import { appendRuntimeLog, db, queueReleaseJob, recordPerformanceMetric, refreshSettings, reportWorkerHeartbeat, type WorkerTaskContext } from './db.js';
import { webExecutor } from './web-executor-client.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription, retryReason } from './retry.js';
import { expandReleaseUrl, getInspectionRules } from './inspection-rules.js';
import { notifyLive } from './live-events.js';
import { isExecutionEngineDraining } from './engine-drain.js';

const POLL_MS = 1_000;
const BACKFILL_BATCH_SIZE = 100;
// This was the generic result emitted before ISO datetime values such as
// `2026-08-28T00:00:00+08:00` were matched correctly. Requeue it once after
// upgrading, while leaving genuine, detailed "unavailable" results alone.
const PREVIOUS_DATE_PATTERN_RESULT = '详情页未找到标签“发行日期”对应的日期值。';

type ReleaseJob = {
  id: number;
  archive_entry_id: number;
  subscription_id: number;
  content: string;
  detail_url: string | null;
  subscription_url: string;
  attempt_count: number;
  priority: number;
};

type LegacyEntry = { id: number; subscription_id: number; content: string; detail_url: string | null; subscription_url: string };

async function queueLegacyReleaseLookups() {
  if (isExecutionEngineDraining()) return;
  const rule = getInspectionRules().releaseDate;
  if (!rule.enabled) return;
  const entries = await db.all<LegacyEntry>(`SELECT a.id, a.subscription_id, a.content, a.detail_url, s.url AS subscription_url
    FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
    WHERE a.release_status = 'unsearched'
      OR (a.release_status = 'unavailable' AND a.release_error = ?)
    ORDER BY a.id ASC LIMIT ?`, [PREVIOUS_DATE_PATTERN_RESULT, BACKFILL_BATCH_SIZE]);
  for (const entry of entries) {
    const detailUrl = expandReleaseUrl(rule.urlTemplate, { detailUrl: entry.detail_url, subscriptionUrl: entry.subscription_url, content: entry.content });
    const now = new Date().toISOString();
    if (!detailUrl) {
      await db.run(`UPDATE archive_entries SET release_status = 'unavailable', release_checked_at = ?, release_error = ?, updated_at = ?
        WHERE id = ? AND (release_status = 'unsearched' OR (release_status = 'unavailable' AND release_error = ?))`,
      [now, '当前发行日期规则无法生成详情页地址；请检查详情页地址模板或内容链接。', now, entry.id, PREVIOUS_DATE_PATTERN_RESULT]);
      continue;
    }
    const changed = await db.run(`UPDATE archive_entries SET release_status = 'pending', release_error = NULL, updated_at = ?
      WHERE id = ? AND (release_status = 'unsearched' OR (release_status = 'unavailable' AND release_error = ?))`, [now, entry.id, PREVIOUS_DATE_PATTERN_RESULT]);
    if (changed.changes) await queueReleaseJob(entry.id);
  }
}

async function remainingJobs(subscriptionId: number) {
  const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM release_jobs j
    JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE a.subscription_id = ? AND j.status IN ('queued', 'running')`, [subscriptionId]);
  return row?.count ?? 0;
}

async function logProgress(subscriptionId: number) {
  const remaining = await remainingJobs(subscriptionId);
  if (remaining === 0) await appendRuntimeLog({ level: 'success', source: 'worker', subscriptionId, message: '发行日期读取队列已完成。' });
  else if (remaining % 50 === 0) await appendRuntimeLog({ level: 'info', source: 'worker', subscriptionId, message: `发行日期读取进行中，剩余 ${remaining} 项。` });
}

async function runNextReleaseJob() {
  if (isExecutionEngineDraining()) return;
  const job = await db.get<ReleaseJob>(`SELECT j.id, j.archive_entry_id, j.attempt_count, j.priority, a.subscription_id, a.content, a.detail_url, s.url AS subscription_url
    FROM release_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id JOIN subscriptions s ON s.id = a.subscription_id
    WHERE j.status = 'queued' AND (j.retry_after IS NULL OR j.retry_after <= ?) ORDER BY j.priority DESC, j.requested_at ASC, j.id ASC LIMIT 1`, [new Date().toISOString()]);
  if (!job) return;
  if (isExecutionEngineDraining()) return;
  const started = await db.run("UPDATE release_jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [new Date().toISOString(), job.id]);
  if (!started.changes) return;
  const startedAtMs = Date.now();
  activeTask = { kind: 'release', subscriptionId: job.subscription_id, archiveEntryId: job.archive_entry_id, content: job.content, label: '正在读取发行日期详情页' };
  await heartbeat();

  try {
    const rule = getInspectionRules().releaseDate;
    if (!rule.enabled) {
      const finishedAt = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE id = ?", [finishedAt, job.archive_entry_id]);
        await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE id = ?", [finishedAt, job.id]);
      });
      activeTask = null;
      return;
    }
    const detailUrl = expandReleaseUrl(rule.urlTemplate, { detailUrl: job.detail_url, subscriptionUrl: job.subscription_url, content: job.content });
    if (!detailUrl) throw new Error('发行日期规则无法生成详情页地址；请检查详情页地址模板或内容链接。');
    const result = await webExecutor.release(detailUrl, rule, job.priority);
    const finishedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      if (result.status === 'found') {
        await tx.run(`UPDATE archive_entries SET release_date = ?, release_status = 'found', release_checked_at = ?, release_error = NULL, updated_at = ? WHERE id = ?`,
          [result.releaseDate, finishedAt, finishedAt, job.archive_entry_id]);
      } else {
        await tx.run(`UPDATE archive_entries SET release_date = NULL, release_status = 'unavailable', release_checked_at = ?, release_error = ?, updated_at = ? WHERE id = ?`,
          [finishedAt, result.reason, finishedAt, job.archive_entry_id]);
      }
      await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = NULL, retry_after = NULL WHERE id = ?", [finishedAt, job.id]);
    });
    await logProgress(job.subscription_id);
    await recordPerformanceMetric({ scope: 'release', metric: 'processed', dimension: result.status, durationMs: Date.now() - startedAtMs }).catch(() => undefined);
    activeTask = null;
    notifyLive('archive', job.subscription_id);
    notifyLive('tasks');
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知发行日期读取错误';
    const finishedAt = new Date().toISOString();
    const attempt = job.attempt_count + 1;
    const shouldRetry = attempt < MAX_JOB_ATTEMPTS && isRetryableJobError(error);
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET release_status = ?, release_checked_at = ?, release_error = ?, updated_at = ? WHERE id = ?`,
        [shouldRetry ? 'pending' : 'failed', finishedAt, shouldRetry ? `${retryDescription(attempt)}：${message}` : message, finishedAt, job.archive_entry_id]);
      if (shouldRetry) {
        await tx.run("UPDATE release_jobs SET status = 'queued', started_at = NULL, finished_at = NULL, error = ?, attempt_count = ?, retry_after = ? WHERE id = ?", [message, attempt, new Date(Date.now() + retryDelayMs(attempt)).toISOString(), job.id]);
      } else {
        await tx.run("UPDATE release_jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [finishedAt, message, attempt, job.id]);
      }
    });
    await appendRuntimeLog({ level: shouldRetry ? 'info' : 'error', source: 'worker', subscriptionId: job.subscription_id, message: shouldRetry ? `发行日期读取“${job.content}”暂时失败，${retryDescription(attempt)}：${message}` : `发行日期读取“${job.content}”失败：${message}` });
    await recordPerformanceMetric({ scope: 'release', metric: shouldRetry ? 'retry' : 'processed', dimension: shouldRetry ? retryReason(error) : 'failed', durationMs: shouldRetry ? 0 : Date.now() - startedAtMs }).catch(() => undefined);
    await logProgress(job.subscription_id);
    console.error(`Release-date job ${job.id} failed: ${message}`);
    notifyLive('archive', job.subscription_id);
    notifyLive('tasks');
    activeTask = null;
  }
}

let working = false;
let activeTask: WorkerTaskContext | null = null;
let lastInfrastructureLogAt = 0;
let lastStalledRecoveryAt = 0;

async function heartbeat() {
  await reportWorkerHeartbeat('release', activeTask?.label ?? '发行日期详情页读取', activeTask ? 'busy' : 'ready', activeTask).catch(() => undefined);
}

async function recoverStalledJobs() {
  if (Date.now() - lastStalledRecoveryAt < 60_000) return;
  lastStalledRecoveryAt = Date.now();
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.run("UPDATE release_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < ?", [cutoff]);
}

async function reportInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : '未知数据库或 Worker 错误';
  console.error(`Release-date worker tick failed: ${message}`);
  if (Date.now() - lastInfrastructureLogAt < 60_000) return;
  lastInfrastructureLogAt = Date.now();
  try { await appendRuntimeLog({ level: 'error', source: 'system', message: `发行日期 Worker 本轮未完成，将自动重试：${message}` }); }
  catch (logError) { console.error(`Unable to save release-date recovery log: ${logError instanceof Error ? logError.message : String(logError)}`); }
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await heartbeat();
    if (isExecutionEngineDraining()) return;
    await refreshSettings();
    await recoverStalledJobs();
    await queueLegacyReleaseLookups();
    await runNextReleaseJob();
  } catch (error) {
    await reportWorkerHeartbeat('release', '发行日期 Worker 遇到基础设施错误', 'error').catch(() => undefined);
    await reportInfrastructureError(error);
  } finally { working = false; }
}

export async function runReleaseWorkerTick() { await tick(); }
export function isReleaseWorkerBusy() { return working; }

if (process.env.PAGE_WATCH_WORKER_AUTOSTART !== '0') {
  void appendRuntimeLog({ level: 'info', source: 'system', message: '发行日期 Worker 已启动（单线程，按检查规则读取详情页字段）。' })
    .catch((error) => console.error(`Unable to save release-date startup log: ${error instanceof Error ? error.message : String(error)}`));
  console.log('Page Watch release-date worker started');
  void tick();
  setInterval(() => void tick(), POLL_MS);
  const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
  heartbeatTimer.unref();
}

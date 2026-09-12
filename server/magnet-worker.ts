import { appendRuntimeLog, db, getQbittorrentSettings, queueDownloadJob, refreshSettings, reportWorkerHeartbeat } from './db.js';
import { lookupMagnet } from './magnet.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription } from './retry.js';
import { getInspectionRules } from './inspection-rules.js';

const POLL_MS = 1_000;

type MagnetJob = {
  id: number;
  archive_entry_id: number;
  subscription_id: number;
  content: string;
  attempt_count: number;
};

async function remainingJobs(subscriptionId: number) {
  const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM magnet_jobs j
    JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE a.subscription_id = ? AND j.status IN ('queued', 'running')`, [subscriptionId]);
  return row?.count ?? 0;
}

async function logProgress(subscriptionId: number) {
  const remaining = await remainingJobs(subscriptionId);
  if (remaining === 0) {
    await appendRuntimeLog({ level: 'success', source: 'worker', subscriptionId, message: '磁力检索队列已完成。' });
  } else if (remaining % 25 === 0) {
    await appendRuntimeLog({ level: 'info', source: 'worker', subscriptionId, message: `磁力检索进行中，剩余 ${remaining} 项。` });
  }
}

async function runNextMagnetJob() {
  const job = await db.get<MagnetJob>(`SELECT j.id, j.archive_entry_id, j.attempt_count, a.subscription_id, a.content
    FROM magnet_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE j.status = 'queued' AND (j.retry_after IS NULL OR j.retry_after <= ?) ORDER BY j.priority DESC, j.requested_at ASC, j.id ASC LIMIT 1`, [new Date().toISOString()]);
  if (!job) return;

  const started = await db.run("UPDATE magnet_jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [new Date().toISOString(), job.id]);
  if (!started.changes) return;

  try {
    const rule = getInspectionRules().magnet;
    if (!rule.enabled) {
      const finishedAt = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE id = ?", [finishedAt, job.archive_entry_id]);
        await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE id = ?", [finishedAt, job.id]);
      });
      return;
    }
    const result = await lookupMagnet(job.content, rule);
    const finishedAt = new Date().toISOString();
    let downloadQueued = false;
    await db.transaction(async (tx) => {
      if (result.status === 'found') {
        await tx.run(`UPDATE archive_entries SET magnet_status = 'found', magnet_value = ?, magnet_checked_at = ?, magnet_error = NULL, updated_at = ?
          WHERE id = ?`, [result.value, finishedAt, finishedAt, job.archive_entry_id]);
        const qbit = getQbittorrentSettings();
        if (qbit.enabled && qbit.autoDownload) {
          const queued = await queueDownloadJob(job.archive_entry_id, tx);
          downloadQueued = queued.queued;
          if (queued.queued) await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL, updated_at = ?
            WHERE id = ?`, [finishedAt, finishedAt, job.archive_entry_id]);
        }
      } else {
        await tx.run(`UPDATE archive_entries SET magnet_status = 'not_found', magnet_value = NULL, magnet_checked_at = ?, magnet_error = ?, updated_at = ?
          WHERE id = ?`, [finishedAt, result.reason, finishedAt, job.archive_entry_id]);
      }
      await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = NULL, retry_after = NULL WHERE id = ?", [finishedAt, job.id]);
    });
    if (result.status === 'not_found') {
      await appendRuntimeLog({ level: 'success', source: 'worker', subscriptionId: job.subscription_id, message: `磁力检索完成，未找到“${job.content}”：${result.reason}` });
    } else if (downloadQueued) {
      await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: job.subscription_id, message: `已将“${job.content}”加入 qBittorrent 下载队列。` });
    }
    await logProgress(job.subscription_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知磁力检索错误';
    const finishedAt = new Date().toISOString();
    const attempt = job.attempt_count + 1;
    const shouldRetry = attempt < MAX_JOB_ATTEMPTS && isRetryableJobError(error);
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET magnet_status = ?, magnet_value = NULL, magnet_checked_at = ?, magnet_error = ?, updated_at = ?
        WHERE id = ?`, [shouldRetry ? 'pending' : 'failed', finishedAt, shouldRetry ? `${retryDescription(attempt)}：${message}` : message, finishedAt, job.archive_entry_id]);
      if (shouldRetry) {
        await tx.run("UPDATE magnet_jobs SET status = 'queued', started_at = NULL, finished_at = NULL, error = ?, attempt_count = ?, retry_after = ? WHERE id = ?", [message, attempt, new Date(Date.now() + retryDelayMs(attempt)).toISOString(), job.id]);
      } else {
        await tx.run("UPDATE magnet_jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [finishedAt, message, attempt, job.id]);
      }
    });
    await appendRuntimeLog({ level: shouldRetry ? 'info' : 'error', source: 'worker', subscriptionId: job.subscription_id, message: shouldRetry ? `磁力检索“${job.content}”暂时失败，${retryDescription(attempt)}：${message}` : `磁力检索“${job.content}”失败：${message}` });
    await logProgress(job.subscription_id);
    console.error(`Magnet job ${job.id} failed: ${message}`);
  }
}

let working = false;
let lastInfrastructureLogAt = 0;
let lastStalledRecoveryAt = 0;

async function heartbeat() {
  await reportWorkerHeartbeat('magnet', working ? '正在检索磁力链接' : '磁力检索队列', working ? 'busy' : 'ready').catch(() => undefined);
}

async function reportInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : '未知数据库或 Worker 错误';
  console.error(`Magnet worker tick failed: ${message}`);
  if (Date.now() - lastInfrastructureLogAt < 60_000) return;
  lastInfrastructureLogAt = Date.now();
  try { await appendRuntimeLog({ level: 'error', source: 'system', message: `磁力检索 Worker 本轮未完成，将自动重试：${message}` }); }
  catch (logError) { console.error(`Unable to save magnet recovery log: ${logError instanceof Error ? logError.message : String(logError)}`); }
}

async function recoverStalledJobs() {
  if (Date.now() - lastStalledRecoveryAt < 60_000) return;
  lastStalledRecoveryAt = Date.now();
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.run("UPDATE magnet_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < ?", [cutoff]);
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await heartbeat();
    await refreshSettings();
    await recoverStalledJobs();
    await runNextMagnetJob();
  } catch (error) {
    await reportWorkerHeartbeat('magnet', '磁力检索 Worker 遇到基础设施错误', 'error').catch(() => undefined);
    await reportInfrastructureError(error);
  }
  finally { working = false; }
}

void appendRuntimeLog({ level: 'info', source: 'system', message: '磁力检索 Worker 已启动（单线程，按检查规则的请求间隔执行）。' })
  .catch((error) => console.error(`Unable to save magnet startup log: ${error instanceof Error ? error.message : String(error)}`));
console.log('Page Watch magnet lookup worker started');
void tick();
setInterval(() => void tick(), POLL_MS);
const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
heartbeatTimer.unref();

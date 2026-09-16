import { appendRuntimeLog, db, getJellyfinSettings, getSetting, JOB_PRIORITY, queueLibrarySyncJob, queueMagnetJob, recordPerformanceMetric, refreshSettings, reportIntegrationStatus, reportWorkerHeartbeat, scheduleSubscriptionProgressRebuild, setSetting, type LibrarySyncJob, type WorkerTaskContext } from './db.js';
import { findJellyfinMedia } from './jellyfin.js';
import { exactJellyfinMatch } from './jellyfin-match.js';
import { librarySyncExecutor } from './library-sync-client.js';
import { findCachedJellyfinMedia } from './jellyfin-cache.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription, retryReason } from './retry.js';
import { notifyLive } from './live-events.js';
import { isExecutionEngineDraining } from './engine-drain.js';

// An idle worker only needs a modest polling cadence. Once a complete local
// Jellyfin index exists, however, individual matches are indexed MySQL reads
// rather than remote API requests, so draining a small sequential batch is
// both safe and dramatically faster for a newly added subscription.
const POLL_MS = 15_000;
const LOCAL_MATCH_BATCH_SIZE = 20;
const LOCAL_MATCH_BATCH_YIELD_MS = 50;
let working = false;
let syncing = false;
let lastErrorLogAt = 0;
let syncTask: WorkerTaskContext | null = null;

type LibraryJob = { id: number; archive_entry_id: number; attempt_count: number; subscription_id: number; content: string; jellyfin_status: string };

async function runNextLibrarySync() {
  if (isExecutionEngineDraining()) return false;
  const job = await db.get<LibrarySyncJob>(`SELECT * FROM library_sync_jobs
    WHERE status = 'queued' ORDER BY priority DESC, requested_at ASC, id ASC LIMIT 1`);
  if (!job) return false;
  const startedAt = new Date().toISOString();
  if (!(await db.run("UPDATE library_sync_jobs SET status = 'running', started_at = ?, error = NULL WHERE id = ? AND status = 'queued'", [startedAt, job.id])).changes) return true;
  await setSetting('jellyfin_last_sync_attempt_at', startedAt);
  syncing = true;
  syncTask = { kind: 'library_sync', current: 0, total: null, label: '正在启动 Jellyfin 同步器' };
  await syncHeartbeat();
  const startedAtMs = Date.now();
  try {
    const result = await librarySyncExecutor.run(job.trigger_type, async (progress) => {
      syncTask = { kind: 'library_sync', current: progress.current, total: progress.total, label: progress.label };
      await db.run(`UPDATE library_sync_jobs SET progress_phase = ?, progress_current = ?, progress_total = ?, progress_label = ? WHERE id = ?`,
        [progress.phase, progress.current, progress.total, progress.label.slice(0, 255), job.id]);
      await syncHeartbeat();
    });
    const finished = new Date().toISOString();
    await db.run(`UPDATE library_sync_jobs SET status = 'completed', finished_at = ?, error = NULL,
      progress_phase = 'completed', progress_label = ?, progress_current = ?, progress_total = ? WHERE id = ?`,
    [finished, `同步完成：${result.scanned} 个媒体项目，${result.matched} 条已入库`, result.scanned, result.scanned, job.id]);
    await recordPerformanceMetric({ scope: 'library', metric: 'processed', dimension: 'full_sync', durationMs: Date.now() - startedAtMs }).catch(() => undefined);
    await reportIntegrationStatus('jellyfin', 'healthy', '最近一次媒体库同步成功').catch(() => undefined);
    await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 影视库${job.trigger_type === 'manual' ? '手动' : '定时'}同步任务完成：扫描 ${result.scanned} 个媒体项目，${result.matched} 条已入库。` });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 Jellyfin 同步错误';
    await db.run("UPDATE library_sync_jobs SET status = 'failed', finished_at = ?, error = ?, progress_phase = 'failed', progress_label = ? WHERE id = ?", [new Date().toISOString(), message, '同步失败', job.id]);
    await reportIntegrationStatus('jellyfin', 'degraded', '最近一次媒体库同步失败').catch(() => undefined);
    await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 影视库${job.trigger_type === 'manual' ? '手动' : '定时'}同步失败：${message}` });
  } finally {
    syncing = false;
    syncTask = null;
  }
  if (!syncing) {
    const subscriptions = await db.all<{ id: number }>('SELECT id FROM subscriptions');
    for (const subscription of subscriptions) {
      scheduleSubscriptionProgressRebuild(subscription.id);
      notifyLive('archive', subscription.id);
    }
    notifyLive('subscriptions');
    notifyLive('tasks');
  }
  return true;
}

async function runNextLibraryJob() {
  if (isExecutionEngineDraining()) return false;
  const job = await db.get<LibraryJob>(`SELECT j.id, j.archive_entry_id, j.attempt_count, a.subscription_id, a.content, a.jellyfin_status
    FROM library_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE j.status = 'queued' AND (j.retry_after IS NULL OR j.retry_after <= ?)
    ORDER BY j.priority DESC, j.requested_at ASC, j.id ASC LIMIT 1`, [new Date().toISOString()]);
  if (!job) return false;
  if (isExecutionEngineDraining()) return false;
  const startedAt = new Date().toISOString();
  if (!(await db.run("UPDATE library_jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [startedAt, job.id])).changes) return true;
  const startedAtMs = Date.now();
  let usedRemoteLookup = false;
  try {
    const settings = getJellyfinSettings();
    if (!settings.enabled || !settings.libraryIds.length) throw new Error('Jellyfin 未启用或尚未选择媒体库。');
    // After the first complete library sync, this is a single indexed MySQL
    // lookup. The Jellyfin API fallback exists only while no local snapshot is
    // available yet (for example immediately after configuration changes).
    const indexReady = Boolean(getSetting('jellyfin_media_index_synced_at'));
    usedRemoteLookup = !indexReady;
    const match = indexReady
      ? await findCachedJellyfinMedia(job.content, settings.libraryIds)
      : exactJellyfinMatch(job.content, await findJellyfinMedia(settings, job.content));
    if (indexReady) await recordPerformanceMetric({ scope: 'library', metric: 'jellyfin_cache', dimension: match ? 'hit' : 'miss' }).catch(() => undefined);
    const finishedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      if (match) {
        await tx.run(`UPDATE archive_entries SET jellyfin_status = 'available', jellyfin_item_id = ?, jellyfin_item_name = ?, jellyfin_matched_at = ?, jellyfin_error = NULL,
          magnet_status = CASE WHEN ? THEN 'skipped' ELSE magnet_status END, magnet_checked_at = CASE WHEN ? THEN ? ELSE magnet_checked_at END,
          magnet_error = CASE WHEN ? THEN 'Jellyfin 已入库，自动跳过磁力检索。' ELSE magnet_error END, updated_at = ? WHERE id = ?`,
        [match.id, match.name, finishedAt, settings.skipMagnetWhenAvailable ? 1 : 0, settings.skipMagnetWhenAvailable ? 1 : 0, finishedAt, settings.skipMagnetWhenAvailable ? 1 : 0, finishedAt, job.archive_entry_id]);
        if (settings.skipMagnetWhenAvailable) await appendRuntimeLog({ level: 'info', source: 'library', subscriptionId: job.subscription_id, message: `Jellyfin 已入库“${job.content}”，自动跳过磁力检索。` });
        else await queueMagnetJob(job.archive_entry_id, tx);
      } else {
        // A one-off JF search is intentionally narrower than the scheduled
        // full-library snapshot. Do not let a transient/mixed result overwrite
        // an already confirmed library item; the next full sync can still mark
        // it missing if the file was genuinely removed.
        if (job.jellyfin_status !== 'available') {
          await tx.run(`UPDATE archive_entries SET jellyfin_status = 'not_found', jellyfin_item_id = NULL, jellyfin_item_name = NULL, jellyfin_matched_at = ?, jellyfin_error = NULL,
            magnet_status = 'pending', magnet_error = NULL, updated_at = ? WHERE id = ?`, [finishedAt, finishedAt, job.archive_entry_id]);
          await queueMagnetJob(job.archive_entry_id, tx);
        }
      }
      await tx.run("UPDATE library_jobs SET status = 'completed', finished_at = ?, error = NULL, retry_after = NULL WHERE id = ?", [finishedAt, job.id]);
    });
    await recordPerformanceMetric({ scope: 'library', metric: 'processed', dimension: match ? 'found' : 'not_found', durationMs: Date.now() - startedAtMs }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 Jellyfin 单条查询错误';
    const attempt = job.attempt_count + 1;
    const retry = attempt < MAX_JOB_ATTEMPTS && isRetryableJobError(error);
    const finishedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      if (job.jellyfin_status !== 'available') await tx.run(`UPDATE archive_entries SET jellyfin_status = 'failed', jellyfin_error = ?, jellyfin_matched_at = ?, magnet_status = 'pending', magnet_error = NULL, updated_at = ? WHERE id = ?`,
        [retry ? `${retryDescription(attempt)}：${message}` : message, finishedAt, finishedAt, job.archive_entry_id]);
      if (retry) await tx.run("UPDATE library_jobs SET status = 'queued', started_at = NULL, error = ?, attempt_count = ?, retry_after = ? WHERE id = ?", [message, attempt, new Date(Date.now() + retryDelayMs(attempt)).toISOString(), job.id]);
      else {
        await tx.run("UPDATE library_jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [finishedAt, message, attempt, job.id]);
        if (job.jellyfin_status !== 'available') await queueMagnetJob(job.archive_entry_id, tx);
      }
    });
    await appendRuntimeLog({ level: retry ? 'info' : 'error', source: 'library', subscriptionId: job.subscription_id, message: `Jellyfin 查询“${job.content}”${retry ? `暂时失败，${retryDescription(attempt)}：` : '失败，已继续磁力补全：'}${message}` });
    await recordPerformanceMetric({ scope: 'library', metric: retry ? 'retry' : 'processed', dimension: retry ? retryReason(error) : 'failed', durationMs: retry ? 0 : Date.now() - startedAtMs }).catch(() => undefined);
    if (usedRemoteLookup) await reportIntegrationStatus('jellyfin', 'degraded', '最近一次 Jellyfin 查询失败').catch(() => undefined);
  }
  scheduleSubscriptionProgressRebuild(job.subscription_id);
  notifyLive('archive', job.subscription_id);
  // Jellyfin availability is shown in the compact subscription summary, so
  // this is one of the few per-entry transitions that merits that refresh.
  notifyLive('subscriptions');
  notifyLive('tasks');
  return true;
}

async function syncHeartbeat() {
  if (!syncing) return;
  await reportWorkerHeartbeat('library', syncTask?.label ?? '正在同步 Jellyfin 影视库', 'busy', syncTask).catch(() => undefined);
}

function syncDue() {
  const last = Date.parse(getSetting('jellyfin_last_synced_at'));
  const lastAttempt = Date.parse(getSetting('jellyfin_last_sync_attempt_at'));
  const interval = getJellyfinSettings().syncIntervalMinutes * 60_000;
  // A failed bootstrap should remain visible as a failed task, not create a
  // fresh external request every polling tick. The next planned retry is
  // bounded to five minutes (or the configured interval if shorter).
  if (!Number.isFinite(last) && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < Math.min(interval, 5 * 60_000)) return false;
  return !Number.isFinite(last) || Date.now() - last >= interval;
}

async function tick() {
  if (working) return;
  working = true;
  let scheduleImmediateTick = false;
  try {
    await refreshSettings();
    if (isExecutionEngineDraining()) return;
    const settings = getJellyfinSettings();
    if (!settings.enabled) {
      // Finish any already-queued gate checks by falling back to magnet work;
      // disabling Jellyfin must never strand an archive item indefinitely.
      if (await runNextLibraryJob()) return;
      await reportWorkerHeartbeat('library', 'Jellyfin 影视库同步未启用');
      return;
    }
    if (!settings.libraryIds.length) {
      if (await runNextLibraryJob()) return;
      await reportWorkerHeartbeat('library', 'Jellyfin 尚未选择媒体库（外部服务未配置）');
      return;
    }
    // A cache miss after configuration changes must build one complete local
    // snapshot before processing individual archive rows. The durable job lets
    // an on-demand child own that heavy work while this runner stays lean.
    if (!getSetting('jellyfin_media_index_synced_at') || syncDue()) await queueLibrarySyncJob('scheduled', JOB_PRIORITY.normal);
    if (await runNextLibrarySync()) return;
    let processed = 0;
    while (processed < LOCAL_MATCH_BATCH_SIZE && await runNextLibraryJob()) processed += 1;
    if (processed > 0) {
      await reportWorkerHeartbeat('library', `正在查询 MySQL Jellyfin 媒体索引（本批已处理 ${processed} 项）`, 'busy');
      // Yield between bounded batches to keep this single Worker responsive
      // to heartbeats and the rest of the Node.js service, without returning
      // to the 15-second idle polling delay while a queue is still backed up.
      scheduleImmediateTick = processed === LOCAL_MATCH_BATCH_SIZE;
      return;
    }
    await reportWorkerHeartbeat('library', `Jellyfin 影视库将在下个计划周期同步（每 ${settings.syncIntervalMinutes} 分钟）`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 Jellyfin 同步错误';
    console.error(`Jellyfin library sync failed: ${message}`);
    await reportIntegrationStatus('jellyfin', 'degraded', '最近一次媒体库同步失败').catch(() => undefined);
    // Jellyfin is optional to Page Watch's core service. A remote timeout or
    // 401 must be visible as degraded without making Docker regard the whole
    // container as unhealthy and restarting otherwise healthy workers.
    await reportWorkerHeartbeat('library', 'Jellyfin 外部服务降级；将在下个计划周期重试').catch(() => undefined);
    if (Date.now() - lastErrorLogAt >= 60_000) {
      lastErrorLogAt = Date.now();
      await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 影视库同步失败：${message}` }).catch(() => undefined);
    }
  } finally {
    syncing = false;
    syncTask = null;
    working = false;
    if (scheduleImmediateTick && process.env.PAGE_WATCH_WORKER_AUTOSTART !== '0') setTimeout(() => void tick(), LOCAL_MATCH_BATCH_YIELD_MS);
  }
}

export async function runLibraryWorkerTick() { await tick(); }
export function isLibraryWorkerBusy() { return working || syncing; }

if (process.env.PAGE_WATCH_WORKER_AUTOSTART !== '0') {
  void appendRuntimeLog({ level: 'info', source: 'system', message: 'Jellyfin 影视库同步 Worker 已启动。' })
    .catch((error) => console.error(`Unable to save Jellyfin startup log: ${error instanceof Error ? error.message : String(error)}`));
  console.log('Page Watch Jellyfin library worker started');
  void tick();
  setInterval(() => void tick(), POLL_MS);
  const heartbeatTimer = setInterval(() => void syncHeartbeat(), 15_000);
  heartbeatTimer.unref();
}

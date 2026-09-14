import { appendRuntimeLog, db, getJellyfinSettings, getSetting, queueMagnetJob, refreshSettings, reportWorkerHeartbeat } from './db.js';
import { findJellyfinMedia } from './jellyfin.js';
import { exactJellyfinMatch } from './jellyfin-match.js';
import { syncJellyfinLibrary } from './jellyfin-sync.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription } from './retry.js';
import { notifyLive } from './live-events.js';

const POLL_MS = 15_000;
let working = false;
let syncing = false;
let lastErrorLogAt = 0;

type LibraryJob = { id: number; archive_entry_id: number; attempt_count: number; subscription_id: number; content: string; jellyfin_status: string };

async function runNextLibraryJob() {
  const job = await db.get<LibraryJob>(`SELECT j.id, j.archive_entry_id, j.attempt_count, a.subscription_id, a.content, a.jellyfin_status
    FROM library_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE j.status = 'queued' AND (j.retry_after IS NULL OR j.retry_after <= ?)
    ORDER BY j.priority DESC, j.requested_at ASC, j.id ASC LIMIT 1`, [new Date().toISOString()]);
  if (!job) return false;
  const startedAt = new Date().toISOString();
  if (!(await db.run("UPDATE library_jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [startedAt, job.id])).changes) return true;
  try {
    const settings = getJellyfinSettings();
    if (!settings.enabled || !settings.libraryIds.length) throw new Error('Jellyfin 未启用或尚未选择媒体库。');
    const media = await findJellyfinMedia(settings, job.content);
    const match = exactJellyfinMatch(job.content, media);
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
  }
  notifyLive('archive', job.subscription_id);
  notifyLive('subscriptions');
  return true;
}

async function syncHeartbeat() {
  if (!syncing) return;
  await reportWorkerHeartbeat('library', '正在同步 Jellyfin 影视库', 'busy').catch(() => undefined);
}

function syncDue() {
  const last = Date.parse(getSetting('jellyfin_last_synced_at'));
  const interval = getJellyfinSettings().syncIntervalMinutes * 60_000;
  return !Number.isFinite(last) || Date.now() - last >= interval;
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await refreshSettings();
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
      await reportWorkerHeartbeat('library', '等待选择 Jellyfin 媒体库', 'error');
      return;
    }
    if (await runNextLibraryJob()) {
      await reportWorkerHeartbeat('library', '正在逐条核对 Jellyfin 影视库', 'busy');
      return;
    }
    if (!syncDue()) {
      await reportWorkerHeartbeat('library', `Jellyfin 影视库将在下个计划周期同步（每 ${settings.syncIntervalMinutes} 分钟）`);
      return;
    }
    syncing = true;
    await syncHeartbeat();
    const result = await syncJellyfinLibrary('scheduled');
    syncing = false;
    await reportWorkerHeartbeat('library', `Jellyfin 已同步 ${result.scanned} 个媒体项目，匹配 ${result.matched} 条归档`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 Jellyfin 同步错误';
    console.error(`Jellyfin library sync failed: ${message}`);
    await reportWorkerHeartbeat('library', `Jellyfin 同步失败：${message}`, 'error').catch(() => undefined);
    if (Date.now() - lastErrorLogAt >= 60_000) {
      lastErrorLogAt = Date.now();
      await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 影视库同步失败：${message}` }).catch(() => undefined);
    }
  } finally { syncing = false; working = false; }
}

void appendRuntimeLog({ level: 'info', source: 'system', message: 'Jellyfin 影视库同步 Worker 已启动。' })
  .catch((error) => console.error(`Unable to save Jellyfin startup log: ${error instanceof Error ? error.message : String(error)}`));
console.log('Page Watch Jellyfin library worker started');
void tick();
setInterval(() => void tick(), POLL_MS);
const heartbeatTimer = setInterval(() => void syncHeartbeat(), 15_000);
heartbeatTimer.unref();

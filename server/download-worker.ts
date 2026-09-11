import { appendRuntimeLog, db, getQbittorrentSettings, refreshSettings, reportWorkerHeartbeat } from './db.js';
import { addMagnetToQbittorrent, getQbittorrentTorrentStates, stopQbittorrentTorrents, torrentHashFromMagnet, type QbittorrentTorrentState } from './qbittorrent.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription } from './retry.js';

const POLL_MS = 1_000;
const STATUS_SYNC_MS = 5_000;

type DownloadJob = {
  id: number;
  archive_entry_id: number;
  subscription_id: number;
  content: string;
  magnet_value: string | null;
  attempt_count: number;
};

type TrackedDownload = {
  id: number;
  subscription_id: number;
  content: string;
  download_status: string;
  download_added_at: string | null;
  download_torrent_hash: string | null;
  magnet_value: string | null;
  download_progress: number | string | null;
  download_speed: number | string | null;
  download_size: number | string | null;
  downloaded_bytes: number | string | null;
  download_save_path: string | null;
  download_content_path: string | null;
};

async function runNextDownloadJob() {
  const job = await db.get<DownloadJob>(`SELECT j.id, j.archive_entry_id, j.attempt_count, a.subscription_id, a.content, a.magnet_value
    FROM download_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE j.status = 'queued' AND (j.retry_after IS NULL OR j.retry_after <= ?) ORDER BY j.requested_at ASC, j.id ASC LIMIT 1`, [new Date().toISOString()]);
  if (!job) return;

  const claimed = await db.run("UPDATE download_jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [new Date().toISOString(), job.id]);
  if (!claimed.changes) return;

  const finishedAt = new Date().toISOString();
  try {
    // A user can save a new API key immediately before pressing 下载. Force a
    // refresh here so this independently running worker never uses stale auth.
    await refreshSettings(true);
    const settings = getQbittorrentSettings();
    if (!settings.enabled) throw new Error('qBittorrent 下载未启用。请先在“下载设置”中启用并保存连接信息。');
    const submission = await addMagnetToQbittorrent(settings, job.magnet_value ?? '');
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET download_status = 'added', download_added_at = ?, download_torrent_hash = ?, download_checked_at = ?, download_error = NULL,
        download_progress = NULL, download_speed = NULL, download_size = NULL, downloaded_bytes = NULL, download_save_path = NULL, download_content_path = NULL, download_removed_at = NULL, updated_at = ?
        WHERE id = ?`, [finishedAt, submission.torrentHash, finishedAt, finishedAt, job.archive_entry_id]);
      await tx.run("UPDATE download_jobs SET status = 'completed', finished_at = ?, error = NULL, retry_after = NULL WHERE id = ?", [finishedAt, job.id]);
    });
    await appendRuntimeLog({ level: 'success', source: 'download', subscriptionId: job.subscription_id, jobId: job.id, message: `已将“${job.content}”提交给 qBittorrent。` });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 qBittorrent 下载错误';
    const attempt = job.attempt_count + 1;
    const shouldRetry = attempt < MAX_JOB_ATTEMPTS && isRetryableJobError(error);
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET download_status = ?, download_error = ?, updated_at = ? WHERE id = ?`, [shouldRetry ? 'queued' : 'failed', shouldRetry ? `${retryDescription(attempt)}：${message}` : message, finishedAt, job.archive_entry_id]);
      if (shouldRetry) {
        await tx.run("UPDATE download_jobs SET status = 'queued', started_at = NULL, finished_at = NULL, error = ?, attempt_count = ?, retry_after = ? WHERE id = ?", [message, attempt, new Date(Date.now() + retryDelayMs(attempt)).toISOString(), job.id]);
      } else {
        await tx.run("UPDATE download_jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [finishedAt, message, attempt, job.id]);
      }
    });
    await appendRuntimeLog({ level: shouldRetry ? 'info' : 'error', source: 'download', subscriptionId: job.subscription_id, jobId: job.id, message: shouldRetry ? `qBittorrent 提交“${job.content}”暂时失败，${retryDescription(attempt)}：${message}` : `qBittorrent 提交“${job.content}”失败：${message}` });
    console.error(`Download job ${job.id} failed: ${message}`);
  }
}

let working = false;
let lastInfrastructureLogAt = 0;
let lastStalledRecoveryAt = 0;

async function reportInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : '未知数据库或 Worker 错误';
  console.error(`Download worker tick failed: ${message}`);
  if (Date.now() - lastInfrastructureLogAt < 60_000) return;
  lastInfrastructureLogAt = Date.now();
  try { await appendRuntimeLog({ level: 'error', source: 'system', message: `qBittorrent 下载 Worker 本轮未完成，将自动重试：${message}` }); }
  catch (logError) { console.error(`Unable to save download recovery log: ${logError instanceof Error ? logError.message : String(logError)}`); }
}

async function recoverStalledJobs() {
  if (Date.now() - lastStalledRecoveryAt < 60_000) return;
  lastStalledRecoveryAt = Date.now();
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.run("UPDATE download_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < ?", [cutoff]);
}

function stateForDownload(torrent: QbittorrentTorrentState) {
  const state = torrent.state.toLowerCase();
  if (torrent.progress >= 0.999 || state.includes('upload')) return 'completed';
  if (state.includes('paused') || state.includes('stopped')) return 'paused';
  if (state.includes('queued')) return 'waiting';
  if (state.includes('downloading') || state.includes('dl') || state.includes('check') || state.includes('moving')) return 'downloading';
  return 'added';
}

function sameNumber(left: number | string | null, right: number) {
  return Number(left ?? 0) === right;
}

function hasDownloadSnapshotChanged(entry: TrackedDownload, nextStatus: string, torrent: QbittorrentTorrentState) {
  return entry.download_status !== nextStatus
    || Math.abs(Number(entry.download_progress ?? 0) - torrent.progress) >= 0.0005
    || !sameNumber(entry.download_speed, torrent.downloadSpeed)
    || !sameNumber(entry.download_size, torrent.totalSize)
    || !sameNumber(entry.downloaded_bytes, torrent.downloadedBytes)
    || (entry.download_save_path ?? null) !== torrent.savePath
    || (entry.download_content_path ?? null) !== torrent.contentPath;
}

let lastStatusSyncAt = 0;
const lastStopFailureLogAt = new Map<number, number>();

function isStoppedState(state: string) {
  const normalized = state.toLowerCase();
  return normalized.includes('paused') || normalized.includes('stopped');
}

async function stopCompletedTorrents(settings: ReturnType<typeof getQbittorrentSettings>, candidates: Array<TrackedDownload & { hash: string }>) {
  if (!settings.stopAfterDownload || !candidates.length) return new Set<number>();
  try {
    await stopQbittorrentTorrents(settings, candidates.map((entry) => entry.hash));
    return new Set(candidates.map((entry) => entry.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知停止做种错误';
    const now = Date.now();
    for (const entry of candidates) {
      if (now - (lastStopFailureLogAt.get(entry.id) ?? 0) < 60_000) continue;
      lastStopFailureLogAt.set(entry.id, now);
      await appendRuntimeLog({ level: 'error', source: 'download', subscriptionId: entry.subscription_id, message: `“${entry.content}”下载完成后停止做种失败：${message}` });
    }
    return new Set<number>();
  }
}

/**
 * qBittorrent owns the download lifecycle. Page Watch only mirrors the
 * states for submitted magnets and never sends another add request here.
 */
async function syncDownloadStates() {
  if (Date.now() - lastStatusSyncAt < STATUS_SYNC_MS) return;
  lastStatusSyncAt = Date.now();
  const settings = getQbittorrentSettings();
  if (!settings.enabled) return;
  const entries = await db.all<TrackedDownload>(`SELECT id, subscription_id, content, download_status, download_added_at, download_torrent_hash, magnet_value,
    download_progress, download_speed, download_size, downloaded_bytes, download_save_path, download_content_path
    FROM archive_entries
    WHERE download_status IN ('added', 'waiting', 'downloading', 'paused', 'completed')`);
  if (!entries.length) return;

  const tracked = entries.map((entry) => ({
    ...entry,
    hash: entry.download_torrent_hash?.toLowerCase() || torrentHashFromMagnet(entry.magnet_value ?? '')
  })).filter((entry): entry is TrackedDownload & { hash: string } => Boolean(entry.hash));
  if (!tracked.length) return;

  const remote = await getQbittorrentTorrentStates(settings, tracked.map((entry) => entry.hash));
  const byHash = new Map(remote.map((torrent) => [torrent.hash, torrent]));
  const stopCandidates = tracked.filter((entry) => {
    const torrent = byHash.get(entry.hash);
    return Boolean(torrent && torrent.progress >= 0.999 && !isStoppedState(torrent.state));
  });
  const stoppedIds = await stopCompletedTorrents(settings, stopCandidates);
  const checkedAt = new Date().toISOString();
  const completed: Array<Pick<TrackedDownload, 'id' | 'subscription_id' | 'content'>> = [];
  const removed: Array<Pick<TrackedDownload, 'subscription_id' | 'content'>> = [];
  await db.transaction(async (tx) => {
    for (const entry of tracked) {
      const torrent = byHash.get(entry.hash);
      if (!torrent) {
        const submittedAt = entry.download_added_at ? new Date(entry.download_added_at).getTime() : 0;
        if (entry.download_status === 'added' && submittedAt > 0 && Date.now() - submittedAt < 60_000) {
          await tx.run('UPDATE archive_entries SET download_checked_at = ? WHERE id = ?', [checkedAt, entry.id]);
          continue;
        }
        if (entry.download_status !== 'removed') {
          await tx.run(`UPDATE archive_entries SET download_status = 'removed', download_speed = 0, download_checked_at = ?, download_removed_at = ?, updated_at = ?
            WHERE id = ?`, [checkedAt, checkedAt, checkedAt, entry.id]);
          removed.push({ subscription_id: entry.subscription_id, content: entry.content });
        } else {
          await tx.run('UPDATE archive_entries SET download_checked_at = ? WHERE id = ?', [checkedAt, entry.id]);
        }
        continue;
      }
      const next = stateForDownload(torrent);
      if (hasDownloadSnapshotChanged(entry, next, torrent)) {
        await tx.run(`UPDATE archive_entries SET download_status = ?, download_torrent_hash = ?, download_checked_at = ?,
          download_progress = ?, download_speed = ?, download_size = ?, downloaded_bytes = ?, download_save_path = ?, download_content_path = ?, download_removed_at = NULL, updated_at = ?
          WHERE id = ?`, [next, entry.hash, checkedAt, torrent.progress, torrent.downloadSpeed, torrent.totalSize, torrent.downloadedBytes, torrent.savePath, torrent.contentPath, checkedAt, entry.id]);
      } else {
        await tx.run('UPDATE archive_entries SET download_checked_at = ? WHERE id = ?', [checkedAt, entry.id]);
      }
      if (next === 'completed' && entry.download_status !== 'completed') {
        completed.push({ id: entry.id, subscription_id: entry.subscription_id, content: entry.content });
      }
    }
  });
  for (const entry of completed) {
    await appendRuntimeLog({ level: 'success', source: 'download', subscriptionId: entry.subscription_id, message: stoppedIds.has(entry.id) ? `qBittorrent 下载完成，已停止做种：“${entry.content}”。` : `qBittorrent 下载完成：“${entry.content}”。` });
  }
  for (const entry of stopCandidates) {
    if (completed.some((item) => item.id === entry.id) || !stoppedIds.has(entry.id)) continue;
    await appendRuntimeLog({ level: 'success', source: 'download', subscriptionId: entry.subscription_id, message: `已停止“${entry.content}”做种。` });
  }
  for (const entry of removed) {
    await appendRuntimeLog({ level: 'info', source: 'download', subscriptionId: entry.subscription_id, message: `qBittorrent 中已找不到“${entry.content}”，已标记为已从 qB 删除。` });
  }
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await reportWorkerHeartbeat('download', 'qBittorrent 下载队列与状态同步').catch(() => undefined);
    await refreshSettings();
    await recoverStalledJobs();
    await runNextDownloadJob();
    await syncDownloadStates();
  } catch (error) {
    await reportWorkerHeartbeat('download', 'qBittorrent 下载 Worker 遇到基础设施错误', 'error').catch(() => undefined);
    await reportInfrastructureError(error);
  }
  finally { working = false; }
}

void appendRuntimeLog({ level: 'info', source: 'system', message: 'qBittorrent 下载 Worker 已启动（单线程提交）。' })
  .catch((error) => console.error(`Unable to save download startup log: ${error instanceof Error ? error.message : String(error)}`));
console.log('Page Watch qBittorrent download worker started');
void tick();
setInterval(() => void tick(), POLL_MS);

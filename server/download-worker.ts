import { appendRuntimeLog, db, getQbittorrentSettings, recordPerformanceMetric, refreshSettings, reportIntegrationStatus, reportWorkerHeartbeat, type WorkerTaskContext } from './db.js';
import { addMagnetToQbittorrent, getQbittorrentTorrentFiles, getQbittorrentTorrentStates, setQbittorrentTorrentFilePriority, startQbittorrentTorrents, stopQbittorrentTorrents, torrentHashFromMagnet, type QbittorrentTorrentFile, type QbittorrentTorrentState } from './qbittorrent.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription, retryReason } from './retry.js';
import { notifyLive } from './live-events.js';
import { isExecutionEngineDraining } from './engine-drain.js';

const POLL_MS = 1_000;
const STATUS_SYNC_MS = 10_000;
const PROGRESS_PERSIST_DELTA = 0.01;
const SNAPSHOT_REFRESH_MS = 30_000;
const SPEED_CHANGE_MIN_BYTES = 256 * 1024;
const MEBIBYTE = 1024 * 1024;
const METADATA_DISCOVERY_GRACE_MS = 10 * 60_000;

type DownloadJob = {
  id: number;
  archive_entry_id: number;
  subscription_id: number;
  content: string;
  magnet_value: string | null;
  download_status: string;
  download_torrent_hash: string | null;
  attempt_count: number;
  priority: number;
};

type TrackedDownload = {
  id: number;
  subscription_id: number;
  content: string;
  download_status: string;
  download_added_at: string | null;
  download_checked_at: string | null;
  download_torrent_hash: string | null;
  magnet_value: string | null;
  download_progress: number | string | null;
  download_speed: number | string | null;
  download_size: number | string | null;
  downloaded_bytes: number | string | null;
  download_save_path: string | null;
  download_content_path: string | null;
  download_filter_min_size_bytes: number | string | null;
};

function displaySize(bytes: number) {
  if (bytes >= 1024 * MEBIBYTE) return `${(bytes / (1024 * MEBIBYTE)).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / MEBIBYTE))} MB`;
}

async function runNextDownloadJob() {
  if (isExecutionEngineDraining()) return;
  const job = await db.get<DownloadJob>(`SELECT j.id, j.archive_entry_id, j.attempt_count, j.priority, a.subscription_id, a.content, a.magnet_value, a.download_status, a.download_torrent_hash
    FROM download_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id
    WHERE j.status = 'queued' AND (j.retry_after IS NULL OR j.retry_after <= ?) ORDER BY j.priority DESC, j.requested_at ASC, j.id ASC LIMIT 1`, [new Date().toISOString()]);
  if (!job) return;
  if (isExecutionEngineDraining()) return;

  const claimed = await db.run("UPDATE download_jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [new Date().toISOString(), job.id]);
  if (!claimed.changes) return;
  const startedAtMs = Date.now();
  activeTask = { kind: 'download', subscriptionId: job.subscription_id, archiveEntryId: job.archive_entry_id, content: job.content, label: '正在提交 qBittorrent 下载' };
  await heartbeat();

  const finishedAt = new Date().toISOString();
  let isFilteredRetry = false;
  try {
    // A user can save a new API key immediately before pressing 下载. Force a
    // refresh here so this independently running worker never uses stale auth.
    await refreshSettings(true);
    const settings = getQbittorrentSettings();
    if (!settings.enabled) throw new Error('qBittorrent 下载未启用。请先在“下载设置”中启用并保存连接信息。');
    isFilteredRetry = job.download_status === 'filtered'
      && Boolean(job.download_torrent_hash && /^[a-f0-9]{40}$/i.test(job.download_torrent_hash));
    const minimumBytes = settings.autoDownloadMinSizeMb > 0 ? settings.autoDownloadMinSizeMb * MEBIBYTE : 0;
    if (isFilteredRetry) {
      const torrentHash = job.download_torrent_hash!.toLowerCase();
      const files = await getQbittorrentTorrentFiles(settings, torrentHash);
      if (!files?.length) throw new Error('qBittorrent 尚未提供该种子的文件列表，无法重新应用大小筛选。');
      const skippedFiles = minimumBytes > 0 ? files.filter((file) => file.size < minimumBytes) : [];
      const selectedFiles = minimumBytes > 0 ? files.filter((file) => file.size >= minimumBytes) : files;
      await setQbittorrentTorrentFilePriority(settings, torrentHash, skippedFiles.map((file) => file.index), 0);
      await setQbittorrentTorrentFilePriority(settings, torrentHash, selectedFiles.map((file) => file.index), 1);
      if (selectedFiles.length) await startQbittorrentTorrents(settings, [torrentHash]);
      await db.transaction(async (tx) => {
        await tx.run(`UPDATE archive_entries SET download_status = ?, download_added_at = ?, download_checked_at = ?, download_error = ?,
          download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`,
        [selectedFiles.length ? 'added' : 'filtered', finishedAt, finishedAt,
          selectedFiles.length ? null : `自动单文件大小筛选：${skippedFiles.length} 个文件均小于 ${displaySize(minimumBytes)}，已在 qBittorrent 中设为不下载。`,
          finishedAt, job.archive_entry_id]);
        await tx.run("UPDATE download_jobs SET status = 'completed', finished_at = ?, error = NULL, retry_after = NULL WHERE id = ?", [finishedAt, job.id]);
      });
      const selection = selectedFiles.length
        ? `保留 ${selectedFiles.length} 个文件，跳过 ${skippedFiles.length} 个较小文件并开始下载。`
        : `种子内 ${skippedFiles.length} 个文件均未达到最小单文件大小，未开始下载。`;
      await appendRuntimeLog({ level: 'info', source: 'download', subscriptionId: job.subscription_id, jobId: job.id, message: `已重新应用“${job.content}”的单文件大小筛选：${selection}` });
    } else {
    // A BTIH is required to safely observe the staged torrent. qBittorrent's
    // MetadataReceived stop condition obtains its file list before payload
    // download begins, letting us exclude small advertisement files safely.
    const canStageSizeFilter = minimumBytes > 0 && Boolean(torrentHashFromMagnet(job.magnet_value ?? ''));
    const submission = await addMagnetToQbittorrent(settings, job.magnet_value ?? '', canStageSizeFilter ? { stopCondition: 'MetadataReceived' } : {});
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET download_status = ?, download_added_at = ?, download_torrent_hash = ?, download_checked_at = ?, download_error = ?,
        download_progress = NULL, download_speed = NULL, download_size = NULL, downloaded_bytes = NULL, download_save_path = NULL, download_content_path = NULL, download_removed_at = NULL,
        download_filter_min_size_bytes = ?, updated_at = ? WHERE id = ?`,
      [canStageSizeFilter ? 'waiting' : 'added', finishedAt, submission.torrentHash, finishedAt,
        canStageSizeFilter ? `正在读取元数据，以应用最小单文件大小 ${settings.autoDownloadMinSizeMb} MB。` : null,
        canStageSizeFilter ? minimumBytes : null, finishedAt, job.archive_entry_id]);
      await tx.run("UPDATE download_jobs SET status = 'completed', finished_at = ?, error = NULL, retry_after = NULL WHERE id = ?", [finishedAt, job.id]);
    });
    const message = canStageSizeFilter
      ? `已将“${job.content}”交给 qBittorrent 读取元数据；仅大小达到 ${settings.autoDownloadMinSizeMb} MB 的文件才会开始下载。`
      : minimumBytes > 0
        ? `已将“${job.content}”提交给 qBittorrent；该磁力缺少可追踪的 BTIH，未执行自动单文件大小筛选。`
        : `已将“${job.content}”提交给 qBittorrent。`;
    await appendRuntimeLog({ level: 'success', source: 'download', subscriptionId: job.subscription_id, jobId: job.id, message });
    }
    await recordPerformanceMetric({ scope: 'download', metric: 'processed', dimension: isFilteredRetry ? 'refiltered' : 'submitted', durationMs: Date.now() - startedAtMs }).catch(() => undefined);
    await reportIntegrationStatus('qbittorrent', 'healthy', '最近一次下载提交成功').catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 qBittorrent 下载错误';
    const attempt = job.attempt_count + 1;
    const shouldRetry = attempt < MAX_JOB_ATTEMPTS && isRetryableJobError(error);
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE archive_entries SET download_status = ?, download_error = ?, updated_at = ? WHERE id = ?`,
        [shouldRetry ? (isFilteredRetry ? 'filtered' : 'queued') : 'failed', shouldRetry ? `${retryDescription(attempt)}：${message}` : message, finishedAt, job.archive_entry_id]);
      if (shouldRetry) {
        await tx.run("UPDATE download_jobs SET status = 'queued', started_at = NULL, finished_at = NULL, error = ?, attempt_count = ?, retry_after = ? WHERE id = ?", [message, attempt, new Date(Date.now() + retryDelayMs(attempt)).toISOString(), job.id]);
      } else {
        await tx.run("UPDATE download_jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [finishedAt, message, attempt, job.id]);
      }
    });
    await appendRuntimeLog({ level: shouldRetry ? 'info' : 'error', source: 'download', subscriptionId: job.subscription_id, jobId: job.id, message: shouldRetry ? `qBittorrent 提交“${job.content}”暂时失败，${retryDescription(attempt)}：${message}` : `qBittorrent 提交“${job.content}”失败：${message}` });
    await recordPerformanceMetric({ scope: 'download', metric: shouldRetry ? 'retry' : 'processed', dimension: shouldRetry ? retryReason(error) : 'failed', durationMs: shouldRetry ? 0 : Date.now() - startedAtMs }).catch(() => undefined);
    if (!/未启用/.test(message)) await reportIntegrationStatus('qbittorrent', 'degraded', '最近一次下载提交失败').catch(() => undefined);
    console.error(`Download job ${job.id} failed: ${message}`);
  }
  activeTask = null;
  notifyLive('archive', job.subscription_id);
  notifyLive('tasks');
}

let working = false;
let activeTask: WorkerTaskContext | null = null;
let lastInfrastructureLogAt = 0;
let lastStalledRecoveryAt = 0;

async function heartbeat() {
  await reportWorkerHeartbeat('download', activeTask?.label ?? 'qBittorrent 下载队列与状态同步', activeTask ? 'busy' : 'ready', activeTask).catch(() => undefined);
}

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

function hasDownloadSnapshotChanged(entry: TrackedDownload, nextStatus: string, torrent: QbittorrentTorrentState, checkedAtMs: number) {
  const previousProgress = Number(entry.download_progress ?? 0);
  const progressChanged = Math.abs(previousProgress - torrent.progress) >= PROGRESS_PERSIST_DELTA;
  const observedAt = entry.download_checked_at ? Date.parse(entry.download_checked_at) : 0;
  const periodicProgressRefresh = Math.abs(previousProgress - torrent.progress) > 0 && checkedAtMs - observedAt >= SNAPSHOT_REFRESH_MS;
  const previousSpeed = Number(entry.download_speed ?? 0);
  const speedChanged = Math.abs(previousSpeed - torrent.downloadSpeed) >= Math.max(SPEED_CHANGE_MIN_BYTES, Math.max(previousSpeed, torrent.downloadSpeed) * 0.2);
  return entry.download_status !== nextStatus
    || progressChanged
    || periodicProgressRefresh
    || speedChanged
    || !sameNumber(entry.download_size, torrent.totalSize)
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
  const entries = await db.all<TrackedDownload>(`SELECT id, subscription_id, content, download_status, download_added_at, download_checked_at, download_torrent_hash, magnet_value,
    download_progress, download_speed, download_size, downloaded_bytes, download_save_path, download_content_path, download_filter_min_size_bytes
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
  const metadataPending = new Set<number>();
  const fileFilterPlans: Array<(TrackedDownload & {
    hash: string;
    torrent: QbittorrentTorrentState;
    minimum: number;
    skippedFiles: QbittorrentTorrentFile[];
    selectedFiles: QbittorrentTorrentFile[];
  })> = [];
  for (const entry of tracked) {
    const minimum = Number(entry.download_filter_min_size_bytes ?? 0);
    if (!Number.isFinite(minimum) || minimum <= 0) continue;
    const torrent = byHash.get(entry.hash);
    if (!torrent) {
      metadataPending.add(entry.id);
      continue;
    }
    const files = await getQbittorrentTorrentFiles(settings, entry.hash);
    if (!files?.length) {
      metadataPending.add(entry.id);
      continue;
    }
    fileFilterPlans.push({
      ...entry,
      torrent,
      minimum,
      skippedFiles: files.filter((file) => file.size < minimum),
      selectedFiles: files.filter((file) => file.size >= minimum)
    });
  }
  // MetadataReceived stops the torrent before payload download. Apply qB's
  // per-file priorities first: 0 means “do not download”, 1 means normal.
  for (const plan of fileFilterPlans) {
    await setQbittorrentTorrentFilePriority(settings, plan.hash, plan.skippedFiles.map((file) => file.index), 0);
    await setQbittorrentTorrentFilePriority(settings, plan.hash, plan.selectedFiles.map((file) => file.index), 1);
  }
  const rejectedIds = new Set(fileFilterPlans.filter((plan) => plan.selectedFiles.length === 0).map((plan) => plan.id));
  const acceptedPlans = fileFilterPlans.filter((plan) => plan.selectedFiles.length > 0);
  if (acceptedPlans.length) await startQbittorrentTorrents(settings, acceptedPlans.map((plan) => plan.hash));
  const acceptedIds = new Set(acceptedPlans.map((plan) => plan.id));
  const fileFilterByEntryId = new Map(fileFilterPlans.map((plan) => [plan.id, plan]));
  const stopCandidates = tracked.filter((entry) => {
    const torrent = byHash.get(entry.hash);
    return Boolean(torrent && !rejectedIds.has(entry.id) && !metadataPending.has(entry.id) && torrent.progress >= 0.999 && !isStoppedState(torrent.state));
  });
  const stoppedIds = await stopCompletedTorrents(settings, stopCandidates);
  const checkedAt = new Date().toISOString();
  const completed: Array<Pick<TrackedDownload, 'id' | 'subscription_id' | 'content'>> = [];
  const removed: Array<Pick<TrackedDownload, 'subscription_id' | 'content'>> = [];
  const filtered: Array<{ subscription_id: number; content: string; skippedCount: number; minimum: number }> = [];
  const accepted: Array<{ subscription_id: number; content: string; selectedCount: number; skippedCount: number; selectedBytes: number; minimum: number }> = [];
  const changedSubscriptionIds = new Set<number>();
  const checkedAtMs = Date.parse(checkedAt);
  await db.transaction(async (tx) => {
    for (const entry of tracked) {
      const torrent = byHash.get(entry.hash);
      if (!torrent) {
        const submittedAt = entry.download_added_at ? new Date(entry.download_added_at).getTime() : 0;
        const hasSizeFilter = Number(entry.download_filter_min_size_bytes ?? 0) > 0;
        const grace = hasSizeFilter ? METADATA_DISCOVERY_GRACE_MS : 60_000;
        if ((entry.download_status === 'added' || hasSizeFilter) && submittedAt > 0 && Date.now() - submittedAt < grace) {
          if (hasSizeFilter && entry.download_status !== 'waiting') {
            await tx.run(`UPDATE archive_entries SET download_status = 'waiting', download_checked_at = ?,
            download_error = '正在读取磁力元数据，以应用最小单文件大小。', updated_at = ? WHERE id = ?`, [checkedAt, checkedAt, entry.id]);
            changedSubscriptionIds.add(entry.subscription_id);
          }
          continue;
        }
        if (entry.download_status !== 'removed') {
          await tx.run(`UPDATE archive_entries SET download_status = 'removed', download_speed = 0, download_checked_at = ?, download_removed_at = ?, updated_at = ?
            WHERE id = ?`, [checkedAt, checkedAt, checkedAt, entry.id]);
          removed.push({ subscription_id: entry.subscription_id, content: entry.content });
          changedSubscriptionIds.add(entry.subscription_id);
        }
        continue;
      }
      const minimum = Number(entry.download_filter_min_size_bytes ?? 0);
      if (minimum > 0) {
        if (metadataPending.has(entry.id) && (entry.download_status !== 'waiting' || !torrent || !sameNumber(entry.download_progress, torrent.progress) || !sameNumber(entry.download_speed, torrent.downloadSpeed))) {
          await tx.run(`UPDATE archive_entries SET download_status = 'waiting', download_torrent_hash = ?, download_checked_at = ?,
            download_progress = ?, download_speed = ?, download_size = ?, downloaded_bytes = ?, download_save_path = ?, download_content_path = ?,
            download_error = ?, updated_at = ? WHERE id = ?`,
          [entry.hash, checkedAt, torrent.progress, torrent.downloadSpeed, torrent.totalSize, torrent.downloadedBytes, torrent.savePath, torrent.contentPath,
            `正在读取元数据，以应用最小单文件大小 ${displaySize(minimum)}。`, checkedAt, entry.id]);
          changedSubscriptionIds.add(entry.subscription_id);
          continue;
        }
        if (metadataPending.has(entry.id)) continue;
        const plan = fileFilterByEntryId.get(entry.id);
        if (rejectedIds.has(entry.id) && plan) {
          await tx.run(`UPDATE archive_entries SET download_status = 'filtered', download_torrent_hash = ?, download_checked_at = ?,
            download_progress = ?, download_speed = 0, download_size = ?, downloaded_bytes = ?, download_save_path = ?, download_content_path = ?,
            download_error = ?, download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`,
          [entry.hash, checkedAt, torrent.progress, torrent.totalSize, torrent.downloadedBytes, torrent.savePath, torrent.contentPath,
            `自动单文件大小筛选：${plan.skippedFiles.length} 个文件均小于 ${displaySize(minimum)}，已在 qBittorrent 中设为不下载。`, checkedAt, entry.id]);
          filtered.push({ subscription_id: entry.subscription_id, content: entry.content, skippedCount: plan.skippedFiles.length, minimum });
          changedSubscriptionIds.add(entry.subscription_id);
          continue;
        }
        if (acceptedIds.has(entry.id) && plan) {
          const next = stateForDownload(torrent);
          const status = next === 'paused' ? 'waiting' : next;
          await tx.run(`UPDATE archive_entries SET download_status = ?, download_torrent_hash = ?, download_checked_at = ?,
            download_progress = ?, download_speed = ?, download_size = ?, downloaded_bytes = ?, download_save_path = ?, download_content_path = ?,
            download_error = NULL, download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`,
          [status, entry.hash, checkedAt, torrent.progress, torrent.downloadSpeed, torrent.totalSize, torrent.downloadedBytes, torrent.savePath, torrent.contentPath, checkedAt, entry.id]);
          accepted.push({
            subscription_id: entry.subscription_id,
            content: entry.content,
            selectedCount: plan.selectedFiles.length,
            skippedCount: plan.skippedFiles.length,
            selectedBytes: plan.selectedFiles.reduce((total, file) => total + file.size, 0),
            minimum
          });
          if (status === 'completed' && entry.download_status !== 'completed') completed.push({ id: entry.id, subscription_id: entry.subscription_id, content: entry.content });
          changedSubscriptionIds.add(entry.subscription_id);
          continue;
        }
      }
      const next = stateForDownload(torrent);
      if (hasDownloadSnapshotChanged(entry, next, torrent, checkedAtMs)) {
        await tx.run(`UPDATE archive_entries SET download_status = ?, download_torrent_hash = ?, download_checked_at = ?,
          download_progress = ?, download_speed = ?, download_size = ?, downloaded_bytes = ?, download_save_path = ?, download_content_path = ?, download_removed_at = NULL, updated_at = ?
          WHERE id = ?`, [next, entry.hash, checkedAt, torrent.progress, torrent.downloadSpeed, torrent.totalSize, torrent.downloadedBytes, torrent.savePath, torrent.contentPath, checkedAt, entry.id]);
        changedSubscriptionIds.add(entry.subscription_id);
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
  for (const entry of filtered) {
    await appendRuntimeLog({ level: 'info', source: 'download', subscriptionId: entry.subscription_id, message: `自动下载未保留“${entry.content}”：${entry.skippedCount} 个文件均小于最小单文件大小 ${displaySize(entry.minimum)}，已在 qBittorrent 中设为不下载。` });
  }
  for (const entry of accepted) {
    const skipped = entry.skippedCount ? `，已跳过 ${entry.skippedCount} 个较小文件` : '';
    await appendRuntimeLog({ level: 'success', source: 'download', subscriptionId: entry.subscription_id, message: `“${entry.content}”已按单文件大小筛选：保留 ${entry.selectedCount} 个文件（共 ${displaySize(entry.selectedBytes)}，每个 ≥ ${displaySize(entry.minimum)}）${skipped}，已开始下载。` });
  }
  for (const subscriptionId of changedSubscriptionIds) notifyLive('archive', subscriptionId);
  if (completed.length || removed.length || filtered.length || accepted.length) notifyLive('tasks');
}

async function tick(observe = true) {
  if (working) return;
  working = true;
  try {
    await heartbeat();
    if (isExecutionEngineDraining()) return;
    await refreshSettings();
    await recoverStalledJobs();
    await runNextDownloadJob();
    if (observe) try {
      await syncDownloadStates();
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知 qBittorrent 状态同步错误';
      console.error(`qBittorrent download state sync failed: ${message}`);
      await reportIntegrationStatus('qbittorrent', 'degraded', '最近一次下载状态同步失败').catch(() => undefined);
      // qBittorrent is externally managed. Keep the Worker alive and the
      // Docker readiness gate focused on Page Watch's own processes.
      await reportWorkerHeartbeat('download', 'qBittorrent 外部服务降级；稍后会继续同步下载状态').catch(() => undefined);
    }
  } catch (error) {
    await reportWorkerHeartbeat('download', 'qBittorrent 下载 Worker 遇到基础设施错误', 'error').catch(() => undefined);
    await reportInfrastructureError(error);
  }
  finally { working = false; }
}

export async function runDownloadWorkerTick() { await tick(false); }
export function isDownloadWorkerBusy() { return working; }
export async function observeQbittorrentDownloads() {
  await refreshSettings();
  await syncDownloadStates();
}

if (process.env.PAGE_WATCH_WORKER_AUTOSTART !== '0') {
  void appendRuntimeLog({ level: 'info', source: 'system', message: 'qBittorrent 下载 Worker 已启动（单线程提交）。' })
    .catch((error) => console.error(`Unable to save download startup log: ${error instanceof Error ? error.message : String(error)}`));
  console.log('Page Watch qBittorrent download worker started');
  void tick();
  setInterval(() => void tick(), POLL_MS);
  const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
  heartbeatTimer.unref();
}

import { db, getJellyfinSettings, getSetting, refreshSettings } from './db.js';
import { isJellyfinSyncDue } from './library-sync-schedule.js';
import { getInspectionRules } from './inspection-rules.js';

export type HandlerName = 'capture' | 'release' | 'magnet' | 'download' | 'library' | 'notification';

export async function runnableHandlers() {
  await refreshSettings();
  const now = new Date().toISOString();
  const rows = await db.get<Record<HandlerName | 'library_sync_running', boolean>>(`SELECT
    EXISTS(SELECT 1 FROM jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) OR EXISTS(SELECT 1 FROM subscriptions WHERE is_active = 1 AND (next_scheduled_at IS NULL OR next_scheduled_at <= ?)) AS capture,
    EXISTS(SELECT 1 FROM release_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) OR
      (? = 1 AND EXISTS(SELECT 1 FROM archive_entries WHERE release_status = 'unsearched' OR
        (release_status = 'unavailable' AND release_error = '详情页未找到标签“发行日期”对应的日期值。'))) AS "release",
    EXISTS(SELECT 1 FROM magnet_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) AS magnet,
    EXISTS(SELECT 1 FROM download_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) AS download,
    EXISTS(SELECT 1 FROM library_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) OR EXISTS(SELECT 1 FROM library_sync_jobs WHERE status = 'queued') AS library,
    EXISTS(SELECT 1 FROM library_sync_jobs WHERE status = 'running') AS library_sync_running,
    EXISTS(SELECT 1 FROM notification_outbox WHERE status = 'queued' AND next_attempt_at <= ?) OR EXISTS(
      SELECT 1 FROM full_scan_batches b WHERE b.status = 'processing'
        AND NOT EXISTS(SELECT 1 FROM archive_entries a JOIN release_jobs j ON j.archive_entry_id = a.id WHERE a.full_scan_batch_id = b.id AND j.status IN ('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM archive_entries a JOIN magnet_jobs j ON j.archive_entry_id = a.id WHERE a.full_scan_batch_id = b.id AND j.status IN ('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM archive_entries a JOIN library_jobs j ON j.archive_entry_id = a.id WHERE a.full_scan_batch_id = b.id AND j.status IN ('queued','running'))
    ) AS notification`, [now, now, now, getInspectionRules().releaseDate.enabled ? 1 : 0, now, now, now, now]);
  const jellyfin = getJellyfinSettings();
  const dueLibrarySync = jellyfin.enabled && jellyfin.libraryIds.length > 0 && isJellyfinSyncDue({
    lastSyncedAt: getSetting('jellyfin_last_synced_at'),
    lastAttemptAt: getSetting('jellyfin_last_sync_attempt_at'),
    mediaIndexSyncedAt: getSetting('jellyfin_media_index_synced_at'),
    intervalMinutes: jellyfin.syncIntervalMinutes
  });
  return {
    capture: Boolean(rows?.capture),
    release: Boolean(rows?.release),
    magnet: Boolean(rows?.magnet),
    download: Boolean(rows?.download),
    library: Boolean(rows?.library) || (dueLibrarySync && !Boolean(rows?.library_sync_running)),
    notification: Boolean(rows?.notification)
  };
}


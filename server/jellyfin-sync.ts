import { appendRuntimeLog, db, getJellyfinSettings, queueMagnetJob, setSetting } from './db.js';
import { listJellyfinMedia, type JellyfinMedia } from './jellyfin.js';
import { archiveKey, mediaKeys } from './jellyfin-match.js';

type ArchiveCandidate = { id: number; subscription_id: number; content: string; jellyfin_status: string; magnet_status: string };
type Match = Pick<JellyfinMedia, 'id' | 'name'>;

export type JellyfinSyncResult = { scanned: number; matched: number; notFound: number; libraries: number };

/** Synchronize all archive entries against one locally-built Jellyfin media index. */
export async function syncJellyfinLibrary(trigger: 'manual' | 'scheduled' = 'scheduled'): Promise<JellyfinSyncResult> {
  const settings = getJellyfinSettings();
  if (!settings.enabled) throw new Error('Jellyfin 影视库同步尚未启用。');
  if (!settings.libraryIds.length) throw new Error('请先选择至少一个 Jellyfin 媒体库。');

  const media = await listJellyfinMedia(settings);
  const index = new Map<string, Match>();
  for (const item of media) {
    for (const key of mediaKeys(item)) if (!index.has(key)) index.set(key, { id: item.id, name: item.name });
  }
  const entries = await db.all<ArchiveCandidate>('SELECT id, subscription_id, content, jellyfin_status, magnet_status FROM archive_entries ORDER BY id ASC');
  const now = new Date().toISOString();
  let matched = 0;
  let notFound = 0;
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const item = index.get(archiveKey(entry.content) ?? '');
      if (item) {
        matched += 1;
        await tx.run(`UPDATE archive_entries SET jellyfin_status = 'available', jellyfin_item_id = ?, jellyfin_item_name = ?,
          jellyfin_matched_at = ?, jellyfin_error = NULL, magnet_status = CASE WHEN ? THEN 'skipped' ELSE magnet_status END,
          magnet_checked_at = CASE WHEN ? THEN ? ELSE magnet_checked_at END,
          magnet_error = CASE WHEN ? THEN 'Jellyfin 已入库，自动跳过磁力检索。' ELSE magnet_error END, updated_at = ? WHERE id = ?`,
        [item.id, item.name, now, settings.skipMagnetWhenAvailable ? 1 : 0, settings.skipMagnetWhenAvailable ? 1 : 0, now, settings.skipMagnetWhenAvailable ? 1 : 0, now, entry.id]);
      } else {
        notFound += 1;
        await tx.run(`UPDATE archive_entries SET jellyfin_status = 'not_found', jellyfin_item_id = NULL, jellyfin_item_name = NULL,
          jellyfin_matched_at = ?, jellyfin_error = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
        if (settings.skipMagnetWhenAvailable && entry.magnet_status === 'skipped') {
          await tx.run(`UPDATE archive_entries SET magnet_status = 'pending', magnet_error = NULL, updated_at = ? WHERE id = ?`, [now, entry.id]);
          await queueMagnetJob(entry.id, tx);
        }
      }
    }
  });
  await setSetting('jellyfin_last_synced_at', now);
  await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 影视库${trigger === 'manual' ? '手动' : '定时'}同步完成：扫描 ${media.length} 个媒体项目，${matched} 条已入库，${notFound} 条未入库。` });
  return { scanned: media.length, matched, notFound, libraries: settings.libraryIds.length };
}

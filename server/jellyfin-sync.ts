import { appendRuntimeLog, db, getJellyfinSettings, setSetting } from './db.js';
import { listJellyfinMedia, type JellyfinMedia } from './jellyfin.js';

type ArchiveCandidate = { id: number; subscription_id: number; content: string; jellyfin_status: string };
type Match = Pick<JellyfinMedia, 'id' | 'name'>;

function archiveKey(value: string) {
  const match = value.trim().match(/^([a-z]{2,16})[-_\s]+(\d{2,8})$/i);
  return match ? `${match[1].toLowerCase()}-${match[2]}` : null;
}

function mediaKeys(media: JellyfinMedia) {
  const keys = new Set<string>();
  const source = [media.name, media.originalTitle, media.path].filter((value): value is string => Boolean(value)).join(' ');
  const matcher = /(^|[^a-z0-9])([a-z]{2,16})[-_\s]+(\d{2,8})(?=$|[^a-z0-9])/gi;
  for (const match of source.matchAll(matcher)) keys.add(`${match[2].toLowerCase()}-${match[3]}`);
  return keys;
}

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
  const entries = await db.all<ArchiveCandidate>('SELECT id, subscription_id, content, jellyfin_status FROM archive_entries ORDER BY id ASC');
  const now = new Date().toISOString();
  let matched = 0;
  let notFound = 0;
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const item = index.get(archiveKey(entry.content) ?? '');
      if (item) {
        matched += 1;
        await tx.run(`UPDATE archive_entries SET jellyfin_status = 'available', jellyfin_item_id = ?, jellyfin_item_name = ?,
          jellyfin_matched_at = ?, jellyfin_error = NULL, updated_at = ? WHERE id = ?`, [item.id, item.name, now, now, entry.id]);
      } else {
        notFound += 1;
        await tx.run(`UPDATE archive_entries SET jellyfin_status = 'not_found', jellyfin_item_id = NULL, jellyfin_item_name = NULL,
          jellyfin_matched_at = ?, jellyfin_error = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
      }
    }
  });
  await setSetting('jellyfin_last_synced_at', now);
  await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 影视库${trigger === 'manual' ? '手动' : '定时'}同步完成：扫描 ${media.length} 个媒体项目，${matched} 条已入库，${notFound} 条未入库。` });
  return { scanned: media.length, matched, notFound, libraries: settings.libraryIds.length };
}

import { appendRuntimeLog, db, getJellyfinSettings, setSetting } from './db.js';
import { listJellyfinMedia } from './jellyfin.js';
import { archiveKey } from './jellyfin-match.js';
import { readJellyfinMediaIndex, saveJellyfinMediaIndex } from './jellyfin-cache.js';

type ArchiveCandidate = { id: number; archive_code: string | null };
type ArchiveCodeCandidate = { id: number; content: string };

export type JellyfinSyncResult = { scanned: number; indexedCodes: number; matched: number; notFound: number; libraries: number };
export type JellyfinSyncProgress = { phase: 'reading' | 'indexing' | 'caching' | 'writing'; current: number | null; total: number | null; label: string };

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/** Backfill only rows created before archive_code was introduced. */
async function backfillArchiveCodes() {
  const legacy = await db.all<ArchiveCodeCandidate>('SELECT id, content FROM archive_entries WHERE archive_code IS NULL ORDER BY id ASC LIMIT 1_000');
  const mapped = legacy.map((entry) => ({ id: entry.id, code: archiveKey(entry.content) })).filter((entry): entry is { id: number; code: string } => Boolean(entry.code));
  for (const batch of chunks(mapped, 200)) {
    const clauses = batch.map(() => 'WHEN ? THEN ?').join(' ');
    await db.run(`UPDATE archive_entries SET archive_code = CASE id ${clauses} ELSE archive_code END WHERE id IN (${batch.map(() => '?').join(', ')})`,
      [...batch.flatMap((entry) => [entry.id, entry.code]), ...batch.map((entry) => entry.id)]);
  }
}

async function writeArchiveMatches(entries: ArchiveCandidate[], index: Map<string, { id: string; name: string }>, skipMagnetWhenAvailable: boolean, onProgress?: (completed: number) => Promise<void> | void) {
  const now = new Date().toISOString();
  const matched = entries.flatMap((entry) => {
    const media = entry.archive_code ? index.get(entry.archive_code) : undefined;
    return media ? [{ id: entry.id, media }] : [];
  });
  const notFound = entries.filter((entry) => !entry.archive_code || !index.has(entry.archive_code)).map((entry) => entry.id);
  let completed = 0;
  // Per-row values differ only for the exact matched media. CASE keeps that
  // in a bounded number of queries instead of one update for every archive.
  for (const batch of chunks(matched, 100)) {
    const itemCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
    const nameCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
    const ids = batch.map((entry) => entry.id);
    await db.run(`UPDATE archive_entries SET jellyfin_status = 'available',
      jellyfin_item_id = CASE id ${itemCases} ELSE jellyfin_item_id END,
      jellyfin_item_name = CASE id ${nameCases} ELSE jellyfin_item_name END,
      jellyfin_matched_at = ?, jellyfin_error = NULL,
      magnet_status = CASE WHEN ? AND magnet_status <> 'found' THEN 'skipped' ELSE magnet_status END,
      magnet_checked_at = CASE WHEN ? AND magnet_status <> 'found' THEN ? ELSE magnet_checked_at END,
      magnet_error = CASE WHEN ? AND magnet_status <> 'found' THEN 'Jellyfin 已入库，自动跳过磁力检索。' ELSE magnet_error END,
      updated_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, [
      ...batch.flatMap((entry) => [entry.id, entry.media.id]),
      ...batch.flatMap((entry) => [entry.id, entry.media.name]),
      now,
      skipMagnetWhenAvailable ? 1 : 0,
      skipMagnetWhenAvailable ? 1 : 0,
      now,
      skipMagnetWhenAvailable ? 1 : 0,
      now,
      ...ids
    ]);
    completed += batch.length;
    await onProgress?.(completed);
  }
  for (const batch of chunks(notFound, 250)) {
    // A complete sync may temporarily see fewer items while Jellyfin scans or
    // upgrades. Do not resurrect previously skipped magnet jobs here.
    await db.run(`UPDATE archive_entries SET jellyfin_status = 'not_found', jellyfin_item_id = NULL, jellyfin_item_name = NULL,
      jellyfin_matched_at = ?, jellyfin_error = NULL, updated_at = ? WHERE id IN (${batch.map(() => '?').join(', ')})`, [now, now, ...batch]);
    completed += batch.length;
    await onProgress?.(completed);
  }
  return { matched: matched.length, notFound: notFound.length };
}

/** Synchronize all archive entries against one locally-built Jellyfin media index. */
export async function syncJellyfinLibrary(trigger: 'manual' | 'scheduled' = 'scheduled', onProgress?: (progress: JellyfinSyncProgress) => Promise<void> | void): Promise<JellyfinSyncResult> {
  const settings = getJellyfinSettings();
  if (!settings.enabled) throw new Error('Jellyfin 影视库同步尚未启用。');
  if (!settings.libraryIds.length) throw new Error('请先选择至少一个 Jellyfin 媒体库。');

  await onProgress?.({ phase: 'reading', current: 0, total: null, label: '正在读取 Jellyfin 媒体库' });
  const media = await listJellyfinMedia(settings);
  await onProgress?.({ phase: 'indexing', current: media.length, total: media.length, label: `已读取 ${media.length} 个媒体项目，正在更新 MySQL 索引` });
  await onProgress?.({ phase: 'caching', current: 0, total: media.length, label: `正在保存 ${media.length} 个 Jellyfin 媒体项目到 MySQL` });
  const cache = await saveJellyfinMediaIndex(media, settings.libraryIds);
  await setSetting('jellyfin_media_index_synced_at', cache.syncedAt);
  await onProgress?.({ phase: 'caching', current: media.length, total: media.length, label: `MySQL 索引已更新：${cache.mediaCount} 个媒体项目，${cache.codeCount} 个番号` });
  // Read back from MySQL: all following archive matching uses the persisted
  // snapshot, exactly like incoming single-entry matching does.
  const index = await readJellyfinMediaIndex(settings.libraryIds);
  await backfillArchiveCodes();
  const entries = await db.all<ArchiveCandidate>('SELECT id, archive_code FROM archive_entries ORDER BY id ASC');
  await onProgress?.({ phase: 'writing', current: 0, total: entries.length, label: `正在写入影视库匹配（0 / ${entries.length}）` });
  const matchedResult = await writeArchiveMatches(entries, index, settings.skipMagnetWhenAvailable, async (completed) => {
    await onProgress?.({ phase: 'writing', current: completed, total: entries.length, label: `正在写入影视库匹配（${completed} / ${entries.length}）` });
  });
  const { matched, notFound } = matchedResult;
  const now = new Date().toISOString();
  await setSetting('jellyfin_last_synced_at', now);
  await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 影视库${trigger === 'manual' ? '手动' : '定时'}同步完成：已更新 ${cache.mediaCount} 个媒体项目、${cache.codeCount} 个番号索引；${matched} 条已入库，${notFound} 条未入库。` });
  return { scanned: media.length, indexedCodes: cache.codeCount, matched, notFound, libraries: settings.libraryIds.length };
}

import { db, getJellyfinSettings, setSetting } from './db.js';
import { streamJellyfinMedia } from './jellyfin.js';
import { archiveKey } from './jellyfin-match.js';
import { JellyfinMediaIndexWriter } from './jellyfin-cache.js';

type ArchiveCandidate = { id: number; archive_code: string | null };
type ArchiveCodeCandidate = { id: number; content: string };
type MediaMatch = { code: string; id: string; name: string };

export type JellyfinSyncResult = { scanned: number; indexedCodes: number; matched: number; notFound: number; libraries: number };
export type JellyfinSyncProgress = { phase: 'reading' | 'indexing' | 'caching' | 'writing'; current: number | null; total: number | null; label: string };

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function placeholders(values: unknown[]) { return values.map(() => '?').join(', '); }

/** Backfill bounded batches so an old archive never becomes one large array. */
async function backfillArchiveCodes() {
  while (true) {
    const legacy = await db.all<ArchiveCodeCandidate>('SELECT id, content FROM archive_entries WHERE archive_code IS NULL ORDER BY id ASC LIMIT 500');
    if (!legacy.length) return;
    const mapped = legacy.map((entry) => ({ id: entry.id, code: archiveKey(entry.content) })).filter((entry): entry is { id: number; code: string } => Boolean(entry.code));
    if (mapped.length) {
      for (const batch of chunks(mapped, 200)) {
        const cases = batch.map(() => 'WHEN ? THEN ?').join(' ');
        await db.run(`UPDATE archive_entries SET archive_code = CASE id ${cases} ELSE archive_code END WHERE id IN (${placeholders(batch)})`,
          [...batch.flatMap((entry) => [entry.id, entry.code]), ...batch.map((entry) => entry.id)]);
      }
    }
    // Rows with no valid code are terminal for this migration; avoid looping.
    const invalid = legacy.filter((entry) => !archiveKey(entry.content)).map((entry) => entry.id);
    if (invalid.length) await db.run(`UPDATE archive_entries SET archive_code = '' WHERE id IN (${placeholders(invalid)})`, invalid);
  }
}

async function writeArchiveBatch(entries: ArchiveCandidate[], libraryIds: string[], skipMagnetWhenAvailable: boolean, now: string) {
  const codes = [...new Set(entries.map((entry) => entry.archive_code).filter((value): value is string => Boolean(value)))];
  const index = new Map<string, { id: string; name: string }>();
  if (codes.length) {
    const rows = await db.all<MediaMatch>(`SELECT c.code, m.item_id AS id, m.name
      FROM jellyfin_media_codes c JOIN jellyfin_media_items m ON m.item_id = c.item_id
      WHERE c.code IN (${placeholders(codes)}) AND m.library_id IN (${placeholders(libraryIds)})
      ORDER BY c.code ASC, m.synced_at DESC, m.item_id ASC`, [...codes, ...libraryIds]);
    for (const row of rows) if (!index.has(row.code)) index.set(row.code, { id: row.id, name: row.name });
  }
  const matched = entries.flatMap((entry) => {
    const media = entry.archive_code ? index.get(entry.archive_code) : undefined;
    return media ? [{ id: entry.id, media }] : [];
  });
  const notFound = entries.filter((entry) => !entry.archive_code || !index.has(entry.archive_code)).map((entry) => entry.id);
  if (matched.length) {
    const itemCases = matched.map(() => 'WHEN ? THEN ?').join(' ');
    const nameCases = matched.map(() => 'WHEN ? THEN ?').join(' ');
    const ids = matched.map((entry) => entry.id);
    await db.run(`UPDATE archive_entries SET jellyfin_status = 'available',
      jellyfin_item_id = CASE id ${itemCases} ELSE jellyfin_item_id END,
      jellyfin_item_name = CASE id ${nameCases} ELSE jellyfin_item_name END,
      jellyfin_matched_at = ?, jellyfin_error = NULL,
      magnet_status = CASE WHEN ? AND magnet_status <> 'found' THEN 'skipped' ELSE magnet_status END,
      magnet_checked_at = CASE WHEN ? AND magnet_status <> 'found' THEN ? ELSE magnet_checked_at END,
      magnet_error = CASE WHEN ? AND magnet_status <> 'found' THEN 'Jellyfin 已入库，自动跳过磁力检索。' ELSE magnet_error END,
      updated_at = ? WHERE id IN (${placeholders(ids)})`, [
      ...matched.flatMap((entry) => [entry.id, entry.media.id]),
      ...matched.flatMap((entry) => [entry.id, entry.media.name]), now,
      skipMagnetWhenAvailable ? 1 : 0, skipMagnetWhenAvailable ? 1 : 0, now,
      skipMagnetWhenAvailable ? 1 : 0, now, ...ids
    ]);
  }
  if (notFound.length) {
    // A complete snapshot can briefly be incomplete while Jellyfin rescans.
    // Do not requeue/resurrect a previously skipped magnet here.
    await db.run(`UPDATE archive_entries SET jellyfin_status = 'not_found', jellyfin_item_id = NULL, jellyfin_item_name = NULL,
      jellyfin_matched_at = ?, jellyfin_error = NULL, updated_at = ? WHERE id IN (${placeholders(notFound)})`, [now, now, ...notFound]);
  }
  return { matched: matched.length, notFound: notFound.length };
}

async function writeArchiveMatches(libraryIds: string[], skipMagnetWhenAvailable: boolean, onProgress?: (completed: number, total: number) => Promise<void> | void) {
  const totalRow = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM archive_entries');
  const total = Number(totalRow?.count ?? 0);
  const now = new Date().toISOString();
  let cursor = 0;
  let completed = 0;
  let matched = 0;
  let notFound = 0;
  while (true) {
    const batch = await db.all<ArchiveCandidate>('SELECT id, archive_code FROM archive_entries WHERE id > ? ORDER BY id ASC LIMIT 250', [cursor]);
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    const result = await writeArchiveBatch(batch, libraryIds, skipMagnetWhenAvailable, now);
    matched += result.matched;
    notFound += result.notFound;
    completed += batch.length;
    await onProgress?.(completed, total);
  }
  return { matched, notFound, total };
}

/**
 * Synchronize a complete Jellyfin snapshot without keeping the entire remote
 * library, code index or archive list in Node. All live matching remains the
 * same MySQL index used by incoming archive entries.
 */
export async function syncJellyfinLibrary(trigger: 'manual' | 'scheduled' = 'scheduled', onProgress?: (progress: JellyfinSyncProgress) => Promise<void> | void): Promise<JellyfinSyncResult> {
  const settings = getJellyfinSettings();
  if (!settings.enabled) throw new Error('Jellyfin 影视库同步尚未启用。');
  if (!settings.libraryIds.length) throw new Error('请先选择至少一个 Jellyfin 媒体库。');

  const writer = new JellyfinMediaIndexWriter(settings.libraryIds);
  let scanned = 0;
  await onProgress?.({ phase: 'reading', current: 0, total: null, label: '正在读取 Jellyfin 媒体库' });
  await streamJellyfinMedia(settings, async (page, rawCount, total) => {
    scanned = rawCount;
    await onProgress?.({ phase: 'indexing', current: rawCount, total, label: `正在读取 Jellyfin 媒体库（${rawCount}${total ? ` / ${total}` : ''}）` });
    await writer.writePage(page);
    await onProgress?.({ phase: 'caching', current: rawCount, total, label: `已分批写入 MySQL Jellyfin 索引（${rawCount}${total ? ` / ${total}` : ''}）` });
  });
  const cache = await writer.finalize();
  await setSetting('jellyfin_media_index_synced_at', cache.syncedAt);
  await backfillArchiveCodes();
  await onProgress?.({ phase: 'writing', current: 0, total: null, label: '正在批量写入影视库匹配' });
  const matches = await writeArchiveMatches(settings.libraryIds, settings.skipMagnetWhenAvailable, async (completed, total) => {
    await onProgress?.({ phase: 'writing', current: completed, total, label: `正在写入影视库匹配（${completed} / ${total}）` });
  });
  const now = new Date().toISOString();
  await setSetting('jellyfin_last_synced_at', now);
  return { scanned, indexedCodes: cache.codeCount, matched: matches.matched, notFound: matches.notFound, libraries: settings.libraryIds.length };
}

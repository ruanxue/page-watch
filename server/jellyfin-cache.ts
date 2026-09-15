import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import type { JellyfinMedia } from './jellyfin.js';
import { archiveKey, mediaKeys } from './jellyfin-match.js';

export type CachedJellyfinMatch = { id: string; name: string };

type CachedCodeRow = CachedJellyfinMatch & { code: string };

function selectedLibraryIds(libraryIds: string[]) {
  return [...new Set(libraryIds.map((id) => id.trim()).filter(Boolean))];
}

function placeholders(values: unknown[]) {
  return values.map(() => '?').join(', ');
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export class JellyfinMediaIndexWriter {
  readonly syncId = randomUUID();
  readonly syncedAt = new Date().toISOString();
  private mediaCount = 0;
  private codeCount = 0;

  constructor(private readonly libraryIds: string[]) {
    if (!selectedLibraryIds(libraryIds).length) throw new Error('请至少选择一个 Jellyfin 媒体库。');
  }

  async writePage(media: JellyfinMedia[]) {
    if (!media.length) return;
    const unique = [...new Map(media.map((item) => [item.id, item])).values()];
    const codes = unique.flatMap((item) => [...mediaKeys(item)].map((code) => ({ itemId: item.id, code })));
    await db.transaction(async (tx) => {
      for (const batch of chunks(unique, 100)) {
        await tx.run(`INSERT INTO jellyfin_media_items
          (item_id, library_id, name, original_title, media_path, media_type, sync_id, synced_at)
          VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
          ON DUPLICATE KEY UPDATE library_id = VALUES(library_id), name = VALUES(name), original_title = VALUES(original_title),
            media_path = VALUES(media_path), media_type = VALUES(media_type), sync_id = VALUES(sync_id), synced_at = VALUES(synced_at)`,
        batch.flatMap((item) => [item.id, item.libraryId, item.name, item.originalTitle, item.path, item.type, this.syncId, this.syncedAt]));
      }
      for (const batch of chunks(unique.map((item) => item.id), 250)) await tx.run(`DELETE FROM jellyfin_media_codes WHERE item_id IN (${placeholders(batch)})`, batch);
      for (const batch of chunks(codes, 250)) await tx.run(`INSERT IGNORE INTO jellyfin_media_codes (item_id, code)
        VALUES ${batch.map(() => '(?, ?)').join(', ')}`, batch.flatMap((item) => [item.itemId, item.code]));
    });
    this.mediaCount += unique.length;
    this.codeCount += codes.length;
  }

  async finalize() {
    const selected = selectedLibraryIds(this.libraryIds);
    const ids = placeholders(selected);
    await db.transaction(async (tx) => {
      await tx.run(`DELETE c FROM jellyfin_media_codes c JOIN jellyfin_media_items m ON m.item_id = c.item_id
        WHERE m.library_id IN (${ids}) AND m.sync_id <> ?`, [...selected, this.syncId]);
      await tx.run(`DELETE FROM jellyfin_media_items WHERE library_id IN (${ids}) AND sync_id <> ?`, [...selected, this.syncId]);
    });
    return { mediaCount: this.mediaCount, codeCount: this.codeCount, syncedAt: this.syncedAt };
  }
}

/** Replace the selected-library snapshot only after Jellyfin has been read successfully. */
export async function saveJellyfinMediaIndex(media: JellyfinMedia[], libraryIds: string[]) {
  const writer = new JellyfinMediaIndexWriter(libraryIds);
  await writer.writePage(media);
  return writer.finalize();
}

/** Build the full-sync matcher from the persisted MySQL index, never the raw API response. */
export async function readJellyfinMediaIndex(libraryIds: string[]) {
  const selected = selectedLibraryIds(libraryIds);
  if (!selected.length) return new Map<string, CachedJellyfinMatch>();
  const ids = placeholders(selected);
  const rows = await db.all<CachedCodeRow>(`SELECT c.code, m.item_id AS id, m.name
    FROM jellyfin_media_codes c JOIN jellyfin_media_items m ON m.item_id = c.item_id
    WHERE m.library_id IN (${ids}) ORDER BY m.synced_at DESC, m.item_id ASC`, selected);
  const index = new Map<string, CachedJellyfinMatch>();
  for (const row of rows) if (!index.has(row.code)) index.set(row.code, { id: row.id, name: row.name });
  return index;
}

/** Exact, indexed single-entry lookup used by the normal archive pipeline. */
export async function findCachedJellyfinMedia(content: string, libraryIds: string[]) {
  const code = archiveKey(content);
  const selected = selectedLibraryIds(libraryIds);
  if (!code || !selected.length) return null;
  const ids = placeholders(selected);
  return db.get<CachedJellyfinMatch>(`SELECT m.item_id AS id, m.name
    FROM jellyfin_media_codes c JOIN jellyfin_media_items m ON m.item_id = c.item_id
    WHERE c.code = ? AND m.library_id IN (${ids})
    ORDER BY m.synced_at DESC, m.item_id ASC LIMIT 1`, [code, ...selected]) ?? null;
}

/** Configuration changes invalidate the snapshot rather than risking stale matches. */
export async function clearJellyfinMediaIndex() {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM jellyfin_media_codes');
    await tx.run('DELETE FROM jellyfin_media_items');
  });
}

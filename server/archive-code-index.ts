import { db, getSetting, refreshSettings, type DatabaseClient } from './db.js';
import { productCodeKeys, productCodeSearchPatterns } from './code-search-parser.js';

const migrationKey = 'archive_entry_codes_backfill_v1';
const cursorKey = 'archive_entry_codes_backfill_cursor_v1';
const chunkSize = 100;

export type ArchiveCodeRow = { id: number; subscription_id: number; content: string; title: string | null };

export function codesForArchiveEntry(content: string, title: string | null) {
  return [...new Set([...productCodeKeys(content), ...productCodeKeys(title ?? '')])];
}

/** Keep the indexed aliases in the same transaction as an archive write. */
export async function replaceArchiveCodes(client: DatabaseClient, rows: ArchiveCodeRow[]) {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const batch = rows.slice(offset, offset + chunkSize);
    if (!batch.length) continue;
    await client.run(`DELETE FROM archive_entry_codes WHERE archive_entry_id IN (${batch.map(() => '?').join(', ')})`, batch.map((row) => row.id));
    const aliases = batch.flatMap((row) => codesForArchiveEntry(row.content, row.title).map((code) => [row.id, row.subscription_id, code]));
    for (let index = 0; index < aliases.length; index += 200) {
      const values = aliases.slice(index, index + 200);
      await client.run(`INSERT IGNORE INTO archive_entry_codes (archive_entry_id, subscription_id, code) VALUES ${values.map(() => '(?, ?, ?)').join(', ')}`, values.flat());
    }
  }
}

/** Return only exact code matches. The bounded legacy path is temporary until backfill finishes. */
export async function findArchiveCodeMatches(client: DatabaseClient, codes: string[], subscriptionId?: number, allMatches = true) {
  const requested = [...new Set(codes)].filter(Boolean);
  if (!requested.length) return [] as Array<{ id: number; code: string }>;
  const indexed = await client.all<{ id: number; code: string }>(`SELECT archive_entry_id AS id, code FROM archive_entry_codes
    WHERE ${subscriptionId === undefined ? '' : 'subscription_id = ? AND '}code IN (${requested.map(() => '?').join(', ')})
    ${subscriptionId === undefined ? 'ORDER BY archive_entry_id DESC LIMIT 500' : ''}`,
  [...(subscriptionId === undefined ? [] : [subscriptionId]), ...requested]);
  const found = new Set(indexed.map((row) => `${row.id}:${row.code}`));
  if (getSetting(migrationKey) === '1') return indexed;
  const searchCodes = allMatches ? requested : requested.filter((code) => !indexed.some((row) => row.code === code));
  if (!searchCodes.length) return indexed;

  // Old rows can contain a matching code only in the title. Check them until
  // every row has been indexed, then remove this expensive path automatically.
  const patterns = searchCodes.flatMap(productCodeSearchPatterns);
  if (!patterns.length) return indexed;
  const clause = patterns.map(() => 'LOWER(content) LIKE ?').concat(patterns.map(() => "LOWER(COALESCE(title, '')) LIKE ?")).join(' OR ');
  const wanted = new Set(searchCodes);
  let before = Number.MAX_SAFE_INTEGER;
  while (true) {
    const legacy = await client.all<ArchiveCodeRow>(`SELECT id, subscription_id, content, title FROM archive_entries
      WHERE ${subscriptionId === undefined ? '' : 'subscription_id = ? AND '}id < ? AND (${clause})
      ORDER BY id DESC LIMIT 200`, [...(subscriptionId === undefined ? [] : [subscriptionId]), before, ...patterns, ...patterns]);
    for (const row of legacy) for (const code of codesForArchiveEntry(row.content, row.title)) {
      const key = `${row.id}:${code}`;
      if (wanted.has(code) && !found.has(key)) { indexed.push({ id: row.id, code }); found.add(key); }
    }
    if (legacy.length < 200 || (subscriptionId === undefined && indexed.length >= 500) || (!allMatches && searchCodes.every((code) => indexed.some((row) => row.code === code)))) break;
    before = legacy[legacy.length - 1].id;
  }
  return indexed;
}

/** One small, committed page at a time; a restart resumes from the cursor. */
export async function backfillArchiveCodeIndex() {
  if (getSetting(migrationKey) === '1') return;
  const target = await db.get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM archive_entries');
  let cursor = Number(getSetting(cursorKey) || 0);
  while (cursor < Number(target?.id ?? 0)) {
    const next = await db.transaction(async (tx) => {
      const rows = await tx.all<ArchiveCodeRow>(`SELECT id, subscription_id, content, title FROM archive_entries
        WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ${chunkSize} FOR UPDATE`, [cursor, target!.id]);
      if (rows.length) await replaceArchiveCodes(tx, rows);
      const at = rows.at(-1)?.id ?? target!.id;
      await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [cursorKey, String(at), new Date().toISOString()]);
      return at;
    });
    cursor = next;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await db.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES (?, '1', ?)
    ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [migrationKey, new Date().toISOString()]);
  await refreshSettings(true);
}

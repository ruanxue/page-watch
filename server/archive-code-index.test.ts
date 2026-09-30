import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PAGE_WATCH_DATABASE_INITIALIZE = '0';
const { codesForArchiveEntry, findArchiveCodeMatches, replaceArchiveCodes } = await import('./archive-code-index.js');

test('indexes exact codes found in the content and title', () => {
  assert.deepEqual(codesForArchiveEntry('FJIN-073', '作品 MEYD568 与 FJIN-073'), ['fjin-073', 'meyd-568']);
});

test('indexed match avoids the legacy scan when only existence is needed', async () => {
  const queries: string[] = [];
  const client = {
    async all(sql: string) {
      queries.push(sql);
      return [{ id: 7, code: 'fjin-073' }];
    }
  } as any;
  assert.deepEqual(await findArchiveCodeMatches(client, ['fjin-073'], 3, false), [{ id: 7, code: 'fjin-073' }]);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /archive_entry_codes/);
});

test('legacy candidates are filtered to exact codes during backfill', async () => {
  let calls = 0;
  const client = {
    async all() {
      calls += 1;
      return calls === 1 ? [] : [
        { id: 1, subscription_id: 3, content: 'FJIN-073', title: null },
        { id: 2, subscription_id: 3, content: 'FJIN-0730', title: null },
        { id: 3, subscription_id: 3, content: 'OTHER-10', title: '影片 FJIN073' }
      ];
    }
  } as any;
  assert.deepEqual(await findArchiveCodeMatches(client, ['fjin-073'], 3, false), [
    { id: 1, code: 'fjin-073' }, { id: 3, code: 'fjin-073' }
  ]);
});

test('replaces title aliases together with an archive update', async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async run(sql: string, values: unknown[]) {
      statements.push({ sql, values });
      return { changes: 1, lastInsertRowid: 0 };
    }
  } as any;
  await replaceArchiveCodes(client, [{ id: 9, subscription_id: 3, content: 'FJIN-073', title: '关联 MEYD568' }]);
  assert.match(statements[0].sql, /^DELETE FROM archive_entry_codes/);
  assert.deepEqual(statements[1].values, [9, 3, 'fjin-073', 9, 3, 'meyd-568']);
});

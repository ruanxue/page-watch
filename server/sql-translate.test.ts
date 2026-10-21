import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateSql, withReturning } from './sql-translate.js';

/**
 * SQL 转换器是 MySQL → PostgreSQL 迁移的地基：占位符一旦转换错位，
 * 参数就会整体错配，查出来的数据看着「正常」其实是错的。因此这里覆盖
 * 项目里真实出现过的写法。
 */

test('按顺序把问号换成 $1、$2', () => {
  const result = translateSql('SELECT * FROM t WHERE a = ? AND b = ?');
  assert.equal(result.text, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(result.paramCount, 2);
});

test('字符串里的问号不算占位符', () => {
  const result = translateSql(`SELECT ? AS a WHERE x LIKE '%?%' AND y = ?`);
  assert.equal(result.text, `SELECT $1 AS a WHERE x LIKE '%?%' AND y = $2`);
  assert.equal(result.paramCount, 2);
});

test('单引号里的两个单引号不会提前结束字符串', () => {
  const result = translateSql(`SELECT 'it''s a ?' AS t WHERE a = ?`);
  assert.equal(result.text, `SELECT 'it''s a ?' AS t WHERE a = $1`);
  assert.equal(result.paramCount, 1);
});

test('磁力链接正则这类含问号的字面量保持原样', () => {
  const result = translateSql(`SELECT 1 FROM t WHERE pattern = '^magnet:\\?' AND id = ?`);
  assert.equal(result.text, `SELECT 1 FROM t WHERE pattern = '^magnet:\\?' AND id = $1`);
  assert.equal(result.paramCount, 1);
});

test('反引号标识符改成双引号，且里面的问号不转换', () => {
  const result = translateSql('SELECT `key`, `value` FROM app_settings WHERE `key` = ?');
  assert.equal(result.text, 'SELECT "key", "value" FROM app_settings WHERE "key" = $1');
  assert.equal(result.paramCount, 1);
});

test('注释里的问号不转换', () => {
  const result = translateSql(`SELECT 1 -- 这里是注释 ?\nFROM t WHERE a = ?`);
  assert.equal(result.text, `SELECT 1 -- 这里是注释 ?\nFROM t WHERE a = $1`);
  assert.equal(result.paramCount, 1);
});

test('块注释里的问号不转换', () => {
  const result = translateSql('SELECT /* 注释 ? */ 1 FROM t WHERE a = ?');
  assert.equal(result.text, 'SELECT /* 注释 ? */ 1 FROM t WHERE a = $1');
  assert.equal(result.paramCount, 1);
});

test('INSERT IGNORE 翻译成 ON CONFLICT DO NOTHING', () => {
  const result = translateSql('INSERT IGNORE INTO t (a, b) VALUES (?, ?)');
  assert.equal(result.text, 'INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING');
  assert.equal(result.paramCount, 2);
});

test('已经有冲突处理的语句不会重复追加', () => {
  const result = translateSql('INSERT IGNORE INTO t (a) VALUES (?) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a');
  assert.equal(result.text, 'INSERT INTO t (a) VALUES ($1) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a');
});

test('普通 INSERT 不受影响', () => {
  const result = translateSql('INSERT INTO t (a) VALUES (?)');
  assert.equal(result.text, 'INSERT INTO t (a) VALUES ($1)');
});

test('给 INSERT 补 RETURNING，取回自增 id', () => {
  assert.equal(withReturning('INSERT INTO t (a) VALUES ($1)'), 'INSERT INTO t (a) VALUES ($1) RETURNING *');
  assert.equal(withReturning('INSERT INTO t (a) VALUES ($1);'), 'INSERT INTO t (a) VALUES ($1) RETURNING *;');
});

test('已有 RETURNING 时不重复追加，非 INSERT 也不动', () => {
  assert.equal(withReturning('INSERT INTO t (a) VALUES ($1) RETURNING id'), 'INSERT INTO t (a) VALUES ($1) RETURNING id');
  assert.equal(withReturning('UPDATE t SET a = $1'), 'UPDATE t SET a = $1');
});

test('真实语句：订阅进度计数更新保持可读', () => {
  const result = translateSql(`INSERT INTO subscription_progress (subscription_id, archive_total, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (subscription_id) DO UPDATE SET archive_total = EXCLUDED.archive_total, updated_at = EXCLUDED.updated_at`);
  assert.equal(result.paramCount, 3);
  assert.match(result.text, /VALUES \(\$1, \$2, \$3\)/);
  assert.match(result.text, /ON CONFLICT \(subscription_id\) DO UPDATE/);
});

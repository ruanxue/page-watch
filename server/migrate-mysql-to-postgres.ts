import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';

/**
 * 一次性数据搬迁：MySQL → PostgreSQL。
 *
 * - 源库从 `data/database-bootstrap.json` 读取（旧版文件没有 driver 字段，按 MySQL 处理），
 *   也可用 SOURCE_MYSQL_* 环境变量覆盖；
 * - 目标库用 PG_* 环境变量；
 * - **只读源库**，不修改 MySQL 任何数据；
 * - 先清空目标库同名表，再按依赖顺序导入，并保留原始 id；
 * - 导入后重置自增序列，并逐表比对行数。
 *
 * 用法：
 *   npx tsx server/migrate-mysql-to-postgres.ts            # 预演，只报告将要做什么
 *   npx tsx server/migrate-mysql-to-postgres.ts --apply    # 真正导入
 */

type SourceSettings = { host: string; port: number; database: string; user: string; password: string };

function sourceSettings(): SourceSettings {
  const env = {
    host: process.env.SOURCE_MYSQL_HOST,
    port: process.env.SOURCE_MYSQL_PORT,
    database: process.env.SOURCE_MYSQL_DATABASE,
    user: process.env.SOURCE_MYSQL_USER,
    password: process.env.SOURCE_MYSQL_PASSWORD
  };
  if (env.host && env.database && env.user && env.password !== undefined) {
    return { host: env.host, port: Number(env.port ?? 3306), database: env.database, user: env.user, password: env.password };
  }
  const file = resolve(process.env.PAGE_WATCH_BOOTSTRAP_PATH?.trim() || './data/database-bootstrap.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; settings?: Partial<SourceSettings> & { driver?: string } };
  const settings = parsed.settings;
  if (!settings?.host || !settings.database || !settings.user || settings.password === undefined) {
    throw new Error(`无法从 ${file} 读取 MySQL 连接；请用 SOURCE_MYSQL_* 环境变量指定源库。`);
  }
  if (settings.driver === 'postgres') throw new Error('引导文件指向的是 PostgreSQL，不能作为 MySQL 源库。');
  return { host: settings.host, port: Number(settings.port ?? 3306), database: settings.database, user: settings.user, password: settings.password };
}

function targetSettings() {
  const host = process.env.PG_HOST;
  const database = process.env.PG_DATABASE;
  const user = process.env.PG_USER;
  const password = process.env.PG_PASSWORD;
  if (!host || !database || !user || password === undefined) throw new Error('请用 PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD 指定目标库。');
  return { host, port: Number(process.env.PG_PORT ?? 5432), database, user, password };
}

/** 依赖顺序：被引用的表在前；导入时按此顺序，清空时反向。 */
const TABLES = [
  'subscriptions',
  'subscription_presets',
  'archive_entries',
  'archive_entry_codes',
  'jobs',
  'release_jobs',
  'magnet_jobs',
  'download_jobs',
  'library_jobs',
  'library_sync_jobs',
  'full_scan_batches',
  'initial_scan_items',
  'runtime_logs',
  'runtime_metrics',
  'performance_metrics',
  'worker_heartbeats',
  'integration_status',
  'notification_outbox',
  'notification_dedupes',
  'jellyfin_media_items',
  'jellyfin_media_codes',
  'subscription_progress',
  'app_settings'
];

/** 自增列由目标库自己描述（is_identity），导入时用 OVERRIDING SYSTEM VALUE 保留原 id。 */
async function identityColumns(table: string) {
  const result = await pgPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_identity = 'YES'`, [table]);
  return new Set(result.rows.map((row) => row.column_name));
}

const apply = process.argv.includes('--apply');
const batchSize = 500;

const source = sourceSettings();
const target = targetSettings();
console.log(`源库（只读）：mysql://${source.user}@${source.host}:${source.port}/${source.database}`);
console.log(`目标库：postgres://${target.user}@${target.host}:${target.port}/${target.database}`);
console.log(`模式：${apply ? '实际导入' : '预演（加 --apply 执行）'}\n`);

const mysqlConn = await mysql.createConnection({ ...source, supportBigNumbers: true, bigNumberStrings: true });
const pgPool = new Pool(target);

const realTables: string[] = [];
for (const table of TABLES) {
  const exists = await mysqlConn.query('SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [source.database, table]) as unknown as [Array<unknown>];
  if ((exists[0] as unknown[]).length) realTables.push(table);
}

// 逐表统计
const counts: Array<{ table: string; source: number; target: number }> = [];
for (const table of realTables) {
  const [rows] = await mysqlConn.query(`SELECT COUNT(*) AS c FROM \`${table}\``) as unknown as [Array<{ c: number }>];
  const pg = await pgPool.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
  counts.push({ table, source: Number(rows[0].c), target: Number(pg.rows[0].c) });
}
console.log('表名                     源库        目标库(现有)');
for (const row of counts) console.log(`${row.table.padEnd(24)} ${String(row.source).padStart(8)} ${String(row.target).padStart(12)}`);

if (!apply) {
  console.log('\n预演结束，未写入任何数据。');
  await mysqlConn.end();
  await pgPool.end();
  process.exit(0);
}

// 清空目标库：反向顺序，避免外键式依赖问题（当前没有外键，仍按逆序更稳妥）
for (const table of [...realTables].reverse()) await pgPool.query(`TRUNCATE TABLE "${table}"`);

/** PostgreSQL 的生成列不允许显式写入，导入时必须跳过（MySQL 侧允许）。 */
async function generatedColumns(table: string) {
  const result = await pgPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'ALWAYS'`, [table]);
  return new Set(result.rows.map((row) => row.column_name));
}

// 导入
for (const table of realTables) {
  const [rows] = await mysqlConn.query(`SELECT * FROM \`${table}\``) as unknown as [Array<Record<string, unknown>>];
  if (!rows.length) { console.log(`${table}: 0 行，跳过`); continue; }
  const generated = await generatedColumns(table);
  const columns = Object.keys(rows[0]).filter((column) => !generated.has(column));
  const identity = (await identityColumns(table)).size > 0;
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  const overriding = identity ? ' OVERRIDING SYSTEM VALUE' : '';
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row) => `(${columns.map((column) => { values.push(row[column] ?? null); return `$${values.length}`; }).join(', ')})`);
    await pgPool.query(`INSERT INTO "${table}" (${columnList})${overriding} VALUES ${tuples.join(', ')}`, values);
  }
  console.log(`${table}: 导入 ${rows.length} 行`);
}

// 重置自增序列，否则后续插入会撞已有的 id
for (const table of realTables) {
  if (!(await identityColumns(table)).has('id')) continue;
  await pgPool.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`);
}

// 校验
console.log('\n校验：');
let mismatched = 0;
for (const table of realTables) {
  const [rows] = await mysqlConn.query(`SELECT COUNT(*) AS c FROM \`${table}\``) as unknown as [Array<{ c: number }>];
  const pg = await pgPool.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
  const expected = Number(rows[0].c);
  const actual = Number(pg.rows[0].c);
  if (expected !== actual) { mismatched += 1; console.log(`  ✗ ${table}: 源 ${expected} / 目标 ${actual}`); }
}
console.log(mismatched ? `发现 ${mismatched} 张表行数不一致` : `全部 ${realTables.length} 张表行数一致`);

await mysqlConn.end();
await pgPool.end();
process.exit(mismatched ? 1 : 0);

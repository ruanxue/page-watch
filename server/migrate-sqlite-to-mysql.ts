import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { ensureMySqlSchema } from './mysql-schema.js';

const host = process.env.MYSQL_HOST?.trim();
const user = process.env.MYSQL_USER?.trim();
const password = process.env.MYSQL_PASSWORD;
const database = process.env.MYSQL_DATABASE?.trim();
const port = Number(process.env.MYSQL_PORT ?? 3306);
const sqlitePath = path.resolve(process.env.SQLITE_SOURCE ?? 'data/page-watch.db');

if (!host || !user || password === undefined || !database || !Number.isInteger(port)) {
  throw new Error('MySQL 配置不完整，无法开始迁移。');
}
if (!fs.existsSync(sqlitePath)) throw new Error(`找不到 SQLite 源文件：${sqlitePath}`);

const pool = mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 2, charset: 'utf8mb4_unicode_ci', timezone: 'Z' });
const source = new Database(sqlitePath, { readonly: true });

const tableColumns: Record<string, string[]> = {
  app_settings: ['key', 'value', 'updated_at'],
  subscription_presets: ['id', 'name', 'description', 'selector', 'render_mode', 'content_source', 'attribute_name', 'match_pattern', 'title_selector', 'title_content_source', 'title_attribute_name', 'title_match_pattern', 'result_mode', 'interval_minutes', 'is_active', 'created_at', 'updated_at'],
  subscriptions: ['id', 'name', 'url', 'selector', 'render_mode', 'content_source', 'attribute_name', 'match_pattern', 'title_selector', 'title_content_source', 'title_attribute_name', 'title_match_pattern', 'result_mode', 'interval_minutes', 'schedule_type', 'schedule_interval_hours', 'schedule_time', 'schedule_weekday', 'is_active', 'last_checked_at', 'last_hash', 'last_content', 'last_error', 'pagination_selector', 'initial_scan_completed', 'initial_scan_total', 'initial_scan_pages_completed', 'created_at', 'updated_at'],
  archive_entries: ['id', 'subscription_id', 'content', 'title', 'content_hash', 'first_seen_at', 'magnet_status', 'magnet_value', 'magnet_checked_at', 'magnet_error'],
  jobs: ['id', 'subscription_id', 'status', 'requested_at', 'started_at', 'finished_at', 'error'],
  magnet_jobs: ['id', 'archive_entry_id', 'status', 'requested_at', 'started_at', 'finished_at', 'error'],
  runtime_logs: ['id', 'level', 'source', 'subscription_id', 'job_id', 'message', 'created_at']
};

function quoteIdentifier(value: string) {
  return `\`${value.replaceAll('`', '``')}\``;
}

async function targetIsEmpty() {
  for (const table of Object.keys(tableColumns)) {
    const [rawRows] = await pool.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
    const rows = rawRows as { count: number }[];
    if (Number(rows[0]?.count ?? 0) > 0) return false;
  }
  return true;
}

async function copyTable(table: string, columns: string[]) {
  const rows = source.prepare(`SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} ORDER BY rowid ASC`).all() as Record<string, unknown>[];
  if (!rows.length) return 0;
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const row of rows) await connection.execute(sql, columns.map((column) => row[column]) as any);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return rows.length;
}

try {
  await ensureMySqlSchema(pool);
  if (!(await targetIsEmpty())) throw new Error(`目标数据库 ${database} 已包含 Page Watch 数据，为防止覆盖，迁移已取消。`);
  const copied: Record<string, number> = {};
  for (const [table, columns] of Object.entries(tableColumns)) copied[table] = await copyTable(table, columns);
  await pool.query("UPDATE archive_entries SET updated_at = first_seen_at WHERE updated_at = '1970-01-01T00:00:00.000Z'");
  console.log(`迁移完成：${Object.entries(copied).map(([table, count]) => `${table} ${count}`).join('；')}`);
} finally {
  source.close();
  await pool.end();
}

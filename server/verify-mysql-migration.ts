import 'dotenv/config';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const host = process.env.MYSQL_HOST?.trim();
const user = process.env.MYSQL_USER?.trim();
const password = process.env.MYSQL_PASSWORD;
const database = process.env.MYSQL_DATABASE?.trim();
const port = Number(process.env.MYSQL_PORT ?? 3306);
const sqlitePath = path.resolve(process.env.SQLITE_SOURCE ?? 'data/page-watch.sqlite-backup-20260910.db');

if (!host || !user || password === undefined || !database || !Number.isInteger(port)) {
  throw new Error('MySQL 配置不完整，无法验证迁移。');
}
if (!fs.existsSync(sqlitePath)) throw new Error(`找不到 SQLite 验证源文件：${sqlitePath}`);

const tableColumns: Record<string, { columns: string[]; orderBy: string }> = {
  app_settings: { columns: ['key', 'value', 'updated_at'], orderBy: 'key' },
  subscription_presets: { columns: ['id', 'name', 'description', 'selector', 'render_mode', 'content_source', 'attribute_name', 'match_pattern', 'title_selector', 'title_content_source', 'title_attribute_name', 'title_match_pattern', 'result_mode', 'interval_minutes', 'is_active', 'created_at', 'updated_at'], orderBy: 'id' },
  subscriptions: { columns: ['id', 'name', 'url', 'selector', 'render_mode', 'content_source', 'attribute_name', 'match_pattern', 'title_selector', 'title_content_source', 'title_attribute_name', 'title_match_pattern', 'result_mode', 'interval_minutes', 'schedule_type', 'schedule_interval_hours', 'schedule_time', 'schedule_weekday', 'is_active', 'pagination_selector', 'created_at'], orderBy: 'id' },
  archive_entries: { columns: ['id', 'subscription_id', 'content', 'title', 'content_hash', 'first_seen_at'], orderBy: 'id' },
  jobs: { columns: ['id', 'subscription_id', 'requested_at'], orderBy: 'id' },
  magnet_jobs: { columns: ['id', 'archive_entry_id', 'requested_at'], orderBy: 'id' },
  runtime_logs: { columns: ['id', 'level', 'source', 'subscription_id', 'job_id', 'message', 'created_at'], orderBy: 'id' }
};

function quoteIdentifier(value: string) {
  return `\`${value.replaceAll('`', '``')}\``;
}

function normalize(value: unknown) {
  return value === undefined ? null : value;
}

function digest(rows: Record<string, unknown>[], columns: string[]) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) hash.update(`${JSON.stringify(columns.map((column) => normalize(row[column])))}\n`);
  return hash.digest('hex');
}

const source = new Database(sqlitePath, { readonly: true });
const target = await mysql.createConnection({ host, port, user, password, database, charset: 'utf8mb4_unicode_ci', timezone: 'Z' });

try {
  const results: string[] = [];
  for (const [table, { columns, orderBy }] of Object.entries(tableColumns)) {
    const select = columns.map(quoteIdentifier).join(', ');
    const sourceRows = source.prepare(`SELECT ${select} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(orderBy)} ASC`).all() as Record<string, unknown>[];
    const [rawTargetRows] = await target.query(`SELECT ${select} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(orderBy)} ASC LIMIT ?`, [sourceRows.length]);
    const targetRows = rawTargetRows as Record<string, unknown>[];
    if (targetRows.length !== sourceRows.length || digest(sourceRows, columns) !== digest(targetRows, columns)) {
      throw new Error(`${table} 校验失败：SQLite ${sourceRows.length} 行，MySQL 前 ${targetRows.length} 行。`);
    }
    results.push(`${table} ${sourceRows.length}`);
  }
  console.log(`迁移校验通过：${results.join('；')}`);
} finally {
  source.close();
  await target.end();
}

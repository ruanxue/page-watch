import 'dotenv/config';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import { ensureMySqlSchema } from './mysql-schema.js';
import { defaultInspectionRules, inspectionRulesJson } from './inspection-rules.js';

const host = process.env.MYSQL_HOST?.trim();
const user = process.env.MYSQL_USER?.trim();
const password = process.env.MYSQL_PASSWORD;
const database = process.env.MYSQL_DATABASE?.trim();
const port = Number(process.env.MYSQL_PORT ?? 3306);

if (!host || !user || password === undefined || !database || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MySQL 配置不完整。请设置 MYSQL_HOST、MYSQL_PORT、MYSQL_DATABASE、MYSQL_USER 和 MYSQL_PASSWORD。');
}

export const pool: Pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z'
});

type Runner = Pool | PoolConnection;
export type RunResult = { changes: number; lastInsertRowid: number };
export type DatabaseClient = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
};

function clientFor(runner: Runner): DatabaseClient {
  return {
    async all<T>(sql: string, params: unknown[] = []) {
      const [rows] = await runner.query(sql, params as any);
      return rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const [rows] = await runner.query(sql, params as any);
      return (rows as T[])[0];
    },
    async run(sql: string, params: unknown[] = []) {
      const [result] = await runner.execute(sql, params as any);
      const header = result as ResultSetHeader;
      return { changes: header.affectedRows, lastInsertRowid: Number(header.insertId) };
    }
  };
}

export const db: DatabaseClient & { transaction<T>(work: (tx: DatabaseClient) => Promise<T>): Promise<T> } = {
  ...clientFor(pool),
  async transaction<T>(work: (tx: DatabaseClient) => Promise<T>) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(clientFor(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
};

export type Subscription = {
  id: number;
  name: string;
  url: string;
  selector: string;
  render_mode: 'static' | 'dynamic';
  content_source: 'text' | 'attribute';
  attribute_name: string | null;
  match_pattern: string | null;
  title_selector: string | null;
  title_content_source: 'text' | 'attribute';
  title_attribute_name: string | null;
  title_match_pattern: string | null;
  result_mode: 'first' | 'all';
  interval_minutes: number;
  schedule_type: 'hourly' | 'daily' | 'weekly';
  schedule_interval_hours: number;
  schedule_time: string;
  schedule_weekday: number;
  is_active: number;
  last_checked_at: string | null;
  last_hash: string | null;
  last_content: string | null;
  last_error: string | null;
  pagination_selector: string | null;
  pagination_parameter: string;
  pagination_match_pattern: string | null;
  initial_scan_completed: number;
  initial_scan_total: number | null;
  initial_scan_pages_completed: number;
  created_at: string;
  updated_at: string;
};

const settings = new Map<string, string>();
let lastSettingsRefreshAt = 0;
const SETTINGS_REFRESH_MS = 3_000;
const missavTitlePattern = '^[A-Za-z]+-\\d+\\s*(.+)$';
const defaultSubscriptionPresets = [
  ['MissAV 番号列表', '适用于列表页，读取影片番号、标题和全部分页内容。', 'a.text-secondary[alt]', 'dynamic', 'attribute', 'alt', '', 'a.text-secondary[alt]', 'text', null, missavTitlePattern, 'all', 60, '#price-currency', 'page', '/\\s*(\\d+)', 1],
  ['文章标题列表', '读取文章区域的一级、二级标题。', 'article h1, article h2, main h1, main h2', 'static', 'text', '', '', null, 'text', null, null, 'all', 120, null, 'page', null, 1],
  ['商品价格', '读取常见的价格字段，适合监测商品详情页。', '[itemprop="price"], .price, [data-price]', 'static', 'text', '', '', null, 'text', null, null, 'first', 30, null, 'page', null, 1],
  ['页面标题', '读取网页标题，适合检查页面是否替换或发布新版本。', 'title', 'static', 'text', '', '', null, 'text', null, null, 'first', 240, null, 'page', null, 1]
] as const;

export async function getSubscription(id: number) {
  return db.get<Subscription>('SELECT * FROM subscriptions WHERE id = ?', [id]);
}

export async function queueJob(subscriptionId: number) {
  const existing = await db.get<{ id: number }>("SELECT id FROM jobs WHERE subscription_id = ? AND status IN ('queued', 'running')", [subscriptionId]);
  if (existing) return { id: existing.id, queued: false };
  try {
    const result = await db.run("INSERT INTO jobs (subscription_id, status, requested_at) VALUES (?, 'queued', ?)", [subscriptionId, new Date().toISOString()]);
    return { id: result.lastInsertRowid, queued: true };
  } catch (error) {
    const duplicate = await db.get<{ id: number }>("SELECT id FROM jobs WHERE subscription_id = ? AND status IN ('queued', 'running')", [subscriptionId]);
    if (duplicate) return { id: duplicate.id, queued: false };
    throw error;
  }
}

export type MagnetStatus = 'unsearched' | 'pending' | 'found' | 'not_found' | 'failed';
export type DownloadStatus = 'not_queued' | 'queued' | 'running' | 'added' | 'waiting' | 'downloading' | 'paused' | 'completed' | 'removed' | 'failed';

export type WorkerName = 'api' | 'capture' | 'release' | 'magnet' | 'download' | 'library';

/** A tiny, DB-backed heartbeat is reliable across the separate Docker services. */
export async function reportWorkerHeartbeat(workerName: WorkerName, detail: string, status: 'ready' | 'busy' | 'error' = 'ready') {
  await db.run(`INSERT INTO worker_heartbeats (worker_name, status, detail, last_seen_at) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), last_seen_at = VALUES(last_seen_at)`,
  [workerName, status, detail.slice(0, 255), new Date().toISOString()]);
}

export async function queueMagnetJob(archiveEntryId: number, client: DatabaseClient = db) {
  const existing = await client.get<{ id: number }>("SELECT id FROM magnet_jobs WHERE archive_entry_id = ? AND status IN ('queued', 'running')", [archiveEntryId]);
  if (existing) return { id: existing.id, queued: false };
  try {
    const result = await client.run("INSERT INTO magnet_jobs (archive_entry_id, status, requested_at) VALUES (?, 'queued', ?)", [archiveEntryId, new Date().toISOString()]);
    return { id: result.lastInsertRowid, queued: true };
  } catch (error) {
    const duplicate = await client.get<{ id: number }>("SELECT id FROM magnet_jobs WHERE archive_entry_id = ? AND status IN ('queued', 'running')", [archiveEntryId]);
    if (duplicate) return { id: duplicate.id, queued: false };
    throw error;
  }
}

/** Add a detail-page release-date lookup without allowing duplicate active work. */
export async function queueReleaseJob(archiveEntryId: number, client: DatabaseClient = db) {
  const existing = await client.get<{ id: number }>("SELECT id FROM release_jobs WHERE archive_entry_id = ? AND status IN ('queued', 'running')", [archiveEntryId]);
  if (existing) return { id: existing.id, queued: false };
  try {
    const result = await client.run("INSERT INTO release_jobs (archive_entry_id, status, requested_at) VALUES (?, 'queued', ?)", [archiveEntryId, new Date().toISOString()]);
    return { id: result.lastInsertRowid, queued: true };
  } catch (error) {
    const duplicate = await client.get<{ id: number }>("SELECT id FROM release_jobs WHERE archive_entry_id = ? AND status IN ('queued', 'running')", [archiveEntryId]);
    if (duplicate) return { id: duplicate.id, queued: false };
    throw error;
  }
}

/** Add an archive item to the qBittorrent submission queue, without allowing a duplicate active job. */
export async function queueDownloadJob(archiveEntryId: number, client: DatabaseClient = db) {
  const existing = await client.get<{ id: number }>("SELECT id FROM download_jobs WHERE archive_entry_id = ? AND status IN ('queued', 'running')", [archiveEntryId]);
  if (existing) return { id: existing.id, queued: false };
  try {
    const result = await client.run("INSERT INTO download_jobs (archive_entry_id, status, requested_at) VALUES (?, 'queued', ?)", [archiveEntryId, new Date().toISOString()]);
    return { id: result.lastInsertRowid, queued: true };
  } catch (error) {
    const duplicate = await client.get<{ id: number }>("SELECT id FROM download_jobs WHERE archive_entry_id = ? AND status IN ('queued', 'running')", [archiveEntryId]);
    if (duplicate) return { id: duplicate.id, queued: false };
    throw error;
  }
}

type RuntimeLogInput = {
  level: 'info' | 'success' | 'error';
  source: 'system' | 'queue' | 'worker' | 'download' | 'library';
  message: string;
  subscriptionId?: number | null;
  jobId?: number | null;
};

export async function appendRuntimeLog(input: RuntimeLogInput) {
  const result = await db.run(`INSERT INTO runtime_logs
    (level, source, subscription_id, job_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  [input.level, input.source, input.subscriptionId ?? null, input.jobId ?? null, input.message, new Date().toISOString()]);
  await db.run('DELETE FROM runtime_logs WHERE id <= (SELECT cutoff.id FROM (SELECT COALESCE(MAX(id), 0) - 1000 AS id FROM runtime_logs) AS cutoff)');
  return result.lastInsertRowid;
}

export function getSetting(key: string) {
  return settings.get(key) ?? '';
}

export async function setSetting(key: string, value: string) {
  await db.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [key, value, new Date().toISOString()]);
  settings.set(key, value);
}

/**
 * API, capture, magnet and download workers run in separate processes. Refresh
 * their local settings cache so a saved proxy or qBittorrent credential takes
 * effect without a service restart.
 */
export async function refreshSettings(force = false) {
  if (!force && Date.now() - lastSettingsRefreshAt < SETTINGS_REFRESH_MS) return;
  const rows = await db.all<{ key: string; value: string }>('SELECT `key`, value FROM app_settings');
  const next = new Map(rows.map((row) => [row.key, row.value]));
  settings.clear();
  for (const [key, value] of next) settings.set(key, value);
  lastSettingsRefreshAt = Date.now();
}

export function getOutboundProxyUrl() {
  return process.env.OUTBOUND_PROXY?.trim() || getSetting('outbound_proxy').trim();
}

export type QbittorrentSettings = {
  enabled: boolean;
  url: string;
  authMode: 'api_key' | 'password';
  apiKey: string;
  username: string;
  password: string;
  category: string;
  savePath: string;
  tags: string;
  autoDownload: boolean;
  stopAfterDownload: boolean;
};

export type JellyfinSettings = {
  enabled: boolean;
  url: string;
  apiKey: string;
  libraryIds: string[];
  syncIntervalMinutes: number;
};

function savedStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))] : [];
  } catch { return []; }
}

export function getJellyfinSettings(): JellyfinSettings {
  const interval = Number(getSetting('jellyfin_sync_interval_minutes'));
  return {
    enabled: getSetting('jellyfin_enabled') === '1',
    url: getSetting('jellyfin_url').trim(),
    apiKey: getSetting('jellyfin_api_key'),
    libraryIds: savedStringArray(getSetting('jellyfin_library_ids')),
    syncIntervalMinutes: Number.isInteger(interval) && interval >= 5 && interval <= 1440 ? interval : 60
  };
}

/** Credentials are intentionally server-only; API routes must never return them. */
export function getQbittorrentSettings(): QbittorrentSettings {
  return {
    enabled: getSetting('qbit_enabled') === '1',
    url: getSetting('qbit_url').trim(),
    authMode: getSetting('qbit_auth_mode') === 'api_key' ? 'api_key' : 'password',
    apiKey: getSetting('qbit_api_key'),
    username: getSetting('qbit_username'),
    password: getSetting('qbit_password'),
    category: getSetting('qbit_category'),
    savePath: getSetting('qbit_save_path'),
    tags: getSetting('qbit_tags'),
    autoDownload: getSetting('qbit_auto_download') === '1',
    stopAfterDownload: getSetting('qbit_stop_after_download') === '1'
  };
}

async function preloadSettings() {
  await refreshSettings(true);
}

async function seedDefaultSubscriptionPresets() {
  if (getSetting('subscription_presets_seeded')) return;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const preset of defaultSubscriptionPresets) {
      await tx.run(`INSERT INTO subscription_presets
        (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...preset, now, now]);
    }
    await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, ['subscription_presets_seeded', '1', now]);
  });
  settings.set('subscription_presets_seeded', '1');
}

/**
 * The rule-library split briefly seeded the MissAV preset without its page
 * counter. Repair only untouched default-shaped presets and new, uninspected
 * MissAV subscriptions; custom rules and already collected archives stay as-is.
 */
async function backfillMissavPaginationDefaults() {
  const migrationKey = 'missav_list_pagination_backfill_v1';
  if (getSetting(migrationKey)) return;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE subscription_presets
      SET description = ?, pagination_selector = ?, pagination_parameter = ?, pagination_match_pattern = ?, updated_at = ?
      WHERE name = 'MissAV 番号列表'
        AND selector = 'a.text-secondary[alt]'
        AND (pagination_selector IS NULL OR TRIM(pagination_selector) = '')`,
    ['适用于列表页，读取影片番号、标题和全部分页内容。', '#price-currency', 'page', '/\\s*(\\d+)', now]);
    await tx.run(`UPDATE subscriptions
      SET pagination_selector = ?, pagination_parameter = ?, pagination_match_pattern = ?,
          initial_scan_completed = 0, initial_scan_total = NULL, initial_scan_pages_completed = 0, updated_at = ?
      WHERE last_checked_at IS NULL
        AND selector = 'a.text-secondary[alt]'
        AND (pagination_selector IS NULL OR TRIM(pagination_selector) = '')
        AND (url LIKE 'https://missav123.com/%' OR url LIKE 'http://missav123.com/%')`,
    ['#price-currency', 'page', '/\\s*(\\d+)', now]);
    await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES (?, '1', ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [migrationKey, now]);
  });
  settings.set(migrationKey, '1');
}

async function seedDefaultInspectionRules() {
  if (getSetting('inspection_rules')) return;
  await setSetting('inspection_rules', inspectionRulesJson(defaultInspectionRules));
}

await ensureMySqlSchema(pool);
await preloadSettings();
await seedDefaultSubscriptionPresets();
await backfillMissavPaginationDefaults();
await seedDefaultInspectionRules();

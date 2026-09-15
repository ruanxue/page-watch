import 'dotenv/config';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import { ensureMySqlSchema } from './mysql-schema.js';
import { defaultInspectionRules, inspectionRulesJson } from './inspection-rules.js';
import { notifyLive } from './live-events.js';
import { decryptSecret, encryptSecret, isEncryptedSecret, readApplicationEncryptionKey } from './secret-storage.js';

const host = process.env.MYSQL_HOST?.trim();
const user = process.env.MYSQL_USER?.trim();
const password = process.env.MYSQL_PASSWORD;
const database = process.env.MYSQL_DATABASE?.trim();
const port = Number(process.env.MYSQL_PORT ?? 3306);
const connectionLimit = Number(process.env.MYSQL_CONNECTION_LIMIT ?? 3);
const applicationEncryptionKey = readApplicationEncryptionKey();
const sensitiveSettingKeys = new Set(['jellyfin_api_key', 'qbit_api_key', 'qbit_password', 'app_auth_session_secret']);

if (!host || !user || password === undefined || !database || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 16) {
  throw new Error('MySQL 配置不完整。请设置 MYSQL_HOST、MYSQL_PORT、MYSQL_DATABASE、MYSQL_USER 和 MYSQL_PASSWORD。');
}

export const pool: Pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  // Six workers live in one container. A small per-process pool avoids each
  // of them reserving eight connections on the NAS MySQL server.
  connectionLimit,
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
  initial_scan_run_id: string | null;
  initial_scan_next_page: number;
  next_scheduled_at: string | null;
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

export const JOB_PRIORITY = { normal: 0, manual: 100 } as const;
export type JobPriority = (typeof JOB_PRIORITY)[keyof typeof JOB_PRIORITY];

async function queueUnique(table: 'jobs' | 'release_jobs' | 'magnet_jobs' | 'download_jobs' | 'library_jobs', column: 'subscription_id' | 'archive_entry_id', id: number, priority: JobPriority, client: DatabaseClient) {
  const existing = await client.get<{ id: number; priority: number }>(`SELECT id, priority FROM \`${table}\` WHERE \`${column}\` = ? AND status IN ('queued', 'running')`, [id]);
  if (existing) {
    // A manual request upgrades waiting automatic work, but never interrupts a
    // running worker task.
    if (existing.priority < priority) {
      await client.run(`UPDATE \`${table}\` SET priority = ? WHERE id = ? AND status = 'queued'`, [priority, existing.id]);
      if (client === db) notifyLive('tasks');
    }
    return { id: existing.id, queued: false };
  }
  try {
    const result = await client.run(`INSERT INTO \`${table}\` (\`${column}\`, status, requested_at, priority) VALUES (?, 'queued', ?, ?)`, [id, new Date().toISOString(), priority]);
    if (client === db) notifyLive('tasks');
    return { id: result.lastInsertRowid, queued: true };
  } catch (error) {
    const duplicate = await client.get<{ id: number }>(`SELECT id FROM \`${table}\` WHERE \`${column}\` = ? AND status IN ('queued', 'running')`, [id]);
    if (duplicate) return { id: duplicate.id, queued: false };
    throw error;
  }
}

export async function queueJob(subscriptionId: number, priority: JobPriority = JOB_PRIORITY.normal, client: DatabaseClient = db) {
  return queueUnique('jobs', 'subscription_id', subscriptionId, priority, client);
}

export type MagnetStatus = 'unsearched' | 'pending' | 'found' | 'not_found' | 'failed' | 'skipped';
export type DownloadStatus = 'not_queued' | 'queued' | 'running' | 'added' | 'waiting' | 'downloading' | 'paused' | 'completed' | 'removed' | 'filtered' | 'failed';

export type WorkerName = 'api' | 'capture' | 'release' | 'magnet' | 'download' | 'library';
export type WorkerTaskContext = {
  kind?: string | null;
  subscriptionId?: number | null;
  archiveEntryId?: number | null;
  content?: string | null;
  current?: number | null;
  total?: number | null;
  label?: string | null;
};

/** A tiny, DB-backed heartbeat is reliable across the separate Docker services. */
export async function reportWorkerHeartbeat(workerName: WorkerName, detail: string, status: 'ready' | 'busy' | 'error' = 'ready', task: WorkerTaskContext | null = null) {
  await db.run(`INSERT INTO worker_heartbeats (worker_name, status, detail, task_kind, subscription_id, archive_entry_id, task_content, progress_current, progress_total, progress_label, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), task_kind = VALUES(task_kind), subscription_id = VALUES(subscription_id), archive_entry_id = VALUES(archive_entry_id), task_content = VALUES(task_content), progress_current = VALUES(progress_current), progress_total = VALUES(progress_total), progress_label = VALUES(progress_label), last_seen_at = VALUES(last_seen_at)`,
  [workerName, status, detail.slice(0, 255), task?.kind?.slice(0, 32) ?? null, task?.subscriptionId ?? null, task?.archiveEntryId ?? null, task?.content?.slice(0, 255) ?? null, task?.current ?? null, task?.total ?? null, task?.label?.slice(0, 128) ?? null, new Date().toISOString()]);
  notifyLive('tasks');
}

export async function queueMagnetJob(archiveEntryId: number, client: DatabaseClient = db, priority: JobPriority = JOB_PRIORITY.normal) {
  return queueUnique('magnet_jobs', 'archive_entry_id', archiveEntryId, priority, client);
}

/** Add a detail-page release-date lookup without allowing duplicate active work. */
export async function queueReleaseJob(archiveEntryId: number, client: DatabaseClient = db, priority: JobPriority = JOB_PRIORITY.normal) {
  return queueUnique('release_jobs', 'archive_entry_id', archiveEntryId, priority, client);
}

/** Add an archive item to the qBittorrent submission queue, without allowing a duplicate active job. */
export async function queueDownloadJob(archiveEntryId: number, client: DatabaseClient = db, priority: JobPriority = JOB_PRIORITY.normal) {
  return queueUnique('download_jobs', 'archive_entry_id', archiveEntryId, priority, client);
}

/** Exact Jellyfin lookup runs ahead of automatic magnet searching. */
export async function queueLibraryJob(archiveEntryId: number, client: DatabaseClient = db, priority: JobPriority = JOB_PRIORITY.normal) {
  return queueUnique('library_jobs', 'archive_entry_id', archiveEntryId, priority, client);
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
  notifyLive('logs');
  return result.lastInsertRowid;
}

export function getSetting(key: string) {
  return settings.get(key) ?? '';
}

function storedSettingValue(key: string, value: string) {
  return sensitiveSettingKeys.has(key) ? encryptSecret(value, applicationEncryptionKey) : value;
}

function readableSettingValue(key: string, value: string) {
  return sensitiveSettingKeys.has(key) ? decryptSecret(value, applicationEncryptionKey) : value;
}

export async function setSetting(key: string, value: string) {
  const stored = storedSettingValue(key, value);
  await db.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [key, stored, new Date().toISOString()]);
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
  const next = new Map(rows.map((row) => [row.key, readableSettingValue(row.key, row.value)]));
  settings.clear();
  for (const [key, value] of next) settings.set(key, value);
  lastSettingsRefreshAt = Date.now();
}

/** Encrypt legacy plaintext credentials once, without changing their plaintext value in memory. */
async function encryptLegacySensitiveSettings() {
  const rows = await db.all<{ key: string; value: string }>('SELECT `key`, value FROM app_settings');
  const legacy = rows.filter((row) => sensitiveSettingKeys.has(row.key) && !isEncryptedSecret(row.value));
  // Validate ciphertext from prior launches before a worker starts using it.
  for (const row of rows) if (sensitiveSettingKeys.has(row.key) && isEncryptedSecret(row.value)) readableSettingValue(row.key, row.value);
  if (!legacy.length) return;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const row of legacy) {
      const encrypted = storedSettingValue(row.key, row.value);
      // More than one worker can start at once; this condition makes the
      // migration idempotent even if each observed the same plaintext row.
      await tx.run('UPDATE app_settings SET value = ?, updated_at = ? WHERE `key` = ? AND value = ?', [encrypted, now, row.key, row.value]);
    }
  });
}

export type PerformanceMetricInput = {
  scope: 'capture' | 'release' | 'magnet' | 'library' | 'download';
  metric: 'processed' | 'retry' | 'jellyfin_cache' | 'chromium_rebuild';
  dimension?: string;
  durationMs?: number;
  count?: number;
};

function metricBucketStart(date = new Date()) {
  date.setUTCSeconds(0, 0);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Persist only aggregate operational counters; never call this with user content or raw errors. */
export async function recordPerformanceMetric(input: PerformanceMetricInput) {
  const dimension = (input.dimension ?? 'all').slice(0, 64) || 'all';
  const count = Math.max(1, Math.floor(input.count ?? 1));
  const duration = Math.max(0, Math.floor(input.durationMs ?? 0));
  await db.run(`INSERT INTO performance_metrics (granularity, bucket_start, scope, metric, dimension, sample_count, duration_ms)
    VALUES ('minute', ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE sample_count = sample_count + VALUES(sample_count), duration_ms = duration_ms + VALUES(duration_ms)`,
  [metricBucketStart(), input.scope, input.metric, dimension, count, duration]);
  notifyLive('metrics');
}

/** Compact old minute buckets to hourly totals, then expire long-lived telemetry. */
export async function maintainPerformanceMetrics() {
  // Keep aggregation and source deletion atomic. If the process stops in the
  // middle, no hourly bucket is double-counted on the next daily maintenance.
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO performance_metrics (granularity, bucket_start, scope, metric, dimension, sample_count, duration_ms)
      SELECT 'hour', DATE_FORMAT(bucket_start, '%Y-%m-%d %H:00:00'), scope, metric, dimension, SUM(sample_count), SUM(duration_ms)
      FROM performance_metrics
      WHERE granularity = 'minute' AND bucket_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
      GROUP BY DATE_FORMAT(bucket_start, '%Y-%m-%d %H:00:00'), scope, metric, dimension
      ON DUPLICATE KEY UPDATE sample_count = sample_count + VALUES(sample_count), duration_ms = duration_ms + VALUES(duration_ms)`);
    await tx.run("DELETE FROM performance_metrics WHERE granularity = 'minute' AND bucket_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)");
    await tx.run("DELETE FROM performance_metrics WHERE granularity = 'hour' AND bucket_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 180 DAY)");
  });
}

export type IntegrationService = 'jellyfin' | 'qbittorrent';
export async function reportIntegrationStatus(service: IntegrationService, status: 'healthy' | 'degraded' | 'disabled', detail: string | null = null) {
  await db.run(`INSERT INTO integration_status (service_name, status, detail, checked_at) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), checked_at = VALUES(checked_at)`,
  [service, status, detail?.slice(0, 255) ?? null, new Date().toISOString()]);
  notifyLive('tasks');
}

export async function getIntegrationStatuses() {
  return db.all<{ service_name: IntegrationService; status: 'healthy' | 'degraded' | 'disabled'; detail: string | null; checked_at: string }>('SELECT service_name, status, detail, checked_at FROM integration_status');
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
  autoDownloadMinSizeMb: number;
  stopAfterDownload: boolean;
};

export type JellyfinSettings = {
  enabled: boolean;
  url: string;
  apiKey: string;
  libraryIds: string[];
  syncIntervalMinutes: number;
  skipMagnetWhenAvailable: boolean;
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
    syncIntervalMinutes: Number.isInteger(interval) && interval >= 5 && interval <= 1440 ? interval : 60,
    skipMagnetWhenAvailable: getSetting('jellyfin_skip_magnet_when_available') !== '0'
  };
}

/** Credentials are intentionally server-only; API routes must never return them. */
export function getQbittorrentSettings(): QbittorrentSettings {
  const configuredMinimum = Number(getSetting('qbit_auto_download_min_size_mb'));
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
    autoDownloadMinSizeMb: Number.isInteger(configuredMinimum) && configuredMinimum >= 0 && configuredMinimum <= 1048576 ? configuredMinimum : 0,
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
 * counter. Repair the standard MissAV list configuration wherever it is still
 * missing. Existing archives stay intact; their next check becomes a full scan.
 */
async function backfillMissavPaginationDefaults() {
  const migrationKey = 'missav_list_pagination_backfill_v2';
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
      WHERE selector = 'a.text-secondary[alt]'
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
await encryptLegacySensitiveSettings();
await preloadSettings();
await seedDefaultSubscriptionPresets();
await backfillMissavPaginationDefaults();
await seedDefaultInspectionRules();

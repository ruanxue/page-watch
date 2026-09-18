import 'dotenv/config';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import { ensureMySqlSchema } from './mysql-schema.js';
import { environmentDatabaseSettings, normalizeDatabaseSettings, savedDatabaseSettings, saveDatabaseSettings, type MySqlConnectionSettings } from './database-bootstrap.js';
import { defaultInspectionRules, inspectionRulesJson } from './inspection-rules.js';
import { notifyLive } from './live-events.js';
import { decryptSecret, encryptSecret, isEncryptedSecret, readApplicationEncryptionKey } from './secret-storage.js';
import { defaultRuntimeSettings, normalizeRuntimeSettings, type RuntimeSettings } from './runtime-settings.js';

const applicationEncryptionKey = readApplicationEncryptionKey();
const sensitiveSettingKeys = new Set(['jellyfin_api_key', 'qbit_api_key', 'qbit_password', 'app_auth_session_secret']);

let pool: Pool | null = null;
let databaseSource: 'environment' | 'saved' | null = null;
let databaseConfigurationProblem: string | null = null;
let databaseConfigurationInProgress = false;

function createPool(config: MySqlConnectionSettings) {
  return mysql.createPool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  waitForConnections: true,
  // Six workers live in one container. A small per-process pool avoids each
  // of them reserving eight connections on the NAS MySQL server.
  connectionLimit: config.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z'
  });
}

function loadDatabasePool() {
  try {
    const environment = environmentDatabaseSettings();
    const saved = environment ? null : savedDatabaseSettings();
    const config = environment ?? saved;
    if (!config) return null;
    databaseSource = environment ? 'environment' : 'saved';
    return createPool(config);
  } catch (error) {
    databaseConfigurationProblem = '已保存的数据库连接无法读取。请重新填写 MySQL 配置，并确认 APP_ENCRYPTION_KEY 未变更。';
    console.warn(`Unable to read saved database connection: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

pool = loadDatabasePool();

export class DatabaseNotConfiguredError extends Error {
  constructor() { super('数据库尚未配置。请先完成 MySQL 安装引导。'); }
}
export function isDatabaseConfigured() { return pool !== null && !databaseConfigurationInProgress; }
export function databaseConfigurationSource() { return databaseSource; }
export function databaseConfigurationError() { return databaseConfigurationProblem; }
function requirePool() {
  if (!pool) throw new DatabaseNotConfiguredError();
  return pool;
}

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
  async all<T>(sql: string, params: unknown[] = []) { return clientFor(requirePool()).all<T>(sql, params); },
  async get<T>(sql: string, params: unknown[] = []) { return clientFor(requirePool()).get<T>(sql, params); },
  async run(sql: string, params: unknown[] = []) { return clientFor(requirePool()).run(sql, params); },
  async transaction<T>(work: (tx: DatabaseClient) => Promise<T>) {
    const connection = await requirePool().getConnection();
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

/** Test, initialise and persist a browser-provided MySQL connection only after it succeeds. */
export async function configureDatabase(input: Partial<MySqlConnectionSettings>) {
  if (databaseSource === 'environment') throw new Error('当前数据库连接由 Docker 环境变量管理，请在部署配置中修改。');
  const settings = normalizeDatabaseSettings(input);
  const candidate = createPool(settings);
  const previousPool = pool;
  const previousSource = databaseSource;
  const previousProblem = databaseConfigurationProblem;
  const previousInitialization = initialization;
  try {
    await candidate.query('SELECT 1');
    await ensureMySqlSchema(candidate);
    pool = candidate;
    databaseSource = 'saved';
    databaseConfigurationProblem = null;
    databaseConfigurationInProgress = true;
    initialization = null;
    await initializeDatabase();
    // Persist only after every initialization step succeeds. Otherwise a
    // failed setup would leave the browser on the database page while the API
    // considered the database configured and required an impossible login.
    saveDatabaseSettings(settings);
    databaseConfigurationInProgress = false;
    await previousPool?.end().catch((error) => console.warn(`Unable to close previous database pool: ${error instanceof Error ? error.message : String(error)}`));
  } catch (error) {
    if (pool === candidate) {
      pool = previousPool;
      databaseSource = previousSource;
      databaseConfigurationProblem = previousProblem;
      initialization = previousInitialization;
    }
    databaseConfigurationInProgress = false;
    await candidate.end().catch(() => undefined);
    throw error;
  }
}

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

const heartbeatCache = new Map<WorkerName, { signature: string; persistedAt: number; hadTask: boolean }>();
const heartbeatPersistIntervalMs = 60_000;

/** A tiny, DB-backed heartbeat is reliable across the separate Docker services. */
export async function reportWorkerHeartbeat(workerName: WorkerName, detail: string, status: 'ready' | 'busy' | 'sleeping' | 'error' = 'ready', task: WorkerTaskContext | null = null) {
  const normalized = {
    status,
    detail: detail.slice(0, 255),
    kind: task?.kind?.slice(0, 32) ?? null,
    subscriptionId: task?.subscriptionId ?? null,
    archiveEntryId: task?.archiveEntryId ?? null,
    content: task?.content?.slice(0, 255) ?? null,
    current: task?.current ?? null,
    total: task?.total ?? null,
    label: task?.label?.slice(0, 128) ?? null
  };
  const signature = JSON.stringify(normalized);
  const nowMs = Date.now();
  const previous = heartbeatCache.get(workerName);
  const changed = previous?.signature !== signature;
  // Identical heartbeats only renew readiness in MySQL. They deliberately do
  // not wake SSE clients or force the task centre to download its queues.
  if (!changed && previous && nowMs - previous.persistedAt < heartbeatPersistIntervalMs) return;
  await db.run(`INSERT INTO worker_heartbeats (worker_name, status, detail, task_kind, subscription_id, archive_entry_id, task_content, progress_current, progress_total, progress_label, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), task_kind = VALUES(task_kind), subscription_id = VALUES(subscription_id), archive_entry_id = VALUES(archive_entry_id), task_content = VALUES(task_content), progress_current = VALUES(progress_current), progress_total = VALUES(progress_total), progress_label = VALUES(progress_label), last_seen_at = VALUES(last_seen_at)`,
  [workerName, normalized.status, normalized.detail, normalized.kind, normalized.subscriptionId, normalized.archiveEntryId, normalized.content, normalized.current, normalized.total, normalized.label, new Date(nowMs).toISOString()]);
  heartbeatCache.set(workerName, { signature, persistedAt: nowMs, hadTask: Boolean(normalized.kind || normalized.archiveEntryId || normalized.subscriptionId) });
  if (changed) {
    notifyLive('services');
    if (Boolean(normalized.kind || normalized.archiveEntryId || normalized.subscriptionId) || previous?.hadTask) notifyLive('tasks');
  }
}

export type SubscriptionProgress = {
  subscription_id: number;
  archive_total: number;
  jellyfin_available: number;
  release_total: number;
  release_done: number;
  magnet_total: number;
  magnet_done: number;
  library_total: number;
  library_done: number;
  download_total: number;
  download_done: number;
  updated_at: string;
};

/** Rebuild one compact read-model row after an archive-state transition. */
export async function rebuildSubscriptionProgress(subscriptionId?: number, client: DatabaseClient = db) {
  const now = new Date().toISOString();
  const where = subscriptionId === undefined ? '' : 'WHERE s.id = ?';
  const params = subscriptionId === undefined ? [now] : [now, subscriptionId];
  await client.run(`INSERT INTO subscription_progress
    (subscription_id, archive_total, jellyfin_available, release_total, release_done, magnet_total, magnet_done, library_total, library_done, download_total, download_done, updated_at)
    SELECT s.id,
      COUNT(a.id),
      COALESCE(SUM(a.jellyfin_status = 'available'), 0),
      COALESCE(SUM(a.release_status <> 'unsearched'), 0),
      COALESCE(SUM(a.release_status IN ('found','unavailable','failed')), 0),
      COALESCE(SUM(a.magnet_status <> 'unsearched'), 0),
      COALESCE(SUM(a.magnet_status IN ('found','not_found','failed','skipped')), 0),
      COALESCE(SUM(a.jellyfin_status <> 'unconfigured'), 0),
      COALESCE(SUM(a.jellyfin_status IN ('available','not_found','failed')), 0),
      COALESCE(SUM(a.download_status <> 'not_queued'), 0),
      COALESCE(SUM(a.download_status IN ('completed','removed','failed','filtered','not_queued')), 0),
      ?
    FROM subscriptions s LEFT JOIN archive_entries a ON a.subscription_id = s.id
    ${where}
    GROUP BY s.id
    ON DUPLICATE KEY UPDATE archive_total=VALUES(archive_total), jellyfin_available=VALUES(jellyfin_available),
      release_total=VALUES(release_total), release_done=VALUES(release_done), magnet_total=VALUES(magnet_total), magnet_done=VALUES(magnet_done),
      library_total=VALUES(library_total), library_done=VALUES(library_done), download_total=VALUES(download_total), download_done=VALUES(download_done), updated_at=VALUES(updated_at)`, params);
}

// NAS MySQL deployments commonly deny CREATE TRIGGER while binary logging is
// enabled. Keep the compact read-model up to date in the application instead:
// transitions for the same subscription are coalesced, so a batch of archive
// jobs costs one bounded aggregate query rather than one query per row or a
// full archive scan whenever the UI refreshes.
const pendingProgressRebuilds = new Set<number>();
let progressRebuildTimer: NodeJS.Timeout | null = null;
const PROGRESS_REBUILD_DEBOUNCE_MS = 2_000;

export function scheduleSubscriptionProgressRebuild(subscriptionId: number) {
  if (!Number.isInteger(subscriptionId) || subscriptionId < 1) return;
  pendingProgressRebuilds.add(subscriptionId);
  if (progressRebuildTimer) return;
  progressRebuildTimer = setTimeout(() => { void flushSubscriptionProgressRebuilds(); }, PROGRESS_REBUILD_DEBOUNCE_MS);
}

export async function flushSubscriptionProgressRebuilds() {
  if (progressRebuildTimer) clearTimeout(progressRebuildTimer);
  progressRebuildTimer = null;
  const subscriptionIds = [...pendingProgressRebuilds];
  pendingProgressRebuilds.clear();
  await Promise.all(subscriptionIds.map(async (subscriptionId) => {
    try { await rebuildSubscriptionProgress(subscriptionId); }
    catch (error) { console.error(`Unable to rebuild subscription progress for ${subscriptionId}: ${error instanceof Error ? error.message : String(error)}`); }
  }));
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

export type LibrarySyncJob = {
  id: number;
  trigger_type: 'manual' | 'scheduled';
  status: 'queued' | 'running' | 'completed' | 'failed';
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  priority: number;
  progress_phase: string | null;
  progress_current: number | null;
  progress_total: number | null;
  progress_label: string | null;
};

/** Queue only one active complete snapshot. A manual click upgrades a waiting
 * scheduled run but never interrupts a currently-running child. */
export async function queueLibrarySyncJob(trigger: 'manual' | 'scheduled', priority: JobPriority = JOB_PRIORITY.normal) {
  const existing = await db.get<Pick<LibrarySyncJob, 'id' | 'priority' | 'status'>>("SELECT id, priority, status FROM library_sync_jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1");
  if (existing) {
    if (existing.status === 'queued' && Number(existing.priority) < priority) {
      await db.run("UPDATE library_sync_jobs SET priority = ?, trigger_type = 'manual' WHERE id = ?", [priority, existing.id]);
      notifyLive('tasks');
    }
    return { id: existing.id, queued: false };
  }
  try {
    const result = await db.run(`INSERT INTO library_sync_jobs (trigger_type, status, requested_at, priority)
      VALUES (?, 'queued', ?, ?)`, [trigger, new Date().toISOString(), priority]);
    notifyLive('tasks');
    return { id: result.lastInsertRowid, queued: true };
  } catch (error) {
    const raced = await db.get<Pick<LibrarySyncJob, 'id'>>("SELECT id FROM library_sync_jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1");
    if (raced) return { id: raced.id, queued: false };
    throw error;
  }
}

/**
 * The unified runner uses this conservative snapshot before an optional
 * memory-only restart. A queued retry counts as work too: preserving a few
 * megabytes is never worth delaying a user's queued task.
 */
export async function getExecutionEngineQueueState() {
  const row = await db.get<{ queued: number | string; running: number | string; busy_workers: number | string }>(`SELECT
      COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
      (SELECT COUNT(*) FROM worker_heartbeats
        WHERE worker_name IN ('capture', 'release', 'magnet', 'download', 'library')
          AND status = 'busy'
          AND last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 SECOND)) AS busy_workers
    FROM (
      SELECT status FROM jobs
      UNION ALL SELECT status FROM release_jobs
      UNION ALL SELECT status FROM magnet_jobs
      UNION ALL SELECT status FROM library_jobs
      UNION ALL SELECT status FROM download_jobs
      UNION ALL SELECT status FROM library_sync_jobs
    ) AS execution_queue`);
  return { queued: Number(row?.queued ?? 0), running: Number(row?.running ?? 0), busyWorkers: Number(row?.busy_workers ?? 0) };
}

type RuntimeLogInput = {
  level: 'info' | 'success' | 'error';
  source: 'system' | 'queue' | 'worker' | 'download' | 'library';
  message: string;
  subscriptionId?: number | null;
  jobId?: number | null;
};

const telemetryBuffered = process.env.PAGE_WATCH_TELEMETRY_BUFFERED === '1';
const bufferedLogs: RuntimeLogInput[] = [];
const bufferedMetrics = new Map<string, { bucket: string; input: PerformanceMetricInput; count: number; durationMs: number }>();
let telemetryFlushTimer: NodeJS.Timeout | null = null;
let telemetryFlushing: Promise<void> | null = null;

function scheduleTelemetryFlush() {
  if (telemetryFlushTimer) return;
  telemetryFlushTimer = setTimeout(() => { void flushTelemetry(); }, 200);
  telemetryFlushTimer.unref();
}

async function appendRuntimeLogNow(input: RuntimeLogInput) {
  const result = await db.run(`INSERT INTO runtime_logs
    (level, source, subscription_id, job_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  [input.level, input.source, input.subscriptionId ?? null, input.jobId ?? null, input.message, new Date().toISOString()]);
  await db.run('DELETE FROM runtime_logs WHERE id <= (SELECT cutoff.id FROM (SELECT COALESCE(MAX(id), 0) - 1000 AS id FROM runtime_logs) AS cutoff)');
  notifyLive('logs');
  return result.lastInsertRowid;
}

/**
 * Worker success/info noise is safe to coalesce. Failures and user-triggered
 * queue entries remain durable before their caller continues, so a crash
 * never hides the reason a task failed or a manual action was accepted.
 */
export async function appendRuntimeLog(input: RuntimeLogInput) {
  if (!telemetryBuffered || input.level === 'error' || input.source === 'queue') return appendRuntimeLogNow(input);
  bufferedLogs.push(input);
  if (bufferedLogs.length >= 50) void flushTelemetry(); else scheduleTelemetryFlush();
  return 0;
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
  scope: 'capture' | 'release' | 'magnet' | 'library' | 'download' | 'runner';
  metric: 'processed' | 'retry' | 'jellyfin_cache' | 'chromium_rebuild' | 'memory_reclaim';
  dimension?: string;
  durationMs?: number;
  count?: number;
};

function metricBucketStart(date = new Date()) {
  date.setUTCSeconds(0, 0);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function recordPerformanceMetricNow(input: PerformanceMetricInput, bucket = metricBucketStart()) {
  const dimension = (input.dimension ?? 'all').slice(0, 64) || 'all';
  const count = Math.max(1, Math.floor(input.count ?? 1));
  const duration = Math.max(0, Math.floor(input.durationMs ?? 0));
  await db.run(`INSERT INTO performance_metrics (granularity, bucket_start, scope, metric, dimension, sample_count, duration_ms)
    VALUES ('minute', ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE sample_count = sample_count + VALUES(sample_count), duration_ms = duration_ms + VALUES(duration_ms)`,
  [bucket, input.scope, input.metric, dimension, count, duration]);
  notifyLive('metrics');
}

/** Persist only aggregate operational counters; never call this with user content or raw errors. */
export async function recordPerformanceMetric(input: PerformanceMetricInput) {
  if (!telemetryBuffered) return recordPerformanceMetricNow(input);
  const bucket = metricBucketStart();
  const dimension = (input.dimension ?? 'all').slice(0, 64) || 'all';
  const key = `${bucket}\u0000${input.scope}\u0000${input.metric}\u0000${dimension}`;
  const current = bufferedMetrics.get(key);
  if (current) {
    current.count += Math.max(1, Math.floor(input.count ?? 1));
    current.durationMs += Math.max(0, Math.floor(input.durationMs ?? 0));
  } else {
    bufferedMetrics.set(key, { bucket, input: { ...input, dimension }, count: Math.max(1, Math.floor(input.count ?? 1)), durationMs: Math.max(0, Math.floor(input.durationMs ?? 0)) });
  }
  if (bufferedMetrics.size + bufferedLogs.length >= 50) void flushTelemetry(); else scheduleTelemetryFlush();
}

/** Flushes process-local success telemetry before a disposable engine exits. */
export async function flushTelemetry() {
  if (telemetryFlushTimer) clearTimeout(telemetryFlushTimer);
  telemetryFlushTimer = null;
  if (telemetryFlushing) return telemetryFlushing;
  const logs = bufferedLogs.splice(0);
  const metrics = [...bufferedMetrics.values()];
  bufferedMetrics.clear();
  if (!logs.length && !metrics.length) return;
  telemetryFlushing = (async () => {
    try {
      if (logs.length) {
        const now = new Date().toISOString();
        const placeholders = logs.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        await db.run(`INSERT INTO runtime_logs (level, source, subscription_id, job_id, message, created_at) VALUES ${placeholders}`,
          logs.flatMap((input) => [input.level, input.source, input.subscriptionId ?? null, input.jobId ?? null, input.message, now]));
        await db.run('DELETE FROM runtime_logs WHERE id <= (SELECT cutoff.id FROM (SELECT COALESCE(MAX(id), 0) - 1000 AS id FROM runtime_logs) AS cutoff)');
        notifyLive('logs');
      }
      for (const metric of metrics) await recordPerformanceMetricNow({ ...metric.input, count: metric.count, durationMs: metric.durationMs }, metric.bucket);
    } catch (error) {
      // The operational path must not fail because telemetry is unavailable.
      // Restore unpersisted values so a later flush has another chance.
      bufferedLogs.unshift(...logs);
      for (const metric of metrics) {
        const dimension = (metric.input.dimension ?? 'all').slice(0, 64) || 'all';
        const key = `${metric.bucket}\u0000${metric.input.scope}\u0000${metric.input.metric}\u0000${dimension}`;
        const previous = bufferedMetrics.get(key);
        if (previous) { previous.count += metric.count; previous.durationMs += metric.durationMs; }
        else bufferedMetrics.set(key, metric);
      }
      console.warn(`Unable to flush buffered telemetry: ${error instanceof Error ? error.message : String(error)}`);
      scheduleTelemetryFlush();
    } finally { telemetryFlushing = null; }
  })();
  return telemetryFlushing;
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

export type RuntimeMetric = { key: string; value?: number | null; text?: string | null };
const runtimeMetricCache = new Map<string, { value: number | null; text: string | null; persistedAt: number }>();

function runtimeMetricChanged(previous: { value: number | null; text: string | null } | undefined, metric: RuntimeMetric) {
  const value = metric.value ?? null;
  const text = metric.text?.slice(0, 64) ?? null;
  if (!previous) return true;
  if (previous.text !== text) return true;
  if (previous.value === value) return false;
  // RSS/cgroup gauges naturally move a few pages while idle. Persist and
  // publish only material shifts; a periodic renewal still keeps the page
  // truthful without producing a stream of tiny memory updates.
  if (metric.key.endsWith('_bytes')) return Math.abs((previous.value ?? 0) - (value ?? 0)) >= 1024 * 1024;
  return true;
}

/** Persist current, safe-to-display process gauges. These are snapshots, not logs. */
export async function reportRuntimeMetrics(metrics: RuntimeMetric[]) {
  if (!metrics.length) return;
  const nowMs = Date.now();
  const changed = metrics.some((metric) => runtimeMetricChanged(runtimeMetricCache.get(metric.key.slice(0, 64)), metric));
  const stale = metrics.some((metric) => nowMs - (runtimeMetricCache.get(metric.key.slice(0, 64))?.persistedAt ?? 0) >= 60_000);
  if (!changed && !stale) return;
  const now = new Date(nowMs).toISOString();
  const values = metrics.flatMap((metric) => [metric.key.slice(0, 64), metric.value ?? null, metric.text?.slice(0, 64) ?? null, now]);
  const placeholders = metrics.map(() => '(?, ?, ?, ?)').join(', ');
  await db.run(`INSERT INTO runtime_metrics (metric_key, numeric_value, text_value, updated_at) VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE numeric_value = VALUES(numeric_value), text_value = VALUES(text_value), updated_at = VALUES(updated_at)`, values);
  for (const metric of metrics) runtimeMetricCache.set(metric.key.slice(0, 64), { value: metric.value ?? null, text: metric.text?.slice(0, 64) ?? null, persistedAt: nowMs });
  if (changed) notifyLive('metrics');
}

export async function getRuntimeMetrics() {
  return db.all<{ metric_key: string; numeric_value: number | null; text_value: string | null; updated_at: string }>(
    'SELECT metric_key, numeric_value, text_value, updated_at FROM runtime_metrics'
  );
}

export type IntegrationService = 'jellyfin' | 'qbittorrent';
const integrationCache = new Map<IntegrationService, { signature: string; persistedAt: number }>();
export async function reportIntegrationStatus(service: IntegrationService, status: 'healthy' | 'degraded' | 'disabled', detail: string | null = null) {
  const normalizedDetail = detail?.slice(0, 255) ?? null;
  const signature = `${status}\u0000${normalizedDetail ?? ''}`;
  const nowMs = Date.now();
  const previous = integrationCache.get(service);
  const changed = previous?.signature !== signature;
  if (!changed && previous && nowMs - previous.persistedAt < 60_000) return;
  await db.run(`INSERT INTO integration_status (service_name, status, detail, checked_at) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), checked_at = VALUES(checked_at)`,
  [service, status, normalizedDetail, new Date(nowMs).toISOString()]);
  integrationCache.set(service, { signature, persistedAt: nowMs });
  if (changed) notifyLive('services');
}

export async function getIntegrationStatuses() {
  return db.all<{ service_name: IntegrationService; status: 'healthy' | 'degraded' | 'disabled'; detail: string | null; checked_at: string }>('SELECT service_name, status, detail, checked_at FROM integration_status');
}

export function getOutboundProxyUrl() {
  return process.env.OUTBOUND_PROXY?.trim() || getSetting('outbound_proxy').trim();
}

export function getRuntimeSettings(): RuntimeSettings {
  return normalizeRuntimeSettings({
    profile: getSetting('runtime_profile') as RuntimeSettings['profile'] || defaultRuntimeSettings.profile,
    browserIdleMinutes: (Number(getSetting('runtime_browser_idle_minutes')) || defaultRuntimeSettings.browserIdleMinutes) as RuntimeSettings['browserIdleMinutes']
  });
}

export async function setRuntimeSettings(input: RuntimeSettings) {
  const settings = normalizeRuntimeSettings(input);
  await Promise.all([
    setSetting('runtime_profile', settings.profile),
    setSetting('runtime_browser_idle_minutes', String(settings.browserIdleMinutes))
  ]);
  return settings;
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

let initialization: Promise<void> | null = null;

/**
 * Schema setup, seed repair and legacy-secret conversion belong to the API
 * lifecycle only. The disposable engine and its child executors merely join
 * the already-initialized database, avoiding an expensive migration pass on
 * every event-driven wake-up.
 */
export function initializeDatabase() {
  if (!initialization) initialization = (async () => {
    await ensureMySqlSchema(requirePool());
    await encryptLegacySensitiveSettings();
    await preloadSettings();
    await seedDefaultSubscriptionPresets();
    await backfillMissavPaginationDefaults();
    await seedDefaultInspectionRules();
    await rebuildSubscriptionProgress();
  })();
  return initialization;
}

if (process.env.PAGE_WATCH_DATABASE_INITIALIZE !== '0' && isDatabaseConfigured()) await initializeDatabase();

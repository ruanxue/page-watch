import 'dotenv/config';
import type { Pool } from 'pg';
import { createPostgresPool, pgClientFor } from './pg-connection.js';
import { ensurePostgresSchema } from './postgres-schema.js';
import { environmentDatabaseSettings, normalizeDatabaseSettings, savedDatabaseSettings, saveDatabaseSettings, type DatabaseConnectionSettings } from './database-bootstrap.js';
import { defaultInspectionRules, inspectionRulesJson } from './inspection-rules.js';
import { BUILTIN_GROUP_NAME, builtinSupplementSteps, legacyMissavGroupName, parseSitesJson, serializeSitesJson } from './rule-groups.js';
import { notifyLive } from './live-events.js';
import { decryptSecret, isEncryptedSecret, isPageWatchEncryptedValue, readOptionalLegacyApplicationEncryptionKey } from './secret-storage.js';
import { resolveHeartbeatWrite, type WorkerHeartbeatContext, type WorkerHeartbeatOptions, type WorkerName, type WorkerTaskContext } from './worker-heartbeat.js';
import { defaultRuntimeSettings, normalizeRuntimeSettings, type RuntimeSettings } from './runtime-settings.js';

let pool: Pool | null = null;
let databaseSource: 'environment' | 'saved' | null = null;
let databaseConfigurationProblem: string | null = null;
let databaseConfigurationInProgress = false;

function loadDatabasePool() {
  try {
    const environment = environmentDatabaseSettings();
    const saved = savedDatabaseSettings();
    const config = environment ?? saved;
    if (!config) return null;
    databaseSource = environment ? 'environment' : 'saved';
    return createPostgresPool(config);
  } catch (error) {
    databaseConfigurationProblem = error instanceof Error ? error.message : '数据库连接配置无法读取。';
    console.warn('数据库配置读取失败：' + databaseConfigurationProblem);
    return null;
  }
}

pool = loadDatabasePool();

export class DatabaseNotConfiguredError extends Error {
  constructor() { super('数据库尚未配置。请先完成 PostgreSQL 安装引导。'); }
}
export function isDatabaseConfigured() { return pool !== null && !databaseConfigurationInProgress; }
export function databaseConfigurationSource() { return databaseSource; }
export function databaseConfigurationError() { return databaseConfigurationProblem; }
function requirePool() {
  if (!pool) throw new DatabaseNotConfiguredError();
  return pool;
}
export type RunResult = { changes: number; lastInsertRowid: number };
export type DatabaseClient = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
};

export const db: DatabaseClient & { transaction<T>(work: (tx: DatabaseClient) => Promise<T>): Promise<T> } = {
  async all<T>(sql: string, params: unknown[] = []) { return pgClientFor(requirePool()).all<T>(sql, params); },
  async get<T>(sql: string, params: unknown[] = []) { return pgClientFor(requirePool()).get<T>(sql, params); },
  async run(sql: string, params: unknown[] = []) { return pgClientFor(requirePool()).run(sql, params); },
  async transaction<T>(work: (tx: DatabaseClient) => Promise<T>) {
    const client = await requirePool().connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await work(pgClientFor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }
};

/** 关闭连接池；用于服务退出及隔离测试结束后的资源回收。 */
export async function closeDatabase() {
  const previous = pool;
  pool = null;
  await previous?.end();
}

/** 完整验证与初始化成功后才保存 PostgreSQL 连接。 */
export async function configureDatabase(input: Partial<DatabaseConnectionSettings>) {
  if (databaseSource === 'environment') throw new Error('当前数据库连接由 Docker 环境变量管理，请在部署配置中修改。');
  environmentDatabaseSettings();
  savedDatabaseSettings();
  const settings = normalizeDatabaseSettings(input);
  const candidate = createPostgresPool(settings);
  const previousPool = pool;
  const previousSource = databaseSource;
  const previousProblem = databaseConfigurationProblem;
  const previousInitialization = initialization;
  try {
    await candidate.query('SELECT 1');
    pool = candidate;
    databaseSource = 'saved';
    databaseConfigurationProblem = null;
    databaseConfigurationInProgress = true;
    initialization = null;
    await initializeDatabase();
    saveDatabaseSettings(settings);
    databaseConfigurationInProgress = false;
    await previousPool?.end().catch(() => console.warn('旧 PostgreSQL 连接池关闭失败。'));
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
  rule_family: 'missav' | 'legacy_custom';
  preset_id: number | null;
  render_mode_override: 'static' | 'dynamic' | null;
  last_checked_at: string | null;
  last_hash: string | null;
  last_content: string | null;
  last_error: string | null;
  last_scan_added_count: number;
  last_scan_seen_at: string | null;
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
  [BUILTIN_GROUP_NAME, '适用于列表页，读取影片番号、标题和全部分页内容。', 'a.text-secondary[alt]', 'dynamic', 'attribute', 'alt', '', 'a.text-secondary[alt]', 'text', null, missavTitlePattern, 'all', 60, '#price-currency', 'page', '/\\s*(\\d+)', 1],
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
  const activeColumn = column === 'subscription_id' ? 'active_subscription_id' : 'active_archive_entry_id';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await client.get<{ id: number; priority: number }>(`SELECT id, priority FROM "${table}" WHERE "${column}" = ? AND status IN ('queued', 'running')`, [id]);
    if (existing) {
      if (existing.priority < priority) {
        const promoted = await client.run(`UPDATE "${table}" SET priority = ? WHERE id = ? AND status = 'queued' AND priority < ?`, [priority, existing.id, priority]);
        if (promoted.changes && client === db) notifyLive('tasks');
      }
      return { id: existing.id, queued: false };
    }
    // 冲突是正常的并发结果，不能通过 SQL 异常处理，否则会使整笔事务失效。
    const result = await client.run(`INSERT INTO "${table}" ("${column}", status, requested_at, priority) VALUES (?, 'queued', ?, ?)
      ON CONFLICT ("${activeColumn}") DO NOTHING RETURNING id`, [id, new Date().toISOString(), priority]);
    if (result.changes) {
      if (client === db) notifyLive('tasks');
      return { id: result.lastInsertRowid, queued: true };
    }
  }
  throw new Error('任务状态正在变化，请稍后重试。');
}

export async function queueJob(subscriptionId: number, priority: JobPriority = JOB_PRIORITY.normal, client: DatabaseClient = db) {
  return queueUnique('jobs', 'subscription_id', subscriptionId, priority, client);
}

export type MagnetStatus = 'unsearched' | 'pending' | 'found' | 'not_found' | 'failed' | 'skipped';
export type DownloadStatus = 'not_queued' | 'queued' | 'running' | 'added' | 'waiting' | 'downloading' | 'paused' | 'completed' | 'removed' | 'filtered' | 'failed';

export type { WorkerName, WorkerTaskContext } from './worker-heartbeat.js';

/** A tiny, DB-backed heartbeat is reliable across the separate Docker services. */
export async function reportWorkerHeartbeat(workerName: WorkerName, detail: string, status: 'ready' | 'busy' | 'sleeping' | 'error' = 'ready', task: WorkerTaskContext | null = null, options: WorkerHeartbeatOptions = {}) {
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
  const nowMs = Date.now();
  const write = resolveHeartbeatWrite(workerName, normalized, nowMs, options);
  // 节流窗口内内容未变化的心跳只用于续期在线状态，这件事已由下一次真实写入
  // 或执行引擎的保活心跳覆盖，这里直接跳过写库。
  if (!write.signature) return;
  await db.run(`INSERT INTO worker_heartbeats (worker_name, status, detail, task_kind, subscription_id, archive_entry_id, task_content, progress_current, progress_total, progress_label, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (worker_name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, task_kind = EXCLUDED.task_kind, subscription_id = EXCLUDED.subscription_id, archive_entry_id = EXCLUDED.archive_entry_id, task_content = EXCLUDED.task_content, progress_current = EXCLUDED.progress_current, progress_total = EXCLUDED.progress_total, progress_label = EXCLUDED.progress_label, last_seen_at = EXCLUDED.last_seen_at`,
  [workerName, normalized.status, normalized.detail, normalized.kind, normalized.subscriptionId, normalized.archiveEntryId, normalized.content, normalized.current, normalized.total, normalized.label, new Date(nowMs).toISOString()]);
  if (write.changed) {
    notifyLive('services');
    if (write.hadTask) notifyLive('tasks');
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
      COUNT(*) FILTER (WHERE a.jellyfin_status = 'available'),
      COUNT(*) FILTER (WHERE a.release_status <> 'unsearched'),
      COUNT(*) FILTER (WHERE a.release_status IN ('found','unavailable','failed')),
      COUNT(*) FILTER (WHERE a.magnet_status <> 'unsearched'),
      COUNT(*) FILTER (WHERE a.magnet_status IN ('found','not_found','failed','skipped')),
      COUNT(*) FILTER (WHERE a.jellyfin_status <> 'unconfigured'),
      COUNT(*) FILTER (WHERE a.jellyfin_status IN ('available','not_found','failed')),
      COUNT(*) FILTER (WHERE a.download_status <> 'not_queued'),
      COUNT(*) FILTER (WHERE a.download_status IN ('completed','removed','failed','filtered','not_queued')),
      ?
    FROM subscriptions s LEFT JOIN archive_entries a ON a.subscription_id = s.id
    ${where}
    GROUP BY s.id
    ON CONFLICT (subscription_id) DO UPDATE SET archive_total=EXCLUDED.archive_total, jellyfin_available=EXCLUDED.jellyfin_available,
      release_total=EXCLUDED.release_total, release_done=EXCLUDED.release_done, magnet_total=EXCLUDED.magnet_total, magnet_done=EXCLUDED.magnet_done,
      library_total=EXCLUDED.library_total, library_done=EXCLUDED.library_done, download_total=EXCLUDED.download_total, download_done=EXCLUDED.download_done, updated_at=EXCLUDED.updated_at`, params);
}

// 按订阅合并统计刷新，避免每条档案状态变化都重新汇总。
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
  const result = await queueUnique('download_jobs', 'archive_entry_id', archiveEntryId, priority, client);
  if (result.queued) {
    await client.run('UPDATE archive_entries SET download_completion_notified_at = NULL WHERE id = ?', [archiveEntryId]);
  }
  return result;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await db.get<Pick<LibrarySyncJob, 'id' | 'priority' | 'status'>>("SELECT id, priority, status FROM library_sync_jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1");
    if (existing) {
      if (existing.status === 'queued' && Number(existing.priority) < priority) {
        const promoted = await db.run("UPDATE library_sync_jobs SET priority = ?, trigger_type = 'manual' WHERE id = ? AND status = 'queued' AND priority < ?", [priority, existing.id, priority]);
        if (promoted.changes) notifyLive('tasks');
      }
      return { id: existing.id, queued: false };
    }
    const result = await db.run(`INSERT INTO library_sync_jobs (trigger_type, status, requested_at, priority)
      VALUES (?, 'queued', ?, ?) ON CONFLICT (active_marker) DO NOTHING RETURNING id`, [trigger, new Date().toISOString(), priority]);
    if (result.changes) {
      notifyLive('tasks');
      return { id: result.lastInsertRowid, queued: true };
    }
  }
  throw new Error('影视库同步任务状态正在变化，请稍后重试。');
}

/** A runner can exit while its external Jellyfin child is running. Release its
 * durable active slot only after the owning runner stops renewing the lease. */
export async function recoverStaleLibrarySyncJobs() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
  const result = await db.run(`UPDATE library_sync_jobs
    SET status = 'failed', finished_at = ?, error = ?, progress_phase = 'failed', progress_label = ?
    WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < ?`,
  [now.toISOString(), 'Jellyfin 同步进程中断或心跳超时，已自动释放任务。', '同步进程心跳超时', cutoff]);
  if (result.changes) notifyLive('tasks');
  return result.changes;
}

/**
 * The unified runner uses this conservative snapshot before an optional
 * memory-only restart. A queued retry counts as work too: preserving a few
 * megabytes is never worth delaying a user's queued task.
 */
export async function getExecutionEngineQueueState() {
  const heartbeatCutoff = new Date(Date.now() - 45_000).toISOString();
  const row = await db.get<{ queued: number | string; running: number | string; busy_workers: number | string }>(`SELECT
      COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
      (SELECT COUNT(*) FROM worker_heartbeats
        WHERE worker_name IN ('capture', 'release', 'magnet', 'download', 'library')
          AND status = 'busy'
          AND last_seen_at >= ?) AS busy_workers
    FROM (
      SELECT status FROM jobs
      UNION ALL SELECT status FROM release_jobs
      UNION ALL SELECT status FROM magnet_jobs
      UNION ALL SELECT status FROM library_jobs
      UNION ALL SELECT status FROM download_jobs
      UNION ALL SELECT status FROM library_sync_jobs
      UNION ALL SELECT status FROM notification_outbox
    ) AS execution_queue`, [heartbeatCutoff]);
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

function readableSettingValue(key: string, value: string) {
  if (!isPageWatchEncryptedValue(value)) return value;
  if (!isEncryptedSecret(value)) throw new Error(`app_settings 中发现不支持的 pwenc 加密版本（${key}）；数据库未修改。`);
  throw new Error(`app_settings 中仍有未迁移的 pwenc:v1 配置（${key}）；请重启 Page Watch 完成迁移。`);
}

export async function setSetting(key: string, value: string) {
  await db.run(`INSERT INTO app_settings ("key", value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [key, value, new Date().toISOString()]);
  settings.set(key, value);
}

/**
 * API, capture, magnet and download workers run in separate processes. Refresh
 * their local settings cache so a saved proxy or qBittorrent credential takes
 * effect without a service restart.
 */
export async function refreshSettings(force = false) {
  if (!force && Date.now() - lastSettingsRefreshAt < SETTINGS_REFRESH_MS) return;
  const rows = await db.all<{ key: string; value: string }>('SELECT "key", value FROM app_settings');
  const next = new Map(rows.map((row) => [row.key, readableSettingValue(row.key, row.value)]));
  settings.clear();
  for (const [key, value] of next) settings.set(key, value);
  lastSettingsRefreshAt = Date.now();
}

/** Decrypt every legacy value before any update, then convert the set atomically. */
async function migrateEncryptedSettingsToPlaintext() {
  const keyToClear: { current: Buffer | null } = { current: null };
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.all<{ key: string; value: string }>('SELECT "key", value FROM app_settings FOR UPDATE');
      const encrypted = rows.filter((row) => isPageWatchEncryptedValue(row.value));
      const unsupported = encrypted.find((row) => !isEncryptedSecret(row.value));
      if (unsupported) throw new Error(`app_settings 中发现不支持的 pwenc 加密版本（${unsupported.key}）；数据库和引导文件未修改。`);
      if (!encrypted.length) return;

      const key = readOptionalLegacyApplicationEncryptionKey();
      if (!key) throw new Error('app_settings 中存在旧版 pwenc:v1 密文，但未找到原 APP_ENCRYPTION_KEY 或旧 data/app-encryption-key。请恢复原密钥后重启；数据库和引导文件未修改。');
      keyToClear.current = key;
      const plaintextRows = encrypted.map((row) => {
        try { return { ...row, plaintext: decryptSecret(row.value, key!) }; }
        catch {
          throw new Error(`无法使用当前 APP_ENCRYPTION_KEY 解密 app_settings 中的 pwenc:v1 配置（${row.key}）。请确认旧密钥正确；数据库和引导文件未修改。`);
        }
      });
      const now = new Date().toISOString();
      for (const row of plaintextRows) {
        const result = await tx.run('UPDATE app_settings SET value = ?, updated_at = ? WHERE "key" = ? AND value = ?', [row.plaintext, now, row.key, row.value]);
        if (result.changes !== 1) throw new Error(`迁移 app_settings 中的旧版密文时配置已变化（${row.key}）；数据库事务已回滚。`);
      }
    });
  } finally {
    keyToClear.current?.fill(0);
  }
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
    ON CONFLICT (granularity, bucket_start, scope, metric, dimension) DO UPDATE SET sample_count = performance_metrics.sample_count + EXCLUDED.sample_count, duration_ms = performance_metrics.duration_ms + EXCLUDED.duration_ms`,
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

/** Keep performance history as a rolling seven-day window. */
export async function maintainPerformanceMetrics() {
  // This also clears hourly aggregates left behind by older versions.
  await db.run("DELETE FROM performance_metrics WHERE bucket_start < (now() AT TIME ZONE 'UTC') - INTERVAL '7 days'");
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
    ON CONFLICT (metric_key) DO UPDATE SET numeric_value = EXCLUDED.numeric_value, text_value = EXCLUDED.text_value, updated_at = EXCLUDED.updated_at`, values);
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
    ON CONFLICT (service_name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`,
  [service, status, normalizedDetail, new Date(nowMs).toISOString()]);
  integrationCache.set(service, { signature, persistedAt: nowMs });
  if (changed) notifyLive('services');
}

export async function getIntegrationStatuses() {
  return db.all<{ service_name: IntegrationService; status: 'healthy' | 'degraded' | 'disabled'; detail: string | null; checked_at: string }>('SELECT service_name, status, detail, checked_at FROM integration_status');
}

export function getOutboundProxyUrl() {
  const environmentProxy = process.env.OUTBOUND_PROXY?.trim();
  if (environmentProxy) return environmentProxy;
  return getSetting('outbound_proxy_enabled') === '0' ? '' : getSetting('outbound_proxy').trim();
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
    await tx.run(`INSERT INTO app_settings ("key", value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, ['subscription_presets_seeded', '1', now]);
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
      WHERE name IN ('MissAV 默认规则组', 'MissAV 番号列表')
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
    await tx.run(`INSERT INTO app_settings ("key", value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [migrationKey, now]);
  });
  settings.set(migrationKey, '1');
}

async function seedDefaultInspectionRules() {
  if (getSetting('inspection_rules')) return;
  await setSetting('inspection_rules', inspectionRulesJson(defaultInspectionRules));
}

/** 只建立旧订阅与规则组的归属，不改写它们当前的读取设置。 */
async function assignLegacyMissavRules() {
  const migrationKey = 'missav_rule_family_v1';
  if (getSetting(migrationKey)) return;
  const sites = (() => {
    try { return JSON.parse(getSetting('inspection_rules')).sites as string[]; }
    catch { return defaultInspectionRules.sites; }
  })();
  const hosts = [...new Set([...defaultInspectionRules.sites, ...(Array.isArray(sites) ? sites : [])].map((site) => {
    try { return new URL(site).hostname.toLowerCase(); } catch { return ''; }
  }).filter(Boolean))];
  const presets = await db.all<{ id: number; selector: string; render_mode: 'static' | 'dynamic'; content_source: string; attribute_name: string | null; pagination_selector: string | null }>('SELECT id, selector, render_mode, content_source, attribute_name, pagination_selector FROM subscription_presets ORDER BY id');
  const fallback = presets[0];
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    let lastId = 0;
    while (true) {
      const batch = await tx.all<Pick<Subscription, 'id' | 'url' | 'selector' | 'render_mode' | 'content_source' | 'attribute_name' | 'pagination_selector'>>('SELECT id, url, selector, render_mode, content_source, attribute_name, pagination_selector FROM subscriptions WHERE id > ? ORDER BY id LIMIT 100', [lastId]);
      if (!batch.length) break;
      for (const subscription of batch) {
        let host = '';
        try { host = new URL(subscription.url).hostname.toLowerCase(); } catch { continue; }
        if (!hosts.includes(host) || !fallback) continue;
        const matched = presets.find((preset) => preset.selector === subscription.selector && preset.content_source === subscription.content_source && preset.attribute_name === subscription.attribute_name && preset.pagination_selector === subscription.pagination_selector) ?? fallback;
        await tx.run("UPDATE subscriptions SET rule_family='missav', preset_id=?, render_mode_override=? WHERE id=? AND rule_family='legacy_custom'", [matched.id, matched.render_mode === subscription.render_mode ? null : subscription.render_mode, subscription.id]);
      }
      lastId = batch[batch.length - 1].id;
    }
    await tx.run(`INSERT INTO app_settings ("key", value, updated_at) VALUES (?, '1', ?) ON CONFLICT ("key") DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`, [migrationKey, now]);
  });
  settings.set(migrationKey, '1');
}

/**
 * 「检查规则组」一次性迁移：原先整个项目只有一份全局站点列表和两条写死的补全
 * 步骤，现在它们归属到内置规则组自己身上。
 *
 * - 内置组：沿用当前 inspection_rules.sites 作为「适用站点」，并写入发行日期、
 *   磁力链接两条内置步骤；旧名称「MissAV 番号列表」同时改为「MissAV 默认规则组」。
 * - 其余已有预设：sites_json / steps_json 补成空数组。空站点表示不限站点，
 *   空步骤表示没有自定义步骤，两者都不是错误状态。
 * - 订阅的 rule_family 与读取列一律不动，迁移只补两列 JSON。
 */
async function migrateRuleGroups() {
  const migrationKey = 'rule_groups_v1';
  if (getSetting(migrationKey)) return;
  const sites = (() => {
    try {
      const parsed = JSON.parse(getSetting('inspection_rules'));
      const list = parseSitesJson(JSON.stringify((parsed as { sites?: unknown } | null)?.sites ?? []));
      return list.length ? list : [...defaultInspectionRules.sites];
    } catch { return [...defaultInspectionRules.sites]; }
  })();
  const builtinStepsJson = JSON.stringify(builtinSupplementSteps());
  const builtinSitesJson = serializeSitesJson(sites);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    // 旧版只可能有一组 MissAV 预设；优先按新名字找，其次按旧名字找。
    const target = await tx.get<{ id: number }>(
      `SELECT id FROM subscription_presets WHERE name IN (?, ?)
        ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, id ASC LIMIT 1`,
      [BUILTIN_GROUP_NAME, legacyMissavGroupName, legacyMissavGroupName]);
    if (target) {
      await tx.run(`UPDATE subscription_presets SET name = ?, sites_json = ?, steps_json = ?, updated_at = ? WHERE id = ?`,
        [BUILTIN_GROUP_NAME, builtinSitesJson, builtinStepsJson, now, target.id]);
    } else {
      // 使用者可能已经删掉了 MissAV 预设，这时补一组内置规则，保证页面仍有一组
      // 可用的基础配置。
      await tx.run(`INSERT INTO subscription_presets
        (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, sites_json, steps_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [BUILTIN_GROUP_NAME, '适用于列表页，读取影片番号、标题和全部分页内容。', 'a.text-secondary[alt]', 'dynamic', 'attribute', 'alt', '', 'a.text-secondary[alt]', 'text', null, missavTitlePattern, 'all', 60, '#price-currency', 'page', '/\\s*(\\d+)', 1, builtinSitesJson, builtinStepsJson, now, now]);
    }
    // 其余预设（以及上面新建时没覆盖到的行）补空数组，但不覆盖已有配置。
    await tx.run(`UPDATE subscription_presets SET sites_json = COALESCE(sites_json, '[]'), steps_json = COALESCE(steps_json, '[]')
      WHERE sites_json IS NULL OR steps_json IS NULL`);
    await tx.run(`INSERT INTO app_settings ("key", value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [migrationKey, now]);
  });
  settings.set(migrationKey, '1');
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
    await ensurePostgresSchema(requirePool());
    await migrateEncryptedSettingsToPlaintext();
    await preloadSettings();
    await seedDefaultSubscriptionPresets();
    await backfillMissavPaginationDefaults();
    await seedDefaultInspectionRules();
    await assignLegacyMissavRules();
    await migrateRuleGroups();
    await rebuildSubscriptionProgress();
  })();
  return initialization;
}

if (process.env.PAGE_WATCH_DATABASE_INITIALIZE !== '0' && isDatabaseConfigured()) await initializeDatabase();

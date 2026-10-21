import type { FastifyInstance } from 'fastify';
import { db, getIntegrationStatuses, getJellyfinSettings, getQbittorrentSettings, getRuntimeMetrics, isDatabaseConfigured, type IntegrationService } from '../db.js';
import { privateJson } from '../http-guards.js';
import { emitLive } from '../sse-hub.js';
import { listSubscriptions } from '../subscriptions-query.js';

/**
 * 运行与系统状态：健康检查、服务心跳、任务队列概览、性能指标与运行日志。
 *
 * 这一领域只读取队列、心跳与日志表，不触发抓取或下载，因此不依赖执行引擎，
 * 可以独立注册与测试。
 */
export function registerOperationsRoutes(app: FastifyInstance) {
type HeartbeatRow = {
  worker_name: string;
  status: 'ready' | 'busy' | 'sleeping' | 'error';
  detail: string;
  last_seen_at: string;
  task_kind: string | null;
  subscription_id: number | null;
  archive_entry_id: number | null;
  task_content: string | null;
  progress_current: number | null;
  progress_total: number | null;
  progress_label: string | null;
};

async function getSystemStatus() {
  const rows = await db.all<HeartbeatRow>('SELECT worker_name, status, detail, last_seen_at, task_kind, subscription_id, archive_entry_id, task_content, progress_current, progress_total, progress_label FROM worker_heartbeats');
  const now = Date.now();
  // Each worker reports at least every 15 seconds. Leave room for a busy
  // browser task and for the NAS/local development clock boundary; a worker
  // actively processing a job is healthy, not an alert condition.
  const staleAfterMs = 90_000;
  const futureClockToleranceMs = 5 * 60_000;
  const byName = new Map(rows.map((row) => [row.worker_name, row]));
  const services = [
    ['api', '网页服务'],
    ['capture', '检查 Worker'],
    ['release', '发行日期 Worker'],
    ['magnet', '磁力检索 Worker'],
    ['download', '下载 Worker'],
    ['library', '影视库同步 Worker']
  ].map(([name, label]) => {
    const row = byName.get(name);
    const age = row ? now - new Date(row.last_seen_at).getTime() : Number.POSITIVE_INFINITY;
    return { name, label, status: row?.status ?? 'missing', detail: row?.detail ?? '尚未收到心跳', lastSeenAt: row?.last_seen_at ?? null, healthy: Boolean(row && age >= -futureClockToleranceMs && age < staleAfterMs && row.status !== 'error') };
  });
  return { generatedAt: new Date().toISOString(), services, heartbeats: rows };
}

type ExternalIntegrationStatus = { name: IntegrationService; enabled: boolean; configured: boolean; status: 'healthy' | 'degraded' | 'disabled' | 'unknown'; detail: string | null; checkedAt: string | null };

function summarizeExternalIntegrations(integrations: Awaited<ReturnType<typeof getIntegrationStatuses>>): ExternalIntegrationStatus[] {
  const integrationByName = new Map(integrations.map((item) => [item.service_name, item]));
  const jellyfin = getJellyfinSettings();
  const qbittorrent = getQbittorrentSettings();
  const configured = {
    jellyfin: Boolean(jellyfin.url && jellyfin.apiKey && jellyfin.libraryIds.length),
    qbittorrent: Boolean(qbittorrent.url && (qbittorrent.authMode === 'api_key' ? qbittorrent.apiKey : qbittorrent.username && qbittorrent.password))
  };
  return (['jellyfin', 'qbittorrent'] as const).map((name) => {
    const latest = integrationByName.get(name);
    const enabled = name === 'jellyfin' ? jellyfin.enabled : qbittorrent.enabled;
    return { name, enabled, configured: configured[name], status: !enabled ? 'disabled' : latest?.status ?? 'unknown', detail: latest?.detail ?? null, checkedAt: latest?.checked_at ?? null };
  });
}

async function readinessStatus() {
  // Keep this intentionally local: a NAS must not restart Page Watch merely
  // because a separately managed Jellyfin/qBittorrent service is offline.
  await Promise.all([
    db.get<{ ok: number }>('SELECT 1 AS ok'),
    db.get<{ ok: number }>('SELECT 1 AS ok FROM app_settings LIMIT 1'),
    db.get<{ ok: number }>('SELECT 1 AS ok FROM worker_heartbeats LIMIT 1'),
    db.get<{ ok: number }>('SELECT 1 AS ok FROM performance_metrics LIMIT 1')
  ]);
  const [{ generatedAt, services }, integrations] = await Promise.all([getSystemStatus(), getIntegrationStatuses()]);
  const external = summarizeExternalIntegrations(integrations);
  const unavailable = services.filter((service) => !service.healthy).map((service) => service.label);
  // This endpoint is deliberately unauthenticated for Docker. Do not expose
  // raw worker errors or task context here; the authenticated run centre has
  // the detailed diagnostics.
  const safeServices = services.map(({ name, label, status, lastSeenAt, healthy }) => ({ name, label, status, lastSeenAt, healthy }));
  return { ok: unavailable.length === 0, generatedAt, database: 'ready', services: safeServices, external, unavailable };
}

app.get('/api/ready', async (_request, reply) => {
  if (!isDatabaseConfigured()) return reply.code(503).send({ ok: false, database: 'setup_required', unavailable: ['数据库尚未配置'], services: [], external: [] });
  try {
    const status = await readinessStatus();
    return reply.code(status.ok ? 200 : 503).send(status);
  } catch {
    return reply.code(503).send({ ok: false, database: 'unavailable', unavailable: ['MySQL'], services: [], external: [] });
  }
});

app.get('/api/system/status', async (request, reply) => {
  const [{ generatedAt, services }, integrations] = await Promise.all([getSystemStatus(), getIntegrationStatuses()]);
  return privateJson(request, reply, { generatedAt, services, external: summarizeExternalIntegrations(integrations) });
});

type TaskQueueRow = {
  kind: string;
  task_id: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  priority: number;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  retry_after: string | null;
  error: string | null;
  attempt_count: number;
  subscription_id: number | null;
  subscription_name: string | null;
  content: string | null;
  title: string | null;
  progress_current: number | null;
  progress_total: number | null;
  progress_label: string | null;
  download_progress: number | string | null;
};
type ActiveDownloadRow = { id: number; subscription_id: number; subscription_name: string; content: string; title: string | null; download_status: string; download_progress: number | string | null; download_queued_at: string | null; download_added_at: string | null; download_error: string | null };

const taskQueueUnion = `
  SELECT CASE WHEN s.pagination_selector IS NOT NULL AND s.initial_scan_completed = 0 THEN 'full_scan' ELSE 'check' END AS kind,
    j.id AS task_id, j.status, j.priority, j.requested_at, j.started_at, j.finished_at, j.retry_after, j.error, j.attempt_count,
    s.id AS subscription_id, s.name AS subscription_name, NULL AS content, NULL AS title,
    CASE WHEN s.pagination_selector IS NOT NULL AND s.initial_scan_completed = 0 THEN s.initial_scan_pages_completed ELSE NULL END AS progress_current,
    CASE WHEN s.pagination_selector IS NOT NULL AND s.initial_scan_completed = 0 THEN s.initial_scan_total ELSE NULL END AS progress_total,
    CASE WHEN s.pagination_selector IS NOT NULL AND s.initial_scan_completed = 0 THEN CONCAT('下一个页面：', s.initial_scan_next_page) ELSE NULL END AS progress_label,
    NULL AS download_progress
  FROM jobs j JOIN subscriptions s ON s.id = j.subscription_id
  UNION ALL
  SELECT 'release', j.id, j.status, j.priority, j.requested_at, j.started_at, j.finished_at, j.retry_after, j.error, j.attempt_count,
    a.subscription_id, s.name, a.content, a.title, NULL, NULL, NULL, NULL
  FROM release_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id JOIN subscriptions s ON s.id = a.subscription_id
  UNION ALL
  SELECT 'magnet', j.id, j.status, j.priority, j.requested_at, j.started_at, j.finished_at, j.retry_after, j.error, j.attempt_count,
    a.subscription_id, s.name, a.content, a.title, NULL, NULL, NULL, NULL
  FROM magnet_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id JOIN subscriptions s ON s.id = a.subscription_id
  UNION ALL
  SELECT 'library', j.id, j.status, j.priority, j.requested_at, j.started_at, j.finished_at, j.retry_after, j.error, j.attempt_count,
    a.subscription_id, s.name, a.content, a.title, NULL, NULL, NULL, NULL
  FROM library_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id JOIN subscriptions s ON s.id = a.subscription_id
  UNION ALL
  SELECT 'download', j.id, j.status, j.priority, j.requested_at, j.started_at, j.finished_at, j.retry_after, j.error, j.attempt_count,
    a.subscription_id, s.name, a.content, a.title, NULL, NULL, NULL, a.download_progress
  FROM download_jobs j JOIN archive_entries a ON a.id = j.archive_entry_id JOIN subscriptions s ON s.id = a.subscription_id
  UNION ALL
  SELECT 'library_sync', j.id, j.status, j.priority, j.requested_at, j.started_at, j.finished_at, NULL, j.error, 0,
    NULL, NULL, NULL, NULL, j.progress_current, j.progress_total, j.progress_label, NULL
  FROM library_sync_jobs j`;

function taskStatus(row: Pick<TaskQueueRow, 'status' | 'retry_after'>) {
  return row.status === 'queued' && row.retry_after && Date.parse(row.retry_after) > Date.now() ? 'retrying' : row.status;
}

function historyLimitFrom(value: unknown, fallback = 50) {
  const limit = Number(value ?? fallback);
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : fallback;
}

async function taskProgressBySubscription() {
  const rows = await db.all<Record<string, number | string | null>>(`SELECT subscription_id, release_total, release_done, magnet_total, magnet_done, library_total, library_done
    FROM subscription_progress`);
  return new Map(rows.map((row) => [Number(row.subscription_id), row]));
}

function serializeTask(row: TaskQueueRow, progressBySubscription: Map<number, Record<string, number | string | null>>) {
  const kind = row.kind;
  const source = progressBySubscription.get(Number(row.subscription_id));
  let current = row.progress_current === null ? null : Number(row.progress_current);
  let total = row.progress_total === null ? null : Number(row.progress_total);
  let label = row.progress_label;
  if (source && (kind === 'release' || kind === 'magnet' || kind === 'library')) {
    current = Number(source[`${kind}_done`] ?? 0);
    total = Number(source[`${kind}_total`] ?? 0);
  }
  if (kind === 'download' && row.download_progress !== null) {
    const value = Number(row.download_progress);
    if (Number.isFinite(value)) { current = Math.round(value * 100); total = 100; label = `下载 ${current}%`; }
  }
  return {
    id: `${kind}-${row.task_id}`, kind, status: taskStatus(row), priority: Number(row.priority ?? 0),
    subscriptionId: row.subscription_id, subscriptionName: row.subscription_name, content: row.content, title: row.title,
    requestedAt: row.requested_at, startedAt: row.started_at, finishedAt: row.finished_at, retryAfter: row.retry_after,
    attemptCount: Number(row.attempt_count ?? 0), error: row.error,
    progress: current !== null || total !== null || label ? { current, total, label } : null
  };
}

async function getTaskOverview() {
  const [{ generatedAt, services }, activeRows, progressBySubscription, activeDownloads, integrations, failed] = await Promise.all([
    getSystemStatus(),
    db.all<TaskQueueRow>(`SELECT * FROM (${taskQueueUnion}) AS queue_tasks WHERE status IN ('queued', 'running')`),
    taskProgressBySubscription(),
    db.all<ActiveDownloadRow>(`SELECT a.id, a.subscription_id, s.name AS subscription_name, a.content, a.title, a.download_status, a.download_progress,
      a.download_queued_at, a.download_added_at, a.download_error FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
      WHERE a.download_status IN ('queued', 'running', 'added', 'waiting', 'downloading')`),
    getIntegrationStatuses(),
    db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM (${taskQueueUnion}) AS queue_tasks WHERE status = 'failed'`)
  ]);
  const active = activeRows.map((row) => serializeTask(row, progressBySubscription));
  for (const download of activeDownloads) {
    if (active.some((task) => task.kind === 'download' && task.content === download.content && task.subscriptionId === download.subscription_id)) continue;
    const numericProgress = download.download_progress === null ? null : Number(download.download_progress);
    const percent = numericProgress !== null && Number.isFinite(numericProgress) ? Math.round(numericProgress * 100) : null;
    const label = download.download_status === 'paused' ? 'qBittorrent 已暂停' : percent === null ? '等待 qBittorrent 开始下载' : `下载 ${percent}%`;
    active.push({ id: `download-state-${download.id}`, kind: 'download', status: 'running', priority: 0,
      subscriptionId: download.subscription_id, subscriptionName: download.subscription_name, content: download.content, title: download.title,
      requestedAt: download.download_queued_at ?? download.download_added_at ?? new Date().toISOString(), startedAt: download.download_added_at, finishedAt: null, retryAfter: null, attemptCount: 0,
      error: download.download_error, progress: percent === null ? { current: null, total: null, label } : { current: percent, total: 100, label } });
  }
  const statusOrder: Record<string, number> = { running: 0, queued: 1, retrying: 2 };
  active.sort((left, right) => (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9) || right.priority - left.priority || String(left.requestedAt ?? '').localeCompare(String(right.requestedAt ?? '')));
  return {
    generatedAt,
    summary: { servicesOnline: services.filter((service) => service.healthy).length, running: active.filter((task) => task.status === 'running').length, queued: active.filter((task) => task.status === 'queued').length, retrying: active.filter((task) => task.status === 'retrying').length, failed: Number(failed?.count ?? 0) },
    services,
    integrations: summarizeExternalIntegrations(integrations),
    active
  };
}

async function getTaskHistory(limit: number, offset = 0) {
  const [rows, progressBySubscription] = await Promise.all([
    db.all<TaskQueueRow>(`SELECT * FROM (${taskQueueUnion}) AS queue_tasks WHERE status IN ('completed', 'failed') ORDER BY finished_at DESC, task_id DESC LIMIT ? OFFSET ?`, [limit, offset]),
    taskProgressBySubscription()
  ]);
  const items = rows.map((row) => serializeTask(row, progressBySubscription));
  return { items, nextCursor: items.length === limit ? String(offset + items.length) : null };
}

app.get('/api/tasks/summary', async (request, reply) => privateJson(request, reply, await getTaskOverview().then(({ active: _active, ...summary }) => summary)));
app.get('/api/tasks/active', async (request, reply) => privateJson(request, reply, await getTaskOverview().then(({ generatedAt, active }) => ({ generatedAt, active }))));
app.get('/api/tasks/history', async (request, reply) => {
  const query = request.query as { limit?: string; cursor?: string };
  const offset = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
  return privateJson(request, reply, await getTaskHistory(historyLimitFrom(query.limit), offset));
});
app.get('/api/tasks', async (request, reply) => {
  const query = request.query as { historyLimit?: string };
  const [overview, history] = await Promise.all([getTaskOverview(), getTaskHistory(historyLimitFrom(query.historyLimit))]);
  return privateJson(request, reply, { ...overview, history: history.items });
});
app.get('/api/subscriptions', async (request, reply) => privateJson(request, reply, await listSubscriptions()));
app.post('/api/subscriptions/:id/archive-seen', async (request, reply) => {
  const id = Number((request.params as { id?: string }).id);
  const body = request.body as { scanAt?: unknown; addedCount?: unknown };
  const scanAt = typeof body?.scanAt === 'string' ? body.scanAt : '';
  const addedCount = Number(body?.addedCount);
  if (!Number.isSafeInteger(id) || id <= 0 || !scanAt || !Number.isSafeInteger(addedCount) || addedCount <= 0) {
    return reply.code(400).send({ error: '档案查看记录无效。' });
  }
  const current = await db.get<{ last_checked_at: string | null; last_scan_added_count: number; last_scan_seen_at: string | null }>(
    'SELECT last_checked_at, last_scan_added_count, last_scan_seen_at FROM subscriptions WHERE id = ?', [id]
  );
  if (!current) return reply.code(404).send({ error: '订阅不存在。' });
  if (current.last_checked_at !== scanAt || Number(current.last_scan_added_count) !== addedCount) return privateJson(request, reply, { seen: false });
  if (current.last_scan_seen_at === scanAt) return privateJson(request, reply, { seen: true });
  const updated = await db.run(`UPDATE subscriptions SET last_scan_seen_at = ?
    WHERE id = ? AND last_checked_at = ? AND last_scan_added_count = ?
      AND (last_scan_seen_at IS NULL OR last_scan_seen_at <> ?)`, [scanAt, id, scanAt, addedCount, scanAt]);
  if (updated.changes) emitLive('subscriptions');
  return privateJson(request, reply, { seen: Boolean(updated.changes) });
});

type PerformanceSummaryRow = { scope: string; metric: string; dimension: string; sample_count: number; duration_ms: number };
type ThroughputRow = { bucket_start: string; scope: string; sample_count: number };

const metricHoursByRange: Record<string, number> = { '24h': 24, '7d': 7 * 24 };

function metricRangeFrom(range: string | undefined) {
  return range && range in metricHoursByRange ? range : null;
}

async function getMetricsSummary(range: string) {
  const now = Date.now();
  const hours = metricHoursByRange[range];
  const rangeStart = new Date(now - hours * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const [summaryRows, runtimeRows] = await Promise.all([
    db.all<PerformanceSummaryRow>(`SELECT scope, metric, dimension, SUM(sample_count) AS sample_count, SUM(duration_ms) AS duration_ms
      FROM performance_metrics
      WHERE granularity = 'minute' AND bucket_start >= ?
      GROUP BY scope, metric, dimension`, [rangeStart]),
    getRuntimeMetrics()
  ]);
  const metric = (scope: string, name: string, dimension?: string) => summaryRows
    .filter((row) => row.scope === scope && row.metric === name && (dimension === undefined || row.dimension === dimension))
    .reduce((total, row) => ({ count: total.count + Number(row.sample_count), durationMs: total.durationMs + Number(row.duration_ms) }), { count: 0, durationMs: 0 });
  const jellyfinHit = metric('library', 'jellyfin_cache', 'hit').count;
  const jellyfinMiss = metric('library', 'jellyfin_cache', 'miss').count;
  const scopes = ['capture', 'release', 'magnet', 'library', 'download'];
  const runtime = new Map(runtimeRows.map((row) => [row.metric_key, row]));
  const numberMetric = (key: string) => {
    const value = runtime.get(key)?.numeric_value;
    return value === null || value === undefined ? null : Number(value);
  };
  return {
    range,
    generatedAt: new Date().toISOString(),
    jellyfinCache: { hit: jellyfinHit, miss: jellyfinMiss, hitRate: jellyfinHit + jellyfinMiss ? jellyfinHit / (jellyfinHit + jellyfinMiss) : null },
    workers: scopes.map((scope) => {
      const result = metric(scope, 'processed');
      return { scope, processed: result.count, averageDurationMs: result.count ? Math.round(result.durationMs / result.count) : null };
    }),
    retries: summaryRows.filter((row) => row.metric === 'retry').map((row) => ({ scope: row.scope, reason: row.dimension, count: Number(row.sample_count) })),
    chromiumRebuilds: summaryRows.filter((row) => row.metric === 'chromium_rebuild').map((row) => ({ scope: row.scope, reason: row.dimension, count: Number(row.sample_count) })),
    runtime: {
      containerMemoryBytes: numberMetric('container_memory_bytes'),
      apiRssBytes: numberMetric('api_rss_bytes'),
      runnerRssBytes: numberMetric('runner_rss_bytes'),
      engineState: runtime.get('engine_state')?.text_value ?? 'sleeping',
      engineLastStartedAt: runtime.get('engine_last_started_at')?.text_value || null,
      engineStartCount: numberMetric('engine_start_count') ?? 0,
      webExecutorRssBytes: numberMetric('web_executor_rss_bytes'),
      webExecutorState: runtime.get('web_executor_state')?.text_value ?? 'offline',
      librarySyncRssBytes: numberMetric('library_sync_rss_bytes'),
      librarySyncState: runtime.get('library_sync_state')?.text_value ?? 'offline',
      browser: {
        state: runtime.get('browser_state')?.text_value ?? 'unknown',
        activePages: numberMetric('browser_active_pages'),
        queuedPages: numberMetric('browser_queued_pages'),
        navigationCount: numberMetric('browser_navigation_count')
      },
      engineMemoryReclaim: {
        state: runtime.get('runner_reclaim_state')?.text_value ?? 'waiting',
        gcBeforeBytes: numberMetric('runner_gc_before_bytes'),
        gcAfterBytes: numberMetric('runner_gc_after_bytes')
      }
    }
  };
}

async function getMetricsTimeseries() {
  const throughput = await db.all<ThroughputRow>(`SELECT to_char(bucket_start, 'YYYY-MM-DD HH24:MI:00') AS bucket_start, scope, SUM(sample_count) AS sample_count
    FROM performance_metrics WHERE granularity = 'minute' AND metric = 'processed' AND bucket_start >= (now() AT TIME ZONE 'UTC') - INTERVAL '60 minutes'
    GROUP BY to_char(bucket_start, 'YYYY-MM-DD HH24:MI:00'), scope ORDER BY bucket_start ASC, scope ASC`);
  return { generatedAt: new Date().toISOString(), throughput: throughput.map((row) => ({ minute: `${row.bucket_start.replace(' ', 'T')}Z`, scope: row.scope, count: Number(row.sample_count) })) };
}

app.get('/api/metrics/summary', async (request, reply) => {
  const range = metricRangeFrom((request.query as { range?: string }).range);
  if (!range) return reply.code(400).send({ error: '指标时间范围无效。' });
  return privateJson(request, reply, await getMetricsSummary(range));
});
app.get('/api/metrics/timeseries', async (request, reply) => privateJson(request, reply, await getMetricsTimeseries()));
app.get('/api/metrics', async (request, reply) => {
  const range = metricRangeFrom((request.query as { range?: string }).range);
  if (!range) return reply.code(400).send({ error: '指标时间范围无效。' });
  const [summary, timeseries] = await Promise.all([getMetricsSummary(range), getMetricsTimeseries()]);
  return privateJson(request, reply, { ...summary, ...timeseries });
});

type RuntimeLogScope = 'system' | 'check' | 'release' | 'magnet' | 'download' | 'library';
type RuntimeLogRow = {
  id: number;
  level: 'info' | 'success' | 'error';
  source: 'system' | 'queue' | 'worker' | 'download' | 'library';
  subscription_id: number | null;
  subscription_name: string | null;
  subscription_url: string | null;
  job_id: number | null;
  message: string;
  created_at: string;
};

/**
 * Runtime logs predate the task centre and only store broad sources. Keep
 * those records compatible by assigning a stable service scope at read time.
 * New messages automatically follow the same rules without a data migration.
 */
function runtimeLogScope(log: Pick<RuntimeLogRow, 'source' | 'message'>): RuntimeLogScope {
  const message = log.message;
  if (log.source === 'library' || /Jellyfin|影视库/.test(message)) return 'library';
  if (log.source === 'download' || /qBittorrent|下载|做种/.test(message)) return 'download';
  if (/磁力|cilisousuo/i.test(message)) return 'magnet';
  if (/发行日期|详情页字段/.test(message)) return 'release';
  if (log.source === 'worker' || /检查|全量扫描|网页抓取/.test(message)) return 'check';
  if (log.source === 'queue') return 'check';
  return 'system';
}

app.get('/api/logs', async (request) => {
  const query = request.query as { limit?: string; scope?: string };
  const limitValue = Number(query.limit ?? 300);
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 1000) : 300;
  const scope = ['system', 'check', 'release', 'magnet', 'download', 'library'].includes(query.scope ?? '') ? query.scope as RuntimeLogScope : null;
  // Fetch the retained window when filtering so a busy service still receives
  // the requested number of its own messages rather than a thin slice of the
  // global feed.
  const rows = await db.all<RuntimeLogRow>(`SELECT l.*, s.name AS subscription_name, s.url AS subscription_url
    FROM runtime_logs l LEFT JOIN subscriptions s ON s.id = l.subscription_id
    ORDER BY l.id DESC LIMIT ?`, [scope ? 1000 : limit]);
  return rows.map((row) => ({ ...row, scope: runtimeLogScope(row) }))
    .filter((row) => !scope || row.scope === scope)
    .slice(0, limit);
});
}

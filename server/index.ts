import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { assertSafeUrl as validateSafeUrl } from './url-safety.js';
import { appendRuntimeLog, configureDatabase, databaseConfigurationError, databaseConfigurationSource, db, getIntegrationStatuses, getJellyfinSettings, getOutboundProxyUrl, getQbittorrentSettings, getRuntimeMetrics, getRuntimeSettings, getSetting, getSubscription, isDatabaseConfigured, JOB_PRIORITY, maintainPerformanceMetrics, queueDownloadJob, queueJob, queueLibrarySyncJob, queueMagnetJob, queueReleaseJob, rebuildSubscriptionProgress, refreshSettings, reportIntegrationStatus, reportRuntimeMetrics, reportWorkerHeartbeat, setRuntimeSettings, setSetting, type IntegrationService, type Subscription } from './db.js';
import { assertQbittorrentConfig, normalizeQbittorrentUrl, testQbittorrentConnection } from './qbittorrent.js';
import { assertJellyfinConfig, listJellyfinLibraries, normalizeJellyfinUrl, testJellyfinConnection } from './jellyfin.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';
import { clearJellyfinMediaIndex } from './jellyfin-cache.js';
import { authenticate, clearSessionCookie, configurePassword, createSession, sessionCookie, statusFor, validatePassword } from './auth.js';
import { getInspectionRules, inspectionRulesJson, normalizeInspectionRules } from './inspection-rules.js';
import { ExecutionEngineController } from './engine-controller.js';
import { EngineWakeScheduler } from './engine-wake-scheduler.js';
import { createTestNotification, deliverNotification, getNotificationSettings, normalizeNotificationSettings, publicNotificationSettings, saveNotificationSettings, type NotificationSettingsPayload } from './notifications.js';

// Docker creates a random private token in its entry script. Keep a fixed,
// loopback-only fallback for `npm run dev`, so the on-demand child can still
// publish task and SSE events without a separate supervisor.
if (!process.env.WORKER_EVENT_TOKEN && process.env.NODE_ENV !== 'production') process.env.WORKER_EVENT_TOKEN = 'page-watch-dev-runner';

const app = Fastify({ logger: { level: 'warn' } });
await app.register(fastifyCompress, { encodings: ['br', 'gzip'], threshold: 1024 });
const port = Number(process.env.PORT ?? 3030);
const engineController = new ExecutionEngineController();
const engineWakeScheduler = new EngineWakeScheduler(engineController);

app.addHook('onResponse', (request, reply, done) => {
  const path = request.url.split('?')[0];
  const queuesWork = request.method === 'POST' && (
    /^\/api\/subscriptions\/\d+\/(run|full-scan|release-backfill|magnet-backfill|download-backfill)$/.test(path)
    || /^\/api\/archive\/\d+\/(magnet-retry|download)$/.test(path)
    || path === '/api/settings/jellyfin/sync'
  );
  if (queuesWork && reply.statusCode < 400) void engineWakeScheduler.wake('网页操作已加入队列').catch((error) => app.log.warn(`Unable to wake execution engine: ${error instanceof Error ? error.message : String(error)}`));
  done();
});

engineController.onChange((snapshot) => {
  void reportRuntimeMetrics([
    { key: 'engine_state', text: snapshot.state },
    { key: 'engine_last_started_at', text: snapshot.lastStartedAt ?? '' },
    { key: 'engine_start_count', value: snapshot.starts },
    { key: 'runner_rss_bytes', value: snapshot.state === 'sleeping' || snapshot.state === 'error' ? 0 : null }
  ]).catch(() => undefined);
  emitLive('tasks');
  emitLive('services');
  emitLive('metrics');
});
const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
const loginWindowMs = 10 * 60_000;
const loginLimit = 7;
type LiveChannel = 'archive' | 'logs' | 'subscriptions' | 'tasks' | 'task-summary' | 'task-active' | 'services' | 'metrics';
const liveChannels = new Set<LiveChannel>(['archive', 'logs', 'subscriptions', 'tasks', 'task-summary', 'task-active', 'services', 'metrics']);
type LiveClient = {
  response: ServerResponse;
  topics: Set<LiveChannel>;
  archiveSubscriptionIds: Set<number>;
  needsSnapshot: boolean;
  blockedAt: number | null;
};
const liveClients = new Set<LiveClient>();
const pendingLiveEvents = new Map<string, { channel: LiveChannel; subscriptionId?: number }>();
const liveVersions = new Map<LiveChannel, number>();
let liveFlushTimer: NodeJS.Timeout | null = null;
const archiveVersions = new Map<number, string>();
let subscriptionsVersion = '';
let tasksVersion = '';
let liveInitialized = false;
let latestLogId = 0;
let lastSseKeepAliveAt = 0;
// DNS may be intentionally delegated to the configured outbound proxy. Keep
// API-side validation equally strict about private addresses without rejecting
// a hostname that is only resolvable from the proxy network.
async function assertSafeUrl(raw: string) {
  return validateSafeUrl(raw, { allowUnresolvedViaProxy: true, hasOutboundProxy: Boolean(getOutboundProxyUrl()) });
}

function authPath(url: string) {
  return url.split('?')[0];
}

/** Authenticated API payloads are revalidated, never shared. The lightweight
 * ETag lets an inactive view keep its in-memory snapshot without re-downloading
 * identical task or subscription documents after it regains focus. */
function privateJson(request: { headers: Record<string, string | string[] | undefined> }, reply: { header: (name: string, value: string) => unknown; code: (status: number) => { send: (value?: unknown) => unknown }; send: (value: unknown) => unknown }, payload: unknown) {
  // `generatedAt` is intentionally informational. Excluding it from the
  // validator makes conditional GET useful when the underlying read model is
  // unchanged instead of defeating caching once per request.
  const cachePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== 'generatedAt'))
    : payload;
  const encoded = JSON.stringify(cachePayload);
  const etag = `\"${createHash('sha1').update(encoded).digest('base64url')}\"`;
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
  reply.header('Vary', 'Accept-Encoding, Cookie');
  reply.header('ETag', etag);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.send(payload);
}

function loginAllowed(ip: string) {
  const record = loginFailures.get(ip);
  if (!record) return true;
  if (record.lockedUntil > Date.now()) return false;
  if (Date.now() - record.firstAt > loginWindowMs) { loginFailures.delete(ip); return true; }
  return true;
}

function recordFailedLogin(ip: string) {
  const current = loginFailures.get(ip);
  const now = Date.now();
  const next = !current || now - current.firstAt > loginWindowMs ? { count: 1, firstAt: now, lockedUntil: 0 } : { ...current, count: current.count + 1 };
  if (next.count >= loginLimit) next.lockedUntil = now + loginWindowMs;
  loginFailures.set(ip, next);
}

function writeSse(client: LiveClient, event: string, data?: unknown) {
  if (client.response.writableEnded || client.response.destroyed) { liveClients.delete(client); return; }
  if (client.response.writableLength > 64 * 1024) {
    client.blockedAt ??= Date.now();
    if (Date.now() - client.blockedAt >= 15_000) {
      liveClients.delete(client);
      client.response.destroy();
    }
    return;
  }
  const payload = `event: ${event}\n${data === undefined ? '' : `data: ${JSON.stringify(data)}\n`}\n`;
  const accepted = client.response.write(payload);
  if (accepted) client.blockedAt = null;
  else client.blockedAt ??= Date.now();
}

function clientWatches(client: LiveClient, channel: LiveChannel, subscriptionId?: number) {
  if (!client.topics.has(channel)) return false;
  return channel !== 'archive' || (subscriptionId !== undefined && client.archiveSubscriptionIds.has(subscriptionId));
}

function expandedLiveChannels(channel: LiveChannel) {
  // Keep the original `tasks` event for older clients, while newer pages can
  // invalidate only the compact summary or active queue they actually render.
  return channel === 'tasks' ? ['tasks', 'task-summary', 'task-active'] as LiveChannel[] : [channel];
}

function queueLive(channel: LiveChannel, subscriptionId?: number) {
  const key = `${channel}:${subscriptionId ?? ''}`;
  pendingLiveEvents.set(key, { channel, subscriptionId });
  if (!liveFlushTimer) {
    liveFlushTimer = setTimeout(() => {
      liveFlushTimer = null;
      for (const event of pendingLiveEvents.values()) {
        const version = (liveVersions.get(event.channel) ?? 0) + 1;
        liveVersions.set(event.channel, version);
        for (const client of liveClients) {
          if (!clientWatches(client, event.channel, event.subscriptionId)) continue;
          writeSse(client, event.channel, event.channel === 'archive'
            ? { subscriptionId: event.subscriptionId, version }
            : { version });
        }
      }
      pendingLiveEvents.clear();
    }, 250);
    liveFlushTimer.unref();
  }
}

function emitLive(channel: LiveChannel, subscriptionId?: number) {
  for (const item of expandedLiveChannels(channel)) queueLive(item, subscriptionId);
}

async function pollLiveChanges() {
  if (!liveClients.size) return;
  const watchesLogs = [...liveClients].some((client) => client.topics.has('logs'));
  const watchesArchive = [...liveClients].some((client) => client.topics.has('archive'));
  const watchesSubscriptions = [...liveClients].some((client) => client.topics.has('subscriptions'));
  const watchesTasks = [...liveClients].some((client) => client.topics.has('tasks') || client.topics.has('task-summary') || client.topics.has('task-active'));
  const [latestLog, versions, subscriptionVersion, taskVersion] = await Promise.all([
    watchesLogs ? db.get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM runtime_logs') : Promise.resolve(undefined),
    watchesArchive ? db.all<{ subscription_id: number; version: string }>(`SELECT subscription_id, MAX(updated_at) AS version
      FROM archive_entries GROUP BY subscription_id`) : Promise.resolve([]),
    watchesSubscriptions ? db.get<{ version: string }>(`SELECT SHA2(CONCAT(COALESCE((SELECT MAX(updated_at) FROM subscriptions), ''), ':', COALESCE((SELECT MAX(updated_at) FROM archive_entries), ''), ':', COALESCE((SELECT MAX(requested_at) FROM jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM release_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM magnet_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM library_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM library_sync_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM download_jobs WHERE status IN ('queued','running')), '')), 256) AS version`) : Promise.resolve(undefined),
    watchesTasks ? db.get<{ version: string }>(`SELECT SHA2(CONCAT(
      COALESCE((SELECT MAX(requested_at) FROM jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM release_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM release_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM release_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM release_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM magnet_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM magnet_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM magnet_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM magnet_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM library_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM library_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM library_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM library_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM library_sync_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM library_sync_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM library_sync_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM download_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM download_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM download_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM download_jobs), '')), 256) AS version`) : Promise.resolve(undefined)
  ]);
  const nextLogId = Number(latestLog?.id ?? 0);
  const nextVersions = new Map(versions.map((row) => [row.subscription_id, row.version]));
  const hadPreviousSnapshot = liveInitialized;
  if (!liveInitialized) {
    latestLogId = nextLogId;
    archiveVersions.clear();
    for (const [subscriptionId, version] of nextVersions) archiveVersions.set(subscriptionId, version);
    subscriptionsVersion = subscriptionVersion?.version ?? '';
    tasksVersion = taskVersion?.version ?? '';
    liveInitialized = true;
  }
  for (const client of liveClients) {
    if (!client.needsSnapshot) continue;
    client.needsSnapshot = false;
    for (const topic of client.topics) {
      if (topic === 'archive') {
        for (const subscriptionId of client.archiveSubscriptionIds) writeSse(client, 'archive', { subscriptionId, version: liveVersions.get('archive') ?? 0 });
      } else if (topic === 'logs') {
        writeSse(client, 'logs', { latestId: nextLogId, version: liveVersions.get('logs') ?? 0 });
      } else if (topic === 'subscriptions') {
        writeSse(client, topic, { version: subscriptionsVersion });
      } else if (topic === 'tasks' || topic === 'task-summary' || topic === 'task-active') {
        writeSse(client, topic, { version: tasksVersion });
      } else {
        writeSse(client, topic, { version: liveVersions.get(topic) ?? 0 });
      }
    }
  }
  if (hadPreviousSnapshot) {
    if (nextLogId > latestLogId) {
      latestLogId = nextLogId;
      emitLive('logs');
    }
    for (const [subscriptionId, version] of nextVersions) {
      if (archiveVersions.get(subscriptionId) === version) continue;
      archiveVersions.set(subscriptionId, version);
      emitLive('archive', subscriptionId);
    }
    if (subscriptionVersion && subscriptionVersion.version !== subscriptionsVersion) {
      subscriptionsVersion = subscriptionVersion.version;
      emitLive('subscriptions');
    }
    if (taskVersion && taskVersion.version !== tasksVersion) {
      tasksVersion = taskVersion.version;
      emitLive('tasks');
    }
  }
  if (Date.now() - lastSseKeepAliveAt >= 20_000) {
    lastSseKeepAliveAt = Date.now();
    for (const client of liveClients) {
      if (!client.response.writableEnded && !client.response.destroyed) client.response.write(': keepalive\n\n');
    }
  }
}

// Direct worker notifications are the normal path. This low-frequency fallback
// keeps separately launched development workers compatible without DB churn.
const livePollTimer = setInterval(() => {
  if (isDatabaseConfigured()) void pollLiveChanges().catch((error) => app.log.warn(`Live update poll failed: ${error instanceof Error ? error.message : String(error)}`));
}, 30_000);
livePollTimer.unref();

app.addHook('onRequest', async (request, reply) => {
  const requestPath = authPath(request.url);
  if (!requestPath.startsWith('/api/') || requestPath === '/api/health' || requestPath === '/api/ready' || requestPath.startsWith('/api/auth/') || requestPath.startsWith('/api/internal/events')) return;
  if (!isDatabaseConfigured()) {
    if (requestPath === '/api/setup/database') return;
    return reply.code(503).send({ error: '数据库尚未配置。请先完成 MySQL 安装引导。' });
  }
  const status = await statusFor(request.headers.cookie);
  // The first-run sequence is database connection, then access password.
  // Keep the database endpoint retryable until that password exists so a
  // failed initialization never traps the setup page behind authentication.
  if (requestPath === '/api/setup/database' && !status.configured) return;
  if (!status.configured) return reply.code(503).send({ error: '请先在网页中设置访问密码，再使用 Page Watch。' });
  if (!status.authenticated) return reply.code(401).send({ error: '登录已失效，请重新登录。' });
});

type SubscriptionPayload = {
  name: string;
  url: string;
  selector: string;
  renderMode?: 'static' | 'dynamic';
  contentSource?: 'text' | 'attribute';
  attributeName?: string;
  matchPattern?: string;
  titleSelector?: string;
  titleContentSource?: 'text' | 'attribute';
  titleAttributeName?: string;
  titleMatchPattern?: string;
  resultMode?: 'first' | 'all';
  intervalMinutes?: number;
  scheduleType?: 'hourly' | 'daily' | 'weekly';
  scheduleIntervalHours?: number;
  scheduleTime?: string;
  scheduleWeekday?: number;
  isActive?: boolean;
  paginationSelector?: string;
  paginationParameter?: string;
  paginationMatchPattern?: string;
};

type SubscriptionPresetPayload = Omit<SubscriptionPayload, 'url'> & { description?: string };
type MissavRulesPayload = { presetId?: number; preset?: SubscriptionPresetPayload; inspectionRules?: unknown };
type QbittorrentSettingsPayload = {
  enabled?: boolean;
  url?: string;
  authMode?: 'api_key' | 'password';
  apiKey?: string;
  clearApiKey?: boolean;
  username?: string;
  password?: string;
  clearPassword?: boolean;
  category?: string;
  savePath?: string;
  tags?: string;
  autoDownload?: boolean;
  autoDownloadMinSizeMb?: number;
  stopAfterDownload?: boolean;
};

type JellyfinSettingsPayload = {
  enabled?: boolean;
  url?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  libraryIds?: string[];
  syncIntervalMinutes?: number;
  skipMagnetWhenAvailable?: boolean;
};

function normalizePaginationPayload(payload: Pick<SubscriptionPayload, 'paginationSelector' | 'paginationParameter' | 'paginationMatchPattern'>) {
  const selector = payload.paginationSelector?.trim() || null;
  const parameter = payload.paginationParameter?.trim() || 'page';
  const matchPattern = selector ? payload.paginationMatchPattern?.trim() || null : null;
  if (parameter.length > 64 || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(parameter)) throw new Error('分页参数名格式无效。');
  if (matchPattern && matchPattern.length > 480) throw new Error('分页页数匹配规则不能超过 480 个字符。');
  if (matchPattern) {
    try { new RegExp(matchPattern, 'i'); } catch { throw new Error('分页页数匹配规则不是有效的正则表达式。'); }
  }
  return { paginationSelector: selector, paginationParameter: parameter, paginationMatchPattern: matchPattern };
}

function normalizePresetPayload(payload: SubscriptionPresetPayload) {
  const name = payload.name?.trim();
  const description = payload.description?.trim() ?? '';
  const selector = payload.selector?.trim();
  const interval = Number(payload.intervalMinutes ?? 60);
  const renderMode = payload.renderMode === 'dynamic' ? 'dynamic' : 'static';
  const contentSource = payload.contentSource === 'attribute' ? 'attribute' : 'text';
  const attributeName = payload.attributeName?.trim() || null;
  const matchPattern = payload.matchPattern?.trim() || null;
  const titleSelector = payload.titleSelector?.trim() || null;
  const titleContentSource = payload.titleContentSource === 'attribute' ? 'attribute' : 'text';
  const titleAttributeName = titleSelector ? payload.titleAttributeName?.trim() || null : null;
  const titleMatchPattern = titleSelector ? payload.titleMatchPattern?.trim() || null : null;
  const resultMode = payload.resultMode === 'all' ? 'all' : 'first';
  const pagination = normalizePaginationPayload(payload);
  if (!name || name.length > 80) throw new Error('请填写不超过 80 个字符的规则名称。');
  if (description.length > 200) throw new Error('规则说明不能超过 200 个字符。');
  if (!selector) throw new Error('请填写 CSS 选择器。');
  if (contentSource === 'attribute' && !attributeName) throw new Error('请填写要提取的属性名。');
  if (attributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(attributeName)) throw new Error('属性名格式无效。');
  if (matchPattern && matchPattern.length > 240) throw new Error('内容匹配规则不能超过 240 个字符。');
  if (matchPattern) {
    try { new RegExp(matchPattern, 'i'); } catch { throw new Error('内容匹配规则不是有效的正则表达式。'); }
  }
  if (titleSelector && titleContentSource === 'attribute' && !titleAttributeName) throw new Error('请填写标题要提取的属性名。');
  if (titleAttributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(titleAttributeName)) throw new Error('标题属性名格式无效。');
  if (titleMatchPattern && titleMatchPattern.length > 240) throw new Error('标题匹配规则不能超过 240 个字符。');
  if (titleMatchPattern) {
    try { new RegExp(titleMatchPattern, 'i'); } catch { throw new Error('标题匹配规则不是有效的正则表达式。'); }
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 10080) throw new Error('检查间隔需在 1 到 10080 分钟之间。');
  return { name, description, selector, renderMode, contentSource, attributeName, matchPattern, titleSelector, titleContentSource, titleAttributeName, titleMatchPattern, resultMode, interval, ...pagination, isActive: payload.isActive === false ? 0 : 1 };
}

async function normalizePayload(payload: SubscriptionPayload) {
  const name = payload.name?.trim();
  const selector = payload.selector?.trim();
  const interval = Number(payload.intervalMinutes ?? 60);
  const scheduleType = payload.scheduleType === 'daily' || payload.scheduleType === 'weekly' ? payload.scheduleType : 'hourly';
  const scheduleIntervalHours = Number(payload.scheduleIntervalHours ?? Math.max(1, Math.round(interval / 60)));
  const scheduleTime = payload.scheduleTime ?? '09:00';
  const scheduleWeekday = Number(payload.scheduleWeekday ?? 1);
  const renderMode = payload.renderMode === 'dynamic' ? 'dynamic' : 'static';
  const contentSource = payload.contentSource === 'attribute' ? 'attribute' : 'text';
  const attributeName = payload.attributeName?.trim() || null;
  const matchPattern = payload.matchPattern?.trim() || null;
  const titleSelector = payload.titleSelector?.trim() || null;
  const titleContentSource = payload.titleContentSource === 'attribute' ? 'attribute' : 'text';
  const titleAttributeName = titleSelector ? payload.titleAttributeName?.trim() || null : null;
  const titleMatchPattern = titleSelector ? payload.titleMatchPattern?.trim() || null : null;
  const resultMode = payload.resultMode === 'all' ? 'all' : 'first';
  const pagination = normalizePaginationPayload(payload);
  if (!name) throw new Error('请填写订阅名称。');
  if (!selector) throw new Error('请先选择检查规则。');
  if (contentSource === 'attribute' && !attributeName) throw new Error('请填写要提取的属性名。');
  if (attributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(attributeName)) throw new Error('属性名格式无效。');
  if (matchPattern && matchPattern.length > 240) throw new Error('内容匹配规则不能超过 240 个字符。');
  if (matchPattern) {
    try { new RegExp(matchPattern, 'i'); } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`内容匹配规则不是有效的正则表达式：${detail}`);
    }
  }
  if (titleSelector && titleContentSource === 'attribute' && !titleAttributeName) throw new Error('请填写标题要提取的属性名。');
  if (titleAttributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(titleAttributeName)) throw new Error('标题属性名格式无效。');
  if (titleMatchPattern && titleMatchPattern.length > 240) throw new Error('标题匹配规则不能超过 240 个字符。');
  if (titleMatchPattern) {
    try { new RegExp(titleMatchPattern, 'i'); } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`标题匹配规则不是有效的正则表达式：${detail}`);
    }
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 10080) throw new Error('检查间隔需在 1 到 10080 分钟之间。');
  if (!Number.isInteger(scheduleIntervalHours) || scheduleIntervalHours < 1 || scheduleIntervalHours > 168) throw new Error('按小时检查需设置为 1 到 168 小时。');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new Error('检查时间需使用 HH:MM 格式。');
  if (!Number.isInteger(scheduleWeekday) || scheduleWeekday < 0 || scheduleWeekday > 6) throw new Error('请选择有效的每周检查日期。');
  const url = (await assertSafeUrl(payload.url)).toString();
  return { name, url, selector, interval: scheduleType === 'hourly' ? scheduleIntervalHours * 60 : 1440, scheduleType, scheduleIntervalHours, scheduleTime, scheduleWeekday, renderMode, contentSource, attributeName, matchPattern, titleSelector, titleContentSource, titleAttributeName, titleMatchPattern, resultMode, ...pagination, isActive: payload.isActive === false ? 0 : 1 };
}

async function listSubscriptions() {
  return db.all(`SELECT s.*,
    COALESCE(p.archive_total, 0) AS archive_count,
    COALESCE(p.jellyfin_available, 0) AS jellyfin_available_count,
    JSON_OBJECT(
      'check', JSON_OBJECT('done', 0, 'total', (SELECT COUNT(*) FROM jobs j WHERE j.subscription_id = s.id AND j.status IN ('queued','running'))),
      'release', JSON_OBJECT('done', COALESCE(p.release_done, 0), 'total', COALESCE(p.release_total, 0)),
      'magnet', JSON_OBJECT('done', COALESCE(p.magnet_done, 0), 'total', COALESCE(p.magnet_total, 0)),
      'library', JSON_OBJECT('done', COALESCE(p.library_done, 0), 'total', COALESCE(p.library_total, 0)),
      'download', JSON_OBJECT('done', COALESCE(p.download_done, 0), 'total', COALESCE(p.download_total, 0))
    ) AS queue_summary,
    CASE
      WHEN s.pagination_selector IS NOT NULL
        AND s.initial_scan_completed = 0
        AND (s.initial_scan_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM jobs j WHERE j.subscription_id = s.id AND j.status IN ('queued', 'running')))
      THEN 1 ELSE NULL
    END AS full_scan_active
    FROM subscriptions s LEFT JOIN subscription_progress p ON p.subscription_id = s.id ORDER BY s.updated_at DESC, s.id DESC`);
}

app.get('/api/health', async () => ({ ok: true }));
app.post('/api/internal/events', async (request, reply) => {
  const token = process.env.WORKER_EVENT_TOKEN;
  if (!token || request.headers['x-page-watch-worker-token'] !== token) return reply.code(403).send({ error: '内部事件令牌无效。' });
  const body = request.body as { channel?: unknown; subscriptionId?: unknown };
  if (typeof body.channel !== 'string' || !liveChannels.has(body.channel as LiveChannel)) return reply.code(400).send({ error: '内部事件类型无效。' });
  const channel = body.channel as LiveChannel;
  const subscriptionId = Number(body.subscriptionId);
  if (channel === 'archive' && (!Number.isInteger(subscriptionId) || subscriptionId < 1)) return reply.code(400).send({ error: '归档事件缺少订阅标识。' });
  emitLive(channel, channel === 'archive' ? subscriptionId : undefined);
  return { ok: true };
});
app.get('/api/events', async (request, reply) => {
  const query = request.query as { channel?: string; topics?: string; subscriptionId?: string };
  const legacyChannel = query.channel && liveChannels.has(query.channel as LiveChannel) ? query.channel as LiveChannel : null;
  const requestedTopics = (query.topics ?? '').split(',').map((item) => item.trim()).filter((item): item is LiveChannel => liveChannels.has(item as LiveChannel));
  const topics = new Set<LiveChannel>(legacyChannel ? [legacyChannel] : requestedTopics);
  const archiveIds = (query.subscriptionId ?? '').split(',').map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
  if (!topics.size || (topics.has('archive') && !archiveIds.length)) {
    return reply.code(400).send({ error: '实时订阅参数无效。' });
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // Never compress SSE: compressed streams can be buffered by a reverse
    // proxy and make otherwise tiny state changes look delayed.
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const client: LiveClient = { response: reply.raw, topics, archiveSubscriptionIds: new Set(archiveIds), needsSnapshot: true, blockedAt: null };
  liveClients.add(client);
  reply.raw.write('retry: 4000\n\n');
  writeSse(client, 'ready');
  request.raw.once('close', () => liveClients.delete(client));
});
app.get('/api/auth/status', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!isDatabaseConfigured()) return { setupRequired: false, authenticated: false, databaseSetupRequired: true };
  const status = await statusFor(request.headers.cookie);
  return { setupRequired: !status.configured, authenticated: status.authenticated, databaseSetupRequired: false };
});
app.get('/api/setup/database', async () => ({ configured: isDatabaseConfigured(), source: databaseConfigurationSource(), error: databaseConfigurationError() }));
app.post('/api/setup/database', async (request, reply) => {
  try {
    await configureDatabase(request.body as Parameters<typeof configureDatabase>[0]);
    startOperationalServices();
    return reply.code(201).send({ configured: true });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'MySQL 连接或初始化失败。' });
  }
});
app.post('/api/auth/setup', async (request, reply) => {
  try {
    const password = (request.body as { password?: unknown }).password;
    validatePassword(password);
    await configurePassword(password);
    // External services are optional. Mark only brand-new installations for
    // the one-time guide; upgrades keep their established workflow intact.
    await setSetting('integration_onboarding_pending', '1');
    reply.header('Set-Cookie', sessionCookie(await createSession()));
    return reply.code(201).send({ authenticated: true });
  } catch (error) {
    return reply.code(error instanceof Error && error.message.includes('已设置') ? 409 : 400).send({ error: error instanceof Error ? error.message : '无法设置访问密码。' });
  }
});
app.post('/api/auth/login', async (request, reply) => {
  const ip = request.ip;
  if (!loginAllowed(ip)) return reply.code(429).send({ error: '登录尝试过于频繁，请 10 分钟后再试。' });
  const password = (request.body as { password?: unknown }).password;
  if (typeof password !== 'string' || !await authenticate(password)) {
    recordFailedLogin(ip);
    return reply.code(401).send({ error: '访问密码不正确。' });
  }
  loginFailures.delete(ip);
  reply.header('Set-Cookie', sessionCookie(await createSession()));
  return { authenticated: true };
});
app.post('/api/auth/logout', async (_request, reply) => {
  reply.header('Set-Cookie', clearSessionCookie());
  return reply.code(204).send();
});

// The guide deliberately reports configuration only. It never probes external
// services: a NAS may be offline during installation and Page Watch remains
// fully usable for subscriptions, archives and rules without either service.
app.get('/api/setup/integrations', async () => {
  const jellyfin = getJellyfinSettings();
  const qbittorrent = getQbittorrentSettings();
  return {
    pending: getSetting('integration_onboarding_pending') === '1',
    jellyfin: {
      enabled: jellyfin.enabled,
      configured: Boolean(jellyfin.url && jellyfin.apiKey && jellyfin.libraryIds.length)
    },
    qbittorrent: {
      enabled: qbittorrent.enabled,
      configured: Boolean(qbittorrent.url && (qbittorrent.authMode === 'api_key' ? qbittorrent.apiKey : qbittorrent.username && qbittorrent.password))
    }
  };
});
app.post('/api/setup/integrations/complete', async () => {
  await setSetting('integration_onboarding_pending', '0');
  return { completed: true };
});
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
      WHERE a.download_status IN ('queued', 'running', 'added', 'waiting', 'downloading', 'paused')`),
    getIntegrationStatuses(),
    db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM (${taskQueueUnion}) AS queue_tasks WHERE status = 'failed'`)
  ]);
  const active = activeRows.map((row) => serializeTask(row, progressBySubscription));
  for (const download of activeDownloads) {
    if (active.some((task) => task.kind === 'download' && task.content === download.content && task.subscriptionId === download.subscription_id)) continue;
    const numericProgress = download.download_progress === null ? null : Number(download.download_progress);
    const percent = numericProgress !== null && Number.isFinite(numericProgress) ? Math.round(numericProgress * 100) : null;
    const label = download.download_status === 'paused' ? 'qBittorrent 已暂停' : percent === null ? '等待 qBittorrent 开始下载' : `下载 ${percent}%`;
    active.push({ id: `download-state-${download.id}`, kind: 'download', status: download.download_status === 'paused' ? 'queued' : 'running', priority: 0,
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

type PerformanceSummaryRow = { scope: string; metric: string; dimension: string; sample_count: number; duration_ms: number };
type ThroughputRow = { bucket_start: string; scope: string; sample_count: number };

const metricHoursByRange: Record<string, number> = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24, '180d': 180 * 24 };

function metricRangeFrom(range: string | undefined) {
  return range && range in metricHoursByRange ? range : null;
}

async function getMetricsSummary(range: string) {
  const now = Date.now();
  const hours = metricHoursByRange[range];
  const rangeStart = new Date(now - hours * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const minuteStart = new Date(Math.max(now - 30 * 24 * 60 * 60_000, now - hours * 60 * 60_000)).toISOString().slice(0, 19).replace('T', ' ');
  const [summaryRows, runtimeRows] = await Promise.all([
    db.all<PerformanceSummaryRow>(`SELECT scope, metric, dimension, SUM(sample_count) AS sample_count, SUM(duration_ms) AS duration_ms
      FROM performance_metrics
      WHERE (granularity = 'hour' AND bucket_start >= ?) OR (granularity = 'minute' AND bucket_start >= ?)
      GROUP BY scope, metric, dimension`, [rangeStart, minuteStart]),
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
  const throughput = await db.all<ThroughputRow>(`SELECT DATE_FORMAT(bucket_start, '%Y-%m-%d %H:%i:00') AS bucket_start, scope, SUM(sample_count) AS sample_count
    FROM performance_metrics WHERE granularity = 'minute' AND metric = 'processed' AND bucket_start >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 MINUTE)
    GROUP BY DATE_FORMAT(bucket_start, '%Y-%m-%d %H:%i:00'), scope ORDER BY bucket_start ASC, scope ASC`);
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
app.get('/api/subscription-presets', async () => await db.all('SELECT * FROM subscription_presets ORDER BY updated_at DESC, id DESC'));
app.post('/api/subscription-presets', async (request, reply) => {
  try {
    const values = normalizePresetPayload(request.body as SubscriptionPresetPayload);
    const now = new Date().toISOString();
    const result = await db.run(`INSERT INTO subscription_presets (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.name, values.description, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.isActive, now, now]);
    return reply.code(201).send(await db.get('SELECT * FROM subscription_presets WHERE id = ?', [result.lastInsertRowid]));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建规则。' }); }
});
app.put('/api/subscription-presets/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!Number.isInteger(id) || !await db.get('SELECT id FROM subscription_presets WHERE id = ?', [id])) return reply.code(404).send({ error: '规则不存在。' });
  try {
    const values = normalizePresetPayload(request.body as SubscriptionPresetPayload);
    await db.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, is_active=?, updated_at=? WHERE id=?`,
      [values.name, values.description, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.isActive, new Date().toISOString(), id]);
    return await db.get('SELECT * FROM subscription_presets WHERE id = ?', [id]);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存规则。' }); }
});
app.delete('/api/subscription-presets/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  await db.run('DELETE FROM subscription_presets WHERE id = ?', [id]);
  return reply.code(204).send();
});
app.get('/api/inspection-rules', async () => getInspectionRules());
app.put('/api/inspection-rules', async (request, reply) => {
  try {
    const rules = normalizeInspectionRules(request.body);
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('inspection_rules', ?, ?)
        ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [inspectionRulesJson(rules), now]);
      if (!rules.releaseDate.enabled) {
        await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE status = 'queued'", [now]);
        await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE release_status = 'pending'", [now]);
      }
      if (!rules.magnet.enabled) {
        await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE status = 'queued'", [now]);
        await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE magnet_status = 'pending'", [now]);
      }
    });
    await setSetting('inspection_rules', inspectionRulesJson(rules));
    await appendRuntimeLog({ level: 'success', source: 'system', message: '检查规则已更新；后续归档会按新规则执行。' });
    return rules;
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '检查规则无法保存。' }); }
});
app.put('/api/rules/missav', async (request, reply) => {
  try {
    const payload = request.body as MissavRulesPayload;
    // Validate both documents before opening the write transaction. This keeps
    // malformed companion rules from ever partially updating the preset.
    const preset = normalizePresetPayload(payload.preset ?? {} as SubscriptionPresetPayload);
    const rules = normalizeInspectionRules(payload.inspectionRules);
    const requestedId = Number(payload.presetId);
    const now = new Date().toISOString();
    const presetId = await db.transaction(async (tx) => {
      const existing = Number.isInteger(requestedId) && requestedId > 0
        ? await tx.get<{ id: number }>('SELECT id FROM subscription_presets WHERE id = ?', [requestedId])
        : await tx.get<{ id: number }>("SELECT id FROM subscription_presets WHERE name = 'MissAV 番号列表' ORDER BY id ASC LIMIT 1");
      let id: number;
      if (existing) {
        id = existing.id;
        await tx.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, is_active=?, updated_at=? WHERE id=?`,
          [preset.name, preset.description, preset.selector, preset.renderMode, preset.contentSource, preset.attributeName, preset.matchPattern, preset.titleSelector, preset.titleContentSource, preset.titleAttributeName, preset.titleMatchPattern, preset.resultMode, preset.interval, preset.paginationSelector, preset.paginationParameter, preset.paginationMatchPattern, preset.isActive, now, id]);
      } else {
        const inserted = await tx.run(`INSERT INTO subscription_presets (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [preset.name, preset.description, preset.selector, preset.renderMode, preset.contentSource, preset.attributeName, preset.matchPattern, preset.titleSelector, preset.titleContentSource, preset.titleAttributeName, preset.titleMatchPattern, preset.resultMode, preset.interval, preset.paginationSelector, preset.paginationParameter, preset.paginationMatchPattern, preset.isActive, now, now]);
        id = inserted.lastInsertRowid;
      }
      await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('inspection_rules', ?, ?)
        ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [inspectionRulesJson(rules), now]);
      if (!rules.releaseDate.enabled) {
        await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE status = 'queued'", [now]);
        await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE release_status = 'pending'", [now]);
      }
      if (!rules.magnet.enabled) {
        await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE status = 'queued'", [now]);
        await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE magnet_status = 'pending'", [now]);
      }
      return id;
    });
    await refreshSettings(true);
    await appendRuntimeLog({ level: 'success', source: 'system', message: 'MissAV 检查规则已原子更新；后续任务会按新规则执行。' });
    return { preset: await db.get('SELECT * FROM subscription_presets WHERE id = ?', [presetId]), inspectionRules: rules };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'MissAV 检查规则无法保存。' }); }
});
app.get('/api/archive', async (request) => {
  const query = request.query as { subscriptionId?: string; page?: string; pageSize?: string; q?: string; releaseFrom?: string; releaseTo?: string };
  const subscriptionId = Number(query.subscriptionId);
  const hasSubscriptionId = Number.isInteger(subscriptionId) && subscriptionId > 0;
  const pageInput = Number(query.page ?? 1);
  const page = Number.isInteger(pageInput) ? Math.max(1, pageInput) : 1;
  const pageSizeInput = Number(query.pageSize ?? 50);
  const pageSize = Number.isInteger(pageSizeInput) ? Math.min(Math.max(pageSizeInput, 20), 200) : 50;
  const keyword = (query.q ?? '').trim().slice(0, 120);
  const releaseFrom = /^\d{4}-\d{2}-\d{2}$/.test(query.releaseFrom ?? '') ? query.releaseFrom! : '';
  const releaseTo = /^\d{4}-\d{2}-\d{2}$/.test(query.releaseTo ?? '') ? query.releaseTo! : '';
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (hasSubscriptionId) { clauses.push('a.subscription_id = ?'); params.push(subscriptionId); }
  if (keyword) { clauses.push('(a.content LIKE ? OR a.title LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (releaseFrom) { clauses.push('a.release_date >= ?'); params.push(releaseFrom); }
  if (releaseTo) { clauses.push('a.release_date <= ?'); params.push(releaseTo); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const totalRow = await db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM archive_entries a ${where}`, params);
  const total = Number(totalRow?.total ?? 0);
  const items = await db.all(`SELECT a.id, a.content, a.title, a.detail_url, a.first_seen_at, a.release_date, a.release_status, a.release_error, a.magnet_status, a.magnet_value, a.magnet_checked_at, a.magnet_error,
      a.download_status, a.download_queued_at, a.download_added_at, a.download_torrent_hash, a.download_checked_at, a.download_error,
      a.download_progress, a.download_speed, a.download_size, a.downloaded_bytes, a.download_save_path, a.download_content_path, a.download_removed_at, a.download_filter_min_size_bytes,
      a.jellyfin_status, a.jellyfin_item_id, a.jellyfin_item_name, a.jellyfin_matched_at, a.jellyfin_error,
      s.id AS subscription_id, s.name AS subscription_name, s.url AS subscription_url
    FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
    ${where}
    ORDER BY a.id ASC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { items, total, page, pageSize };
});

app.post('/api/subscriptions/:id/magnet-backfill', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (!getInspectionRules().magnet.enabled) return reply.code(400).send({ error: '磁力检索规则当前已停用，请先在“检查规则”中启用。' });
  const candidates = await db.all<{ id: number }>(`SELECT id FROM archive_entries
    WHERE subscription_id = ? AND magnet_status IN ('unsearched', 'failed', 'skipped') ORDER BY id ASC`, [id]);
  let queued = 0;
  await db.transaction(async (tx) => {
    for (const entry of candidates) {
      await tx.run(`UPDATE archive_entries
        SET magnet_status = 'pending', magnet_value = NULL, magnet_checked_at = NULL, magnet_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), entry.id]);
      if ((await queueMagnetJob(entry.id, tx, JOB_PRIORITY.manual)).queued) queued += 1;
    }
  });
  if (queued) {
    await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `磁力检索补全已开始：${queued} 项已加入检索队列。` });
  }
  return reply.code(202).send({ queued, skipped: candidates.length - queued });
});

app.post('/api/subscriptions/:id/release-backfill', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (!getInspectionRules().releaseDate.enabled) return reply.code(400).send({ error: '发行日期规则当前已停用，请先在“检查规则”中启用。' });
  const candidates = await db.all<{ id: number }>(`SELECT id FROM archive_entries
    WHERE subscription_id = ? AND release_status IN ('unsearched', 'unavailable', 'failed') ORDER BY id ASC`, [id]);
  let queued = 0;
  await db.transaction(async (tx) => {
    for (const entry of candidates) {
      const now = new Date().toISOString();
      await tx.run(`UPDATE archive_entries
        SET release_date = NULL, release_status = 'pending', release_checked_at = NULL, release_error = NULL, updated_at = ? WHERE id = ?`, [now, entry.id]);
      if ((await queueReleaseJob(entry.id, tx, JOB_PRIORITY.manual)).queued) queued += 1;
    }
  });
  if (queued) {
    await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `发行日期检索已开始：${queued} 项已加入读取队列。` });
  }
  return reply.code(202).send({ queued, skipped: candidates.length - queued });
});

app.post('/api/archive/:id/magnet-retry', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const entry = await db.get<{ id: number; subscription_id: number; content: string; magnet_status: string; subscription_name: string }>(`SELECT a.id, a.subscription_id, a.content, a.magnet_status, s.name AS subscription_name
    FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.id = ?`, [id]);
  if (!entry) return reply.code(404).send({ error: '归档内容不存在。' });
  if (!getInspectionRules().magnet.enabled) return reply.code(400).send({ error: '磁力检索规则当前已停用，请先在“检查规则”中启用。' });
  if (entry.magnet_status === 'found') return reply.code(409).send({ error: '该内容已找到磁力链接，无需重试。' });
  if (entry.magnet_status === 'pending') return reply.code(409).send({ error: '该内容正在检索中。' });
  let queued = false;
  let jobId = 0;
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE archive_entries SET magnet_status = 'pending', magnet_value = NULL, magnet_checked_at = NULL, magnet_error = NULL, updated_at = ?
      WHERE id = ?`, [new Date().toISOString(), entry.id]);
    const result = await queueMagnetJob(entry.id, tx, JOB_PRIORITY.manual);
    queued = result.queued;
    jobId = result.id;
  });
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: entry.subscription_id, message: queued ? `已重新加入“${entry.content}”的磁力检索队列。` : `“${entry.content}”已在磁力检索队列中。` });
  return reply.code(202).send({ queued, jobId });
});

function publicQbittorrentSettings() {
  const settings = getQbittorrentSettings();
  return {
    enabled: settings.enabled,
    url: settings.url,
    authMode: settings.authMode,
    apiKeyConfigured: Boolean(settings.apiKey),
    username: settings.username,
    passwordConfigured: Boolean(settings.password),
    category: settings.category,
    savePath: settings.savePath,
    tags: settings.tags,
    autoDownload: settings.autoDownload,
    autoDownloadMinSizeMb: settings.autoDownloadMinSizeMb,
    stopAfterDownload: settings.stopAfterDownload
  };
}

function publicJellyfinSettings() {
  const settings = getJellyfinSettings();
  return {
    enabled: settings.enabled,
    url: settings.url,
    apiKeyConfigured: Boolean(settings.apiKey),
    libraryIds: settings.libraryIds,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    skipMagnetWhenAvailable: settings.skipMagnetWhenAvailable,
    lastSyncedAt: getSetting('jellyfin_last_synced_at') || null
  };
}

function normalizeJellyfinLibraryIds(value: unknown, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error('Jellyfin 媒体库选择格式无效。');
  const ids = [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
  if (ids.length > 30 || ids.some((id) => id.length > 128)) throw new Error('Jellyfin 媒体库选择数量或标识无效。');
  return ids;
}

function normalizeJellyfinSettings(payload: JellyfinSettingsPayload) {
  const current = getJellyfinSettings();
  const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : current.enabled;
  const rawUrl = payload.url === undefined ? current.url : typeof payload.url === 'string' ? payload.url.trim() : (() => { throw new Error('Jellyfin Web 地址格式无效。'); })();
  const url = rawUrl ? normalizeJellyfinUrl(rawUrl) : '';
  const apiKey = payload.clearApiKey ? '' : typeof payload.apiKey === 'string' && payload.apiKey.trim() ? payload.apiKey.trim() : current.apiKey;
  if (apiKey.length > 512) throw new Error('Jellyfin API 密钥不能超过 512 个字符。');
  const libraryIds = normalizeJellyfinLibraryIds(payload.libraryIds, current.libraryIds);
  const interval = payload.syncIntervalMinutes === undefined ? current.syncIntervalMinutes : Number(payload.syncIntervalMinutes);
  if (!Number.isInteger(interval) || interval < 5 || interval > 1440) throw new Error('Jellyfin 同步间隔需在 5 到 1440 分钟之间。');
  const skipMagnetWhenAvailable = typeof payload.skipMagnetWhenAvailable === 'boolean' ? payload.skipMagnetWhenAvailable : current.skipMagnetWhenAvailable;
  const settings = { enabled, url, apiKey, libraryIds, syncIntervalMinutes: interval, skipMagnetWhenAvailable };
  if (enabled) assertJellyfinConfig(settings);
  return settings;
}

function compactQbittorrentField(value: unknown, label: string, limit: number) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const normalized = value.trim();
  if (normalized.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符。`);
  return normalized;
}

function normalizeQbittorrentSettings(payload: QbittorrentSettingsPayload) {
  const current = getQbittorrentSettings();
  const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : current.enabled;
  const autoDownload = typeof payload.autoDownload === 'boolean' ? payload.autoDownload : current.autoDownload;
  const autoDownloadMinSizeMb = payload.autoDownloadMinSizeMb === undefined ? current.autoDownloadMinSizeMb : Number(payload.autoDownloadMinSizeMb);
  if (!Number.isInteger(autoDownloadMinSizeMb) || autoDownloadMinSizeMb < 0 || autoDownloadMinSizeMb > 1048576) {
    throw new Error('最小单文件大小需为 0 到 1048576 之间的整数 MB。');
  }
  const stopAfterDownload = typeof payload.stopAfterDownload === 'boolean' ? payload.stopAfterDownload : current.stopAfterDownload;
  const authMode = payload.authMode === 'api_key' ? 'api_key' : payload.authMode === 'password' ? 'password' : current.authMode;
  const rawUrl = payload.url === undefined ? current.url : compactQbittorrentField(payload.url, 'qBittorrent Web UI 地址', 500);
  const url = rawUrl ? normalizeQbittorrentUrl(rawUrl) : '';
  const apiKey = payload.clearApiKey ? '' : typeof payload.apiKey === 'string' && payload.apiKey.length ? payload.apiKey.trim() : current.apiKey;
  if (apiKey.length > 128) throw new Error('qBittorrent API 密钥不能超过 128 个字符。');
  const username = payload.username === undefined ? current.username : compactQbittorrentField(payload.username, 'qBittorrent 用户名', 128);
  const password = payload.clearPassword ? '' : typeof payload.password === 'string' && payload.password.length ? payload.password : current.password;
  if (password.length > 1024) throw new Error('qBittorrent 密码不能超过 1024 个字符。');
  const category = payload.category === undefined ? current.category : compactQbittorrentField(payload.category, '分类', 255);
  const savePath = payload.savePath === undefined ? current.savePath : compactQbittorrentField(payload.savePath, '保存路径', 1000);
  const tags = payload.tags === undefined ? current.tags : compactQbittorrentField(payload.tags, '标签', 500);
  const values = { enabled, url, authMode, apiKey, username, password, category, savePath, tags, autoDownload, autoDownloadMinSizeMb, stopAfterDownload };
  if (enabled) assertQbittorrentConfig(values);
  return values;
}

async function ensureQbittorrentEnabled(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  const settings = getQbittorrentSettings();
  if (!settings.enabled) {
    reply.code(409).send({ error: 'qBittorrent 下载尚未启用。请先在“下载设置”中完成配置。' });
    return null;
  }
  try { return assertQbittorrentConfig(settings); }
  catch (error) {
    reply.code(409).send({ error: error instanceof Error ? error.message : 'qBittorrent 配置不完整。' });
    return null;
  }
}

app.post('/api/subscriptions/:id/download-backfill', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (!await ensureQbittorrentEnabled(reply)) return;
  const candidates = await db.all<{ id: number; download_status: string }>(`SELECT id, download_status FROM archive_entries
    WHERE subscription_id = ? AND magnet_status = 'found' AND magnet_value IS NOT NULL
      AND download_status IN ('not_queued', 'failed', 'filtered') ORDER BY id ASC`, [id]);
  let queued = 0;
  await db.transaction(async (tx) => {
    for (const entry of candidates) {
      const result = await queueDownloadJob(entry.id, tx, JOB_PRIORITY.manual);
      if (result.queued) {
        queued += 1;
        const now = new Date().toISOString();
        if (entry.download_status === 'filtered') {
          await tx.run(`UPDATE archive_entries SET download_queued_at = ?,
            download_error = '已排队手动下载，将恢复种子内全部文件。', updated_at = ? WHERE id = ?`, [now, now, entry.id]);
        } else {
          await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL,
            download_filter_min_size_bytes = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
        }
      }
    }
  });
  if (queued) await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `已将 ${queued} 项磁力链接加入 qBittorrent 下载队列。` });
  return reply.code(202).send({ queued, skipped: candidates.length - queued });
});

app.post('/api/archive/:id/download', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const entry = await db.get<{ id: number; subscription_id: number; content: string; magnet_status: string; magnet_value: string | null; download_status: string }>(
    'SELECT id, subscription_id, content, magnet_status, magnet_value, download_status FROM archive_entries WHERE id = ?', [id]);
  if (!entry) return reply.code(404).send({ error: '归档内容不存在。' });
  if (!await ensureQbittorrentEnabled(reply)) return;
  if (entry.magnet_status !== 'found' || !entry.magnet_value) return reply.code(400).send({ error: '该内容尚未找到可用的磁力链接。' });
  if (entry.download_status === 'added') return reply.code(409).send({ error: '该内容已提交给 qBittorrent。' });
  let queued = false;
  let jobId = 0;
  await db.transaction(async (tx) => {
    const result = await queueDownloadJob(entry.id, tx, JOB_PRIORITY.manual);
    queued = result.queued;
    jobId = result.id;
    if (queued) {
      const now = new Date().toISOString();
      if (entry.download_status === 'filtered') {
        await tx.run(`UPDATE archive_entries SET download_queued_at = ?,
          download_error = '已排队手动下载，将恢复种子内全部文件。', updated_at = ? WHERE id = ?`, [now, now, entry.id]);
      } else {
        await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL,
          download_filter_min_size_bytes = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
      }
    }
  });
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: entry.subscription_id, jobId, message: queued ? `已将“${entry.content}”加入 qBittorrent 下载队列。` : `“${entry.content}”已在 qBittorrent 下载队列中。` });
  return reply.code(202).send({ queued, jobId });
});

function validateProxy(raw: string | undefined) {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入有效的代理地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || !url.port) {
    throw new Error('代理地址需为 http://地址:端口 或 https://地址:端口。');
  }
  return url.toString();
}

const presetNamesSettingKey = 'subscription_preset_names';

function readPresetNames() {
  const raw = getSetting(presetNamesSettingKey);
  if (!raw) return {} as Record<string, string>;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, string>;
    return Object.fromEntries(Object.entries(value).filter(([id, name]) => /^[a-z0-9-]+$/.test(id) && typeof name === 'string')) as Record<string, string>;
  } catch { return {} as Record<string, string>; }
}

function normalizePresetNames(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预设名称格式无效。');
  const names: Record<string, string> = {};
  for (const [id, rawName] of Object.entries(input)) {
    if (!/^[a-z0-9-]+$/.test(id) || typeof rawName !== 'string') throw new Error('预设名称格式无效。');
    const name = rawName.trim();
    if (name.length > 40) throw new Error('预设名称不能超过 40 个字符。');
    if (name) names[id] = name;
  }
  return names;
}

app.get('/api/settings/network', async () => ({
  proxyUrl: process.env.OUTBOUND_PROXY ? '' : getSetting('outbound_proxy'),
  active: Boolean(getOutboundProxyUrl()),
  fromEnvironment: Boolean(process.env.OUTBOUND_PROXY)
}));

app.put('/api/settings/network', async (request, reply) => {
  if (process.env.OUTBOUND_PROXY) return reply.code(409).send({ error: '当前代理由 OUTBOUND_PROXY 环境变量管理。' });
  try {
    const proxyUrl = validateProxy((request.body as { proxyUrl?: string }).proxyUrl);
    await setSetting('outbound_proxy', proxyUrl);
    return { proxyUrl, active: Boolean(proxyUrl), fromEnvironment: false };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存代理设置。' });
  }
});

app.get('/api/settings/runtime', async () => getRuntimeSettings());
app.put('/api/settings/runtime', async (request, reply) => {
  const body = request.body as { profile?: unknown; browserIdleMinutes?: unknown };
  if (body.profile !== 'safe' && body.profile !== 'performance') return reply.code(400).send({ error: '运行模式无效。' });
  if (![5, 10, 20].includes(Number(body.browserIdleMinutes))) return reply.code(400).send({ error: '浏览器空闲回收时间只能是 5、10 或 20 分钟。' });
  const settings = await setRuntimeSettings({ profile: body.profile, browserIdleMinutes: Number(body.browserIdleMinutes) as 5 | 10 | 20 });
  await appendRuntimeLog({ level: 'info', source: 'system', message: `运行性能设置已更新：${settings.profile === 'performance' ? '性能模式' : '稳妥模式'}，浏览器空闲 ${settings.browserIdleMinutes} 分钟后回收。` });
  return settings;
});

app.get('/api/settings/notifications', async () => publicNotificationSettings());
app.put('/api/settings/notifications', async (request, reply) => {
  try {
    const settings = normalizeNotificationSettings(request.body as NotificationSettingsPayload);
    await saveNotificationSettings(settings);
    await appendRuntimeLog({ level: 'info', source: 'system', message: settings.enabled ? '通知设置已保存并启用。' : '通知设置已保存，通知当前处于关闭状态。' });
    return publicNotificationSettings(settings);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存通知设置。' });
  }
});
app.post('/api/settings/notifications/test', async (_request, reply) => {
  try {
    await deliverNotification(createTestNotification(), getNotificationSettings());
    await appendRuntimeLog({ level: 'success', source: 'system', message: '通知测试发送成功。' });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '通知测试发送失败。';
    await appendRuntimeLog({ level: 'error', source: 'system', message: `通知测试发送失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.get('/api/settings/qbittorrent', async () => publicQbittorrentSettings());
app.put('/api/settings/qbittorrent', async (request, reply) => {
  try {
    const settings = normalizeQbittorrentSettings(request.body as QbittorrentSettingsPayload);
    await Promise.all([
      setSetting('qbit_enabled', settings.enabled ? '1' : '0'),
      setSetting('qbit_url', settings.url),
      setSetting('qbit_auth_mode', settings.authMode),
      setSetting('qbit_api_key', settings.apiKey),
      setSetting('qbit_username', settings.username),
      setSetting('qbit_password', settings.password),
      setSetting('qbit_category', settings.category),
      setSetting('qbit_save_path', settings.savePath),
      setSetting('qbit_tags', settings.tags),
      setSetting('qbit_auto_download', settings.autoDownload ? '1' : '0'),
      setSetting('qbit_auto_download_min_size_mb', String(settings.autoDownloadMinSizeMb)),
      setSetting('qbit_stop_after_download', settings.stopAfterDownload ? '1' : '0'),
      setSetting('integration_onboarding_pending', '0')
    ]);
    if (!settings.enabled) await reportIntegrationStatus('qbittorrent', 'disabled', 'qBittorrent 已在 Page Watch 中停用');
    return publicQbittorrentSettings();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存 qBittorrent 设置。' });
  }
});

app.post('/api/settings/qbittorrent/test', async (_request, reply) => {
  try {
    const settings = getQbittorrentSettings();
    await testQbittorrentConnection(settings);
    await reportIntegrationStatus('qbittorrent', 'healthy', '连接测试成功');
    await appendRuntimeLog({ level: 'success', source: 'download', message: `qBittorrent 连接测试成功（${normalizeQbittorrentUrl(settings.url)}）。` });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'qBittorrent 连接测试失败。';
    await reportIntegrationStatus('qbittorrent', 'degraded', '最近一次连接测试失败').catch(() => undefined);
    await appendRuntimeLog({ level: 'error', source: 'download', message: `qBittorrent 连接测试失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.get('/api/settings/jellyfin', async () => publicJellyfinSettings());
app.put('/api/settings/jellyfin', async (request, reply) => {
  try {
    const activeSync = await db.get<{ id: number }>("SELECT id FROM library_sync_jobs WHERE status = 'running' LIMIT 1");
    if (activeSync) return reply.code(409).send({ error: 'Jellyfin 全量同步正在执行；请等待任务完成后再修改连接或媒体库。' });
    const settings = normalizeJellyfinSettings(request.body as JellyfinSettingsPayload);
    const now = new Date().toISOString();
    await Promise.all([
      setSetting('jellyfin_enabled', settings.enabled ? '1' : '0'),
      setSetting('jellyfin_url', settings.url),
      setSetting('jellyfin_api_key', settings.apiKey),
      setSetting('jellyfin_library_ids', JSON.stringify(settings.libraryIds)),
      setSetting('jellyfin_sync_interval_minutes', String(settings.syncIntervalMinutes)),
      setSetting('jellyfin_skip_magnet_when_available', settings.skipMagnetWhenAvailable ? '1' : '0'),
      setSetting('jellyfin_last_synced_at', ''),
      setSetting('jellyfin_media_index_synced_at', ''),
      setSetting('integration_onboarding_pending', '0')
    ]);
    await clearJellyfinMediaIndex();
    await db.run(`UPDATE archive_entries SET jellyfin_status = ?, jellyfin_item_id = NULL, jellyfin_item_name = NULL,
      jellyfin_matched_at = NULL, jellyfin_error = NULL, updated_at = ?`, [settings.enabled && settings.libraryIds.length ? 'pending' : 'unconfigured', now]);
    if (!settings.enabled) {
      await db.run("UPDATE library_sync_jobs SET status = 'completed', finished_at = ?, error = 'Jellyfin 已停用', progress_phase = 'cancelled', progress_label = 'Jellyfin 已停用' WHERE status = 'queued'", [now]);
      await reportIntegrationStatus('jellyfin', 'disabled', 'Jellyfin 已在 Page Watch 中停用');
    }
    return publicJellyfinSettings();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存 Jellyfin 设置。' });
  }
});

app.post('/api/settings/jellyfin/test', async (_request, reply) => {
  try {
    const settings = getJellyfinSettings();
    const [server, libraries] = await Promise.all([testJellyfinConnection(settings), listJellyfinLibraries(settings)]);
    await reportIntegrationStatus('jellyfin', 'healthy', '连接测试成功');
    await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 连接测试成功（${server.serverName}${server.version ? ` ${server.version}` : ''}），发现 ${libraries.length} 个媒体库。` });
    return { ok: true, server, libraries };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Jellyfin 连接测试失败。';
    await reportIntegrationStatus('jellyfin', 'degraded', '最近一次连接测试失败').catch(() => undefined);
    await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 连接测试失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.post('/api/settings/jellyfin/sync', async (_request, reply) => {
  try {
    const settings = getJellyfinSettings();
    if (!settings.enabled || !settings.libraryIds.length) return reply.code(400).send({ error: '请先启用 Jellyfin 并选择至少一个媒体库。' });
    const queued = await queueLibrarySyncJob('manual', JOB_PRIORITY.manual);
    await appendRuntimeLog({ level: 'info', source: 'library', message: queued.queued ? 'Jellyfin 手动全量同步已加入队列。' : 'Jellyfin 全量同步已在队列中或正在执行。' });
    return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法加入 Jellyfin 同步队列。' });
  }
});

app.get('/api/settings/preset-names', async () => ({ names: readPresetNames() }));
app.put('/api/settings/preset-names', async (request, reply) => {
  try {
    const names = normalizePresetNames((request.body as { names?: unknown }).names);
    await setSetting(presetNamesSettingKey, JSON.stringify(names));
    return { names };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存预设名称。' });
  }
});

app.post('/api/subscriptions', async (request, reply) => {
  try {
    const values = await normalizePayload(request.body as SubscriptionPayload);
    const now = new Date().toISOString();
    const result = await db.run(`INSERT INTO subscriptions
      (name, url, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, schedule_type, schedule_interval_hours, schedule_time, schedule_weekday, is_active, pagination_selector, pagination_parameter, pagination_match_pattern, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.name, values.url, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.scheduleType, values.scheduleIntervalHours, values.scheduleTime, values.scheduleWeekday, values.isActive, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, now, now]);
    await rebuildSubscriptionProgress(result.lastInsertRowid);
    return reply.code(201).send(await getSubscription(result.lastInsertRowid));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建订阅。' });
  }
});

app.put('/api/subscriptions/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!await getSubscription(id)) return reply.code(404).send({ error: '订阅不存在。' });
  try {
    const values = await normalizePayload(request.body as SubscriptionPayload);
    await db.run(`UPDATE subscriptions SET name=?, url=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, schedule_type=?, schedule_interval_hours=?, schedule_time=?, schedule_weekday=?, is_active=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, initial_scan_completed=CASE WHEN ? IS NULL THEN 1 WHEN pagination_selector IS NULL THEN 0 ELSE initial_scan_completed END, initial_scan_total=CASE WHEN ? IS NOT NULL AND pagination_selector IS NULL THEN NULL ELSE initial_scan_total END, initial_scan_pages_completed=CASE WHEN ? IS NOT NULL AND pagination_selector IS NULL THEN 0 ELSE initial_scan_pages_completed END, updated_at=? WHERE id=?`,
      [values.name, values.url, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.scheduleType, values.scheduleIntervalHours, values.scheduleTime, values.scheduleWeekday, values.isActive, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.paginationSelector, values.paginationSelector, values.paginationSelector, new Date().toISOString(), id]);
    return await getSubscription(id);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法更新订阅。' });
  }
});

app.delete('/api/subscriptions/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  await db.transaction(async (tx) => {
    await tx.run('DELETE d FROM download_jobs d JOIN archive_entries a ON a.id = d.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE r FROM release_jobs r JOIN archive_entries a ON a.id = r.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE m FROM magnet_jobs m JOIN archive_entries a ON a.id = m.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE l FROM library_jobs l JOIN archive_entries a ON a.id = l.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
    await tx.run('DELETE FROM archive_entries WHERE subscription_id = ?', [id]);
    await tx.run('DELETE FROM jobs WHERE subscription_id = ?', [id]);
    await tx.run('DELETE FROM subscription_progress WHERE subscription_id = ?', [id]);
    await tx.run('UPDATE runtime_logs SET subscription_id = NULL WHERE subscription_id = ?', [id]);
    await tx.run('DELETE FROM subscriptions WHERE id = ?', [id]);
  });
  return reply.code(204).send();
});

app.delete('/api/subscriptions/:id/archive', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!await getSubscription(id)) return reply.code(404).send({ error: '订阅不存在。' });
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run('DELETE d FROM download_jobs d JOIN archive_entries a ON a.id = d.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE r FROM release_jobs r JOIN archive_entries a ON a.id = r.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE m FROM magnet_jobs m JOIN archive_entries a ON a.id = m.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE l FROM library_jobs l JOIN archive_entries a ON a.id = l.archive_entry_id WHERE a.subscription_id = ?', [id]);
    await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
    await tx.run('DELETE FROM archive_entries WHERE subscription_id = ?', [id]);
    await tx.run(`INSERT INTO subscription_progress
      (subscription_id, archive_total, jellyfin_available, release_total, release_done, magnet_total, magnet_done, library_total, library_done, download_total, download_done, updated_at)
      VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
      ON DUPLICATE KEY UPDATE archive_total=0, jellyfin_available=0, release_total=0, release_done=0, magnet_total=0, magnet_done=0, library_total=0, library_done=0, download_total=0, download_done=0, updated_at=VALUES(updated_at)`, [id, now]);
    await tx.run("DELETE FROM jobs WHERE subscription_id = ? AND status = 'queued'", [id]);
    await tx.run(`UPDATE subscriptions
      SET last_checked_at = NULL, last_hash = NULL, last_content = NULL, last_error = NULL,
        initial_scan_completed = CASE WHEN pagination_selector IS NULL THEN 1 ELSE 0 END,
        initial_scan_total = NULL, initial_scan_pages_completed = 0, initial_scan_run_id = NULL, initial_scan_next_page = 1, updated_at = ?
      WHERE id = ?`, [now, id]);
  });
  return reply.code(204).send();
});

app.post('/api/subscriptions/preview', async (request, reply) => {
  try {
    const values = await normalizePayload(request.body as SubscriptionPayload);
    const token = process.env.WORKER_EVENT_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'page-watch-dev-runner');
    if (!token) throw new Error('统一执行引擎尚未就绪，请稍后重试。');
    await engineWakeScheduler.wake('规则预览');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`http://127.0.0.1:${process.env.RUNNER_INTERNAL_PORT || '3031'}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-page-watch-worker-token': token },
        body: JSON.stringify({ url: values.url, selector: values.selector, render_mode: values.renderMode as Subscription['render_mode'], content_source: values.contentSource as Subscription['content_source'], attribute_name: values.attributeName, match_pattern: values.matchPattern, title_selector: values.titleSelector, title_content_source: values.titleContentSource as Subscription['title_content_source'], title_attribute_name: values.titleAttributeName, title_match_pattern: values.titleMatchPattern, result_mode: values.resultMode as Subscription['result_mode'] }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '预览抽取失败。');
      return result;
    } finally { clearTimeout(timeout); }
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '预览失败。' });
  }
});

app.post('/api/subscriptions/:id/run', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  const queued = await queueJob(id, JOB_PRIORITY.manual);
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, jobId: queued.id, message: queued.queued ? '已加入立即检查队列。' : '检查已在队列中或正在执行。' });
  return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
});

app.post('/api/subscriptions/:id/full-scan', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (!subscription.pagination_selector) return reply.code(400).send({ error: '当前订阅没有配置全量分页检查。' });
  const active = await db.get<{ id: number }>("SELECT id FROM jobs WHERE subscription_id = ? AND status IN ('queued','running')", [id]);
  if (active) return reply.code(409).send({ error: '该订阅已有检查正在执行或排队；请等待其结束后再开始新的全量检查。' });
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
    await tx.run(`UPDATE subscriptions SET initial_scan_completed = 0, initial_scan_total = NULL, initial_scan_pages_completed = 0, initial_scan_run_id = NULL, initial_scan_next_page = 1, last_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  });
  const queued = await queueJob(id, JOB_PRIORITY.manual);
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, jobId: queued.id, message: queued.queued ? '已加入全量检查队列。' : '全量检查设置已更新，当前检查结束后可再次确认日志。' });
  return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
});

const dist = path.resolve(process.cwd(), 'dist');
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, {
    root: dist,
    wildcard: false,
    setHeaders(response, filePath) {
      if (/[/\\]assets[/\\].*-[A-Za-z0-9_-]{8,}\./.test(filePath)) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else response.setHeader('Cache-Control', 'no-cache');
    }
  });
  app.get('/*', async (_request, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });
}

let operationalServicesStarted = false;
function startOperationalServices() {
  if (operationalServicesStarted || !isDatabaseConfigured()) return;
  operationalServicesStarted = true;
  const beat = async () => {
    await reportWorkerHeartbeat('api', `网页服务监听端口 ${port}`).catch((error) => app.log.warn(`Unable to save API heartbeat: ${error instanceof Error ? error.message : String(error)}`));
    if (engineController.snapshot().state === 'sleeping') {
      await Promise.all(([
        ['capture', '检查 Worker 按需休眠'],
        ['release', '发行日期 Worker 按需休眠'],
        ['magnet', '磁力检索 Worker 按需休眠'],
        ['download', '下载提交 Worker 按需休眠'],
        ['library', '影视库同步 Worker 按需休眠']
      ] as const).map(([name, detail]) => reportWorkerHeartbeat(name, detail, 'sleeping'))).catch(() => undefined);
    }
  };
  void beat();
  setInterval(() => void beat(), 30_000).unref();
  engineWakeScheduler.start();
  engineController.onChange(() => { void beat(); });

  let downloadObserverTimer: NodeJS.Timeout | null = null;
  const scheduleDownloadObserver = async () => {
    try {
      const active = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM archive_entries
        WHERE download_status IN ('added', 'waiting', 'downloading', 'paused')`);
      const delay = Number(active?.count ?? 0) > 0 ? 10_000 : 60_000;
      if (Number(active?.count ?? 0) > 0) {
        await reportWorkerHeartbeat('download', `正在轻量同步 ${active?.count ?? 0} 个 qBittorrent 下载状态`, 'busy');
        process.env.PAGE_WATCH_WORKER_AUTOSTART = '0';
        const observer = await import('./download-worker.js');
        if (await observer.observeQbittorrentDownloads()) await engineWakeScheduler.wake('下载完成通知已入队');
      }
      downloadObserverTimer = setTimeout(() => void scheduleDownloadObserver(), delay);
      downloadObserverTimer.unref();
    } catch (error) {
      app.log.warn(`Unable to synchronize qBittorrent downloads: ${error instanceof Error ? error.message : String(error)}`);
      downloadObserverTimer = setTimeout(() => void scheduleDownloadObserver(), 60_000);
      downloadObserverTimer.unref();
    }
  };
  void scheduleDownloadObserver();
  void appendRuntimeLog({ level: 'info', source: 'system', message: `网页服务已启动，监听端口 ${port}。` })
    .catch((error) => app.log.warn(`Unable to save service startup log: ${error instanceof Error ? error.message : String(error)}`));
  const maintainMetrics = async () => {
    try {
      await maintainPerformanceMetrics();
      await rebuildSubscriptionProgress();
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : '未知数据库错误';
      await appendRuntimeLog({ level: 'error', source: 'system', message: `长期性能指标维护失败：${detail}` }).catch(() => undefined);
    }
  };
  void maintainMetrics();
  const maintenanceTimer = setInterval(() => void maintainMetrics(), 24 * 60 * 60_000);
  maintenanceTimer.unref();
}

app.listen({ port, host: '0.0.0.0' }).then(() => {
  startRuntimeMemoryReporter('api');
  startOperationalServices();
}).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

let apiStopping = false;
async function stopApi() {
  if (apiStopping) return;
  apiStopping = true;
  engineWakeScheduler.stop();
  await engineController.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
}
process.once('SIGTERM', () => { void stopApi(); });
process.once('SIGINT', () => { void stopApi(); });

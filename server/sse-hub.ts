import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { statusFor } from './auth.js';
import { db, isDatabaseConfigured } from './db.js';
import { tokensMatch } from './http-guards.js';

/**
 * 实时推送：浏览器通过 SSE 订阅归档、任务、日志等变化，Worker 通过内部令牌
 * 通知 API 立即推送，另有 30 秒一次的兜底轮询。
 *
 * 该领域持有全部连接与版本号状态，其他领域只调用 emitLive 广播，不直接触碰
 * 连接集合。
 */

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

export function emitLive(channel: LiveChannel, subscriptionId?: number) {
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
    watchesSubscriptions ? db.get<{ version: string }>(`SELECT md5(concat(COALESCE((SELECT MAX(updated_at) FROM subscriptions), ''), ':', COALESCE((SELECT MAX(updated_at) FROM archive_entries), ''), ':', COALESCE((SELECT MAX(requested_at) FROM jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM release_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM magnet_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM library_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM library_sync_jobs WHERE status IN ('queued','running')), ''), ':', COALESCE((SELECT MAX(requested_at) FROM download_jobs WHERE status IN ('queued','running')), ''))) AS version`) : Promise.resolve(undefined),
    watchesTasks ? db.get<{ version: string }>(`SELECT md5(concat(
      COALESCE((SELECT MAX(requested_at) FROM jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM release_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM release_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM release_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM release_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM magnet_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM magnet_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM magnet_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM magnet_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM library_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM library_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM library_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM library_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM library_sync_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM library_sync_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM library_sync_jobs), ''), ':',
      COALESCE((SELECT MAX(requested_at) FROM download_jobs), ''), ':', COALESCE((SELECT MAX(started_at) FROM download_jobs), ''), ':', COALESCE((SELECT MAX(finished_at) FROM download_jobs), ''), ':', COALESCE((SELECT MAX(retry_after) FROM download_jobs), ''))) AS version`) : Promise.resolve(undefined)
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


export function registerLiveRoutes(app: FastifyInstance) {
app.post('/api/internal/events', async (request, reply) => {
  const token = process.env.WORKER_EVENT_TOKEN;
  if (!token || !tokensMatch(request.headers['x-page-watch-worker-token'], token)) return reply.code(403).send({ error: '内部事件令牌无效。' });
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
}

export function startLivePolling(app: FastifyInstance) {
// Direct worker notifications are the normal path. This low-frequency fallback
// keeps separately launched development workers compatible without DB churn.
const livePollTimer = setInterval(() => {
  if (isDatabaseConfigured()) void pollLiveChanges().catch((error) => app.log.warn(`Live update poll failed: ${error instanceof Error ? error.message : String(error)}`));
}, 30_000);
livePollTimer.unref();
}

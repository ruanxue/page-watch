import path from 'node:path';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { assertSafeUrl, previewCapture } from './capture.js';
import { appendRuntimeLog, db, getJellyfinSettings, getOutboundProxyUrl, getQbittorrentSettings, getSetting, getSubscription, queueDownloadJob, queueJob, queueMagnetJob, queueReleaseJob, reportWorkerHeartbeat, setSetting, type Subscription } from './db.js';
import { assertQbittorrentConfig, normalizeQbittorrentUrl, testQbittorrentConnection } from './qbittorrent.js';
import { assertJellyfinConfig, listJellyfinLibraries, normalizeJellyfinUrl, testJellyfinConnection } from './jellyfin.js';
import { syncJellyfinLibrary } from './jellyfin-sync.js';
import { authenticate, clearSessionCookie, configurePassword, createSession, sessionCookie, statusFor, validatePassword } from './auth.js';
import { getInspectionRules, inspectionRulesJson, normalizeInspectionRules } from './inspection-rules.js';

const app = Fastify({ logger: { level: 'warn' } });
const port = Number(process.env.PORT ?? 3030);
const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
const loginWindowMs = 10 * 60_000;
const loginLimit = 7;
type LiveChannel = 'archive' | 'logs';
type LiveClient = { response: ServerResponse; channel: LiveChannel; subscriptionId: number | null; needsSnapshot: boolean };
const liveClients = new Set<LiveClient>();
const archiveVersions = new Map<number, string>();
let liveInitialized = false;
let latestLogId = 0;
let lastSseKeepAliveAt = 0;

function authPath(url: string) {
  return url.split('?')[0];
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
  client.response.write(`event: ${event}\n`);
  if (data !== undefined) client.response.write(`data: ${JSON.stringify(data)}\n`);
  client.response.write('\n');
}

async function pollLiveChanges() {
  if (!liveClients.size) return;
  const watchesLogs = [...liveClients].some((client) => client.channel === 'logs');
  const watchesArchive = [...liveClients].some((client) => client.channel === 'archive');
  const [latestLog, versions] = await Promise.all([
    watchesLogs ? db.get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM runtime_logs') : Promise.resolve(undefined),
    watchesArchive ? db.all<{ subscription_id: number; version: string }>(`SELECT subscription_id, MAX(updated_at) AS version
      FROM archive_entries GROUP BY subscription_id`) : Promise.resolve([])
  ]);
  const nextLogId = Number(latestLog?.id ?? 0);
  const nextVersions = new Map(versions.map((row) => [row.subscription_id, row.version]));
  const hadPreviousSnapshot = liveInitialized;
  if (!liveInitialized) {
    latestLogId = nextLogId;
    archiveVersions.clear();
    for (const [subscriptionId, version] of nextVersions) archiveVersions.set(subscriptionId, version);
    liveInitialized = true;
  }
  for (const client of liveClients) {
    if (!client.needsSnapshot) continue;
    client.needsSnapshot = false;
    writeSse(client, client.channel, client.channel === 'archive' ? { subscriptionId: client.subscriptionId } : { latestId: nextLogId });
  }
  if (hadPreviousSnapshot) {
    if (nextLogId > latestLogId) {
      latestLogId = nextLogId;
      for (const client of liveClients) if (client.channel === 'logs') writeSse(client, 'logs', { latestId: nextLogId });
    }
    for (const [subscriptionId, version] of nextVersions) {
      if (archiveVersions.get(subscriptionId) === version) continue;
      archiveVersions.set(subscriptionId, version);
      for (const client of liveClients) {
        if (client.channel === 'archive' && client.subscriptionId === subscriptionId) writeSse(client, 'archive', { subscriptionId, version });
      }
    }
  }
  if (Date.now() - lastSseKeepAliveAt >= 20_000) {
    lastSseKeepAliveAt = Date.now();
    for (const client of liveClients) {
      if (!client.response.writableEnded && !client.response.destroyed) client.response.write(': keepalive\n\n');
    }
  }
}

const livePollTimer = setInterval(() => void pollLiveChanges().catch((error) => app.log.warn(`Live update poll failed: ${error instanceof Error ? error.message : String(error)}`)), 2_000);
livePollTimer.unref();

app.addHook('onRequest', async (request, reply) => {
  const requestPath = authPath(request.url);
  if (!requestPath.startsWith('/api/') || requestPath === '/api/health' || requestPath.startsWith('/api/auth/')) return;
  const status = await statusFor(request.headers.cookie);
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
  stopAfterDownload?: boolean;
};

type JellyfinSettingsPayload = {
  enabled?: boolean;
  url?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  libraryIds?: string[];
  syncIntervalMinutes?: number;
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
    (SELECT COUNT(*) FROM archive_entries a WHERE a.subscription_id = s.id) AS archive_count,
    CASE
      WHEN s.pagination_selector IS NOT NULL
        AND s.initial_scan_completed = 0
        AND EXISTS(SELECT 1 FROM jobs j WHERE j.subscription_id = s.id AND j.status IN ('queued', 'running'))
      THEN 1 ELSE NULL
    END AS full_scan_active
    FROM subscriptions s ORDER BY s.updated_at DESC, s.id DESC`);
}

app.get('/api/health', async () => ({ ok: true }));
app.get('/api/events', async (request, reply) => {
  const query = request.query as { channel?: string; subscriptionId?: string };
  const channel: LiveChannel | null = query.channel === 'archive' || query.channel === 'logs' ? query.channel : null;
  const subscriptionId = Number(query.subscriptionId);
  if (!channel || (channel === 'archive' && (!Number.isInteger(subscriptionId) || subscriptionId < 1))) {
    return reply.code(400).send({ error: '实时订阅参数无效。' });
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const client: LiveClient = { response: reply.raw, channel, subscriptionId: channel === 'archive' ? subscriptionId : null, needsSnapshot: true };
  liveClients.add(client);
  reply.raw.write('retry: 4000\n\n');
  writeSse(client, 'ready');
  request.raw.once('close', () => liveClients.delete(client));
});
app.get('/api/auth/status', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  const status = await statusFor(request.headers.cookie);
  return { setupRequired: !status.configured, authenticated: status.authenticated };
});
app.post('/api/auth/setup', async (request, reply) => {
  try {
    const password = (request.body as { password?: unknown }).password;
    validatePassword(password);
    await configurePassword(password);
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
app.get('/api/system/status', async () => {
  const rows = await db.all<{ worker_name: string; status: 'ready' | 'busy' | 'error'; detail: string; last_seen_at: string }>('SELECT worker_name, status, detail, last_seen_at FROM worker_heartbeats');
  const now = Date.now();
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
    return { name, label, status: row?.status ?? 'missing', detail: row?.detail ?? '尚未收到心跳', lastSeenAt: row?.last_seen_at ?? null, healthy: Boolean(row && age >= 0 && age < 45_000 && row.status !== 'error') };
  });
  return { generatedAt: new Date().toISOString(), services };
});
app.get('/api/subscriptions', async () => await listSubscriptions());
app.get('/api/logs', async (request) => {
  const query = request.query as { limit?: string };
  const limitValue = Number(query.limit ?? 300);
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 1000) : 300;
  return db.all(`SELECT l.*, s.name AS subscription_name, s.url AS subscription_url
    FROM runtime_logs l LEFT JOIN subscriptions s ON s.id = l.subscription_id
    ORDER BY l.id DESC LIMIT ?`, [limit]);
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
app.get('/api/archive', async (request) => {
  const query = request.query as { limit?: string; subscriptionId?: string };
  // An archive detail view is intentionally complete: its displayed count must
  // always match the rows the user can inspect.
  const limitValue = Number(query.limit ?? 10_000);
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 10_000) : 10_000;
  const subscriptionId = Number(query.subscriptionId);
  const hasSubscriptionId = Number.isInteger(subscriptionId) && subscriptionId > 0;
  return db.all(`SELECT a.id, a.content, a.title, a.detail_url, a.first_seen_at, a.release_date, a.release_status, a.release_error, a.magnet_status, a.magnet_value, a.magnet_checked_at, a.magnet_error,
      a.download_status, a.download_queued_at, a.download_added_at, a.download_torrent_hash, a.download_checked_at, a.download_error,
      a.download_progress, a.download_speed, a.download_size, a.downloaded_bytes, a.download_save_path, a.download_content_path, a.download_removed_at,
      a.jellyfin_status, a.jellyfin_item_id, a.jellyfin_item_name, a.jellyfin_matched_at, a.jellyfin_error,
      s.id AS subscription_id, s.name AS subscription_name, s.url AS subscription_url
    FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
    ${hasSubscriptionId ? 'WHERE a.subscription_id = ?' : ''}
    ORDER BY a.id ASC LIMIT ?`, hasSubscriptionId ? [subscriptionId, limit] : [limit]);
});

app.post('/api/subscriptions/:id/magnet-backfill', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (!getInspectionRules().magnet.enabled) return reply.code(400).send({ error: '磁力检索规则当前已停用，请先在“检查规则”中启用。' });
  const candidates = await db.all<{ id: number }>(`SELECT id FROM archive_entries
    WHERE subscription_id = ? AND magnet_status IN ('unsearched', 'failed') ORDER BY id ASC`, [id]);
  let queued = 0;
  await db.transaction(async (tx) => {
    for (const entry of candidates) {
      await tx.run(`UPDATE archive_entries
        SET magnet_status = 'pending', magnet_value = NULL, magnet_checked_at = NULL, magnet_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), entry.id]);
      if ((await queueMagnetJob(entry.id, tx)).queued) queued += 1;
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
      if ((await queueReleaseJob(entry.id, tx)).queued) queued += 1;
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
    const result = await queueMagnetJob(entry.id, tx);
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
  const settings = { enabled, url, apiKey, libraryIds, syncIntervalMinutes: interval };
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
  const values = { enabled, url, authMode, apiKey, username, password, category, savePath, tags, autoDownload, stopAfterDownload };
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
  const candidates = await db.all<{ id: number }>(`SELECT id FROM archive_entries
    WHERE subscription_id = ? AND magnet_status = 'found' AND magnet_value IS NOT NULL
      AND download_status IN ('not_queued', 'failed') ORDER BY id ASC`, [id]);
  let queued = 0;
  await db.transaction(async (tx) => {
    for (const entry of candidates) {
      const result = await queueDownloadJob(entry.id, tx);
      if (result.queued) {
        queued += 1;
        const now = new Date().toISOString();
        await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
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
    const result = await queueDownloadJob(entry.id, tx);
    queued = result.queued;
    jobId = result.id;
    if (queued) {
      const now = new Date().toISOString();
      await tx.run(`UPDATE archive_entries SET download_status = 'queued', download_queued_at = ?, download_error = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
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
      setSetting('qbit_stop_after_download', settings.stopAfterDownload ? '1' : '0')
    ]);
    return publicQbittorrentSettings();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存 qBittorrent 设置。' });
  }
});

app.post('/api/settings/qbittorrent/test', async (_request, reply) => {
  try {
    const settings = getQbittorrentSettings();
    await testQbittorrentConnection(settings);
    await appendRuntimeLog({ level: 'success', source: 'download', message: `qBittorrent 连接测试成功（${normalizeQbittorrentUrl(settings.url)}）。` });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'qBittorrent 连接测试失败。';
    await appendRuntimeLog({ level: 'error', source: 'download', message: `qBittorrent 连接测试失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.get('/api/settings/jellyfin', async () => publicJellyfinSettings());
app.put('/api/settings/jellyfin', async (request, reply) => {
  try {
    const settings = normalizeJellyfinSettings(request.body as JellyfinSettingsPayload);
    const now = new Date().toISOString();
    await Promise.all([
      setSetting('jellyfin_enabled', settings.enabled ? '1' : '0'),
      setSetting('jellyfin_url', settings.url),
      setSetting('jellyfin_api_key', settings.apiKey),
      setSetting('jellyfin_library_ids', JSON.stringify(settings.libraryIds)),
      setSetting('jellyfin_sync_interval_minutes', String(settings.syncIntervalMinutes)),
      setSetting('jellyfin_last_synced_at', '')
    ]);
    await db.run(`UPDATE archive_entries SET jellyfin_status = ?, jellyfin_item_id = NULL, jellyfin_item_name = NULL,
      jellyfin_matched_at = NULL, jellyfin_error = NULL, updated_at = ?`, [settings.enabled && settings.libraryIds.length ? 'pending' : 'unconfigured', now]);
    return publicJellyfinSettings();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存 Jellyfin 设置。' });
  }
});

app.post('/api/settings/jellyfin/test', async (_request, reply) => {
  try {
    const settings = getJellyfinSettings();
    const [server, libraries] = await Promise.all([testJellyfinConnection(settings), listJellyfinLibraries(settings)]);
    await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 连接测试成功（${server.serverName}${server.version ? ` ${server.version}` : ''}），发现 ${libraries.length} 个媒体库。` });
    return { ok: true, server, libraries };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Jellyfin 连接测试失败。';
    await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 连接测试失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.post('/api/settings/jellyfin/sync', async (_request, reply) => {
  try {
    const result = await syncJellyfinLibrary('manual');
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Jellyfin 影视库同步失败。';
    await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 影视库手动同步失败：${message}` });
    return reply.code(400).send({ error: message });
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
    await tx.run('DELETE FROM archive_entries WHERE subscription_id = ?', [id]);
    await tx.run('DELETE FROM jobs WHERE subscription_id = ?', [id]);
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
    await tx.run('DELETE FROM archive_entries WHERE subscription_id = ?', [id]);
    await tx.run("DELETE FROM jobs WHERE subscription_id = ? AND status = 'queued'", [id]);
    await tx.run(`UPDATE subscriptions
      SET last_checked_at = NULL, last_hash = NULL, last_content = NULL, last_error = NULL,
        initial_scan_completed = CASE WHEN pagination_selector IS NULL THEN 1 ELSE 0 END,
        initial_scan_total = NULL, initial_scan_pages_completed = 0, updated_at = ?
      WHERE id = ?`, [now, id]);
  });
  return reply.code(204).send();
});

app.post('/api/subscriptions/preview', async (request, reply) => {
  try {
    const values = await normalizePayload(request.body as SubscriptionPayload);
    return await previewCapture({ url: values.url, selector: values.selector, render_mode: values.renderMode as Subscription['render_mode'], content_source: values.contentSource as Subscription['content_source'], attribute_name: values.attributeName, match_pattern: values.matchPattern, title_selector: values.titleSelector, title_content_source: values.titleContentSource as Subscription['title_content_source'], title_attribute_name: values.titleAttributeName, title_match_pattern: values.titleMatchPattern, result_mode: values.resultMode as Subscription['result_mode'] });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '预览失败。' });
  }
});

app.post('/api/subscriptions/:id/run', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  const queued = await queueJob(id);
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, jobId: queued.id, message: queued.queued ? '已加入立即检查队列。' : '检查已在队列中或正在执行。' });
  return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
});

app.post('/api/subscriptions/:id/full-scan', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (!subscription.pagination_selector) return reply.code(400).send({ error: '当前订阅没有配置全量分页检查。' });
  await db.run(`UPDATE subscriptions SET initial_scan_completed = 0, initial_scan_total = NULL, initial_scan_pages_completed = 0, last_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  const queued = await queueJob(id);
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, jobId: queued.id, message: queued.queued ? '已加入全量检查队列。' : '全量检查设置已更新，当前检查结束后可再次确认日志。' });
  return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
});

const dist = path.resolve(process.cwd(), 'dist');
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
}

app.listen({ port, host: '0.0.0.0' }).then(() => {
  const beat = () => void reportWorkerHeartbeat('api', `网页服务监听端口 ${port}`).catch((error) => app.log.warn(`Unable to save API heartbeat: ${error instanceof Error ? error.message : String(error)}`));
  beat();
  setInterval(beat, 15_000);
  void appendRuntimeLog({ level: 'info', source: 'system', message: `网页服务已启动，监听端口 ${port}。` })
    .catch((error) => app.log.warn(`Unable to save service startup log: ${error instanceof Error ? error.message : String(error)}`));
}).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

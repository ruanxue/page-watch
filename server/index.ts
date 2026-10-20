import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { assertSafeUrl as validateSafeUrl } from './url-safety.js';
import { appendRuntimeLog, configureDatabase, databaseConfigurationError, databaseConfigurationSource, db, getIntegrationStatuses, getJellyfinSettings, getOutboundProxyUrl, getQbittorrentSettings, getRuntimeMetrics, getRuntimeSettings, getSetting, getSubscription, isDatabaseConfigured, JOB_PRIORITY, maintainPerformanceMetrics, queueDownloadJob, queueJob, queueLibraryJob, queueLibrarySyncJob, queueMagnetJob, queueReleaseJob, rebuildSubscriptionProgress, refreshSettings, reportIntegrationStatus, reportRuntimeMetrics, reportWorkerHeartbeat, setRuntimeSettings, setSetting, type DatabaseClient, type IntegrationService, type Subscription } from './db.js';
import { assertQbittorrentConfig, getQbittorrentTorrentStates, normalizeQbittorrentUrl, testQbittorrentConnection, torrentHashFromMagnet } from './qbittorrent.js';
import { assertJellyfinConfig, listJellyfinLibraries, normalizeJellyfinUrl, testJellyfinConnection } from './jellyfin.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';
import { clearJellyfinMediaIndex } from './jellyfin-cache.js';
import { authenticate, clearSessionCookie, configurePassword, createSession, revokeSessions, sessionCookie, statusFor, validatePassword } from './auth.js';
import { getInspectionRules } from './inspection-rules.js';
import { BUILTIN_GROUP_NAME, legacyMissavGroupName } from './rule-groups.js';
import { emitLive, registerLiveRoutes, startLivePolling } from './sse-hub.js';
import { assertSafeUrl, normalizePayload, resolveMissavPayload, type SubscriptionPayload } from './subscription-payload.js';
import { authPath, clearLoginFailures, loginAllowed, privateJson, pruneLoginFailures, recordFailedLogin, tokensMatch, trustProxyOption } from './http-guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerArchiveRoutes } from './routes/archive.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerRulesRoutes } from './routes/rules.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSubscriptionsRoutes } from './routes/subscriptions.js';
import { listSubscriptions } from './subscriptions-query.js';
import { ExecutionEngineController } from './engine-controller.js';
import { EngineWakeScheduler } from './engine-wake-scheduler.js';
import { createTestNotification, deliverNotification, getNotificationSettings, normalizeNotificationSettings, publicNotificationSettings, saveNotificationSettings, type NotificationSettingsPayload } from './notifications.js';
import { buildMissavActressSubscriptionUrl, normalizeMissavActressIdentity, normalizeProductCode, productCodeKeys } from './code-search-parser.js';
import { backfillArchiveCodeIndex, findArchiveCodeMatches, replaceArchiveCodes } from './archive-code-index.js';
import { webExecutor } from './web-executor-client.js';

// Docker creates a random private token in its entry script. Keep a fixed,
// loopback-only fallback for `npm run dev`, so the on-demand child can still
// publish task and SSE events without a separate supervisor.
if (!process.env.WORKER_EVENT_TOKEN && process.env.NODE_ENV !== 'production') process.env.WORKER_EVENT_TOKEN = 'page-watch-dev-runner';

// 网页服务只负责接口与调度，所有 Worker 都由统一执行引擎按需拉起；在模块加载
// 阶段就关闭自启动，避免动态 import 下载观察器时在本进程里意外注册定时器。
process.env.PAGE_WATCH_WORKER_AUTOSTART = '0';

const app = Fastify({
  logger: { level: 'warn' },
  // 反向代理（NAS 常见）后面必须显式开启，否则 request.ip 永远拿到代理地址，
  // 登录失败限流会把所有用户当成同一个 IP。默认关闭，避免被伪造的
  // X-Forwarded-For 绕过限流。
  trustProxy: trustProxyOption()
});
await app.register(fastifyCompress, { encodings: ['br', 'gzip'], threshold: 1024 });

// 生产构建下补一组基础安全响应头。开发模式放宽，避免 Vite 的 HMR
// 内联脚本与 WebSocket 被 CSP 拦掉。
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    reply.header('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '));
  }
  return payload;
});
const port = Number(process.env.PORT ?? 3030);
const engineController = new ExecutionEngineController();
const engineWakeScheduler = new EngineWakeScheduler(engineController);

app.addHook('onResponse', (request, reply, done) => {
  const path = request.url.split('?')[0];
  const queuesWork = request.method === 'POST' && (
    /^\/api\/subscriptions\/\d+\/(run|full-scan|release-backfill|magnet-backfill|download-backfill)$/.test(path)
    || /^\/api\/archive\/\d+\/(magnet-retry|download)$/.test(path)
    || path === '/api/code-search/subscribe'
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

type SearchRelease =
  | { status: 'found'; releaseDate: string }
  | { status: 'unavailable' | 'failed'; reason: string }
  | { status: 'pending' };
type SearchMagnet =
  | { status: 'found'; value: string }
  | { status: 'not_found' | 'failed' | 'disabled'; reason: string }
  | { status: 'pending' };
type CodeSearchSession = {
  id: string;
  code: string;
  title: string | null;
  detailUrl: string;
  releaseDate: SearchRelease;
  magnet: SearchMagnet;
  performers: Array<{ name: string; url: string }>;
  performerError: string | null;
  createdAt: number;
};
const codeSearchSessions = new Map<string, CodeSearchSession>();
const codeSearchSessionTtlMs = 15 * 60_000;
const codeSearchSessionLimit = 100;
const codeSearchSubscriptionLocks = new Map<string, Promise<void>>();

function rememberCodeSearchSession(session: Omit<CodeSearchSession, 'id' | 'createdAt'>) {
  const now = Date.now();
  for (const [id, item] of codeSearchSessions) if (now - item.createdAt > codeSearchSessionTtlMs) codeSearchSessions.delete(id);
  while (codeSearchSessions.size >= codeSearchSessionLimit) codeSearchSessions.delete(codeSearchSessions.keys().next().value!);
  const item: CodeSearchSession = { ...session, id: randomUUID(), createdAt: now };
  codeSearchSessions.set(item.id, item);
  return item;
}

function getCodeSearchSession(id: unknown) {
  if (typeof id !== 'string') return null;
  const session = codeSearchSessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > codeSearchSessionTtlMs) { codeSearchSessions.delete(id); return null; }
  return session;
}

async function withCodeSearchSubscriptionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = codeSearchSubscriptionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  codeSearchSubscriptionLocks.set(key, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (codeSearchSubscriptionLocks.get(key) === current) codeSearchSubscriptionLocks.delete(key);
  }
}

startLivePolling(app);

app.addHook('onRequest', async (request, reply) => {
  const requestPath = authPath(request.url);
  // CSRF 纵深防护：用浏览器自动附加的 Sec-Fetch-Site 判断来源，而不是比较
  // Origin 与 Host —— 经过 Vite 代理或反向代理时 Host 会被改写，比较 Host 会
  // 把正常的同源登录也拒掉。same-origin/none 放行，其余（cross-site 等）拒绝；
  // 不带该头的请求来自 curl、内部 Worker 或旧浏览器，交给 SameSite=Lax 兜底。
  if (requestPath.startsWith('/api/') && request.method !== 'GET' && request.method !== 'HEAD') {
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') {
      return reply.code(403).send({ error: '请求来源与当前站点不一致，已拒绝。' });
    }
  }
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

app.get('/api/health', async () => ({ ok: true }));
registerLiveRoutes(app);
registerAuthRoutes(app, { startOperationalServices });
await registerOperationsRoutes(app);
registerRulesRoutes(app);

app.post('/api/code-search', async (request, reply) => {
  const input = (request.body ?? {}) as { code?: unknown };
  const code = typeof input.code === 'string' ? normalizeProductCode(input.code) : null;
  if (!code) return reply.code(400).send({ error: '请输入有效番号，例如 MEYD-568 或 meyd568。' });
  const codeKey = code.toLowerCase();
  const matches = await findArchiveCodeMatches(db, [codeKey]);
  const ids = [...new Set(matches.map((row) => row.id))];
  // 结果最终只用前 100 条，所以这里也只取 100 行正文：a.content 是这批数据里
  // 最大的字段，按 500 行取回来再丢掉 400 行是纯浪费（单次请求可能多占几十 MB）。
  const archivedCandidates = ids.length ? await db.all<{
    id: number; content: string; archive_code: string | null; title: string | null; detail_url: string | null; first_seen_at: string;
    release_date: string | null; release_status: string; release_error: string | null;
    magnet_status: string; magnet_value: string | null; magnet_error: string | null;
    subscription_id: number; subscription_name: string; subscription_url: string;
  }>(`SELECT a.id, a.content, a.title, a.detail_url, a.first_seen_at, a.release_date, a.release_status, a.release_error,
      a.archive_code, a.magnet_status, a.magnet_value, a.magnet_error, s.id AS subscription_id, s.name AS subscription_name, s.url AS subscription_url
    FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id
    WHERE a.id IN (${ids.map(() => '?').join(', ')})
    ORDER BY a.first_seen_at DESC, a.id DESC LIMIT 100`, ids) : [];
  const archived = archivedCandidates.filter((item) => item.archive_code?.toLowerCase() === codeKey || productCodeKeys(item.content).includes(codeKey) || productCodeKeys(item.title ?? '').includes(codeKey)).slice(0, 100);
  if (archived.length) return { source: 'archive', code, items: archived };

  try {
    const result = await webExecutor.codeSearch(code, JOB_PRIORITY.manual);
    if (result.status === 'not_found') return { source: 'not_found', code: result.code };
    const film = result.film;
    const rules = getInspectionRules();
    const session = rememberCodeSearchSession({
      code: film.code,
      title: film.title,
      detailUrl: film.detailUrl,
      releaseDate: result.releaseDate,
      magnet: rules.magnet.enabled ? { status: 'pending' } : { status: 'disabled', reason: '磁力检索规则已停用。' },
      performers: film.performers,
      performerError: film.performerError
    });
    return {
      source: 'missav', searchId: session.id, code: session.code, title: session.title,
      detailUrl: session.detailUrl, releaseDate: session.releaseDate,
      magnet: session.magnet, performers: session.performers, performerError: session.performerError
    };
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : 'MissAV 番号检索失败。' });
  }
});

app.post('/api/code-search/performers', async (request, reply) => {
  const input = (request.body ?? {}) as { archiveEntryId?: unknown };
  const archiveEntryId = Number(input.archiveEntryId);
  if (!Number.isInteger(archiveEntryId) || archiveEntryId < 1) return reply.code(400).send({ error: '档案记录标识无效。' });
  const item = await db.get<{
    id: number; content: string; title: string | null; detail_url: string | null;
    release_date: string | null; release_status: string; release_error: string | null;
    magnet_status: string; magnet_value: string | null; magnet_error: string | null;
  }>('SELECT id, content, title, detail_url, release_date, release_status, release_error, magnet_status, magnet_value, magnet_error FROM archive_entries WHERE id = ?', [archiveEntryId]);
  if (!item) return reply.code(404).send({ error: '内容档案记录不存在。' });
  if (!item.detail_url) return reply.code(409).send({ error: '这条档案没有详情页链接，无法读取女优信息。' });
  const code = normalizeProductCode(item.content);
  if (!code) return reply.code(409).send({ error: `档案内容“${item.content}”不是可检索番号。` });
  try {
    const performers = await webExecutor.performers(item.detail_url);
    const releaseDate: SearchRelease = item.release_status === 'found' && item.release_date
      ? { status: 'found', releaseDate: item.release_date }
      : item.release_status === 'unsearched' || item.release_status === 'pending'
        ? { status: 'pending' }
        : { status: item.release_status === 'failed' ? 'failed' : 'unavailable', reason: item.release_error || '没有可用的发行日期。' };
    const magnet: SearchMagnet = item.magnet_status === 'found' && item.magnet_value
      ? { status: 'found', value: item.magnet_value }
      : item.magnet_status === 'not_found'
        ? { status: 'not_found', reason: item.magnet_error || '没有找到磁力链接。' }
        : item.magnet_status === 'failed'
          ? { status: 'failed', reason: item.magnet_error || '磁力检索失败。' }
          : { status: 'pending' };
    const session = rememberCodeSearchSession({ code, title: item.title, detailUrl: item.detail_url, releaseDate, magnet, performers, performerError: performers.length ? null : '影片详情页没有找到“女优”字段或女优链接。' });
    return { searchId: session.id, performers, performerError: session.performerError };
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : '无法读取影片详情页的女优信息。' });
  }
});

app.post('/api/code-search/magnet', async (request, reply) => {
  const input = (request.body ?? {}) as { searchId?: unknown; retry?: unknown };
  const session = getCodeSearchSession(input.searchId);
  if (!session) return reply.code(410).send({ error: '检索结果已过期，请重新检索番号。' });
  const rule = getInspectionRules().magnet;
  if (!rule.enabled) {
    session.magnet = { status: 'disabled', reason: '磁力检索规则已停用。' };
    return { magnet: session.magnet };
  }
  if (session.magnet.status !== 'pending' && !(input.retry === true && session.magnet.status === 'failed')) return { magnet: session.magnet };
  try {
    const result = await webExecutor.magnet(session.code, rule);
    session.magnet = result.status === 'found' ? { status: 'found', value: result.value } : { status: 'not_found', reason: result.reason };
    return { magnet: session.magnet };
  } catch (error) {
    session.magnet = { status: 'failed', reason: error instanceof Error ? error.message : '磁力检索失败。' };
    return { magnet: session.magnet };
  }
});

app.post('/api/code-search/subscribe', async (request, reply) => {
  const input = (request.body ?? {}) as { searchId?: unknown; actressUrl?: unknown };
  const session = getCodeSearchSession(input.searchId);
  if (!session) return reply.code(410).send({ error: '检索结果已过期，请重新检索番号。' });
  if (typeof input.actressUrl !== 'string') return reply.code(400).send({ error: '缺少女优链接。' });
  const actressIdentity = normalizeMissavActressIdentity(input.actressUrl);
  const performer = actressIdentity ? session.performers.find((item) => normalizeMissavActressIdentity(item.url) === actressIdentity) : undefined;
  if (!performer || !actressIdentity) return reply.code(400).send({ error: '该女优链接不属于本次影片检索结果，请重新读取女优信息。' });

  let actress: { name: string; profileUrl: string };
  try { actress = await webExecutor.actressName(performer.url); }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : '无法读取女优页面名称。' }); }
  return withCodeSearchSubscriptionLock(actressIdentity, async () => {
    const subscriptionUrl = buildMissavActressSubscriptionUrl(performer.url);
    try {
    const existingUrls = await db.all<{ id: number; url: string; initial_scan_completed: number; initial_scan_run_id: string | null; pagination_selector: string | null; last_hash: string | null }>('SELECT id, url, initial_scan_completed, initial_scan_run_id, pagination_selector, last_hash FROM subscriptions');
    const duplicate = existingUrls.find((item) => {
      try {
        const url = new URL(item.url);
        return url.searchParams.get('filters') === 'individual' && normalizeMissavActressIdentity(item.url) === actressIdentity;
      } catch { return false; }
    });
    let presetValues: Awaited<ReturnType<typeof normalizePayload>> | null = null;
    let presetIdForNewSubscription: number | null = null;
    if (!duplicate) {
      const preset = await db.get<{
        id: number;
        selector: string; render_mode: string; content_source: string; attribute_name: string | null; match_pattern: string | null;
        title_selector: string | null; title_content_source: string; title_attribute_name: string | null; title_match_pattern: string | null;
        result_mode: string; interval_minutes: number; pagination_selector: string | null; pagination_parameter: string; pagination_match_pattern: string | null;
      }>("SELECT id, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern FROM subscription_presets ORDER BY CASE WHEN name IN (?, ?) THEN 0 ELSE 1 END, id ASC LIMIT 1", [BUILTIN_GROUP_NAME, legacyMissavGroupName]);
      if (!preset) return reply.code(409).send({ error: `找不到“${BUILTIN_GROUP_NAME}”规则组，请在检查规则中恢复该规则组后重试。` });
      presetValues = await normalizePayload({
        name: actress.name, url: subscriptionUrl, selector: preset.selector,
        renderMode: preset.render_mode === 'dynamic' ? 'dynamic' : 'static',
        contentSource: preset.content_source === 'attribute' ? 'attribute' : 'text',
        attributeName: preset.attribute_name ?? '', matchPattern: preset.match_pattern ?? '',
        titleSelector: preset.title_selector ?? '', titleContentSource: preset.title_content_source === 'attribute' ? 'attribute' : 'text',
        titleAttributeName: preset.title_attribute_name ?? '', titleMatchPattern: preset.title_match_pattern ?? '',
        resultMode: preset.result_mode === 'all' ? 'all' : 'first', intervalMinutes: preset.interval_minutes,
        scheduleType: 'hourly', scheduleIntervalHours: Math.max(1, Math.min(168, Math.round(preset.interval_minutes / 60))),
        isActive: true, paginationSelector: preset.pagination_selector ?? '', paginationParameter: preset.pagination_parameter ?? 'page',
        paginationMatchPattern: preset.pagination_match_pattern ?? ''
      });
      presetIdForNewSubscription = preset.id;
    }

    let fullScanBatchId: string | null = null;
    if (duplicate && !duplicate.initial_scan_completed && duplicate.pagination_selector) {
      const pendingBatch = await db.get<{ id: string }>(`SELECT id FROM full_scan_batches WHERE subscription_id = ? AND status = 'scanning' ORDER BY created_at DESC, id DESC LIMIT 1`, [duplicate.id]);
      fullScanBatchId = duplicate.initial_scan_run_id ?? pendingBatch?.id ?? randomUUID();
    } else if (!duplicate && presetValues?.paginationSelector) {
      fullScanBatchId = randomUUID();
    }

    const now = new Date().toISOString();
    const rules = getInspectionRules();
    const jellyfin = getJellyfinSettings();
    const result = await db.transaction(async (tx) => {
      let subscriptionId = duplicate?.id ?? 0;
      let created = false;
      if (!subscriptionId && presetValues) {
        const inserted = await tx.run(`INSERT INTO subscriptions
          (name, url, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, schedule_type, schedule_interval_hours, schedule_time, schedule_weekday, is_active, pagination_selector, pagination_parameter, pagination_match_pattern, rule_family, preset_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actress.name, subscriptionUrl, presetValues.selector, presetValues.renderMode, presetValues.contentSource, presetValues.attributeName, presetValues.matchPattern, presetValues.titleSelector, presetValues.titleContentSource, presetValues.titleAttributeName, presetValues.titleMatchPattern, presetValues.resultMode, presetValues.interval, presetValues.scheduleType, presetValues.scheduleIntervalHours, presetValues.scheduleTime, presetValues.scheduleWeekday, presetValues.isActive, presetValues.paginationSelector, presetValues.paginationParameter, presetValues.paginationMatchPattern, 'missav', presetIdForNewSubscription, now, now]);
        subscriptionId = inserted.lastInsertRowid;
        created = true;
      }

      if (fullScanBatchId) {
        await tx.run(`INSERT IGNORE INTO full_scan_batches (id, subscription_id, subscription_name, status, is_initial, page_count, scanned_count, archived_count, created_at)
          VALUES (?, ?, ?, 'scanning', ?, NULL, 0, 0, ?)`,
        [fullScanBatchId, subscriptionId, actress.name, duplicate?.last_hash ? 0 : 1, now]);
      }

      const existingCandidates = await findArchiveCodeMatches(tx, [session.code.toLowerCase()], subscriptionId, false);
      const existingEntry = existingCandidates[0];
      let archiveEntryId = existingEntry?.id ?? 0;
      const addedToArchive = !existingEntry;
      if (!existingEntry) {
        const useLibraryFirst = session.magnet.status === 'pending' && rules.magnet.enabled && jellyfin.enabled && jellyfin.libraryIds.length > 0 && jellyfin.skipMagnetWhenAvailable;
        const magnetStatus = session.magnet.status === 'found' ? 'found'
          : session.magnet.status === 'not_found' ? 'not_found'
            : session.magnet.status === 'failed' ? 'failed'
              : session.magnet.status === 'disabled' || !rules.magnet.enabled || useLibraryFirst ? 'unsearched' : 'pending';
        const releaseStatus = session.releaseDate.status === 'found' ? 'found'
          : session.releaseDate.status === 'pending' && rules.releaseDate.enabled ? 'pending'
            : session.releaseDate.status === 'failed' ? 'failed' : 'unavailable';
        const releaseError = session.releaseDate.status === 'found' ? null
          : session.releaseDate.status === 'pending' && !rules.releaseDate.enabled ? '发行日期检索规则已停用。'
            : session.releaseDate.status === 'pending' ? null : session.releaseDate.reason;
        const magnetError = session.magnet.status === 'found' ? null
          : session.magnet.status === 'pending' && !rules.magnet.enabled ? '磁力检索规则已停用。'
            : session.magnet.status === 'pending' && useLibraryFirst ? null
              : session.magnet.status === 'pending' ? null : session.magnet.reason;
        const inserted = await tx.run(`INSERT INTO archive_entries
          (subscription_id, content, title, archive_code, content_hash, first_seen_at, detail_url, release_date, release_status, release_checked_at, release_error, magnet_status, magnet_value, magnet_checked_at, magnet_error, auto_download_suppressed, jellyfin_status, full_scan_batch_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [subscriptionId, session.code, session.title, session.code.toLowerCase(), createHash('sha256').update(session.code.toLowerCase()).digest('hex'), now, session.detailUrl,
          session.releaseDate.status === 'found' ? session.releaseDate.releaseDate : null, releaseStatus, releaseStatus === 'pending' ? null : now, releaseError,
          magnetStatus, session.magnet.status === 'found' ? session.magnet.value : null, magnetStatus === 'pending' ? null : now, magnetError,
          useLibraryFirst ? 'pending' : 'unconfigured', fullScanBatchId, now]);
        archiveEntryId = inserted.lastInsertRowid;
        await replaceArchiveCodes(tx, [{ id: archiveEntryId, subscription_id: subscriptionId, content: session.code, title: session.title }]);
        if (releaseStatus === 'pending') await queueReleaseJob(archiveEntryId, tx);
        if (useLibraryFirst) await queueLibraryJob(archiveEntryId, tx);
        else if (magnetStatus === 'pending') await queueMagnetJob(archiveEntryId, tx);
      } else if (fullScanBatchId) {
        await tx.run('UPDATE archive_entries SET full_scan_batch_id = ? WHERE id = ? AND full_scan_batch_id IS NULL', [fullScanBatchId, archiveEntryId]);
      }
      await rebuildSubscriptionProgress(subscriptionId, tx);
      return { subscriptionId, archiveEntryId, created, addedToArchive };
    });
    emitLive('subscriptions');
    emitLive('archive', result.subscriptionId);
    emitLive('tasks');
    const subscription = await getSubscription(result.subscriptionId);
    return reply.code(result.created ? 201 : 200).send({ ...result, subscription, actressName: actress.name });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建女优订阅。' });
    }
  });
});

registerArchiveRoutes(app);
await registerSettingsRoutes(app, { wakeEngine: (reason) => engineWakeScheduler.wake(reason) });
registerSubscriptionsRoutes(app, { wakeEngine: (reason) => engineWakeScheduler.wake(reason) });
const dist = path.resolve(process.cwd(), 'dist');
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, {
    root: dist,
    wildcard: false,
    // @fastify/static v10 起，setHeaders 的第一个参数是 Fastify 的 reply，
    // 不再是 Node 的 ServerResponse，因此必须用 reply.header() 设置响应头。
    setHeaders(reply, filePath) {
      const cacheControl = /[/\\]assets[/\\].*-[A-Za-z0-9_-]{8,}\./.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache';
      void reply.header('Cache-Control', cacheControl);
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
  const backfillCodes = () => void backfillArchiveCodeIndex().catch((error) => {
    app.log.warn(`Unable to backfill archive code index: ${error instanceof Error ? error.message : String(error)}`);
    setTimeout(backfillCodes, 60_000).unref();
  });
  backfillCodes();
  const beat = async () => {
    await reportWorkerHeartbeat('api', `网页服务监听端口 ${port}`).catch((error) => app.log.warn(`Unable to save API heartbeat: ${error instanceof Error ? error.message : String(error)}`));
    if (engineController.snapshot().state === 'sleeping') {
      const sleepingWorkers = ([
        ['capture', '检查 Worker 按需休眠'],
        ['release', '发行日期 Worker 按需休眠'],
        ['magnet', '磁力检索 Worker 按需休眠'],
        ['library', '影视库同步 Worker 按需休眠']
      ] as const).map(([name, detail]) => reportWorkerHeartbeat(name, detail, 'sleeping'));
      sleepingWorkers.push((async () => {
        const work = await db.get<{ count: number }>(`SELECT
          (SELECT COUNT(*) FROM download_jobs WHERE status IN ('queued', 'running')) +
          (SELECT COUNT(*) FROM archive_entries WHERE download_status IN ('queued', 'running', 'added', 'waiting', 'downloading')) AS count`);
        if (Number(work?.count ?? 0) === 0) await reportWorkerHeartbeat('download', '下载提交 Worker 按需休眠', 'sleeping');
      })());
      await Promise.all(sleepingWorkers).catch(() => undefined);
    }
  };
  void beat();
  setInterval(() => void beat(), 30_000).unref();
  engineWakeScheduler.start();
  engineController.onChange(() => { void beat(); });

  let downloadObserverTimer: NodeJS.Timeout | null = null;
  const scheduleDownloadObserver = async () => {
    try {
      const getDownloadStateCounts = () => db.get<{ active: number; paused: number }>(`SELECT
        SUM(download_status IN ('added', 'waiting', 'downloading')) AS active,
        SUM(download_status = 'paused') AS paused
        FROM archive_entries WHERE download_status IN ('added', 'waiting', 'downloading', 'paused')`);
      const initial = await getDownloadStateCounts();
      const activeCount = Number(initial?.active ?? 0);
      const pausedCount = Number(initial?.paused ?? 0);
      let delay = activeCount > 0 ? 10_000 : 60_000;
      if (activeCount > 0 || pausedCount > 0) {
        const observer = await import('./download-worker.js');
        if (await observer.observeQbittorrentDownloads()) await engineWakeScheduler.wake('下载完成通知已入队');
      }
      const latest = (activeCount > 0 || pausedCount > 0) ? await getDownloadStateCounts() : initial;
      const latestActive = Number(latest?.active ?? 0);
      const latestPaused = Number(latest?.paused ?? 0);
      delay = latestActive > 0 ? 10_000 : 60_000;
      const queued = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM download_jobs WHERE status IN ('queued', 'running')");
      if (latestActive > 0) {
        await reportWorkerHeartbeat('download', `正在轻量同步 ${latestActive} 个 qBittorrent 下载状态`, 'busy');
      } else if (Number(queued?.count ?? 0) === 0) {
        const coldDetails = [latestPaused > 0 ? `${latestPaused} 个 qBittorrent 下载已暂停` : ''].filter(Boolean);
        const detail = coldDetails.length ? `${coldDetails.join('；')}（每 60 秒检查）` : '下载提交 Worker 按需休眠';
        await reportWorkerHeartbeat('download', detail, 'sleeping');
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

/**
 * 网页服务是唯一永不退出的进程，因此也最需要一条“只观察、只告警”的兜底线。
 * 它不做重启（会掐断 SSE 与登录会话），只在 RSS 超出阈值时记录一次日志，
 * 并在进程带 --expose-gc 时顺手做一次受控 GC。登录失败表也顺带定期裁剪。
 */
function startApiMemoryGuard() {
  const configured = Number(process.env.APP_MEMORY_GUARD_MB);
  const thresholdMb = Number.isFinite(configured) && configured > 0 ? Math.min(4096, Math.max(64, configured)) : 256;
  const thresholdBytes = thresholdMb * 1024 * 1024;
  const logIntervalMs = 30 * 60_000;
  const pruneIntervalMs = 5 * 60_000;
  let lastLoggedAt = 0;
  let lastPrunedAt = Date.now();
  const guard = () => {
    const now = Date.now();
    if (now - lastPrunedAt >= pruneIntervalMs) {
      lastPrunedAt = now;
      pruneLoginFailures(now);
    }
    const before = process.memoryUsage().rss;
    if (before <= thresholdBytes) return;
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (gc) gc();
    // 只在第一次越过阈值和之后每 30 分钟说一次，避免把日志表刷满。
    if (now - lastLoggedAt < logIntervalMs) return;
    lastLoggedAt = now;
    const after = Math.round(process.memoryUsage().rss / 1024 / 1024);
    void appendRuntimeLog({
      level: 'info',
      source: 'system',
      message: `网页服务进程内存偏高：RSS 约 ${Math.round(before / 1024 / 1024)}MB（告警阈值 ${thresholdMb}MB）`
        + (gc ? `，已执行受控 GC，现约 ${after}MB。` : `，当前进程未开启受控 GC（${after}MB）。`)
        + ' 若持续上涨，请在运行中心查看各进程内存。'
    }).catch(() => undefined);
  };
  const timer = setInterval(guard, 60_000);
  timer.unref();
}

app.listen({ port, host: '0.0.0.0' }).then(() => {
  startRuntimeMemoryReporter('api');
  startApiMemoryGuard();
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

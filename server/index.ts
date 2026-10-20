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
import { defaultInspectionRules, getInspectionRules, inspectionRulesJson, normalizeInspectionRules, normalizeSiteUrl } from './inspection-rules.js';
import {
  BUILTIN_GROUP_NAME,
  applyBuiltinStepFlags,
  coerceRuleGroupReading,
  coerceSupplementSteps,
  collectReadingIssues,
  collectSupplementStepIssues,
  coerceRuleGroup,
  isBuiltinGroup,
  legacyMissavGroupName,
  normalizeRuleGroupDescription,
  normalizeRuleGroupName,
  normalizeRuleGroupSites,
  parseSitesJson,
  parseStepsJson,
  removedBuiltinSteps,
  serializeSitesJson,
  serializeStepsJson,
  type RuleGroup,
  type RuleGroupReading,
  type SupplementStep
} from './rule-groups.js';
import { emitLive, registerLiveRoutes, startLivePolling } from './sse-hub.js';
import { assertSafeUrl, normalizePayload, normalizePaginationPayload, normalizePresetPayload, resolveMissavPayload, updatePresetList, type MissavPresetListPayload, type MissavRulesPayload, type SubscriptionPayload, type SubscriptionPresetPayload } from './subscription-payload.js';
import { authPath, clearLoginFailures, loginAllowed, privateJson, pruneLoginFailures, recordFailedLogin, tokensMatch, trustProxyOption } from './http-guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerSettingsRoutes } from './routes/settings.js';
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

async function syncSubscriptionsFromPresets(tx: Pick<DatabaseClient, 'run'>, now: string, presetId?: number) {
  const filter = presetId === undefined ? '' : ' AND p.id = ?';
  const params = presetId === undefined ? [] : [presetId];
  await tx.run(`UPDATE subscriptions s JOIN subscription_presets p ON p.id=s.preset_id
    SET s.initial_scan_completed=0, s.initial_scan_total=NULL, s.initial_scan_pages_completed=0, s.initial_scan_next_page=1
    WHERE s.rule_family='missav' AND s.pagination_selector IS NULL AND p.pagination_selector IS NOT NULL AND s.initial_scan_run_id IS NULL${filter}`, params);
  await tx.run(`UPDATE subscriptions s JOIN subscription_presets p ON p.id=s.preset_id SET
    s.selector=p.selector, s.render_mode=COALESCE(s.render_mode_override,p.render_mode), s.content_source=p.content_source,
    s.attribute_name=p.attribute_name, s.match_pattern=p.match_pattern, s.title_selector=p.title_selector,
    s.title_content_source=p.title_content_source, s.title_attribute_name=p.title_attribute_name,
    s.title_match_pattern=p.title_match_pattern, s.result_mode=p.result_mode, s.pagination_selector=p.pagination_selector,
    s.pagination_parameter=p.pagination_parameter, s.pagination_match_pattern=p.pagination_match_pattern, s.updated_at=?
    WHERE s.rule_family='missav'${filter}`, [now, ...params]);
}

/**
 * 数据库里的一组检查规则。读取列沿用 subscription_presets 原有字段，新增的只有
 * sites_json / steps_json 两列 JSON。
 */
type RuleGroupRow = {
  id: number;
  name: string;
  description: string;
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
  pagination_selector: string | null;
  pagination_parameter: string;
  pagination_match_pattern: string | null;
  is_active: number;
  sites_json: string | null;
  steps_json: string | null;
};

const RULE_GROUP_COLUMNS = `id, name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, sites_json, steps_json`;

/** 行 → 接口对象。站点与步骤损坏时各自回落到空数组，整组规则仍然可读。 */
function ruleGroupFromRow(row: RuleGroupRow): RuleGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sites: parseSitesJson(row.sites_json),
    steps: parseStepsJson(row.steps_json),
    reading: {
      selector: row.selector,
      renderMode: row.render_mode === 'dynamic' ? 'dynamic' : 'static',
      contentSource: row.content_source === 'attribute' ? 'attribute' : 'text',
      attributeName: row.attribute_name ?? '',
      matchPattern: row.match_pattern ?? '',
      titleSelector: row.title_selector ?? '',
      titleContentSource: row.title_content_source === 'attribute' ? 'attribute' : 'text',
      titleAttributeName: row.title_attribute_name ?? '',
      titleMatchPattern: row.title_match_pattern ?? '',
      resultMode: row.result_mode === 'all' ? 'all' : 'first',
      intervalMinutes: row.interval_minutes,
      paginationSelector: row.pagination_selector ?? '',
      paginationParameter: row.pagination_parameter || 'page',
      paginationMatchPattern: row.pagination_match_pattern ?? ''
    }
  };
}

/** 读取方式 → 数据库列。复用既有的分页校验，避免两套规则。 */
function ruleGroupReadingColumns(reading: RuleGroupReading) {
  const pagination = normalizePaginationPayload({
    paginationSelector: reading.paginationSelector,
    paginationParameter: reading.paginationParameter,
    paginationMatchPattern: reading.paginationMatchPattern
  });
  return {
    selector: reading.selector.trim(),
    renderMode: reading.renderMode,
    contentSource: reading.contentSource,
    attributeName: reading.contentSource === 'attribute' ? reading.attributeName.trim() || null : null,
    matchPattern: reading.matchPattern.trim() || null,
    titleSelector: reading.titleSelector.trim() || null,
    titleContentSource: reading.titleContentSource,
    titleAttributeName: reading.titleSelector.trim() && reading.titleContentSource === 'attribute' ? reading.titleAttributeName.trim() || null : null,
    titleMatchPattern: reading.titleSelector.trim() ? reading.titleMatchPattern.trim() || null : null,
    resultMode: reading.resultMode,
    interval: reading.intervalMinutes,
    ...pagination
  };
}

function assertReadingValid(reading: RuleGroupReading) {
  const first = Object.values(collectReadingIssues(reading))[0];
  if (first) throw new Error(first);
}

/** 规则组名称在库内唯一，避免订阅选择时看不出差别。 */
async function assertGroupNameAvailable(name: string, excludeId: number | null) {
  const existing = await db.get<{ id: number }>('SELECT id FROM subscription_presets WHERE name = ? AND id <> ? LIMIT 1', [name, excludeId ?? 0]);
  if (existing) throw new Error('已有同名规则组，请换一个名称。');
}

async function loadRuleGroupRow(id: number) {
  return db.get<RuleGroupRow>(`SELECT ${RULE_GROUP_COLUMNS} FROM subscription_presets WHERE id = ?`, [id]);
}

async function loadRuleGroup(id: number): Promise<RuleGroup | null> {
  const row = await loadRuleGroupRow(id);
  return row ? ruleGroupFromRow(row) : null;
}

/**
 * 所有规则组站点的并集。写回 inspection_rules.sites 只是为了让仍然读取全局站点
 * 的旧代码（例如 403 提示、发行日期读取）保持可用；执行层的站点已按规则组解析。
 * 注意 getInspectionRules() 读取时会沿用旧的「最多 5 个」限制，因此这里如实写入
 * 完整并集，由读取方决定截断——抓取主流程不依赖这份全局列表。
 */
async function collectGroupSiteUnion(client: Pick<DatabaseClient, 'all'>) {
  const rows = await client.all<{ sites_json: string | null }>('SELECT sites_json FROM subscription_presets ORDER BY id');
  const union: string[] = [];
  for (const row of rows) {
    for (const site of parseSitesJson(row.sites_json)) {
      if (!union.includes(site)) union.push(site);
    }
  }
  return union;
}

/**
 * 只改写 inspection_rules 的 sites，其余补全规则保持原样。base 用于兼容层把
 * 本次一并提交的发行日期、磁力链接规则合进来。
 */
async function writeInspectionSites(
  client: Pick<DatabaseClient, 'run'>,
  sites: string[],
  now: string,
  base: ReturnType<typeof getInspectionRules> = getInspectionRules()
) {
  const rules = { ...base, sites };
  await client.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('inspection_rules', ?, ?)
    ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [inspectionRulesJson(rules), now]);
  return rules;
}


app.get('/api/health', async () => ({ ok: true }));
registerLiveRoutes(app);
registerAuthRoutes(app, { startOperationalServices });
await registerOperationsRoutes(app);
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
/** 规则组列表；builtinIds 供页面禁止删除内置组。 */
app.get('/api/rule-groups', async () => {
  const rows = await db.all<RuleGroupRow>(`SELECT ${RULE_GROUP_COLUMNS} FROM subscription_presets ORDER BY id ASC`);
  const groups = rows.map(ruleGroupFromRow);
  return {
    groups,
    builtinIds: groups.filter((group) => group.id !== null && isBuiltinGroup(group)).map((group) => group.id as number)
  };
});

/**
 * 新建规则组。名称与读取方式必须合法；适用站点可以为空（不限站点），补充步骤
 * 可以为空。这里只开一个事务写这一组，不影响其他规则组。
 */
app.post('/api/rule-groups', async (request, reply) => {
  try {
    const input = coerceRuleGroup(request.body);
    const name = normalizeRuleGroupName(input.name);
    const description = normalizeRuleGroupDescription(input.description);
    assertReadingValid(input.reading);
    // 新建的规则组没有内置步骤：即使请求里带了 builtin 标记也要去掉，避免普通规则组
    // 变成「不可删除」的内置组。
    const steps = applyBuiltinStepFlags([], coerceSupplementSteps(input.steps));
    const stepIssues = collectSupplementStepIssues(steps);
    if (Object.keys(stepIssues).length) {
      const first = Object.values(stepIssues)[0];
      return reply.code(400).send({ error: first, fields: stepIssues });
    }
    await assertGroupNameAvailable(name, null);
    const now = new Date().toISOString();
    const columns = ruleGroupReadingColumns(input.reading);
    const groupId = await db.transaction(async (tx) => {
      const inserted = await tx.run(`INSERT INTO subscription_presets
        (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, sites_json, steps_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, description, columns.selector, columns.renderMode, columns.contentSource, columns.attributeName, columns.matchPattern,
        columns.titleSelector, columns.titleContentSource, columns.titleAttributeName, columns.titleMatchPattern, columns.resultMode,
        columns.interval, columns.paginationSelector, columns.paginationParameter, columns.paginationMatchPattern, 1,
        serializeSitesJson(input.sites), serializeStepsJson(steps), now, now]);
      // 站点非空时才需要更新全局并集，避免每次新建都重写 inspection_rules。
      if (input.sites.length) await writeInspectionSites(tx, await collectGroupSiteUnion(tx), now);
      return inserted.lastInsertRowid;
    });
    if (input.sites.length) await refreshSettings(true);
    return reply.code(201).send({ group: await loadRuleGroup(groupId) });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建规则组。' });
  }
});

/** 修改名称、说明与「读取方式」；适用站点与补充步骤各有独立接口。 */
app.patch('/api/rule-groups/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
  const current = await loadRuleGroupRow(id);
  if (!current) return reply.code(404).send({ error: '规则组不存在。' });
  try {
    const body = (request.body ?? {}) as { name?: unknown; description?: unknown; reading?: unknown };
    const existing = ruleGroupFromRow(current);
    const name = body.name === undefined ? existing.name : normalizeRuleGroupName(body.name);
    const description = body.description === undefined ? existing.description : normalizeRuleGroupDescription(body.description);
    const reading = body.reading === undefined ? existing.reading : coerceRuleGroupReading(body.reading);
    assertReadingValid(reading);
    if (name !== existing.name) await assertGroupNameAvailable(name, id);
    const columns = ruleGroupReadingColumns(reading);
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, updated_at=? WHERE id=?`,
        [name, description, columns.selector, columns.renderMode, columns.contentSource, columns.attributeName, columns.matchPattern,
          columns.titleSelector, columns.titleContentSource, columns.titleAttributeName, columns.titleMatchPattern, columns.resultMode,
          columns.interval, columns.paginationSelector, columns.paginationParameter, columns.paginationMatchPattern, now, id]);
      // 订阅行保存的是读取配置副本，这里同步一次，改完立刻在下一次检查生效。
      await syncSubscriptionsFromPresets(tx, now, id);
    });
    return { group: await loadRuleGroup(id) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存规则组。' });
  }
});

/** 删除规则组：内置组禁止删除；使用中的订阅改挂到仍存在的规则组上。 */
app.delete('/api/rule-groups/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
  const row = await loadRuleGroupRow(id);
  if (!row) return reply.code(404).send({ error: '规则组不存在。' });
  if (isBuiltinGroup(ruleGroupFromRow(row))) return reply.code(400).send({ error: '内置规则组不能删除，只能修改其中的配置。' });
  const remaining = (await db.all<RuleGroupRow>(`SELECT ${RULE_GROUP_COLUMNS} FROM subscription_presets WHERE id <> ? ORDER BY id ASC`, [id]))
    .map(ruleGroupFromRow);
  if (!remaining.length) return reply.code(400).send({ error: '请至少保留一组检查规则。' });
  const fallback = remaining.find((group) => isBuiltinGroup(group)) ?? remaining[0];
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      if (fallback.id !== null) {
        await tx.run("UPDATE subscriptions SET preset_id=?, updated_at=? WHERE rule_family='missav' AND preset_id=?", [fallback.id, now, id]);
        // 改挂之后重新复制一次读取配置，避免订阅继续使用已删除规则组的旧选择器。
        await syncSubscriptionsFromPresets(tx, now, fallback.id);
      }
      await tx.run('DELETE FROM subscription_presets WHERE id = ?', [id]);
      await writeInspectionSites(tx, await collectGroupSiteUnion(tx), now);
    });
    await refreshSettings(true);
    return { ok: true, reassignedPresetId: fallback.id };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法删除规则组。' });
  }
});

/**
 * 只保存「适用站点」这一段。允许空数组：空表示不限站点，此时抓取直接读取订阅
 * 原地址。成功后把全部规则组的站点并集写回 inspection_rules.sites。
 */
app.put('/api/rule-groups/:id/sites', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
  if (!await loadRuleGroupRow(id)) return reply.code(404).send({ error: '规则组不存在。' });
  try {
    const body = (request.body ?? {}) as { sites?: unknown };
    // 必须显式提交数组：漏传字段与「清空站点」必须区分开。
    if (!Array.isArray(body.sites)) throw new Error('请提交站点数组；不限站点时提交空数组。');
    const sites = normalizeRuleGroupSites(body.sites);
    const now = new Date().toISOString();
    const union = await db.transaction(async (tx) => {
      await tx.run('UPDATE subscription_presets SET sites_json=?, updated_at=? WHERE id=?', [serializeSitesJson(sites), now, id]);
      const next = await collectGroupSiteUnion(tx);
      await writeInspectionSites(tx, next, now);
      return next;
    });
    await refreshSettings(true);
    return { group: await loadRuleGroup(id), sites: union };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存适用站点。' });
  }
});

/**
 * 只保存「补充步骤」这一段（0~5 步）。逐项校验，失败时通过 fields 返回每一步的
 * 具体原因；内置步骤不能删除，只能停用。
 */
app.put('/api/rule-groups/:id/steps', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
  const row = await loadRuleGroupRow(id);
  if (!row) return reply.code(404).send({ error: '规则组不存在。' });
  try {
    const body = (request.body ?? {}) as { steps?: unknown };
    if (!Array.isArray(body.steps)) throw new Error('请提交步骤数组；没有补充步骤时提交空数组。');
    const existing = ruleGroupFromRow(row);
    const steps = applyBuiltinStepFlags(existing.steps, coerceSupplementSteps(body.steps));
    const issues = collectSupplementStepIssues(steps);
    const removed = removedBuiltinSteps(existing.steps, steps);
    if (removed.length) {
      issues.steps = `内置步骤“${removed.map((step) => step.name).join('、')}”不能删除，只能停用。`;
    }
    if (Object.keys(issues).length) {
      return reply.code(400).send({ error: Object.values(issues)[0], fields: issues });
    }
    await db.run('UPDATE subscription_presets SET steps_json=?, updated_at=? WHERE id=?',
      [serializeStepsJson(steps), new Date().toISOString(), id]);
    return { group: await loadRuleGroup(id) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存补充步骤。' });
  }
});

/**
 * 「检查规则」页面把列表读取规则、站点和归档补全放在一起编辑，因此这里提供
 * 一次性保存全部内容的入口：预设列表整体替换，站点与补全规则同时更新。
 */
app.put('/api/rules/missav/presets', async (request, reply) => {
  try {
    const payload = request.body as MissavPresetListPayload;
    const rows = Array.isArray(payload.presets) ? payload.presets : [];
    if (!rows.length) throw new Error('请至少保留一组列表读取规则。');
    if (new Set(rows.map((row) => row.name?.trim())).size !== rows.length) throw new Error('每组读取规则需要不同的名称。');
    const incoming = payload.inspectionRules as Partial<typeof defaultInspectionRules> | undefined;
    if (!Array.isArray(payload.sites) || !payload.sites.length || payload.sites.some((site) => typeof site !== 'string' || !normalizeSiteUrl(site))) throw new Error('请填写至少一个完整的读取站点地址。');
    if (!Array.isArray(incoming?.magnet?.origins) || !incoming.magnet.origins.length) throw new Error('请至少填写一个磁力检索节点。');
    for (const interval of [incoming?.releaseDate?.requestIntervalMs, incoming?.magnet?.requestIntervalMs]) {
      if (!Number.isInteger(interval) || Number(interval) < 250 || Number(interval) > 60000) throw new Error('访问间隔需在 250 到 60000 毫秒之间。');
    }
    const sites = normalizeRuleGroupSites(payload.sites);
    const rules = normalizeInspectionRules({
      sites,
      releaseDate: { ...defaultInspectionRules.releaseDate, renderMode: incoming?.releaseDate?.renderMode, requestIntervalMs: incoming?.releaseDate?.requestIntervalMs, enabled: true },
      magnet: { ...defaultInspectionRules.magnet, origins: incoming?.magnet?.origins, filenamePrefix: incoming?.magnet?.filenamePrefix, fallbackFilenamePrefixes: incoming?.magnet?.fallbackFilenamePrefixes, requestIntervalMs: incoming?.magnet?.requestIntervalMs, enabled: true }
    });
    // 兼容层：老页面仍按「一次性保存」提交。这里改成依次写入三段（读取方式、
    // 适用站点、补充步骤），并沿用原来的整体事务；先校验再写，避免半套数据。
    const submittedIds = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));
    const builtinRows = await db.all<{ id: number; steps_json: string | null }>('SELECT id, steps_json FROM subscription_presets ORDER BY id');
    const missingBuiltin = builtinRows
      .filter((row) => isBuiltinGroup({ steps: parseStepsJson(row.steps_json) }) && !submittedIds.has(row.id));
    if (missingBuiltin.length) throw new Error(`内置规则组“${BUILTIN_GROUP_NAME}”不能删除，请在提交内容中保留它。`);
    // 先逐组校验读取方式，任何一组非法都在写库前返回。
    for (const row of rows) normalizePresetPayload(row as unknown as SubscriptionPresetPayload);
    const now = new Date().toISOString();
    let finalRules = rules;
    await db.transaction(async (tx) => {
      const keptIds = await updatePresetList(tx, rows, now);
      // 老页面只有一份全局站点：把它写到本次提交的每一组上，行为与改造前一致。
      for (const keptId of keptIds) {
        await tx.run('UPDATE subscription_presets SET sites_json=?, steps_json=COALESCE(steps_json, \'[]\') WHERE id=?', [serializeSitesJson(sites), keptId]);
      }
      await tx.run(`UPDATE subscriptions SET preset_id=? WHERE rule_family='missav' AND (preset_id IS NULL OR preset_id NOT IN (${keptIds.map(() => '?').join(',')}))`, [keptIds[0], ...keptIds]);
      await syncSubscriptionsFromPresets(tx, now);
      finalRules = await writeInspectionSites(tx, await collectGroupSiteUnion(tx), now, rules);
      if (!finalRules.releaseDate.enabled) {
        await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE status = 'queued'", [now]);
        await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE release_status = 'pending'", [now]);
      }
      if (!finalRules.magnet.enabled) {
        await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE status = 'queued'", [now]);
        await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE magnet_status = 'pending'", [now]);
      }
    });
    await refreshSettings(true);
    await appendRuntimeLog({ level: 'success', source: 'system', message: '检查规则已更新；后续归档会按新规则执行。' });
    return { presets: await db.all('SELECT * FROM subscription_presets ORDER BY id ASC'), inspectionRules: finalRules };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '检查规则无法保存。' }); }
});

app.put('/api/rules/missav', async (request, reply) => {
  try {
    const payload = request.body as MissavRulesPayload;
    // Validate both documents before opening the write transaction. This keeps
    // malformed companion rules from ever partially updating the preset.
    const preset = normalizePresetPayload(payload.preset ?? {} as SubscriptionPresetPayload);
    // 界面把站点列表放在「检查规则」顶部，保存时与预设、补全规则一起提交，
    // 因此这里合并成同一份文档后再统一校验与写入。
    const rules = normalizeInspectionRules({ ...(payload.inspectionRules ?? {} as Record<string, unknown>), sites: payload.sites });
    const requestedId = Number(payload.presetId);
    const now = new Date().toISOString();
    const presetId = await db.transaction(async (tx) => {
      const existing = Number.isInteger(requestedId) && requestedId > 0
        ? await tx.get<{ id: number }>('SELECT id FROM subscription_presets WHERE id = ?', [requestedId])
        : await tx.get<{ id: number }>("SELECT id FROM subscription_presets WHERE name IN (?, ?) ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, id ASC LIMIT 1", [BUILTIN_GROUP_NAME, legacyMissavGroupName, legacyMissavGroupName]);
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
    ORDER BY a.release_date IS NULL ASC, a.release_date DESC, a.id ASC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { items, total, page, pageSize };
});

app.post('/api/subscriptions/:id/magnet-backfill', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const subscription = await getSubscription(id);
  if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
  if (subscription.rule_family !== 'missav') return reply.code(400).send({ error: '此订阅不使用 MissAV 磁力规则。' });
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
  if (subscription.rule_family !== 'missav') return reply.code(400).send({ error: '此订阅不使用 MissAV 发行日期规则。' });
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
  const entry = await db.get<{ id: number; subscription_id: number; content: string; magnet_status: string; subscription_name: string; rule_family: string }>(`SELECT a.id, a.subscription_id, a.content, a.magnet_status, s.name AS subscription_name, s.rule_family
    FROM archive_entries a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.id = ?`, [id]);
  if (!entry) return reply.code(404).send({ error: '归档内容不存在。' });
  if (entry.rule_family !== 'missav') return reply.code(400).send({ error: '此档案不使用 MissAV 磁力规则。' });
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
      AND download_status IN ('not_queued', 'failed', 'filtered', 'removed') ORDER BY id ASC`, [id]);
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
            download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
        }
      }
    }
  });
  if (queued) await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, message: `已将 ${queued} 项磁力链接加入 qBittorrent 下载队列。` });
  return reply.code(202).send({ queued, skipped: candidates.length - queued });
});

app.post('/api/archive/:id/download', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const entry = await db.get<{ id: number; subscription_id: number; content: string; magnet_status: string; magnet_value: string | null; download_status: string; download_torrent_hash: string | null }>(
    'SELECT id, subscription_id, content, magnet_status, magnet_value, download_status, download_torrent_hash FROM archive_entries WHERE id = ?', [id]);
  if (!entry) return reply.code(404).send({ error: '归档内容不存在。' });
  if (!await ensureQbittorrentEnabled(reply)) return;
  if (entry.magnet_status !== 'found' || !entry.magnet_value) return reply.code(400).send({ error: '该内容尚未找到可用的磁力链接。' });
  if (entry.download_status === 'added') return reply.code(409).send({ error: '该内容已提交给 qBittorrent。' });
  if (entry.download_status === 'completed') {
    const hash = entry.download_torrent_hash || torrentHashFromMagnet(entry.magnet_value);
    if (hash) {
      try {
        if ((await getQbittorrentTorrentStates(getQbittorrentSettings(), [hash])).length) {
          return reply.code(409).send({ error: 'qBittorrent 中仍存在这个已完成的种子。请先在 qBittorrent 中删除种子，再点击下载。' });
        }
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : '无法确认 qBittorrent 中的种子状态。' });
      }
    }
  }
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
          download_filter_min_size_bytes = NULL, download_removed_at = NULL, updated_at = ? WHERE id = ?`, [now, now, entry.id]);
      }
    }
  });
  await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: entry.subscription_id, jobId, message: queued ? `已将“${entry.content}”加入 qBittorrent 下载队列。` : `“${entry.content}”已在 qBittorrent 下载队列中。` });
  return reply.code(202).send({ queued, jobId });
});

await registerSettingsRoutes(app, { wakeEngine: (reason) => engineWakeScheduler.wake(reason) });
app.post('/api/subscriptions', async (request, reply) => {
  try {
    const { values, family, presetId, override } = await resolveMissavPayload(request.body as SubscriptionPayload);
    const now = new Date().toISOString();
    const result = await db.run(`INSERT INTO subscriptions
      (name, url, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, schedule_type, schedule_interval_hours, schedule_time, schedule_weekday, is_active, pagination_selector, pagination_parameter, pagination_match_pattern, rule_family, preset_id, render_mode_override, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.name, values.url, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.scheduleType, values.scheduleIntervalHours, values.scheduleTime, values.scheduleWeekday, values.isActive, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, family, presetId, override, now, now]);
    await rebuildSubscriptionProgress(result.lastInsertRowid);
    return reply.code(201).send(await getSubscription(result.lastInsertRowid));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建订阅。' });
  }
});

app.put('/api/subscriptions/:id', async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const current = await getSubscription(id);
  if (!current) return reply.code(404).send({ error: '订阅不存在。' });
  try {
    const payload = request.body as SubscriptionPayload;
    const { values, family, presetId, override } = await resolveMissavPayload({ ...payload, ruleFamily: payload.ruleFamily ?? current.rule_family, presetId: payload.presetId ?? current.preset_id, renderModeOverride: payload.renderModeOverride === undefined ? current.render_mode_override : payload.renderModeOverride });
    const scheduleChanged = current.schedule_type !== values.scheduleType || current.schedule_interval_hours !== values.scheduleIntervalHours
      || current.schedule_time !== values.scheduleTime || current.schedule_weekday !== values.scheduleWeekday || current.is_active !== values.isActive;
    await db.run(`UPDATE subscriptions SET name=?, url=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, schedule_type=?, schedule_interval_hours=?, schedule_time=?, schedule_weekday=?, is_active=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, rule_family=?, preset_id=?, render_mode_override=?, initial_scan_completed=CASE WHEN ? IS NULL THEN 1 WHEN pagination_selector IS NULL THEN 0 ELSE initial_scan_completed END, initial_scan_total=CASE WHEN ? IS NOT NULL AND pagination_selector IS NULL THEN NULL ELSE initial_scan_total END, initial_scan_pages_completed=CASE WHEN ? IS NOT NULL AND pagination_selector IS NULL THEN 0 ELSE initial_scan_pages_completed END, next_scheduled_at=CASE WHEN ? THEN NULL ELSE next_scheduled_at END, updated_at=? WHERE id=?`,
      [values.name, values.url, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.scheduleType, values.scheduleIntervalHours, values.scheduleTime, values.scheduleWeekday, values.isActive, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, family, presetId, override, values.paginationSelector, values.paginationSelector, values.paginationSelector, scheduleChanged ? 1 : 0, new Date().toISOString(), id]);
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
    await tx.run('DELETE FROM archive_entry_codes WHERE subscription_id = ?', [id]);
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
    await tx.run('DELETE FROM archive_entry_codes WHERE subscription_id = ?', [id]);
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
    const { values, family, presetId } = await resolveMissavPayload(request.body as SubscriptionPayload);
    const token = process.env.WORKER_EVENT_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'page-watch-dev-runner');
    if (!token) throw new Error('统一执行引擎尚未就绪，请稍后重试。');
    await engineWakeScheduler.wake('规则预览');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`http://127.0.0.1:${process.env.RUNNER_INTERNAL_PORT || '3031'}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-page-watch-worker-token': token },
        body: JSON.stringify({ url: values.url, selector: values.selector, render_mode: values.renderMode as Subscription['render_mode'], content_source: values.contentSource as Subscription['content_source'], attribute_name: values.attributeName, match_pattern: values.matchPattern, title_selector: values.titleSelector, title_content_source: values.titleContentSource as Subscription['title_content_source'], title_attribute_name: values.titleAttributeName, title_match_pattern: values.titleMatchPattern, result_mode: values.resultMode as Subscription['result_mode'], rule_family: family, preset_id: presetId }),
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
  const existingBatch = await db.get<{ id: string }>("SELECT id FROM full_scan_batches WHERE subscription_id = ? AND status = 'scanning' ORDER BY created_at DESC, id DESC LIMIT 1", [id]);
  const batchId = existingBatch?.id ?? randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
    await tx.run(`UPDATE subscriptions SET initial_scan_completed = 0, initial_scan_total = NULL, initial_scan_pages_completed = 0, initial_scan_run_id = NULL, initial_scan_next_page = 1, last_error = NULL, updated_at = ? WHERE id = ?`, [now, id]);
    await tx.run(`INSERT INTO full_scan_batches (id, subscription_id, subscription_name, status, is_initial, page_count, scanned_count, archived_count, created_at)
      VALUES (?, ?, ?, 'scanning', ?, NULL, 0, 0, ?)
      ON DUPLICATE KEY UPDATE subscription_name = VALUES(subscription_name), status = 'scanning', is_initial = VALUES(is_initial), page_count = NULL, scanned_count = 0, archived_count = 0, completed_at = NULL, created_at = VALUES(created_at)`,
    [batchId, id, subscription.name, subscription.last_hash ? 0 : 1, now]);
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

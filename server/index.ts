import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { appendRuntimeLog, closeDatabase, db, isDatabaseConfigured, reportRuntimeMetrics, reportWorkerHeartbeat } from './db.js';
import { maintainDatabase } from './database-maintenance.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';
import { statusFor } from './auth.js';
import { emitLive, registerLiveRoutes, startLivePolling } from './sse-hub.js';
import { authPath, pruneLoginFailures, trustProxyOption } from './http-guards.js';
import { registerArchiveRoutes } from './routes/archive.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCodeSearchRoutes } from './routes/code-search.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerRulesRoutes } from './routes/rules.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSubscriptionsRoutes } from './routes/subscriptions.js';
import { ExecutionEngineController } from './engine-controller.js';
import { EngineWakeScheduler } from './engine-wake-scheduler.js';
import { backfillArchiveCodeIndex } from './archive-code-index.js';

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
    return reply.code(503).send({ error: '数据库尚未配置。请先完成 PostgreSQL 安装引导。' });
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
registerCodeSearchRoutes(app);

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
        COUNT(*) FILTER (WHERE download_status IN ('added', 'waiting', 'downloading')) AS active,
        COUNT(*) FILTER (WHERE download_status = 'paused') AS paused
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
  void maintainDatabase();
  const maintenanceTimer = setInterval(() => void maintainDatabase(), 24 * 60 * 60_000);
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
  await closeDatabase().catch(() => undefined);
}
process.once('SIGTERM', () => { void stopApi(); });
process.once('SIGINT', () => { void stopApi(); });

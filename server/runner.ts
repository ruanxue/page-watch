import { createServer } from 'node:http';
import { db, flushSubscriptionProgressRebuilds, flushTelemetry, getJellyfinSettings, getSetting, refreshSettings, reportRuntimeMetrics } from './db.js';
import { webExecutor } from './web-executor-client.js';
import { librarySyncExecutor } from './library-sync-client.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';
import { isExecutionEngineDraining } from './engine-drain.js';

console.log('Page Watch unified runner started');
await refreshSettings(true);
startRuntimeMemoryReporter('runner');

const ENGINE_IDLE_EXIT_CODE = 76;
const ENGINE_IDLE_MS = 2 * 60_000;
let dispatchTimer: NodeJS.Timeout | null = null;
let idleSince: number | null = null;
let dispatching = false;
let shuttingDown = false;
type HandlerName = 'capture' | 'release' | 'magnet' | 'download' | 'library';
const activeHandlers = new Set<HandlerName>();

function send(message: unknown) { if (process.send) process.send(message); }
function reportState(state: 'running' | 'sleeping', detail: string) { send({ type: 'state', state, detail }); }

async function runnableHandlers() {
  const now = new Date().toISOString();
  const rows = await db.get<Record<HandlerName, number>>(`SELECT
    EXISTS(SELECT 1 FROM jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) OR EXISTS(SELECT 1 FROM subscriptions WHERE is_active = 1 AND (next_scheduled_at IS NULL OR next_scheduled_at <= ?)) AS capture,
    EXISTS(SELECT 1 FROM release_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) AS \`release\`,
    EXISTS(SELECT 1 FROM magnet_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) AS magnet,
    EXISTS(SELECT 1 FROM download_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) AS download,
    EXISTS(SELECT 1 FROM library_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?)) OR EXISTS(SELECT 1 FROM library_sync_jobs WHERE status = 'queued') AS library`, [now, now, now, now, now, now]);
  const jellyfin = getJellyfinSettings();
  const dueLibrarySync = jellyfin.enabled && jellyfin.libraryIds.length && (!Date.parse(getSetting('jellyfin_last_synced_at')) || Date.now() - Date.parse(getSetting('jellyfin_last_synced_at')) >= jellyfin.syncIntervalMinutes * 60_000);
  return { capture: Boolean(rows?.capture), release: Boolean(rows?.release), magnet: Boolean(rows?.magnet), download: Boolean(rows?.download), library: Boolean(rows?.library) || dueLibrarySync };
}

async function runHandler(name: HandlerName) {
  if (activeHandlers.has(name) || shuttingDown) return;
  activeHandlers.add(name);
  try {
    if (name === 'capture') await (await import('./worker.js')).runCaptureWorkerTick();
    if (name === 'release') await (await import('./release-worker.js')).runReleaseWorkerTick();
    if (name === 'magnet') await (await import('./magnet-worker.js')).runMagnetWorkerTick();
    if (name === 'download') await (await import('./download-worker.js')).runDownloadWorkerTick();
    if (name === 'library') await (await import('./library-worker.js')).runLibraryWorkerTick();
  } catch (error) {
    console.error(`Execution handler ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    activeHandlers.delete(name);
    void requestDispatch('任务处理完成');
  }
}

async function requestDispatch(_reason = '事件唤醒') {
  if (dispatching || shuttingDown) return;
  dispatching = true;
  try {
    const runnable = await runnableHandlers();
    const names = (Object.keys(runnable) as HandlerName[]).filter((name) => runnable[name]);
    if (names.length) {
      idleSince = null;
      reportState('running', `正在处理 ${names.length} 类队列`);
      for (const name of names) void runHandler(name);
      scheduleDispatch(250);
      return;
    }
    const web = webExecutor.snapshot();
    const librarySync = librarySyncExecutor.snapshot();
    // A browser executor with an open, but idle, Chromium is intentionally
    // kept alive for the configured 5/10/20 minute browser-idle window. If
    // this runner exited after two minutes it would kill that executor early
    // and silently make the runtime setting ineffective. Once the pool has
    // closed, the executor exits and the normal two-minute engine idle timer
    // starts below.
    if (activeHandlers.size || web.state !== 'offline' || librarySync.active) {
      idleSince = null;
      scheduleDispatch(500);
      return;
    }
    idleSince ??= Date.now();
    reportState('running', '等待新的队列任务');
    if (Date.now() - idleSince >= ENGINE_IDLE_MS) {
      reportState('sleeping', '队列空闲，执行引擎退出');
      void shutdown(ENGINE_IDLE_EXIT_CODE);
      return;
    }
    scheduleDispatch(Math.min(5_000, ENGINE_IDLE_MS - (Date.now() - idleSince)));
  } catch (error) {
    console.error(`Execution dispatcher failed: ${error instanceof Error ? error.message : String(error)}`);
    scheduleDispatch(5_000);
  } finally { dispatching = false; }
}

function scheduleDispatch(delay: number) {
  if (dispatchTimer) clearTimeout(dispatchTimer);
  dispatchTimer = setTimeout(() => void requestDispatch('调度定时器'), delay);
  dispatchTimer.unref();
}

const runnerPort = Number(process.env.RUNNER_INTERNAL_PORT ?? 3031);
const runnerToken = process.env.WORKER_EVENT_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'page-watch-dev-runner');

// The API delegates browser previews here instead of importing Playwright in
// its own process. It keeps *all* dynamic rendering behind the one pool while
// remaining loopback-only and protected by the supervisor's random token.
const previewServer = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/preview' || !runnerToken || request.headers['x-page-watch-worker-token'] !== runnerToken) {
    response.writeHead(404).end();
    return;
  }
  if (isExecutionEngineDraining()) {
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: '后台引擎正在完成空闲内存回收，请稍后重试。' }));
    return;
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 200_000) request.destroy();
  });
  request.on('end', () => void (async () => {
    try {
      idleSince = null;
      const input = JSON.parse(raw);
      const result = await webExecutor.preview(input);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : '预览抽取失败。';
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: message }));
    } finally { void requestDispatch('预览完成'); }
  })());
});

previewServer.listen({ host: '127.0.0.1', port: runnerPort }, () => console.log(`[统一执行引擎] 浏览器预览通道已监听 127.0.0.1:${runnerPort}`));

previewServer.once('listening', () => {
  send({ type: 'ready' });
  reportState('running', '统一执行引擎已启动');
  void requestDispatch('引擎启动');
});

process.on('message', (message: { type?: string; reason?: string }) => {
  if (message?.type === 'wake') void requestDispatch(message.reason ?? 'API 唤醒');
});

async function shutdown(exitCode = 0) {
  shuttingDown = true;
  if (dispatchTimer) clearTimeout(dispatchTimer);
  await webExecutor.close();
  await librarySyncExecutor.close();
  if (exitCode === ENGINE_IDLE_EXIT_CODE) {
    await reportRuntimeMetrics([
      { key: 'runner_reclaim_state', text: 'process_exit' },
      { key: 'runner_rss_bytes', value: 0 }
    ]).catch(() => undefined);
  }
  await flushSubscriptionProgressRebuilds();
  await flushTelemetry().catch(() => undefined);
  previewServer.close(() => process.exit(exitCode));
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });

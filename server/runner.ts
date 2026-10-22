import { createServer } from 'node:http';
import { flushSubscriptionProgressRebuilds, flushTelemetry, refreshSettings, reportRuntimeMetrics, reportWorkerHeartbeat, type WorkerName } from './db.js';
import { webExecutor } from './web-executor-client.js';
import { librarySyncExecutor } from './library-sync-client.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';
import { isExecutionEngineDraining } from './engine-drain.js';
import { runnableHandlers, type HandlerName } from './engine-queue.js';

console.log('Page Watch unified runner started');
await refreshSettings(true);
startRuntimeMemoryReporter('runner');

const ENGINE_IDLE_EXIT_CODE = 76;
const ENGINE_IDLE_MS = 2 * 60_000;
const HEARTBEAT_KEEPALIVE_MS = 15_000;
// 浏览器只是“开着但空闲”（等 browserIdleMinutes 到点关闭）时，队列必然为空，
// 否则上面的 runnableHandlers 会命中并进入处理分支。这段时间没必要按 5 秒重跑
// 那条含 8 段 UNION 的队列查询：真正的任务由 API 的唤醒消息立即触发，不依赖
// 这个定时器；qBittorrent 状态同步也由 API 进程自己的观察器负责，与本循环无关。
const BROWSER_IDLE_RECHECK_MS = 20_000;
let dispatchTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let idleSince: number | null = null;
let dispatching = false;
let dispatchRequested = false;
let shuttingDown = false;
const activeHandlers = new Set<HandlerName>();
// API 的健康检查在 90 秒收不到心跳落库后就把 worker 判为不可用。这里的
// worker 运行时带着 PAGE_WATCH_WORKER_AUTOSTART=0，它们自己的 15 秒心跳定时器
// 根本不会启动，而一个长耗时的浏览器批次会让 handler 停在首次心跳里远超 90 秒。
const heartbeatWorkers: WorkerName[] = ['capture', 'release', 'magnet', 'download', 'library'];

function send(message: unknown) { if (process.send) process.send(message); }
function reportState(state: 'running' | 'sleeping', detail: string) { send({ type: 'state', state, detail }); }


async function runHandler(name: HandlerName) {
  if (activeHandlers.has(name) || shuttingDown) return;
  activeHandlers.add(name);
  try {
    if (name === 'capture') await (await import('./worker.js')).runCaptureWorkerTick();
    if (name === 'release') await (await import('./release-worker.js')).runReleaseWorkerTick();
    if (name === 'magnet') await (await import('./magnet-worker.js')).runMagnetWorkerTick();
    if (name === 'download') await (await import('./download-worker.js')).runDownloadWorkerTick();
    if (name === 'library') await (await import('./library-worker.js')).runLibraryWorkerTick();
    if (name === 'notification') await (await import('./notifications.js')).runNotificationWorkerTick();
  } catch (error) {
    console.error(`Execution handler ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    activeHandlers.delete(name);
    void requestDispatch('任务处理完成');
  }
}

async function requestDispatch(_reason = '事件唤醒') {
  if (shuttingDown) return;
  if (dispatching) { dispatchRequested = true; return; }
  dispatching = true;
  try {
    const runnable = await runnableHandlers();
    const names = (Object.keys(runnable) as HandlerName[]).filter((name) => runnable[name]);
    if (names.length) {
      idleSince = null;
      reportState('running', `正在处理 ${names.length} 类队列`);
      for (const name of names) void runHandler(name);
      // Handler completion triggers the next dispatch immediately. This timer
      // only recovers a missed event or work added outside the API wake path.
      scheduleDispatch(5_000);
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
      // 只有“浏览器仍开着、但没有任务在处理”这一种情况可以降频；同步器在跑或
      // handler 未收尾时仍需保持 5 秒，避免拖慢正在进行的批次。
      const waitingForBrowserIdle = !activeHandlers.size && !librarySync.active && web.state === 'browser_idle';
      scheduleDispatch(waitingForBrowserIdle ? BROWSER_IDLE_RECHECK_MS : 5_000);
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
  } finally {
    dispatching = false;
    if (dispatchRequested && !shuttingDown) {
      dispatchRequested = false;
      scheduleDispatch(0);
    }
  }
}

function scheduleDispatch(delay: number) {
  if (dispatchTimer) clearTimeout(dispatchTimer);
  dispatchTimer = setTimeout(() => void requestDispatch('调度定时器'), delay);
  dispatchTimer.unref();
}

function keepAliveHeartbeats() {
  for (const name of heartbeatWorkers) {
    void reportWorkerHeartbeat(name, '正在执行引擎中处理队列', 'busy', null, { force: true })
      .catch((error) => console.error(`无法续报 ${name} 的心跳：${error instanceof Error ? error.message : String(error)}`));
  }
}

function startHeartbeatKeepAlive() {
  heartbeatTimer ??= setInterval(() => { if (activeHandlers.size && !shuttingDown) keepAliveHeartbeats(); }, HEARTBEAT_KEEPALIVE_MS);
  heartbeatTimer.unref();
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
  startHeartbeatKeepAlive();
  console.log(`[心跳保活] 定时器已启动（每 ${HEARTBEAT_KEEPALIVE_MS / 1_000} 秒）`);
  void requestDispatch('引擎启动');
});

process.on('message', (message: { type?: string; reason?: string }) => {
  if (message?.type === 'wake') void requestDispatch(message.reason ?? 'API 唤醒');
});

async function shutdown(exitCode = 0) {
  shuttingDown = true;
  if (dispatchTimer) clearTimeout(dispatchTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
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

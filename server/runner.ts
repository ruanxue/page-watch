// The six logical workers deliberately live in one Node process. Their queues,
// heartbeats and operation-centre cards remain independent, while Chromium,
// the settings cache and the MySQL pool are shared.
import { createServer } from 'node:http';
import './worker.js';
import './release-worker.js';
import './magnet-worker.js';
import './download-worker.js';
import './library-worker.js';
import { webExecutor } from './web-executor-client.js';
import { librarySyncExecutor } from './library-sync-client.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';
import { ExecutionEngineMemoryReclaimer, ENGINE_MEMORY_RECYCLE_EXIT_CODE } from './engine-memory-reclaimer.js';
import { isExecutionEngineDraining } from './engine-drain.js';

console.log('Page Watch unified runner started');
startRuntimeMemoryReporter('runner');

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
      const input = JSON.parse(raw);
      const result = await webExecutor.preview(input);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : '预览抽取失败。';
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: message }));
    }
  })());
});

previewServer.listen({ host: '127.0.0.1', port: runnerPort }, () => console.log(`[统一执行引擎] 浏览器预览通道已监听 127.0.0.1:${runnerPort}`));

const memoryReclaimer = new ExecutionEngineMemoryReclaimer({
  getCompanionState() {
    const executor = webExecutor.snapshot();
    const librarySync = librarySyncExecutor.snapshot();
    return {
      browser: executor.browser,
      helpersIdle: executor.state === 'offline' && !librarySync.active
    };
  },
  async onRecycle() {
    memoryReclaimer.stop();
    await webExecutor.close();
    await librarySyncExecutor.close();
    await new Promise<void>((resolve) => previewServer.close(() => resolve()));
    process.exit(ENGINE_MEMORY_RECYCLE_EXIT_CODE);
  }
});
memoryReclaimer.start();

async function shutdown() {
  memoryReclaimer.stop();
  await webExecutor.close();
  await librarySyncExecutor.close();
  previewServer.close(() => process.exit(0));
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });

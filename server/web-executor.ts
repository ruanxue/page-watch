import { browserPool } from './browser-pool.js';
import { captureSubscription, previewCapture } from './capture.js';
import { getRuntimeSettings, refreshSettings, reportRuntimeMetrics, type Subscription } from './db.js';
import { getInspectionRules, type ReleaseDateRule } from './inspection-rules.js';
import { lookupMagnet } from './magnet.js';
import { lookupReleaseDate } from './release-date.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';

type ExecutorRequest =
  | { id: string; operation: 'capture'; payload: { subscription: Subscription; priority: number } }
  | { id: string; operation: 'release'; payload: { detailUrl: string; rule: ReleaseDateRule; priority: number } }
  | { id: string; operation: 'magnet'; payload: { content: string; rule: ReturnType<typeof getInspectionRules>['magnet'] } }
  | { id: string; operation: 'preview'; payload: Parameters<typeof previewCapture>[0] };

type ExecutorMessage = { type: 'request'; request: ExecutorRequest };

let pending = 0;
let lastActivityAt = Date.now();
let idleTimer: NodeJS.Timeout | null = null;

function send(message: unknown) {
  if (process.send) process.send(message);
}

function snapshot() {
  const browser = browserPool.snapshot();
  return { state: pending || browser.activePages || browser.queuedPages ? 'busy' : browser.state === 'closed' ? 'idle' : 'browser_idle', rssBytes: process.memoryUsage().rss, browser };
}

function publishState() {
  const value = snapshot();
  send({ type: 'state', ...value });
  void reportRuntimeMetrics([
    { key: 'web_executor_rss_bytes', value: value.rssBytes },
    { key: 'web_executor_state', text: value.state },
    { key: 'browser_active_pages', value: value.browser.activePages },
    { key: 'browser_queued_pages', value: value.browser.queuedPages },
    { key: 'browser_navigation_count', value: value.browser.navigationCount },
    { key: 'browser_state', text: value.browser.state }
  ]).catch(() => undefined);
}

function scheduleIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  const idleMs = getRuntimeSettings().browserIdleMinutes * 60_000;
  const remaining = Math.max(1_000, idleMs - (Date.now() - lastActivityAt) + 1_000);
  idleTimer = setTimeout(() => {
    const current = browserPool.snapshot();
    if (pending || current.activePages || current.queuedPages || current.state !== 'closed') {
      scheduleIdleExit();
      return;
    }
    publishState();
    process.exit(0);
  }, remaining);
  idleTimer.unref();
}

async function execute(request: ExecutorRequest) {
  await refreshSettings();
  switch (request.operation) {
    case 'capture': return captureSubscription(request.payload.subscription, request.payload.priority);
    case 'release': return lookupReleaseDate(request.payload.detailUrl, request.payload.rule, undefined, request.payload.priority);
    case 'magnet': return lookupMagnet(request.payload.content, request.payload.rule);
    case 'preview': return previewCapture(request.payload);
  }
}

process.on('message', (message: ExecutorMessage) => {
  if (!message || message.type !== 'request') return;
  if (idleTimer) clearTimeout(idleTimer);
  pending += 1;
  lastActivityAt = Date.now();
  publishState();
  void execute(message.request).then(
    (result) => send({ type: 'result', id: message.request.id, ok: true, result }),
    (error) => send({ type: 'result', id: message.request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  ).finally(() => {
    pending -= 1;
    lastActivityAt = Date.now();
    publishState();
    scheduleIdleExit();
  });
});

startRuntimeMemoryReporter('web_executor', () => browserPool.snapshot());
publishState();
scheduleIdleExit();
console.log('Page Watch web executor started');

async function shutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  await browserPool.close();
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('disconnect', () => { void shutdown(); });

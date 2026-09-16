import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { getOutboundProxyUrl, getRuntimeSettings, recordPerformanceMetric } from './db.js';

type BrowserScope = 'capture' | 'release';
// The queue stores heterogeneous task results. The public `use` method keeps
// the generic result type; the runner only needs to pass that result through.
type BrowserTask = { scope: BrowserScope; priority: number; requestedAt: number; run: (page: Page) => Promise<unknown>; resolve: (value: any) => void; reject: (reason: unknown) => void };
type BrowserCloseReason = 'disconnected' | 'proxy_changed' | 'page_limit' | 'age_limit' | 'idle' | 'error';

export type BrowserPoolSnapshot = {
  state: 'active' | 'idle' | 'closed';
  activePages: number;
  queuedPages: number;
  navigationCount: number;
  openedAt: string | null;
};

const localBrowserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

function executablePath() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (process.platform !== 'win32') return undefined;
  return localBrowserCandidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * The runner owns exactly one Chromium. Individual tasks get disposable
 * contexts, while this pool limits page concurrency and releases Chromium
 * completely after the configured idle period.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private browserProxy: string | null = null;
  private openedAt = 0;
  private navigationCount = 0;
  private active = 0;
  private queue: BrowserTask[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private launching: Promise<Browser> | null = null;
  private pendingRecycle: BrowserCloseReason | null = null;

  async use<T>(scope: BrowserScope, work: (page: Page) => Promise<T>, priority = 0) {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ scope, priority, requestedAt: Date.now(), run: work, resolve, reject });
      this.drain();
    });
  }

  snapshot(): BrowserPoolSnapshot {
    return {
      state: this.browser ? (this.active ? 'active' : 'idle') : 'closed',
      activePages: this.active,
      queuedPages: this.queue.length,
      navigationCount: this.navigationCount,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null
    };
  }

  async close(reason?: BrowserCloseReason, scope: BrowserScope = 'capture') {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const browser = this.browser;
    this.browser = null;
    this.browserProxy = null;
    this.openedAt = 0;
    this.navigationCount = 0;
    this.pendingRecycle = null;
    if (browser && reason) await recordPerformanceMetric({ scope, metric: 'chromium_rebuild', dimension: reason }).catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  private capacity() {
    return getRuntimeSettings().profile === 'performance' ? 2 : 1;
  }

  private async ensureBrowser(scope: BrowserScope) {
    const proxyUrl = getOutboundProxyUrl() || null;
    const reason = !this.browser ? null
      : !this.browser.isConnected() ? 'disconnected'
        : this.browserProxy !== proxyUrl ? 'proxy_changed'
          : this.navigationCount >= 50 ? 'page_limit'
            : Date.now() - this.openedAt >= 30 * 60_000 ? 'age_limit'
              : null;
    // Never recycle a shared browser underneath another active context. A
    // proxy/config change or threshold is applied before the next task once
    // all currently running pages have finished.
    if (reason && this.active > 1) this.pendingRecycle = reason;
    else if (reason) await this.close(reason, scope);
    if (this.browser) return this.browser;
    if (!this.launching) {
      const executable = executablePath();
      this.launching = chromium.launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        args: [
          '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
          '--disable-extensions', '--disable-features=Translate,MediaRouter,OptimizationHints'
        ],
        ...(executable ? { executablePath: executable } : {}),
        ...(proxyUrl ? { proxy: { server: proxyUrl } } : {})
      }).then((browser) => {
        this.browser = browser;
        this.browserProxy = proxyUrl;
        this.openedAt = Date.now();
        browser.once('disconnected', () => { if (this.browser === browser) void this.close('disconnected'); });
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  private drain() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    while (this.active < this.capacity() && this.queue.length) {
      this.queue.sort((left, right) => right.priority - left.priority || left.requestedAt - right.requestedAt);
      const task = this.queue.shift()!;
      this.active += 1;
      void this.run(task);
    }
  }

  private async run(task: BrowserTask) {
    let context: Awaited<ReturnType<Browser['newContext']>> | null = null;
    try {
      const browser = await this.ensureBrowser(task.scope);
      context = await browser.newContext({ userAgent: 'PageWatch/0.1 (+self-hosted webpage monitor)' });
      const page = await context.newPage();
      await page.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
      const result = await task.run(page);
      this.navigationCount += 1;
      task.resolve(result);
    } catch (error) {
      await this.close('error', task.scope);
      task.reject(error);
    } finally {
      await context?.close().catch(() => undefined);
      this.active -= 1;
      if (!this.active && !this.pendingRecycle && this.browser && (this.navigationCount >= 50 || Date.now() - this.openedAt >= 30 * 60_000)) {
        this.pendingRecycle = this.navigationCount >= 50 ? 'page_limit' : 'age_limit';
      }
      if (!this.active && this.pendingRecycle) await this.close(this.pendingRecycle, task.scope);
      this.drain();
      this.scheduleIdleClose();
    }
  }

  private scheduleIdleClose() {
    if (!this.browser || this.active || this.queue.length || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { if (!this.active && !this.queue.length) void this.close('idle'); }, getRuntimeSettings().browserIdleMinutes * 60_000);
    this.idleTimer.unref();
  }
}

export const browserPool = new BrowserPool();

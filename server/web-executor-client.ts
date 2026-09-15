import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportRuntimeMetrics, type Subscription } from './db.js';
import type { ReleaseDateRule } from './inspection-rules.js';
import type { MagnetRule } from './inspection-rules.js';

type BrowserSnapshot = { state: 'active' | 'idle' | 'closed'; activePages: number; queuedPages: number; navigationCount: number; openedAt: string | null };
type ExecutorState = 'offline' | 'starting' | 'busy' | 'idle' | 'browser_idle';
type StateMessage = { type: 'state'; state: Exclude<ExecutorState, 'offline' | 'starting'>; rssBytes: number; browser: BrowserSnapshot };
type ResultMessage = { type: 'result'; id: string; ok: boolean; result?: unknown; error?: string };
type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void };

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === 'production';

function modulePath() {
  return production ? path.join(moduleDirectory, 'web-executor.js') : path.resolve(process.cwd(), 'server', 'web-executor.ts');
}

/**
 * The runner intentionally imports only this client. Playwright, Cheerio and
 * capture code live in the child and disappear with it after the configured
 * browser idle period.
 */
export class WebExecutorClient {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private state: ExecutorState = 'offline';
  private rssBytes: number | null = null;
  private browser: BrowserSnapshot = { state: 'closed', activePages: 0, queuedPages: 0, navigationCount: 0, openedAt: null };

  snapshot() {
    return { state: this.state, rssBytes: this.rssBytes, browser: this.browser };
  }

  async capture(subscription: Subscription, priority: number) {
    return this.request('capture', { subscription, priority });
  }

  async release(detailUrl: string, rule: ReleaseDateRule, priority: number) {
    return this.request('release', { detailUrl, rule, priority });
  }

  async magnet(content: string, rule: MagnetRule) {
    return this.request('magnet', { content, rule });
  }

  async preview(payload: Pick<Subscription, 'url' | 'selector' | 'render_mode' | 'content_source' | 'attribute_name' | 'match_pattern' | 'title_selector' | 'title_content_source' | 'title_attribute_name' | 'title_match_pattern' | 'result_mode'>) {
    return this.request('preview', payload);
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    this.setOffline();
  }

  private async request(operation: string, payload: unknown) {
    const child = this.ensureChild();
    const id = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.send({ type: 'request', request: { id, operation, payload } }, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new Error(`网页执行器通信失败：${error.message}`));
      });
    });
  }

  private ensureChild() {
    if (this.child?.connected) return this.child;
    this.state = 'starting';
    void reportRuntimeMetrics([{ key: 'web_executor_state', text: 'starting' }]).catch(() => undefined);
    const child = fork(modulePath(), [], {
      cwd: production ? path.resolve(moduleDirectory, '..') : process.cwd(),
      execArgv: production ? [] : ['--import', 'tsx'],
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    this.child = child;
    child.on('message', (message: StateMessage | ResultMessage) => this.onMessage(message));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      const reason = code === 0 ? '网页执行器已按空闲策略回收。' : `网页执行器意外退出（${signal ?? `退出码 ${code ?? '未知'}`}）。`;
      for (const pending of this.pending.values()) pending.reject(new Error(reason));
      this.pending.clear();
      this.setOffline();
    });
    child.once('error', (error) => console.error(`Unable to start web executor: ${error.message}`));
    return child;
  }

  private onMessage(message: StateMessage | ResultMessage) {
    if (message.type === 'result') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || '网页执行器任务失败。'));
      return;
    }
    this.state = message.state;
    this.rssBytes = message.rssBytes;
    this.browser = message.browser;
    void reportRuntimeMetrics([
      { key: 'web_executor_rss_bytes', value: message.rssBytes },
      { key: 'web_executor_state', text: message.state },
      { key: 'browser_active_pages', value: message.browser.activePages },
      { key: 'browser_queued_pages', value: message.browser.queuedPages },
      { key: 'browser_navigation_count', value: message.browser.navigationCount },
      { key: 'browser_state', text: message.browser.state }
    ]).catch(() => undefined);
  }

  private setOffline() {
    this.state = 'offline';
    this.rssBytes = null;
    this.browser = { state: 'closed', activePages: 0, queuedPages: 0, navigationCount: 0, openedAt: null };
    void reportRuntimeMetrics([
      { key: 'web_executor_rss_bytes', value: 0 },
      { key: 'web_executor_state', text: 'offline' },
      { key: 'browser_active_pages', value: 0 },
      { key: 'browser_queued_pages', value: 0 },
      { key: 'browser_navigation_count', value: 0 },
      { key: 'browser_state', text: 'closed' }
    ]).catch(() => undefined);
  }
}

export const webExecutor = new WebExecutorClient();

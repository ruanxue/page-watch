import { appendRuntimeLog, getExecutionEngineQueueState, recordPerformanceMetric, reportRuntimeMetrics } from './db.js';
import { beginExecutionEngineDrain, cancelExecutionEngineDrain } from './engine-drain.js';
import { ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS, ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES, isEligibleForExecutionEngineMemoryReclaim } from './engine-memory-policy.js';

export const ENGINE_MEMORY_RECYCLE_EXIT_CODE = 75;

const CHECK_INTERVAL_MS = 15_000;
const RECHECK_DELAY_MS = 500;

type ReclaimerOptions = {
  onRecycle: () => Promise<void>;
  /** Companion processes own Chromium/Jellyfin memory and must have exited
   * before a runner recycle can be considered safe. */
  getCompanionState: () => { browser: { state: 'active' | 'idle' | 'closed'; activePages: number; queuedPages: number }; helpersIdle: boolean };
};

function toMiB(bytes: number) {
  return Math.round(bytes / 1024 / 1024);
}

function configuredNotBefore() {
  const value = Date.parse(process.env.ENGINE_MEMORY_RECYCLE_NOT_BEFORE ?? '');
  return Number.isFinite(value) ? value : 0;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runControlledGc() {
  const before = process.memoryUsage().rss;
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (gc) {
    gc();
    await wait(100);
    gc();
    await wait(100);
  }
  return { before, after: process.memoryUsage().rss, ran: Boolean(gc) };
}

/**
 * Node deliberately retains a high-water mark after a large scan. When all
 * durable queues are empty, Chromium is gone and a controlled GC has not
 * brought RSS down, restart only the disposable execution engine. The API is
 * never touched, and every task state already lives in MySQL.
 */
export class ExecutionEngineMemoryReclaimer {
  private readonly startedAt = Date.now();
  private readonly recycleNotBefore = configuredNotBefore();
  private idleSince: number | null = null;
  private checking = false;
  private recycling = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ReclaimerOptions) {}

  start() {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    cancelExecutionEngineDrain();
  }

  private resetIdleWindow() {
    this.idleSince = null;
  }

  private async check() {
    if (this.checking || this.recycling) return;
    this.checking = true;
    try {
      const companion = this.options.getCompanionState();
      const browser = companion.browser;
      const jobs = await getExecutionEngineQueueState();
      const now = Date.now();
      const rssBytes = process.memoryUsage().rss;
      const idleNow = companion.helpersIdle
        && browser.state === 'closed'
        && browser.activePages === 0
        && browser.queuedPages === 0
        && jobs.queued === 0
        && jobs.running === 0
        && jobs.busyWorkers === 0;

      if (!idleNow || rssBytes <= ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES) {
        this.resetIdleWindow();
        return;
      }
      this.idleSince ??= now;

      if (!isEligibleForExecutionEngineMemoryReclaim({
        now,
        startedAt: this.startedAt,
        recycleNotBefore: this.recycleNotBefore,
        idleSince: this.idleSince,
        rssBytes,
        browserState: browser.state,
        activePages: browser.activePages,
        queuedPages: browser.queuedPages,
        queuedJobs: jobs.queued,
        runningJobs: jobs.running,
        busyWorkers: jobs.busyWorkers
      })) return;

      if (!beginExecutionEngineDrain()) return;
      // Let any worker that was between polling steps observe the gate, then
      // prove the queue and browser are still empty before changing process.
      await wait(RECHECK_DELAY_MS);
      const confirmed = this.options.getCompanionState();
      const confirmedBrowser = confirmed.browser;
      const confirmedJobs = await getExecutionEngineQueueState();
      if (!confirmed.helpersIdle || confirmedBrowser.state !== 'closed' || confirmedBrowser.activePages || confirmedBrowser.queuedPages || confirmedJobs.queued || confirmedJobs.running || confirmedJobs.busyWorkers) {
        cancelExecutionEngineDrain();
        this.resetIdleWindow();
        return;
      }

      const gc = await runControlledGc();
      await reportRuntimeMetrics([
        { key: 'runner_gc_before_bytes', value: gc.before },
        { key: 'runner_gc_after_bytes', value: gc.after },
        { key: 'runner_reclaim_state', text: gc.ran ? 'gc_complete' : 'gc_unavailable' }
      ]);
      await recordPerformanceMetric({ scope: 'runner', metric: 'memory_reclaim', dimension: gc.ran ? 'gc' : 'gc_unavailable' });

      if (gc.after <= ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES) {
        if (gc.before - gc.after >= 8 * 1024 * 1024) {
          await appendRuntimeLog({ level: 'info', source: 'system', message: `统一执行引擎空闲内存回收：受控 GC 后 RSS 由 ${toMiB(gc.before)}MB 降至 ${toMiB(gc.after)}MB。` });
        }
        cancelExecutionEngineDrain();
        this.resetIdleWindow();
        return;
      }

      this.recycling = true;
      await reportRuntimeMetrics([{ key: 'runner_reclaim_state', text: 'restarting' }]);
      await recordPerformanceMetric({ scope: 'runner', metric: 'memory_reclaim', dimension: 'restart' });
      await appendRuntimeLog({ level: 'info', source: 'system', message: `统一执行引擎空闲且 RSS 仍为 ${toMiB(gc.after)}MB，已安全重启引擎回收内存；网页服务不会中断。` });
      await this.options.onRecycle();
    } catch (error) {
      // Reclamation is optional. Never let a telemetry/database hiccup affect
      // task processing; the next interval can evaluate it again.
      cancelExecutionEngineDrain();
      this.resetIdleWindow();
      console.warn(`Execution engine memory reclamation skipped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.checking = false;
    }
  }
}

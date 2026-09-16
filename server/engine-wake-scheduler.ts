import { db, getJellyfinSettings, getSetting } from './db.js';
import type { ExecutionEngineController } from './engine-controller.js';

const FALLBACK_SCAN_MS = 60_000;

type NextWakeRow = { wake_at: string | null };

/** Durable queue data remains authoritative; timers only avoid idle polling. */
export class EngineWakeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private fallback: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly engine: ExecutionEngineController) {}

  async wake(reason: string) {
    await this.engine.wake(reason);
    void this.schedule();
  }

  start() {
    this.stopped = false;
    void this.schedule();
    this.fallback = setInterval(() => void this.schedule(), FALLBACK_SCAN_MS);
    this.fallback.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.fallback) clearInterval(this.fallback);
    this.timer = null;
    this.fallback = null;
  }

  private async nextWakeAt() {
    const queue = await db.get<NextWakeRow>(`SELECT MIN(wake_at) AS wake_at FROM (
      SELECT MIN(COALESCE(retry_after, requested_at)) AS wake_at FROM jobs WHERE status = 'queued'
      UNION ALL SELECT MIN(COALESCE(retry_after, requested_at)) FROM release_jobs WHERE status = 'queued'
      UNION ALL SELECT MIN(COALESCE(retry_after, requested_at)) FROM magnet_jobs WHERE status = 'queued'
      UNION ALL SELECT MIN(COALESCE(retry_after, requested_at)) FROM library_jobs WHERE status = 'queued'
      UNION ALL SELECT MIN(COALESCE(retry_after, requested_at)) FROM download_jobs WHERE status = 'queued'
      UNION ALL SELECT MIN(requested_at) FROM library_sync_jobs WHERE status = 'queued'
      UNION ALL SELECT MIN(COALESCE(next_scheduled_at, updated_at)) FROM subscriptions WHERE is_active = 1
    ) AS candidates`);
    let next = queue?.wake_at ? Date.parse(queue.wake_at) : Number.POSITIVE_INFINITY;
    const jellyfin = getJellyfinSettings();
    if (jellyfin.enabled && jellyfin.libraryIds.length) {
      const last = Date.parse(getSetting('jellyfin_last_synced_at'));
      next = Math.min(next, Number.isFinite(last) ? last + jellyfin.syncIntervalMinutes * 60_000 : Date.now());
    }
    return next;
  }

  private async schedule() {
    if (this.stopped) return;
    try {
      const next = await this.nextWakeAt();
      let delay = Number.isFinite(next) ? Math.max(0, next - Date.now()) : FALLBACK_SCAN_MS;
      if (delay <= 250) {
        await this.engine.wake('计划任务或重试已到期');
        if (this.stopped) return;
        // The child now owns the due work. Re-querying the same due row every
        // few milliseconds would turn this wake path back into polling.
        delay = FALLBACK_SCAN_MS;
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.schedule(), Math.min(Math.max(delay, 500), FALLBACK_SCAN_MS));
      this.timer.unref();
    } catch (error) {
      console.warn(`Unable to schedule execution engine wake: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

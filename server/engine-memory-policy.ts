export const ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES = 160 * 1024 * 1024;
export const ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS = 2 * 60_000;
export const ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS = 5 * 60_000;

export type EngineMemoryEligibility = {
  now: number;
  startedAt: number;
  recycleNotBefore: number;
  idleSince: number | null;
  rssBytes: number;
  browserState: 'active' | 'idle' | 'closed';
  activePages: number;
  queuedPages: number;
  queuedJobs: number;
  runningJobs: number;
  busyWorkers: number;
};

/**
 * A runner is only recyclable after a sustained, fully idle interval. The
 * caller performs a second check after closing the drain gate before exiting.
 */
export function isEligibleForExecutionEngineMemoryReclaim(input: EngineMemoryEligibility) {
  return input.now - input.startedAt >= ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS
    && input.now >= input.recycleNotBefore
    && input.idleSince !== null
    && input.now - input.idleSince >= ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS
    && input.rssBytes > ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES
    && input.browserState === 'closed'
    && input.activePages === 0
    && input.queuedPages === 0
    && input.queuedJobs === 0
    && input.runningJobs === 0
    && input.busyWorkers === 0;
}

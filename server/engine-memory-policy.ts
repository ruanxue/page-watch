export const ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES = 160 * 1024 * 1024;
export const ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS = 2 * 60_000;
export const ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS = 5 * 60_000;

// 小内存 NAS 可以把阈值调低，性能模式或大内存机器可以调高；范围之外的值一律
// 收敛到边界，避免手误写出 0 或天文数字让回收器彻底失效。
const THRESHOLD_MIN_MB = 64;
const THRESHOLD_MAX_MB = 4_096;

/**
 * 引擎内存回收阈值：默认 160MB，可用 ENGINE_MEMORY_RECYCLE_THRESHOLD_MB 覆盖。
 * 非法或空值回落到默认值，保证回收行为在任何配置下都是确定的。
 */
export function engineMemoryReclaimThresholdBytes(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(env.ENGINE_MEMORY_RECYCLE_THRESHOLD_MB);
  if (!Number.isFinite(configured) || configured <= 0) return ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES;
  const bounded = Math.min(THRESHOLD_MAX_MB, Math.max(THRESHOLD_MIN_MB, configured));
  return Math.round(bounded * 1024 * 1024);
}

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
  /** 未指定时按 ENGINE_MEMORY_RECYCLE_THRESHOLD_MB 解析，便于调用方复用同一阈值。 */
  thresholdBytes?: number;
};

/**
 * A runner is only recyclable after a sustained, fully idle interval. The
 * caller performs a second check after closing the drain gate before exiting.
 */
export function isEligibleForExecutionEngineMemoryReclaim(input: EngineMemoryEligibility) {
  const thresholdBytes = input.thresholdBytes ?? engineMemoryReclaimThresholdBytes();
  return input.now - input.startedAt >= ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS
    && input.now >= input.recycleNotBefore
    && input.idleSince !== null
    && input.now - input.idleSince >= ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS
    && input.rssBytes > thresholdBytes
    && input.browserState === 'closed'
    && input.activePages === 0
    && input.queuedPages === 0
    && input.queuedJobs === 0
    && input.runningJobs === 0
    && input.busyWorkers === 0;
}

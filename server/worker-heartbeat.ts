export type WorkerName = 'api' | 'capture' | 'release' | 'magnet' | 'download' | 'library';

export type WorkerTaskContext = {
  kind?: string | null;
  subscriptionId?: number | null;
  archiveEntryId?: number | null;
  content?: string | null;
  current?: number | null;
  total?: number | null;
  label?: string | null;
};

export type WorkerHeartbeatContext = {
  status: 'ready' | 'busy' | 'sleeping' | 'error';
  detail: string;
  kind: string | null;
  subscriptionId: number | null;
  archiveEntryId: number | null;
  content: string | null;
  current: number | null;
  total: number | null;
  label: string | null;
};

export type WorkerHeartbeatWrite = {
  /** 为 null 表示这是节流窗口内内容未变化的重复心跳，不需要写库。 */
  signature: string | null;
  /** 该 worker 是否正挂在一项任务上，任务中心需要据此刷新。 */
  hadTask: boolean;
  /** 本次心跳内容是否与上一次不同。 */
  changed: boolean;
};

export type WorkerHeartbeatOptions = {
  /**
   * 即使内容没有变化、节流窗口未过，也强制写库。统一执行引擎需要这个能力：
   * 一个 handler 进入长耗时的浏览器批次后，期间无法自己上报心跳，否则它的
   * 在线状态会超过 API 的过期窗口，导致它明明健康且忙碌，`/api/ready` 却失败。
   */
  force?: boolean;
};

const heartbeatCache = new Map<WorkerName, { signature: string; persistedAt: number; hadTask: boolean }>();
const heartbeatPersistIntervalMs = 60_000;

/**
 * 判断一次心跳是否需要写 MySQL。保持为纯函数，才能在不需要数据库连接池的
 * 前提下直接测试节流逻辑。
 */
export function resolveHeartbeatWrite(workerName: WorkerName, context: WorkerHeartbeatContext, nowMs = Date.now(), options: WorkerHeartbeatOptions = {}): WorkerHeartbeatWrite {
  const signature = JSON.stringify(context);
  const previous = heartbeatCache.get(workerName);
  const changed = previous?.signature !== signature;
  const hadTask = Boolean(context.kind || context.archiveEntryId || context.subscriptionId);
  // 内容相同的心跳只用于续期在线状态。它刻意不唤醒 SSE 客户端，也不让任务
  // 中心重新下载队列。
  if (!options.force && !changed && previous && nowMs - previous.persistedAt < heartbeatPersistIntervalMs) {
    return { signature: null, hadTask, changed: false };
  }
  heartbeatCache.set(workerName, { signature, persistedAt: nowMs, hadTask });
  return { signature, hadTask, changed };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHeartbeatWrite, type WorkerHeartbeatContext, type WorkerName } from './worker-heartbeat.js';

/**
 * 统一执行引擎会替它管理的 worker 续报在线状态：一个 handler 进入长耗时的
 * 浏览器批次后，期间无法自己上报心跳，在线状态就会超过 API 设置的 90 秒过期
 * 窗口，导致它明明健康且忙碌，`/api/ready` 却返回失败。这些测试把支撑该续报
 * 的缓存约定固定下来。
 */

// 节流缓存的生命周期是整个进程，因此每个测试都要用独立的 worker 名；
// WorkerName 是封闭联合类型，所以这里做一次类型断言。
function uniqueWorker() {
  return `probe_${Math.random().toString(36).slice(2)}` as unknown as WorkerName;
}

function context(overrides: Partial<WorkerHeartbeatContext> = {}): WorkerHeartbeatContext {
  return {
    status: 'busy',
    detail: '正在执行引擎中处理队列',
    kind: null,
    subscriptionId: null,
    archiveEntryId: null,
    content: null,
    current: null,
    total: null,
    label: null,
    ...overrides
  };
}

test('writes a heartbeat immediately when its details change', () => {
  const worker = uniqueWorker();
  const now = Date.now();
  assert.equal(resolveHeartbeatWrite(worker, context({ detail: '正在读取发行日期详情页' }), now).changed, true);
  const second = resolveHeartbeatWrite(worker, context({ detail: '发行日期详情页读取', status: 'ready' }), now + 1_000);
  assert.equal(second.changed, true);
  assert.ok(second.signature, 'changed details must always be persisted');
});

test('throttles an unchanged heartbeat inside the window', () => {
  const worker = uniqueWorker();
  const now = Date.now();
  assert.ok(resolveHeartbeatWrite(worker, context(), now).signature, 'the first heartbeat must be persisted');
  assert.equal(resolveHeartbeatWrite(worker, context(), now + 15_000).signature, null, 'an identical heartbeat inside the window must not be persisted');
  assert.ok(resolveHeartbeatWrite(worker, context(), now + 60_000).signature, 'an identical heartbeat after the window must be persisted');
});

test('a forced heartbeat is persisted on every renewal', () => {
  const worker = uniqueWorker();
  const start = Date.now();
  resolveHeartbeatWrite(worker, context(), start);
  // 引擎每 15 秒续报一次。没有 force 时，60 秒的节流会把四次续报里的三次
  // 丢掉，忙碌 worker 的在线状态就会照样过期——这正是原先那个缺陷。
  for (let elapsed = 15_000; elapsed <= 60_000; elapsed += 15_000) {
    const at = start + elapsed;
    assert.ok(resolveHeartbeatWrite(worker, context(), at, { force: true }).signature, `renewal at +${elapsed}ms must persist`);
  }
});

test('a forced duplicate renewal does not look like a change', () => {
  const worker = uniqueWorker();
  const now = Date.now();
  resolveHeartbeatWrite(worker, context(), now);
  const duplicate = resolveHeartbeatWrite(worker, context(), now + 15_000, { force: true });
  assert.ok(duplicate.signature, 'the write must happen');
  assert.equal(duplicate.changed, false, 'a duplicate renewal must not wake SSE clients');
});

test('reports whether the heartbeat belongs to a task', () => {
  assert.equal(resolveHeartbeatWrite(uniqueWorker(), context(), Date.now()).hadTask, false);
  assert.equal(resolveHeartbeatWrite(uniqueWorker(), context({ kind: 'release', archiveEntryId: 7 }), Date.now()).hadTask, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES, ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS, ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS, engineMemoryReclaimThresholdBytes, isEligibleForExecutionEngineMemoryReclaim } from './engine-memory-policy.js';

const now = 10_000_000;
const ready = {
  now,
  startedAt: now - ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS,
  recycleNotBefore: now,
  idleSince: now - ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS,
  rssBytes: ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES + 1,
  browserState: 'closed' as const,
  activePages: 0,
  queuedPages: 0,
  queuedJobs: 0,
  runningJobs: 0,
  busyWorkers: 0
};

test('reclaims only after a sustained fully idle, high-memory interval', () => {
  assert.equal(isEligibleForExecutionEngineMemoryReclaim(ready), true);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, browserState: 'idle' }), false);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, queuedJobs: 1 }), false);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, runningJobs: 1 }), false);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, busyWorkers: 1 }), false);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, rssBytes: ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES }), false);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, idleSince: now - ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS + 1 }), false);
});

test('honours an explicit threshold so callers can reuse one resolved value', () => {
  const thresholdBytes = 64 * 1024 * 1024;
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, rssBytes: thresholdBytes + 1, thresholdBytes }), true);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, rssBytes: 100 * 1024 * 1024, thresholdBytes }), true);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, rssBytes: thresholdBytes, thresholdBytes }), false);
});

test('parses the threshold from the environment with safe fallbacks', () => {
  assert.equal(engineMemoryReclaimThresholdBytes({}), ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES);
  assert.equal(engineMemoryReclaimThresholdBytes({ ENGINE_MEMORY_RECYCLE_THRESHOLD_MB: '' }), ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES);
  assert.equal(engineMemoryReclaimThresholdBytes({ ENGINE_MEMORY_RECYCLE_THRESHOLD_MB: '不是数字' }), ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES);
  assert.equal(engineMemoryReclaimThresholdBytes({ ENGINE_MEMORY_RECYCLE_THRESHOLD_MB: '0' }), ENGINE_MEMORY_RECLAIM_DEFAULT_THRESHOLD_BYTES);
  assert.equal(engineMemoryReclaimThresholdBytes({ ENGINE_MEMORY_RECYCLE_THRESHOLD_MB: '240' }), 240 * 1024 * 1024);
  // 越界值收敛到边界，而不是让回收器失效。
  assert.equal(engineMemoryReclaimThresholdBytes({ ENGINE_MEMORY_RECYCLE_THRESHOLD_MB: '1' }), 64 * 1024 * 1024);
  assert.equal(engineMemoryReclaimThresholdBytes({ ENGINE_MEMORY_RECYCLE_THRESHOLD_MB: '99999' }), 4096 * 1024 * 1024);
});

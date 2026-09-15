import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS, ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS, ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES, isEligibleForExecutionEngineMemoryReclaim } from './engine-memory-policy.js';

const now = 10_000_000;
const ready = {
  now,
  startedAt: now - ENGINE_MEMORY_RECLAIM_MIN_UPTIME_MS,
  recycleNotBefore: now,
  idleSince: now - ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS,
  rssBytes: ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES + 1,
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
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, rssBytes: ENGINE_MEMORY_RECLAIM_THRESHOLD_BYTES }), false);
  assert.equal(isEligibleForExecutionEngineMemoryReclaim({ ...ready, idleSince: now - ENGINE_MEMORY_RECLAIM_IDLE_GRACE_MS + 1 }), false);
});

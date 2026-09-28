import assert from 'node:assert/strict';
import test from 'node:test';
import { isJellyfinSyncDue, nextJellyfinSyncAt } from './library-sync-schedule.js';

const now = Date.parse('2026-09-28T12:00:00.000Z');

test('queues the initial Jellyfin index build when it has never been attempted', () => {
  assert.equal(isJellyfinSyncDue({
    lastSyncedAt: '', lastAttemptAt: '', mediaIndexSyncedAt: '', intervalMinutes: 60, now
  }), true);
});

test('backs off after a failed initial sync even while the media index is missing', () => {
  const schedule = {
    lastSyncedAt: '', lastAttemptAt: new Date(now - 30_000).toISOString(), mediaIndexSyncedAt: '', intervalMinutes: 60, now
  };
  assert.equal(isJellyfinSyncDue(schedule), false);
  assert.equal(nextJellyfinSyncAt(schedule), now + 4.5 * 60_000);
});

test('retries a failed initial sync after the bounded five-minute backoff', () => {
  assert.equal(isJellyfinSyncDue({
    lastSyncedAt: '', lastAttemptAt: new Date(now - 5 * 60_000).toISOString(), mediaIndexSyncedAt: '', intervalMinutes: 60, now
  }), true);
});

test('backs off an overdue scheduled sync after failure even if an older index exists', () => {
  assert.equal(isJellyfinSyncDue({
    lastSyncedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(now - 60_000).toISOString(),
    mediaIndexSyncedAt: '2026-09-27T10:00:00.000Z',
    intervalMinutes: 60,
    now
  }), false);
});

test('does not queue a sync before its configured interval', () => {
  assert.equal(isJellyfinSyncDue({
    lastSyncedAt: new Date(now - 30 * 60_000).toISOString(),
    lastAttemptAt: '',
    mediaIndexSyncedAt: '2026-09-28T11:30:00.000Z',
    intervalMinutes: 60,
    now
  }), false);
});

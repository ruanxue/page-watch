import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldEnqueueDownloadCompletionNotification } from './download-notification.js';

test('queues a completion notification on the first transition in a download cycle', () => {
  assert.equal(shouldEnqueueDownloadCompletionNotification('downloading', 'completed', null), true);
});

test('does not queue another completion notification after a transient qBittorrent state regression', () => {
  const notificationQueuedAt = '2026-09-24T12:45:02.872Z';
  assert.equal(shouldEnqueueDownloadCompletionNotification('downloading', 'completed', notificationQueuedAt), false);
  assert.equal(shouldEnqueueDownloadCompletionNotification('paused', 'completed', notificationQueuedAt), false);
});

test('does not re-notify an already-completed entry during startup observation', () => {
  assert.equal(shouldEnqueueDownloadCompletionNotification('completed', 'completed', '2026-09-24T12:45:02.872Z'), false);
});

test('allows a new download cycle to notify after its marker is reset', () => {
  assert.equal(shouldEnqueueDownloadCompletionNotification('downloading', 'completed', null), true);
});

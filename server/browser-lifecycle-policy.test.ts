import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRebuildBrowserAfterTaskError } from './browser-lifecycle-policy.js';

test('keeps the shared browser when only the page failed', () => {
  assert.equal(shouldRebuildBrowserAfterTaskError({ contextCreated: true, browserConnected: true }), false);
});

test('rebuilds when the browser itself is gone', () => {
  assert.equal(shouldRebuildBrowserAfterTaskError({ contextCreated: true, browserConnected: false }), true);
  assert.equal(shouldRebuildBrowserAfterTaskError({ contextCreated: false, browserConnected: true }), true);
  assert.equal(shouldRebuildBrowserAfterTaskError({ contextCreated: false, browserConnected: false }), true);
});

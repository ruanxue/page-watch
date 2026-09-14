import assert from 'node:assert/strict';
import test from 'node:test';
import { isIndexedJellyfinVideoType, jellyfinAuthorizationHeader } from './jellyfin.js';

test('uses Jellyfin 12 MediaBrowser authorization instead of the deprecated token header', () => {
  assert.equal(jellyfinAuthorizationHeader('api-key-value'), 'MediaBrowser Token="api-key-value"');
  assert.equal(jellyfinAuthorizationHeader('key"with\\characters'), 'MediaBrowser Token="key\\"with\\\\characters"');
});

test('ignores Jellyfin 12 collection and folder records when indexing videos', () => {
  assert.equal(isIndexedJellyfinVideoType('Movie'), true);
  assert.equal(isIndexedJellyfinVideoType('Video'), true);
  assert.equal(isIndexedJellyfinVideoType('BoxSet'), false);
  assert.equal(isIndexedJellyfinVideoType('Folder'), false);
});

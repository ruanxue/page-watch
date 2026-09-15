import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveKey, exactJellyfinMatch } from './jellyfin-match.js';

test('normalizes only a whole archive code', () => {
  assert.equal(archiveKey('IPZZ-698'), 'ipzz-698');
  assert.equal(archiveKey('ipzz-698-uncensored'), null);
});

test('requires an exact code boundary in Jellyfin metadata', () => {
  const media = [
    { id: 'wrong', libraryId: 'library', name: 'IPZZ-6980.mp4', originalTitle: null, path: null, type: 'Movie' },
    { id: 'right', libraryId: 'library', name: 'hhd800 IPZZ-698', originalTitle: null, path: '/media/IPZZ-698.mp4', type: 'Movie' }
  ];
  assert.equal(exactJellyfinMatch('ipzz-698', media)?.id, 'right');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldColdPauseSizeFilteredWaiting } from './download-state.js';
import type { QbittorrentTorrentState } from './qbittorrent.js';

const pausedTorrent: QbittorrentTorrentState = {
  hash: '0123456789abcdef0123456789abcdef01234567',
  state: 'stoppedDL',
  progress: 0.2,
  downloadedBytes: 20,
  totalSize: 100,
  downloadSpeed: 0,
  savePath: null,
  contentPath: null
};

test('cold-pauses a size-filtered waiting torrent only while paused metadata is unavailable', () => {
  assert.equal(shouldColdPauseSizeFilteredWaiting('waiting', 1024, pausedTorrent, false), true);
  assert.equal(shouldColdPauseSizeFilteredWaiting('waiting', 1024, pausedTorrent, true), false);
  assert.equal(shouldColdPauseSizeFilteredWaiting('downloading', 1024, pausedTorrent, false), false);
  assert.equal(shouldColdPauseSizeFilteredWaiting('waiting', 0, pausedTorrent, false), false);
  assert.equal(shouldColdPauseSizeFilteredWaiting('waiting', 1024, { ...pausedTorrent, state: 'downloading' }, false), false);
});

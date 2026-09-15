import assert from 'node:assert/strict';
import test from 'node:test';
import { getQbittorrentTorrentFiles, setQbittorrentTorrentFilePriority } from './qbittorrent.js';

const config = {
  url: 'http://qbittorrent.test:8080',
  authMode: 'api_key' as const,
  apiKey: `qbt_${'a'.repeat(28)}`
};
const hash = '0123456789abcdef0123456789abcdef01234567';

test('reads torrent files and sets qBittorrent per-file download priority', async (context) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? '') });
    if (url.includes('/api/v2/torrents/files')) {
      return new Response(JSON.stringify([
        { index: 0, name: 'MIDA-744.mp4', size: 4_000_000_000, priority: 1 },
        { index: 1, name: 'ad.jpg', size: 50_000, priority: 1 },
        { index: 'bad', name: 'ignored', size: 1, priority: 1 }
      ]), { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const files = await getQbittorrentTorrentFiles(config, hash);
  assert.deepEqual(files, [
    { index: 0, name: 'MIDA-744.mp4', size: 4_000_000_000, priority: 1 },
    { index: 1, name: 'ad.jpg', size: 50_000, priority: 1 }
  ]);

  await setQbittorrentTorrentFilePriority(config, hash, [1], 0);
  assert.match(requests[0].url, /\/api\/v2\/torrents\/files\?hash=/);
  assert.equal(requests[1].body, `hash=${hash}&id=1&priority=0`);
});

test('waits for magnet metadata when qBittorrent has no file list yet', async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 409 })) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await getQbittorrentTorrentFiles(config, hash), null);
});

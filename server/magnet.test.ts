import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { pool } from './db.js';
import { decodeCloudflareEmail, findMagnetDetailPath } from './magnet.js';

const searchPage = `
  <ul>
    <li class="item"><div class="filename"><b>ATID-799</b>/4k688.com@ATID-799.mp4</div><a class="link" href="/magnet/fallback-first"></a></li>
    <li class="item"><div class="filename">hhd800.com@ATID-799.mp4</div><a class="link" href="/magnet/primary"></a></li>
    <li class="item"><div class="filename"><b>ATID-799</b>/4k688.com@ATID-799-alt.mp4</div><a class="link" href="/magnet/fallback-second"></a></li>
  </ul>`;

test('prefers an hhd800 result even when a 4k688 fallback appears first', () => {
  assert.equal(findMagnetDetailPath(searchPage), '/magnet/primary');
});

test('uses the first 4k688 fallback only when the primary prefix is absent', () => {
  const withoutPrimary = searchPage.replace('<li class="item"><div class="filename">hhd800.com@ATID-799.mp4</div><a class="link" href="/magnet/primary"></a></li>', '');
  assert.equal(findMagnetDetailPath(withoutPrimary), '/magnet/fallback-first');
});

test('decodes Cloudflare-protected fallback filenames before matching', () => {
  const email = `4k688.com${String.fromCharCode(64)}ATID-799.mp4`;
  const key = 0x12;
  const encoded = [key, ...[...Buffer.from(email)].map((byte) => byte ^ key)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const protectedSearch = `<li class="item"><div class="filename"><b>ATID-799</b>/<a class="__cf_email__" data-cfemail="${encoded}">[email protected]</a></div><a class="link" href="/magnet/cloudflare-fallback"></a></li>`;
  assert.equal(decodeCloudflareEmail(encoded), email);
  assert.equal(findMagnetDetailPath(protectedSearch), '/magnet/cloudflare-fallback');
});

after(async () => {
  await pool.end();
});

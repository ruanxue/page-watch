import assert from 'node:assert/strict';
import test from 'node:test';
import { missavBackupUrl, shouldTryMissavBackup } from './site-fallback.js';

test('maps only the primary MissAV origin to its backup while retaining the path and query', () => {
  assert.equal(missavBackupUrl(new URL('https://missav123.com/dm109/cn/actresses/demo?filters=individual'))?.toString(), 'https://missav.live/dm109/cn/actresses/demo?filters=individual');
  assert.equal(missavBackupUrl(new URL('https://example.com/cn/atid-799')), null);
});

test('uses the backup only for site availability failures', () => {
  assert.equal(shouldTryMissavBackup(new Error('page.goto: net::ERR_EMPTY_RESPONSE')), true);
  assert.equal(shouldTryMissavBackup(new Error('详情页返回 HTTP 503。')), true);
  assert.equal(shouldTryMissavBackup(new Error('找不到选择器：a.text-secondary[alt]')), false);
  assert.equal(shouldTryMissavBackup(new Error('内容匹配规则没有匹配到结果。')), false);
});

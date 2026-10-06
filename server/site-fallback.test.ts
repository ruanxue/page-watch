import assert from 'node:assert/strict';
import test from 'node:test';
import { siteFallbackUrl, shouldTryMissavBackup } from './site-fallback.js';

const sites = ['https://missav123.com', 'https://missav.live'];

test('换站时保留原页面路径与查询参数', () => {
  assert.equal(
    siteFallbackUrl(new URL('https://missav123.com/dm109/cn/actresses/demo?filters=individual'), sites)?.toString(),
    'https://missav.live/dm109/cn/actresses/demo?filters=individual');
});

test('列表中的站点依次轮换，最后一个会回到第一个', () => {
  assert.equal(siteFallbackUrl(new URL('https://missav.live/cn/atid-799'), sites)?.toString(), 'https://missav123.com/cn/atid-799');
});

test('当前地址不在站点列表时改从第一个站点重试', () => {
  assert.equal(siteFallbackUrl(new URL('https://example.com/cn/atid-799'), sites)?.toString(), 'https://missav123.com/cn/atid-799');
});

test('只有一个站点时没有可切换的地址', () => {
  assert.equal(siteFallbackUrl(new URL('https://missav123.com/cn/atid-799'), ['https://missav123.com']), null);
});

test('只有可用性故障才换站，规则类错误必须原样暴露', () => {
  assert.equal(shouldTryMissavBackup(new Error('page.goto: net::ERR_EMPTY_RESPONSE')), true);
  assert.equal(shouldTryMissavBackup(new Error('详情页返回 HTTP 503。')), true);
  assert.equal(shouldTryMissavBackup(new Error('找不到选择器：a.text-secondary[alt]')), false);
  assert.equal(shouldTryMissavBackup(new Error('内容匹配规则没有匹配到结果。')), false);
});

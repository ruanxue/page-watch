import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedSiteHosts, defaultSites, MAX_SITES, nextSiteUrl, normalizeSiteList, normalizeSiteUrl, orderedSiteUrls, validateSiteList } from './site-list.js';

/**
 * 站点列表是「检查规则」页面里可见、可改的一组地址：读取番号、标题、发行日期
 * 和女优页都按这里的顺序尝试。用户不是程序员，所以既要有合理默认值，也要容忍
 * 随手填写的写法。
 */

test('默认站点是两个常用地址', () => {
  assert.deepEqual(defaultSites, ['https://missav123.com', 'https://missav.live']);
});

test('站点只保留协议与域名，忽略多余路径和结尾斜杠', () => {
  assert.equal(normalizeSiteUrl('missav123.com'), null, '缺少协议时无法判断站点');
  assert.equal(normalizeSiteUrl(' https://missav123.com/ '), 'https://missav123.com');
  assert.equal(normalizeSiteUrl('https://missav.live/cn/actresses/demo'), 'https://missav.live');
  assert.equal(normalizeSiteUrl('http://example.com:8080/path'), 'http://example.com:8080');
  assert.equal(normalizeSiteUrl('ftp://missav123.com'), null);
  assert.equal(normalizeSiteUrl('https://user:secret@missav123.com'), null, '不接受带账号密码的地址');
  assert.equal(normalizeSiteUrl(''), null);
});

test('站点去重、保留填写顺序，并要求第一个是有效地址', () => {
  assert.deepEqual(
    normalizeSiteList(['https://missav.live', 'https://missav123.com', 'https://missav.live/']),
    ['https://missav.live', 'https://missav123.com']);
});

test('站点数量上限为五个', () => {
  const many = ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com', 'https://f.com'];
  assert.equal(normalizeSiteList(many).length, MAX_SITES);
});

test('站点被清空或全是非法值时回落到默认值，避免出现无法读取的状态', () => {
  assert.deepEqual(normalizeSiteList([]), defaultSites);
  assert.deepEqual(normalizeSiteList(['不是网址']), defaultSites);
  assert.deepEqual(normalizeSiteList(undefined), defaultSites);
});

test('保存时至少需要一个站点', () => {
  assert.throws(() => validateSiteList([]), /至少填写一个读取站点/);
  assert.doesNotThrow(() => validateSiteList(['https://missav123.com']));
});

test('允许访问的主机名来自配置的站点', () => {
  const hosts = allowedSiteHosts(['https://missav123.com', 'https://missav.live']);
  assert.equal(hosts.has('missav123.com'), true);
  assert.equal(hosts.has('missav.live'), true);
  assert.equal(allowedSiteHosts(['https://missav.live']).has('missav123.com'), false);
});

test('按列表顺序轮换站点，并保留原页面路径与查询参数', () => {
  const sites = ['https://missav123.com', 'https://missav.live', 'https://third.example'];
  assert.equal(nextSiteUrl(new URL('https://missav123.com/dm11/cn/abc?q=1'), sites)?.toString(), 'https://missav.live/dm11/cn/abc?q=1');
  assert.equal(nextSiteUrl(new URL('https://missav.live/dm11/cn/abc'), sites)?.toString(), 'https://third.example/dm11/cn/abc');
  assert.equal(nextSiteUrl(new URL('https://third.example/dm11/cn/abc'), sites)?.toString(), 'https://missav123.com/dm11/cn/abc', '最后一个会回到第一个');
});

test('当前地址不在站点列表时改用第一个站点', () => {
  assert.equal(nextSiteUrl(new URL('https://old-domain.example/cn/atid-799'), ['https://missav123.com', 'https://missav.live'])?.toString(), 'https://missav123.com/cn/atid-799');
});

test('只有一个站点时没有可切换的地址', () => {
  assert.equal(nextSiteUrl(new URL('https://missav123.com/cn/atid-799'), ['https://missav123.com']), null);
});

test('站点顺序决定优先使用的站点', () => {
  const sites = ['https://missav.live', 'https://missav123.com'];
  assert.equal(nextSiteUrl(new URL('https://missav.live/cn/atid-799'), sites)?.toString(), 'https://missav123.com/cn/atid-799');
});

test('每次检查从首选站点开始并保留订阅路径与参数', () => {
  const urls = orderedSiteUrls(new URL('https://old.example/cn/actress?page=3#list'), ['https://missav.live', 'https://missav123.com']);
  assert.deepEqual(urls.map((url) => url.toString()), [
    'https://missav.live/cn/actress?page=3#list',
    'https://missav123.com/cn/actress?page=3#list'
  ]);
});

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildNotificationRequest, dingtalkSignature, notificationMarkdown, notificationText, webhookSignature } from './notification-protocol.js';
import type { NotificationPayload, NotificationSettings } from './notifications.js';

const baseSettings: NotificationSettings = {
  enabled: true,
  channel: 'wecom',
  events: { content_discovered: true, operation_failed: true, magnet_found: false, download_completed: false },
  wecomWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example',
  dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=example',
  dingtalkSecret: 'SECexample',
  webhookUrl: 'https://hooks.example.test/page-watch',
  webhookHmacSecret: 'webhook-secret'
};

const testPayload: NotificationPayload = {
  version: 1,
  id: 'test-event',
  type: 'test',
  severity: 'info',
  occurredAt: '2026-09-18T00:00:00.000Z',
  title: '测试通知',
  summary: '通知渠道连接正常。',
  pagePath: '#subscriptions',
  subscription: null,
  operation: null,
  items: []
};

test('formats a branded DingTalk Markdown digest with independently linked content items', () => {
  const payload: NotificationPayload = {
    ...testPayload,
    type: 'content_discovered',
    title: '发现 8 条新内容',
    summary: '订阅“新片列表”本次检查发现 8 条新内容。',
    pagePath: '#archive',
    subscription: { id: 7, name: '新片列表' },
    items: Array.from({ length: 6 }, (_, index) => ({ content: `ITEM-${index + 1}`, detailUrl: `https://example.test/${index + 1}` }))
  };
  const markdown = notificationMarkdown(payload);
  assert.match(markdown, /^### Page Watch｜发现 8 条新内容/);
  assert.match(markdown, /\*\*订阅：\*\* 新片列表/);
  assert.match(markdown, /\*\*数量：\*\* 8 条/);
  assert.match(markdown, /\*\*详情 1：\*\* \[https:\/\/example\.test\/1\]\(https:\/\/example\.test\/1\)/);
  assert.match(markdown, /\*\*入口：\*\* Page Watch > 内容档案/);
  assert.match(markdown, /\*\*时间：\*\* 2026-09-18 08:00:00/);
  assert.match(markdown, /\*\*订阅：\*\* 新片列表\n\n\*\*数量：\*\* 8 条/);
  assert.equal((markdown.match(/ITEM-/g) ?? []).length, 5);
});

test('formats every event with a branded heading and stable field order', () => {
  const payloads: NotificationPayload[] = [
    { ...testPayload, type: 'magnet_found', title: '已找到磁力链接', subscription: { id: 1, name: '河北彩花' }, operation: { kind: '磁力检索' }, items: [{ content: 'SNOS-377' }], pagePath: '#archive' },
    { ...testPayload, type: 'download_completed', title: '下载已完成', subscription: { id: 1, name: '河北彩花' }, operation: { kind: 'qBittorrent 下载' }, items: [{ content: 'SNOS-377' }], pagePath: '#archive' },
    { ...testPayload, type: 'operation_failed', title: '发行日期读取最终失败', subscription: { id: 1, name: '河北彩花' }, operation: { kind: '发行日期读取', error: '发行日期详情页浏览器读取失败（目标：missav123.com；代理：未配置）：page.evaluate: ReferenceError: __name is not defined\n at UtilityScript.evaluate' }, items: [{ content: 'SNOS-377' }], pagePath: '#operations' },
    { ...testPayload, type: 'test', title: '测试通知', summary: '通知渠道连接正常。', pagePath: '#subscriptions' }
  ];
  for (const payload of payloads) {
    const markdown = notificationMarkdown(payload);
    assert.match(markdown, new RegExp(`^### Page Watch｜${payload.title}`));
    assert.match(markdown, /\*\*时间：\*\* 2026-09-18 08:00:00/);
  }
  const failure = notificationMarkdown(payloads[2]);
  assert.match(failure, /\*\*失败原因：\*\* 发行日期详情页浏览器读取失败（目标：missav123\.com；代理：未配置）/);
  assert.doesNotMatch(failure, /page\.evaluate|__name|UtilityScript/);
  assert.ok(failure.indexOf('**订阅：**') < failure.indexOf('**内容：**'));
  assert.ok(failure.indexOf('**内容：**') < failure.indexOf('**任务：**'));
  assert.ok(failure.indexOf('**任务：**') < failure.indexOf('**失败原因：**'));
  assert.match(notificationMarkdown(payloads[1]), /\*\*入口：\*\* Page Watch > 内容档案/);
  assert.match(notificationMarkdown(payloads[3]), /\*\*状态：\*\* 通知渠道连接正常。/);
});

test('formats a personal-WeChat-compatible Enterprise WeCom text request and a DingTalk Markdown request', async () => {
  const wecom = buildNotificationRequest(testPayload, { ...baseSettings, channel: 'wecom' }, '1720000000000');
  const wecomBody = JSON.parse(wecom.body);
  assert.equal(wecomBody.msgtype, 'text');
  assert.match(wecomBody.text.content, /Page Watch｜测试通知/);
  assert.doesNotMatch(wecomBody.text.content, /\*\*/);

  const dingtalk = buildNotificationRequest(testPayload, { ...baseSettings, channel: 'dingtalk' }, '1720000000000');
  const url = new URL(dingtalk.url);
  assert.equal(JSON.parse(dingtalk.body).msgtype, 'markdown');
  assert.match(JSON.parse(dingtalk.body).markdown.text, /^### Page Watch｜测试通知/);
  assert.ok(url.searchParams.get('timestamp'));
  assert.ok(url.searchParams.get('sign'));
});

test('keeps WeCom text messages within its 2048-byte limit without splitting Chinese characters', () => {
  const message = notificationText({ ...testPayload, summary: '新'.repeat(2_000) });
  assert.ok(Buffer.byteLength(message, 'utf8') <= 2_048);
  assert.doesNotMatch(message, /�/);
});

test('signs generic webhook bodies with timestamp and HMAC-SHA256', async () => {
  const sent = buildNotificationRequest(testPayload, { ...baseSettings, channel: 'webhook' }, '1720000000000');
  const headers = sent.headers;
  const body = sent.body;
  const timestamp = headers['x-page-watch-timestamp'];
  assert.equal(headers['x-page-watch-signature'], webhookSignature(baseSettings.webhookHmacSecret, timestamp, body));
  assert.equal(headers['x-page-watch-signature'], `sha256=${createHmac('sha256', baseSettings.webhookHmacSecret).update(`${timestamp}.${body}`).digest('hex')}`);
});

test('uses the DingTalk timestamp newline signing convention', () => {
  const timestamp = '1720000000000';
  assert.equal(dingtalkSignature('SECexample', timestamp), createHmac('sha256', 'SECexample').update(`${timestamp}\nSECexample`).digest('base64'));
});

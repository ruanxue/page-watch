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
  title: 'Page Watch 测试通知',
  summary: '通知渠道连接正常。',
  pagePath: '#subscriptions',
  subscription: null,
  operation: null,
  items: []
};

test('formats concise content digests with at most five entries', () => {
  const payload: NotificationPayload = {
    ...testPayload,
    type: 'content_discovered',
    title: '发现 8 条新内容',
    summary: '订阅“新片列表”本次检查发现 8 条新内容。',
    subscription: { id: 7, name: '新片列表' },
    items: Array.from({ length: 5 }, (_, index) => ({ content: `ITEM-${index + 1}` }))
  };
  const markdown = notificationMarkdown(payload);
  assert.match(markdown, /8 条新内容/);
  assert.equal((markdown.match(/ITEM-/g) ?? []).length, 5);
});

test('formats a personal-WeChat-compatible Enterprise WeCom text request and a DingTalk Markdown request', async () => {
  const wecom = buildNotificationRequest(testPayload, { ...baseSettings, channel: 'wecom' }, '1720000000000');
  const wecomBody = JSON.parse(wecom.body);
  assert.equal(wecomBody.msgtype, 'text');
  assert.match(wecomBody.text.content, /Page Watch 测试通知/);
  assert.doesNotMatch(wecomBody.text.content, /\*\*/);

  const dingtalk = buildNotificationRequest(testPayload, { ...baseSettings, channel: 'dingtalk' }, '1720000000000');
  const url = new URL(dingtalk.url);
  assert.equal(JSON.parse(dingtalk.body).msgtype, 'markdown');
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

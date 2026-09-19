import { createHmac } from 'node:crypto';
import type { NotificationPayload, NotificationSettings } from './notifications.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export type NotificationRequest = { url: string; body: string; headers: Record<string, string> };

export function webhookSignature(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function dingtalkSignature(secret: string, timestamp: string) {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

type NotificationField = { label: string; value: string; link?: boolean };

const pageLabels: Record<string, string> = {
  '#subscriptions': 'Page Watch > 订阅中心',
  '#archive': 'Page Watch > 内容档案',
  '#operations': 'Page Watch > 运行中心',
  '#settings': 'Page Watch > 设置',
  // Downloads now live in the archive/settings workflow. Keep old queued
  // payloads readable instead of exposing a page that no longer exists.
  '#downloads': 'Page Watch > 内容档案'
};

function formatNotificationTime(occurredAt: string) {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return occurredAt;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function conciseFailureReason(value: string) {
  const firstLine = value.replace(/\s+/g, ' ').trim().split(/\s+at\s+/i, 1)[0] ?? '';
  const frameworkStart = firstLine.search(/[：:]\s*(?:page\.|browserType\.|UtilityScript\b|ReferenceError\b|TypeError\b|SyntaxError\b)/i);
  const reason = (frameworkStart > 0 ? firstLine.slice(0, frameworkStart) : firstLine).trim();
  return reason.length > 180 ? `${reason.slice(0, 179)}…` : reason || '任务执行失败。';
}

function itemLabel(item: NotificationPayload['items'][number]) {
  return item.title ? `${item.content} · ${item.title}` : item.content;
}

function discoveredCount(payload: NotificationPayload) {
  const match = payload.title.match(/发现\s*(\d+)\s*条新内容/);
  return match ? Math.max(1, Number(match[1])) : Math.max(1, payload.items.length);
}

function notificationFields(payload: NotificationPayload): NotificationField[] {
  const fields: NotificationField[] = [];
  if (payload.subscription) fields.push({ label: '订阅', value: payload.subscription.name ?? `#${payload.subscription.id}` });
  if (payload.type === 'content_discovered') fields.push({ label: '数量', value: `${discoveredCount(payload)} 条` });
  const indexedItems = payload.items.slice(0, 5);
  indexedItems.forEach((item, index) => {
    const suffix = indexedItems.length > 1 ? ` ${index + 1}` : '';
    fields.push({ label: `内容${suffix}`, value: itemLabel(item) });
    if (payload.type === 'content_discovered' && item.detailUrl) fields.push({ label: `详情${suffix}`, value: item.detailUrl, link: true });
  });
  if (payload.operation?.kind) fields.push({ label: '任务', value: payload.operation.kind });
  if (payload.type === 'operation_failed') fields.push({ label: '失败原因', value: conciseFailureReason(payload.operation?.error ?? payload.summary) });
  if (payload.type === 'test') fields.push({ label: '状态', value: payload.summary });
  fields.push({ label: '时间', value: formatNotificationTime(payload.occurredAt) });
  fields.push({ label: '入口', value: pageLabels[payload.pagePath] ?? 'Page Watch' });
  return fields;
}

function notificationHeading(payload: NotificationPayload) {
  return `【Page Watch｜${payload.title.replace(/^Page Watch\s*/i, '')}】`;
}

export function notificationMarkdown(payload: NotificationPayload) {
  const lines = [`### ${notificationHeading(payload)}`, ''];
  for (const field of notificationFields(payload)) {
    const value = field.link ? `[${field.value}](${field.value})` : field.value;
    lines.push(`**${field.label}：** ${value}`);
  }
  return lines.join('\n').slice(0, 3500);
}

/**
 * Enterprise WeChat's Markdown robot messages are not rendered by some
 * personal-WeChat clients. Keep this deliberately plain so the same message
 * remains readable in both Enterprise WeChat and its personal-WeChat bridge.
 */
export function notificationText(payload: NotificationPayload) {
  const lines = [notificationHeading(payload), '', ...notificationFields(payload).map((field) => `${field.label}：${field.value}`)];
  return truncateUtf8(lines.join('\n'), 2048);
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Build a request without sending it so every transport has one auditable,
 * unit-testable wire format. The caller validates the configured URL first. */
export function buildNotificationRequest(payload: NotificationPayload, settings: NotificationSettings, timestamp = String(Date.now())): NotificationRequest {
  const markdown = notificationMarkdown(payload);
  if (settings.channel === 'wecom') {
    return { url: settings.wecomWebhook, body: JSON.stringify({ msgtype: 'text', text: { content: notificationText(payload) } }), headers: {} };
  }
  if (settings.channel === 'dingtalk') {
    const url = new URL(settings.dingtalkWebhook);
    if (settings.dingtalkSecret) {
      url.searchParams.set('timestamp', timestamp);
      url.searchParams.set('sign', dingtalkSignature(settings.dingtalkSecret, timestamp));
    }
    return { url: url.toString(), body: JSON.stringify({ msgtype: 'markdown', markdown: { title: payload.title.slice(0, 64), text: markdown } }), headers: {} };
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'x-page-watch-timestamp': timestamp, 'x-page-watch-event': payload.type };
  if (settings.webhookHmacSecret) headers['x-page-watch-signature'] = webhookSignature(settings.webhookHmacSecret, timestamp, body);
  return { url: settings.webhookUrl, body, headers };
}

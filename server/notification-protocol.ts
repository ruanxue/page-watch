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

export function notificationMarkdown(payload: NotificationPayload) {
  const lines = [`**${payload.title}**`, '', payload.summary];
  if (payload.subscription) lines.push(`订阅：${payload.subscription.name ?? `#${payload.subscription.id}`}`);
  if (payload.operation?.kind) lines.push(`任务：${payload.operation.kind}`);
  if (payload.items.length) {
    lines.push('', ...payload.items.slice(0, 5).map((item) => {
      const label = item.title ? `${item.content} · ${item.title}` : item.content;
      return item.detailUrl ? `- [${label}](${item.detailUrl})` : `- ${label}`;
    }));
  }
  lines.push('', `时间：${new Date(payload.occurredAt).toLocaleString('zh-CN', { hour12: false })}`, `Page Watch：${payload.pagePath}`);
  return lines.join('\n').slice(0, 3500);
}

/**
 * Enterprise WeChat's Markdown robot messages are not rendered by some
 * personal-WeChat clients. Keep this deliberately plain so the same message
 * remains readable in both Enterprise WeChat and its personal-WeChat bridge.
 */
export function notificationText(payload: NotificationPayload) {
  const lines = [payload.title, '', payload.summary];
  if (payload.subscription) lines.push(`订阅：${payload.subscription.name ?? `#${payload.subscription.id}`}`);
  if (payload.operation?.kind) lines.push(`任务：${payload.operation.kind}`);
  if (payload.items.length) {
    lines.push('', ...payload.items.slice(0, 5).flatMap((item) => {
      const label = item.title ? `${item.content} · ${item.title}` : item.content;
      return item.detailUrl ? [`• ${label}`, `  ${item.detailUrl}`] : [`• ${label}`];
    }));
  }
  lines.push('', `时间：${new Date(payload.occurredAt).toLocaleString('zh-CN', { hour12: false })}`, `Page Watch：${payload.pagePath}`);
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

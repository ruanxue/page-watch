import { createHash, randomUUID } from 'node:crypto';
import { db, getSetting, refreshSettings, setSetting, type DatabaseClient } from './db.js';
import { buildNotificationRequest, type FetchLike } from './notification-protocol.js';

export { dingtalkSignature, notificationMarkdown, webhookSignature } from './notification-protocol.js';

export type NotificationChannel = 'wecom' | 'dingtalk' | 'webhook';
export type NotificationEventType = 'content_discovered' | 'operation_failed' | 'magnet_found' | 'download_completed';
export type NotificationSeverity = 'info' | 'error';

export type NotificationItem = { content: string; title?: string | null; detailUrl?: string | null };
export type NotificationPayload = {
  version: 1;
  id: string;
  type: NotificationEventType | 'test';
  severity: NotificationSeverity;
  occurredAt: string;
  title: string;
  summary: string;
  pagePath: string;
  subscription: { id: number; name?: string | null } | null;
  operation: { kind: string; jobId?: number | null; error?: string | null } | null;
  items: NotificationItem[];
};

export type NotificationEvents = Record<NotificationEventType, boolean>;
export type NotificationSettings = {
  enabled: boolean;
  channel: NotificationChannel;
  events: NotificationEvents;
  wecomWebhook: string;
  dingtalkWebhook: string;
  dingtalkSecret: string;
  webhookUrl: string;
  webhookHmacSecret: string;
};

export type PublicNotificationSettings = Omit<NotificationSettings, 'wecomWebhook' | 'dingtalkWebhook' | 'dingtalkSecret' | 'webhookUrl' | 'webhookHmacSecret'> & {
  wecomWebhookConfigured: boolean;
  dingtalkWebhookConfigured: boolean;
  dingtalkSecretConfigured: boolean;
  webhookUrlConfigured: boolean;
  webhookHmacSecretConfigured: boolean;
};

export type NotificationSettingsPayload = {
  enabled?: unknown;
  channel?: unknown;
  events?: unknown;
  wecomWebhook?: unknown;
  dingtalkWebhook?: unknown;
  dingtalkSecret?: unknown;
  webhookUrl?: unknown;
  webhookHmacSecret?: unknown;
  clearWecomWebhook?: unknown;
  clearDingtalkWebhook?: unknown;
  clearDingtalkSecret?: unknown;
  clearWebhookUrl?: unknown;
  clearWebhookHmacSecret?: unknown;
};

const defaultEvents: NotificationEvents = {
  content_discovered: true,
  operation_failed: true,
  magnet_found: false,
  download_completed: false
};

const settingsKeys = {
  enabled: 'notification_enabled',
  channel: 'notification_channel',
  events: 'notification_events',
  wecomWebhook: 'notification_wecom_webhook',
  dingtalkWebhook: 'notification_dingtalk_webhook',
  dingtalkSecret: 'notification_dingtalk_secret',
  webhookUrl: 'notification_webhook_url',
  webhookHmacSecret: 'notification_webhook_hmac_secret'
} as const;

const notificationRetryDelaysMs = [15_000, 60_000, 4 * 60_000];
const maxDeliveryAttempts = notificationRetryDelaysMs.length + 1;
const dedupeWindowMs = 30 * 60_000;
const deliveryTimeoutMs = 15_000;

function stringSetting(key: string) { return getSetting(key).trim(); }

function parseEvents(raw: string): NotificationEvents {
  if (!raw) return { ...defaultEvents };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultEvents };
    return {
      content_discovered: typeof value.content_discovered === 'boolean' ? value.content_discovered : defaultEvents.content_discovered,
      operation_failed: typeof value.operation_failed === 'boolean' ? value.operation_failed : defaultEvents.operation_failed,
      magnet_found: typeof value.magnet_found === 'boolean' ? value.magnet_found : defaultEvents.magnet_found,
      download_completed: typeof value.download_completed === 'boolean' ? value.download_completed : defaultEvents.download_completed
    };
  } catch { return { ...defaultEvents }; }
}

export function getNotificationSettings(): NotificationSettings {
  const channel = stringSetting(settingsKeys.channel);
  return {
    enabled: stringSetting(settingsKeys.enabled) === '1',
    channel: channel === 'dingtalk' || channel === 'webhook' ? channel : 'wecom',
    events: parseEvents(getSetting(settingsKeys.events)),
    wecomWebhook: stringSetting(settingsKeys.wecomWebhook),
    dingtalkWebhook: stringSetting(settingsKeys.dingtalkWebhook),
    dingtalkSecret: stringSetting(settingsKeys.dingtalkSecret),
    webhookUrl: stringSetting(settingsKeys.webhookUrl),
    webhookHmacSecret: stringSetting(settingsKeys.webhookHmacSecret)
  };
}

export function publicNotificationSettings(settings = getNotificationSettings()): PublicNotificationSettings {
  const { wecomWebhook, dingtalkWebhook, dingtalkSecret, webhookUrl, webhookHmacSecret, ...publicSettings } = settings;
  return {
    ...publicSettings,
    wecomWebhookConfigured: Boolean(wecomWebhook),
    dingtalkWebhookConfigured: Boolean(dingtalkWebhook),
    dingtalkSecretConfigured: Boolean(dingtalkSecret),
    webhookUrlConfigured: Boolean(webhookUrl),
    webhookHmacSecretConfigured: Boolean(webhookHmacSecret)
  };
}

function booleanInput(value: unknown, fallback: boolean, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name}格式无效。`);
  return value;
}

function channelInput(value: unknown, fallback: NotificationChannel) {
  if (value === undefined) return fallback;
  if (value === 'wecom' || value === 'dingtalk' || value === 'webhook') return value;
  throw new Error('通知渠道无效。');
}

function eventsInput(value: unknown, fallback: NotificationEvents): NotificationEvents {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('通知事件选项格式无效。');
  const input = value as Record<string, unknown>;
  return {
    content_discovered: booleanInput(input.content_discovered, fallback.content_discovered, '新内容通知'),
    operation_failed: booleanInput(input.operation_failed, fallback.operation_failed, '失败通知'),
    magnet_found: booleanInput(input.magnet_found, fallback.magnet_found, '磁链通知'),
    download_completed: booleanInput(input.download_completed, fallback.download_completed, '下载完成通知')
  };
}

function secretInput(value: unknown, clear: unknown, fallback: string, label: string) {
  if (clear === true) return '';
  if (clear !== undefined && clear !== false) throw new Error(`${label}清除选项格式无效。`);
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const next = value.trim();
  if (next.length > 4096) throw new Error(`${label}不能超过 4096 个字符。`);
  return next || fallback;
}

function assertHttpUrl(value: string, label: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`);
  return url.toString();
}

export function normalizeNotificationSettings(input: NotificationSettingsPayload, current = getNotificationSettings()): NotificationSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('通知设置格式无效。');
  const settings: NotificationSettings = {
    enabled: booleanInput(input.enabled, current.enabled, '启用状态'),
    channel: channelInput(input.channel, current.channel),
    events: eventsInput(input.events, current.events),
    wecomWebhook: secretInput(input.wecomWebhook, input.clearWecomWebhook, current.wecomWebhook, '企业微信机器人地址'),
    dingtalkWebhook: secretInput(input.dingtalkWebhook, input.clearDingtalkWebhook, current.dingtalkWebhook, '钉钉机器人地址'),
    dingtalkSecret: secretInput(input.dingtalkSecret, input.clearDingtalkSecret, current.dingtalkSecret, '钉钉签名密钥'),
    webhookUrl: secretInput(input.webhookUrl, input.clearWebhookUrl, current.webhookUrl, '通用 Webhook 地址'),
    webhookHmacSecret: secretInput(input.webhookHmacSecret, input.clearWebhookHmacSecret, current.webhookHmacSecret, 'Webhook HMAC 密钥')
  };
  if (settings.wecomWebhook) settings.wecomWebhook = assertHttpUrl(settings.wecomWebhook, '企业微信机器人地址');
  if (settings.dingtalkWebhook) settings.dingtalkWebhook = assertHttpUrl(settings.dingtalkWebhook, '钉钉机器人地址');
  if (settings.webhookUrl) settings.webhookUrl = assertHttpUrl(settings.webhookUrl, '通用 Webhook 地址');
  if (settings.enabled) assertNotificationChannel(settings);
  return settings;
}

export async function saveNotificationSettings(settings: NotificationSettings) {
  await Promise.all([
    setSetting(settingsKeys.enabled, settings.enabled ? '1' : '0'),
    setSetting(settingsKeys.channel, settings.channel),
    setSetting(settingsKeys.events, JSON.stringify(settings.events)),
    setSetting(settingsKeys.wecomWebhook, settings.wecomWebhook),
    setSetting(settingsKeys.dingtalkWebhook, settings.dingtalkWebhook),
    setSetting(settingsKeys.dingtalkSecret, settings.dingtalkSecret),
    setSetting(settingsKeys.webhookUrl, settings.webhookUrl),
    setSetting(settingsKeys.webhookHmacSecret, settings.webhookHmacSecret)
  ]);
}

function channelWebhook(settings: NotificationSettings) {
  if (settings.channel === 'wecom') return settings.wecomWebhook;
  if (settings.channel === 'dingtalk') return settings.dingtalkWebhook;
  return settings.webhookUrl;
}

export function assertNotificationChannel(settings: NotificationSettings) {
  const url = channelWebhook(settings);
  if (!url) {
    const name = settings.channel === 'wecom' ? '企业微信' : settings.channel === 'dingtalk' ? '钉钉' : '通用 Webhook';
    throw new Error(`请先填写${name}机器人地址。`);
  }
  assertHttpUrl(url, '通知地址');
}

export function isNotificationEventEnabled(type: NotificationEventType, settings = getNotificationSettings()) {
  return settings.enabled && settings.events[type];
}

export function createContentDiscoveredNotification(input: {
  subscription: { id: number; name?: string | null };
  count: number;
  items: NotificationItem[];
  occurredAt?: string;
}): NotificationPayload {
  const count = Math.max(1, Math.floor(input.count));
  return {
    version: 1,
    id: randomUUID(),
    type: 'content_discovered',
    severity: 'info',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    title: `发现 ${count} 条新内容`,
    summary: `订阅“${input.subscription.name ?? `#${input.subscription.id}`}”本次检查发现 ${count} 条新内容。`,
    pagePath: '#archive',
    subscription: input.subscription,
    operation: null,
    items: input.items.slice(0, 5).map((item) => ({ content: item.content, title: item.title ?? null, detailUrl: item.detailUrl ?? null }))
  };
}

export function createOperationFailureNotification(input: {
  operation: string;
  error: string;
  subscription?: { id: number; name?: string | null } | null;
  jobId?: number | null;
  content?: string | null;
  occurredAt?: string;
}): NotificationPayload {
  const item = input.content?.trim() ? [{ content: input.content.trim() }] : [];
  return {
    version: 1,
    id: randomUUID(),
    type: 'operation_failed',
    severity: 'error',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    title: `${input.operation}最终失败`,
    summary: input.error.slice(0, 1000),
    pagePath: '#operations',
    subscription: input.subscription ?? null,
    operation: { kind: input.operation, jobId: input.jobId ?? null, error: input.error.slice(0, 2000) },
    items: item
  };
}

export function createMagnetFoundNotification(input: {
  subscription: { id: number; name?: string | null };
  content: string;
  occurredAt?: string;
}): NotificationPayload {
  return {
    version: 1,
    id: randomUUID(),
    type: 'magnet_found',
    severity: 'info',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    title: '已找到磁力链接',
    summary: `“${input.content}”已找到可用磁力链接。`,
    pagePath: '#archive',
    subscription: input.subscription,
    operation: { kind: '磁力检索' },
    items: [{ content: input.content }]
  };
}

export function createDownloadCompletedNotification(input: {
  subscription: { id: number; name?: string | null };
  content: string;
  occurredAt?: string;
}): NotificationPayload {
  return {
    version: 1,
    id: randomUUID(),
    type: 'download_completed',
    severity: 'info',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    title: '下载已完成',
    summary: `“${input.content}”已在 qBittorrent 中下载完成。`,
    pagePath: '#archive',
    subscription: input.subscription,
    operation: { kind: 'qBittorrent 下载' },
    items: [{ content: input.content }]
  };
}

export function createTestNotification(): NotificationPayload {
  return {
    version: 1,
    id: randomUUID(),
    type: 'test',
    severity: 'info',
    occurredAt: new Date().toISOString(),
    title: '测试通知',
    summary: '通知渠道连接正常。后续仅会按所选事件发送提醒。',
    pagePath: '#subscriptions',
    subscription: null,
    operation: null,
    items: []
  };
}

function failureDedupeKey(payload: NotificationPayload) {
  if (payload.type !== 'operation_failed') return null;
  return createHash('sha256').update(JSON.stringify([
    payload.type,
    payload.subscription?.id ?? null,
    payload.operation?.kind ?? '',
    payload.operation?.error ?? payload.summary
  ])).digest('hex');
}

/** Queue a business event in the caller's transaction so a committed state
 * transition cannot lose its accompanying notification during a restart. */
export async function enqueueNotification(payload: NotificationPayload, client: DatabaseClient = db) {
  if (payload.type === 'test' || !isNotificationEventEnabled(payload.type)) return { queued: false, deduped: false, id: null as number | null };
  const now = new Date();
  const createdAt = now.toISOString();
  const dedupeKey = failureDedupeKey(payload);
  if (dedupeKey) {
    const expiresAt = new Date(now.getTime() + dedupeWindowMs).toISOString();
    const dedupe = await client.run(`INSERT INTO notification_dedupes (dedupe_key, expires_at, created_at)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE expires_at = IF(expires_at <= VALUES(created_at), VALUES(expires_at), expires_at), created_at = IF(expires_at <= VALUES(created_at), VALUES(created_at), created_at)`, [dedupeKey, expiresAt, createdAt]);
    if (dedupe.changes === 0) return { queued: false, deduped: true, id: null as number | null };
  }
  const result = await client.run(`INSERT INTO notification_outbox
    (event_type, payload, status, attempt_count, next_attempt_at, created_at, started_at, sent_at, failed_at, last_error)
    VALUES (?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL)`, [payload.type, JSON.stringify(payload), createdAt, createdAt]);
  return { queued: true, deduped: false, id: result.lastInsertRowid };
}

async function postNotificationRequest(request: ReturnType<typeof buildNotificationRequest>, fetcher: FetchLike = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deliveryTimeoutMs);
  try {
    const response = await fetcher(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...request.headers },
      body: request.body,
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`通知服务返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
  } finally { clearTimeout(timer); }
}

export async function deliverNotification(payload: NotificationPayload, settings = getNotificationSettings(), fetcher?: FetchLike) {
  assertNotificationChannel(settings);
  await postNotificationRequest(buildNotificationRequest(payload, settings), fetcher);
}

type OutboxRow = { id: number; event_type: NotificationEventType; payload: string; attempt_count: number };
let working = false;
let lastMaintenanceAt = 0;

async function maintainNotificationOutbox() {
  if (Date.now() - lastMaintenanceAt < 60 * 60_000) return;
  lastMaintenanceAt = Date.now();
  const now = new Date();
  const historyCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  await Promise.all([
    db.run('DELETE FROM notification_dedupes WHERE expires_at < ?', [now.toISOString()]),
    db.run(`DELETE FROM notification_outbox
      WHERE status IN ('sent', 'failed', 'skipped') AND COALESCE(sent_at, failed_at, created_at) < ?`, [historyCutoff])
  ]);
}

async function recoverStalledNotifications() {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.run(`UPDATE notification_outbox SET status = 'queued', started_at = NULL, next_attempt_at = ?
    WHERE status = 'running' AND started_at < ?`, [new Date().toISOString(), cutoff]);
}

export async function runNotificationWorkerTick() {
  if (working) return;
  working = true;
  try {
    await refreshSettings();
    await maintainNotificationOutbox();
    await recoverStalledNotifications();
    const now = new Date().toISOString();
    const job = await db.get<OutboxRow>(`SELECT id, event_type, payload, attempt_count FROM notification_outbox
      WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at ASC, id ASC LIMIT 1`, [now]);
    if (!job) return;
    const claim = await db.run(`UPDATE notification_outbox SET status = 'running', started_at = ?, last_error = NULL
      WHERE id = ? AND status = 'queued'`, [now, job.id]);
    if (!claim.changes) return;
    let payload: NotificationPayload;
    try { payload = JSON.parse(job.payload) as NotificationPayload; }
    catch { throw new Error('通知队列载荷格式无效。'); }
    const settings = getNotificationSettings();
    if (!isNotificationEventEnabled(job.event_type, settings)) {
      await db.run(`UPDATE notification_outbox SET status = 'skipped', failed_at = ?, last_error = ? WHERE id = ?`, [new Date().toISOString(), '通知设置已停用或对应事件已关闭。', job.id]);
      return;
    }
    try {
      await deliverNotification(payload, settings);
      await db.run(`UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`, [new Date().toISOString(), job.id]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '通知发送失败。';
      const attempt = job.attempt_count + 1;
      if (attempt < maxDeliveryAttempts) {
        const retryAt = new Date(Date.now() + notificationRetryDelaysMs[attempt - 1]).toISOString();
        await db.run(`UPDATE notification_outbox SET status = 'queued', started_at = NULL, attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`, [attempt, retryAt, message.slice(0, 4000), job.id]);
      } else {
        await db.run(`UPDATE notification_outbox SET status = 'failed', failed_at = ?, attempt_count = ?, last_error = ? WHERE id = ?`, [new Date().toISOString(), attempt, message.slice(0, 4000), job.id]);
        const { appendRuntimeLog } = await import('./db.js');
        await appendRuntimeLog({ level: 'error', source: 'system', message: `通知发送失败，已重试 ${maxDeliveryAttempts} 次：${message}` }).catch(() => undefined);
      }
    }
  } finally { working = false; }
}

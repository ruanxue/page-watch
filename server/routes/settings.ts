import type { FastifyInstance } from 'fastify';
import { JOB_PRIORITY, appendRuntimeLog, db, queueLibrarySyncJob, getJellyfinSettings, getOutboundProxyUrl, getQbittorrentSettings, getRuntimeSettings, getSetting, reportIntegrationStatus, setRuntimeSettings, setSetting } from '../db.js';
import { assertJellyfinConfig, listJellyfinLibraries, normalizeJellyfinUrl, testJellyfinConnection } from '../jellyfin.js';
import { createTestNotification, deliverNotification, getNotificationSettings, normalizeNotificationSettings, publicNotificationSettings, saveNotificationSettings, type NotificationSettingsPayload } from '../notifications.js';
import { assertQbittorrentConfig, normalizeQbittorrentUrl, testQbittorrentConnection } from '../qbittorrent.js';
import { clearJellyfinMediaIndex } from '../jellyfin-cache.js';

/**
 * 设置领域：网络代理、运行性能、通知、qBittorrent、Jellyfin 的读写与连接测试。
 *
 * 只通过 db 的读写函数操作配置，不直接碰队列与抓取流程。唯一的外部动作是
 * Jellyfin 同步需要唤醒执行引擎，因此由 index 注入 wakeEngine。
 */
type QbittorrentSettingsPayload = {
  enabled?: boolean;
  url?: string;
  authMode?: 'api_key' | 'password';
  apiKey?: string;
  clearApiKey?: boolean;
  username?: string;
  password?: string;
  clearPassword?: boolean;
  category?: string;
  savePath?: string;
  tags?: string;
  autoDownload?: boolean;
  autoDownloadMinSizeMb?: number;
  stopAfterDownload?: boolean;
};

type JellyfinSettingsPayload = {
  enabled?: boolean;
  url?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  libraryIds?: string[];
  syncIntervalMinutes?: number;
  skipMagnetWhenAvailable?: boolean;
};

export function registerSettingsRoutes(app: FastifyInstance, deps: { wakeEngine: (reason: string) => Promise<void> }) {
function publicQbittorrentSettings() {
  const settings = getQbittorrentSettings();
  return {
    enabled: settings.enabled,
    url: settings.url,
    authMode: settings.authMode,
    apiKeyConfigured: Boolean(settings.apiKey),
    username: settings.username,
    passwordConfigured: Boolean(settings.password),
    category: settings.category,
    savePath: settings.savePath,
    tags: settings.tags,
    autoDownload: settings.autoDownload,
    autoDownloadMinSizeMb: settings.autoDownloadMinSizeMb,
    stopAfterDownload: settings.stopAfterDownload
  };
}

function publicJellyfinSettings() {
  const settings = getJellyfinSettings();
  return {
    enabled: settings.enabled,
    url: settings.url,
    apiKeyConfigured: Boolean(settings.apiKey),
    libraryIds: settings.libraryIds,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    skipMagnetWhenAvailable: settings.skipMagnetWhenAvailable,
    lastSyncedAt: getSetting('jellyfin_last_synced_at') || null
  };
}

function normalizeJellyfinLibraryIds(value: unknown, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error('Jellyfin 媒体库选择格式无效。');
  const ids = [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
  if (ids.length > 30 || ids.some((id) => id.length > 128)) throw new Error('Jellyfin 媒体库选择数量或标识无效。');
  return ids;
}

function normalizeJellyfinSettings(payload: JellyfinSettingsPayload) {
  const current = getJellyfinSettings();
  const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : current.enabled;
  const rawUrl = payload.url === undefined ? current.url : typeof payload.url === 'string' ? payload.url.trim() : (() => { throw new Error('Jellyfin Web 地址格式无效。'); })();
  const url = rawUrl ? normalizeJellyfinUrl(rawUrl) : '';
  const apiKey = payload.clearApiKey ? '' : typeof payload.apiKey === 'string' && payload.apiKey.trim() ? payload.apiKey.trim() : current.apiKey;
  if (apiKey.length > 512) throw new Error('Jellyfin API 密钥不能超过 512 个字符。');
  const libraryIds = normalizeJellyfinLibraryIds(payload.libraryIds, current.libraryIds);
  const interval = payload.syncIntervalMinutes === undefined ? current.syncIntervalMinutes : Number(payload.syncIntervalMinutes);
  if (!Number.isInteger(interval) || interval < 5 || interval > 1440) throw new Error('Jellyfin 同步间隔需在 5 到 1440 分钟之间。');
  const skipMagnetWhenAvailable = typeof payload.skipMagnetWhenAvailable === 'boolean' ? payload.skipMagnetWhenAvailable : current.skipMagnetWhenAvailable;
  const settings = { enabled, url, apiKey, libraryIds, syncIntervalMinutes: interval, skipMagnetWhenAvailable };
  if (enabled) assertJellyfinConfig(settings);
  return settings;
}

function compactQbittorrentField(value: unknown, label: string, limit: number) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const normalized = value.trim();
  if (normalized.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符。`);
  return normalized;
}

function normalizeQbittorrentSettings(payload: QbittorrentSettingsPayload) {
  const current = getQbittorrentSettings();
  const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : current.enabled;
  const autoDownload = typeof payload.autoDownload === 'boolean' ? payload.autoDownload : current.autoDownload;
  const autoDownloadMinSizeMb = payload.autoDownloadMinSizeMb === undefined ? current.autoDownloadMinSizeMb : Number(payload.autoDownloadMinSizeMb);
  if (!Number.isInteger(autoDownloadMinSizeMb) || autoDownloadMinSizeMb < 0 || autoDownloadMinSizeMb > 1048576) {
    throw new Error('最小单文件大小需为 0 到 1048576 之间的整数 MB。');
  }
  const stopAfterDownload = typeof payload.stopAfterDownload === 'boolean' ? payload.stopAfterDownload : current.stopAfterDownload;
  const authMode = payload.authMode === 'api_key' ? 'api_key' : payload.authMode === 'password' ? 'password' : current.authMode;
  const rawUrl = payload.url === undefined ? current.url : compactQbittorrentField(payload.url, 'qBittorrent Web UI 地址', 500);
  const url = rawUrl ? normalizeQbittorrentUrl(rawUrl) : '';
  const apiKey = payload.clearApiKey ? '' : typeof payload.apiKey === 'string' && payload.apiKey.length ? payload.apiKey.trim() : current.apiKey;
  if (apiKey.length > 128) throw new Error('qBittorrent API 密钥不能超过 128 个字符。');
  const username = payload.username === undefined ? current.username : compactQbittorrentField(payload.username, 'qBittorrent 用户名', 128);
  const password = payload.clearPassword ? '' : typeof payload.password === 'string' && payload.password.length ? payload.password : current.password;
  if (password.length > 1024) throw new Error('qBittorrent 密码不能超过 1024 个字符。');
  const category = payload.category === undefined ? current.category : compactQbittorrentField(payload.category, '分类', 255);
  const savePath = payload.savePath === undefined ? current.savePath : compactQbittorrentField(payload.savePath, '保存路径', 1000);
  const tags = payload.tags === undefined ? current.tags : compactQbittorrentField(payload.tags, '标签', 500);
  const values = { enabled, url, authMode, apiKey, username, password, category, savePath, tags, autoDownload, autoDownloadMinSizeMb, stopAfterDownload };
  if (enabled) assertQbittorrentConfig(values);
  return values;
}

function validateProxy(raw: string | undefined) {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入有效的代理地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || !url.port) {
    throw new Error('代理地址需为 http://地址:端口 或 https://地址:端口。');
  }
  return url.toString();
}

const presetNamesSettingKey = 'subscription_preset_names';

function readPresetNames() {
  const raw = getSetting(presetNamesSettingKey);
  if (!raw) return {} as Record<string, string>;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, string>;
    return Object.fromEntries(Object.entries(value).filter(([id, name]) => /^[a-z0-9-]+$/.test(id) && typeof name === 'string')) as Record<string, string>;
  } catch { return {} as Record<string, string>; }
}

function normalizePresetNames(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预设名称格式无效。');
  const names: Record<string, string> = {};
  for (const [id, rawName] of Object.entries(input)) {
    if (!/^[a-z0-9-]+$/.test(id) || typeof rawName !== 'string') throw new Error('预设名称格式无效。');
    const name = rawName.trim();
    if (name.length > 40) throw new Error('预设名称不能超过 40 个字符。');
    if (name) names[id] = name;
  }
  return names;
}

app.get('/api/settings/network', async () => {
  const fromEnvironment = Boolean(process.env.OUTBOUND_PROXY);
  const proxyUrl = fromEnvironment ? '' : getSetting('outbound_proxy');
  const enabled = fromEnvironment || (getSetting('outbound_proxy_enabled') !== '0' && Boolean(proxyUrl.trim()));
  return { proxyUrl, enabled, active: Boolean(getOutboundProxyUrl()), fromEnvironment };
});

app.put('/api/settings/network', async (request, reply) => {
  if (process.env.OUTBOUND_PROXY) return reply.code(409).send({ error: '当前代理由 OUTBOUND_PROXY 环境变量管理。' });
  try {
    const body = request.body as { proxyUrl?: string; enabled?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('代理开关无效。');
    const proxyUrl = validateProxy(body.proxyUrl);
    const enabled = Boolean(proxyUrl) && (body.enabled ?? true);
    await Promise.all([setSetting('outbound_proxy', proxyUrl), setSetting('outbound_proxy_enabled', enabled ? '1' : '0')]);
    return { proxyUrl, enabled, active: enabled, fromEnvironment: false };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存代理设置。' });
  }
});

app.get('/api/settings/runtime', async () => getRuntimeSettings());
app.put('/api/settings/runtime', async (request, reply) => {
  const body = request.body as { profile?: unknown; browserIdleMinutes?: unknown };
  if (body.profile !== 'safe' && body.profile !== 'performance') return reply.code(400).send({ error: '运行模式无效。' });
  if (![5, 10, 20].includes(Number(body.browserIdleMinutes))) return reply.code(400).send({ error: '浏览器空闲回收时间只能是 5、10 或 20 分钟。' });
  const settings = await setRuntimeSettings({ profile: body.profile, browserIdleMinutes: Number(body.browserIdleMinutes) as 5 | 10 | 20 });
  await appendRuntimeLog({ level: 'info', source: 'system', message: `运行性能设置已更新：${settings.profile === 'performance' ? '性能模式' : '稳妥模式'}，浏览器空闲 ${settings.browserIdleMinutes} 分钟后回收。` });
  return settings;
});

app.get('/api/settings/notifications', async () => publicNotificationSettings());
app.put('/api/settings/notifications', async (request, reply) => {
  try {
    const settings = normalizeNotificationSettings(request.body as NotificationSettingsPayload);
    await saveNotificationSettings(settings);
    await appendRuntimeLog({ level: 'info', source: 'system', message: settings.enabled ? '通知设置已保存并启用。' : '通知设置已保存，通知当前处于关闭状态。' });
    return publicNotificationSettings(settings);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存通知设置。' });
  }
});
app.post('/api/settings/notifications/test', async (_request, reply) => {
  try {
    await deliverNotification(createTestNotification(), getNotificationSettings());
    await appendRuntimeLog({ level: 'success', source: 'system', message: '通知测试发送成功。' });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '通知测试发送失败。';
    await appendRuntimeLog({ level: 'error', source: 'system', message: `通知测试发送失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.get('/api/settings/qbittorrent', async () => publicQbittorrentSettings());
app.put('/api/settings/qbittorrent', async (request, reply) => {
  try {
    const settings = normalizeQbittorrentSettings(request.body as QbittorrentSettingsPayload);
    await Promise.all([
      setSetting('qbit_enabled', settings.enabled ? '1' : '0'),
      setSetting('qbit_url', settings.url),
      setSetting('qbit_auth_mode', settings.authMode),
      setSetting('qbit_api_key', settings.apiKey),
      setSetting('qbit_username', settings.username),
      setSetting('qbit_password', settings.password),
      setSetting('qbit_category', settings.category),
      setSetting('qbit_save_path', settings.savePath),
      setSetting('qbit_tags', settings.tags),
      setSetting('qbit_auto_download', settings.autoDownload ? '1' : '0'),
      setSetting('qbit_auto_download_min_size_mb', String(settings.autoDownloadMinSizeMb)),
      setSetting('qbit_stop_after_download', settings.stopAfterDownload ? '1' : '0'),
      setSetting('integration_onboarding_pending', '0')
    ]);
    if (!settings.enabled) await reportIntegrationStatus('qbittorrent', 'disabled', 'qBittorrent 已在 Page Watch 中停用');
    return publicQbittorrentSettings();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存 qBittorrent 设置。' });
  }
});

app.post('/api/settings/qbittorrent/test', async (_request, reply) => {
  try {
    const settings = getQbittorrentSettings();
    await testQbittorrentConnection(settings);
    await reportIntegrationStatus('qbittorrent', 'healthy', '连接测试成功');
    await appendRuntimeLog({ level: 'success', source: 'download', message: `qBittorrent 连接测试成功（${normalizeQbittorrentUrl(settings.url)}）。` });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'qBittorrent 连接测试失败。';
    await reportIntegrationStatus('qbittorrent', 'degraded', '最近一次连接测试失败').catch(() => undefined);
    await appendRuntimeLog({ level: 'error', source: 'download', message: `qBittorrent 连接测试失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.get('/api/settings/jellyfin', async () => publicJellyfinSettings());
app.put('/api/settings/jellyfin', async (request, reply) => {
  try {
    const activeSync = await db.get<{ id: number }>("SELECT id FROM library_sync_jobs WHERE status = 'running' LIMIT 1");
    if (activeSync) return reply.code(409).send({ error: 'Jellyfin 全量同步正在执行；请等待任务完成后再修改连接或媒体库。' });
    const settings = normalizeJellyfinSettings(request.body as JellyfinSettingsPayload);
    const now = new Date().toISOString();
    await Promise.all([
      setSetting('jellyfin_enabled', settings.enabled ? '1' : '0'),
      setSetting('jellyfin_url', settings.url),
      setSetting('jellyfin_api_key', settings.apiKey),
      setSetting('jellyfin_library_ids', JSON.stringify(settings.libraryIds)),
      setSetting('jellyfin_sync_interval_minutes', String(settings.syncIntervalMinutes)),
      setSetting('jellyfin_skip_magnet_when_available', settings.skipMagnetWhenAvailable ? '1' : '0'),
      setSetting('jellyfin_last_synced_at', ''),
      setSetting('jellyfin_media_index_synced_at', ''),
      setSetting('integration_onboarding_pending', '0')
    ]);
    await clearJellyfinMediaIndex();
    await db.run(`UPDATE archive_entries SET jellyfin_status = ?, jellyfin_item_id = NULL, jellyfin_item_name = NULL,
      jellyfin_matched_at = NULL, jellyfin_error = NULL, updated_at = ?`, [settings.enabled && settings.libraryIds.length ? 'pending' : 'unconfigured', now]);
    if (!settings.enabled) {
      await db.run("UPDATE library_sync_jobs SET status = 'completed', finished_at = ?, error = 'Jellyfin 已停用', progress_phase = 'cancelled', progress_label = 'Jellyfin 已停用' WHERE status = 'queued'", [now]);
      await reportIntegrationStatus('jellyfin', 'disabled', 'Jellyfin 已在 Page Watch 中停用');
    }
    return publicJellyfinSettings();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存 Jellyfin 设置。' });
  }
});

app.post('/api/settings/jellyfin/test', async (_request, reply) => {
  try {
    const settings = getJellyfinSettings();
    const [server, libraries] = await Promise.all([testJellyfinConnection(settings), listJellyfinLibraries(settings)]);
    await reportIntegrationStatus('jellyfin', 'healthy', '连接测试成功');
    await appendRuntimeLog({ level: 'success', source: 'library', message: `Jellyfin 连接测试成功（${server.serverName}${server.version ? ` ${server.version}` : ''}），发现 ${libraries.length} 个媒体库。` });
    return { ok: true, server, libraries };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Jellyfin 连接测试失败。';
    await reportIntegrationStatus('jellyfin', 'degraded', '最近一次连接测试失败').catch(() => undefined);
    await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 连接测试失败：${message}` });
    return reply.code(400).send({ error: message });
  }
});

app.post('/api/settings/jellyfin/sync', async (_request, reply) => {
  try {
    const settings = getJellyfinSettings();
    if (!settings.enabled || !settings.libraryIds.length) return reply.code(400).send({ error: '请先启用 Jellyfin 并选择至少一个媒体库。' });
    const queued = await queueLibrarySyncJob('manual', JOB_PRIORITY.manual);
    await appendRuntimeLog({ level: 'info', source: 'library', message: queued.queued ? 'Jellyfin 手动全量同步已加入队列。' : 'Jellyfin 全量同步已在队列中或正在执行。' });
    return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法加入 Jellyfin 同步队列。' });
  }
});

app.get('/api/settings/preset-names', async () => ({ names: readPresetNames() }));
app.put('/api/settings/preset-names', async (request, reply) => {
  try {
    const names = normalizePresetNames((request.body as { names?: unknown }).names);
    await setSetting(presetNamesSettingKey, JSON.stringify(names));
    return { names };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存预设名称。' });
  }
});
}

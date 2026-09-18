import { describeError } from './error-details.js';

export type QbittorrentConfig = {
  url: string;
  authMode?: 'api_key' | 'password';
  apiKey?: string;
  username?: string;
  password?: string;
  category?: string;
  savePath?: string;
  tags?: string;
};

const REQUEST_TIMEOUT_MS = 20_000;

type TorrentAddResponse = {
  success_count?: unknown;
  pending_count?: unknown;
  failure_count?: unknown;
  added_torrent_ids?: unknown;
};

type TorrentInfoResponse = {
  hash?: unknown;
  state?: unknown;
  progress?: unknown;
  downloaded?: unknown;
  size?: unknown;
  total_size?: unknown;
  dlspeed?: unknown;
  save_path?: unknown;
  content_path?: unknown;
};

type TorrentFileResponse = {
  index?: unknown;
  name?: unknown;
  size?: unknown;
  priority?: unknown;
};

export type QbittorrentTorrentState = {
  hash: string;
  state: string;
  progress: number;
  downloadedBytes: number;
  totalSize: number;
  downloadSpeed: number;
  savePath: string | null;
  contentPath: string | null;
};

export type QbittorrentTorrentFile = {
  index: number;
  name: string;
  size: number;
  priority: number;
};

const completedSeedingStates = new Set(['uploading', 'stalledup', 'queuedup', 'forcedup', 'pausedup']);
const activeSeedingStates = new Set(['uploading', 'stalledup', 'queuedup', 'forcedup']);

/** A rounded 99.9% progress value is still incomplete: qBittorrent reports 1 only at 100%. */
export function isQbittorrentDownloadComplete(torrent: Pick<QbittorrentTorrentState, 'progress' | 'state'>) {
  return torrent.progress >= 1 && completedSeedingStates.has(torrent.state.toLowerCase());
}

/** Only stop a torrent after qBittorrent has fully entered an active seeding state. */
export function isQbittorrentReadyToStopSeeding(torrent: Pick<QbittorrentTorrentState, 'progress' | 'state'>) {
  return torrent.progress >= 1 && activeSeedingStates.has(torrent.state.toLowerCase());
}

export type QbittorrentAddOptions = {
  /** qBittorrent stops after receiving magnet metadata, before payload download. */
  stopCondition?: 'MetadataReceived';
};

/** Make previously saved HTML-escaped magnet values safe for qBittorrent. */
function normalizeMagnetForSubmission(raw: string) {
  let value = raw.trim();
  for (let index = 0; index < 4; index += 1) {
    const decoded = value.replace(/&(amp|#0*38|#x0*26);/gi, '&');
    if (decoded === value) break;
    value = decoded;
  }
  return value;
}

/** Derive a qB-compatible hexadecimal info hash for legacy `Ok.` responses. */
export function torrentHashFromMagnet(raw: string) {
  try {
    const magnet = new URL(normalizeMagnetForSubmission(raw));
    for (const value of magnet.searchParams.getAll('xt')) {
      const match = value.match(/^urn:btih:([a-f0-9]{40})$/i);
      if (match) return match[1].toLowerCase();
    }
  } catch {
    // The caller validates the magnet independently; an unavailable hash only
    // means that this older submission cannot be tracked by info hash.
  }
  return null;
}

/** qBittorrent Web API 2.14+ returns a JSON summary instead of legacy `Ok.`. */
function acceptedTorrentAddResponse(message: string) {
  if (message === 'Ok.') return { accepted: true, torrentHash: null };
  try {
    const result = JSON.parse(message) as TorrentAddResponse;
    const successful = Number(result.success_count ?? 0);
    const pending = Number(result.pending_count ?? 0);
    const torrentHash = Array.isArray(result.added_torrent_ids)
      ? result.added_torrent_ids.find((value): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value))?.toLowerCase() ?? null
      : null;
    return {
      accepted: Number.isFinite(successful) && Number.isFinite(pending) && (successful > 0 || pending > 0),
      torrentHash
    };
  } catch {
    return { accepted: false, torrentHash: null };
  }
}

export function normalizeQbittorrentUrl(raw: string) {
  const value = raw.trim();
  if (!value) throw new Error('请填写 qBittorrent Web UI 地址。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('qBittorrent Web UI 地址格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('qBittorrent Web UI 地址需使用 http 或 https。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('qBittorrent Web UI 地址不能包含账号、查询参数或锚点。');
  }
  return url.toString().replace(/\/+$/, '');
}

function endpoint(baseUrl: string, pathname: string) {
  return new URL(pathname.replace(/^\//, ''), `${baseUrl}/`);
}

/**
 * qBittorrent verifies the Origin/Referer of state-changing Web API calls.
 * This is especially important behind a NAS application proxy, where a bare
 * server-to-server POST is otherwise rejected as "invalid token".
 */
function webUiHeaders(baseUrl: string): Record<string, string> {
  const url = new URL(baseUrl);
  return {
    origin: url.origin,
    referer: `${baseUrl.replace(/\/+$/, '')}/`
  };
}

function cookieFrom(response: Response) {
  const cookie = response.headers.get('set-cookie')?.split(';')[0]?.trim();
  if (!cookie) throw new Error('qBittorrent 未返回登录会话 Cookie。请检查 Web UI 的反向代理或认证设置。');
  return cookie;
}

async function requestQbittorrent(url: URL, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: init.headers
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`连接 qBittorrent 超时（${url.host}，${REQUEST_TIMEOUT_MS / 1000} 秒）。请检查 Web UI 地址、端口和 NAS 网络。`);
    }
    throw new Error(describeError(error, { action: '连接 qBittorrent', target: url.host }));
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url: URL, form: URLSearchParams, headers: Record<string, string> = {}) {
  return requestQbittorrent(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers },
    body: form.toString()
  });
}

/**
 * qBittorrent's torrent-add endpoint is intentionally different from the
 * rest of its Web API: it parses a multipart form, even when the only input
 * is a magnet URL.  Do not set Content-Type manually here; fetch adds the
 * required boundary to the header for FormData.
 */
async function postMultipart(url: URL, form: FormData, headers: Record<string, string> = {}) {
  return requestQbittorrent(url, {
    method: 'POST',
    headers,
    body: form
  });
}

export function assertQbittorrentConfig(config: QbittorrentConfig) {
  const url = normalizeQbittorrentUrl(config.url);
  const authMode = config.authMode === 'api_key' ? 'api_key' : 'password';
  if (authMode === 'api_key') {
    const apiKey = config.apiKey?.trim() ?? '';
    if (!/^qbt_[A-Za-z0-9]{28}$/.test(apiKey)) throw new Error('qBittorrent API 密钥格式无效。请在 Web UI 的“设置 → Web UI → API Key”重新生成并完整粘贴。');
    return { ...config, url, authMode, apiKey };
  }
  const username = config.username?.trim() ?? '';
  if (!username) throw new Error('请填写 qBittorrent 用户名。');
  if (!config.password) throw new Error('请填写 qBittorrent 密码。');
  return { ...config, url, authMode, username };
}

export async function loginQbittorrent(input: Pick<QbittorrentConfig, 'url' | 'username' | 'password'>) {
  const config = assertQbittorrentConfig({ ...input, authMode: 'password' });
  const url = endpoint(config.url, 'api/v2/auth/login');
  const response = await postForm(
    url,
    new URLSearchParams({ username: config.username ?? '', password: config.password ?? '' }),
    webUiHeaders(config.url)
  );
  const message = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(`qBittorrent 登录被拒绝（HTTP ${response.status}）。请检查 Web UI 地址、账号和密码。`);
  }
  if (message !== 'Ok.') {
    throw new Error(`qBittorrent 登录未成功：${message || '服务器没有返回 Ok。'}。请检查账号、密码与 Web UI 认证设置。`);
  }
  return { config, cookie: cookieFrom(response) };
}

async function authorizedHeaders(input: QbittorrentConfig) {
  const config = assertQbittorrentConfig(input);
  const requestHeaders = webUiHeaders(config.url);
  if (config.authMode === 'api_key') {
    const headers: Record<string, string> = { ...requestHeaders, authorization: `Bearer ${config.apiKey}` };
    return { config, headers };
  }
  const { cookie } = await loginQbittorrent(config);
  const headers: Record<string, string> = { ...requestHeaders, cookie };
  return { config, headers };
}

/** Verify that the configured Web UI accepts authentication without adding anything. */
export async function testQbittorrentConnection(config: QbittorrentConfig) {
  const authenticated = await authorizedHeaders(config);
  if (authenticated.config.authMode === 'password') return;
  const response = await requestQbittorrent(endpoint(authenticated.config.url, 'api/v2/app/version'), { headers: authenticated.headers });
  const version = (await response.text()).trim();
  if (!response.ok) throw new Error(`qBittorrent API 密钥验证失败（HTTP ${response.status}）。请确认 qBittorrent 版本为 5.2 或更高，并检查密钥是否已被轮换。`);
  if (/^invalid token$/i.test(version)) {
    throw new Error('qBittorrent API 密钥验证失败：当前地址返回“invalid token”，它看起来是 NAS 的应用门户或反向代理，而不是 qBittorrent 直接 Web UI。请填写 qB 容器映射出的直接 Web UI 地址和端口。');
  }
  if (!/^v?\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/i.test(version)) {
    throw new Error('qBittorrent API 密钥验证失败：服务器未返回可识别的 qBittorrent 版本。请确认填写的是 qBittorrent 直接 Web UI 地址，而非 NAS 应用门户地址。');
  }
}

/** Submit a magnet to qBittorrent. qBittorrent itself de-duplicates matching info hashes. */
export async function addMagnetToQbittorrent(input: QbittorrentConfig, magnet: string, options: QbittorrentAddOptions = {}) {
  const normalizedMagnet = normalizeMagnetForSubmission(magnet);
  if (!normalizedMagnet.toLowerCase().startsWith('magnet:?')) throw new Error('保存的磁力链接格式无效，无法提交给 qBittorrent。');
  const { config, headers } = await authorizedHeaders(input);
  const body = new FormData();
  body.set('urls', normalizedMagnet);
  if (config.category?.trim()) body.set('category', config.category.trim());
  if (config.savePath?.trim()) body.set('savepath', config.savePath.trim());
  if (config.tags?.trim()) body.set('tags', config.tags.trim());
  if (options.stopCondition) body.set('stopCondition', options.stopCondition);
  const response = await postMultipart(endpoint(config.url, 'api/v2/torrents/add'), body, headers);
  const message = (await response.text()).trim();
  if (!response.ok) throw new Error(`qBittorrent 添加任务失败（HTTP ${response.status}）：${message || '服务器未提供详细说明。'}`);
  if (/^invalid token$/i.test(message)) {
    throw new Error('qBittorrent 拒绝下载任务：当前地址返回“invalid token”，请改用 qB 容器映射出的直接 Web UI 地址和端口。');
  }
  const accepted = acceptedTorrentAddResponse(message);
  if (!accepted.accepted) throw new Error(`qBittorrent 未接受下载任务：${message || '服务器没有返回可识别的成功结果。'}`);
  return { torrentHash: accepted.torrentHash ?? torrentHashFromMagnet(normalizedMagnet) };
}

function requestedTorrentHashes(hashes: string[]) {
  return [...new Set(hashes.map((hash) => hash.trim().toLowerCase()).filter((hash) => /^[a-f0-9]{40}$/.test(hash)))];
}

/** Start torrents after Page Watch has accepted their metadata-based size check. */
export async function startQbittorrentTorrents(input: QbittorrentConfig, hashes: string[]) {
  const requested = requestedTorrentHashes(hashes);
  if (!requested.length) return;
  const { config, headers } = await authorizedHeaders(input);
  const form = new URLSearchParams({ hashes: requested.join('|') });
  let response = await postForm(endpoint(config.url, 'api/v2/torrents/start'), form, headers);
  // qBittorrent 5 renamed resume to start; retain compatibility for older NAS
  // installations that expose the older Web API route.
  if (response.status === 404 || response.status === 405) {
    await response.text();
    response = await postForm(endpoint(config.url, 'api/v2/torrents/resume'), form, headers);
  }
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`qBittorrent 开始下载失败（HTTP ${response.status}）：${body || '服务器未提供详细说明。'}`);
}

/**
 * Returns null while qBittorrent is still receiving metadata. Once metadata
 * exists, its file list is authoritative and exposes each file's size and
 * selectable priority.
 */
export async function getQbittorrentTorrentFiles(input: QbittorrentConfig, hash: string) {
  const requested = requestedTorrentHashes([hash]);
  if (!requested.length) throw new Error('qBittorrent 种子哈希格式无效。');
  const { config, headers } = await authorizedHeaders(input);
  const url = endpoint(config.url, 'api/v2/torrents/files');
  url.searchParams.set('hash', requested[0]);
  const response = await requestQbittorrent(url, { headers });
  const body = (await response.text()).trim();
  // This is qBittorrent's documented “metadata hasn't downloaded yet” state;
  // it is normal for a newly-added magnet and should remain waiting.
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`qBittorrent 文件列表读取失败（HTTP ${response.status}）：${body || '服务器未提供详细说明。'}`);
  let results: unknown;
  try { results = JSON.parse(body); } catch { throw new Error('qBittorrent 文件列表返回的不是有效 JSON。'); }
  if (!Array.isArray(results)) throw new Error('qBittorrent 文件列表返回的数据格式无效。');
  return results.flatMap((item) => {
    const file = item as TorrentFileResponse;
    const index = Number(file.index);
    const size = Number(file.size);
    const priority = Number(file.priority);
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    return Number.isInteger(index) && index >= 0 && Number.isFinite(size) && size >= 0 && Number.isFinite(priority) && name
      ? [{ index, name, size: Math.trunc(size), priority: Math.trunc(priority) }]
      : [];
  }) as QbittorrentTorrentFile[];
}

/** Mark a set of torrent files as normal (1) or excluded (0) priority. */
export async function setQbittorrentTorrentFilePriority(input: QbittorrentConfig, hash: string, indexes: number[], priority: 0 | 1) {
  const requested = requestedTorrentHashes([hash]);
  const ids = [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0))];
  if (!requested.length) throw new Error('qBittorrent 种子哈希格式无效。');
  if (!ids.length) return;
  const { config, headers } = await authorizedHeaders(input);
  // Bound the form payload so an unusually large multi-file torrent cannot
  // exceed the NAS proxy's request-line or body limits.
  for (let offset = 0; offset < ids.length; offset += 250) {
    const response = await postForm(endpoint(config.url, 'api/v2/torrents/filePrio'), new URLSearchParams({ hash: requested[0], id: ids.slice(offset, offset + 250).join('|'), priority: String(priority) }), headers);
    const body = (await response.text()).trim();
    if (!response.ok) throw new Error(`qBittorrent 文件筛选设置失败（HTTP ${response.status}）：${body || '服务器未提供详细说明。'}`);
  }
}

/** Stop only the supplied Page Watch torrents after their download completes. */
export async function stopQbittorrentTorrents(input: QbittorrentConfig, hashes: string[]) {
  const requested = requestedTorrentHashes(hashes);
  if (!requested.length) return;
  const { config, headers } = await authorizedHeaders(input);
  const form = new URLSearchParams({ hashes: requested.join('|') });
  let response = await postForm(endpoint(config.url, 'api/v2/torrents/stop'), form, headers);
  // qBittorrent 5 names the action “stop”; older compatible Web APIs call the
  // equivalent endpoint “pause”. Keep existing NAS installations working.
  if (response.status === 404 || response.status === 405) {
    await response.text();
    response = await postForm(endpoint(config.url, 'api/v2/torrents/pause'), form, headers);
  }
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`qBittorrent 停止做种失败（HTTP ${response.status}）：${body || '服务器未提供详细说明。'}`);
}

/** Read the current qBittorrent state for known info hashes without mutating any torrent. */
export async function getQbittorrentTorrentStates(input: QbittorrentConfig, hashes: string[]) {
  const requested = requestedTorrentHashes(hashes);
  if (!requested.length) return [] as QbittorrentTorrentState[];
  const { config, headers } = await authorizedHeaders(input);
  const url = endpoint(config.url, 'api/v2/torrents/info');
  url.searchParams.set('hashes', requested.join('|'));
  const response = await requestQbittorrent(url, { headers });
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`qBittorrent 状态查询失败（HTTP ${response.status}）：${body || '服务器未提供详细说明。'}`);
  let results: unknown;
  try { results = JSON.parse(body); } catch { throw new Error('qBittorrent 状态查询返回的不是有效 JSON。'); }
  if (!Array.isArray(results)) throw new Error('qBittorrent 状态查询返回的数据格式无效。');
  return results.flatMap((item) => {
    const result = item as TorrentInfoResponse;
    const hash = typeof result.hash === 'string' ? result.hash.toLowerCase() : '';
    const state = typeof result.state === 'string' ? result.state : '';
    const progress = Number(result.progress);
    const totalSize = Number(result.total_size ?? result.size);
    const downloaded = Number(result.downloaded);
    const downloadSpeed = Number(result.dlspeed);
    return /^[a-f0-9]{40}$/.test(hash) && state && Number.isFinite(progress)
      ? [{
        hash,
        state,
        progress: Math.min(Math.max(progress, 0), 1),
        totalSize: Number.isFinite(totalSize) && totalSize >= 0 ? Math.trunc(totalSize) : 0,
        downloadedBytes: Number.isFinite(downloaded) && downloaded >= 0 ? Math.trunc(downloaded) : 0,
        downloadSpeed: Number.isFinite(downloadSpeed) && downloadSpeed >= 0 ? Math.trunc(downloadSpeed) : 0,
        savePath: typeof result.save_path === 'string' && result.save_path.trim() ? result.save_path.trim() : null,
        contentPath: typeof result.content_path === 'string' && result.content_path.trim() ? result.content_path.trim() : null
      }]
      : [];
  });
}

import { describeError } from './error-details.js';
import { readResponseText } from './bounded-body.js';

export type JellyfinConfig = {
  url: string;
  apiKey: string;
  libraryIds?: string[];
};

export type JellyfinLibrary = {
  id: string;
  name: string;
  collectionType: string | null;
};

export type JellyfinMedia = {
  id: string;
  libraryId: string;
  name: string;
  originalTitle: string | null;
  path: string | null;
  type: string;
};

type JellyfinItemsResponse = { Items?: unknown; TotalRecordCount?: unknown };
type JellyfinLibraryResponse = { ItemId?: unknown; Name?: unknown; CollectionType?: unknown };
type JellyfinUserResponse = { Id?: unknown; Name?: unknown; Policy?: { IsDisabled?: unknown; IsAdministrator?: unknown } };

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;
const INDEXED_VIDEO_TYPES = new Set(['Movie', 'Video']);

export function normalizeJellyfinUrl(raw: string) {
  const value = raw.trim();
  if (!value) throw new Error('请填写 Jellyfin Web 地址。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Jellyfin Web 地址格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Jellyfin Web 地址需使用 http 或 https。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Jellyfin Web 地址不能包含账号、查询参数或锚点。');
  }
  return url.toString().replace(/\/+$/, '');
}

export function assertJellyfinConfig(input: JellyfinConfig) {
  const url = normalizeJellyfinUrl(input.url);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('请填写 Jellyfin API 密钥。');
  if (apiKey.length > 512) throw new Error('Jellyfin API 密钥不能超过 512 个字符。');
  if (/[\r\n]/.test(apiKey)) throw new Error('Jellyfin API 密钥格式无效。');
  return { ...input, url, apiKey };
}

/**
 * Jellyfin 12 disables the old X-Emby-Token header by default. The standard
 * MediaBrowser Authorization scheme works with Jellyfin 12 and remains
 * compatible with supported older servers.
 */
export function jellyfinAuthorizationHeader(apiKey: string) {
  return `MediaBrowser Token="${apiKey.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function endpoint(baseUrl: string, pathname: string) {
  return new URL(pathname.replace(/^\//, ''), `${baseUrl}/`);
}

async function jellyfinRequest(config: JellyfinConfig, pathname: string, search?: URLSearchParams) {
  const checked = assertJellyfinConfig(config);
  const url = endpoint(checked.url, pathname);
  if (search) url.search = search.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { authorization: jellyfinAuthorizationHeader(checked.apiKey), accept: 'application/json' },
      signal: controller.signal
    });
    const body = await readResponseText(response);
    if (!response.ok) {
      const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(`Jellyfin 请求失败（HTTP ${response.status}）：${detail || '服务器未提供详细说明。'}`);
    }
    try { return JSON.parse(body) as unknown; }
    catch { throw new Error('Jellyfin 返回的不是有效 JSON。请确认填写的是 Jellyfin Web 地址。'); }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`连接 Jellyfin 超时（${new URL(checked.url).host}，${REQUEST_TIMEOUT_MS / 1000} 秒）。请检查地址、端口和 NAS 网络。`);
    }
    if (error instanceof Error && error.message.startsWith('Jellyfin ')) throw error;
    throw new Error(describeError(error, { action: '连接 Jellyfin', target: new URL(checked.url).host }));
  } finally {
    clearTimeout(timer);
  }
}

export async function testJellyfinConnection(config: JellyfinConfig) {
  const result = await jellyfinRequest(config, 'System/Info') as { ServerName?: unknown; Version?: unknown };
  return {
    serverName: typeof result.ServerName === 'string' && result.ServerName.trim() ? result.ServerName.trim() : 'Jellyfin',
    version: typeof result.Version === 'string' && result.Version.trim() ? result.Version.trim() : null
  };
}

export async function listJellyfinLibraries(config: JellyfinConfig) {
  const result = await jellyfinRequest(config, 'Library/VirtualFolders');
  if (!Array.isArray(result)) throw new Error('Jellyfin 媒体库列表格式无效。');
  return result.flatMap((value) => {
    const library = value as JellyfinLibraryResponse;
    const id = typeof library.ItemId === 'string' ? library.ItemId.trim() : '';
    const name = typeof library.Name === 'string' ? library.Name.trim() : '';
    return id && name ? [{ id, name, collectionType: typeof library.CollectionType === 'string' ? library.CollectionType : null }] : [];
  });
}

/**
 * Jellyfin 12 returns a partial, server-scoped result from /Items for some
 * library layouts. Queries made through an enabled user's view return the
 * same items shown in the Jellyfin web client, including recursive folders.
 * Prefer an administrator for API-key access; fall back to the first enabled
 * user when a server has no administrator in the response.
 */
async function jellyfinLibraryUserId(config: JellyfinConfig) {
  const result = await jellyfinRequest(config, 'Users');
  if (!Array.isArray(result)) throw new Error('Jellyfin 用户列表格式无效。');
  const users = result.flatMap((value) => {
    const user = value as JellyfinUserResponse;
    const id = typeof user.Id === 'string' ? user.Id.trim() : '';
    if (!id || user.Policy?.IsDisabled === true) return [];
    return [{ id, administrator: user.Policy?.IsAdministrator === true }];
  });
  const selected = users.find((user) => user.administrator) ?? users[0];
  if (!selected) throw new Error('Jellyfin 中没有可用于读取媒体库的启用用户。');
  return selected.id;
}

function userItemsPath(userId: string) {
  return `Users/${encodeURIComponent(userId)}/Items`;
}

export function isIndexedJellyfinVideoType(type: string) {
  return INDEXED_VIDEO_TYPES.has(type);
}

function normalizeMedia(value: unknown, libraryId: string) {
  const item = value as { Id?: unknown; Name?: unknown; OriginalTitle?: unknown; Path?: unknown; Type?: unknown };
  const id = typeof item.Id === 'string' ? item.Id.trim() : '';
  const name = typeof item.Name === 'string' ? item.Name.trim() : '';
  const type = typeof item.Type === 'string' ? item.Type : 'Unknown';
  // Jellyfin 12 can return BoxSet and Folder records even when GetItems has
  // IncludeItemTypes=Movie. Those records do not represent a playable item
  // and should never count as an inspected library video.
  if (!isIndexedJellyfinVideoType(type)) return null;
  return id && name ? {
    id,
    libraryId,
    name,
    originalTitle: typeof item.OriginalTitle === 'string' && item.OriginalTitle.trim() ? item.OriginalTitle.trim() : null,
    path: typeof item.Path === 'string' && item.Path.trim() ? item.Path.trim() : null,
    type
  } satisfies JellyfinMedia : null;
}

/** Retrieve an entire selected library in pages so matching is local and deterministic. */
export async function listJellyfinMedia(config: JellyfinConfig) {
  const all: JellyfinMedia[] = [];
  await streamJellyfinMedia(config, async (page) => { all.push(...page); });
  return all;
}

/** Stream selected-library pages to a caller-owned sink. The full synchronizer
 * writes each page immediately instead of retaining a complete server snapshot
 * in Node memory. */
export async function streamJellyfinMedia(config: JellyfinConfig, onPage: (page: JellyfinMedia[], scannedRaw: number, totalRaw: number | null) => Promise<void> | void) {
  const checked = assertJellyfinConfig(config);
  const libraryIds = [...new Set((checked.libraryIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (!libraryIds.length) throw new Error('请至少选择一个 Jellyfin 媒体库。');
  const userId = await jellyfinLibraryUserId(checked);
  let scannedRaw = 0;
  let knownTotal: number | null = null;
  for (const libraryId of libraryIds) {
    let startIndex = 0;
    let total = Number.POSITIVE_INFINITY;
    while (startIndex < total) {
      const query = new URLSearchParams({
        ParentId: libraryId,
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Video',
        Fields: 'Path,OriginalTitle',
        StartIndex: String(startIndex),
        Limit: String(PAGE_SIZE),
        EnableTotalRecordCount: 'true'
      });
      const result = await jellyfinRequest(checked, userItemsPath(userId), query) as JellyfinItemsResponse;
      if (!Array.isArray(result.Items)) throw new Error('Jellyfin 媒体项目列表格式无效。');
      // Use the raw result count for the next offset. Jellyfin 12 can cap a
      // requested page and can return non-video records that we filter out;
      // advancing by PAGE_SIZE or by filtered rows would skip real movies.
      const received = result.Items.length;
      const page = result.Items.flatMap((item) => {
        const media = normalizeMedia(item, libraryId);
        return media ? [media] : [];
      });
      scannedRaw += received;
      const parsedTotal = Number(result.TotalRecordCount);
      total = Number.isInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : startIndex + received;
      // Multiple selected libraries have independent totals; reporting a
      // running lower bound remains more useful than allocating a full list.
      knownTotal = knownTotal === null ? total : Math.max(knownTotal, scannedRaw + Math.max(0, total - startIndex - received));
      await onPage(page, scannedRaw, knownTotal);
      if (!received) break;
      startIndex += received;
    }
  }
  return scannedRaw;
}

/** Search selected libraries before applying strict local code matching. */
export async function findJellyfinMedia(config: JellyfinConfig, content: string) {
  const checked = assertJellyfinConfig(config);
  const libraryIds = [...new Set((checked.libraryIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (!libraryIds.length) throw new Error('请至少选择一个 Jellyfin 媒体库。');
  const userId = await jellyfinLibraryUserId(checked);
  const matches: JellyfinMedia[] = [];
  for (const libraryId of libraryIds) {
    const query = new URLSearchParams({ ParentId: libraryId, Recursive: 'true', IncludeItemTypes: 'Movie,Video', Fields: 'Path,OriginalTitle', SearchTerm: content, Limit: '25', EnableTotalRecordCount: 'true' });
    const result = await jellyfinRequest(checked, userItemsPath(userId), query) as JellyfinItemsResponse;
    if (!Array.isArray(result.Items)) throw new Error('Jellyfin 单条查询结果格式无效。');
    matches.push(...result.Items.flatMap((item) => {
      const media = normalizeMedia(item, libraryId);
      return media ? [media] : [];
    }));
  }
  return matches;
}

import { describeError } from './error-details.js';

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
  name: string;
  originalTitle: string | null;
  path: string | null;
  type: string;
};

type JellyfinItemsResponse = { Items?: unknown; TotalRecordCount?: unknown };
type JellyfinLibraryResponse = { ItemId?: unknown; Name?: unknown; CollectionType?: unknown };

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;

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
  return { ...input, url, apiKey };
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
      headers: { 'X-Emby-Token': checked.apiKey, accept: 'application/json' },
      signal: controller.signal
    });
    const body = await response.text();
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

function normalizeMedia(value: unknown) {
  const item = value as { Id?: unknown; Name?: unknown; OriginalTitle?: unknown; Path?: unknown; Type?: unknown };
  const id = typeof item.Id === 'string' ? item.Id.trim() : '';
  const name = typeof item.Name === 'string' ? item.Name.trim() : '';
  return id && name ? {
    id,
    name,
    originalTitle: typeof item.OriginalTitle === 'string' && item.OriginalTitle.trim() ? item.OriginalTitle.trim() : null,
    path: typeof item.Path === 'string' && item.Path.trim() ? item.Path.trim() : null,
    type: typeof item.Type === 'string' ? item.Type : 'Unknown'
  } satisfies JellyfinMedia : null;
}

/** Retrieve an entire selected library in pages so matching is local and deterministic. */
export async function listJellyfinMedia(config: JellyfinConfig) {
  const checked = assertJellyfinConfig(config);
  const libraryIds = [...new Set((checked.libraryIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (!libraryIds.length) throw new Error('请至少选择一个 Jellyfin 媒体库。');
  const all: JellyfinMedia[] = [];
  for (const libraryId of libraryIds) {
    let startIndex = 0;
    let total = Number.POSITIVE_INFINITY;
    while (startIndex < total) {
      const query = new URLSearchParams({
        ParentId: libraryId,
        Recursive: 'true',
        IncludeItemTypes: 'Movie',
        Fields: 'Path,OriginalTitle',
        StartIndex: String(startIndex),
        Limit: String(PAGE_SIZE),
        EnableTotalRecordCount: 'true'
      });
      const result = await jellyfinRequest(checked, 'Items', query) as JellyfinItemsResponse;
      if (!Array.isArray(result.Items)) throw new Error('Jellyfin 媒体项目列表格式无效。');
      const page = result.Items.flatMap((item) => {
        const media = normalizeMedia(item);
        return media ? [media] : [];
      });
      all.push(...page);
      const parsedTotal = Number(result.TotalRecordCount);
      total = Number.isInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : startIndex + page.length;
      startIndex += PAGE_SIZE;
      if (!page.length) break;
    }
  }
  return all;
}

/** Search selected libraries before applying strict local code matching. */
export async function findJellyfinMedia(config: JellyfinConfig, content: string) {
  const checked = assertJellyfinConfig(config);
  const libraryIds = [...new Set((checked.libraryIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (!libraryIds.length) throw new Error('请至少选择一个 Jellyfin 媒体库。');
  const matches: JellyfinMedia[] = [];
  for (const libraryId of libraryIds) {
    const query = new URLSearchParams({ ParentId: libraryId, Recursive: 'true', IncludeItemTypes: 'Movie', Fields: 'Path,OriginalTitle', SearchTerm: content, Limit: '25', EnableTotalRecordCount: 'true' });
    const result = await jellyfinRequest(checked, 'Items', query) as JellyfinItemsResponse;
    if (!Array.isArray(result.Items)) throw new Error('Jellyfin 单条查询结果格式无效。');
    matches.push(...result.Items.flatMap((item) => {
      const media = normalizeMedia(item);
      return media ? [media] : [];
    }));
  }
  return matches;
}

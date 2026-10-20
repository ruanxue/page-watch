/**
 * 前端唯一的接口调用入口。
 *
 * 这里集中处理三件事：JSON 头、同源 Cookie、以及基于 ETag 的 GET 缓存。
 * 抽成独立模块是为了让页面组件只关心数据形状，不再各自拼 fetch。
 */

const responseCache = new Map<string, { etag: string; value: unknown }>();
const pendingRequests = new Map<string, Promise<unknown>>();

/** 登录态或数据源切换后调用，避免读到上一个会话的缓存。 */
export function clearResponseCache() {
  responseCache.clear();
  pendingRequests.clear();
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const cacheable = (options?.method ?? 'GET').toUpperCase() === 'GET' && !options?.body;
  const key = cacheable ? url : '';
  const cached = cacheable ? responseCache.get(key) : undefined;
  if (cached) headers.set('if-none-match', cached.etag);
  if (cacheable && pendingRequests.has(key)) return pendingRequests.get(key) as Promise<T>;
  const execute = async () => {
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 304 && cached) return cached.value as T;
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? '请求失败，请稍后再试。');
    }
    if (response.status === 204) return undefined as T;
    const value = await response.json() as T;
    const etag = response.headers.get('etag');
    if (cacheable && etag) responseCache.set(key, { etag, value });
    return value;
  };
  const promise = execute();
  if (cacheable) pendingRequests.set(key, promise);
  try { return await promise; }
  finally { if (cacheable) pendingRequests.delete(key); }
}

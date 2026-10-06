/**
 * 「检查规则」里的站点列表：读取番号、标题、发行日期和女优页都按这里的顺序
 * 尝试。独立成模块是为了让它不依赖数据库，既方便单独测试，也让保存规则、
 * 浏览器抓取等不同进程都能直接复用同一套判断。
 */

export type SitesRule = string[];

export const defaultSites: SitesRule = ['https://missav123.com', 'https://missav.live'];

export const MAX_SITES = 5;

/**
 * 站点只保留协议和域名：读取时始终沿用订阅当前的页面路径，只替换域名，
 * 因此存储多余的路径没有意义，反而会误导使用者。
 */
export function normalizeSiteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/** 过滤非法项、去重、保留填写顺序，最多 MAX_SITES 个。 */
export function normalizeSiteList(value: unknown, fallback: SitesRule = defaultSites): SitesRule {
  if (!Array.isArray(value)) return [...fallback];
  const parsed: string[] = [];
  for (const entry of value) {
    const site = normalizeSiteUrl(entry);
    if (site && !parsed.includes(site)) parsed.push(site);
  }
  return parsed.length ? parsed.slice(0, MAX_SITES) : [...fallback];
}

/** 允许访问的站点主机名，用于校验订阅地址和页面上抓到的链接。 */
export function allowedSiteHosts(value: SitesRule) {
  const hosts = new Set<string>();
  for (const site of value) {
    try { hosts.add(new URL(site).hostname.toLowerCase()); }
    catch { /* 非法站点已在保存时拦截，这里直接跳过 */ }
  }
  return hosts;
}

/** 检查每次都从首选站点开始，沿用订阅原来的路径、参数和锚点。 */
export function orderedSiteUrls(original: URL, value: SitesRule): URL[] {
  return normalizeSiteList(value).map((site) => new URL(original.pathname + original.search + original.hash, site));
}

/**
 * 按填写顺序选择下一个站点，并沿用原来的页面路径与查询参数。当前地址不在
 * 站点列表中（例如历史订阅仍指向旧域名）时，改从第一个站点重试。
 */
export function nextSiteUrl(current: URL, value: SitesRule) {
  const currentHost = current.hostname.toLowerCase();
  const normalized = value
    .map((candidate) => normalizeSiteUrl(candidate))
    .filter((site): site is string => site !== null);
  const index = normalized.findIndex((site) => new URL(site).hostname.toLowerCase() === currentHost);
  // 命中列表就顺着往下取一个，取完回到第一个；没命中（例如历史订阅仍指向旧
  // 域名）就从第一个站点开始试。
  const order = index === -1
    ? normalized
    : [...normalized.slice(index + 1), ...normalized.slice(0, index + 1)];
  for (const site of order) {
    const picked = new URL(site);
    if (picked.hostname.toLowerCase() === currentHost) continue;
    return new URL(current.pathname + current.search + current.hash, picked.origin);
  }
  return null;
}

export function validateSiteList(value: SitesRule) {
  if (!value.length) throw new Error('请至少填写一个读取站点。');
  if (value.length > MAX_SITES) throw new Error(`读取站点最多 ${MAX_SITES} 个。`);
}

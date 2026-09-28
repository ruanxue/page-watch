export type MissavSearchAnchor = {
  href: string;
  text?: string | null;
  alt?: string | null;
  title?: string | null;
};

export type MissavFilmCandidate = {
  code: string;
  title: string;
  detailUrl: string;
};

const missavHosts = new Set(['missav123.com', 'www.missav123.com', 'missav.live', 'www.missav.live']);

export function normalizeProductCode(value: string) {
  const match = value.trim().match(/^([a-z]{2,16})[-_\s]?(\d{2,8})$/i);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

export function productCodeKey(value: string) {
  return normalizeProductCode(value)?.toLowerCase() ?? null;
}

function productCodesIn(value: string) {
  const decoded = value.replace(/%2d/gi, '-').replace(/[_\s]+/g, '-');
  const matches = decoded.matchAll(/([a-z]{2,16})-?(\d{2,8})(?=$|[^a-z0-9])/gi);
  return [...matches].map((match) => `${match[1].toUpperCase()}-${match[2]}`);
}

export function productCodeKeys(value: string) {
  return [...new Set(productCodesIn(value).map((code) => productCodeKey(code)).filter((code): code is string => code !== null))];
}

export function productCodeSearchPatterns(value: string) {
  const code = normalizeProductCode(value);
  if (!code) return [];
  const [prefix, number] = code.toLowerCase().split('-');
  return [`%${prefix}-${number}%`, `%${prefix}_${number}%`, `%${prefix} ${number}%`, `%${prefix}${number}%`];
}

export function safeMissavDetailUrl(raw: string, baseUrl: string) {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !missavHosts.has(url.hostname.toLowerCase())) return null;
    const path = url.pathname.match(/^\/(?:dm\d+\/)?cn\/([^/]+)\/?$/i);
    if (!path || /^(?:actresses|search)$/i.test(path[1])) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function displayTitle(value: string, code: string) {
  const prefix = new RegExp(`^${code.replace('-', '[-_\\s]?')}\\s*[-:：]?\\s*`, 'i');
  return value.replace(/\s+/g, ' ').trim().replace(prefix, '').trim();
}

/** Match by the exact product code found in a result card, never by position. */
export function findMissavFilmCandidate(anchors: MissavSearchAnchor[], wantedCode: string, baseUrl: string): MissavFilmCandidate | null {
  const wantedKey = productCodeKey(wantedCode);
  if (!wantedKey) return null;
  const byUrl = new Map<string, { codeMatched: boolean; title: string; code: string }>();
  for (const anchor of anchors) {
    const detailUrl = safeMissavDetailUrl(anchor.href, baseUrl);
    if (!detailUrl) continue;
    const url = new URL(detailUrl);
    const slug = url.pathname.split('/').at(-1) ?? '';
    const sources = [anchor.alt, anchor.title, anchor.text, slug].filter((value): value is string => Boolean(value?.trim()));
    const detectedCode = sources.flatMap(productCodesIn).find((code) => productCodeKey(code) === wantedKey);
    if (!detectedCode) continue;
    const titleText = [anchor.text, anchor.title, anchor.alt].find((value) => Boolean(value?.trim() && productCodesIn(value).some((code) => productCodeKey(code) === wantedKey))) ?? '';
    const current = byUrl.get(detailUrl);
    const candidateTitle = displayTitle(titleText, detectedCode);
    byUrl.set(detailUrl, {
      codeMatched: true,
      code: detectedCode,
      title: candidateTitle.length > (current?.title.length ?? 0) ? candidateTitle : current?.title ?? ''
    });
  }
  const [detailUrl, match] = byUrl.entries().next().value ?? [];
  return detailUrl && match?.codeMatched ? { code: match.code, title: match.title || match.code, detailUrl } : null;
}

export function normalizeMissavActressIdentity(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !missavHosts.has(url.hostname.toLowerCase())) return null;
    const path = url.pathname.replace(/^\/dm\d+(?=\/)/i, '');
    const match = path.match(/^\/cn\/actresses\/([^/]+)\/?$/i);
    if (!match) return null;
    return decodeURIComponent(match[1]).normalize('NFKC').toLocaleLowerCase();
  } catch {
    return null;
  }
}

export function buildMissavActressSubscriptionUrl(raw: string) {
  const identity = normalizeMissavActressIdentity(raw);
  if (!identity) throw new Error('女优链接不是受支持的 MissAV 页面。');
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  url.searchParams.set('filters', 'individual');
  return url.toString();
}

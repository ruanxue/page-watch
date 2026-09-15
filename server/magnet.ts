import * as cheerio from 'cheerio';
import { ProxyAgent } from 'undici';
import { getOutboundProxyUrl } from './db.js';
import { describeError } from './error-details.js';
import { defaultInspectionRules, type MagnetRule } from './inspection-rules.js';
import { findMagnetDetailPath as parseMagnetDetailPath } from './magnet-parser.js';

export { decodeCloudflareEmail } from './magnet-parser.js';

const REQUEST_TIMEOUT_MS = 25_000;
const ORIGIN_HEALTH_TTL_MS = 10 * 60 * 1000;
let lastRequestStartedAt = 0;
let lastOriginHealthCheckAt = 0;

type SearchOrigin = string;
type OriginHealth = { origin: SearchOrigin; latencyMs: number | null; error?: string };
let originHealth: OriginHealth[] | null = null;
let originHealthSignature = '';

export type MagnetLookupResult =
  | { status: 'found'; value: string; origin: SearchOrigin }
  | { status: 'not_found'; reason: string; origin: SearchOrigin };

function fallbackFilenamePrefixes(rule: MagnetRule) {
  const primary = rule.filenamePrefix.trim().toLowerCase();
  return [...new Set(rule.fallbackFilenamePrefixes
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .filter((prefix) => prefix.toLowerCase() !== primary))];
}

async function waitForRequestSlot(requestGapMs: number) {
  const delay = Math.max(0, lastRequestStartedAt + requestGapMs - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastRequestStartedAt = Date.now();
}

async function fetchTarget(url: URL, stage: '节点测速' | '搜索页' | '详情页', requestGapMs: number) {
  await waitForRequestSlot(requestGapMs);
  const requestedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const proxyUrl = getOutboundProxyUrl();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'PageWatch/0.1 (+self-hosted webpage monitor)' },
      ...(dispatcher ? { dispatcher } : {})
    });
    if (response.status >= 300 && response.status < 400) throw new Error(`目标网站返回重定向（HTTP ${response.status}）。`);
    if (!response.ok) throw new Error(`目标网站返回 HTTP ${response.status}。`);
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error('目标页面超过 5 MB，已停止解析。');
    return { html, latencyMs: Math.round(performance.now() - requestedAt) };
  } catch (error) {
    const action = stage === '节点测速' ? '磁力节点测速' : `磁力${stage}请求`;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(describeError(new Error('请求超时', { cause: error }), { action, target: url.hostname, proxyUrl }));
    }
    throw new Error(describeError(error, { action, target: url.hostname, proxyUrl }));
  } finally {
    clearTimeout(timeout);
    await dispatcher?.close();
  }
}

export function findMagnetDetailPath(html: string, origin: SearchOrigin = defaultInspectionRules.magnet.origins[0], rule: MagnetRule = defaultInspectionRules.magnet) {
  return parseMagnetDetailPath(html, origin, rule);
}

function noMagnetResultReason(rule: MagnetRule) {
  const fallbacks = fallbackFilenamePrefixes(rule);
  if (!fallbacks.length) return `未找到文件名以 ${rule.filenamePrefix} 开头的搜索结果。`;
  return `未找到文件名以 ${rule.filenamePrefix} 开头的搜索结果，也未匹配后备标记 ${fallbacks.join('、')}。`;
}

/**
 * Some search mirrors return the magnet value double HTML-escaped (for
 * example, `&amp;amp;tr=`).  A magnet URI is not HTML, so retain the canonical
 * ampersand form before persisting it.  The bounded loop also prevents an
 * unexpectedly crafted value from causing unbounded work.
 */
export function normalizeMagnetValue(raw: string) {
  let value = raw.trim();
  for (let index = 0; index < 4; index += 1) {
    const decoded = value.replace(/&(amp|#0*38|#x0*26);/gi, '&');
    if (decoded === value) break;
    value = decoded;
  }
  return value;
}

export function extractMagnetValue(html: string, rule: MagnetRule = defaultInspectionRules.magnet) {
  const element = cheerio.load(html)(rule.valueSelector).first();
  const value = rule.valueSource === 'attribute' ? element.attr(rule.valueAttribute) : element.text();
  if (!value) throw new Error('详情页未提供磁力链接，无法完成检索。');
  const normalized = normalizeMagnetValue(value);
  if (!new RegExp(rule.valueMatchPattern, 'i').test(normalized)) throw new Error('详情页提供的磁力链接未通过当前规则的格式校验。');
  return normalized;
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function markOriginFailure(origin: SearchOrigin, error: unknown) {
  if (!originHealth) return;
  originHealth = originHealth.map((item) => item.origin === origin ? { ...item, latencyMs: null, error: messageFor(error) } : item);
}

function markOriginSuccess(origin: SearchOrigin, latencyMs: number) {
  if (!originHealth) return;
  originHealth = originHealth.map((item) => item.origin === origin ? { origin, latencyMs } : item);
}

function ruleSignature(rule: MagnetRule) {
  return JSON.stringify({ origins: rule.origins, searchUrlTemplate: rule.searchUrlTemplate, requestIntervalMs: rule.requestIntervalMs });
}

function searchUrlFor(origin: string, content: string, rule: MagnetRule) {
  const expanded = rule.searchUrlTemplate.replaceAll('{{origin}}', origin).replaceAll('{{content}}', encodeURIComponent(content));
  const url = new URL(expanded);
  if (url.origin !== new URL(origin).origin) throw new Error('搜索地址模板必须指向当前磁力检索节点。');
  return url;
}

/** Probe configured mirrors serially and retain the result for ten minutes. */
export async function rankedMagnetOrigins(rule: MagnetRule = defaultInspectionRules.magnet, force = false): Promise<SearchOrigin[]> {
  const signature = ruleSignature(rule);
  if (originHealthSignature !== signature) {
    originHealth = null;
    originHealthSignature = signature;
  }
  if (!force && originHealth && Date.now() - lastOriginHealthCheckAt < ORIGIN_HEALTH_TTL_MS) {
    return [...originHealth].sort((left, right) => (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity)).map((item) => item.origin);
  }
  const measurements: OriginHealth[] = [];
  for (const origin of rule.origins) {
    try {
      const probeUrl = searchUrlFor(origin, 'page-watch-health-check', rule);
      const result = await fetchTarget(probeUrl, '节点测速', rule.requestIntervalMs);
      measurements.push({ origin, latencyMs: result.latencyMs });
    } catch (error) {
      measurements.push({ origin, latencyMs: null, error: messageFor(error) });
    }
  }
  originHealth = measurements;
  lastOriginHealthCheckAt = Date.now();
  return [...measurements].sort((left, right) => (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity)).map((item) => item.origin);
}

export async function lookupMagnet(content: string, rule: MagnetRule = defaultInspectionRules.magnet): Promise<MagnetLookupResult> {
  const query = content.trim();
  if (!query) throw new Error('归档内容为空，无法检索磁力链接。');
  const failures: string[] = [];
  let notFoundReason = '';
  let notFoundOrigin = '';
  for (const origin of await rankedMagnetOrigins(rule)) {
    try {
      const searchUrl = searchUrlFor(origin, query, rule);
      const search = await fetchTarget(searchUrl, '搜索页', rule.requestIntervalMs);
      const detailPath = findMagnetDetailPath(search.html, origin, rule);
      if (!detailPath) {
        notFoundReason = noMagnetResultReason(rule);
        notFoundOrigin = origin;
        continue;
      }
      const detail = await fetchTarget(new URL(detailPath, origin), '详情页', rule.requestIntervalMs);
      markOriginSuccess(origin, Math.min(search.latencyMs, detail.latencyMs));
      return { status: 'found', value: extractMagnetValue(detail.html, rule), origin };
    } catch (error) {
      markOriginFailure(origin, error);
      failures.push(`${new URL(origin).hostname}：${messageFor(error)}`);
    }
  }
  if (notFoundOrigin) return { status: 'not_found', reason: notFoundReason, origin: notFoundOrigin };
  throw new Error(`所有磁力节点均无法完成检索：${failures.join('；') || '未知错误'}`);
}

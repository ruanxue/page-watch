import crypto from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { ProxyAgent } from 'undici';
import { db, getOutboundProxyUrl, queueMagnetJob, queueReleaseJob, type DatabaseClient, type Subscription } from './db.js';
import { describeError } from './error-details.js';
import { expandReleaseUrl, getInspectionRules } from './inspection-rules.js';

// Some DNS forwarders return an unusable ::1 AAAA record together with a valid
// public A record.  Prefer the valid IPv4 address for Node's outbound requests.
setDefaultResultOrder('ipv4first');

export type CaptureResult = {
  title: string;
  content: string;
  hash: string;
  items: CapturedItem[];
  pageCount?: number;
};

export type CapturedItem = {
  content: string;
  title: string | null;
  detailUrl: string | null;
};

function pageCount(value: string, pattern: string | null) {
  let match: RegExpMatchArray | null;
  try { match = value.match(pattern?.trim() ? new RegExp(pattern, 'i') : /\/\s*(\d+)/); }
  catch (error) { throw new Error(`分页页数匹配规则无法执行：${error instanceof Error ? error.message : '未知错误'}`); }
  const count = Number(match?.[1] ?? match?.[0]?.match(/\d+/)?.[0] ?? 1);
  return Number.isInteger(count) ? Math.min(Math.max(count, 1), 100) : 1;
}

function applyMatchPattern(value: string, pattern: string | null) {
  if (!pattern?.trim()) return value;
  let match: RegExpMatchArray | null;
  try { match = value.match(new RegExp(pattern, 'i')); } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`内容匹配规则无法执行：${detail}`);
  }
  if (!match) return '';
  return normalize(match[1] ?? match[0]);
}

function uniqueItems(items: CapturedItem[]) {
  const unique = new Map<string, CapturedItem>();
  for (const item of items) {
    const existing = unique.get(item.content);
    if (!existing || (!existing.title && item.title) || (!existing.detailUrl && item.detailUrl)) {
      unique.set(item.content, { content: item.content, title: item.title ?? existing?.title ?? null, detailUrl: item.detailUrl ?? existing?.detailUrl ?? null });
    }
  }
  return [...unique.values()];
}

function extractItems(contentValues: Array<string | null | undefined>, titleValues: Array<string | null | undefined> | undefined, detailUrlValues: Array<string | null | undefined> | undefined, pattern: string | null, titlePattern: string | null, resultMode: Subscription['result_mode']) {
  const candidates: CapturedItem[] = [];
  const examples: string[] = [];
  for (let index = 0; index < contentValues.length; index += 1) {
    const rawContent = normalize(contentValues[index] ?? '');
    if (!rawContent) continue;
    examples.push(rawContent);
    const content = applyMatchPattern(rawContent, pattern);
    if (!content) continue;
    const rawTitle = normalize(titleValues?.[index] ?? '');
    const title = rawTitle ? applyMatchPattern(rawTitle, titlePattern) || null : null;
    candidates.push({ content, title, detailUrl: detailUrlValues?.[index]?.trim() || null });
  }
  const selected = resultMode === 'all' ? candidates : candidates.slice(0, 1);
  const items = uniqueItems(selected);
  if (!items.length) {
    if (!pattern) throw new Error('目标元素没有可提取的文本内容。');
    const sample = examples.slice(0, 3).map((value) => value.slice(0, 80)).join('；');
    throw new Error(`内容匹配规则没有匹配到结果。已读取 ${examples.length} 项${sample ? `，例如：${sample}` : ''}`);
  }
  return items;
}

function resolveDetailUrl(raw: string | null | undefined, base: URL) {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function contentForItems(items: CapturedItem[]) {
  return items.map((item) => item.content).join('\n');
}

const blockedHosts = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
const localBrowserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

function localBrowserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (process.platform !== 'win32') return undefined;
  return localBrowserCandidates.find((candidate) => fs.existsSync(candidate));
}

function isPrivateIp(value: string) {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (!net.isIP(hostname)) return false;
  if (hostname === '::1' || hostname === '::' || hostname === '0.0.0.0') return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')) return true;
  if (hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.')) return true;
  const first = Number(hostname.split('.')[0]);
  const second = Number(hostname.split('.')[1]);
  return first === 172 && second >= 16 && second <= 31;
}

function isIpv6Loopback(value: string) {
  return value.replace(/^\[|\]$/g, '').toLowerCase() === '::1';
}

export async function assertSafeUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('请输入有效的网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http 或 https 地址。');
  if (blockedHosts.has(url.hostname.toLowerCase()) || isPrivateIp(url.hostname)) {
    throw new Error('不允许访问本机或内网地址。');
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  // With an outbound proxy, the proxy performs the eventual DNS lookup. Some
  // domains are intentionally only resolvable from that network, so rejecting
  // them here would make a correctly configured proxy unusable. Literal and
  // locally resolved private addresses remain blocked above/below.
  if (!addresses.length && !getOutboundProxyUrl()) throw new Error('无法解析该网页地址。');
  const privateAddresses = addresses.filter((address) => isPrivateIp(address.address));
  const publicAddresses = addresses.filter((address) => !isPrivateIp(address.address));
  // A few router DNS forwarders (including common proxy-router setups) append
  // ::1 to every hostname while still returning a valid public IPv4 A record.
  // Accept only that narrow mixed result; all other private/mixed DNS answers
  // remain blocked to prevent an external hostname from reaching the LAN.
  const hasOnlyIpv6LoopbackAlongsidePublicAddress = publicAddresses.length > 0
    && privateAddresses.length > 0
    && privateAddresses.every((address) => isIpv6Loopback(address.address));
  if (privateAddresses.length > 0 && !hasOnlyIpv6LoopbackAlongsidePublicAddress) {
    const resolved = addresses.map((address) => address.address).join(', ');
    throw new Error(`不允许访问解析到内网的地址（${url.hostname}：${resolved}）。`);
  }
  return url;
}

function normalize(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function getStatic(url: URL, selector: string, contentSource: Subscription['content_source'], attributeName: string | null, matchPattern: string | null, resultMode: Subscription['result_mode'], pageCountSelector?: string | null, pageCountPattern?: string | null, titleSelector?: string | null, titleContentSource: Subscription['title_content_source'] = 'text', titleAttributeName: string | null = null, titleMatchPattern: string | null = null): Promise<CaptureResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const proxyUrl = getOutboundProxyUrl();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'PageWatch/0.1 (+self-hosted webpage monitor)' },
      redirect: 'manual',
      ...(dispatcher ? { dispatcher } : {})
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('网页重定向没有目标地址。');
      return getStatic(await assertSafeUrl(new URL(location, url).toString()), selector, contentSource, attributeName, matchPattern, resultMode, pageCountSelector, pageCountPattern, titleSelector, titleContentSource, titleAttributeName, titleMatchPattern);
    }
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error('网页内容超过 5 MB，已停止解析。');
    const $ = cheerio.load(html);
    const elements = $(selector).toArray();
    if (!elements.length) throw new Error(`找不到选择器：${selector}`);
    const rawContent = elements.map((element) => contentSource === 'attribute' ? $(element).attr(attributeName ?? '') : $(element).text());
    const titleElements = titleSelector ? $(titleSelector).toArray() : undefined;
    const rawTitles = titleElements?.map((element) => titleContentSource === 'attribute' ? $(element).attr(titleAttributeName ?? '') : $(element).text());
    const detailUrls = elements.map((element) => resolveDetailUrl($(element).attr('href'), url));
    const items = extractItems(rawContent, rawTitles, detailUrls, matchPattern, titleMatchPattern, resultMode);
    const content = contentForItems(items);
    return { title: normalize($('title').first().text()) || url.hostname, content, hash: hash(content), items, ...(pageCountSelector ? { pageCount: pageCount($(pageCountSelector).first().text(), pageCountPattern ?? null) } : {}) };
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timeout);
    await dispatcher?.close();
  }
}

async function getDynamic(url: URL, selector: string, contentSource: Subscription['content_source'], attributeName: string | null, matchPattern: string | null, resultMode: Subscription['result_mode'], pageCountSelector?: string | null, pageCountPattern?: string | null, titleSelector?: string | null, titleContentSource: Subscription['title_content_source'] = 'text', titleAttributeName: string | null = null, titleMatchPattern: string | null = null): Promise<CaptureResult> {
  const proxyUrl = getOutboundProxyUrl();
  const executablePath = localBrowserExecutable();
  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    ...(executablePath ? { executablePath } : {}),
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {})
  });
  try {
    const page = await browser.newPage({ userAgent: 'PageWatch/0.1 (+self-hosted webpage monitor)' });
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const elements = page.locator(selector);
    await elements.first().waitFor({ state: 'attached', timeout: 15_000 });
    const rawContent = await elements.evaluateAll((nodes, options) => nodes.map((node) => options.contentSource === 'attribute'
      ? node.getAttribute(options.attributeName ?? '')
      : node.textContent), { contentSource, attributeName });
    const rawTitles = titleSelector ? await page.locator(titleSelector).evaluateAll((nodes, options) => nodes.map((node) => options.contentSource === 'attribute'
      ? node.getAttribute(options.attributeName ?? '')
      : node.textContent), { contentSource: titleContentSource, attributeName: titleAttributeName }) : undefined;
    const rawDetailUrls = await elements.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
    const detailUrls = rawDetailUrls.map((value) => resolveDetailUrl(value, url));
    const items = extractItems(rawContent, rawTitles, detailUrls, matchPattern, titleMatchPattern, resultMode);
    const content = contentForItems(items);
    const countText = pageCountSelector ? await page.locator(pageCountSelector).first().textContent().catch(() => '') : '';
    return { title: normalize(await page.title()) || url.hostname, content, hash: hash(content), items, ...(pageCountSelector ? { pageCount: pageCount(countText ?? '', pageCountPattern ?? null) } : {}) };
  } finally {
    await browser.close();
  }
}

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function archiveItems(content: string) {
  return [...new Set(content.split('\n').map((item) => item.trim()).filter(Boolean))];
}

async function archiveNewItems(subscription: Subscription, items: CapturedItem[], capturedAt: string, client: DatabaseClient) {
  const rules = getInspectionRules();
  const currentItems = uniqueItems(items);
  const archivedCount = await client.get<{ count: number }>('SELECT COUNT(*) AS count FROM archive_entries WHERE subscription_id = ?', [subscription.id]);
  const previousItems = new Set(archiveItems(subscription.last_content ?? ''));
  const additions = (archivedCount?.count ?? 0) === 0 ? currentItems : currentItems.filter((item) => !previousItems.has(item.content));
  for (const item of additions) {
    const detailUrl = item.detailUrl;
    const releaseUrl = rules.releaseDate.enabled ? expandReleaseUrl(rules.releaseDate.urlTemplate, { detailUrl, subscriptionUrl: subscription.url, content: item.content }) : null;
    const result = await client.run(`INSERT IGNORE INTO archive_entries
      (subscription_id, content, title, content_hash, first_seen_at, detail_url, release_status, magnet_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [subscription.id, item.content, item.title, hash(item.content), capturedAt, detailUrl, releaseUrl ? 'pending' : 'unsearched', rules.magnet.enabled ? 'pending' : 'unsearched', capturedAt]);
    if (result.changes) {
      if (rules.magnet.enabled) await queueMagnetJob(result.lastInsertRowid, client);
      if (releaseUrl) await queueReleaseJob(result.lastInsertRowid, client);
    }
  }
  for (const item of currentItems) {
    if (item.title) await client.run(`UPDATE archive_entries SET title = ?, updated_at = ?
      WHERE subscription_id = ? AND content_hash = ? AND (title IS NULL OR title <> ?)`, [item.title, capturedAt, subscription.id, hash(item.content), item.title]);
  }
  return additions.length;
}

export async function previewCapture(input: Pick<Subscription, 'url' | 'selector' | 'render_mode' | 'content_source' | 'attribute_name' | 'match_pattern' | 'title_selector' | 'title_content_source' | 'title_attribute_name' | 'title_match_pattern' | 'result_mode'>) {
  const url = await assertSafeUrl(input.url);
  if (!input.selector.trim()) throw new Error('请填写 CSS 选择器。');
  if (input.content_source === 'attribute' && !input.attribute_name?.trim()) throw new Error('请填写要提取的属性名。');
  return input.render_mode === 'dynamic'
    ? getDynamic(url, input.selector, input.content_source, input.attribute_name, input.match_pattern, input.result_mode, undefined, undefined, input.title_selector, input.title_content_source, input.title_attribute_name, input.title_match_pattern)
    : getStatic(url, input.selector, input.content_source, input.attribute_name, input.match_pattern, input.result_mode, undefined, undefined, input.title_selector, input.title_content_source, input.title_attribute_name, input.title_match_pattern);
}

async function capturePage(subscription: Subscription, rawUrl: string, includePageCount = false) {
  const url = await assertSafeUrl(rawUrl);
  return subscription.render_mode === 'dynamic'
    ? getDynamic(url, subscription.selector, subscription.content_source, subscription.attribute_name, subscription.match_pattern, subscription.result_mode, includePageCount ? subscription.pagination_selector : null, subscription.pagination_match_pattern, subscription.title_selector, subscription.title_content_source, subscription.title_attribute_name, subscription.title_match_pattern)
    : getStatic(url, subscription.selector, subscription.content_source, subscription.attribute_name, subscription.match_pattern, subscription.result_mode, includePageCount ? subscription.pagination_selector : null, subscription.pagination_match_pattern, subscription.title_selector, subscription.title_content_source, subscription.title_attribute_name, subscription.title_match_pattern);
}

export async function captureSubscription(subscription: Subscription) {
  let first: CaptureResult;
  try {
    first = await capturePage(subscription, subscription.url, !subscription.initial_scan_completed && Boolean(subscription.pagination_selector));
  } catch (error) {
    throw new Error(describeError(error, { action: '第 1 页读取', target: new URL(subscription.url).hostname, proxyUrl: getOutboundProxyUrl() }), { cause: error });
  }
  const capturedItems = [...first.items];
  const total = !subscription.initial_scan_completed && subscription.pagination_selector ? (first.pageCount ?? 1) : 1;
  if (!subscription.initial_scan_completed && subscription.pagination_selector) {
    await db.run('UPDATE subscriptions SET initial_scan_total = ?, initial_scan_pages_completed = 1, last_error = NULL WHERE id = ? AND updated_at = ?', [total, subscription.id, subscription.updated_at]);
    for (let page = 2; page <= total; page += 1) {
      const url = new URL(subscription.url);
      url.searchParams.set(subscription.pagination_parameter || 'page', String(page));
      let result: CaptureResult;
      try {
        result = await capturePage(subscription, url.toString());
      } catch (error) {
        throw new Error(describeError(error, { action: `第 ${page}/${total} 页读取`, target: url.hostname, proxyUrl: getOutboundProxyUrl() }), { cause: error });
      }
      capturedItems.push(...result.items);
      await db.run('UPDATE subscriptions SET initial_scan_pages_completed = ? WHERE id = ? AND updated_at = ?', [page, subscription.id, subscription.updated_at]);
    }
  }
  const items = uniqueItems(capturedItems);
  const content = contentForItems(items);
  const result = { ...first, items, content, hash: hash(content) };
  const changed = Boolean(subscription.last_hash && subscription.last_hash !== result.hash);
  const now = new Date().toISOString();
  const stored = await db.transaction(async (tx) => {
    const write = await tx.run(`UPDATE subscriptions
      SET last_checked_at = ?, last_hash = ?, last_content = ?, last_error = NULL, initial_scan_completed = CASE WHEN pagination_selector IS NULL THEN initial_scan_completed ELSE 1 END, initial_scan_total = CASE WHEN pagination_selector IS NULL THEN initial_scan_total ELSE ? END, initial_scan_pages_completed = CASE WHEN pagination_selector IS NULL THEN initial_scan_pages_completed ELSE ? END, updated_at = ?
      WHERE id = ? AND updated_at = ?`, [now, result.hash, result.content, total, total, now, subscription.id, subscription.updated_at]);
    const addedCount = write.changes ? await archiveNewItems(subscription, result.items, now, tx) : 0;
    return { stored: Boolean(write.changes), addedCount };
  });
  return { ...result, changed, capturedAt: now, ...stored, itemCount: result.items.length, totalPages: total };
}

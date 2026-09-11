import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { ProxyAgent } from 'undici';
import { assertSafeUrl } from './capture.js';
import { getOutboundProxyUrl } from './db.js';
import { describeError } from './error-details.js';
import type { ReleaseDateRule } from './inspection-rules.js';

const REQUEST_TIMEOUT_MS = 25_000;
let lastRequestStartedAt = 0;
const localBrowserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

export type ReleaseDateLookupResult =
  | { status: 'found'; releaseDate: string }
  | { status: 'unavailable'; reason: string };

function normalize(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function validDate(value: string) {
  const match = value.match(/\b(19\d{2}|20\d{2})-(\d{2})-(\d{2})\b/);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function matchedValue(value: string, pattern: string) {
  const match = value.match(new RegExp(pattern, 'i'));
  if (!match) return null;
  // A user may use a convenience group for only the year/month. Prefer a
  // capture only when it is itself a complete date; otherwise retain the full
  // match. This also keeps earlier default rules compatible.
  return validDate(match[1] ?? '') ? match[1] : match[0];
}

/** Parse a configured labelled detail-page field into a normal YYYY-MM-DD date. */
export function extractReleaseDate(html: string, rule: Pick<ReleaseDateRule, 'containerSelector' | 'labelSelector' | 'labelText' | 'valueSelector' | 'valueSource' | 'valueAttribute' | 'valueMatchPattern'>) {
  const $ = cheerio.load(html);
  for (const element of $(rule.containerSelector).toArray()) {
    const label = normalize($(element).find(rule.labelSelector).first().text()).replace(/[：:]/g, '');
    if (label !== normalize(rule.labelText).replace(/[：:]/g, '')) continue;
    const valueElement = $(element).find(rule.valueSelector).first();
    const value = rule.valueSource === 'attribute' ? valueElement.attr(rule.valueAttribute) ?? '' : valueElement.text();
    const matched = matchedValue(normalize(value), rule.valueMatchPattern);
    if (matched) return validDate(matched);
  }
  return null;
}

async function waitForRequestSlot(requestGapMs: number) {
  const delay = Math.max(0, lastRequestStartedAt + requestGapMs - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastRequestStartedAt = Date.now();
}

async function fetchDetail(url: URL, requestGapMs: number, redirectsLeft = 3): Promise<string> {
  await waitForRequestSlot(requestGapMs);
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
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`详情页重定向缺少目标地址（HTTP ${response.status}）。`);
      if (redirectsLeft <= 0) throw new Error('详情页重定向次数过多。');
      return fetchDetail(await assertSafeUrl(new URL(location, url).toString()), requestGapMs, redirectsLeft - 1);
    }
    if (!response.ok) throw new Error(`详情页返回 HTTP ${response.status}。`);
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error('详情页超过 5 MB，已停止解析。');
    return html;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(describeError(new Error('请求超时', { cause: error }), { action: '发行日期详情页读取', target: url.hostname, proxyUrl }));
    throw new Error(describeError(error, { action: '发行日期详情页读取', target: url.hostname, proxyUrl }));
  } finally {
    clearTimeout(timeout);
    await dispatcher?.close();
  }
}

function localBrowserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (process.platform !== 'win32') return undefined;
  return localBrowserCandidates.find((candidate) => fs.existsSync(candidate));
}

async function fetchDetailInBrowser(url: URL, rule: ReleaseDateRule): Promise<string> {
  await waitForRequestSlot(rule.requestIntervalMs);
  const proxyUrl = getOutboundProxyUrl();
  const executablePath = localBrowserExecutable();
  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    ...(executablePath ? { executablePath } : {}),
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {})
  });
  try {
    const page = await browser.newPage({ userAgent: 'PageWatch/0.1 (+self-hosted webpage monitor)' });
    const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await assertSafeUrl(page.url());
    if (response && !response.ok()) throw new Error(`详情页返回 HTTP ${response.status()}。`);
    await page.locator(rule.valueSelector).first().waitFor({ state: 'attached', timeout: 12_000 }).catch(() => undefined);
    return await page.content();
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) throw new Error(describeError(error, { action: '发行日期详情页浏览器读取', target: url.hostname, proxyUrl }));
    throw new Error(describeError(error, { action: '发行日期详情页浏览器读取', target: url.hostname, proxyUrl }));
  } finally {
    await browser.close();
  }
}

export async function lookupReleaseDate(rawUrl: string, rule: ReleaseDateRule): Promise<ReleaseDateLookupResult> {
  const url = await assertSafeUrl(rawUrl);
  const html = rule.renderMode === 'dynamic' ? await fetchDetailInBrowser(url, rule) : await fetchDetail(url, rule.requestIntervalMs);
  const releaseDate = extractReleaseDate(html, rule);
  return releaseDate
    ? { status: 'found', releaseDate }
    : { status: 'unavailable', reason: `详情页未找到标签“${rule.labelText}”对应的日期值。` };
}

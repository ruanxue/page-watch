import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { chromium, type Browser } from 'playwright';
import { ProxyAgent } from 'undici';
import { assertSafeUrl } from './capture.js';
import { getOutboundProxyUrl } from './db.js';
import { describeError } from './error-details.js';
import type { ReleaseDateRule } from './inspection-rules.js';
import { missavBackupUrl, missavFallbackFailure, shouldTryMissavBackup } from './site-fallback.js';

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

type ReleaseDateExtraction = {
  releaseDate: string | null;
  reason: string;
};

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

function normalizedLabel(value: string) {
  return normalize(value).replace(/[：:]/g, '');
}

function securityChallengeReason(html: string) {
  const $ = cheerio.load(html);
  const title = normalize($('title').first().text());
  const body = normalize($('body').text()).slice(0, 4_000);
  if (/just a moment|attention required|checking your browser|verify you are human|performing security verification/i.test(`${title}\n${body}`)) {
    return '详情页被网站安全验证拦截，未获取到实际内容；请确认代理可访问目标站点后重试。';
  }
  return null;
}

function inspectReleaseDate(html: string, rule: Pick<ReleaseDateRule, 'containerSelector' | 'labelSelector' | 'labelText' | 'valueSelector' | 'valueSource' | 'valueAttribute' | 'valueMatchPattern'>): ReleaseDateExtraction {
  const challengeReason = securityChallengeReason(html);
  if (challengeReason) return { releaseDate: null, reason: challengeReason };

  const $ = cheerio.load(html);
  const containers = $(rule.containerSelector).toArray();
  if (!containers.length) {
    return { releaseDate: null, reason: `详情页未找到字段容器“${rule.containerSelector}”。` };
  }

  const expectedLabel = normalizedLabel(rule.labelText);
  const labelledContainers = containers.filter((element) => normalizedLabel($(element).find(rule.labelSelector).first().text()) === expectedLabel);
  if (!labelledContainers.length) {
    return { releaseDate: null, reason: `字段容器中未找到标签“${rule.labelText}”。` };
  }

  for (const element of labelledContainers) {
    const valueElement = $(element).find(rule.valueSelector).first();
    if (!valueElement.length) continue;
    const value = rule.valueSource === 'attribute' ? valueElement.attr(rule.valueAttribute) ?? '' : valueElement.text();
    const normalizedValue = normalize(value);
    if (!normalizedValue) continue;
    const matched = matchedValue(normalizedValue, rule.valueMatchPattern);
    if (!matched) {
      return { releaseDate: null, reason: `日期值“${normalizedValue.slice(0, 80)}”不符合当前日期匹配规则。` };
    }
    const releaseDate = validDate(matched);
    if (releaseDate) return { releaseDate, reason: '' };
    return { releaseDate: null, reason: `日期值“${matched}”不是有效的 YYYY-MM-DD 日期。` };
  }

  return { releaseDate: null, reason: `标签“${rule.labelText}”中未找到日期节点“${rule.valueSelector}”或可读取的日期值。` };
}

/** Parse a configured labelled detail-page field into a normal YYYY-MM-DD date. */
export function extractReleaseDate(html: string, rule: Pick<ReleaseDateRule, 'containerSelector' | 'labelSelector' | 'labelText' | 'valueSelector' | 'valueSource' | 'valueAttribute' | 'valueMatchPattern'>) {
  return inspectReleaseDate(html, rule).releaseDate;
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
    const html = await response.text();
    if (!response.ok) {
      const challengeReason = securityChallengeReason(html);
      throw new Error(challengeReason ? `${challengeReason}（HTTP ${response.status}）。` : `详情页返回 HTTP ${response.status}。`);
    }
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

export class ReleaseDateBrowserSession {
  private browser: Browser | null = null;
  private proxyUrl: string | null = null;
  private openedAt = 0;
  private pageCount = 0;

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.proxyUrl = null;
    this.pageCount = 0;
    this.openedAt = 0;
    await browser?.close().catch(() => undefined);
  }

  private async ensureBrowser() {
    const proxyUrl = getOutboundProxyUrl() || null;
    const stale = !this.browser || !this.browser.isConnected() || this.proxyUrl !== proxyUrl || this.pageCount >= 25 || Date.now() - this.openedAt >= 15 * 60_000;
    if (!stale) return this.browser!;
    await this.close();
    const executablePath = localBrowserExecutable();
    this.browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      ...(executablePath ? { executablePath } : {}),
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {})
    });
    this.proxyUrl = proxyUrl;
    this.openedAt = Date.now();
    return this.browser;
  }

  async fetch(url: URL, rule: ReleaseDateRule): Promise<string> {
    await waitForRequestSlot(rule.requestIntervalMs);
    const proxyUrl = getOutboundProxyUrl();
    let context: Awaited<ReturnType<Browser['newContext']>> | null = null;
    try {
      const browser = await this.ensureBrowser();
      // An isolated context prevents page cookies, storage and service workers
      // from leaking from one archive entry to another.
      context = await browser.newContext({ userAgent: 'PageWatch/0.1 (+self-hosted webpage monitor)' });
      const page = await context.newPage();
      const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await assertSafeUrl(page.url());
      const initialHtml = response && !response.ok() ? await page.content() : null;
      if (response && !response.ok()) {
        const challengeReason = securityChallengeReason(initialHtml ?? '');
        throw new Error(challengeReason ? `${challengeReason}（HTTP ${response.status()}）。` : `详情页返回 HTTP ${response.status()}。`);
      }
      await page.waitForFunction((config) => {
        const normalizeLabel = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[：:]/g, '');
        const expectedLabel = normalizeLabel(config.labelText);
        return Array.from(document.querySelectorAll(config.containerSelector)).some((container) => {
          const label = container.querySelector(config.labelSelector)?.textContent ?? '';
          if (normalizeLabel(label) !== expectedLabel) return false;
          const valueElement = container.querySelector(config.valueSelector);
          return Boolean(valueElement && (config.valueSource === 'attribute' ? valueElement.getAttribute(config.valueAttribute)?.trim() : valueElement.textContent?.trim()));
        });
      }, { containerSelector: rule.containerSelector, labelSelector: rule.labelSelector, labelText: rule.labelText, valueSelector: rule.valueSelector, valueSource: rule.valueSource, valueAttribute: rule.valueAttribute }, { timeout: 12_000 }).catch(() => undefined);
      this.pageCount += 1;
      return await page.content();
    } catch (error) {
      // A timeout/disconnect must not poison later tasks in the reusable browser.
      await this.close();
      if (error instanceof Error && /timeout/i.test(error.message)) throw new Error(describeError(error, { action: '发行日期详情页浏览器读取', target: url.hostname, proxyUrl }));
      throw new Error(describeError(error, { action: '发行日期详情页浏览器读取', target: url.hostname, proxyUrl }));
    } finally { await context?.close().catch(() => undefined); }
  }
}

async function fetchDetailInBrowser(url: URL, rule: ReleaseDateRule, session?: ReleaseDateBrowserSession): Promise<string> {
  if (session) return session.fetch(url, rule);
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
    const initialHtml = response && !response.ok() ? await page.content() : null;
    if (response && !response.ok()) {
      const challengeReason = securityChallengeReason(initialHtml ?? '');
      throw new Error(challengeReason ? `${challengeReason}（HTTP ${response.status()}）。` : `详情页返回 HTTP ${response.status()}。`);
    }
    await page.waitForFunction((config) => {
      const normalizeLabel = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[：:]/g, '');
      const expectedLabel = normalizeLabel(config.labelText);
      return Array.from(document.querySelectorAll(config.containerSelector)).some((container) => {
        const label = container.querySelector(config.labelSelector)?.textContent ?? '';
        if (normalizeLabel(label) !== expectedLabel) return false;
        const valueElement = container.querySelector(config.valueSelector);
        if (!valueElement) return false;
        return config.valueSource === 'attribute'
          ? Boolean(valueElement.getAttribute(config.valueAttribute)?.trim())
          : Boolean(valueElement.textContent?.trim());
      });
    }, {
      containerSelector: rule.containerSelector,
      labelSelector: rule.labelSelector,
      labelText: rule.labelText,
      valueSelector: rule.valueSelector,
      valueSource: rule.valueSource,
      valueAttribute: rule.valueAttribute
    }, { timeout: 12_000 }).catch(() => undefined);
    return await page.content();
  } catch (error) {
    if (error instanceof Error && /timeout/i.test(error.message)) throw new Error(describeError(error, { action: '发行日期详情页浏览器读取', target: url.hostname, proxyUrl }));
    throw new Error(describeError(error, { action: '发行日期详情页浏览器读取', target: url.hostname, proxyUrl }));
  } finally {
    await browser.close();
  }
}

export async function lookupReleaseDate(rawUrl: string, rule: ReleaseDateRule, session?: ReleaseDateBrowserSession): Promise<ReleaseDateLookupResult> {
  const url = await assertSafeUrl(rawUrl);
  const read = async (target: URL) => {
    const html = rule.renderMode === 'dynamic' ? await fetchDetailInBrowser(target, rule, session) : await fetchDetail(target, rule.requestIntervalMs);
    const result = inspectReleaseDate(html, rule);
    return result.releaseDate ? { status: 'found', releaseDate: result.releaseDate } as const : { status: 'unavailable', reason: result.reason } as const;
  };
  let primaryResult: ReleaseDateLookupResult | null = null;
  let primaryError: unknown = null;
  try { primaryResult = await read(url); }
  catch (error) { primaryError = error; }
  const availabilityFailure = primaryError ?? (primaryResult?.status === 'unavailable' ? new Error(primaryResult.reason) : null);
  if (!availabilityFailure || !shouldTryMissavBackup(availabilityFailure)) {
    if (primaryError) throw primaryError;
    return primaryResult!;
  }
  const backup = missavBackupUrl(url);
  if (!backup) {
    if (primaryError) throw primaryError;
    return primaryResult!;
  }
  try { return await read(await assertSafeUrl(backup.toString())); }
  catch (backupError) { throw missavFallbackFailure(url, backup, availabilityFailure, backupError); }
}

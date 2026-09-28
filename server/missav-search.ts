import type { Page } from 'playwright';
import { browserPool } from './browser-pool.js';
import { assertSafeUrl as validateSafeUrl } from './url-safety.js';
import { getOutboundProxyUrl } from './db.js';
import { missavBackupUrl, missavFallbackFailure, shouldTryMissavBackup } from './site-fallback.js';
import { findMissavFilmCandidate, normalizeProductCode, productCodeKeys, safeMissavDetailUrl, type MissavSearchAnchor } from './code-search-parser.js';

const missavHosts = new Set(['missav123.com', 'www.missav123.com', 'missav.live', 'www.missav.live']);

export type MissavPerformer = { name: string; url: string };
export type MissavSearchResult = { code: string; title: string; detailUrl: string; performers: MissavPerformer[]; performerError: string | null };
export type MissavCodeSearchResponse = { status: 'found'; film: MissavSearchResult } | { status: 'not_found'; code: string };

async function assertMissavUrl(raw: string) {
  const url = await validateSafeUrl(raw, { allowUnresolvedViaProxy: true, hasOutboundProxy: Boolean(getOutboundProxyUrl()) });
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !missavHosts.has(url.hostname.toLowerCase())) throw new Error('只允许访问 MissAV 官方页面。');
  return url;
}

function actressUrl(raw: string, base: URL) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !missavHosts.has(url.hostname.toLowerCase())) return null;
    if (!/^\/(?:dm\d+\/)?cn\/actresses\/[^/]+\/?$/i.test(url.pathname)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

async function readPage<T>(url: URL, work: (page: Page, responseStatus: number | null) => Promise<T>) {
  return browserPool.use('release', async (page) => {
    const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await assertMissavUrl(page.url());
    return work(page, response?.status() ?? null);
  }, 100);
}

function checkPage(title: string, body: string, responseStatus: number | null, label: string) {
  if (/just a moment|attention required|checking your browser|verify you are human|performing security verification|security verification/i.test(`${title}\n${body}`)) {
    throw new Error(`${label}被 MissAV 安全验证拦截，未获取到实际页面内容；请检查代理能否访问 MissAV 后重试。`);
  }
  if (responseStatus !== null && responseStatus >= 400) throw new Error(`${label}返回 HTTP ${responseStatus}。`);
}

async function withMissavFallback<T>(url: URL, read: (target: URL) => Promise<T>) {
  try { return await read(url); }
  catch (error) {
    const backup = missavBackupUrl(url);
    if (!backup || !shouldTryMissavBackup(error)) throw error;
    try { return await read(await assertMissavUrl(backup.toString())); }
    catch (backupError) { throw missavFallbackFailure(url, backup, error, backupError); }
  }
}

function browserLaunchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|Please run `?npx playwright install/i.test(message)) {
    return new Error('本机缺少 Playwright Chromium。Windows 开发环境可运行 `npx playwright install chromium` 后重试；若 Docker 环境也出现此错误，请更新到包含浏览器的项目镜像。');
  }
  return error instanceof Error ? error : new Error(message);
}

async function readSearchPage(url: URL, wantedCode: string) {
  return readPage(url, async (page, responseStatus) => {
    await page.waitForFunction((code) => {
      const normalizedCode = code.toLowerCase().replace('-', '');
      const body = document.body?.innerText ?? '';
      const noResults = /没有找到|未找到|无结果|暂无|no results|not found|no items|nothing found/i.test(body);
      const cards = Array.from(document.querySelectorAll('div.thumbnail.group'));
      return noResults || cards.some((card) => (card.parentElement?.innerText ?? card.textContent ?? '').toLowerCase().replace(/[-_\s]/g, '').includes(normalizedCode));
    }, wantedCode, { timeout: 12_000 }).catch(() => undefined);
    const diagnostic = await page.evaluate(() => ({
      title: document.title,
      body: (document.body?.innerText ?? '').slice(0, 5_000),
      url: location.href,
      resultCards: document.querySelectorAll('div.thumbnail.group').length,
      cardText: Array.from(document.querySelectorAll('div.thumbnail.group')).map((card) => card.parentElement?.innerText ?? card.textContent ?? '').join('\n')
    }));
    checkPage(diagnostic.title, diagnostic.body, responseStatus, 'MissAV 搜索页');
    const anchors = await page.locator('a[href]').evaluateAll((nodes) => nodes.slice(0, 500).map((node) => ({
      href: (node as HTMLAnchorElement).href,
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      alt: node.getAttribute('alt'),
      title: node.getAttribute('title')
    } satisfies MissavSearchAnchor)));
    const baseUrl = diagnostic.url;
    const film = findMissavFilmCandidate(anchors, wantedCode, baseUrl);
    if (film) return film;
    if (productCodeKeys(diagnostic.cardText).includes(wantedCode.toLowerCase())) {
      throw new Error(`MissAV 搜索页出现了 ${wantedCode}，但无法识别对应影片链接；页面结构可能已变化。`);
    }

    // Some site versions redirect a single exact search result straight to its
    // detail page instead of rendering a list card.
    const current = new URL(diagnostic.url);
    const currentDetail = safeMissavDetailUrl(current.toString(), current.toString());
    const currentCode = current.pathname.split('/').at(-1) ?? '';
    const redirected = findMissavFilmCandidate([{ href: current.toString(), text: diagnostic.title, title: currentCode }], wantedCode, diagnostic.url);
    if (currentDetail && redirected) return { ...redirected, detailUrl: currentDetail };
    if (!diagnostic.resultCards && !/没有找到|未找到|无结果|暂无|no results|not found|no items|nothing found/i.test(diagnostic.body)) {
      throw new Error('MissAV 搜索页结构发生变化，未识别到搜索结果卡片。');
    }
    return null;
  });
}

async function readPerformersPage(url: URL): Promise<MissavPerformer[]> {
  return readPage(url, async (page, responseStatus) => {
    await page.waitForSelector('body', { timeout: 8_000 });
    const data = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div.text-secondary'))
        .filter((row) => (row.querySelector('span')?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/[：:]/g, '') === '女优');
      const links = rows.flatMap((row) => Array.from(row.querySelectorAll('a[href]')).map((anchor) => ({ href: (anchor as HTMLAnchorElement).href, name: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim() })));
      return { title: document.title, body: (document.body?.innerText ?? '').slice(0, 5_000), links };
    });
    checkPage(data.title, data.body, responseStatus, '影片详情页');
    const unique = new Map<string, MissavPerformer>();
    for (const link of data.links) {
      const href = actressUrl(link.href, url);
      if (href && !unique.has(href)) unique.set(href, { name: link.name, url: href });
    }
    return [...unique.values()];
  });
}

export async function searchMissavCode(rawCode: string): Promise<MissavCodeSearchResponse> {
  const code = normalizeProductCode(rawCode);
  if (!code) throw new Error('请输入有效番号，例如 MEYD-568 或 meyd568。');
  const searchUrl = new URL(`/cn/search/${encodeURIComponent(code.replace('-', '').toLowerCase())}`, 'https://missav123.com');
  const film = await withMissavFallback(await assertMissavUrl(searchUrl.toString()), read => readSearchPage(read, code)).catch((error) => { throw browserLaunchError(error); });
  if (!film) return { status: 'not_found', code };
  const url = await assertMissavUrl(film.detailUrl);
  let performers: MissavPerformer[] = [];
  let performerError: string | null = null;
  try {
    performers = await withMissavFallback(url, readPerformersPage);
    if (!performers.length) performerError = '影片详情页没有找到“女优”字段或女优链接。';
  } catch (error) {
    performerError = error instanceof Error ? error.message : String(error);
  }
  return { status: 'found', film: { ...film, performers, performerError } };
}

export async function readMissavPerformers(rawDetailUrl: string) {
  const url = await assertMissavUrl(rawDetailUrl);
  return withMissavFallback(url, readPerformersPage).catch((error) => { throw browserLaunchError(error); });
}

export async function readMissavActressName(rawActressUrl: string) {
  const url = await assertMissavUrl(rawActressUrl);
  if (!actressUrl(url.toString(), url)) throw new Error('女优链接格式无效。');
  return withMissavFallback(url, async (target) => readPage(target, async (page, responseStatus) => {
    await page.waitForSelector('h4.text-nord6, h4', { timeout: 12_000 }).catch(() => undefined);
    const data = await page.evaluate(() => ({ title: document.title, body: (document.body?.innerText ?? '').slice(0, 5_000), name: document.querySelector('h4.text-nord6')?.textContent?.trim() || document.querySelector('h4')?.textContent?.trim() || '' }));
    checkPage(data.title, data.body, responseStatus, '女优页面');
    if (!data.name) throw new Error('女优页面没有找到名称标题（h4）。');
    return { name: data.name.replace(/\s+/g, ' ').trim(), profileUrl: target.toString() };
  })).catch((error) => { throw browserLaunchError(error); });
}

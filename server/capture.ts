import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { ProxyAgent } from 'undici';
import { db, getJellyfinSettings, getOutboundProxyUrl, queueLibraryJob, queueMagnetJob, queueReleaseJob, recordPerformanceMetric, scheduleSubscriptionProgressRebuild, type DatabaseClient, type Subscription } from './db.js';
import { browserPool } from './browser-pool.js';
import { describeError } from './error-details.js';
import { expandReleaseUrl, getInspectionRules } from './inspection-rules.js';
import { archiveKey } from './jellyfin-match.js';
import { missavBackupUrl, missavFallbackFailure, shouldTryMissavBackup } from './site-fallback.js';
import { assertSafeUrl as validateSafeUrl } from './url-safety.js';
import { readResponseText } from './bounded-body.js';
import { createContentDiscoveredNotification, enqueueNotification } from './notifications.js';


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

export async function assertSafeUrl(raw: string) {
  return validateSafeUrl(raw, { allowUnresolvedViaProxy: true, hasOutboundProxy: Boolean(getOutboundProxyUrl()) });
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
    const html = await readResponseText(response);
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

async function getDynamic(url: URL, selector: string, contentSource: Subscription['content_source'], attributeName: string | null, matchPattern: string | null, resultMode: Subscription['result_mode'], pageCountSelector?: string | null, pageCountPattern?: string | null, titleSelector?: string | null, titleContentSource: Subscription['title_content_source'] = 'text', titleAttributeName: string | null = null, titleMatchPattern: string | null = null, browserPriority = 0): Promise<CaptureResult> {
  return browserPool.use('capture', async (page) => {
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
  }, browserPriority);
}

export async function closeCaptureBrowser() { await browserPool.close(); }

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function archiveItems(content: string) {
  return [...new Set(content.split('\n').map((item) => item.trim()).filter(Boolean))];
}

async function archiveNewItems(subscription: Subscription, items: CapturedItem[], capturedAt: string, client: DatabaseClient, suppressAutoDownload = false) {
  const rules = getInspectionRules();
  const jellyfin = getJellyfinSettings();
  const currentItems = uniqueItems(items);
  const archivedCount = await client.get<{ count: number }>('SELECT COUNT(*) AS count FROM archive_entries WHERE subscription_id = ?', [subscription.id]);
  const previousItems = new Set(archiveItems(subscription.last_content ?? ''));
  const additions = (archivedCount?.count ?? 0) === 0 ? currentItems : currentItems.filter((item) => !previousItems.has(item.content));
  const insertedItems: CapturedItem[] = [];
  for (const item of additions) {
    const detailUrl = item.detailUrl;
    const releaseUrl = rules.releaseDate.enabled ? expandReleaseUrl(rules.releaseDate.urlTemplate, { detailUrl, subscriptionUrl: subscription.url, content: item.content }) : null;
    const shouldCheckLibraryFirst = rules.magnet.enabled && jellyfin.enabled && jellyfin.libraryIds.length > 0 && jellyfin.skipMagnetWhenAvailable;
    const result = await client.run(`INSERT IGNORE INTO archive_entries
      (subscription_id, content, title, archive_code, content_hash, first_seen_at, detail_url, release_status, magnet_status, auto_download_suppressed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [subscription.id, item.content, item.title, archiveKey(item.content), hash(item.content), capturedAt, detailUrl, releaseUrl ? 'pending' : 'unsearched', rules.magnet.enabled && !shouldCheckLibraryFirst ? 'pending' : 'unsearched', suppressAutoDownload ? 1 : 0, capturedAt]);
    if (result.changes) {
      insertedItems.push(item);
      if (rules.magnet.enabled) {
        if (shouldCheckLibraryFirst) {
          await client.run(`UPDATE archive_entries SET jellyfin_status = 'pending', jellyfin_error = NULL, updated_at = ? WHERE id = ?`, [capturedAt, result.lastInsertRowid]);
          await queueLibraryJob(result.lastInsertRowid, client);
        } else await queueMagnetJob(result.lastInsertRowid, client);
      }
      if (releaseUrl) await queueReleaseJob(result.lastInsertRowid, client);
    }
  }
  for (const item of currentItems) {
    if (item.title) await client.run(`UPDATE archive_entries SET title = ?, updated_at = ?
      WHERE subscription_id = ? AND content_hash = ? AND (title IS NULL OR title <> ?)`, [item.title, capturedAt, subscription.id, hash(item.content), item.title]);
  }
  return insertedItems;
}

async function captureWithFallback<T>(url: URL, read: (target: URL) => Promise<T>) {
  try { return await read(url); }
  catch (error) {
    const backup = missavBackupUrl(url);
    if (!backup || !shouldTryMissavBackup(error)) throw error;
    try { return await read(await assertSafeUrl(backup.toString())); }
    catch (backupError) { throw missavFallbackFailure(url, backup, error, backupError); }
  }
}

export async function previewCapture(input: Pick<Subscription, 'url' | 'selector' | 'render_mode' | 'content_source' | 'attribute_name' | 'match_pattern' | 'title_selector' | 'title_content_source' | 'title_attribute_name' | 'title_match_pattern' | 'result_mode'>) {
  const url = await assertSafeUrl(input.url);
  if (!input.selector.trim()) throw new Error('请填写 CSS 选择器。');
  if (input.content_source === 'attribute' && !input.attribute_name?.trim()) throw new Error('请填写要提取的属性名。');
  return captureWithFallback(url, (target) => input.render_mode === 'dynamic'
    ? getDynamic(target, input.selector, input.content_source, input.attribute_name, input.match_pattern, input.result_mode, undefined, undefined, input.title_selector, input.title_content_source, input.title_attribute_name, input.title_match_pattern, 100)
    : getStatic(target, input.selector, input.content_source, input.attribute_name, input.match_pattern, input.result_mode, undefined, undefined, input.title_selector, input.title_content_source, input.title_attribute_name, input.title_match_pattern));
}

async function capturePage(subscription: Subscription, rawUrl: string, includePageCount = false, browserPriority = 0) {
  const url = await assertSafeUrl(rawUrl);
  return captureWithFallback(url, (target) => subscription.render_mode === 'dynamic'
    ? getDynamic(target, subscription.selector, subscription.content_source, subscription.attribute_name, subscription.match_pattern, subscription.result_mode, includePageCount ? subscription.pagination_selector : null, subscription.pagination_match_pattern, subscription.title_selector, subscription.title_content_source, subscription.title_attribute_name, subscription.title_match_pattern, browserPriority)
    : getStatic(target, subscription.selector, subscription.content_source, subscription.attribute_name, subscription.match_pattern, subscription.result_mode, includePageCount ? subscription.pagination_selector : null, subscription.pagination_match_pattern, subscription.title_selector, subscription.title_content_source, subscription.title_attribute_name, subscription.title_match_pattern));
}

export async function captureSubscription(subscription: Subscription, browserPriority = 0) {
  const isFullScan = Boolean(!subscription.initial_scan_completed && subscription.pagination_selector);
  if (isFullScan) return captureInitialFullScan(subscription, browserPriority);

  let first: CaptureResult;
  try { first = await capturePage(subscription, subscription.url, false, browserPriority); }
  catch (error) { throw new Error(describeError(error, { action: '第 1 页读取', target: new URL(subscription.url).hostname, proxyUrl: getOutboundProxyUrl() }), { cause: error }); }
  const items = uniqueItems(first.items);
  const content = contentForItems(items);
  const result = { ...first, items, content, hash: hash(content) };
  const changed = Boolean(subscription.last_hash && subscription.last_hash !== result.hash);
  const hadBaseline = Boolean(subscription.last_hash);
  const now = new Date().toISOString();
  const stored = await db.transaction(async (tx) => {
    const write = await tx.run(`UPDATE subscriptions
      SET last_checked_at = ?, last_hash = ?, last_content = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND updated_at = ?`, [now, result.hash, result.content, now, subscription.id, subscription.updated_at]);
    const addedItems = write.changes ? await archiveNewItems(subscription, result.items, now, tx, !hadBaseline) : [];
    if (write.changes && hadBaseline && addedItems.length) {
      await enqueueNotification(createContentDiscoveredNotification({ subscription, count: addedItems.length, items: addedItems, occurredAt: now }), tx);
    }
    return { stored: Boolean(write.changes), addedCount: addedItems.length };
  });
  if (stored.addedCount) scheduleSubscriptionProgressRebuild(subscription.id);
  return { ...result, changed, capturedAt: now, ...stored, itemCount: result.items.length, totalPages: 1 };
}

async function stagePage(subscription: Subscription, scanId: string, page: number, items: CapturedItem[]) {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    // Use bounded multi-row inserts: a large pagination page must not turn
    // into hundreds of per-row MySQL round trips or one unbounded statement.
    for (let offset = 0; offset < items.length; offset += 100) {
      const batch = items.slice(offset, offset + 100);
      await tx.run(`INSERT IGNORE INTO initial_scan_items
        (subscription_id, scan_id, page_number, item_position, content, title, detail_url, content_hash, created_at)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      batch.flatMap((item, index) => [subscription.id, scanId, page, offset + index + 1, item.content, item.title, item.detailUrl, hash(item.content), now]));
    }
    await tx.run(`UPDATE subscriptions SET initial_scan_pages_completed = GREATEST(initial_scan_pages_completed, ?), initial_scan_next_page = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND initial_scan_run_id = ?`, [page, page + 1, now, subscription.id, scanId]);
  });
}

async function captureInitialFullScan(subscription: Subscription, browserPriority = 0) {
  let scanId = subscription.initial_scan_run_id;
  let total = subscription.initial_scan_total ?? 0;
  let first: CaptureResult | null = null;
  let nextPage = Math.max(1, subscription.initial_scan_next_page || 1);
  if (!scanId) {
    try { first = await capturePage(subscription, subscription.url, true, browserPriority); }
    catch (error) { throw new Error(describeError(error, { action: '第 1 页读取', target: new URL(subscription.url).hostname, proxyUrl: getOutboundProxyUrl() }), { cause: error }); }
    scanId = crypto.randomUUID();
    total = first.pageCount ?? 1;
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [subscription.id]);
      await tx.run(`UPDATE subscriptions SET initial_scan_run_id = ?, initial_scan_total = ?, initial_scan_pages_completed = 0, initial_scan_next_page = 1, last_error = NULL, updated_at = ? WHERE id = ?`, [scanId, total, now, subscription.id]);
    });
    await stagePage(subscription, scanId, 1, first.items);
    nextPage = 2;
  }
  for (let page = nextPage; page <= total; page += 1) {
    const url = new URL(subscription.url);
    url.searchParams.set(subscription.pagination_parameter || 'page', String(page));
    let result: CaptureResult;
    try { result = await capturePage(subscription, url.toString(), false, browserPriority); }
    catch (error) { throw new Error(describeError(error, { action: `第 ${page}/${total} 页读取`, target: url.hostname, proxyUrl: getOutboundProxyUrl() }), { cause: error }); }
    await stagePage(subscription, scanId, page, result.items);
  }
  const now = new Date().toISOString();
  let cursor = 0;
  let itemCount = 0;
  let content = '';
  const contentHash = crypto.createHash('sha256');
  let addedCount = 0;
  const addedItems: CapturedItem[] = [];
  let stored = false;
  await db.transaction(async (tx) => {
    // Keep the staged archive invisible until all pages have arrived and this
    // one transaction commits, while only retaining one 200-row slice in RAM.
    while (true) {
      const batch = await tx.all<{ id: number; content: string; title: string | null; detail_url: string | null }>(`SELECT id, content, title, detail_url FROM initial_scan_items
        WHERE subscription_id = ? AND scan_id = ? AND id > ? ORDER BY page_number ASC, item_position ASC, id ASC LIMIT 200`, [subscription.id, scanId, cursor]);
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;
      const items = batch.map((item) => ({ content: item.content, title: item.title, detailUrl: item.detail_url }));
      for (const item of items) {
        if (content) { content += '\n'; contentHash.update('\n'); }
        content += item.content;
        contentHash.update(item.content);
      }
      itemCount += items.length;
    }
    const contentDigest = contentHash.digest('hex');
    const write = await tx.run(`UPDATE subscriptions SET last_checked_at = ?, last_hash = ?, last_content = ?, last_error = NULL,
      initial_scan_completed = 1, initial_scan_total = ?, initial_scan_pages_completed = ?, initial_scan_run_id = NULL, initial_scan_next_page = 1, updated_at = ?
      WHERE id = ? AND initial_scan_run_id = ?`, [now, contentDigest, content, total, total, now, subscription.id, scanId]);
    stored = Boolean(write.changes);
    if (!stored) return;
    // A second bounded cursor pass keeps the write conditional on the
    // optimistic subscription update, matching the prior all-or-nothing
    // semantics without retaining every staged row in memory.
    cursor = 0;
    while (true) {
      const batch = await tx.all<{ id: number; content: string; title: string | null; detail_url: string | null }>(`SELECT id, content, title, detail_url FROM initial_scan_items
        WHERE subscription_id = ? AND scan_id = ? AND id > ? ORDER BY page_number ASC, item_position ASC, id ASC LIMIT 200`, [subscription.id, scanId, cursor]);
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;
      const inserted = await archiveNewItems(subscription, batch.map((item) => ({ content: item.content, title: item.title, detailUrl: item.detail_url })), now, tx, !subscription.last_hash);
      addedCount += inserted.length;
      if (addedItems.length < 5) addedItems.push(...inserted.slice(0, 5 - addedItems.length));
    }
    if (subscription.last_hash && addedCount) {
      await enqueueNotification(createContentDiscoveredNotification({ subscription, count: addedCount, items: addedItems, occurredAt: now }), tx);
    }
    await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ? AND scan_id = ?', [subscription.id, scanId]);
  });
  if (stored && addedCount) scheduleSubscriptionProgressRebuild(subscription.id);
  const result = { title: first?.title ?? subscription.name, content, hash: hash(content), pageCount: total };
  const changed = Boolean(subscription.last_hash && subscription.last_hash !== result.hash);
  return { ...result, changed, capturedAt: now, stored, addedCount: stored ? addedCount : 0, itemCount, totalPages: total };
}

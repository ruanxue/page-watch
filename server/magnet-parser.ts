import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { MagnetRule } from './inspection-rules.js';

function fallbackFilenamePrefixes(rule: MagnetRule) {
  const primary = rule.filenamePrefix.trim().toLowerCase();
  return [...new Set(rule.fallbackFilenamePrefixes
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .filter((prefix) => prefix.toLowerCase() !== primary))];
}

/** Decode Cloudflare's client-side email-protection payload in raw search HTML. */
export function decodeCloudflareEmail(encoded: string) {
  const value = encoded.trim();
  if (!/^[\da-f]+$/i.test(value) || value.length < 4 || value.length % 2 !== 0) return null;
  const key = Number.parseInt(value.slice(0, 2), 16);
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 2; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (!Number.isInteger(byte)) return null;
    bytes[(index - 2) / 2] = byte ^ key;
  }
  try { return new TextDecoder().decode(bytes); }
  catch { return null; }
}

/**
 * Return the matching detail path. The primary prefix must start the filename;
 * only when no primary result exists on the whole page do ordered fallback
 * markers become eligible.
 */
export function findMagnetDetailPath(html: string, origin: string, rule: MagnetRule) {
  const $ = cheerio.load(html);
  const items = $(rule.itemSelector).toArray();
  const filenameFor = (element: AnyNode) => {
    const filename = $(element).find(rule.filenameSelector).first().clone();
    filename.find('a.__cf_email__[data-cfemail]').each((_, protectedLink) => {
      const decoded = decodeCloudflareEmail($(protectedLink).attr('data-cfemail') ?? '');
      if (decoded) $(protectedLink).text(decoded);
    });
    return filename.text().trim().toLowerCase();
  };
  const primaryPrefix = rule.filenamePrefix.trim().toLowerCase();
  const primary = items.find((element) => filenameFor(element).startsWith(primaryPrefix));
  const fallback = primary ? undefined : fallbackFilenamePrefixes(rule)
    .map((prefix) => prefix.toLowerCase())
    .map((prefix) => items.find((element) => filenameFor(element).includes(prefix)))
    .find((item): item is AnyNode => Boolean(item));
  const item = primary ?? fallback;
  if (!item) return null;
  const href = $(item).find(rule.detailLinkSelector).first().attr('href')?.trim();
  if (!href) throw new Error('搜索结果缺少详情链接，无法解析。');
  const detail = new URL(href, origin);
  if (detail.origin !== new URL(origin).origin || !detail.pathname.startsWith(rule.detailPathPrefix)) {
    throw new Error('搜索结果详情链接格式无效。');
  }
  return `${detail.pathname}${detail.search}`;
}

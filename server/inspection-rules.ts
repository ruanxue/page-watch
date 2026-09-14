import { getSetting } from './db.js';

export type ValueSource = 'text' | 'attribute';

export type ReleaseDateRule = {
  enabled: boolean;
  urlTemplate: string;
  renderMode: 'static' | 'dynamic';
  containerSelector: string;
  labelSelector: string;
  labelText: string;
  valueSelector: string;
  valueSource: ValueSource;
  valueAttribute: string;
  valueMatchPattern: string;
  requestIntervalMs: number;
};

export type MagnetRule = {
  enabled: boolean;
  origins: string[];
  searchUrlTemplate: string;
  itemSelector: string;
  filenameSelector: string;
  filenamePrefix: string;
  fallbackFilenamePrefixes: string[];
  detailLinkSelector: string;
  detailPathPrefix: string;
  valueSelector: string;
  valueSource: ValueSource;
  valueAttribute: string;
  valueMatchPattern: string;
  requestIntervalMs: number;
};

export type InspectionRules = {
  releaseDate: ReleaseDateRule;
  magnet: MagnetRule;
};

export const defaultInspectionRules: InspectionRules = {
  releaseDate: {
    enabled: true,
    // The list-page link is stored with every archive item, so this default is
    // not tied to any particular website or URL convention.
    urlTemplate: '{{detailUrl}}',
    renderMode: 'dynamic',
    containerSelector: 'div.text-secondary',
    labelSelector: 'span',
    labelText: '发行日期',
    valueSelector: 'time',
    valueSource: 'attribute',
    valueAttribute: 'datetime',
    // `datetime` values use an ISO suffix (for example `2026-08-28T00:00:00+08:00`).
    // Do not put a word boundary after the day: `8T` has no word boundary.
    valueMatchPattern: '\\b(?:19\\d{2}|20\\d{2})-\\d{2}-\\d{2}(?!\\d)',
    requestIntervalMs: 800
  },
  magnet: {
    enabled: true,
    origins: ['https://cilisousuo.co', 'https://cilisousuo.cc', 'https://cilisousuo.net'],
    searchUrlTemplate: '{{origin}}/search?q={{content}}',
    itemSelector: 'li.item',
    filenameSelector: '.filename',
    filenamePrefix: 'hhd800.com@',
    fallbackFilenamePrefixes: ['4k688.com@'],
    detailLinkSelector: 'a.link',
    detailPathPrefix: '/magnet/',
    valueSelector: 'input#input-magnet',
    valueSource: 'attribute',
    valueAttribute: 'value',
    valueMatchPattern: '^magnet:\\?',
    requestIntervalMs: 800
  }
};

const legacyReleaseDatePatterns = new Set([
  '\\b(19\\d{2}|20\\d{2})-(\\d{2})-(\\d{2})\\b',
  '\\b(?:19\\d{2}|20\\d{2})-\\d{2}-\\d{2}\\b'
]);

function cloneDefaults(): InspectionRules {
  return JSON.parse(JSON.stringify(defaultInspectionRules)) as InspectionRules;
}

function nonEmptyString(value: unknown, fallback: string, max = 1_500) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : fallback;
}

function source(value: unknown, fallback: ValueSource): ValueSource {
  return value === 'attribute' || value === 'text' ? value : fallback;
}

function boolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function requestGap(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 250 && number <= 60_000 ? number : fallback;
}

function origins(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const parsed = value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 8);
  return parsed.length ? parsed : fallback;
}

function filenameMarkers(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** Returns a safe, complete config even when a database value was written by an older release. */
export function coerceInspectionRules(value: unknown): InspectionRules {
  const defaults = cloneDefaults();
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const release = data.releaseDate && typeof data.releaseDate === 'object' ? data.releaseDate as Record<string, unknown> : {};
  const magnet = data.magnet && typeof data.magnet === 'object' ? data.magnet as Record<string, unknown> : {};
  return {
    releaseDate: {
      enabled: boolean(release.enabled, defaults.releaseDate.enabled),
      urlTemplate: nonEmptyString(release.urlTemplate, defaults.releaseDate.urlTemplate),
      renderMode: release.renderMode === 'static' ? 'static' : release.renderMode === 'dynamic' ? 'dynamic' : defaults.releaseDate.renderMode,
      containerSelector: nonEmptyString(release.containerSelector, defaults.releaseDate.containerSelector),
      labelSelector: nonEmptyString(release.labelSelector, defaults.releaseDate.labelSelector),
      labelText: nonEmptyString(release.labelText, defaults.releaseDate.labelText, 160),
      valueSelector: nonEmptyString(release.valueSelector, defaults.releaseDate.valueSelector),
      valueSource: source(release.valueSource, defaults.releaseDate.valueSource),
      valueAttribute: nonEmptyString(release.valueAttribute, defaults.releaseDate.valueAttribute, 128),
      valueMatchPattern: legacyReleaseDatePatterns.has(String(release.valueMatchPattern ?? ''))
        ? defaults.releaseDate.valueMatchPattern
        : nonEmptyString(release.valueMatchPattern, defaults.releaseDate.valueMatchPattern, 480),
      requestIntervalMs: requestGap(release.requestIntervalMs, defaults.releaseDate.requestIntervalMs)
    },
    magnet: {
      enabled: boolean(magnet.enabled, defaults.magnet.enabled),
      origins: origins(magnet.origins, defaults.magnet.origins),
      searchUrlTemplate: nonEmptyString(magnet.searchUrlTemplate, defaults.magnet.searchUrlTemplate),
      itemSelector: nonEmptyString(magnet.itemSelector, defaults.magnet.itemSelector),
      filenameSelector: nonEmptyString(magnet.filenameSelector, defaults.magnet.filenameSelector),
      filenamePrefix: nonEmptyString(magnet.filenamePrefix, defaults.magnet.filenamePrefix, 240),
      fallbackFilenamePrefixes: filenameMarkers(magnet.fallbackFilenamePrefixes, defaults.magnet.fallbackFilenamePrefixes),
      detailLinkSelector: nonEmptyString(magnet.detailLinkSelector, defaults.magnet.detailLinkSelector),
      detailPathPrefix: nonEmptyString(magnet.detailPathPrefix, defaults.magnet.detailPathPrefix, 240),
      valueSelector: nonEmptyString(magnet.valueSelector, defaults.magnet.valueSelector),
      valueSource: source(magnet.valueSource, defaults.magnet.valueSource),
      valueAttribute: nonEmptyString(magnet.valueAttribute, defaults.magnet.valueAttribute, 128),
      valueMatchPattern: nonEmptyString(magnet.valueMatchPattern, defaults.magnet.valueMatchPattern, 480),
      requestIntervalMs: requestGap(magnet.requestIntervalMs, defaults.magnet.requestIntervalMs)
    }
  };
}

export function getInspectionRules() {
  const raw = getSetting('inspection_rules');
  if (!raw) return cloneDefaults();
  try { return coerceInspectionRules(JSON.parse(raw)); }
  catch { return cloneDefaults(); }
}

function validateRegex(value: string, label: string) {
  try { new RegExp(value, 'i'); }
  catch { throw new Error(`${label}不是有效的正则表达式。`); }
}

function validateUrlTemplate(value: string, label: string, allowedTokens: string[]) {
  if (!value.includes('{{')) return void new URL(value);
  for (const token of value.match(/{{[^}]+}}/g) ?? []) {
    if (!allowedTokens.includes(token)) throw new Error(`${label}包含不支持的变量 ${token}。`);
  }
}

/** Validate user input before it becomes a worker rule. */
export function normalizeInspectionRules(payload: unknown): InspectionRules {
  const rules = coerceInspectionRules(payload);
  const release = rules.releaseDate;
  const magnet = rules.magnet;
  if (release.enabled) {
    validateUrlTemplate(release.urlTemplate, '详情页地址模板', ['{{detailUrl}}', '{{baseUrl}}', '{{content}}']);
    validateRegex(release.valueMatchPattern, '发行日期匹配规则');
  }
  if (magnet.enabled) {
    if (!magnet.origins.length) throw new Error('请至少填写一个磁力检索节点。');
    for (const origin of magnet.origins) {
      let url: URL;
      try { url = new URL(origin); } catch { throw new Error(`磁力检索节点地址无效：${origin}`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error(`磁力检索节点必须是纯 http(s) 站点地址：${origin}`);
    }
    validateUrlTemplate(magnet.searchUrlTemplate, '搜索地址模板', ['{{origin}}', '{{content}}']);
    if (!magnet.searchUrlTemplate.includes('{{origin}}') || !magnet.searchUrlTemplate.includes('{{content}}')) throw new Error('搜索地址模板必须同时包含 {{origin}} 和 {{content}}。');
    if (!magnet.detailPathPrefix.startsWith('/')) throw new Error('详情链接路径前缀必须以 / 开头。');
    validateRegex(magnet.valueMatchPattern, '磁力链接匹配规则');
  }
  return rules;
}

export type RuleUrlContext = { detailUrl: string | null; subscriptionUrl: string; content: string };

/** Expand only documented variables; {{content}} is URL encoded for both paths and queries. */
export function expandReleaseUrl(template: string, context: RuleUrlContext) {
  const baseUrl = new URL(context.subscriptionUrl).origin;
  const detailUrl = context.detailUrl?.trim() ?? '';
  const expanded = template
    .replaceAll('{{detailUrl}}', detailUrl)
    .replaceAll('{{baseUrl}}', baseUrl)
    .replaceAll('{{content}}', encodeURIComponent(context.content.trim()));
  return expanded.trim() || null;
}

export function inspectionRulesJson(rules: InspectionRules) {
  return JSON.stringify(rules);
}

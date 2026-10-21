import { db, getOutboundProxyUrl, type DatabaseClient, type Subscription } from './db.js';
import { defaultInspectionRules, getInspectionRules } from './inspection-rules.js';
import { assertSafeUrl as validateSafeUrl } from './url-safety.js';
import { parseSitesJson } from './rule-groups.js';

/**
 * 订阅载荷的规范化：把前端提交的松散字段收成可入库的确定值，并在 MissAV
 * 规则族下换成规则组里的读取方式。
 *
 * 订阅路由与规则组校验都要用这些函数，因此独立成模块，避免两边互相引用。
 * 这里只做校验与整形，不写库（唯一例外是读取规则组时的只读查询）。
 */

/** 订阅地址的安全校验：禁止本机与内网，允许交给代理解析。 */
export async function assertSafeUrl(raw: string) {
  return validateSafeUrl(raw, { allowUnresolvedViaProxy: true, hasOutboundProxy: Boolean(getOutboundProxyUrl()) });
}

export type SubscriptionPayload = {
  name: string;
  ruleFamily?: 'missav' | 'legacy_custom';
  presetId?: number | null;
  renderModeOverride?: 'static' | 'dynamic' | null;
  url: string;
  selector: string;
  renderMode?: 'static' | 'dynamic';
  contentSource?: 'text' | 'attribute';
  attributeName?: string;
  matchPattern?: string;
  titleSelector?: string;
  titleContentSource?: 'text' | 'attribute';
  titleAttributeName?: string;
  titleMatchPattern?: string;
  resultMode?: 'first' | 'all';
  intervalMinutes?: number;
  scheduleType?: 'hourly' | 'daily' | 'weekly';
  scheduleIntervalHours?: number;
  scheduleTime?: string;
  scheduleWeekday?: number;
  isActive?: boolean;
  paginationSelector?: string;
  paginationParameter?: string;
  paginationMatchPattern?: string;
};

export type SubscriptionPresetPayload = Omit<SubscriptionPayload, 'url'> & { description?: string };
/** 列表读取规则的一次提交：带已有 id 的更新，没有 id 的新建。 */
type PresetListRow = SubscriptionPresetPayload & { id?: number | null };
export type MissavRulesPayload = { presetId?: number; preset?: SubscriptionPresetPayload; presets?: PresetListRow[]; sites?: unknown; inspectionRules?: unknown };
export type MissavPresetListPayload = { presets?: PresetListRow[]; sites?: unknown; inspectionRules?: unknown };
export function normalizePaginationPayload(payload: Pick<SubscriptionPayload, 'paginationSelector' | 'paginationParameter' | 'paginationMatchPattern'>) {
  const selector = payload.paginationSelector?.trim() || null;
  const parameter = payload.paginationParameter?.trim() || 'page';
  const matchPattern = selector ? payload.paginationMatchPattern?.trim() || null : null;
  if (parameter.length > 64 || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(parameter)) throw new Error('分页参数名格式无效。');
  if (matchPattern && matchPattern.length > 480) throw new Error('分页页数匹配规则不能超过 480 个字符。');
  if (matchPattern) {
    try { new RegExp(matchPattern, 'i'); } catch { throw new Error('分页页数匹配规则不是有效的正则表达式。'); }
  }
  return { paginationSelector: selector, paginationParameter: parameter, paginationMatchPattern: matchPattern };
}

/** 一次保存整组列表读取规则：已存在的更新，没有 id 的新建，未提交的删除。 */
export function normalizePresetPayload(payload: SubscriptionPresetPayload) {
  const name = payload.name?.trim();
  const description = payload.description?.trim() ?? '';
  const selector = payload.selector?.trim();
  const interval = Number(payload.intervalMinutes ?? 60);
  const renderMode = payload.renderMode === 'dynamic' ? 'dynamic' : 'static';
  const contentSource = payload.contentSource === 'attribute' ? 'attribute' : 'text';
  const attributeName = payload.attributeName?.trim() || null;
  const matchPattern = payload.matchPattern?.trim() || null;
  const titleSelector = payload.titleSelector?.trim() || null;
  const titleContentSource = payload.titleContentSource === 'attribute' ? 'attribute' : 'text';
  const titleAttributeName = titleSelector ? payload.titleAttributeName?.trim() || null : null;
  const titleMatchPattern = titleSelector ? payload.titleMatchPattern?.trim() || null : null;
  const resultMode = payload.resultMode === 'all' ? 'all' : 'first';
  const pagination = normalizePaginationPayload(payload);
  if (!name || name.length > 80) throw new Error('请填写不超过 80 个字符的规则名称。');
  if (description.length > 200) throw new Error('规则说明不能超过 200 个字符。');
  if (!selector) throw new Error('请填写 CSS 选择器。');
  if (contentSource === 'attribute' && !attributeName) throw new Error('请填写要提取的属性名。');
  if (attributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(attributeName)) throw new Error('属性名格式无效。');
  if (matchPattern && matchPattern.length > 240) throw new Error('内容匹配规则不能超过 240 个字符。');
  if (matchPattern) {
    try { new RegExp(matchPattern, 'i'); } catch { throw new Error('内容匹配规则不是有效的正则表达式。'); }
  }
  if (titleSelector && titleContentSource === 'attribute' && !titleAttributeName) throw new Error('请填写标题要提取的属性名。');
  if (titleAttributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(titleAttributeName)) throw new Error('标题属性名格式无效。');
  if (titleMatchPattern && titleMatchPattern.length > 240) throw new Error('标题匹配规则不能超过 240 个字符。');
  if (titleMatchPattern) {
    try { new RegExp(titleMatchPattern, 'i'); } catch { throw new Error('标题匹配规则不是有效的正则表达式。'); }
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 10080) throw new Error('检查间隔需在 1 到 10080 分钟之间。');
  return { name, description, selector, renderMode, contentSource, attributeName, matchPattern, titleSelector, titleContentSource, titleAttributeName, titleMatchPattern, resultMode, interval, ...pagination, isActive: payload.isActive === false ? 0 : 1 };
}

/**
 * 规则组改动后，把读取列复制到跟随它的订阅上。
 *
 * 订阅行保存的是读取配置的副本（Worker 只读订阅），所以改完规则组必须同步一次，
 * 否则页面上的修改要等订阅重新保存才生效。presetId 为空时同步全部 missav 订阅，
 * 供兼容接口沿用原有的整体保存行为。
 */

export async function updatePresetList(tx: Pick<DatabaseClient, 'run' | 'get'>, rows: PresetListRow[], now: string) {
  const keptIds: number[] = [];
  for (const row of rows) {
    const values = normalizePresetPayload(row as unknown as SubscriptionPresetPayload);
    const id = Number(row.id);
    if (Number.isInteger(id) && id > 0) {
      if (!await tx.get('SELECT id FROM subscription_presets WHERE id=?', [id])) throw new Error('读取规则已被删除，请刷新页面后重试。');
      await tx.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, is_active=?, updated_at=? WHERE id=?`,
        [values.name, values.description, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.isActive, now, id]);
      keptIds.push(id); continue;
    }
    const inserted = await tx.run(`INSERT INTO subscription_presets (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.name, values.description, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.isActive, now, now]);
    keptIds.push(inserted.lastInsertRowid);
  }
  if (keptIds.length) await tx.run(`DELETE FROM subscription_presets WHERE id NOT IN (${keptIds.map(() => '?').join(', ')})`, keptIds);
  else await tx.run('DELETE FROM subscription_presets');
  return keptIds;
}

export async function resolveMissavPayload(payload: SubscriptionPayload): Promise<{ values: Awaited<ReturnType<typeof normalizePayload>>; family: 'missav' | 'legacy_custom'; presetId: number | null; override: 'static' | 'dynamic' | null }> {
  if (payload.ruleFamily !== 'missav') return { values: await normalizePayload(payload), family: 'legacy_custom', presetId: null, override: null };
  const host = new URL((await assertSafeUrl(payload.url)).toString()).hostname.toLowerCase();
  const presetId = Number(payload.presetId);
  const preset = await db.get<Subscription & { sites_json?: string | null }>(`SELECT * FROM subscription_presets WHERE id=?`, [presetId]);
  if (!preset) throw new Error('请选择有效的检查规则组。');
  // 只有规则组自己声明了站点时才限制主机名；站点为空表示任意网站都可以用这组规则。
  const groupSites = parseSitesJson(preset.sites_json);
  if (groupSites.length) {
    const allowedHosts = groupSites.map((site) => { try { return new URL(site).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean);
    if (!allowedHosts.includes(host)) throw new Error(`这组检查规则只适用于已声明的站点：${groupSites.join('、')}。`);
  }
  const override = payload.renderModeOverride === 'static' || payload.renderModeOverride === 'dynamic' ? payload.renderModeOverride : null;
  // 匹配规则允许订阅级覆盖：规则组里留空表示「不下发」，此时沿用本次提交的值，
  // 否则每次保存订阅都会把用户写好的屏蔽正则清空。
  const matchPattern = preset.match_pattern?.trim() ? preset.match_pattern : (payload.matchPattern ?? '');
  const titleMatchPattern = preset.title_match_pattern?.trim() ? preset.title_match_pattern : (payload.titleMatchPattern ?? '');
  const values = await normalizePayload({ ...payload, selector: preset.selector, renderMode: override ?? preset.render_mode, contentSource: preset.content_source, attributeName: preset.attribute_name ?? '', matchPattern, titleSelector: preset.title_selector ?? '', titleContentSource: preset.title_content_source, titleAttributeName: preset.title_attribute_name ?? '', titleMatchPattern, resultMode: preset.result_mode, paginationSelector: preset.pagination_selector ?? '', paginationParameter: preset.pagination_parameter, paginationMatchPattern: preset.pagination_match_pattern ?? '' });
  return { values, family: 'missav', presetId, override };
}


export async function normalizePayload(payload: SubscriptionPayload) {
  const name = payload.name?.trim();
  const selector = payload.selector?.trim();
  const interval = Number(payload.intervalMinutes ?? 60);
  const scheduleType = payload.scheduleType === 'daily' || payload.scheduleType === 'weekly' ? payload.scheduleType : 'hourly';
  const scheduleIntervalHours = Number(payload.scheduleIntervalHours ?? Math.max(1, Math.round(interval / 60)));
  const scheduleTime = payload.scheduleTime ?? '09:00';
  const scheduleWeekday = Number(payload.scheduleWeekday ?? 1);
  const renderMode = payload.renderMode === 'dynamic' ? 'dynamic' : 'static';
  const contentSource = payload.contentSource === 'attribute' ? 'attribute' : 'text';
  const attributeName = payload.attributeName?.trim() || null;
  const matchPattern = payload.matchPattern?.trim() || null;
  const titleSelector = payload.titleSelector?.trim() || null;
  const titleContentSource = payload.titleContentSource === 'attribute' ? 'attribute' : 'text';
  const titleAttributeName = titleSelector ? payload.titleAttributeName?.trim() || null : null;
  const titleMatchPattern = titleSelector ? payload.titleMatchPattern?.trim() || null : null;
  const resultMode = payload.resultMode === 'all' ? 'all' : 'first';
  const pagination = normalizePaginationPayload(payload);
  if (!name) throw new Error('请填写订阅名称。');
  if (!selector) throw new Error('请先选择检查规则。');
  if (contentSource === 'attribute' && !attributeName) throw new Error('请填写要提取的属性名。');
  if (attributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(attributeName)) throw new Error('属性名格式无效。');
  if (matchPattern && matchPattern.length > 240) throw new Error('内容匹配规则不能超过 240 个字符。');
  if (matchPattern) {
    try { new RegExp(matchPattern, 'i'); } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`内容匹配规则不是有效的正则表达式：${detail}`);
    }
  }
  if (titleSelector && titleContentSource === 'attribute' && !titleAttributeName) throw new Error('请填写标题要提取的属性名。');
  if (titleAttributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(titleAttributeName)) throw new Error('标题属性名格式无效。');
  if (titleMatchPattern && titleMatchPattern.length > 240) throw new Error('标题匹配规则不能超过 240 个字符。');
  if (titleMatchPattern) {
    try { new RegExp(titleMatchPattern, 'i'); } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`标题匹配规则不是有效的正则表达式：${detail}`);
    }
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 10080) throw new Error('检查间隔需在 1 到 10080 分钟之间。');
  if (!Number.isInteger(scheduleIntervalHours) || scheduleIntervalHours < 1 || scheduleIntervalHours > 168) throw new Error('按小时检查需设置为 1 到 168 小时。');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new Error('检查时间需使用 HH:MM 格式。');
  if (!Number.isInteger(scheduleWeekday) || scheduleWeekday < 0 || scheduleWeekday > 6) throw new Error('请选择有效的每周检查日期。');
  const url = (await assertSafeUrl(payload.url)).toString();
  return { name, url, selector, interval: scheduleType === 'hourly' ? scheduleIntervalHours * 60 : 1440, scheduleType, scheduleIntervalHours, scheduleTime, scheduleWeekday, renderMode, contentSource, attributeName, matchPattern, titleSelector, titleContentSource, titleAttributeName, titleMatchPattern, resultMode, ...pagination, isActive: payload.isActive === false ? 0 : 1 };
}

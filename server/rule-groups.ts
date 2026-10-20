/**
 * 「检查规则组」的数据模型、归一化与校验。
 *
 * 原先整个项目只有一份 MissAV 共用规则，站点、选择器、分页等全部写死。重构后
 * 每一组规则自带「适用站点」与「补充步骤」，因此同一套执行逻辑可以服务任意网站：
 *
 * - 站点为空表示不限站点；执行层会把空站点当成「直接读取订阅原地址」。
 * - 补充步骤本次只保存配置，其中内置的发行日期、磁力链接仍由现有 Worker 执行。
 *
 * 本模块刻意不依赖数据库，既方便单元测试，也让 API 进程、抓取进程复用同一套
 * 归一化规则。
 */

/** 补充步骤读取哪一类页面。 */
export type StepSource = 'detail' | 'search';

/** 步骤取值的两种方式：标签文字或属性值。 */
export type StepValueMode = 'text' | 'attribute';

/** 内置步骤的种类：发行日期与磁力链接。 */
export type BuiltinStepKind = 'release' | 'magnet';

/** 一组规则里的一个补充步骤。 */
export type SupplementStep = {
  /** 稳定标识；内置步骤固定为 builtin-release / builtin-magnet。 */
  id: string;
  name: string;
  source: StepSource;
  selector: string;
  valueMode: StepValueMode;
  attribute: string;
  matchPattern: string;
  requestIntervalMs: number;
  enabled: boolean;
  /** 只有内置步骤带这个标记；自定义步骤永远没有。 */
  builtin?: BuiltinStepKind;
};

/** 一组规则的列表读取方式（原 subscription_presets 的读取列）。 */
export type RuleGroupReading = {
  selector: string;
  renderMode: 'static' | 'dynamic';
  contentSource: StepValueMode;
  attributeName: string;
  matchPattern: string;
  titleSelector: string;
  titleContentSource: StepValueMode;
  titleAttributeName: string;
  titleMatchPattern: string;
  resultMode: 'first' | 'all';
  intervalMinutes: number;
  paginationSelector: string;
  paginationParameter: string;
  paginationMatchPattern: string;
};

/** 界面上的「一组检查规则」。 */
export type RuleGroup = {
  /** 已保存的规则组有 id；新建草稿为 null。 */
  id: number | null;
  name: string;
  description: string;
  /** 适用站点；空数组表示不限站点。 */
  sites: string[];
  steps: SupplementStep[];
  reading: RuleGroupReading;
};

export const MAX_RULE_GROUP_NAME_LENGTH = 60;
export const MAX_RULE_GROUP_DESCRIPTION_LENGTH = 200;
export const MAX_SUPPLEMENT_STEPS = 5;
export const MAX_RULE_GROUP_SITES = 5;
export const SUPPLEMENT_INTERVAL_MIN_MS = 250;
export const SUPPLEMENT_INTERVAL_MAX_MS = 60_000;

/** 内置规则组的默认名称；迁移时也会把旧的 MissAV 预设改成这个名字。 */
export const BUILTIN_GROUP_NAME = 'MissAV 默认规则组';

/** 内置步骤的固定标识，界面据此禁止删除。 */
export const BUILTIN_RELEASE_STEP_ID = 'builtin-release';
export const BUILTIN_MAGNET_STEP_ID = 'builtin-magnet';

const LEGACY_MISSAAV_GROUP_NAME = 'MissAV 番号列表';

/** 新建规则组时的读取方式默认值：字段齐全但选择器为空，需要使用者自己填写。 */
export const defaultRuleGroupReading: RuleGroupReading = {
  selector: '',
  renderMode: 'static',
  contentSource: 'text',
  attributeName: '',
  matchPattern: '',
  titleSelector: '',
  titleContentSource: 'text',
  titleAttributeName: '',
  titleMatchPattern: '',
  resultMode: 'first',
  intervalMinutes: 60,
  paginationSelector: '',
  paginationParameter: 'page',
  paginationMatchPattern: ''
};

function text(value: unknown, max = 1_500) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

function interval(value: unknown, fallback = 800) {
  const number = Number(value);
  return Number.isInteger(number) && number >= SUPPLEMENT_INTERVAL_MIN_MS && number <= SUPPLEMENT_INTERVAL_MAX_MS
    ? number
    : fallback;
}

function valueMode(value: unknown, fallback: StepValueMode): StepValueMode {
  return value === 'attribute' || value === 'text' ? value : fallback;
}

function stepSource(value: unknown): StepSource {
  return value === 'search' ? 'search' : 'detail';
}

function builtinKind(value: unknown): BuiltinStepKind | undefined {
  return value === 'release' || value === 'magnet' ? value : undefined;
}

/** 内置步骤的初始配置：字段名与现有 Worker 使用的选择器保持一致。 */
export function builtinSupplementSteps(): SupplementStep[] {
  return [
    {
      id: BUILTIN_RELEASE_STEP_ID,
      name: '发行日期',
      source: 'detail',
      selector: 'time',
      valueMode: 'attribute',
      attribute: 'datetime',
      matchPattern: '\\b(?:19\\d{2}|20\\d{2})-\\d{2}-\\d{2}(?!\\d)',
      requestIntervalMs: 800,
      enabled: true,
      builtin: 'release'
    },
    {
      id: BUILTIN_MAGNET_STEP_ID,
      name: '磁力链接',
      source: 'search',
      selector: 'input#input-magnet',
      valueMode: 'attribute',
      attribute: 'value',
      matchPattern: '^magnet:\\?',
      requestIntervalMs: 800,
      enabled: true,
      builtin: 'magnet'
    }
  ];
}

/** 单个补充步骤归一化；缺字段用安全默认值补齐，绝不返回 undefined 字段。 */
export function coerceSupplementStep(value: unknown, index: number): SupplementStep {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = text(data.name, 120) || `步骤 ${index + 1}`;
  const builtin = builtinKind(data.builtin);
  const id = text(data.id, 120) || (builtin ? `builtin-${builtin}` : `step-${index + 1}`);
  return {
    id,
    name,
    source: stepSource(data.source),
    selector: text(data.selector),
    valueMode: valueMode(data.valueMode, 'text'),
    attribute: text(data.attribute, 128),
    matchPattern: text(data.matchPattern, 480),
    requestIntervalMs: interval(data.requestIntervalMs),
    enabled: data.enabled === undefined ? true : data.enabled !== false,
    ...(builtin ? { builtin } : {})
  };
}

/** 步骤数组归一化：保持提交顺序，不做数量截断（超限交给校验报错）。 */
export function coerceSupplementSteps(value: unknown): SupplementStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => coerceSupplementStep(entry, index));
}

function regexIssue(pattern: string) {
  if (!pattern) return null;
  try { new RegExp(pattern); return null; }
  catch { return '不是有效的正则表达式。'; }
}

/**
 * 逐项收集补充步骤的问题，键是下标字符串。数量超限时用 `steps` 作为键，
 * 这样页面能把错误挂在正确的位置上。
 */
export function collectSupplementStepIssues(steps: SupplementStep[]): Record<string, string> {
  const issues: Record<string, string> = {};
  if (steps.length > MAX_SUPPLEMENT_STEPS) {
    issues.steps = `补充步骤最多 ${MAX_SUPPLEMENT_STEPS} 个，当前有 ${steps.length} 个。`;
  }
  steps.forEach((step, index) => {
    if (!step.selector.trim()) issues[String(index)] = `第 ${index + 1} 步请填写 CSS 选择器。`;
    else {
      const issue = regexIssue(step.matchPattern);
      if (issue) issues[String(index)] = `第 ${index + 1} 步的匹配规则${issue}`;
    }
  });
  return issues;
}

/** 校验补充步骤；失败时抛出第一条中文原因，便于旧接口复用。 */
export function validateSupplementSteps(steps: SupplementStep[]) {
  const issues = collectSupplementStepIssues(steps);
  const first = Object.values(issues)[0];
  if (first) throw new Error(first);
}

/** 读取方式的问题清单，键与界面字段同名。 */
export function collectReadingIssues(reading: RuleGroupReading): Record<string, string> {
  const issues: Record<string, string> = {};
  if (!reading.selector.trim()) issues.selector = '请填写列表内容的 CSS 选择器。';
  const matchIssue = regexIssue(reading.matchPattern);
  if (matchIssue) issues.matchPattern = `内容匹配规则${matchIssue}`;
  const titleIssue = regexIssue(reading.titleMatchPattern);
  if (titleIssue) issues.titleMatchPattern = `标题匹配规则${titleIssue}`;
  const paginationIssue = regexIssue(reading.paginationMatchPattern);
  if (paginationIssue) issues.paginationMatchPattern = `页数匹配规则${paginationIssue}`;
  if (reading.paginationParameter.length > 64) issues.paginationParameter = '分页参数名不能超过 64 个字符。';
  else if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(reading.paginationParameter)) {
    issues.paginationParameter = '分页参数名需以字母开头，只能包含字母、数字、下划线和点。';
  }
  if (!Number.isInteger(reading.intervalMinutes) || reading.intervalMinutes < 1 || reading.intervalMinutes > 10_080) {
    issues.intervalMinutes = '检查间隔需在 1 到 10080 分钟之间。';
  }
  if (reading.contentSource === 'attribute' && !reading.attributeName.trim()) issues.attributeName = '选择「指定属性的值」时需要填写属性名。';
  if (reading.attributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(reading.attributeName)) issues.attributeName = '属性名格式无效。';
  if (reading.titleSelector.trim() && reading.titleContentSource === 'attribute' && !reading.titleAttributeName.trim()) {
    issues.titleAttributeName = '标题选择「指定属性的值」时需要填写属性名。';
  }
  if (reading.titleAttributeName && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(reading.titleAttributeName)) {
    issues.titleAttributeName = '标题属性名格式无效。';
  }
  return issues;
}

/** 校验规则组名称；返回去掉首尾空格后的名称。 */
export function normalizeRuleGroupName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error('请填写规则组名称。');
  if (name.length > MAX_RULE_GROUP_NAME_LENGTH) throw new Error(`规则组名称不能超过 ${MAX_RULE_GROUP_NAME_LENGTH} 个字符。`);
  return name;
}

/** 说明可以为空，但超长必须报错而不是静默截断。 */
export function normalizeRuleGroupDescription(value: unknown): string {
  const description = typeof value === 'string' ? value.trim() : '';
  if (description.length > MAX_RULE_GROUP_DESCRIPTION_LENGTH) {
    throw new Error(`规则组说明不能超过 ${MAX_RULE_GROUP_DESCRIPTION_LENGTH} 个字符。`);
  }
  return description;
}

/** 站点只保留协议与域名，与 site-list 的既有约定一致。 */
export function normalizeRuleGroupSite(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/**
 * 适用站点归一化：允许为空（表示不限站点），非法地址直接报错而不是静默丢弃，
 * 避免用户以为已经生效。
 */
export function normalizeRuleGroupSites(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('适用站点格式无效，请提交站点地址数组。');
  const sites: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const site = normalizeRuleGroupSite(entry);
    if (!site) throw new Error(`适用站点地址无效：${entry}`);
    if (!sites.includes(site)) sites.push(site);
  }
  if (sites.length > MAX_RULE_GROUP_SITES) throw new Error(`每组规则最多 ${MAX_RULE_GROUP_SITES} 个适用站点。`);
  return sites;
}

/** 读取方式归一化：所有字段都有确定的值，避免前端拿到 null。 */
export function coerceRuleGroupReading(value: unknown): RuleGroupReading {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const intervalValue = Number(data.intervalMinutes ?? defaultRuleGroupReading.intervalMinutes);
  return {
    selector: text(data.selector) || defaultRuleGroupReading.selector,
    renderMode: data.renderMode === 'dynamic' ? 'dynamic' : 'static',
    contentSource: valueMode(data.contentSource, defaultRuleGroupReading.contentSource),
    attributeName: text(data.attributeName, 128),
    matchPattern: text(data.matchPattern, 480),
    titleSelector: text(data.titleSelector),
    titleContentSource: valueMode(data.titleContentSource, defaultRuleGroupReading.titleContentSource),
    titleAttributeName: text(data.titleAttributeName, 128),
    titleMatchPattern: text(data.titleMatchPattern, 480),
    resultMode: data.resultMode === 'all' ? 'all' : 'first',
    intervalMinutes: Number.isInteger(intervalValue) && intervalValue >= 1 && intervalValue <= 10_080
      ? intervalValue
      : defaultRuleGroupReading.intervalMinutes,
    paginationSelector: text(data.paginationSelector),
    paginationParameter: text(data.paginationParameter, 64) || 'page',
    paginationMatchPattern: text(data.paginationMatchPattern, 480)
  };
}

/** 整组归一化：名字、说明、站点、步骤、读取方式。 */
export function coerceRuleGroup(value: unknown): RuleGroup {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const idValue = Number(data.id);
  return {
    id: Number.isInteger(idValue) && idValue > 0 ? idValue : null,
    name: typeof data.name === 'string' ? data.name.trim() : '',
    description: typeof data.description === 'string' ? data.description.trim() : '',
    sites: normalizeRuleGroupSites(data.sites),
    steps: coerceSupplementSteps(data.steps),
    reading: coerceRuleGroupReading(data.reading)
  };
}

/** 一组规则是否内置（含内置步骤）。内置组禁止删除。 */
export function isBuiltinGroup(group: Pick<RuleGroup, 'steps'>): boolean {
  return group.steps.some((step) => Boolean(step.builtin));
}

/** 内置步骤的种类集合，用于迁移与保存时比对。 */
export function builtinStepKinds(steps: SupplementStep[]): BuiltinStepKind[] {
  return steps.flatMap((step) => (step.builtin ? [step.builtin] : []));
}

/**
 * 保存步骤时的内置保护：已存在的内置步骤不能被删除，自定义步骤也不能冒充内置。
 * 同时保证改名、调整顺序后的内置步骤仍然带 builtin 标记。
 */
export function applyBuiltinStepFlags(existing: SupplementStep[], incoming: SupplementStep[]): SupplementStep[] {
  const kinds = new Set(builtinStepKinds(existing));
  return incoming.map((step) => {
    const kind = step.builtin && kinds.has(step.builtin) ? step.builtin : undefined;
    if (kind) return { ...step, builtin: kind };
    const { builtin: _dropped, ...rest } = step;
    return rest;
  });
}

/** 找出被删除的内置步骤。 */
export function removedBuiltinSteps(existing: SupplementStep[], incoming: SupplementStep[]): SupplementStep[] {
  const incomingKinds = new Set(builtinStepKinds(incoming));
  return existing.filter((step) => step.builtin && !incomingKinds.has(step.builtin));
}

/**
 * 站点 JSON 解析：数据库里可能是 NULL、旧版本留下的非法 JSON，统一回落到空数组。
 * 空数组表示不限站点，绝不能回落成默认站点，否则「不限站点」会被悄悄改掉。
 */
export function parseSitesJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sites: string[] = [];
    for (const entry of parsed) {
      const site = normalizeRuleGroupSite(entry);
      if (site && !sites.includes(site)) sites.push(site);
    }
    return sites;
  } catch { return []; }
}

/** 步骤 JSON 解析：损坏数据只丢掉出错的部分，不影响整组规则可用。 */
export function parseStepsJson(raw: unknown): SupplementStep[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return coerceSupplementSteps(Array.isArray(parsed) ? parsed.slice(0, MAX_SUPPLEMENT_STEPS * 2) : []);
  } catch { return []; }
}

export function serializeSitesJson(sites: string[]): string {
  return JSON.stringify(normalizeRuleGroupSites(sites));
}

export function serializeStepsJson(steps: SupplementStep[]): string {
  return JSON.stringify(coerceSupplementSteps(steps));
}

/** 兼容旧名称：迁移会把旧预设改名，这里两个名字都认。 */
export const legacyMissavGroupName = LEGACY_MISSAAV_GROUP_NAME;

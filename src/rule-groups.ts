/**
 * 「检查规则组」的前端模型：类型、默认值，以及提交前的本地校验。
 *
 * 与 server/rule-groups.ts 保持同一套语义：
 * - sites 为空表示不限站点，绝不能自动补默认站点；
 * - 名称必填、最长 60 字；
 * - 补充步骤最多 5 个，每步必须填写选择器；
 * - 所有正则都必须能被 new RegExp() 构造。
 *
 * 校验函数返回「原因文本」而不是布尔值，页面才能把不可保存的原因常显出来，
 * 避免按钮静默禁用。
 */

export type StepSource = 'detail' | 'search';
export type StepValueMode = 'text' | 'attribute';
export type BuiltinStepKind = 'release' | 'magnet';

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
  builtin?: BuiltinStepKind;
};

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

export type RuleGroup = {
  id: number | null;
  name: string;
  description: string;
  sites: string[];
  steps: SupplementStep[];
  reading: RuleGroupReading;
};

export const MAX_RULE_GROUP_NAME_LENGTH = 60;
export const MAX_RULE_GROUP_DESCRIPTION_LENGTH = 200;
export const MAX_SUPPLEMENT_STEPS = 5;
export const MAX_RULE_GROUP_SITES = 5;

/** 新建规则组的读取方式默认值：字段齐全但选择器为空，必须由使用者填写。 */
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

/** 新建一组空白规则；站点与步骤都从空开始。 */
export function blankRuleGroup(): RuleGroup {
  return {
    id: null,
    name: '',
    description: '',
    sites: [],
    steps: [],
    reading: { ...defaultRuleGroupReading }
  };
}

let nextLocalStepId = 1;

/** 新建自定义步骤：字段齐全，方便直接填写。 */
export function newSupplementStep(): SupplementStep {
  const id = `custom-${Date.now().toString(36)}-${nextLocalStepId++}`;
  return {
    id,
    name: '自定义步骤',
    source: 'detail',
    selector: '',
    valueMode: 'text',
    attribute: '',
    matchPattern: '',
    requestIntervalMs: 800,
    enabled: true
  };
}

/** 站点地址只保留协议与域名，和保存端的处理一致。 */
export function normalizeSiteValue(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function regexIssue(pattern: string): string | null {
  if (!pattern.trim()) return null;
  try { new RegExp(pattern); return null; }
  catch { return '不是有效的正则表达式。'; }
}

/** 适用站点的问题：允许 0 个；填写了非法地址才报错。 */
export function siteIssues(sites: string[]): Record<string, string> {
  const issues: Record<string, string> = {};
  let valid = 0;
  sites.forEach((site, index) => {
    if (!site.trim()) return;
    if (!normalizeSiteValue(site)) issues[String(index)] = '请填写完整地址，例如 https://example.com';
    else valid += 1;
  });
  if (valid > MAX_RULE_GROUP_SITES) issues.sites = `每组规则最多 ${MAX_RULE_GROUP_SITES} 个适用站点。`;
  return issues;
}

/** 读取方式的问题清单，键与界面字段同名。 */
export function readingIssues(reading: RuleGroupReading): Record<string, string> {
  const issues: Record<string, string> = {};
  if (!reading.selector.trim()) issues.selector = '请填写列表内容的 CSS 选择器。';
  const matchIssue = regexIssue(reading.matchPattern);
  if (matchIssue) issues.matchPattern = `内容匹配规则${matchIssue}`;
  const titleIssue = regexIssue(reading.titleMatchPattern);
  if (titleIssue) issues.titleMatchPattern = `标题匹配规则${titleIssue}`;
  const paginationIssue = regexIssue(reading.paginationMatchPattern);
  if (paginationIssue) issues.paginationMatchPattern = `页数匹配规则${paginationIssue}`;
  if (!reading.paginationParameter.trim()) issues.paginationParameter = '请填写分页参数名，例如 page。';
  else if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(reading.paginationParameter) || reading.paginationParameter.length > 64) {
    issues.paginationParameter = '分页参数名需以字母开头，只能包含字母、数字、下划线和点。';
  }
  if (!Number.isInteger(reading.intervalMinutes) || reading.intervalMinutes < 1 || reading.intervalMinutes > 10_080) {
    issues.intervalMinutes = '检查间隔需在 1 到 10080 分钟之间。';
  }
  if (reading.contentSource === 'attribute' && !reading.attributeName.trim()) issues.attributeName = '选择「指定属性的值」时需要填写属性名。';
  else if (reading.attributeName.trim() && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(reading.attributeName.trim())) issues.attributeName = '属性名格式无效。';
  if (reading.titleSelector.trim() && reading.titleContentSource === 'attribute' && !reading.titleAttributeName.trim()) {
    issues.titleAttributeName = '标题选择「指定属性的值」时需要填写属性名。';
  } else if (reading.titleAttributeName.trim() && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(reading.titleAttributeName.trim())) {
    issues.titleAttributeName = '标题属性名格式无效。';
  }
  return issues;
}

/** 补充步骤的问题清单；数量超限用 steps 作为键。 */
export function supplementStepIssues(steps: SupplementStep[]): Record<string, string> {
  const issues: Record<string, string> = {};
  if (steps.length > MAX_SUPPLEMENT_STEPS) issues.steps = `补充步骤最多 ${MAX_SUPPLEMENT_STEPS} 个，当前有 ${steps.length} 个。`;
  steps.forEach((step, index) => {
    if (!step.selector.trim()) issues[String(index)] = '请填写 CSS 选择器。';
    else {
      const issue = regexIssue(step.matchPattern);
      if (issue) issues[String(index)] = `匹配规则${issue}`;
    }
  });
  return issues;
}

/** 取问题清单里的第一条原因，用于按钮旁的常显提示。 */
export function firstIssue(issues: Record<string, string>): string {
  return Object.values(issues)[0] ?? '';
}

/** 组名与说明的问题（属于「读取方式」这一段一起保存）。 */
export function groupMetaIssues(group: Pick<RuleGroup, 'name' | 'description'>): Record<string, string> {
  const issues: Record<string, string> = {};
  const name = group.name.trim();
  if (!name) issues.name = '请填写规则组名称。';
  else if (name.length > MAX_RULE_GROUP_NAME_LENGTH) issues.name = `规则组名称不能超过 ${MAX_RULE_GROUP_NAME_LENGTH} 个字符。`;
  if (group.description.trim().length > MAX_RULE_GROUP_DESCRIPTION_LENGTH) {
    issues.description = `规则组说明不能超过 ${MAX_RULE_GROUP_DESCRIPTION_LENGTH} 个字符。`;
  }
  return issues;
}

/** 一组规则的摘要：列表里显示「几个站点 / 什么读取方式 / 几步」。 */
export function ruleGroupSummary(group: RuleGroup): string {
  const mode = group.reading.renderMode === 'dynamic' ? '浏览器渲染' : '网页直接读取';
  const sites = group.sites.length ? `${group.sites.length} 个站点` : '不限站点';
  return `${sites} · ${mode} · ${group.steps.length} 个补充步骤`;
}

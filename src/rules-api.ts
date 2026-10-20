/**
 * 「检查规则组」页面的接口封装。
 *
 * 三段配置各有独立接口，互不牵连：读取方式（PATCH）、适用站点（PUT sites）、
 * 补充步骤（PUT steps）。任何一段失败都只影响自己，页面据此分别提示原因。
 */

import type { RuleGroup, RuleGroupReading, SupplementStep } from './rule-groups.js';

export type RuleGroupList = {
  groups: RuleGroup[];
  /** 内置规则组的 id，禁止删除。 */
  builtinIds: number[];
};

/** 带逐字段错误的接口异常：步骤保存失败时 fields 会带上每一步的原因。 */
export class RulesApiError extends Error {
  fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'RulesApiError';
    this.fields = fields;
  }
}

async function call<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: unknown; fields?: unknown };
    const fields = data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)
      ? Object.fromEntries(Object.entries(data.fields as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      : {};
    throw new RulesApiError(typeof data.error === 'string' && data.error.trim() ? data.error : '请求失败，请稍后再试。', fields);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

/** 读取全部规则组与内置组 id。 */
export async function fetchRuleGroups(): Promise<RuleGroupList> {
  const data = await call<{ groups?: RuleGroup[]; builtinIds?: number[] }>('/api/rule-groups');
  return {
    groups: Array.isArray(data.groups) ? data.groups : [],
    builtinIds: Array.isArray(data.builtinIds) ? data.builtinIds.filter((id) => Number.isInteger(id)) : []
  };
}

/** 新建规则组：名称与读取方式必填，站点可为空（不限站点）。 */
export async function createRuleGroup(input: {
  name: string;
  description: string;
  sites: string[];
  steps: SupplementStep[];
  reading: RuleGroupReading;
}): Promise<RuleGroup> {
  const data = await call<{ group: RuleGroup }>('/api/rule-groups', { method: 'POST', body: JSON.stringify(input) });
  return data.group;
}

/** 保存名称、说明与读取方式；不触碰适用站点与补充步骤。 */
export async function updateRuleGroup(id: number, input: {
  name: string;
  description: string;
  reading: RuleGroupReading;
}): Promise<RuleGroup> {
  const data = await call<{ group: RuleGroup }>(`/api/rule-groups/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  return data.group;
}

/** 删除规则组；内置组会被服务端拒绝。 */
export async function deleteRuleGroup(id: number): Promise<void> {
  await call<{ ok: boolean }>(`/api/rule-groups/${id}`, { method: 'DELETE' });
}

/** 保存适用站点；传空数组表示不限站点。 */
export async function saveRuleGroupSites(id: number, sites: string[]): Promise<RuleGroup> {
  const data = await call<{ group: RuleGroup; sites: string[] }>(`/api/rule-groups/${id}/sites`, {
    method: 'PUT',
    body: JSON.stringify({ sites })
  });
  return data.group;
}

/** 保存补充步骤（0~5 步）；内置步骤缺失时服务端会返回 fields.steps。 */
export async function saveRuleGroupSteps(id: number, steps: SupplementStep[]): Promise<RuleGroup> {
  const data = await call<{ group: RuleGroup }>(`/api/rule-groups/${id}/steps`, {
    method: 'PUT',
    body: JSON.stringify({ steps })
  });
  return data.group;
}

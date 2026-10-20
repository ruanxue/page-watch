import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBuiltinStepFlags,
  BUILTIN_MAGNET_STEP_ID,
  BUILTIN_RELEASE_STEP_ID,
  builtinSupplementSteps,
  coerceRuleGroupReading,
  coerceSupplementSteps,
  collectReadingIssues,
  collectSupplementStepIssues,
  isBuiltinGroup,
  MAX_RULE_GROUP_NAME_LENGTH,
  MAX_SUPPLEMENT_STEPS,
  normalizeRuleGroupName,
  normalizeRuleGroupSites,
  parseSitesJson,
  parseStepsJson,
  removedBuiltinSteps,
  serializeSitesJson,
  type SupplementStep
} from './rule-groups.js';

/**
 * 检查规则组是「任意网站都能配自己的读取方式」的基础：站点可以留空，名称必须
 * 填，步骤最多五个，正则必须能执行，内置步骤只能停用不能删除。
 */

function step(overrides: Partial<SupplementStep> = {}): SupplementStep {
  return {
    id: 'step-1',
    name: '自定义步骤',
    source: 'detail',
    selector: 'div.value',
    valueMode: 'text',
    attribute: '',
    matchPattern: '',
    requestIntervalMs: 800,
    enabled: true,
    ...overrides
  };
}

test('适用站点允许为空，空数组表示不限站点', () => {
  assert.deepEqual(normalizeRuleGroupSites([]), []);
  assert.deepEqual(normalizeRuleGroupSites(null), []);
  // 空站点不能在解析阶段被悄悄换成默认站点，否则「不限站点」会被改写。
  assert.deepEqual(parseSitesJson(null), []);
  assert.deepEqual(parseSitesJson('[]'), []);
  assert.equal(serializeSitesJson([]), '[]');
});

test('适用站点只保留协议与域名，并对非法地址报错', () => {
  assert.deepEqual(
    normalizeRuleGroupSites(['https://example.com/path', 'https://example.com', 'http://second.example:8080']),
    ['https://example.com', 'http://second.example:8080']);
  assert.throws(() => normalizeRuleGroupSites(['example.com']), /适用站点地址无效/);
});

test('规则组名称必填且不超过 60 个字符', () => {
  assert.throws(() => normalizeRuleGroupName(''), /请填写规则组名称/);
  assert.throws(() => normalizeRuleGroupName('   '), /请填写规则组名称/);
  assert.equal(normalizeRuleGroupName('  商品价格监控  '), '商品价格监控');
  assert.throws(() => normalizeRuleGroupName('组'.repeat(MAX_RULE_GROUP_NAME_LENGTH + 1)), /不能超过/);
});

test('补充步骤最多五个，超过时整段被拒绝', () => {
  const steps = Array.from({ length: MAX_SUPPLEMENT_STEPS + 1 }, (_, index) => step({ id: `step-${index}`, selector: 'div.value' }));
  const issues = collectSupplementStepIssues(steps);
  assert.ok(issues.steps, '超过上限时要给出整段错误');
  assert.match(issues.steps, /最多 5 个/);
});

test('每步必须填写选择器', () => {
  const issues = collectSupplementStepIssues([step(), step({ id: 'step-2', selector: '   ' })]);
  assert.equal(issues['1'], '第 2 步请填写 CSS 选择器。');
  assert.equal(issues['0'], undefined);
});

test('非法的匹配正则会被拒绝', () => {
  const issues = collectSupplementStepIssues([step({ matchPattern: '([' })]);
  assert.match(issues['0'], /不是有效的正则表达式/);
  const reading = collectReadingIssues(coerceRuleGroupReading({ selector: 'a', matchPattern: '([' }));
  assert.match(reading.matchPattern, /不是有效的正则表达式/);
});

test('内置步骤不能删除，但可以改名、停用与调整顺序', () => {
  const existing = builtinSupplementSteps();
  assert.deepEqual(existing.map((entry) => entry.id), [BUILTIN_RELEASE_STEP_ID, BUILTIN_MAGNET_STEP_ID]);
  assert.equal(isBuiltinGroup({ steps: existing }), true);

  // 删掉磁力链接这一步必须被识别出来。
  const withoutMagnet = existing.filter((entry) => entry.builtin !== 'magnet');
  const removed = removedBuiltinSteps(existing, withoutMagnet);
  assert.deepEqual(removed.map((entry) => entry.builtin), ['magnet']);

  // 改名、停用、换顺序都算合法修改。
  const renamed = [
    { ...existing[1], name: '磁力（停用）', enabled: false },
    { ...existing[0], name: '发行日期（自定义名称）' }
  ];
  assert.deepEqual(removedBuiltinSteps(existing, renamed), []);
});

test('普通规则组不能凭空创建内置步骤', () => {
  // 只有已经拥有内置步骤的规则组才能保留 builtin 标记，普通规则组提交的同名字段会被忽略。
  const flags = applyBuiltinStepFlags([], [
    step({ id: 'fake', builtin: 'release' } as Partial<SupplementStep>)
  ]);
  assert.equal(flags[0].builtin, undefined);
  assert.equal(isBuiltinGroup({ steps: flags }), false);
});

test('补充步骤 JSON 损坏时回落到空数组，不影响整组规则', () => {
  assert.deepEqual(parseStepsJson(null), []);
  assert.deepEqual(parseStepsJson('不是 JSON'), []);
  const steps = coerceSupplementSteps([{ selector: 'time' }]);
  assert.equal(steps[0].selector, 'time');
  assert.equal(steps[0].requestIntervalMs, 800);
  assert.equal(steps[0].enabled, true);
});

/**
 * 「检查规则组」页面。
 *
 * 一段配置一个保存按钮，三段互不影响：
 *   1. 读取方式（名称、说明、选择器、正则、标题、分页、间隔）；
 *   2. 适用站点（可以为空，空 = 不限站点）；
 *   3. 补充步骤（0~5 个，内置步骤只能停用不能删除）。
 *
 * 每个保存按钮旁边都会常显「为什么现在不能保存」，不使用静默禁用。
 */

import { useEffect, useRef, useState } from 'react';
import {
  blankRuleGroup,
  firstIssue,
  groupMetaIssues,
  MAX_RULE_GROUP_DESCRIPTION_LENGTH,
  MAX_RULE_GROUP_NAME_LENGTH,
  MAX_RULE_GROUP_SITES,
  MAX_SUPPLEMENT_STEPS,
  newSupplementStep,
  readingIssues,
  ruleGroupSummary,
  siteIssues,
  supplementStepIssues,
  type RuleGroup,
  type RuleGroupReading,
  type SupplementStep
} from './rule-groups.js';
import {
  createRuleGroup,
  deleteRuleGroup,
  fetchRuleGroups,
  saveRuleGroupSites,
  saveRuleGroupSteps,
  updateRuleGroup
} from './rules-api.js';

type Segment = 'reading' | 'sites' | 'steps';

type RulesPageProps = {
  onNotice: (message: string) => void;
};

/** 规则组是纯数据对象，草稿与基线各自独立，避免互相引用。 */
function cloneGroup(group: RuleGroup): RuleGroup {
  return JSON.parse(JSON.stringify(group)) as RuleGroup;
}

function errorText(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message.trim() ? reason.message.trim() : fallback;
}

type TextFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  wide?: boolean;
  maxLength?: number;
  type?: 'text' | 'url' | 'number';
  min?: number;
  max?: number;
  inputMode?: 'text' | 'url' | 'numeric';
};

/** 统一的输入框：标签、说明与错误都挂在一起，窄屏自动单列。 */
function TextField({ label, value, onChange, placeholder, hint, error, wide, maxLength, type = 'text', min, max, inputMode }: TextFieldProps) {
  return <label className={`rule-group-field${wide ? ' rule-group-field-wide' : ''}`}>
    <span>{label}</span>
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      min={min}
      max={max}
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
    />
    {hint && <small className="rule-group-hint">{hint}</small>}
    {error && <small className="rule-group-error" role="alert">{error}</small>}
  </label>;
}

type SelectFieldProps = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
};

function SelectField({ label, value, options, onChange, hint, error }: SelectFieldProps) {
  return <label className="rule-group-field">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {hint && <small className="rule-group-hint">{hint}</small>}
    {error && <small className="rule-group-error" role="alert">{error}</small>}
  </label>;
}

/** 一段配置的保存区：不可保存的原因常显，保存失败的原因也留在这一段里。 */
function SegmentFooter({ blocked, dirty, busy, idleLabel, savingLabel, error, onSave }: {
  blocked: string;
  dirty: boolean;
  busy: boolean;
  idleLabel: string;
  savingLabel: string;
  error: string;
  onSave: () => void;
}) {
  return <footer className="rule-group-save">
    {blocked
      ? <p className="rule-group-block" role="alert">{blocked}</p>
      : dirty
        ? <p className="rule-group-unsaved">有未保存的修改</p>
        : <p className="rule-group-saved">这一段已保存，没有未保存的修改。</p>}
    {error && <p className="rule-group-save-error" role="alert">{error}</p>}
    <button type="button" className="primary" disabled={busy || !dirty || Boolean(blocked)} onClick={onSave}>
      {busy ? savingLabel : idleLabel}
    </button>
  </footer>;
}

export default function RulesPage({ onNotice }: RulesPageProps) {
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [builtinIds, setBuiltinIds] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<RuleGroup | null>(null);
  const [baseline, setBaseline] = useState<RuleGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [saving, setSaving] = useState<Segment | ''>('');
  const [segmentErrors, setSegmentErrors] = useState<Record<Segment, string>>({ reading: '', sites: '', steps: '' });
  /**
   * 切换到别的规则组时，把当前组的草稿暂存在这里：切回来还能接着改，不会因为
   * 一次切换就丢掉未保存的内容。只保存内存中的草稿，不写库、不做持久化。
   */
  const stashedDrafts = useRef<Record<number, { draft: RuleGroup; baseline: RuleGroup }>>({});

  /** 载入列表并选中指定规则组（默认第一组）。 */
  const loadGroups = async (preferId?: number | 'new' | null) => {
    const data = await fetchRuleGroups();
    // 刷新/删除后以服务端为准，之前暂存的草稿一律作废。
    stashedDrafts.current = {};
    setGroups(data.groups);
    setBuiltinIds(data.builtinIds);
    const target = preferId === 'new'
      ? null
      : data.groups.find((group) => group.id === preferId) ?? data.groups[0] ?? null;
    if (preferId === 'new') {
      setSelected('new');
      setDraft(blankRuleGroup());
      setBaseline(null);
      return;
    }
    setSelected(target?.id ?? null);
    setDraft(target ? cloneGroup(target) : null);
    setBaseline(target ? cloneGroup(target) : null);
  };

  useEffect(() => {
    void loadGroups()
      .catch((reason) => setPageError(errorText(reason, '无法读取检查规则组。')))
      .finally(() => setLoading(false));
    // 只在首次挂载时读取一次，后续刷新由按钮与保存动作触发。
  }, []);

  const isNew = draft !== null && draft.id === null;
  const metaIssues = draft ? groupMetaIssues(draft) : {};
  const readingFieldIssues = draft ? readingIssues(draft.reading) : {};
  const sitesFieldIssues = draft ? siteIssues(draft.sites) : {};
  const stepsFieldIssues = draft ? supplementStepIssues(draft.steps) : {};
  const readingBlocked = firstIssue({ ...metaIssues, ...readingFieldIssues });
  const sitesBlocked = firstIssue(sitesFieldIssues);
  const stepsBlocked = firstIssue(stepsFieldIssues);

  const readingDirty = Boolean(draft) && (baseline === null
    || draft!.name !== baseline.name
    || draft!.description !== baseline.description
    || JSON.stringify(draft!.reading) !== JSON.stringify(baseline.reading));
  const sitesDirty = Boolean(draft) && (baseline === null
    ? draft!.sites.length > 0
    : JSON.stringify(draft!.sites) !== JSON.stringify(baseline.sites));
  const stepsDirty = Boolean(draft) && (baseline === null
    ? draft!.steps.length > 0
    : JSON.stringify(draft!.steps) !== JSON.stringify(baseline.steps));
  const anyDirty = readingDirty || sitesDirty || stepsDirty;

  const updateDraft = (patch: Partial<RuleGroup>) => setDraft((old) => (old ? { ...old, ...patch } : old));
  const updateReading = <K extends keyof RuleGroupReading>(key: K, value: RuleGroupReading[K]) => {
    setDraft((old) => (old ? { ...old, reading: { ...old.reading, [key]: value } } : old));
  };
  const updateStep = <K extends keyof SupplementStep>(index: number, key: K, value: SupplementStep[K]) => {
    setDraft((old) => (old ? { ...old, steps: old.steps.map((step, position) => (position === index ? { ...step, [key]: value } : step)) } : old));
  };

  const clearSegmentError = (segment: Segment) => setSegmentErrors((old) => ({ ...old, [segment]: '' }));

  /** 离开当前组前暂存草稿；没有未保存修改时清掉旧暂存，避免切回来看到过期草稿。 */
  const stashCurrentDraft = () => {
    const current = draft;
    if (!current || current.id === null) return;
    if (anyDirty && baseline) {
      stashedDrafts.current[current.id] = { draft: cloneGroup(current), baseline: cloneGroup(baseline) };
    } else {
      delete stashedDrafts.current[current.id];
    }
  };

  const selectGroup = (group: RuleGroup) => {
    if (draft !== null && group.id === draft.id) return;
    stashCurrentDraft();
    const stored = group.id !== null ? stashedDrafts.current[group.id] : undefined;
    setSelected(group.id);
    setDraft(stored ? cloneGroup(stored.draft) : cloneGroup(group));
    setBaseline(stored ? cloneGroup(stored.baseline) : cloneGroup(group));
    setSegmentErrors({ reading: '', sites: '', steps: '' });
  };

  const startNew = () => {
    stashCurrentDraft();
    setSelected('new');
    setDraft(blankRuleGroup());
    setBaseline(null);
    setSegmentErrors({ reading: '', sites: '', steps: '' });
  };

  /** 第 1 段：新建或保存名称、说明与读取方式。 */
  const saveReading = async () => {
    if (!draft || saving || readingBlocked) return;
    setSaving('reading');
    clearSegmentError('reading');
    try {
      if (draft.id === null) {
        const created = await createRuleGroup({
          name: draft.name.trim(),
          description: draft.description.trim(),
          sites: draft.sites,
          steps: draft.steps,
          reading: draft.reading
        });
        setGroups((old) => [...old, created]);
        setSelected(created.id);
        setDraft(cloneGroup(created));
        setBaseline(cloneGroup(created));
        onNotice('规则组已创建。');
      } else {
        const updated = await updateRuleGroup(draft.id, {
          name: draft.name.trim(),
          description: draft.description.trim(),
          reading: draft.reading
        });
        // 只回写这一段，另外两段未保存的草稿保持原样。
        setDraft((old) => (old ? { ...old, name: updated.name, description: updated.description, reading: updated.reading } : old));
        setBaseline((old) => (old
          ? { ...old, name: updated.name, description: updated.description, reading: updated.reading }
          : cloneGroup(updated)));
        setGroups((old) => old.map((group) => (group.id === updated.id ? updated : group)));
        onNotice('读取方式已保存。');
      }
    } catch (reason) {
      setSegmentErrors((old) => ({ ...old, reading: errorText(reason, '读取方式无法保存。') }));
    } finally {
      setSaving('');
    }
  };

  /** 第 2 段：适用站点，允许空数组。 */
  const saveSites = async () => {
    if (!draft || draft.id === null || saving || sitesBlocked) return;
    setSaving('sites');
    clearSegmentError('sites');
    try {
      const sites = draft.sites.map((site) => site.trim()).filter(Boolean);
      const updated = await saveRuleGroupSites(draft.id, sites);
      setDraft((old) => (old ? { ...old, sites: updated.sites } : old));
      setBaseline((old) => (old ? { ...old, sites: updated.sites } : old));
      setGroups((old) => old.map((group) => (group.id === updated.id ? { ...group, sites: updated.sites } : group)));
      onNotice(updated.sites.length ? '适用站点已保存。' : '适用站点已清空，这组规则不再限制网站。');
    } catch (reason) {
      setSegmentErrors((old) => ({ ...old, sites: errorText(reason, '适用站点无法保存。') }));
    } finally {
      setSaving('');
    }
  };

  /** 第 3 段：补充步骤，0~5 个；内置步骤由服务端保护。 */
  const saveSteps = async () => {
    if (!draft || draft.id === null || saving || stepsBlocked) return;
    setSaving('steps');
    clearSegmentError('steps');
    try {
      const updated = await saveRuleGroupSteps(draft.id, draft.steps);
      setDraft((old) => (old ? { ...old, steps: updated.steps } : old));
      setBaseline((old) => (old ? { ...old, steps: updated.steps } : old));
      setGroups((old) => old.map((group) => (group.id === updated.id ? { ...group, steps: updated.steps } : group)));
      onNotice('补充步骤已保存。');
    } catch (reason) {
      // 服务端返回的错误文案已经指明是第几步、哪一项，直接展示即可。
      setSegmentErrors((old) => ({ ...old, steps: errorText(reason, '补充步骤无法保存。') }));
    } finally {
      setSaving('');
    }
  };

  /** 重新读取全部规则组；有未保存修改时先确认，避免静默丢弃草稿。 */
  const refresh = () => {
    if (anyDirty && !window.confirm('还有未保存的修改，刷新后会丢失。继续刷新？')) return;
    setPageError('');
    setLoading(true);
    void loadGroups(selected)
      .catch((reason) => setPageError(errorText(reason, '无法读取检查规则组。')))
      .finally(() => setLoading(false));
  };

  const removeGroup = async (group: RuleGroup) => {
    if (group.id === null || builtinIds.includes(group.id)) return;
    if (!window.confirm(`删除规则组“${group.name || '未命名规则组'}”？使用它的订阅会改挂到其他规则组。`)) return;
    setPageError('');
    try {
      await deleteRuleGroup(group.id);
      await loadGroups();
      onNotice('规则组已删除。');
    } catch (reason) {
      setPageError(errorText(reason, '无法删除规则组。'));
    }
  };

  return <section id="rules-page" className="rules-page">
    <div className="section-head rules-page-head">
      <div>
        <p className="eyebrow">检查规则组</p>
        <h2>检查规则组</h2>
        <p>每一组规则自己带读取方式、适用站点与补充步骤；适用站点留空表示不限网站。</p>
      </div>
      <button type="button" className="quiet" onClick={refresh}>↻ 刷新</button>
    </div>
    {pageError && <p className="form-error" role="alert">{pageError}</p>}
    {loading
      ? <p className="rules-page-loading">正在读取检查规则组…</p>
      : <div className="rules-page-body">
        <aside className="rule-group-list" aria-label="规则组列表">
          <div className="rule-group-list-head"><strong>规则组</strong><span>{groups.length} 组</span></div>
          <ul>
            {groups.map((group) => {
              const isActive = draft !== null && draft.id === group.id;
              const isBuiltin = group.id !== null && builtinIds.includes(group.id);
              // 正在编辑且有未保存修改时，列表摘要与名称跟随草稿显示，否则显示已保存值，
              // 避免用户以为「删了站点/改了名字但没生效」。空行不算站点，摘要里先过滤掉。
              const shown = isActive && anyDirty && draft
                ? { ...draft, sites: draft.sites.filter((site) => site.trim()) }
                : group;
              return <li key={String(group.id)} className={isActive ? 'active' : ''}>
                <button type="button" className="rule-group-pick" aria-current={isActive ? 'true' : undefined} onClick={() => selectGroup(group)}>
                  <strong>{shown.name || '未命名规则组'}</strong>
                  <small>{ruleGroupSummary(shown)}</small>
                </button>
                {isActive && anyDirty && <span className="rule-unsaved" role="status">未保存</span>}
                {isBuiltin && <span className="rule-group-badge">内置</span>}
                {isActive && !isBuiltin && <button type="button" className="rule-group-delete" onClick={() => void removeGroup(group)}>删除</button>}
              </li>;
            })}
            {isNew && draft && <li className="active">
              <button type="button" className="rule-group-pick" aria-current="true">
                <strong>{draft.name || '未命名规则组'}</strong>
                <small>尚未保存</small>
              </button>
              <span className="rule-unsaved" role="status">未保存</span>
            </li>}
          </ul>
          <button type="button" className="rule-group-add" onClick={startNew}>＋ 新建规则组</button>
        </aside>

        <div className="rule-group-detail">
          {!draft
            ? <div className="empty-card rule-group-empty"><h3>还没有规则组</h3><p>点击左侧「新建规则组」开始配置。</p></div>
            : <>
              <section className="rule-group-card" aria-labelledby="rule-reading-title">
                <header className="rule-group-card-head">
                  <div>
                    <span className="rule-kind">第 1 段 · 读取方式</span>
                    <h3 id="rule-reading-title">{isNew ? '新建规则组' : '怎么从列表页读出内容'}</h3>
                  </div>
                  {draft.id !== null && <span className="rule-group-id">编号 #{draft.id}</span>}
                </header>
                <div className="rule-group-grid">
                  <TextField
                    label="规则组名称"
                    value={draft.name}
                    maxLength={MAX_RULE_GROUP_NAME_LENGTH}
                    placeholder="例如：商品价格监控"
                    error={metaIssues.name}
                    onChange={(value) => updateDraft({ name: value })}
                  />
                  <TextField
                    label="规则组说明"
                    value={draft.description}
                    maxLength={MAX_RULE_GROUP_DESCRIPTION_LENGTH}
                    placeholder="这组规则适合哪些页面"
                    error={metaIssues.description}
                    onChange={(value) => updateDraft({ description: value })}
                  />
                  <TextField
                    label="内容 CSS 选择器"
                    value={draft.reading.selector}
                    placeholder="例如 .product .price"
                    hint="从列表页每一行里取出要监测的内容。"
                    error={readingFieldIssues.selector}
                    onChange={(value) => updateReading('selector', value)}
                  />
                  <SelectField
                    label="读取方式"
                    value={draft.reading.renderMode}
                    options={[{ value: 'static', label: '网页直接读取' }, { value: 'dynamic', label: '浏览器渲染（推荐）' }]}
                    onChange={(value) => updateReading('renderMode', value === 'dynamic' ? 'dynamic' : 'static')}
                    hint="网页需要加载一会儿才显示内容时，选浏览器渲染。"
                  />
                  <SelectField
                    label="取值方式"
                    value={draft.reading.contentSource}
                    options={[{ value: 'text', label: '标签中的文字' }, { value: 'attribute', label: '指定属性的值' }]}
                    onChange={(value) => updateReading('contentSource', value === 'attribute' ? 'attribute' : 'text')}
                  />
                  {draft.reading.contentSource === 'attribute'
                    ? <TextField
                      label="属性名"
                      value={draft.reading.attributeName}
                      placeholder="例如 alt、href、data-id"
                      error={readingFieldIssues.attributeName}
                      onChange={(value) => updateReading('attributeName', value)}
                    />
                    : <p className="rule-group-hint rule-group-hint-block">将直接读取所选标签的可见文字。</p>}
                  <TextField
                    label="内容匹配正则"
                    value={draft.reading.matchPattern}
                    placeholder="可选；优先保存第一个括号"
                    error={readingFieldIssues.matchPattern}
                    onChange={(value) => updateReading('matchPattern', value)}
                  />
                  <SelectField
                    label="结果模式"
                    value={draft.reading.resultMode}
                    options={[{ value: 'first', label: '仅第一项' }, { value: 'all', label: '全部匹配项' }]}
                    onChange={(value) => updateReading('resultMode', value === 'all' ? 'all' : 'first')}
                  />
                  <TextField
                    label="检查间隔（分钟）"
                    type="number"
                    min={1}
                    max={10080}
                    inputMode="numeric"
                    value={String(draft.reading.intervalMinutes)}
                    error={readingFieldIssues.intervalMinutes}
                    onChange={(value) => updateReading('intervalMinutes', Number(value))}
                  />
                </div>

                <section className="rule-group-subcard" aria-labelledby="rule-title-heading">
                  <header>
                    <h4 id="rule-title-heading">标题读取</h4>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.reading.titleSelector)}
                        onChange={(event) => setDraft((old) => {
                          if (!old) return old;
                          return event.target.checked
                            ? { ...old, reading: { ...old.reading, titleSelector: old.reading.selector, titleContentSource: 'text', titleAttributeName: '', titleMatchPattern: old.reading.titleMatchPattern } }
                            : { ...old, reading: { ...old.reading, titleSelector: '', titleAttributeName: '', titleMatchPattern: '' } };
                        })}
                      />
                      <span />读取并保存标题
                    </label>
                  </header>
                  {draft.reading.titleSelector
                    ? <div className="rule-group-grid">
                      <TextField
                        label="标题 CSS 选择器"
                        value={draft.reading.titleSelector}
                        onChange={(value) => updateReading('titleSelector', value)}
                      />
                      <SelectField
                        label="标题取值方式"
                        value={draft.reading.titleContentSource}
                        options={[{ value: 'text', label: '标签中的文字' }, { value: 'attribute', label: '指定属性的值' }]}
                        onChange={(value) => updateReading('titleContentSource', value === 'attribute' ? 'attribute' : 'text')}
                      />
                      {draft.reading.titleContentSource === 'attribute'
                        ? <TextField
                          label="标题属性名"
                          value={draft.reading.titleAttributeName}
                          placeholder="例如 alt"
                          error={readingFieldIssues.titleAttributeName}
                          onChange={(value) => updateReading('titleAttributeName', value)}
                        />
                        : <p className="rule-group-hint rule-group-hint-block">将直接读取标题标签的可见文字。</p>}
                      <TextField
                        label="标题匹配正则"
                        value={draft.reading.titleMatchPattern}
                        placeholder="可选；优先保存第一个括号"
                        error={readingFieldIssues.titleMatchPattern}
                        onChange={(value) => updateReading('titleMatchPattern', value)}
                      />
                    </div>
                    : <p className="rule-group-note">未启用时只保存内容，不读取标题。</p>}
                </section>

                <section className="rule-group-subcard" aria-labelledby="rule-pagination-heading">
                  <header>
                    <h4 id="rule-pagination-heading">分页读取</h4>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.reading.paginationSelector)}
                        onChange={(event) => setDraft((old) => {
                          if (!old) return old;
                          return event.target.checked
                            ? { ...old, reading: { ...old.reading, paginationSelector: old.reading.paginationSelector || '#page-count', paginationParameter: old.reading.paginationParameter || 'page', paginationMatchPattern: old.reading.paginationMatchPattern || '(\\d+)' } }
                            : { ...old, reading: { ...old.reading, paginationSelector: '', paginationMatchPattern: '' } };
                        })}
                      />
                      <span />启用分页读取
                    </label>
                  </header>
                  {draft.reading.paginationSelector
                    ? <div className="rule-group-grid">
                      <TextField
                        label="页数 CSS 选择器"
                        value={draft.reading.paginationSelector}
                        placeholder="例如 .pagination-total"
                        onChange={(value) => updateReading('paginationSelector', value)}
                      />
                      <TextField
                        label="页码参数名"
                        value={draft.reading.paginationParameter}
                        placeholder="例如 page"
                        error={readingFieldIssues.paginationParameter}
                        onChange={(value) => updateReading('paginationParameter', value)}
                      />
                      <TextField
                        label="页数匹配正则"
                        value={draft.reading.paginationMatchPattern}
                        placeholder="例如 (\\d+)"
                        hint="系统取第一个括号作为总页数，并在网址中追加页码参数。"
                        error={readingFieldIssues.paginationMatchPattern}
                        onChange={(value) => updateReading('paginationMatchPattern', value)}
                      />
                    </div>
                    : <p className="rule-group-note">未启用时只读取当前页，不做全量扫描。</p>}
                </section>

                <SegmentFooter
                  blocked={readingBlocked}
                  dirty={readingDirty}
                  busy={saving === 'reading'}
                  idleLabel={isNew ? '创建规则组' : '保存读取方式'}
                  savingLabel="保存中…"
                  error={segmentErrors.reading}
                  onSave={() => void saveReading()}
                />
              </section>

              <section className="rule-group-card" aria-labelledby="rule-sites-title">
                <header className="rule-group-card-head">
                  <div>
                    <span className="rule-kind">第 2 段 · 适用站点</span>
                    <h3 id="rule-sites-title">这组规则可以用在哪些网站</h3>
                  </div>
                </header>
                {isNew
                  ? <p className="rule-group-note">先创建规则组，再配置适用站点。</p>
                  : <>
                    <p className="rule-group-note">留空表示不限站点：检查时直接读取订阅原始地址；填写后只允许使用这些站点，并会在打不开时按顺序切换。</p>
                    <div className="rule-site-list">
                      {draft.sites.length === 0 && <p className="rule-site-empty">当前不限站点。</p>}
                      {draft.sites.map((site, index) => <div className="rule-site-row" key={`site-${index}`}>
                        <span className="rule-site-order" aria-hidden="true">{index + 1}</span>
                        <input
                          type="url"
                          inputMode="url"
                          value={site}
                          placeholder="https://example.com"
                          aria-label={`第 ${index + 1} 个适用站点`}
                          onChange={(event) => updateDraft({ sites: draft.sites.map((item, position) => (position === index ? event.target.value : item)) })}
                        />
                        <button
                          type="button"
                          className="rule-site-remove"
                          aria-label={`删除第 ${index + 1} 个站点`}
                          onClick={() => updateDraft({ sites: draft.sites.filter((_, position) => position !== index) })}
                        >×</button>
                        {sitesFieldIssues[String(index)] && <small className="rule-group-error" role="alert">{sitesFieldIssues[String(index)]}</small>}
                      </div>)}
                    </div>
                    {draft.sites.length < MAX_RULE_GROUP_SITES && <button type="button" className="rule-site-add" onClick={() => updateDraft({ sites: [...draft.sites, ''] })}>＋ 添加站点</button>}
                    <SegmentFooter
                      blocked={sitesBlocked}
                      dirty={sitesDirty}
                      busy={saving === 'sites'}
                      idleLabel="保存适用站点"
                      savingLabel="保存中…"
                      error={segmentErrors.sites}
                      onSave={() => void saveSites()}
                    />
                  </>}
              </section>

              <section className="rule-group-card" aria-labelledby="rule-steps-title">
                <header className="rule-group-card-head">
                  <div>
                    <span className="rule-kind">第 3 段 · 补充步骤</span>
                    <h3 id="rule-steps-title">入档之后还要做什么</h3>
                  </div>
                  {!isNew && <span className="rule-group-id">{draft.steps.length} / {MAX_SUPPLEMENT_STEPS} 步</span>}
                </header>
                {isNew
                  ? <p className="rule-group-note">先创建规则组，再添加补充步骤。</p>
                  : <>
                    <p className="rule-group-note">自定义步骤当前仅保存配置，内置的发行日期与磁力链接两类仍由现有 Worker 执行；「启用」标记同样只作为配置保存。</p>
                    {draft.steps.map((step, index) => <article className="rule-step-card" key={step.id}>
                      <header>
                        <div className="rule-step-copy">
                          <strong>{step.name || '未命名步骤'}</strong>
                          {step.builtin && <span className="rule-step-badge">{step.builtin === 'release' ? '内置 · 发行日期' : '内置 · 磁力链接'}</span>}
                        </div>
                        <div className="rule-step-actions">
                          <label className="toggle">
                            <input type="checkbox" checked={step.enabled} onChange={(event) => updateStep(index, 'enabled', event.target.checked)} />
                            <span />启用
                          </label>
                          <button
                            type="button"
                            className="rule-step-delete"
                            disabled={Boolean(step.builtin)}
                            title={step.builtin ? '内置步骤不能删除，只能停用' : undefined}
                            onClick={() => updateDraft({ steps: draft.steps.filter((_, position) => position !== index) })}
                          >删除</button>
                        </div>
                      </header>
                      {step.builtin && <p className="rule-group-note">内置步骤不能删除；是否执行仍由现有 Worker 的规则决定。</p>}
                      <div className="rule-group-grid">
                        <TextField
                          label="步骤名称"
                          value={step.name}
                          maxLength={120}
                          onChange={(value) => updateStep(index, 'name', value)}
                        />
                        <SelectField
                          label="读取来源"
                          value={step.source}
                          options={[{ value: 'detail', label: '详情页' }, { value: 'search', label: '搜索页' }]}
                          onChange={(value) => updateStep(index, 'source', value === 'search' ? 'search' : 'detail')}
                        />
                        <TextField
                          label="CSS 选择器"
                          value={step.selector}
                          placeholder="例如 time"
                          error={stepsFieldIssues[String(index)] && !step.selector.trim() ? stepsFieldIssues[String(index)] : undefined}
                          onChange={(value) => updateStep(index, 'selector', value)}
                        />
                        <SelectField
                          label="取值方式"
                          value={step.valueMode}
                          options={[{ value: 'text', label: '标签中的文字' }, { value: 'attribute', label: '指定属性的值' }]}
                          onChange={(value) => updateStep(index, 'valueMode', value === 'attribute' ? 'attribute' : 'text')}
                        />
                        {step.valueMode === 'attribute' && <TextField
                          label="属性名"
                          value={step.attribute}
                          placeholder="例如 datetime、value"
                          onChange={(value) => updateStep(index, 'attribute', value)}
                        />}
                        <TextField
                          label="匹配正则"
                          value={step.matchPattern}
                          placeholder="可选；能从取值中截出结果即可"
                          error={stepsFieldIssues[String(index)] && step.selector.trim() ? stepsFieldIssues[String(index)] : undefined}
                          onChange={(value) => updateStep(index, 'matchPattern', value)}
                        />
                        <TextField
                          label="访问间隔（毫秒）"
                          type="number"
                          min={250}
                          max={60000}
                          inputMode="numeric"
                          value={String(step.requestIntervalMs)}
                          hint="两次访问之间等待多久，250 到 60000 毫秒。"
                          onChange={(value) => updateStep(index, 'requestIntervalMs', Number(value))}
                        />
                      </div>
                    </article>)}
                    {draft.steps.length === 0 && <p className="rule-site-empty">还没有补充步骤。</p>}
                    {draft.steps.length < MAX_SUPPLEMENT_STEPS && <button type="button" className="rule-step-add" onClick={() => updateDraft({ steps: [...draft.steps, newSupplementStep()] })}>＋ 添加补充步骤</button>}
                    <SegmentFooter
                      blocked={stepsBlocked}
                      dirty={stepsDirty}
                      busy={saving === 'steps'}
                      idleLabel="保存补充步骤"
                      savingLabel="保存中…"
                      error={segmentErrors.steps}
                      onSave={() => void saveSteps()}
                    />
                  </>}
              </section>
            </>}
        </div>
      </div>}
  </section>;
}

import type { FastifyInstance } from 'fastify';
import { appendRuntimeLog, db, refreshSettings, setSetting, type DatabaseClient } from '../db.js';
import { defaultInspectionRules, getInspectionRules, inspectionRulesJson, normalizeInspectionRules, normalizeSiteUrl } from '../inspection-rules.js';
import {
  BUILTIN_GROUP_NAME,
  applyBuiltinStepFlags,
  coerceRuleGroup,
  coerceRuleGroupReading,
  coerceSupplementSteps,
  collectReadingIssues,
  collectSupplementStepIssues,
  isBuiltinGroup,
  legacyMissavGroupName,
  normalizeRuleGroupDescription,
  normalizeRuleGroupName,
  normalizeRuleGroupSites,
  parseSitesJson,
  parseStepsJson,
  removedBuiltinSteps,
  serializeSitesJson,
  serializeStepsJson,
  type RuleGroup,
  type RuleGroupReading
} from '../rule-groups.js';
import { normalizePaginationPayload, normalizePresetPayload, updatePresetList, type MissavPresetListPayload, type MissavRulesPayload, type SubscriptionPresetPayload } from '../subscription-payload.js';

/**
 * 规则领域：检查规则组、列表读取预设、归档补全规则与其适用站点。
 *
 * 只读写规则配置本身；改完规则后需要让订阅副本与执行引擎跟上，因此把订阅行的
 * 读取配置同步与 settings 刷新也留在这里，但抓取、归档、下载都不在这里发生。
 */
export function registerRulesRoutes(app: FastifyInstance) {
  async function syncSubscriptionsFromPresets(tx: Pick<DatabaseClient, 'run'>, now: string, presetId?: number) {
    const filter = presetId === undefined ? '' : ' AND p.id = ?';
    const params = presetId === undefined ? [] : [presetId];
    // PostgreSQL 不支持 MySQL 的「UPDATE ... JOIN」，改用 UPDATE ... FROM。
    await tx.run(`UPDATE subscriptions s
      SET initial_scan_completed=0, initial_scan_total=NULL, initial_scan_pages_completed=0, initial_scan_next_page=1
      FROM subscription_presets p
      WHERE p.id=s.preset_id AND s.rule_family='missav' AND s.pagination_selector IS NULL AND p.pagination_selector IS NOT NULL AND s.initial_scan_run_id IS NULL${filter}`, params);
    // 匹配规则（内容/标题）允许订阅自行设置：规则组里留空表示「不下发」，此时
    // 保留订阅已有的值。否则保存一次规则组，就会把用户给单条订阅写好的屏蔽正则
    // 一起刷成空，导致原本要过滤的内容重新入档。
    await tx.run(`UPDATE subscriptions s
      SET selector=p.selector, render_mode=COALESCE(s.render_mode_override,p.render_mode), content_source=p.content_source,
      attribute_name=p.attribute_name,
      match_pattern=COALESCE(NULLIF(TRIM(p.match_pattern),''), s.match_pattern), title_selector=p.title_selector,
      title_content_source=p.title_content_source, title_attribute_name=p.title_attribute_name,
      title_match_pattern=COALESCE(NULLIF(TRIM(p.title_match_pattern),''), s.title_match_pattern),
      result_mode=p.result_mode, pagination_selector=p.pagination_selector,
      pagination_parameter=p.pagination_parameter, pagination_match_pattern=p.pagination_match_pattern, updated_at=?
      FROM subscription_presets p
      WHERE p.id=s.preset_id AND s.rule_family='missav'${filter}`, [now, ...params]);
  }

  /**
   * 数据库里的一组检查规则。读取列沿用 subscription_presets 原有字段，新增的只有
   * sites_json / steps_json 两列 JSON。
   */
  type RuleGroupRow = {
    id: number;
    name: string;
    description: string;
    selector: string;
    render_mode: 'static' | 'dynamic';
    content_source: 'text' | 'attribute';
    attribute_name: string | null;
    match_pattern: string | null;
    title_selector: string | null;
    title_content_source: 'text' | 'attribute';
    title_attribute_name: string | null;
    title_match_pattern: string | null;
    result_mode: 'first' | 'all';
    interval_minutes: number;
    pagination_selector: string | null;
    pagination_parameter: string;
    pagination_match_pattern: string | null;
    is_active: number;
    sites_json: string | null;
    steps_json: string | null;
  };

  const RULE_GROUP_COLUMNS = `id, name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, sites_json, steps_json`;

  /** 行 → 接口对象。站点与步骤损坏时各自回落到空数组，整组规则仍然可读。 */
  function ruleGroupFromRow(row: RuleGroupRow): RuleGroup {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sites: parseSitesJson(row.sites_json),
      steps: parseStepsJson(row.steps_json),
      reading: {
        selector: row.selector,
        renderMode: row.render_mode === 'dynamic' ? 'dynamic' : 'static',
        contentSource: row.content_source === 'attribute' ? 'attribute' : 'text',
        attributeName: row.attribute_name ?? '',
        matchPattern: row.match_pattern ?? '',
        titleSelector: row.title_selector ?? '',
        titleContentSource: row.title_content_source === 'attribute' ? 'attribute' : 'text',
        titleAttributeName: row.title_attribute_name ?? '',
        titleMatchPattern: row.title_match_pattern ?? '',
        resultMode: row.result_mode === 'all' ? 'all' : 'first',
        intervalMinutes: row.interval_minutes,
        paginationSelector: row.pagination_selector ?? '',
        paginationParameter: row.pagination_parameter || 'page',
        paginationMatchPattern: row.pagination_match_pattern ?? ''
      }
    };
  }

  /** 读取方式 → 数据库列。复用既有的分页校验，避免两套规则。 */
  function ruleGroupReadingColumns(reading: RuleGroupReading) {
    const pagination = normalizePaginationPayload({
      paginationSelector: reading.paginationSelector,
      paginationParameter: reading.paginationParameter,
      paginationMatchPattern: reading.paginationMatchPattern
    });
    return {
      selector: reading.selector.trim(),
      renderMode: reading.renderMode,
      contentSource: reading.contentSource,
      attributeName: reading.contentSource === 'attribute' ? reading.attributeName.trim() || null : null,
      matchPattern: reading.matchPattern.trim() || null,
      titleSelector: reading.titleSelector.trim() || null,
      titleContentSource: reading.titleContentSource,
      titleAttributeName: reading.titleSelector.trim() && reading.titleContentSource === 'attribute' ? reading.titleAttributeName.trim() || null : null,
      titleMatchPattern: reading.titleSelector.trim() ? reading.titleMatchPattern.trim() || null : null,
      resultMode: reading.resultMode,
      interval: reading.intervalMinutes,
      ...pagination
    };
  }

  function assertReadingValid(reading: RuleGroupReading) {
    const first = Object.values(collectReadingIssues(reading))[0];
    if (first) throw new Error(first);
  }

  /** 规则组名称在库内唯一，避免订阅选择时看不出差别。 */
  async function assertGroupNameAvailable(name: string, excludeId: number | null) {
    const existing = await db.get<{ id: number }>('SELECT id FROM subscription_presets WHERE name = ? AND id <> ? LIMIT 1', [name, excludeId ?? 0]);
    if (existing) throw new Error('已有同名规则组，请换一个名称。');
  }

  async function loadRuleGroupRow(id: number) {
    return db.get<RuleGroupRow>(`SELECT ${RULE_GROUP_COLUMNS} FROM subscription_presets WHERE id = ?`, [id]);
  }

  async function loadRuleGroup(id: number): Promise<RuleGroup | null> {
    const row = await loadRuleGroupRow(id);
    return row ? ruleGroupFromRow(row) : null;
  }

  /**
   * 所有规则组站点的并集。写回 inspection_rules.sites 只是为了让仍然读取全局站点
   * 的旧代码（例如 403 提示、发行日期读取）保持可用；执行层的站点已按规则组解析。
   * 注意 getInspectionRules() 读取时会沿用旧的「最多 5 个」限制，因此这里如实写入
   * 完整并集，由读取方决定截断——抓取主流程不依赖这份全局列表。
   */
  async function collectGroupSiteUnion(client: Pick<DatabaseClient, 'all'>) {
    const rows = await client.all<{ sites_json: string | null }>('SELECT sites_json FROM subscription_presets ORDER BY id');
    const union: string[] = [];
    for (const row of rows) {
      for (const site of parseSitesJson(row.sites_json)) {
        if (!union.includes(site)) union.push(site);
      }
    }
    return union;
  }

  /**
   * 只改写 inspection_rules 的 sites，其余补全规则保持原样。base 用于兼容层把
   * 本次一并提交的发行日期、磁力链接规则合进来。
   */
  async function writeInspectionSites(
    client: Pick<DatabaseClient, 'run'>,
    sites: string[],
    now: string,
    base: ReturnType<typeof getInspectionRules> = getInspectionRules()
  ) {
    const rules = { ...base, sites };
    await client.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('inspection_rules', ?, ?)
      ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [inspectionRulesJson(rules), now]);
    return rules;
  }

  app.get('/api/subscription-presets', async () => await db.all('SELECT * FROM subscription_presets ORDER BY updated_at DESC, id DESC'));
  app.post('/api/subscription-presets', async (request, reply) => {
    try {
      const values = normalizePresetPayload(request.body as SubscriptionPresetPayload);
      const now = new Date().toISOString();
      const result = await db.run(`INSERT INTO subscription_presets (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [values.name, values.description, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.isActive, now, now]);
      return reply.code(201).send(await db.get('SELECT * FROM subscription_presets WHERE id = ?', [result.lastInsertRowid]));
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建规则。' }); }
  });
  app.put('/api/subscription-presets/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !await db.get('SELECT id FROM subscription_presets WHERE id = ?', [id])) return reply.code(404).send({ error: '规则不存在。' });
    try {
      const values = normalizePresetPayload(request.body as SubscriptionPresetPayload);
      await db.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, is_active=?, updated_at=? WHERE id=?`,
        [values.name, values.description, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, values.isActive, new Date().toISOString(), id]);
      return await db.get('SELECT * FROM subscription_presets WHERE id = ?', [id]);
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存规则。' }); }
  });
  app.delete('/api/subscription-presets/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    await db.run('DELETE FROM subscription_presets WHERE id = ?', [id]);
    return reply.code(204).send();
  });
  app.get('/api/inspection-rules', async () => getInspectionRules());
  app.put('/api/inspection-rules', async (request, reply) => {
    try {
      const rules = normalizeInspectionRules(request.body);
      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('inspection_rules', ?, ?)
          ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [inspectionRulesJson(rules), now]);
        if (!rules.releaseDate.enabled) {
          await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE status = 'queued'", [now]);
          await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE release_status = 'pending'", [now]);
        }
        if (!rules.magnet.enabled) {
          await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE status = 'queued'", [now]);
          await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE magnet_status = 'pending'", [now]);
        }
      });
      await setSetting('inspection_rules', inspectionRulesJson(rules));
      await appendRuntimeLog({ level: 'success', source: 'system', message: '检查规则已更新；后续归档会按新规则执行。' });
      return rules;
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '检查规则无法保存。' }); }
  });
  /** 规则组列表；builtinIds 供页面禁止删除内置组。 */
  app.get('/api/rule-groups', async () => {
    const rows = await db.all<RuleGroupRow>(`SELECT ${RULE_GROUP_COLUMNS} FROM subscription_presets ORDER BY id ASC`);
    const groups = rows.map(ruleGroupFromRow);
    return {
      groups,
      builtinIds: groups.filter((group) => group.id !== null && isBuiltinGroup(group)).map((group) => group.id as number)
    };
  });

  /**
   * 新建规则组。名称与读取方式必须合法；适用站点可以为空（不限站点），补充步骤
   * 可以为空。这里只开一个事务写这一组，不影响其他规则组。
   */
  app.post('/api/rule-groups', async (request, reply) => {
    try {
      const input = coerceRuleGroup(request.body);
      const name = normalizeRuleGroupName(input.name);
      const description = normalizeRuleGroupDescription(input.description);
      assertReadingValid(input.reading);
      // 新建的规则组没有内置步骤：即使请求里带了 builtin 标记也要去掉，避免普通规则组
      // 变成「不可删除」的内置组。
      const steps = applyBuiltinStepFlags([], coerceSupplementSteps(input.steps));
      const stepIssues = collectSupplementStepIssues(steps);
      if (Object.keys(stepIssues).length) {
        const first = Object.values(stepIssues)[0];
        return reply.code(400).send({ error: first, fields: stepIssues });
      }
      await assertGroupNameAvailable(name, null);
      const now = new Date().toISOString();
      const columns = ruleGroupReadingColumns(input.reading);
      const groupId = await db.transaction(async (tx) => {
        const inserted = await tx.run(`INSERT INTO subscription_presets
          (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, sites_json, steps_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, columns.selector, columns.renderMode, columns.contentSource, columns.attributeName, columns.matchPattern,
          columns.titleSelector, columns.titleContentSource, columns.titleAttributeName, columns.titleMatchPattern, columns.resultMode,
          columns.interval, columns.paginationSelector, columns.paginationParameter, columns.paginationMatchPattern, 1,
          serializeSitesJson(input.sites), serializeStepsJson(steps), now, now]);
        // 站点非空时才需要更新全局并集，避免每次新建都重写 inspection_rules。
        if (input.sites.length) await writeInspectionSites(tx, await collectGroupSiteUnion(tx), now);
        return inserted.lastInsertRowid;
      });
      if (input.sites.length) await refreshSettings(true);
      return reply.code(201).send({ group: await loadRuleGroup(groupId) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建规则组。' });
    }
  });

  /** 修改名称、说明与「读取方式」；适用站点与补充步骤各有独立接口。 */
  app.patch('/api/rule-groups/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
    const current = await loadRuleGroupRow(id);
    if (!current) return reply.code(404).send({ error: '规则组不存在。' });
    try {
      const body = (request.body ?? {}) as { name?: unknown; description?: unknown; reading?: unknown };
      const existing = ruleGroupFromRow(current);
      const name = body.name === undefined ? existing.name : normalizeRuleGroupName(body.name);
      const description = body.description === undefined ? existing.description : normalizeRuleGroupDescription(body.description);
      const reading = body.reading === undefined ? existing.reading : coerceRuleGroupReading(body.reading);
      assertReadingValid(reading);
      if (name !== existing.name) await assertGroupNameAvailable(name, id);
      const columns = ruleGroupReadingColumns(reading);
      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, updated_at=? WHERE id=?`,
          [name, description, columns.selector, columns.renderMode, columns.contentSource, columns.attributeName, columns.matchPattern,
            columns.titleSelector, columns.titleContentSource, columns.titleAttributeName, columns.titleMatchPattern, columns.resultMode,
            columns.interval, columns.paginationSelector, columns.paginationParameter, columns.paginationMatchPattern, now, id]);
        // 订阅行保存的是读取配置副本，这里同步一次，改完立刻在下一次检查生效。
        await syncSubscriptionsFromPresets(tx, now, id);
      });
      return { group: await loadRuleGroup(id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存规则组。' });
    }
  });

  /** 删除规则组：内置组禁止删除；使用中的订阅改挂到仍存在的规则组上。 */
  app.delete('/api/rule-groups/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
    const row = await loadRuleGroupRow(id);
    if (!row) return reply.code(404).send({ error: '规则组不存在。' });
    if (isBuiltinGroup(ruleGroupFromRow(row))) return reply.code(400).send({ error: '内置规则组不能删除，只能修改其中的配置。' });
    const remaining = (await db.all<RuleGroupRow>(`SELECT ${RULE_GROUP_COLUMNS} FROM subscription_presets WHERE id <> ? ORDER BY id ASC`, [id]))
      .map(ruleGroupFromRow);
    if (!remaining.length) return reply.code(400).send({ error: '请至少保留一组检查规则。' });
    const fallback = remaining.find((group) => isBuiltinGroup(group)) ?? remaining[0];
    const now = new Date().toISOString();
    try {
      await db.transaction(async (tx) => {
        if (fallback.id !== null) {
          await tx.run("UPDATE subscriptions SET preset_id=?, updated_at=? WHERE rule_family='missav' AND preset_id=?", [fallback.id, now, id]);
          // 改挂之后重新复制一次读取配置，避免订阅继续使用已删除规则组的旧选择器。
          await syncSubscriptionsFromPresets(tx, now, fallback.id);
        }
        await tx.run('DELETE FROM subscription_presets WHERE id = ?', [id]);
        await writeInspectionSites(tx, await collectGroupSiteUnion(tx), now);
      });
      await refreshSettings(true);
      return { ok: true, reassignedPresetId: fallback.id };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法删除规则组。' });
    }
  });

  /**
   * 只保存「适用站点」这一段。允许空数组：空表示不限站点，此时抓取直接读取订阅
   * 原地址。成功后把全部规则组的站点并集写回 inspection_rules.sites。
   */
  app.put('/api/rule-groups/:id/sites', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
    if (!await loadRuleGroupRow(id)) return reply.code(404).send({ error: '规则组不存在。' });
    try {
      const body = (request.body ?? {}) as { sites?: unknown };
      // 必须显式提交数组：漏传字段与「清空站点」必须区分开。
      if (!Array.isArray(body.sites)) throw new Error('请提交站点数组；不限站点时提交空数组。');
      const sites = normalizeRuleGroupSites(body.sites);
      const now = new Date().toISOString();
      const union = await db.transaction(async (tx) => {
        await tx.run('UPDATE subscription_presets SET sites_json=?, updated_at=? WHERE id=?', [serializeSitesJson(sites), now, id]);
        const next = await collectGroupSiteUnion(tx);
        await writeInspectionSites(tx, next, now);
        return next;
      });
      await refreshSettings(true);
      return { group: await loadRuleGroup(id), sites: union };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存适用站点。' });
    }
  });

  /**
   * 只保存「补充步骤」这一段（0~5 步）。逐项校验，失败时通过 fields 返回每一步的
   * 具体原因；内置步骤不能删除，只能停用。
   */
  app.put('/api/rule-groups/:id/steps', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '规则组标识无效。' });
    const row = await loadRuleGroupRow(id);
    if (!row) return reply.code(404).send({ error: '规则组不存在。' });
    try {
      const body = (request.body ?? {}) as { steps?: unknown };
      if (!Array.isArray(body.steps)) throw new Error('请提交步骤数组；没有补充步骤时提交空数组。');
      const existing = ruleGroupFromRow(row);
      const steps = applyBuiltinStepFlags(existing.steps, coerceSupplementSteps(body.steps));
      const issues = collectSupplementStepIssues(steps);
      const removed = removedBuiltinSteps(existing.steps, steps);
      if (removed.length) {
        issues.steps = `内置步骤“${removed.map((step) => step.name).join('、')}”不能删除，只能停用。`;
      }
      if (Object.keys(issues).length) {
        return reply.code(400).send({ error: Object.values(issues)[0], fields: issues });
      }
      await db.run('UPDATE subscription_presets SET steps_json=?, updated_at=? WHERE id=?',
        [serializeStepsJson(steps), new Date().toISOString(), id]);
      return { group: await loadRuleGroup(id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法保存补充步骤。' });
    }
  });

  /**
   * 「检查规则」页面把列表读取规则、站点和归档补全放在一起编辑，因此这里提供
   * 一次性保存全部内容的入口：预设列表整体替换，站点与补全规则同时更新。
   */
  app.put('/api/rules/missav/presets', async (request, reply) => {
    try {
      const payload = request.body as MissavPresetListPayload;
      const rows = Array.isArray(payload.presets) ? payload.presets : [];
      if (!rows.length) throw new Error('请至少保留一组列表读取规则。');
      if (new Set(rows.map((row) => row.name?.trim())).size !== rows.length) throw new Error('每组读取规则需要不同的名称。');
      const incoming = payload.inspectionRules as Partial<typeof defaultInspectionRules> | undefined;
      if (!Array.isArray(payload.sites) || !payload.sites.length || payload.sites.some((site) => typeof site !== 'string' || !normalizeSiteUrl(site))) throw new Error('请填写至少一个完整的读取站点地址。');
      if (!Array.isArray(incoming?.magnet?.origins) || !incoming.magnet.origins.length) throw new Error('请至少填写一个磁力检索节点。');
      for (const interval of [incoming?.releaseDate?.requestIntervalMs, incoming?.magnet?.requestIntervalMs]) {
        if (!Number.isInteger(interval) || Number(interval) < 250 || Number(interval) > 60000) throw new Error('访问间隔需在 250 到 60000 毫秒之间。');
      }
      const sites = normalizeRuleGroupSites(payload.sites);
      const rules = normalizeInspectionRules({
        sites,
        releaseDate: { ...defaultInspectionRules.releaseDate, renderMode: incoming?.releaseDate?.renderMode, requestIntervalMs: incoming?.releaseDate?.requestIntervalMs, enabled: true },
        magnet: { ...defaultInspectionRules.magnet, origins: incoming?.magnet?.origins, filenamePrefix: incoming?.magnet?.filenamePrefix, fallbackFilenamePrefixes: incoming?.magnet?.fallbackFilenamePrefixes, requestIntervalMs: incoming?.magnet?.requestIntervalMs, enabled: true }
      });
      // 兼容层：老页面仍按「一次性保存」提交。这里改成依次写入三段（读取方式、
      // 适用站点、补充步骤），并沿用原来的整体事务；先校验再写，避免半套数据。
      const submittedIds = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));
      const builtinRows = await db.all<{ id: number; steps_json: string | null }>('SELECT id, steps_json FROM subscription_presets ORDER BY id');
      const missingBuiltin = builtinRows
        .filter((row) => isBuiltinGroup({ steps: parseStepsJson(row.steps_json) }) && !submittedIds.has(row.id));
      if (missingBuiltin.length) throw new Error(`内置规则组“${BUILTIN_GROUP_NAME}”不能删除，请在提交内容中保留它。`);
      // 先逐组校验读取方式，任何一组非法都在写库前返回。
      for (const row of rows) normalizePresetPayload(row as unknown as SubscriptionPresetPayload);
      const now = new Date().toISOString();
      let finalRules = rules;
      await db.transaction(async (tx) => {
        const keptIds = await updatePresetList(tx, rows, now);
        // 老页面只有一份全局站点：把它写到本次提交的每一组上，行为与改造前一致。
        for (const keptId of keptIds) {
          await tx.run('UPDATE subscription_presets SET sites_json=?, steps_json=COALESCE(steps_json, \'[]\') WHERE id=?', [serializeSitesJson(sites), keptId]);
        }
        await tx.run(`UPDATE subscriptions SET preset_id=? WHERE rule_family='missav' AND (preset_id IS NULL OR preset_id NOT IN (${keptIds.map(() => '?').join(',')}))`, [keptIds[0], ...keptIds]);
        await syncSubscriptionsFromPresets(tx, now);
        finalRules = await writeInspectionSites(tx, await collectGroupSiteUnion(tx), now, rules);
        if (!finalRules.releaseDate.enabled) {
          await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE status = 'queued'", [now]);
          await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE release_status = 'pending'", [now]);
        }
        if (!finalRules.magnet.enabled) {
          await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE status = 'queued'", [now]);
          await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE magnet_status = 'pending'", [now]);
        }
      });
      await refreshSettings(true);
      await appendRuntimeLog({ level: 'success', source: 'system', message: '检查规则已更新；后续归档会按新规则执行。' });
      return { presets: await db.all('SELECT * FROM subscription_presets ORDER BY id ASC'), inspectionRules: finalRules };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '检查规则无法保存。' }); }
  });

  app.put('/api/rules/missav', async (request, reply) => {
    try {
      const payload = request.body as MissavRulesPayload;
      // Validate both documents before opening the write transaction. This keeps
      // malformed companion rules from ever partially updating the preset.
      const preset = normalizePresetPayload(payload.preset ?? {} as SubscriptionPresetPayload);
      // 界面把站点列表放在「检查规则」顶部，保存时与预设、补全规则一起提交，
      // 因此这里合并成同一份文档后再统一校验与写入。
      const rules = normalizeInspectionRules({ ...(payload.inspectionRules ?? {} as Record<string, unknown>), sites: payload.sites });
      const requestedId = Number(payload.presetId);
      const now = new Date().toISOString();
      const presetId = await db.transaction(async (tx) => {
        const existing = Number.isInteger(requestedId) && requestedId > 0
          ? await tx.get<{ id: number }>('SELECT id FROM subscription_presets WHERE id = ?', [requestedId])
          : await tx.get<{ id: number }>("SELECT id FROM subscription_presets WHERE name IN (?, ?) ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, id ASC LIMIT 1", [BUILTIN_GROUP_NAME, legacyMissavGroupName, legacyMissavGroupName]);
        let id: number;
        if (existing) {
          id = existing.id;
          await tx.run(`UPDATE subscription_presets SET name=?, description=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, is_active=?, updated_at=? WHERE id=?`,
            [preset.name, preset.description, preset.selector, preset.renderMode, preset.contentSource, preset.attributeName, preset.matchPattern, preset.titleSelector, preset.titleContentSource, preset.titleAttributeName, preset.titleMatchPattern, preset.resultMode, preset.interval, preset.paginationSelector, preset.paginationParameter, preset.paginationMatchPattern, preset.isActive, now, id]);
        } else {
          const inserted = await tx.run(`INSERT INTO subscription_presets (name, description, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, pagination_selector, pagination_parameter, pagination_match_pattern, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [preset.name, preset.description, preset.selector, preset.renderMode, preset.contentSource, preset.attributeName, preset.matchPattern, preset.titleSelector, preset.titleContentSource, preset.titleAttributeName, preset.titleMatchPattern, preset.resultMode, preset.interval, preset.paginationSelector, preset.paginationParameter, preset.paginationMatchPattern, preset.isActive, now, now]);
          id = inserted.lastInsertRowid;
        }
        await tx.run(`INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('inspection_rules', ?, ?)
          ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [inspectionRulesJson(rules), now]);
        if (!rules.releaseDate.enabled) {
          await tx.run("UPDATE release_jobs SET status = 'completed', finished_at = ?, error = '发行日期规则已停用' WHERE status = 'queued'", [now]);
          await tx.run("UPDATE archive_entries SET release_status = 'unsearched', release_error = NULL, updated_at = ? WHERE release_status = 'pending'", [now]);
        }
        if (!rules.magnet.enabled) {
          await tx.run("UPDATE magnet_jobs SET status = 'completed', finished_at = ?, error = '磁力检索规则已停用' WHERE status = 'queued'", [now]);
          await tx.run("UPDATE archive_entries SET magnet_status = 'unsearched', magnet_error = NULL, updated_at = ? WHERE magnet_status = 'pending'", [now]);
        }
        return id;
      });
      await refreshSettings(true);
      await appendRuntimeLog({ level: 'success', source: 'system', message: 'MissAV 检查规则已原子更新；后续任务会按新规则执行。' });
      return { preset: await db.get('SELECT * FROM subscription_presets WHERE id = ?', [presetId]), inspectionRules: rules };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'MissAV 检查规则无法保存。' }); }
  });
}

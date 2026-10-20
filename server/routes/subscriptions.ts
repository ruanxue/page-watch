import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { JOB_PRIORITY, appendRuntimeLog, db, getSubscription, queueJob, rebuildSubscriptionProgress, type Subscription } from '../db.js';
import { resolveMissavPayload, type SubscriptionPayload } from '../subscription-payload.js';

/**
 * 订阅领域：订阅的新增、修改、删除，档案重置，预览抽取与手动触发检查。
 *
 * 预览需要执行引擎里的浏览器进程，因此唤醒动作由 index 注入 wakeEngine；
 * 这里不直接依赖引擎控制器，避免订阅领域反向依赖调度实现。
 */
export function registerSubscriptionsRoutes(app: FastifyInstance, deps: { wakeEngine: (reason: string) => Promise<void> }) {
  app.post('/api/subscriptions', async (request, reply) => {
    try {
      const { values, family, presetId, override } = await resolveMissavPayload(request.body as SubscriptionPayload);
      const now = new Date().toISOString();
      const result = await db.run(`INSERT INTO subscriptions
        (name, url, selector, render_mode, content_source, attribute_name, match_pattern, title_selector, title_content_source, title_attribute_name, title_match_pattern, result_mode, interval_minutes, schedule_type, schedule_interval_hours, schedule_time, schedule_weekday, is_active, pagination_selector, pagination_parameter, pagination_match_pattern, rule_family, preset_id, render_mode_override, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [values.name, values.url, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.scheduleType, values.scheduleIntervalHours, values.scheduleTime, values.scheduleWeekday, values.isActive, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, family, presetId, override, now, now]);
      await rebuildSubscriptionProgress(result.lastInsertRowid);
      return reply.code(201).send(await getSubscription(result.lastInsertRowid));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法创建订阅。' });
    }
  });

  app.put('/api/subscriptions/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const current = await getSubscription(id);
    if (!current) return reply.code(404).send({ error: '订阅不存在。' });
    try {
      const payload = request.body as SubscriptionPayload;
      const { values, family, presetId, override } = await resolveMissavPayload({ ...payload, ruleFamily: payload.ruleFamily ?? current.rule_family, presetId: payload.presetId ?? current.preset_id, renderModeOverride: payload.renderModeOverride === undefined ? current.render_mode_override : payload.renderModeOverride });
      const scheduleChanged = current.schedule_type !== values.scheduleType || current.schedule_interval_hours !== values.scheduleIntervalHours
        || current.schedule_time !== values.scheduleTime || current.schedule_weekday !== values.scheduleWeekday || current.is_active !== values.isActive;
      await db.run(`UPDATE subscriptions SET name=?, url=?, selector=?, render_mode=?, content_source=?, attribute_name=?, match_pattern=?, title_selector=?, title_content_source=?, title_attribute_name=?, title_match_pattern=?, result_mode=?, interval_minutes=?, schedule_type=?, schedule_interval_hours=?, schedule_time=?, schedule_weekday=?, is_active=?, pagination_selector=?, pagination_parameter=?, pagination_match_pattern=?, rule_family=?, preset_id=?, render_mode_override=?, initial_scan_completed=CASE WHEN ? IS NULL THEN 1 WHEN pagination_selector IS NULL THEN 0 ELSE initial_scan_completed END, initial_scan_total=CASE WHEN ? IS NOT NULL AND pagination_selector IS NULL THEN NULL ELSE initial_scan_total END, initial_scan_pages_completed=CASE WHEN ? IS NOT NULL AND pagination_selector IS NULL THEN 0 ELSE initial_scan_pages_completed END, next_scheduled_at=CASE WHEN ? THEN NULL ELSE next_scheduled_at END, updated_at=? WHERE id=?`,
        [values.name, values.url, values.selector, values.renderMode, values.contentSource, values.attributeName, values.matchPattern, values.titleSelector, values.titleContentSource, values.titleAttributeName, values.titleMatchPattern, values.resultMode, values.interval, values.scheduleType, values.scheduleIntervalHours, values.scheduleTime, values.scheduleWeekday, values.isActive, values.paginationSelector, values.paginationParameter, values.paginationMatchPattern, family, presetId, override, values.paginationSelector, values.paginationSelector, values.paginationSelector, scheduleChanged ? 1 : 0, new Date().toISOString(), id]);
      return await getSubscription(id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '无法更新订阅。' });
    }
  });

  app.delete('/api/subscriptions/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    await db.transaction(async (tx) => {
      await tx.run('DELETE d FROM download_jobs d JOIN archive_entries a ON a.id = d.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE r FROM release_jobs r JOIN archive_entries a ON a.id = r.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE m FROM magnet_jobs m JOIN archive_entries a ON a.id = m.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE l FROM library_jobs l JOIN archive_entries a ON a.id = l.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE FROM archive_entry_codes WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM archive_entries WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM jobs WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM subscription_progress WHERE subscription_id = ?', [id]);
      await tx.run('UPDATE runtime_logs SET subscription_id = NULL WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM subscriptions WHERE id = ?', [id]);
    });
    return reply.code(204).send();
  });

  app.delete('/api/subscriptions/:id/archive', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!await getSubscription(id)) return reply.code(404).send({ error: '订阅不存在。' });
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run('DELETE d FROM download_jobs d JOIN archive_entries a ON a.id = d.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE r FROM release_jobs r JOIN archive_entries a ON a.id = r.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE m FROM magnet_jobs m JOIN archive_entries a ON a.id = m.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE l FROM library_jobs l JOIN archive_entries a ON a.id = l.archive_entry_id WHERE a.subscription_id = ?', [id]);
      await tx.run('DELETE FROM archive_entry_codes WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
      await tx.run('DELETE FROM archive_entries WHERE subscription_id = ?', [id]);
      await tx.run(`INSERT INTO subscription_progress
        (subscription_id, archive_total, jellyfin_available, release_total, release_done, magnet_total, magnet_done, library_total, library_done, download_total, download_done, updated_at)
        VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
        ON DUPLICATE KEY UPDATE archive_total=0, jellyfin_available=0, release_total=0, release_done=0, magnet_total=0, magnet_done=0, library_total=0, library_done=0, download_total=0, download_done=0, updated_at=VALUES(updated_at)`, [id, now]);
      await tx.run("DELETE FROM jobs WHERE subscription_id = ? AND status = 'queued'", [id]);
      await tx.run(`UPDATE subscriptions
        SET last_checked_at = NULL, last_hash = NULL, last_content = NULL, last_error = NULL,
          initial_scan_completed = CASE WHEN pagination_selector IS NULL THEN 1 ELSE 0 END,
          initial_scan_total = NULL, initial_scan_pages_completed = 0, initial_scan_run_id = NULL, initial_scan_next_page = 1, updated_at = ?
        WHERE id = ?`, [now, id]);
    });
    return reply.code(204).send();
  });

  app.post('/api/subscriptions/preview', async (request, reply) => {
    try {
      const { values, family, presetId } = await resolveMissavPayload(request.body as SubscriptionPayload);
      const token = process.env.WORKER_EVENT_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'page-watch-dev-runner');
      if (!token) throw new Error('统一执行引擎尚未就绪，请稍后重试。');
      await deps.wakeEngine('规则预览');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.RUNNER_INTERNAL_PORT || '3031'}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-page-watch-worker-token': token },
          body: JSON.stringify({ url: values.url, selector: values.selector, render_mode: values.renderMode as Subscription['render_mode'], content_source: values.contentSource as Subscription['content_source'], attribute_name: values.attributeName, match_pattern: values.matchPattern, title_selector: values.titleSelector, title_content_source: values.titleContentSource as Subscription['title_content_source'], title_attribute_name: values.titleAttributeName, title_match_pattern: values.titleMatchPattern, result_mode: values.resultMode as Subscription['result_mode'], rule_family: family, preset_id: presetId }),
          signal: controller.signal
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '预览抽取失败。');
        return result;
      } finally { clearTimeout(timeout); }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '预览失败。' });
    }
  });

  app.post('/api/subscriptions/:id/run', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const subscription = await getSubscription(id);
    if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
    const queued = await queueJob(id, JOB_PRIORITY.manual);
    await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, jobId: queued.id, message: queued.queued ? '已加入立即检查队列。' : '检查已在队列中或正在执行。' });
    return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
  });

  app.post('/api/subscriptions/:id/full-scan', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const subscription = await getSubscription(id);
    if (!subscription) return reply.code(404).send({ error: '订阅不存在。' });
    if (!subscription.pagination_selector) return reply.code(400).send({ error: '当前订阅没有配置全量分页检查。' });
    const active = await db.get<{ id: number }>("SELECT id FROM jobs WHERE subscription_id = ? AND status IN ('queued','running')", [id]);
    if (active) return reply.code(409).send({ error: '该订阅已有检查正在执行或排队；请等待其结束后再开始新的全量检查。' });
    const existingBatch = await db.get<{ id: string }>("SELECT id FROM full_scan_batches WHERE subscription_id = ? AND status = 'scanning' ORDER BY created_at DESC, id DESC LIMIT 1", [id]);
    const batchId = existingBatch?.id ?? randomUUID();
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM initial_scan_items WHERE subscription_id = ?', [id]);
      await tx.run(`UPDATE subscriptions SET initial_scan_completed = 0, initial_scan_total = NULL, initial_scan_pages_completed = 0, initial_scan_run_id = NULL, initial_scan_next_page = 1, last_error = NULL, updated_at = ? WHERE id = ?`, [now, id]);
      await tx.run(`INSERT INTO full_scan_batches (id, subscription_id, subscription_name, status, is_initial, page_count, scanned_count, archived_count, created_at)
        VALUES (?, ?, ?, 'scanning', ?, NULL, 0, 0, ?)
        ON DUPLICATE KEY UPDATE subscription_name = VALUES(subscription_name), status = 'scanning', is_initial = VALUES(is_initial), page_count = NULL, scanned_count = 0, archived_count = 0, completed_at = NULL, created_at = VALUES(created_at)`,
      [batchId, id, subscription.name, subscription.last_hash ? 0 : 1, now]);
    });
    const queued = await queueJob(id, JOB_PRIORITY.manual);
    await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: id, jobId: queued.id, message: queued.queued ? '已加入全量检查队列。' : '全量检查设置已更新，当前检查结束后可再次确认日志。' });
    return reply.code(202).send({ queued: queued.queued, jobId: queued.id });
  });
}

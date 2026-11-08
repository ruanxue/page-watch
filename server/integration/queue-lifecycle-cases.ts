import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, getSubscription, queueJob, renewWorkerHeartbeat, setSetting, type Subscription } from '../db.js';
import { captureSubscription } from '../capture.js';
import { runnableHandlers } from '../engine-queue.js';
import { EngineWakeScheduler } from '../engine-wake-scheduler.js';
import { recoverStalledJobs } from '../job-recovery.js';
import { runReleaseWorkerTick } from '../release-worker.js';
import * as notifications from '../notifications.js';
import type { ExecutionEngineController } from '../engine-controller.js';

// 只能由 postgres.test.ts 在随机创建的隔离测试库中调用。
export async function testQueueLifecycle(t: TestContext, app: FastifyInstance) {
  const database = await db.get<{ name: string }>('SELECT current_database() AS name');
  assert.match(database!.name, /^pagewatch_test_[a-f0-9]{32}$/, '生命周期测试只能清理随机创建的测试库');
  const tables = ['jobs', 'release_jobs', 'magnet_jobs', 'download_jobs', 'library_jobs', 'library_sync_jobs',
    'notification_outbox', 'notification_dedupes', 'full_scan_batches', 'initial_scan_items', 'archive_entry_codes',
    'archive_entries', 'subscription_progress', 'subscriptions', 'worker_heartbeats'];
  const clear = () => db.run(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`);
  const now = () => new Date().toISOString();
  const n = async (table: string, id: number) => Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE subscription_id = ?`, [id]))!.n);
  const base = { name: '生命周期测试', url: 'https://8.8.8.8/full', ruleFamily: 'legacy_custom', selector: '.code',
    contentSource: 'text', resultMode: 'all', renderMode: 'static', isActive: false };
  async function subscription(paginated = false) {
    const response = await app.inject({ method: 'POST', url: '/api/subscriptions', payload: {
      ...base, ...(paginated ? { paginationSelector: '#pages', paginationMatchPattern: '/\\s*(\\d+)' } : {})
    } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Subscription>();
  }
  async function entry(id: number, batchId: string | null = null, status = 'found') {
    return (await db.run(`INSERT INTO archive_entries (subscription_id, content, content_hash, first_seen_at, updated_at, release_status, full_scan_batch_id)
      VALUES (?, 'TEST-001', ?, ?, ?, ?, ?)`, [id, randomUUID(), now(), now(), status, batchId])).lastInsertRowid;
  }
  async function batch(id: number, status = 'processing') {
    const batchId = randomUUID();
    await db.run(`INSERT INTO full_scan_batches (id, subscription_id, subscription_name, status, is_initial, page_count, scanned_count, archived_count, created_at)
      VALUES (?, ?, '生命周期测试', ?, 1, 1, 1, 1, ?)`, [batchId, id, status, now()]);
    return batchId;
  }
  const scheduler = () => new EngineWakeScheduler({} as ExecutionEngineController) as unknown as { nextWakeAt(): Promise<number> };
  const page = '<b id="pages">1 / 2</b><a class="code">TEST-001</a>';
  await clear();
  await setSetting('jellyfin_enabled', '0');
  await setSetting('qbit_enabled', '0');

  await t.test('普通网站档案不会唤醒发行日期处理，MissAV 候选仍可唤醒', async () => {
    const sub = await subscription();
    await entry(sub.id, null, 'unsearched');
    for (let i = 0; i < 3; i++) {
      assert.equal((await runnableHandlers()).release, false);
      await runReleaseWorkerTick();
    }
    assert.equal(await scheduler().nextWakeAt(), Infinity);
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM release_jobs'))!.n), 0);
    await db.run("UPDATE subscriptions SET rule_family = 'missav' WHERE id = ?", [sub.id]);
    assert.equal((await runnableHandlers()).release, true);
    assert.ok(await scheduler().nextWakeAt() <= Date.now());
  });

  await t.test('只剩中断任务时仍会恢复全部队列，不改变未来重试时间', async () => {
    await clear();
    const sub = await subscription();
    const archiveId = await entry(sub.id);
    const startedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const queue = await queueJob(sub.id);
    await db.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [startedAt, queue.id]);
    for (const table of ['release_jobs', 'magnet_jobs', 'download_jobs', 'library_jobs']) {
      await db.run(`INSERT INTO ${table} (archive_entry_id, status, requested_at, started_at) VALUES (?, 'running', ?, ?)`, [archiveId, startedAt, startedAt]);
    }
    await notifications.enqueueNotification(notifications.createOperationFailureNotification({ operation: '中断测试', error: '测试', subscription: sub }));
    await db.run("UPDATE notification_outbox SET status = 'running', started_at = ?", [startedAt]);
    assert.equal((await runnableHandlers()).magnet, false);
    assert.ok(await scheduler().nextWakeAt() <= Date.now());
    const runnable = await runnableHandlers();
    for (const value of Object.values(runnable)) assert.equal(value, true);
    for (const table of ['jobs', 'release_jobs', 'magnet_jobs', 'download_jobs', 'library_jobs', 'notification_outbox']) {
      assert.equal((await db.get<{ status: string }>(`SELECT status FROM ${table} LIMIT 1`))!.status, 'queued');
    }
    for (const delay of [30_000, 120_000]) {
      const retryAt = new Date(Date.now() + delay).toISOString();
      await db.run('UPDATE magnet_jobs SET retry_after = ?', [retryAt]);
      await recoverStalledJobs();
      assert.equal((await runnableHandlers()).magnet, false);
      assert.equal((await db.get<{ retry_after: string }>('SELECT retry_after FROM magnet_jobs LIMIT 1'))!.retry_after, retryAt);
    }
  });

  await t.test('健康长任务不被回收，保活保留任务与进度，心跳过期后恢复', async () => {
    await clear();
    const sub = await subscription();
    const job = await queueJob(sub.id);
    await db.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
    await db.run(`INSERT INTO worker_heartbeats (worker_name, status, detail, task_kind, subscription_id, progress_current, progress_total, last_seen_at)
      VALUES ('capture', 'busy', '长任务', 'full_scan', ?, 2, 10, ?)`, [sub.id, now()]);
    assert.equal(await recoverStalledJobs(), 0);
    await renewWorkerHeartbeat('capture');
    const heartbeat = await db.get<{ task_kind: string; subscription_id: number; progress_current: number }>("SELECT * FROM worker_heartbeats WHERE worker_name='capture'");
    assert.equal(heartbeat!.task_kind, 'full_scan');
    assert.equal(heartbeat!.subscription_id, sub.id);
    assert.equal(heartbeat!.progress_current, 2);
    await db.run("UPDATE worker_heartbeats SET last_seen_at = '2000-01-01T00:00:00.000Z'");
    assert.equal(await recoverStalledJobs(), 1);
    assert.equal((await runnableHandlers()).capture, true);
  });

  for (const action of ['delete', 'reset'] as const) for (const heldPage of [1, 2]) {
    await t.test(`第 ${heldPage} 页读取期间${action === 'delete' ? '删除订阅' : '重置档案'}，旧扫描不得写回`, async () => {
      await clear();
      const sub = await subscription(true);
      let arrived!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { arrived = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      globalThis.fetch = async (input) => {
        if (Number(new URL(String(input)).searchParams.get('page') || 1) === heldPage) { arrived(); await gate; }
        return new Response(page);
      };
      const running = captureSubscription(sub);
      try {
        await waiting;
        const response = await app.inject({ method: 'DELETE', url: `/api/subscriptions/${sub.id}${action === 'reset' ? '/archive' : ''}` });
        assert.equal(response.statusCode, 204, response.body);
      } finally { release(); }
      assert.equal((await running).stored, false);
      for (const table of ['initial_scan_items', 'archive_entries', 'full_scan_batches']) assert.equal(await n(table, sub.id), 0, table);
      if (action === 'reset') {
        assert.equal((await getSubscription(sub.id))!.initial_scan_run_id, null);
        globalThis.fetch = async () => new Response(page);
        assert.equal((await captureSubscription((await getSubscription(sub.id))!)).addedCount, 1);
      } else assert.equal(await getSubscription(sub.id), undefined);
    });
  }

  await t.test('删除或重置清理全部批次和待发通知，遗留孤立批次不产生通知', async () => {
    for (const action of ['delete', 'reset'] as const) {
      await clear();
      const sub = await subscription();
      for (const status of ['scanning', 'processing', 'scan_failed', 'completed']) await batch(sub.id, status);
      await notifications.enqueueNotification(notifications.createFullScanCompletedNotification({ subscription: sub,
        stats: { pageCount: 1, scannedCount: 1, archivedCount: 1, magnetFoundCount: 0, magnetNotFoundCount: 0, failedCount: 0 }, items: [] }));
      await queueJob(sub.id);
      await db.run("UPDATE jobs SET status='running'");
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${sub.id}${action === 'reset' ? '/archive' : ''}` })).statusCode, 204);
      assert.equal(await n('full_scan_batches', sub.id), 0);
      assert.equal(await n('jobs', sub.id), 0);
      assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_outbox'))!.n), 0);
      await batch(999999);
      let deliveries = 0;
      globalThis.fetch = async () => { deliveries++; return new Response('{}'); };
      await notifications.runNotificationWorkerTick();
      assert.equal(deliveries, 0);
      assert.equal(await n('full_scan_batches', 999999), 0);
    }
  });

  await t.test('重置后旧网页请求报错，也不回写错误、重试或失败通知', async () => {
    await clear();
    const sub = await subscription(true);
    await queueJob(sub.id);
    const { webExecutor } = await import('../web-executor-client.js');
    const { runCaptureWorkerTick } = await import('../worker.js');
    const originalCapture = webExecutor.capture;
    let arrived!: () => void;
    let reject!: (error: Error) => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    webExecutor.capture = async () => { arrived(); return new Promise((_resolve, fail) => { reject = fail; }); };
    const running = runCaptureWorkerTick();
    try {
      await waiting;
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${sub.id}/archive` })).statusCode, 204);
    } finally {
      reject(new Error('网页返回 HTTP 503'));
      await running;
      webExecutor.capture = originalCapture;
    }
    assert.equal((await getSubscription(sub.id))!.last_error, null);
    assert.equal(await n('jobs', sub.id), 0);
    assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_outbox'))!.n), 0);
  });

  await t.test('较早批次未就绪时，后续已就绪批次仍正常完成且只通知一次', async () => {
    await clear();
    const sub = await subscription();
    const blocked = await batch(sub.id);
    const archiveId = await entry(sub.id, blocked);
    await db.run("INSERT INTO magnet_jobs (archive_entry_id, status, requested_at) VALUES (?, 'queued', ?)", [archiveId, now()]);
    const ready = await batch(sub.id);
    let deliveries = 0;
    globalThis.fetch = async () => { deliveries++; return new Response('{}'); };
    assert.equal((await runnableHandlers()).notification, true);
    await notifications.runNotificationWorkerTick();
    assert.equal((await db.get<{ status: string }>('SELECT status FROM full_scan_batches WHERE id=?', [ready]))!.status, 'completed');
    await notifications.runNotificationWorkerTick();
    assert.equal(deliveries, 1);
    assert.equal((await runnableHandlers()).notification, false);
  });
}

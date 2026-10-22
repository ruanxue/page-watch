import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { createPostgresPool, pgClientFor } from '../pg-connection.js';
import { ensurePostgresSchema } from '../postgres-schema.js';
import type { DatabaseClient, Subscription } from '../db.js';

// 绝不加载 .env 或日常引导文件来寻找测试连接。
const connection = process.env.PAGE_WATCH_TEST_DATABASE_URL;
if (!connection) throw new Error('必须显式配置 PAGE_WATCH_TEST_DATABASE_URL，不能使用日常数据库执行集成测试。');
const url = new URL(connection);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/(^|[_-])test([_-]|$)/i.test(decodeURIComponent(url.pathname.slice(1)))) {
  throw new Error('集成测试连接必须指向名称包含独立 test 字段的 PostgreSQL 专用测试库。');
}
const controlSettings = {
  host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), connectionLimit: 3
};

test('PostgreSQL 真实数据库回归', { timeout: 120_000 }, async (t) => {
  const control = createPostgresPool(controlSettings);
  const database = `pagewatch_test_${randomUUID().replaceAll('-', '')}`;
  const directory = mkdtempSync(join(tmpdir(), 'pagewatch-postgres-test-'));
  const originalEnvironment = { ...process.env };
  const originalFetch = globalThis.fetch;
  let created = false;
  let closeDatabase: (() => Promise<void>) | undefined;
  let flushProgress: (() => Promise<void>) | undefined;
  let closeBrowser: (() => Promise<void>) | undefined;
  const app = Fastify();
  try {
    await control.query(`CREATE DATABASE "${database}"`);
    created = true;
    for (const key of Object.keys(process.env)) if (/^(MYSQL_|DATABASE_|DB_DRIVER$|WORKER_EVENT_)/.test(key)) delete process.env[key];
    Object.assign(process.env, {
      DOTENV_CONFIG_PATH: join(directory, 'absent.env'), PAGE_WATCH_BOOTSTRAP_PATH: join(directory, 'database-bootstrap.json'),
      PAGE_WATCH_DATABASE_INITIALIZE: '0', PAGE_WATCH_WORKER_AUTOSTART: '0', PAGE_WATCH_TELEMETRY_BUFFERED: '0',
      DATABASE_HOST: controlSettings.host, DATABASE_PORT: String(controlSettings.port), DATABASE_NAME: database,
      DATABASE_USER: controlSettings.user, DATABASE_PASSWORD: controlSettings.password, DATABASE_CONNECTION_LIMIT: '3'
    });
    const databaseModule = await import('../db.js');
    const { db, initializeDatabase, getSubscription, setSetting, getSetting, queueJob, queueDownloadJob, queueLibrarySyncJob, JOB_PRIORITY, maintainPerformanceMetrics, getExecutionEngineQueueState, rebuildSubscriptionProgress } = databaseModule;
    closeDatabase = databaseModule.closeDatabase;
    flushProgress = databaseModule.flushSubscriptionProgressRebuilds;
    const fixturePool = createPostgresPool({ ...controlSettings, database });
    try {
      await ensurePostgresSchema(fixturePool);
      const { encryptSecret, readApplicationEncryptionKey } = await import('../secret-storage.js');
      const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
      process.env.APP_ENCRYPTION_KEY = key;
      await fixturePool.query('INSERT INTO app_settings ("key", value, updated_at) VALUES ($1,$2,$3)', ['qbit_api_key', encryptSecret('迁移后保留的凭据', readApplicationEncryptionKey(key)), new Date().toISOString()]);
    } finally { await fixturePool.end(); }
    await initializeDatabase();
    const { registerSubscriptionsRoutes } = await import('../routes/subscriptions.js');
    const { registerRulesRoutes } = await import('../routes/rules.js');
    const { registerArchiveRoutes } = await import('../routes/archive.js');
    const { registerOperationsRoutes } = await import('../routes/operations.js');
    registerSubscriptionsRoutes(app, { wakeEngine: async () => {} });
    registerRulesRoutes(app);
    registerArchiveRoutes(app);
    await registerOperationsRoutes(app);
    const { findArchiveCodeMatches, backfillArchiveCodeIndex } = await import('../archive-code-index.js');
    const { productCodeKeys } = await import('../code-search-parser.js');
    const { runnableHandlers } = await import('../engine-queue.js');
    const { maintainDatabase } = await import('../database-maintenance.js');
    const capture = await import('../capture.js');
    closeBrowser = capture.closeCaptureBrowser;
    const notifications = await import('../notifications.js');
    const base = {
      name: '测试订阅', url: 'https://8.8.8.8/movies', ruleFamily: 'legacy_custom', selector: '.code',
      contentSource: 'attribute', attributeName: 'data-code', titleSelector: '.title', resultMode: 'all', renderMode: 'static',
      scheduleType: 'daily', scheduleTime: '09:00', isActive: true
    };
    async function createSubscription(overrides: Record<string, unknown> = {}) {
      const response = await app.inject({ method: 'POST', url: '/api/subscriptions', payload: { ...base, ...overrides } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<Subscription>();
    }
    async function archive(subscriptionId: number, content = `TEST-${Date.now()}`, title: string | null = null) {
      return (await db.run(`INSERT INTO archive_entries (subscription_id, content, title, content_hash, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [subscriptionId, content, title, createHash('sha256').update(randomUUID()).digest('hex'), new Date().toISOString(), new Date().toISOString()])).lastInsertRowid;
    }
    const count = async (table: string) => Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`))!.n);

    await t.test('初始化、数据结构、自增编号及既有加密凭据正常', async () => {
      const row = await db.get<{ version: string }>("SELECT current_setting('server_version') AS version");
      assert.match(row!.version, /^18\./);
      assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"))!.n), 23);
      assert.equal(getSetting('qbit_api_key'), '迁移后保留的凭据');
    });

    const subscription = await createSubscription();
    await t.test('订阅名称、时间、读取方式、启停和分页切换均可保存且不删除档案', async () => {
      await archive(subscription.id);
      await db.run('UPDATE subscriptions SET initial_scan_completed=1, initial_scan_total=5, initial_scan_pages_completed=5, next_scheduled_at=? WHERE id=?', ['2099-01-01T00:00:00.000Z', subscription.id]);
      for (const changes of [{ name: '新名字' }, { scheduleTime: '10:30' }, { renderMode: 'dynamic' }, { isActive: false }]) {
        const result = await app.inject({ method: 'PUT', url: `/api/subscriptions/${subscription.id}`, payload: { ...base, ...changes } });
        assert.equal(result.statusCode, 200, result.body);
      }
      const added = await app.inject({ method: 'PUT', url: `/api/subscriptions/${subscription.id}`, payload: { ...base, paginationSelector: '#pages', paginationMatchPattern: '/\\s*(\\d+)' } });
      assert.equal(added.statusCode, 200, added.body);
      assert.equal(added.json().initial_scan_completed, 0);
      assert.equal(added.json().initial_scan_total, null);
      assert.equal(added.json().initial_scan_pages_completed, 0);
      const removed = await app.inject({ method: 'PUT', url: `/api/subscriptions/${subscription.id}`, payload: base });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(removed.json().initial_scan_completed, 1);
      assert.equal(await count('archive_entries'), 1);
    });

    await t.test('并发重复下载不会破坏事务，手动优先级只提升等待任务', async () => {
      const entry = await archive(subscription.id);
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const results = await Promise.all([JOB_PRIORITY.normal, JOB_PRIORITY.manual].map((priority) => db.transaction(async (tx) => {
        let first = true;
        const racing: DatabaseClient = { ...tx, async get<T>(sql: string, params?: unknown[]) {
          const row = await tx.get<T>(sql, params);
          if (first) { first = false; if (++arrived === 2) release(); await barrier; }
          return row;
        } };
        const queued = await queueDownloadJob(entry, racing, priority);
        await tx.run('INSERT INTO app_settings ("key",value,updated_at) VALUES (?, ?, ?)', [`并发事务-${priority}`, '仍可提交', new Date().toISOString()]);
        return queued;
      })));
      assert.equal(results.filter((r) => r.queued).length, 1);
      assert.equal(results[0].id, results[1].id);
      assert.equal((await db.get<{ priority: number }>('SELECT priority FROM download_jobs WHERE id=?', [results[0].id]))!.priority, 100);
      await db.run("UPDATE download_jobs SET status='running', priority=0 WHERE id=?", [results[0].id]);
      await queueDownloadJob(entry, db, JOB_PRIORITY.manual);
      assert.equal((await db.get<{ priority: number }>('SELECT priority FROM download_jobs WHERE id=?', [results[0].id]))!.priority, 0);
    });

    await t.test('任务竞争最多重试三次，其他 SQL 错误保留原错误且整笔回滚', async () => {
      let inserts = 0;
      const racing = { get: async () => undefined, all: async () => [], run: async () => { inserts += 1; return { changes: 0, lastInsertRowid: 0 }; } } as DatabaseClient;
      await assert.rejects(queueJob(1, JOB_PRIORITY.normal, racing), /任务状态正在变化/);
      assert.equal(inserts, 3);
      await assert.rejects(db.transaction(async (tx) => {
        await tx.run('INSERT INTO app_settings ("key",value,updated_at) VALUES (?, ?, ?)', ['应当回滚', '1', new Date().toISOString()]);
        await tx.run('INSERT INTO missing_table_for_test (id) VALUES (?)', [1]);
      }), (error: any) => error.code === '42P01');
      assert.equal(await db.get('SELECT value FROM app_settings WHERE "key"=?', ['应当回滚']), undefined);
    });

    await t.test('并发影视库同步只有一项，运行标记阻止重复调度', async () => {
      const results = await Promise.all([queueLibrarySyncJob('scheduled'), queueLibrarySyncJob('manual', JOB_PRIORITY.manual)]);
      assert.equal(results[0].id, results[1].id);
      assert.equal(results.filter((r) => r.queued).length, 1);
      await setSetting('jellyfin_enabled', '1');
      await setSetting('jellyfin_library_ids', '["test-library"]');
      await setSetting('jellyfin_last_sync_attempt_at', '2000-01-01T00:00:00.000Z');
      await db.run("UPDATE library_sync_jobs SET status='running', started_at=?, heartbeat_at=? WHERE id=?", [new Date().toISOString(), new Date().toISOString(), results[0].id]);
      assert.equal((await runnableHandlers()).library, false);
      await db.run("UPDATE library_sync_jobs SET status='completed' WHERE id=?", [results[0].id]);
      assert.equal((await runnableHandlers()).library, true);
      await setSetting('jellyfin_enabled', '0');
    });

    await t.test('30 秒和 2 分钟重试在到期前不运行、到期后可以运行', async () => {
      await db.run('UPDATE subscriptions SET is_active=0');
      const queued = await queueJob(subscription.id);
      for (const delay of [30_000, 120_000]) {
        await db.run('UPDATE jobs SET retry_after=? WHERE id=?', [new Date(Date.now() + delay).toISOString(), queued.id]);
        assert.equal((await runnableHandlers()).capture, false);
        await db.run('UPDATE jobs SET retry_after=? WHERE id=?', [new Date(Date.now() - 1_000).toISOString(), queued.id]);
        assert.equal((await runnableHandlers()).capture, true);
      }
      await db.run("UPDATE jobs SET status='completed' WHERE id=?", [queued.id]);
    });

    await t.test('指标清理、心跳时限和清理失败后的统计校准正常', async () => {
      await db.run(`INSERT INTO performance_metrics (granularity,bucket_start,scope,metric) VALUES
        ('minute',(now() AT TIME ZONE 'UTC')-INTERVAL '8 days','capture','old'), ('minute',(now() AT TIME ZONE 'UTC'),'capture','new')`);
      await maintainPerformanceMetrics();
      assert.equal(await count('performance_metrics'), 1);
      await db.run('INSERT INTO worker_heartbeats (worker_name,status,detail,last_seen_at) VALUES (?, ?, ?, ?)', ['capture', 'busy', '测试', new Date().toISOString()]);
      assert.equal((await getExecutionEngineQueueState()).busyWorkers, 1);
      await db.run('UPDATE worker_heartbeats SET last_seen_at=?', [new Date(Date.now() - 60_000).toISOString()]);
      assert.equal((await getExecutionEngineQueueState()).busyWorkers, 0);
      await db.run('UPDATE subscription_progress SET archive_total=0 WHERE subscription_id=?', [subscription.id]);
      await db.run('ALTER TABLE performance_metrics RENAME TO maintenance_failure_fixture');
      try { await maintainDatabase(); }
      finally { await db.run('ALTER TABLE maintenance_failure_fixture RENAME TO performance_metrics'); }
      assert.equal((await db.get<{ n: number }>('SELECT archive_total AS n FROM subscription_progress WHERE subscription_id=?', [subscription.id]))!.n, 2);
    });

    await t.test('索引补齐前跨页精确查重，完成后仅走索引', async () => {
      const target = await archive(subscription.id, 'FJIN-073');
      const alias = await archive(subscription.id, 'OTHER-10', '影片 MEYD568');
      for (let offset = 0; offset < 201; offset += 50) {
        const size = Math.min(50, 201 - offset);
        await db.run(`INSERT INTO archive_entries (subscription_id,content,content_hash,first_seen_at,updated_at) VALUES ${Array.from({ length: size }, () => '(?, ?, ?, ?, ?)').join(', ')}`,
          Array.from({ length: size }, () => [subscription.id, 'FJIN-0730', createHash('sha256').update(randomUUID()).digest('hex'), new Date().toISOString(), new Date().toISOString()]).flat());
      }
      await setSetting('archive_entry_codes_backfill_v1', '0');
      for (const code of ['FJIN-073', 'FJIN073']) assert.deepEqual((await findArchiveCodeMatches(db, productCodeKeys(code), subscription.id, false)).map((r) => r.id), [target]);
      assert.deepEqual((await findArchiveCodeMatches(db, productCodeKeys('MEYD-568'), subscription.id, false)).map((r) => r.id), [alias]);
      await backfillArchiveCodeIndex();
      let reads = 0;
      const tracked = { ...db, async all<T>(sql: string, params?: unknown[]) { reads += 1; assert.match(sql, /FROM archive_entry_codes/); return db.all<T>(sql, params); } };
      assert.deepEqual((await findArchiveCodeMatches(tracked, ['fjin-073'], subscription.id)).map((r) => r.id), [target]);
      assert.equal(reads, 1);
    });

    await notifications.saveNotificationSettings({ ...notifications.getNotificationSettings(), enabled: true, channel: 'webhook', webhookUrl: 'https://8.8.8.8/notification' });
    await t.test('普通检查、预览、首次全量和失败断点续跑不重复入档', async () => {
      let failSecondPage = true;
      let ordinaryCodes = ['AAA-001', 'AAA-002'];
      const requested: number[] = [];
      globalThis.fetch = async (input) => {
        const target = new URL(String(input));
        const page = Number(target.searchParams.get('page') || 1);
        if (target.pathname === '/notification') return new Response('{}', { status: 200 });
        requested.push(page);
        if (target.pathname === '/full' && page === 2 && failSecondPage) return new Response('测试中断', { status: 503 });
        const codes = target.pathname === '/full' ? [['BBB-001', 'BBB-002'], ['BBB-002', 'BBB-003'], ['BBB-004']][page - 1] : ordinaryCodes;
        return new Response(`<title>测试页面</title><b id="pages">1 / 3</b>${codes.map((code) => `<a class="code" data-code="${code}" href="/${code}"><span class="title">标题 ${code}</span></a>`).join('')}`, { headers: { 'content-type': 'text/html' } });
      };
      const ordinary = await createSubscription();
      assert.equal((await capture.captureSubscription(ordinary)).addedCount, 2);
      assert.equal((await capture.captureSubscription((await getSubscription(ordinary.id))!)).addedCount, 0);
      ordinaryCodes = [...ordinaryCodes, 'AAA-003'];
      const beforeNotifications = await count('notification_outbox');
      assert.equal((await capture.captureSubscription((await getSubscription(ordinary.id))!)).addedCount, 1);
      assert.equal(await count('notification_outbox'), beforeNotifications + 1);
      const beforePreview = await count('archive_entries');
      assert.equal((await capture.previewCapture((await getSubscription(ordinary.id))!)).items.length, 3);
      assert.equal(await count('archive_entries'), beforePreview);
      const full = await createSubscription({ url: 'https://8.8.8.8/full', paginationSelector: '#pages', paginationMatchPattern: '/\\s*(\\d+)' });
      await assert.rejects(capture.captureSubscription(full), /503/);
      assert.equal((await getSubscription(full.id))!.initial_scan_next_page, 2);
      assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM archive_entries WHERE subscription_id=?', [full.id]))!.n), 0);
      requested.length = 0;
      failSecondPage = false;
      assert.equal((await capture.captureSubscription((await getSubscription(full.id))!)).addedCount, 4);
      assert.deepEqual(requested, [2, 3]);
      assert.equal((await getSubscription(full.id))!.last_scan_added_count, 4);
      assert.equal((await capture.captureSubscription((await getSubscription(full.id))!)).addedCount, 0);
      assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM archive_entries WHERE subscription_id=?', [full.id]))!.n), 4);
    });

    await t.test('规则组更新沿用到订阅，单独覆盖的读取方式保留', async () => {
      const groups = (await app.inject('/api/rule-groups')).json();
      const group = await app.inject({ method: 'POST', url: '/api/rule-groups', payload: { name: '回归测试规则', description: '', sites: [], steps: [], reading: groups.groups[0].reading } });
      assert.equal(group.statusCode, 201, group.body);
      const saved = group.json().group;
      const inherited = await createSubscription({ ruleFamily: 'missav', presetId: saved.id });
      const overridden = await createSubscription({ ruleFamily: 'missav', presetId: saved.id, renderModeOverride: 'static' });
      const changed = await app.inject({ method: 'PATCH', url: `/api/rule-groups/${saved.id}`, payload: { reading: { ...saved.reading, renderMode: 'dynamic' } } });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.equal((await getSubscription(inherited.id))!.render_mode, 'dynamic');
      assert.equal((await getSubscription(overridden.id))!.render_mode, 'static');
      assert.equal((await getSubscription(inherited.id))!.schedule_time, base.scheduleTime);
    });

    await t.test('重复失败通知去重、数据库回滚不会遗留通知', async () => {
      const payload = notifications.createOperationFailureNotification({ operation: '数据库回归', error: '同一错误', subscription: { id: subscription.id } });
      const first = await db.transaction((tx) => notifications.enqueueNotification(payload, tx));
      const second = await db.transaction((tx) => notifications.enqueueNotification(payload, tx));
      assert.equal(first.queued, true);
      assert.equal(second.deduped, true);
      const before = await count('notification_outbox');
      await assert.rejects(db.transaction(async (tx) => {
        await notifications.enqueueNotification(notifications.createDownloadCompletedNotification({ subscription: { id: subscription.id }, content: 'TEST-900' }), tx);
        throw new Error('主动回滚');
      }), /主动回滚/);
      assert.equal(await count('notification_outbox'), before);
    });

    await t.test('已完成下载保持终态，观察器不查询它的远端状态', async () => {
      const entry = await archive(subscription.id, 'DONE-001');
      await db.run("UPDATE archive_entries SET download_status='completed', download_torrent_hash=? WHERE id=?", ['a'.repeat(40), entry]);
      await setSetting('qbit_enabled', '1');
      let remoteCalls = 0;
      globalThis.fetch = async () => { remoteCalls += 1; throw new Error('不应访问远端'); };
      const { observeQbittorrentDownloads } = await import('../download-worker.js');
      await observeQbittorrentDownloads();
      assert.equal(remoteCalls, 0);
      assert.equal((await db.get<{ download_status: string }>('SELECT download_status FROM archive_entries WHERE id=?', [entry]))!.download_status, 'completed');
      await setSetting('qbit_enabled', '0');
    });

    await t.test('运行中心、档案筛选与分页均能读取真实数据库', async () => {
      await rebuildSubscriptionProgress();
      for (const endpoint of ['/api/tasks/summary', '/api/tasks/active', '/api/tasks/history', '/api/subscriptions', `/api/archive?subscriptionId=${subscription.id}&q=fjin&page=1&pageSize=10`]) {
        const response = await app.inject(endpoint);
        assert.equal(response.statusCode, 200, `${endpoint}: ${response.body}`);
      }
    });

    await t.test('安装接口接受省略类型或 PostgreSQL，拒绝旧类型且保留既有数据', async () => {
      const before = await count('archive_entries');
      const code = `
        import Fastify from 'fastify';
        import fs from 'node:fs';
        const { registerAuthRoutes } = await import('./server/routes/auth.ts');
        const { closeDatabase } = await import('./server/db.ts');
        const input = JSON.parse(process.env.PAGE_WATCH_TEST_SETUP_INPUT);
        const app = Fastify();
        registerAuthRoutes(app, {startOperationalServices: () => {}});
        try {
          const invalid = await app.inject({method:'POST', url:'/api/setup/database', payload:{...input,driver:'mysql'}});
          const omitted = await app.inject({method:'POST', url:'/api/setup/database', payload:input});
          const explicit = await app.inject({method:'POST', url:'/api/setup/database', payload:{...input,driver:'postgres'}});
          const saved = JSON.parse(fs.readFileSync(process.env.PAGE_WATCH_BOOTSTRAP_PATH, 'utf8'));
          console.log(JSON.stringify({invalid:invalid.statusCode,omitted:omitted.statusCode,explicit:explicit.statusCode,driver:saved.settings.driver}));
        } finally {await app.close();await closeDatabase();}
      `;
      const environment = { ...process.env };
      for (const key of Object.keys(environment)) if (/^(MYSQL_|DATABASE_|DB_DRIVER$)/.test(key)) delete environment[key];
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
        env: { ...environment, PAGE_WATCH_BOOTSTRAP_PATH: join(directory, 'setup.json'), PAGE_WATCH_TEST_SETUP_INPUT: JSON.stringify({ ...controlSettings, database }) }
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout.trim()), { invalid: 400, omitted: 201, explicit: 201, driver: 'postgres' });
      assert.equal(await count('archive_entries'), before);
    });

    await t.test('断开自己的空闲连接后不退出进程，下次查询重新连接', async () => {
      const pool = createPostgresPool({ ...controlSettings, database, connectionLimit: 1 });
      try {
        assert.equal(pool.listenerCount('error'), 1);
        const client = await pool.connect();
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        client.release();
        const disconnected = once(pool, 'error', { signal: AbortSignal.timeout(5_000) });
        await control.query('SELECT pg_terminate_backend($1)', [pid]);
        await disconnected;
        assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
      } finally { await pool.end(); }
    });

    await t.test('事务中途断线只回滚，不自动重放写入', async () => {
      await assert.rejects(db.transaction(async (tx) => {
        const pid = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
        await tx.run('INSERT INTO app_settings ("key",value,updated_at) VALUES (?, ?, ?)', ['断线写入不可重放', '1', new Date().toISOString()]);
        await control.query('SELECT pg_terminate_backend($1)', [pid]);
        await tx.get('SELECT 1');
      }));
      assert.equal(await db.get('SELECT value FROM app_settings WHERE "key"=?', ['断线写入不可重放']), undefined);
      assert.equal((await db.get<{ value: number }>('SELECT 1 AS value'))!.value, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [closeBrowser, flushProgress, () => app.close(), closeDatabase]) {
      try { await cleanup?.(); } catch (error) { cleanupErrors.push(error); }
    }
    try { if (created) await control.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    catch (error) { cleanupErrors.push(error); }
    finally { await control.end(); }
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    rmSync(directory, { recursive: true, force: true });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '临时测试资源清理失败。');
  }
});

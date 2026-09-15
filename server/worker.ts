import { webExecutor } from './web-executor-client.js';
import { appendRuntimeLog, db, getSubscription, JOB_PRIORITY, queueJob, recordPerformanceMetric, refreshSettings, reportWorkerHeartbeat, type Subscription, type WorkerTaskContext } from './db.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription, retryReason } from './retry.js';
import { notifyLive } from './live-events.js';
import { isExecutionEngineDraining } from './engine-drain.js';

const POLL_MS = 10_000;

function scheduledAfter(subscription: Subscription, last: Date) {
  if (subscription.schedule_type === 'hourly') {
    return new Date(last.getTime() + subscription.schedule_interval_hours * 60 * 60 * 1000);
  }
  const [hours, minutes] = subscription.schedule_time.split(':').map(Number);
  const next = new Date(last);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);
  if (subscription.schedule_type === 'daily') {
    if (next <= last) next.setDate(next.getDate() + 1);
    return next;
  }
  const daysUntil = (subscription.schedule_weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + daysUntil);
  if (next <= last) next.setDate(next.getDate() + 7);
  return next;
}

function scheduleStaggerMinutes(subscription: Subscription) {
  // Stable and tiny: recurring work does not bunch up after a restart, while
  // a manually started task remains immediate.
  return (subscription.id * 17) % 4;
}

function nextScheduledAt(subscription: Subscription, now: Date) {
  if (subscription.schedule_type === 'hourly') {
    const anchor = subscription.next_scheduled_at ? new Date(subscription.next_scheduled_at) : new Date(subscription.last_checked_at ?? subscription.updated_at);
    let next = new Date(anchor.getTime() + subscription.schedule_interval_hours * 3_600_000);
    while (next <= now) next = new Date(next.getTime() + subscription.schedule_interval_hours * 3_600_000);
    return next;
  }
  const base = new Date(now);
  const [hours, minutes] = subscription.schedule_time.split(':').map(Number);
  base.setHours(hours, minutes + scheduleStaggerMinutes(subscription), 0, 0);
  if (subscription.schedule_type === 'daily') {
    if (base <= now) base.setDate(base.getDate() + 1);
    return base;
  }
  const days = (subscription.schedule_weekday - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + days);
  if (base <= now) base.setDate(base.getDate() + 7);
  return base;
}

async function enqueueDueSubscriptions() {
  if (isExecutionEngineDraining()) return;
  const subscriptions = await db.all<Subscription>('SELECT * FROM subscriptions WHERE is_active = 1');
  const now = new Date();
  for (const subscription of subscriptions) {
    const due = subscription.next_scheduled_at ? new Date(subscription.next_scheduled_at) : scheduledAfter(subscription, new Date(subscription.last_checked_at ?? subscription.updated_at));
    if (now >= due) {
      const queued = await queueJob(subscription.id, JOB_PRIORITY.normal);
      const next = nextScheduledAt(subscription, now);
      await db.run('UPDATE subscriptions SET next_scheduled_at = ? WHERE id = ?', [next.toISOString(), subscription.id]);
      if (queued.queued) await appendRuntimeLog({ level: 'info', source: 'queue', subscriptionId: subscription.id, message: `计划检查已排队（${subscription.schedule_type === 'hourly' ? '按小时' : `${scheduleStaggerMinutes(subscription)} 分钟错峰`}）。` });
    }
  }
}

async function runNextJob() {
  if (isExecutionEngineDraining()) return;
  const now = new Date().toISOString();
  const job = await db.get<{ id: number; subscription_id: number; attempt_count: number; priority: number }>("SELECT * FROM jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?) ORDER BY priority DESC, requested_at ASC, id ASC LIMIT 1", [now]);
  if (!job) return;
  if (isExecutionEngineDraining()) return;
  const started = await db.run("UPDATE jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [now, job.id]);
  if (!started.changes) return;
  let subscription: Subscription | undefined;
  const startedAtMs = Date.now();
  try {
    subscription = await getSubscription(job.subscription_id);
    if (!subscription) throw new Error('订阅已删除。');
    const fullScan = Boolean(subscription.pagination_selector && !subscription.initial_scan_completed);
    activeTask = { kind: fullScan ? 'full_scan' : 'check', subscriptionId: subscription.id, current: fullScan ? subscription.initial_scan_pages_completed : null, total: fullScan ? subscription.initial_scan_total : null, label: fullScan ? `下一个页面：${subscription.initial_scan_next_page}` : '正在读取网页内容' };
    await heartbeat();
    await appendRuntimeLog({ level: 'info', source: 'worker', subscriptionId: subscription.id, jobId: job.id, message: fullScan ? (subscription.initial_scan_run_id ? `恢复全量检查：从第 ${subscription.initial_scan_next_page} 页继续。` : '开始全量检查。') : '开始检查第一页。' });
    const result = await webExecutor.capture(subscription, job.priority);
    await db.run("UPDATE jobs SET status = 'completed', finished_at = ? WHERE id = ?", [new Date().toISOString(), job.id]);
    const additions = result.addedCount ? `，新增 ${result.addedCount} 条内容` : '，没有新增内容';
    await appendRuntimeLog({ level: 'success', source: 'worker', subscriptionId: subscription.id, jobId: job.id, message: `${result.totalPages > 1 ? `全量检查完成，共读取 ${result.totalPages} 页` : '检查完成'}，提取 ${result.itemCount} 项${additions}。` });
    await recordPerformanceMetric({ scope: 'capture', metric: 'processed', dimension: fullScan ? 'full_scan' : 'check', durationMs: Date.now() - startedAtMs }).catch(() => undefined);
    activeTask = null;
    notifyLive('archive', subscription.id);
    notifyLive('subscriptions');
    notifyLive('tasks');
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知抓取错误';
    const attempt = job.attempt_count + 1;
    const shouldRetry = attempt < MAX_JOB_ATTEMPTS && isRetryableJobError(error);
    const retryAt = new Date(Date.now() + retryDelayMs(attempt)).toISOString();
    if (subscription) {
      await db.run('UPDATE subscriptions SET last_error = ? WHERE id = ?', [shouldRetry ? `${retryDescription(attempt)}：${message}` : message, job.subscription_id]);
    }
    if (shouldRetry) {
      await db.run("UPDATE jobs SET status = 'queued', started_at = NULL, finished_at = NULL, error = ?, attempt_count = ?, retry_after = ? WHERE id = ?", [message, attempt, retryAt, job.id]);
      await appendRuntimeLog({ level: 'info', source: 'worker', subscriptionId: job.subscription_id, jobId: job.id, message: `检查暂时失败，${retryDescription(attempt)}：${message}` });
      await recordPerformanceMetric({ scope: 'capture', metric: 'retry', dimension: retryReason(error) }).catch(() => undefined);
    } else {
      await db.run("UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [new Date().toISOString(), message, attempt, job.id]);
      await appendRuntimeLog({ level: 'error', source: 'worker', subscriptionId: job.subscription_id, jobId: job.id, message: `检查失败：${message}` });
      await recordPerformanceMetric({ scope: 'capture', metric: 'processed', dimension: 'failed', durationMs: Date.now() - startedAtMs }).catch(() => undefined);
    }
    console.error(`Job ${job.id} failed: ${message}`);
    if (subscription) {
      notifyLive('archive', subscription.id);
      notifyLive('subscriptions');
      notifyLive('tasks');
    }
    activeTask = null;
  }
}

let working = false;
let activeTask: WorkerTaskContext | null = null;
let lastInfrastructureLogAt = 0;
let lastStalledRecoveryAt = 0;

async function heartbeat() {
  await reportWorkerHeartbeat('capture', activeTask?.label ?? '检查计划与网页抓取', activeTask ? 'busy' : 'ready', activeTask).catch(() => undefined);
}

async function reportInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : '未知数据库或 Worker 错误';
  console.error(`Check worker tick failed: ${message}`);
  // A database reconnect can briefly fail too, so logging must never make the
  // worker exit. Limit these recovery notices to one per minute.
  if (Date.now() - lastInfrastructureLogAt < 60_000) return;
  lastInfrastructureLogAt = Date.now();
  try { await appendRuntimeLog({ level: 'error', source: 'system', message: `检查 Worker 本轮未完成，将自动重试：${message}` }); }
  catch (logError) { console.error(`Unable to save worker recovery log: ${logError instanceof Error ? logError.message : String(logError)}`); }
}

async function recoverStalledJobs() {
  if (Date.now() - lastStalledRecoveryAt < 60_000) return;
  lastStalledRecoveryAt = Date.now();
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.run("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < ?", [cutoff]);
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await heartbeat();
    if (isExecutionEngineDraining()) return;
    await refreshSettings();
    await recoverStalledJobs();
    await enqueueDueSubscriptions();
    await runNextJob();
  } catch (error) {
    await reportWorkerHeartbeat('capture', '检查 Worker 遇到基础设施错误', 'error').catch(() => undefined);
    await reportInfrastructureError(error);
  } finally {
    working = false;
  }
}

void appendRuntimeLog({ level: 'info', source: 'system', message: '检查 Worker 已启动。' })
  .catch((error) => console.error(`Unable to save worker startup log: ${error instanceof Error ? error.message : String(error)}`));
console.log('Page Watch worker started');
void tick();
setInterval(() => void tick(), POLL_MS);
const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
heartbeatTimer.unref();

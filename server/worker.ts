import { captureSubscription } from './capture.js';
import { appendRuntimeLog, db, getSubscription, queueJob, refreshSettings, reportWorkerHeartbeat, type Subscription } from './db.js';
import { isRetryableJobError, MAX_JOB_ATTEMPTS, retryDelayMs, retryDescription } from './retry.js';

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

async function enqueueDueSubscriptions() {
  const subscriptions = await db.all<Subscription>('SELECT * FROM subscriptions WHERE is_active = 1');
  const now = Date.now();
  for (const subscription of subscriptions) {
    const anchor = subscription.last_checked_at ?? subscription.updated_at;
    if (now >= scheduledAfter(subscription, new Date(anchor)).getTime()) await queueJob(subscription.id);
  }
}

async function runNextJob() {
  const now = new Date().toISOString();
  const job = await db.get<{ id: number; subscription_id: number; attempt_count: number }>("SELECT * FROM jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= ?) ORDER BY requested_at ASC LIMIT 1", [now]);
  if (!job) return;
  const started = await db.run("UPDATE jobs SET status = 'running', started_at = ?, retry_after = NULL WHERE id = ? AND status = 'queued'", [now, job.id]);
  if (!started.changes) return;
  let subscription: Subscription | undefined;
  try {
    subscription = await getSubscription(job.subscription_id);
    if (!subscription) throw new Error('订阅已删除。');
    const fullScan = Boolean(subscription.pagination_selector && !subscription.initial_scan_completed);
    await appendRuntimeLog({ level: 'info', source: 'worker', subscriptionId: subscription.id, jobId: job.id, message: fullScan ? '开始全量检查。' : '开始检查第一页。' });
    const result = await captureSubscription(subscription);
    await db.run("UPDATE jobs SET status = 'completed', finished_at = ? WHERE id = ?", [new Date().toISOString(), job.id]);
    const additions = result.addedCount ? `，新增 ${result.addedCount} 条内容` : '，没有新增内容';
    await appendRuntimeLog({ level: 'success', source: 'worker', subscriptionId: subscription.id, jobId: job.id, message: `${result.totalPages > 1 ? `全量检查完成，共读取 ${result.totalPages} 页` : '检查完成'}，提取 ${result.itemCount} 项${additions}。` });
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
    } else {
      await db.run("UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, attempt_count = ?, retry_after = NULL WHERE id = ?", [new Date().toISOString(), message, attempt, job.id]);
      await appendRuntimeLog({ level: 'error', source: 'worker', subscriptionId: job.subscription_id, jobId: job.id, message: `检查失败：${message}` });
    }
    console.error(`Job ${job.id} failed: ${message}`);
  }
}

let working = false;
let lastInfrastructureLogAt = 0;
let lastStalledRecoveryAt = 0;

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
    await reportWorkerHeartbeat('capture', '检查计划与网页抓取').catch(() => undefined);
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

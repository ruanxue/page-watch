import { db } from './db.js';
import { notifyLive } from './live-events.js';

const queues = {
  capture: 'jobs', release: 'release_jobs', magnet: 'magnet_jobs',
  download: 'download_jobs', library: 'library_jobs'
} as const;

// 任务运行超过十分钟且处理器已经失去心跳才可恢复，不能重放仍在正常执行的长任务。
export async function recoverStalledJobs(worker?: keyof typeof queues, now = new Date()) {
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString();
  const heartbeatCutoff = new Date(now.getTime() - 90_000).toISOString();
  let recovered = 0;
  for (const name of worker ? [worker] : Object.keys(queues) as Array<keyof typeof queues>) {
    const result = await db.run(`UPDATE ${queues[name]} SET status = 'queued', started_at = NULL
      WHERE status = 'running' AND started_at < ? AND NOT EXISTS (
        SELECT 1 FROM worker_heartbeats WHERE worker_name = ? AND status = 'busy' AND last_seen_at >= ?
      )`, [cutoff, name, heartbeatCutoff]);
    recovered += result.changes;
  }
  if (!worker) {
    const result = await db.run(`UPDATE notification_outbox SET status = 'queued', started_at = NULL, next_attempt_at = ?
      WHERE status = 'running' AND started_at < ?`, [now.toISOString(), cutoff]);
    recovered += result.changes;
  }
  if (recovered) notifyLive('tasks');
  return recovered;
}

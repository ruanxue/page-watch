import type { DatabaseClient } from './db.js';
import { nextCalendarCheckAt, type SubscriptionSchedule } from './subscription-schedule.js';

export const SCHEDULE_REPAIR_KEY = 'subscription_schedule_beijing_v1';

// 调用方必须提供事务；唯一标记与计划在同一事务提交，失败时一起回滚。
export async function repairSubscriptionSchedules(tx: DatabaseClient, now = new Date()) {
  const claimed = await tx.run(`INSERT INTO app_settings ("key", value, updated_at) VALUES (?, '1', ?)
    ON CONFLICT ("key") DO NOTHING`, [SCHEDULE_REPAIR_KEY, now.toISOString()]);
  if (!claimed.changes) return 0;
  let lastId = 0;
  let repaired = 0;
  while (true) {
    const rows = await tx.all<SubscriptionSchedule>(`SELECT id, schedule_type, schedule_interval_hours, schedule_time, schedule_weekday,
      next_scheduled_at, last_checked_at, updated_at FROM subscriptions
      WHERE id > ? AND schedule_type IN ('daily', 'weekly') AND next_scheduled_at IS NOT NULL
      ORDER BY id LIMIT 100 FOR UPDATE`, [lastId]);
    if (!rows.length) break;
    for (const subscription of rows) {
      await tx.run('UPDATE subscriptions SET next_scheduled_at = ? WHERE id = ?',
        [nextCalendarCheckAt(subscription, now).toISOString(), subscription.id]);
      repaired++;
    }
    lastId = rows[rows.length - 1].id;
  }
  return repaired;
}

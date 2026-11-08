export const SCHEDULE_TIME_ZONE = 'Asia/Shanghai';
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type SubscriptionSchedule = {
  id: number;
  schedule_type: 'hourly' | 'daily' | 'weekly';
  schedule_interval_hours: number;
  schedule_time: string;
  schedule_weekday: number;
  next_scheduled_at: string | null;
  last_checked_at: string | null;
  updated_at: string;
};

export function scheduleStaggerMinutes(subscription: Pick<SubscriptionSchedule, 'id'>) {
  return (subscription.id * 17) % 4;
}

// 检查计划统一按北京时间解释，不能依赖 Windows、容器或数据库连接的时区。
// 现代北京时间固定为 UTC+8；用 UTC 日期运算避免宿主机的夏令时影响。
export function nextCalendarCheckAt(subscription: SubscriptionSchedule, after: Date) {
  const stagger = scheduleStaggerMinutes(subscription) * 60_000;
  // 先扣除错峰量，保证 23:59 加上错峰后跨日的任务仍归属于原来的计划日期。
  const local = new Date(after.getTime() + BEIJING_OFFSET_MS - stagger);
  const [hours, minutes] = subscription.schedule_time.split(':').map(Number);
  let next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hours, minutes)
    - BEIJING_OFFSET_MS + stagger;
  if (subscription.schedule_type === 'weekly') {
    next += (subscription.schedule_weekday - local.getUTCDay() + 7) % 7 * DAY_MS;
    if (next <= after.getTime()) next += 7 * DAY_MS;
  } else if (next <= after.getTime()) next += DAY_MS;
  return new Date(next);
}

export function scheduledAfter(subscription: SubscriptionSchedule, last: Date) {
  return subscription.schedule_type === 'hourly'
    ? new Date(last.getTime() + subscription.schedule_interval_hours * 3_600_000)
    : nextCalendarCheckAt(subscription, last);
}

export function nextScheduledAt(subscription: SubscriptionSchedule, now: Date) {
  if (subscription.schedule_type !== 'hourly') return nextCalendarCheckAt(subscription, now);
  const anchor = Date.parse(subscription.next_scheduled_at ?? subscription.last_checked_at ?? subscription.updated_at);
  const interval = subscription.schedule_interval_hours * 3_600_000;
  const steps = Math.max(1, Math.floor((now.getTime() - anchor) / interval) + 1);
  return new Date(anchor + steps * interval);
}

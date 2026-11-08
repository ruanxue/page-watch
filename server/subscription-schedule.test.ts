import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { nextCalendarCheckAt, nextScheduledAt, scheduledAfter, scheduleStaggerMinutes, type SubscriptionSchedule } from './subscription-schedule.js';

const base: SubscriptionSchedule = {
  id: 4, schedule_type: 'daily', schedule_interval_hours: 2, schedule_time: '09:00', schedule_weekday: 1,
  next_scheduled_at: null, last_checked_at: null, updated_at: '2026-11-08T00:00:00.000Z'
};

test('每天检查按北京时间计算，时间恰好到期后选择下一天', () => {
  assert.equal(nextCalendarCheckAt(base, new Date('2026-11-08T00:59:59Z')).toISOString(), '2026-11-08T01:00:00.000Z');
  assert.equal(nextCalendarCheckAt(base, new Date('2026-11-08T01:00:00Z')).toISOString(), '2026-11-09T01:00:00.000Z');
  assert.equal(nextCalendarCheckAt(base, new Date('2026-12-31T15:59:59Z')).toISOString(), '2027-01-01T01:00:00.000Z');
});

test('首次计划与后续计划均保留相同的 0～3 分钟错峰', () => {
  for (const id of [3, 4, 5, 6]) {
    const sub = { ...base, id };
    const expected = new Date(Date.UTC(2026, 10, 8, 1, scheduleStaggerMinutes(sub))).toISOString();
    const anchor = new Date('2026-11-08T00:00:00Z');
    assert.equal(scheduledAfter(sub, anchor).toISOString(), expected);
    assert.equal(nextScheduledAt(sub, anchor).toISOString(), expected);
  }
});

test('每周检查按北京时间的星期计算，并处理错峰跨午夜', () => {
  const weekly = { ...base, id: 5, schedule_type: 'weekly' as const };
  assert.equal(nextScheduledAt(weekly, new Date('2026-11-08T11:00:00Z')).toISOString(), '2026-11-09T01:01:00.000Z');
  assert.equal(nextScheduledAt(weekly, new Date('2026-11-09T01:01:00Z')).toISOString(), '2026-11-16T01:01:00.000Z');
  const midnight = { ...base, id: 3, schedule_time: '23:59' };
  assert.equal(nextScheduledAt(midnight, new Date('2026-11-08T16:01:00Z')).toISOString(), '2026-11-08T16:02:00.000Z');
  assert.equal(nextScheduledAt({ ...midnight, schedule_type: 'weekly', schedule_weekday: 0 }, new Date('2026-11-08T16:01:00Z')).toISOString(), '2026-11-08T16:02:00.000Z');
});

test('按小时检查保持原有间隔和锚点，长期停机也可直接计算', () => {
  const sub = { ...base, schedule_type: 'hourly' as const, next_scheduled_at: '2026-11-08T00:00:00.000Z' };
  assert.equal(scheduledAfter(sub, new Date(sub.next_scheduled_at)).toISOString(), '2026-11-08T02:00:00.000Z');
  assert.equal(nextScheduledAt(sub, new Date('2026-11-08T05:00:00Z')).toISOString(), '2026-11-08T06:00:00.000Z');
  assert.equal(nextScheduledAt({ ...sub, next_scheduled_at: '2000-01-01T00:00:00.000Z' }, new Date('2026-11-08T05:00:00Z')).toISOString(), '2026-11-08T06:00:00.000Z');
});

test('UTC、北京时间和纽约宿主环境算出的每日及每周计划完全一致', () => {
  const code = `import {nextScheduledAt} from ${JSON.stringify(new URL('./subscription-schedule.ts', import.meta.url).href)};
    const sub = ${JSON.stringify(base)};
    const now = new Date('2026-11-08T00:00:00Z');
    console.log(JSON.stringify([nextScheduledAt(sub,now),nextScheduledAt({...sub,schedule_type:'weekly'},now)]));`;
  for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      encoding: 'utf8', env: { ...process.env, TZ: timezone }, timeout: 10_000
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ['2026-11-08T01:00:00.000Z', '2026-11-09T01:00:00.000Z']);
  }
});

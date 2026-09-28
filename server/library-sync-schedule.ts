const FAILED_SYNC_RETRY_CAP_MS = 5 * 60_000;

type JellyfinSyncSchedule = {
  lastSyncedAt: string;
  lastAttemptAt: string;
  mediaIndexSyncedAt: string;
  intervalMinutes: number;
  now?: number;
};

export function nextJellyfinSyncAt({
  lastSyncedAt,
  lastAttemptAt,
  mediaIndexSyncedAt,
  intervalMinutes,
  now = Date.now()
}: JellyfinSyncSchedule) {
  const intervalMs = Math.max(1, Number.isFinite(intervalMinutes) ? intervalMinutes : 1) * 60_000;
  const lastSynced = Date.parse(lastSyncedAt);
  const lastAttempt = Date.parse(lastAttemptAt);
  const syncRequired = !mediaIndexSyncedAt || !Number.isFinite(lastSynced) || now - lastSynced >= intervalMs;
  const scheduledAt = syncRequired ? now : lastSynced + intervalMs;

  // A missing local index or an overdue last-success time can persist after a
  // failed sync. Respect the failed-attempt backoff in both cases, otherwise
  // the runner can wake the engine continuously and enqueue the same sync.
  const retryDelayMs = Math.min(intervalMs, FAILED_SYNC_RETRY_CAP_MS);
  const retryAt = Number.isFinite(lastAttempt) ? lastAttempt + retryDelayMs : Number.NEGATIVE_INFINITY;
  return Math.max(scheduledAt, retryAt);
}

export function isJellyfinSyncDue(schedule: JellyfinSyncSchedule) {
  return nextJellyfinSyncAt(schedule) <= (schedule.now ?? Date.now());
}

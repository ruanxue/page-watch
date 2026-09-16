export type LiveEventChannel = 'logs' | 'archive' | 'subscriptions' | 'tasks' | 'task-summary' | 'task-active' | 'services' | 'metrics';

const pending = new Map<string, { channel: LiveEventChannel; subscriptionId?: number }>();
let flushTimer: NodeJS.Timeout | null = null;

function flush() {
  flushTimer = null;
  const events = [...pending.values()];
  pending.clear();
  const token = process.env.WORKER_EVENT_TOKEN;
  if (!token || !events.length) return;
  const base = (process.env.WORKER_EVENT_URL || `http://127.0.0.1:${process.env.PORT || 3030}`).replace(/\/+$/, '');
  for (const event of events) {
    void fetch(`${base}/api/internal/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-page-watch-worker-token': token },
      body: JSON.stringify(event)
    }).catch(() => undefined);
  }
}

/**
 * Workers are separate Node processes even in the single Docker container.
 * The all-in-one supervisor gives them a short-lived private token so they can
 * notify the API immediately without continuously polling MySQL.
 */
export function notifyLive(channel: LiveEventChannel, subscriptionId?: number) {
  if (!process.env.WORKER_EVENT_TOKEN) return;
  pending.set(`${channel}:${subscriptionId ?? ''}`, { channel, subscriptionId });
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 250);
  flushTimer.unref();
}

process.once('beforeExit', flush);

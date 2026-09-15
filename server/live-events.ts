export type LiveEventChannel = 'logs' | 'archive' | 'subscriptions' | 'tasks' | 'metrics';

/**
 * Workers are separate Node processes even in the single Docker container.
 * The all-in-one supervisor gives them a short-lived private token so they can
 * notify the API immediately without continuously polling MySQL.
 */
export function notifyLive(channel: LiveEventChannel, subscriptionId?: number) {
  const token = process.env.WORKER_EVENT_TOKEN;
  if (!token) return;
  const base = (process.env.WORKER_EVENT_URL || `http://127.0.0.1:${process.env.PORT || 3030}`).replace(/\/+$/, '');
  void fetch(`${base}/api/internal/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-page-watch-worker-token': token },
    body: JSON.stringify({ channel, subscriptionId })
  }).catch(() => undefined);
}

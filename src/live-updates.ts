export type LiveTopic = 'archive' | 'logs' | 'subscriptions' | 'task-summary' | 'task-active' | 'services' | 'metrics';
export type LiveEvent = { topic: LiveTopic; subscriptionId?: number; version?: number };

type Listener = (event: LiveEvent) => void;

const topics = new Map<LiveTopic, Set<Listener>>();
const archiveSubscriptionIds = new Map<number, number>();
const tabId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const leaseMs = 6_000;
const heartbeatMs = 2_000;
let stream: EventSource | null = null;
let leaseIssuedAt = 0;
let knownLeader: { id: string; issuedAt: number; seenAt: number } | null = null;
let heartbeatTimer: number | null = null;
let pendingVisibleTopics = new Set<LiveTopic>();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('page-watch-live-v1');

function wantedTopics() {
  return [...topics.entries()].filter(([, listeners]) => listeners.size > 0).map(([topic]) => topic);
}

function isVisible() {
  return document.visibilityState === 'visible';
}

function isLeader() {
  return knownLeader?.id === tabId;
}

function closeStream() {
  stream?.close();
  stream = null;
}

function notify(event: LiveEvent) {
  if (!isVisible() || !isLeader()) {
    pendingVisibleTopics.add(event.topic);
    return;
  }
  for (const listener of topics.get(event.topic) ?? []) listener(event);
}

function replayVisibleTopics() {
  const active = new Set<LiveTopic>([...wantedTopics(), ...pendingVisibleTopics]);
  pendingVisibleTopics.clear();
  for (const topic of active) notify({ topic });
}

function openStream() {
  closeStream();
  if (!isVisible() || !isLeader()) return;
  const activeTopics = wantedTopics();
  if (!activeTopics.length) return;
  const params = new URLSearchParams({ topics: activeTopics.join(',') });
  if (activeTopics.includes('archive')) params.set('subscriptionId', [...archiveSubscriptionIds.keys()].join(','));
  const source = new EventSource(`/api/events?${params.toString()}`);
  stream = source;
  for (const topic of activeTopics) {
    source.addEventListener(topic, (message) => {
      let payload: Omit<LiveEvent, 'topic'> = {};
      try { payload = JSON.parse((message as MessageEvent<string>).data) as Omit<LiveEvent, 'topic'>; } catch { /* server snapshots are best effort */ }
      const event = { topic, ...payload } as LiveEvent;
      channel?.postMessage({ type: 'event', event });
      notify(event);
    });
  }
  source.addEventListener('ready', () => replayVisibleTopics());
}

function publishLease() {
  if (!isLeader()) return;
  channel?.postMessage({ type: 'leader', id: tabId, issuedAt: leaseIssuedAt });
}

function startHeartbeat() {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = window.setInterval(() => {
    if (!isVisible() || !isLeader()) return;
    publishLease();
  }, heartbeatMs);
}

function stopHeartbeat() {
  if (heartbeatTimer === null) return;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function claimLeadership() {
  if (!isVisible()) return;
  leaseIssuedAt = Date.now();
  knownLeader = { id: tabId, issuedAt: leaseIssuedAt, seenAt: leaseIssuedAt };
  publishLease();
  startHeartbeat();
  openStream();
  replayVisibleTopics();
}

function releaseLeadership() {
  if (isLeader()) channel?.postMessage({ type: 'release', id: tabId, issuedAt: leaseIssuedAt });
  closeStream();
  stopHeartbeat();
  if (isLeader()) knownLeader = null;
}

function ensureLeader() {
  if (!isVisible() || !wantedTopics().length) return;
  if (isLeader()) return;
  const now = Date.now();
  if (!knownLeader || now - knownLeader.seenAt >= leaseMs) claimLeadership();
}

channel?.addEventListener('message', (message: MessageEvent<unknown>) => {
  const data = message.data as { type?: string; id?: string; issuedAt?: number; event?: LiveEvent };
  if (data.type === 'event' && data.event) {
    pendingVisibleTopics.add(data.event.topic);
    return;
  }
  if ((data.type === 'leader' || data.type === 'release') && !data.id) return;
  if (data.type === 'release' && knownLeader?.id === data.id) {
    knownLeader = null;
    window.setTimeout(ensureLeader, 50);
    return;
  }
  if (data.type !== 'leader' || !data.id || !data.issuedAt || data.id === tabId) return;
  const current = knownLeader;
  if (!current || data.issuedAt >= current.issuedAt) {
    knownLeader = { id: data.id, issuedAt: data.issuedAt, seenAt: Date.now() };
    if (stream) closeStream();
  }
});

window.addEventListener('focus', () => claimLeadership());
window.addEventListener('visibilitychange', () => {
  if (isVisible()) { ensureLeader(); replayVisibleTopics(); }
  else releaseLeadership();
});
window.addEventListener('beforeunload', releaseLeadership);
// A tab can disappear without emitting `beforeunload` (browser crash, a
// killed mobile WebView, or a machine suspend). Visible followers therefore
// re-check the six-second lease and take over without requiring a click.
window.setInterval(ensureLeader, heartbeatMs);

export function subscribeLive(topic: LiveTopic, listener: Listener, subscriptionId?: number) {
  const listeners = topics.get(topic) ?? new Set<Listener>();
  listeners.add(listener);
  topics.set(topic, listeners);
  if (topic === 'archive' && subscriptionId && Number.isInteger(subscriptionId) && subscriptionId > 0) {
    archiveSubscriptionIds.set(subscriptionId, (archiveSubscriptionIds.get(subscriptionId) ?? 0) + 1);
  }
  ensureLeader();
  if (isLeader()) openStream();
  return () => {
    const current = topics.get(topic);
    current?.delete(listener);
    if (current?.size === 0) topics.delete(topic);
    if (topic === 'archive' && subscriptionId) {
      const count = (archiveSubscriptionIds.get(subscriptionId) ?? 1) - 1;
      if (count > 0) archiveSubscriptionIds.set(subscriptionId, count); else archiveSubscriptionIds.delete(subscriptionId);
    }
    if (isLeader()) openStream();
  };
}

export function resetLiveUpdates() {
  pendingVisibleTopics.clear();
  releaseLeadership();
}

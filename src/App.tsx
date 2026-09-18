import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { resetLiveUpdates, subscribeLive, type LiveEvent } from './live-updates.js';

type Subscription = {
  id: number;
  name: string;
  url: string;
  selector: string;
  render_mode: 'static' | 'dynamic';
  content_source: 'text' | 'attribute';
  attribute_name: string | null;
  match_pattern: string | null;
  title_selector: string | null;
  title_content_source: 'text' | 'attribute';
  title_attribute_name: string | null;
  title_match_pattern: string | null;
  result_mode: 'first' | 'all';
  interval_minutes: number;
  schedule_type: 'hourly' | 'daily' | 'weekly';
  schedule_interval_hours: number;
  schedule_time: string;
  schedule_weekday: number;
  is_active: number;
  last_checked_at: string | null;
  last_content: string | null;
  last_error: string | null;
  pagination_selector: string | null;
  pagination_parameter: string;
  pagination_match_pattern: string | null;
  initial_scan_completed: number;
  initial_scan_total: number | null;
  initial_scan_pages_completed: number;
  initial_scan_run_id: string | null;
  initial_scan_next_page: number;
  next_scheduled_at: string | null;
  full_scan_active: number;
  archive_count: number;
  jellyfin_available_count: number;
  queue_summary: Record<string, { done: number; total: number }> | string;
};

type FormData = {
  name: string;
  url: string;
  selector: string;
  renderMode: 'static' | 'dynamic';
  contentSource: 'text' | 'attribute';
  attributeName: string;
  matchPattern: string;
  titleSelector: string;
  titleContentSource: 'text' | 'attribute';
  titleAttributeName: string;
  titleMatchPattern: string;
  resultMode: 'first' | 'all';
  intervalMinutes: number;
  scheduleType: 'hourly' | 'daily' | 'weekly';
  scheduleIntervalHours: number;
  scheduleTime: string;
  scheduleWeekday: number;
  isActive: boolean;
  paginationSelector: string;
  paginationParameter: string;
  paginationMatchPattern: string;
};

type ArchiveEntry = {
  id: number;
  content: string;
  title: string | null;
  detail_url: string | null;
  first_seen_at: string;
  release_date: string | null;
  release_status: 'unsearched' | 'pending' | 'found' | 'unavailable' | 'failed';
  release_error: string | null;
  magnet_status: 'unsearched' | 'pending' | 'found' | 'not_found' | 'failed' | 'skipped';
  magnet_value: string | null;
  magnet_checked_at: string | null;
  magnet_error: string | null;
  download_status: 'not_queued' | 'queued' | 'running' | 'added' | 'waiting' | 'downloading' | 'paused' | 'completed' | 'removed' | 'filtered' | 'failed';
  download_queued_at: string | null;
  download_added_at: string | null;
  download_torrent_hash: string | null;
  download_checked_at: string | null;
  download_error: string | null;
  download_progress: number | string | null;
  download_speed: number | string | null;
  download_size: number | string | null;
  downloaded_bytes: number | string | null;
  download_save_path: string | null;
  download_content_path: string | null;
  download_removed_at: string | null;
  download_filter_min_size_bytes: number | string | null;
  jellyfin_status: 'unconfigured' | 'pending' | 'available' | 'not_found' | 'failed';
  jellyfin_item_id: string | null;
  jellyfin_item_name: string | null;
  jellyfin_matched_at: string | null;
  jellyfin_error: string | null;
  subscription_id: number;
  subscription_name: string;
  subscription_url: string;
};

type ArchivePageResult = {
  items: ArchiveEntry[];
  total: number;
  page: number;
  pageSize: number;
};

type RuntimeLog = {
  id: number;
  level: 'info' | 'success' | 'error';
  source: 'system' | 'queue' | 'worker' | 'download' | 'library';
  subscription_id: number | null;
  subscription_name: string | null;
  subscription_url: string | null;
  job_id: number | null;
  message: string;
  created_at: string;
  scope: 'system' | 'check' | 'release' | 'magnet' | 'download' | 'library';
};

type AuthStatus = { setupRequired: boolean; authenticated: boolean; databaseSetupRequired?: boolean };
type IntegrationOnboarding = {
  pending: boolean;
  jellyfin: { enabled: boolean; configured: boolean };
  qbittorrent: { enabled: boolean; configured: boolean };
};
type SystemService = { name: string; label: string; status: 'ready' | 'busy' | 'sleeping' | 'error' | 'missing'; detail: string; lastSeenAt: string | null; healthy: boolean };
type SystemStatus = { generatedAt: string; services: SystemService[] };
type TaskStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed';
type TaskItem = {
  id: string;
  kind: 'check' | 'full_scan' | 'release' | 'magnet' | 'library' | 'download' | 'library_sync';
  status: TaskStatus;
  priority: number;
  subscriptionId: number | null;
  subscriptionName: string | null;
  content: string | null;
  title: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  retryAfter: string | null;
  attemptCount: number;
  error: string | null;
  progress: { current: number | null; total: number | null; label: string | null } | null;
};
type TasksResponse = {
  generatedAt: string;
  summary: { servicesOnline: number; running: number; queued: number; retrying: number; failed: number };
  services: SystemService[];
  integrations: Array<{ name: 'jellyfin' | 'qbittorrent'; enabled: boolean; configured: boolean; status: 'healthy' | 'degraded' | 'disabled' | 'unknown'; detail: string | null; checkedAt: string | null }>;
  active: TaskItem[];
  history: TaskItem[];
};
type PerformanceMetrics = {
  range: '24h' | '7d' | '30d' | '180d';
  generatedAt: string;
  jellyfinCache: { hit: number; miss: number; hitRate: number | null };
  workers: Array<{ scope: 'capture' | 'release' | 'magnet' | 'library' | 'download'; processed: number; averageDurationMs: number | null }>;
  retries: Array<{ scope: string; reason: string; count: number }>;
  chromiumRebuilds: Array<{ scope: string; reason: string; count: number }>;
  throughput: Array<{ minute: string; scope: string; count: number }>;
  runtime: {
    containerMemoryBytes: number | null;
    apiRssBytes: number | null;
    runnerRssBytes: number | null;
    engineState: string;
    engineLastStartedAt: string | null;
    engineStartCount: number;
    webExecutorRssBytes: number | null;
    webExecutorState: string;
    librarySyncRssBytes: number | null;
    librarySyncState: string;
    browser: { state: string; activePages: number | null; queuedPages: number | null; navigationCount: number | null };
    engineMemoryReclaim: { state: string; gcBeforeBytes: number | null; gcAfterBytes: number | null };
  };
};

type RuntimeSettings = { profile: 'safe' | 'performance'; browserIdleMinutes: 5 | 10 | 20 };

const blankForm: FormData = {
  name: '', url: '', selector: '', renderMode: 'static', contentSource: 'text', attributeName: '', matchPattern: '', titleSelector: '', titleContentSource: 'text', titleAttributeName: '', titleMatchPattern: '', resultMode: 'first', intervalMinutes: 60, scheduleType: 'hourly', scheduleIntervalHours: 1, scheduleTime: '09:00', scheduleWeekday: 1, isActive: true, paginationSelector: '', paginationParameter: 'page', paginationMatchPattern: ''
};

type SubscriptionPreset = {
  id: number;
  name: string;
  description: string;
  selector: string;
  render_mode: 'static' | 'dynamic';
  content_source: 'text' | 'attribute';
  attribute_name: string | null;
  match_pattern: string | null;
  title_selector: string | null;
  title_content_source: 'text' | 'attribute';
  title_attribute_name: string | null;
  title_match_pattern: string | null;
  result_mode: 'first' | 'all';
  interval_minutes: number;
  pagination_selector: string | null;
  pagination_parameter: string;
  pagination_match_pattern: string | null;
  is_active: number;
};

type PresetForm = Omit<FormData, 'name' | 'url'> & { name: string; description: string };

const blankPresetForm: PresetForm = {
  name: '', description: '', selector: '', renderMode: 'static', contentSource: 'text', attributeName: '', matchPattern: '', titleSelector: '', titleContentSource: 'text', titleAttributeName: '', titleMatchPattern: '', resultMode: 'first', intervalMinutes: 60, scheduleType: 'hourly', scheduleIntervalHours: 1, scheduleTime: '09:00', scheduleWeekday: 1, isActive: true, paginationSelector: '', paginationParameter: 'page', paginationMatchPattern: ''
};

const defaultMissavPresetForm: PresetForm = {
  ...blankPresetForm,
  name: 'MissAV 番号列表',
  description: '适用于列表页，读取影片番号、标题和全部分页内容。',
  selector: 'a.text-secondary[alt]',
  renderMode: 'dynamic',
  contentSource: 'attribute',
  attributeName: 'alt',
  titleSelector: 'a.text-secondary[alt]',
  titleContentSource: 'text',
  titleMatchPattern: '^[A-Za-z]+-\\d+\\s*(.+)$',
  resultMode: 'all',
  paginationSelector: '#price-currency',
  paginationParameter: 'page',
  paginationMatchPattern: '/\\s*(\\d+)'
};

const responseCache = new Map<string, { etag: string; value: unknown }>();
const pendingRequests = new Map<string, Promise<unknown>>();

function clearResponseCache() {
  responseCache.clear();
  pendingRequests.clear();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const cacheable = (options?.method ?? 'GET').toUpperCase() === 'GET' && !options?.body;
  const key = cacheable ? url : '';
  const cached = cacheable ? responseCache.get(key) : undefined;
  if (cached) headers.set('if-none-match', cached.etag);
  if (cacheable && pendingRequests.has(key)) return pendingRequests.get(key) as Promise<T>;
  const execute = async () => {
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 304 && cached) return cached.value as T;
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? '请求失败，请稍后再试。');
    }
    if (response.status === 204) return undefined as T;
    const value = await response.json() as T;
    const etag = response.headers.get('etag');
    if (cacheable && etag) responseCache.set(key, { etag, value });
    return value;
  };
  const promise = execute();
  if (cacheable) pendingRequests.set(key, promise);
  try { return await promise; }
  finally { if (cacheable) pendingRequests.delete(key); }
}

function formatTime(value: string | null) {
  if (!value) return '尚未检查';
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function shortUrl(value: string) {
  try { return new URL(value).hostname; } catch { return value; }
}

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type View = 'subscriptions' | 'archive' | 'downloads' | 'operations';

function viewFromHash(): View {
  if (window.location.hash === '#logs' || window.location.hash === '#tasks' || window.location.hash === '#operations') return 'operations';
  if (window.location.hash === '#archive' || window.location.hash === '#activity') return 'archive';
  if (window.location.hash === '#downloads') return 'downloads';
  return 'subscriptions';
}

function scheduleLabel(item: Pick<Subscription, 'schedule_type' | 'schedule_interval_hours' | 'schedule_time' | 'schedule_weekday'>) {
  if (item.schedule_type === 'daily') return `每天 ${item.schedule_time}`;
  if (item.schedule_type === 'weekly') return `每${weekdayLabels[item.schedule_weekday] ?? '周一'} ${item.schedule_time}`;
  return `每 ${item.schedule_interval_hours} 小时`;
}

function subscriptionToForm(item: Subscription): FormData {
  return { name: item.name, url: item.url, selector: item.selector, renderMode: item.render_mode, contentSource: item.content_source ?? 'text', attributeName: item.attribute_name ?? '', matchPattern: item.match_pattern ?? '', titleSelector: item.title_selector ?? '', titleContentSource: item.title_content_source ?? 'text', titleAttributeName: item.title_attribute_name ?? '', titleMatchPattern: item.title_match_pattern ?? '', resultMode: item.result_mode ?? 'first', intervalMinutes: item.interval_minutes, scheduleType: item.schedule_type ?? 'hourly', scheduleIntervalHours: item.schedule_interval_hours ?? Math.max(1, Math.round(item.interval_minutes / 60)), scheduleTime: item.schedule_time ?? '09:00', scheduleWeekday: item.schedule_weekday ?? 1, isActive: Boolean(item.is_active), paginationSelector: item.pagination_selector ?? '', paginationParameter: item.pagination_parameter ?? 'page', paginationMatchPattern: item.pagination_match_pattern ?? '' };
}

function ScheduleControls({ form, update }: { form: Pick<FormData, 'scheduleType' | 'scheduleIntervalHours' | 'scheduleTime' | 'scheduleWeekday'>; update: <K extends 'scheduleType' | 'scheduleIntervalHours' | 'scheduleTime' | 'scheduleWeekday'>(key: K, value: FormData[K]) => void }) {
  return <section className="schedule-settings"><div className="schedule-settings-heading">检查计划 <span>按 NAS 本地时间执行</span></div><div className="two-col"><label>执行方式<select value={form.scheduleType} onChange={(event) => update('scheduleType', event.target.value as FormData['scheduleType'])}><option value="hourly">按小时检查</option><option value="daily">每天定时检查</option><option value="weekly">每周定时检查</option></select></label>{form.scheduleType === 'hourly' ? <label>每隔（小时）<input type="number" min="1" max="168" value={form.scheduleIntervalHours} onChange={(event) => update('scheduleIntervalHours', Number(event.target.value))} /></label> : <label>检查时间<input type="time" value={form.scheduleTime} onChange={(event) => update('scheduleTime', event.target.value)} /></label>}</div>{form.scheduleType === 'weekly' && <label>执行日期<select value={form.scheduleWeekday} onChange={(event) => update('scheduleWeekday', Number(event.target.value))}>{weekdayLabels.map((label, weekday) => <option key={weekday} value={weekday}>{label}</option>)}</select></label>}</section>;
}

function AppShell({ onLogout }: { onLogout: () => Promise<void> }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Subscription | null | 'new'>(null);
  const [networkSettingsOpen, setNetworkSettingsOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>(viewFromHash);
  const [rulesOpen, setRulesOpen] = useState(() => window.location.hash === '#rules');
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [taskSummary, setTaskSummary] = useState<TasksResponse['summary'] | null>(null);
  const [integrationOnboarding, setIntegrationOnboarding] = useState<IntegrationOnboarding | null>(null);

  const load = async () => {
    try { setSubscriptions(await request<Subscription[]>('/api/subscriptions')); }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法加载订阅。'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    void request<IntegrationOnboarding>('/api/setup/integrations')
      .then(setIntegrationOnboarding)
      .catch(() => setIntegrationOnboarding({ pending: false, jellyfin: { enabled: false, configured: false }, qbittorrent: { enabled: false, configured: false } }));
  }, []);
  useEffect(() => {
    let alive = true;
    const loadStatus = async () => {
      try {
        const status = await request<SystemStatus>('/api/system/status');
        if (alive) setSystemStatus(status);
      } catch { if (alive) setSystemStatus(null); }
    };
    void loadStatus();
    const unsubscribe = subscribeLive('services', () => void loadStatus());
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    return subscribeLive('subscriptions', () => void load());
  }, []);
  useEffect(() => {
    let alive = true;
    const loadTasks = async () => {
      try {
        const tasks = await request<Pick<TasksResponse, 'summary'>>('/api/tasks/summary');
        if (alive) setTaskSummary(tasks.summary);
      } catch { if (alive) setTaskSummary(null); }
    };
    void loadTasks();
    const unsubscribe = subscribeLive('task-summary', () => void loadTasks());
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const syncView = () => {
      setView(viewFromHash());
      setRulesOpen(window.location.hash === '#rules');
    };
    window.addEventListener('hashchange', syncView);
    return () => window.removeEventListener('hashchange', syncView);
  }, []);
  useEffect(() => {
    if (!rulesOpen || window.location.hash !== '#rules') return;
    const frame = window.requestAnimationFrame(() => document.getElementById('rules-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [rulesOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const stats = useMemo(() => ({
    total: subscriptions.length,
    active: subscriptions.filter((item) => item.is_active).length,
    archived: subscriptions.reduce((sum, item) => sum + item.archive_count, 0),
    libraryAvailable: subscriptions.reduce((sum, item) => sum + Number(item.jellyfin_available_count ?? 0), 0)
  }), [subscriptions]);
  const unhealthyServices = systemStatus?.services.filter((service) => !service.healthy) ?? [];
  const busyServiceCount = systemStatus?.services.filter((service) => service.healthy && service.status === 'busy').length ?? 0;
  const servicesHealthy = Boolean(systemStatus && unhealthyServices.length === 0);
  const serviceAttention = unhealthyServices.map((service) => `${service.label}：${service.status === 'missing' ? '尚未启动' : service.detail}`).join('；');
  const taskCount = taskSummary?.running ?? busyServiceCount;
  const healthyServiceSummary = systemStatus ? `${systemStatus.services.length} 项服务在线 · ${taskCount} 项任务执行中` : '';

  function openRules() {
    setRulesOpen(true);
    window.requestAnimationFrame(() => document.getElementById('rules-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function runNow(item: Subscription) {
    try {
      await request(`/api/subscriptions/${item.id}/run`, { method: 'POST' });
      setNotice(`“${item.name}”已加入抓取队列。`);
      window.setTimeout(() => void load(), 1200);
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败。'); }
  }

  async function toggleSubscription(item: Subscription) {
    const isActive = !item.is_active;
    try {
      await request(`/api/subscriptions/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: item.name, url: item.url, selector: item.selector,
          renderMode: item.render_mode, contentSource: item.content_source,
          attributeName: item.attribute_name ?? '', matchPattern: item.match_pattern ?? '',
          titleSelector: item.title_selector ?? '', titleContentSource: item.title_content_source ?? 'text',
          titleAttributeName: item.title_attribute_name ?? '', titleMatchPattern: item.title_match_pattern ?? '',
          resultMode: item.result_mode, intervalMinutes: item.interval_minutes,
          scheduleType: item.schedule_type, scheduleIntervalHours: item.schedule_interval_hours,
          scheduleTime: item.schedule_time, scheduleWeekday: item.schedule_weekday, isActive,
          paginationSelector: item.pagination_selector ?? '', paginationParameter: item.pagination_parameter ?? 'page', paginationMatchPattern: item.pagination_match_pattern ?? ''
        })
      });
      setNotice(isActive ? '订阅已启用。' : '订阅已暂停。');
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败。'); }
  }

  async function remove(item: Subscription) {
    if (!window.confirm(`删除订阅“${item.name}”？这会同时删除它的内容档案。`)) return;
    try {
      await request(`/api/subscriptions/${item.id}`, { method: 'DELETE' });
      setNotice('订阅已删除。');
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '删除失败。'); }
  }

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">⌁</span><span>PAGE WATCH</span></div>
      <nav aria-label="主导航">
        <a className={`nav-item ${view === 'subscriptions' ? 'active' : ''}`} href="#subscriptions"><span>◉</span> 订阅中心 <b>{stats.total}</b></a>
        <a className={`nav-item ${view === 'operations' ? 'active' : ''}`} href="#operations"><span>◫</span> 运行中心 {taskCount ? <b>{taskCount}</b> : null}</a>
        <a className={`nav-item ${view === 'archive' ? 'active' : ''}`} href="#archive"><span>◌</span> 内容档案</a>
        <a className={`nav-item ${view === 'downloads' ? 'active' : ''}`} href="#downloads"><span>⇩</span> 下载与影视库</a>
        <button className="nav-item nav-button" onClick={() => setNetworkSettingsOpen(true)}><span>⌁</span> 网络代理</button>
      </nav>
      <div className={`sidebar-note ${servicesHealthy ? '' : 'needs-attention'}`} title={serviceAttention}>
        <span className="pulse" /> {servicesHealthy ? '后台服务运行正常' : systemStatus ? `服务需要注意（${unhealthyServices.length}）` : '正在确认服务状态…'}
        {servicesHealthy ? <a className="sidebar-task-link" href="#operations">{healthyServiceSummary}</a> : <small>{serviceAttention || '正在读取服务状态…'}</small>}
        <button type="button" className="sign-out" onClick={() => void onLogout()}>退出登录</button>
      </div>
    </aside>

    <section className="workspace">
      <header className="topbar">
        <div><p className="eyebrow">自托管网页监测</p><h1>{view === 'archive' ? '内容档案' : view === 'downloads' ? '下载与影视库' : view === 'operations' ? '运行中心' : '订阅中心'}</h1></div>
        {view === 'subscriptions' && <div className="topbar-actions"><button type="button" className="secondary" onClick={() => openRules()}>检查规则</button><button className="primary" onClick={() => setEditor('new')}><span>＋</span> 新建订阅</button></div>}
      </header>

      {view === 'subscriptions' ? <><section className="summary" aria-label="订阅概览">
        <div><span>全部订阅</span><strong>{stats.total}</strong></div>
        <div><span>正在监测</span><strong>{stats.active}</strong></div>
        <div><span>已入库 / 收录内容</span><strong>{stats.libraryAvailable} / {stats.archived}</strong></div>
      </section>

      <section id="subscriptions" className="list-section">
        <div className="section-head"><div><h2>你的网页订阅</h2><p>用 CSS Selector 精确读取所需内容</p></div><button className="quiet" onClick={() => void load()}>↻ 刷新</button></div>
        {loading ? <div className="empty">正在读取订阅…</div> : subscriptions.length === 0 ? <Empty onCreate={() => setEditor('new')} /> :
          <div className="subscription-grid">
            {subscriptions.map((item) => <SubscriptionCard key={item.id} item={item} onRun={runNow} onEdit={setEditor} onConfigure={() => openRules()} onToggle={toggleSubscription} onDelete={remove} />)}
          </div>}
      </section>
      <RulesLibrary open={rulesOpen} onToggle={() => setRulesOpen((current) => !current)} onNotice={setNotice} />
      </> : view === 'archive' ? <ArchivePage subscriptions={subscriptions} onNotice={setNotice} /> : view === 'downloads' ? <QbittorrentSettingsPage onNotice={setNotice} /> : <OperationsCenterPage onSummary={setTaskSummary} />}
      {notice && <div className="toast" role="status">{notice}</div>}
    </section>
    {editor && <Editor item={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await load(); setNotice('订阅已保存。'); }} onFullScan={async () => { await load(); setNotice('已加入全量检查队列。'); }} onArchiveCleared={async () => { setEditor(null); await load(); setNotice('订阅数据已重置。'); }} />}
    {networkSettingsOpen && <NetworkSettings onClose={() => setNetworkSettingsOpen(false)} onSaved={(message) => { setNetworkSettingsOpen(false); setNotice(message); }} />}
    {integrationOnboarding?.pending && <IntegrationOnboardingGuide
      status={integrationOnboarding}
      onComplete={async () => {
        await request('/api/setup/integrations/complete', { method: 'POST' });
        setIntegrationOnboarding((current) => current ? { ...current, pending: false } : current);
      }}
      onOpenSettings={async () => {
        await request('/api/setup/integrations/complete', { method: 'POST' });
        setIntegrationOnboarding((current) => current ? { ...current, pending: false } : current);
        window.location.hash = '#downloads';
      }}
    />}
  </main>;
}

function IntegrationOnboardingGuide({ status, onComplete, onOpenSettings }: { status: IntegrationOnboarding; onComplete: () => Promise<void>; onOpenSettings: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const finish = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  return <div className="overlay integration-onboarding" role="dialog" aria-modal="true" aria-labelledby="integration-onboarding-title">
    <section className="editor onboarding-card">
      <p className="eyebrow">首次使用</p>
      <h2 id="integration-onboarding-title">外部服务按需配置</h2>
      <p>Page Watch 已可直接用于订阅、网页检查、发行日期和磁力检索。Jellyfin 与 qBittorrent 均是可选功能：系统不会在安装或启动时主动连接它们。</p>
      <div className="onboarding-integrations">
        <article><strong>Jellyfin 影视库</strong><span className={status.jellyfin.configured && status.jellyfin.enabled ? 'ready' : ''}>{status.jellyfin.configured && status.jellyfin.enabled ? '已配置' : '未启用'}</span><small>配置并选择媒体库后，才会同步本地影视库索引。</small></article>
        <article><strong>qBittorrent 下载</strong><span className={status.qbittorrent.configured && status.qbittorrent.enabled ? 'ready' : ''}>{status.qbittorrent.configured && status.qbittorrent.enabled ? '已配置' : '未启用'}</span><small>填写 Web UI 凭据并启用后，下载按钮才可提交任务。</small></article>
      </div>
      <p className="field-note">配置页会先保存你填写的信息；只有点击“保存并测试连接”时才会访问对应服务。未配置或未启用时，相关功能会明确提示并保持关闭。</p>
      <footer><button type="button" className="secondary" disabled={busy} onClick={() => finish(onComplete)}>{busy ? '处理中…' : '暂不设置，进入页面'}</button><button type="button" className="primary" disabled={busy} onClick={() => finish(onOpenSettings)}>前往下载与影视库配置</button></footer>
    </section>
  </div>;
}

function AccessGate({ setupRequired, onAuthenticated }: { setupRequired: boolean; onAuthenticated: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (setupRequired && password !== confirmation) { setError('两次输入的密码不一致。'); return; }
    setBusy(true); setError('');
    try {
      await request(setupRequired ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      await onAuthenticated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法完成登录。'); }
    finally { setBusy(false); }
  };
  return <main className="access-gate"><form className="access-card" onSubmit={submit}>
    <div className="brand"><span className="brand-mark">⌁</span><span>PAGE WATCH</span></div>
    <p className="eyebrow">自托管访问保护</p>
    <h1>{setupRequired ? '设置访问密码' : '登录 Page Watch'}</h1>
    <p>{setupRequired ? '首次使用请设置一个仅自己知晓的密码。设置后，所有数据与下载设置都需要登录才能访问。' : '请输入访问密码以继续。'}</p>
    <label>访问密码<input autoFocus type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" /></label>
    {setupRequired && <label>确认密码<input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入访问密码" /></label>}
    {error && <p className="form-error">{error}</p>}
    <button className="primary" disabled={busy} type="submit">{busy ? '处理中…' : setupRequired ? '设置并进入' : '登录'}</button>
  </form></main>;
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const loadAuth = async () => {
    try { setAuth(await request<AuthStatus>('/api/auth/status')); }
    catch { setAuth({ setupRequired: false, authenticated: false }); }
  };
  useEffect(() => { void loadAuth(); }, []);
  if (!auth) return <main className="access-gate"><div className="access-card access-loading">正在读取访问状态…</div></main>;
  if (auth.databaseSetupRequired) return <DatabaseSetupGate onConfigured={loadAuth} />;
  if (!auth.authenticated) return <AccessGate setupRequired={auth.setupRequired} onAuthenticated={loadAuth} />;
  return <AppShell onLogout={async () => {
    await request('/api/auth/logout', { method: 'POST' });
    clearResponseCache();
    resetLiveUpdates();
    await loadAuth();
  }} />;
}

function DatabaseSetupGate({ onConfigured }: { onConfigured: () => Promise<void> }) {
  const [form, setForm] = useState({ host: '', port: 3306, database: 'page_watch', user: 'page_watch', password: '', connectionLimit: 3 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    void request('/api/setup/database', { method: 'POST', body: JSON.stringify(form) })
      .then(onConfigured)
      .catch((reason) => setError(reason instanceof Error ? reason.message : '无法连接或初始化 MySQL。'))
      .finally(() => setBusy(false));
  };
  return <main className="access-gate"><form className="access-card database-setup-card" onSubmit={submit}>
    <div className="brand"><span className="brand-mark">⌁</span><span>PAGE WATCH</span></div>
    <p className="eyebrow">安装引导 · 第一步</p><h1>连接 MySQL 数据库</h1>
    <p>验证成功后，连接信息将使用 <code>APP_ENCRYPTION_KEY</code> 加密保存到 Docker 持久目录。Jellyfin 与 qBittorrent 不会在容器启动时被访问。</p>
    <label>MySQL 主机<input autoFocus required disabled={busy} value={form.host} onChange={(event) => update('host', event.target.value)} placeholder="例如 mysql 或 192.168.1.20" /></label>
    <div className="two-col"><label>端口<input required type="number" min="1" max="65535" disabled={busy} value={form.port} onChange={(event) => update('port', Number(event.target.value))} /></label><label>数据库名<input required disabled={busy} value={form.database} onChange={(event) => update('database', event.target.value)} /></label></div>
    <label>数据库账号<input required autoComplete="username" disabled={busy} value={form.user} onChange={(event) => update('user', event.target.value)} /></label>
    <label>数据库密码<input required type="password" autoComplete="current-password" disabled={busy} value={form.password} onChange={(event) => update('password', event.target.value)} /></label>
    <label>连接数上限<input required type="number" min="1" max="16" disabled={busy} value={form.connectionLimit} onChange={(event) => update('connectionLimit', Number(event.target.value))} /><span className="field-note">个人 NAS 通常保持 3 即可。</span></label>
    {error && <p className="form-error">{error}</p>}
    <button className="primary" disabled={busy} type="submit">{busy ? '正在验证并初始化…' : '验证连接并继续'}</button>
  </form></main>;
}

function Empty({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-card"><div className="empty-orbit">⌁</div><h3>还没有订阅</h3><p>添加一个网页地址，填入目标元素的 CSS Selector，<br />系统就会为你定时记录内容变化。</p><button className="primary" onClick={onCreate}>新建第一个订阅</button><small>示例：<code>#price</code>、<code>.article-body</code>、<code>[data-status]</code></small></div>;
}

function SubscriptionCard({ item, onRun, onEdit, onConfigure, onToggle, onDelete }: { item: Subscription; onRun: (item: Subscription) => void; onEdit: (item: Subscription) => void; onConfigure: (item: Subscription) => void; onToggle: (item: Subscription) => void; onDelete: (item: Subscription) => void }) {
  return <article className={`subscription-card ${item.last_error ? 'has-error' : ''}`}>
    <div className="card-top"><div className="site-ident">{shortUrl(item.url).slice(0, 1).toUpperCase()}</div><div className="card-title"><h3>{item.name}</h3><a href={item.url} target="_blank" rel="noreferrer">{shortUrl(item.url)} ↗</a></div><button className="icon-button" title="编辑订阅" onClick={() => onEdit(item)}>⋯</button></div>
    {item.last_error && <div className="error-line">上次失败：{item.last_error}</div>}
    <footer className="card-footer"><button type="button" className={`subscription-switch ${item.is_active ? 'on' : ''}`} role="switch" aria-checked={Boolean(item.is_active)} disabled={!item.selector} title={!item.selector ? '请先配置读取规则' : item.is_active ? '暂停订阅' : '启用订阅'} onClick={() => onToggle(item)}><span aria-hidden="true" /><em>{item.is_active ? '已启用' : '已暂停'}</em></button>{item.is_active && <span>{scheduleLabel(item)}</span>}<span>上次：{formatTime(item.last_checked_at)}</span>{Boolean(item.full_scan_active) && <span className="scan-progress"><b>{item.initial_scan_total ? `全量 ${item.initial_scan_pages_completed}/${item.initial_scan_total}` : '全量准备中'}</b><i><em style={{ width: item.initial_scan_total ? `${Math.min(100, item.initial_scan_pages_completed / item.initial_scan_total * 100)}%` : '18%' }} /></i></span>}<div className="card-actions"><button type="button" onClick={() => onConfigure(item)}>{item.selector ? '规则' : '配置规则'}</button><button disabled={!item.selector} title={!item.selector ? '请先配置读取规则' : undefined} onClick={() => onRun(item)}>立即检查</button><button className="danger" onClick={() => onDelete(item)}>删除</button></div></footer>
  </article>;
}

function asNumber(value: number | string | null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function archiveContentUrl(entry: ArchiveEntry) {
  if (entry.detail_url) return entry.detail_url;
  try {
    const source = new URL(entry.subscription_url);
    return new URL(`/cn/${encodeURIComponent(entry.content)}`, source.origin).toString();
  } catch { return null; }
}

function magnetSearchUrl(rules: InspectionRules | null, content: string) {
  const magnet = rules?.magnet;
  const origin = magnet?.origins.find((candidate) => /^https?:\/\//i.test(candidate.trim()))?.trim().replace(/\/+$/, '')
    ?? defaultInspectionRules.magnet.origins[0];
  const template = magnet?.searchUrlTemplate || defaultInspectionRules.magnet.searchUrlTemplate;
  const target = template
    .replaceAll('{{origin}}', origin)
    .replaceAll('{{content}}', encodeURIComponent(content));
  try {
    const url = new URL(target);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function DownloadCell({ entry, downloadingId, onSubmit }: { entry: ArchiveEntry; downloadingId: number | null; onSubmit: (entry: ArchiveEntry) => void }) {
  if (entry.magnet_status !== 'found') return <span>—</span>;
  if (entry.download_status === 'not_queued' || entry.download_status === 'failed' || entry.download_status === 'filtered') {
    const wasFiltered = entry.download_status === 'filtered';
    const title = entry.download_status === 'failed'
      ? (entry.download_error || '提交失败，点击重试')
      : wasFiltered
        ? (entry.download_error || '种子内文件均未达到最小单文件大小；点击可按当前设置重新筛选')
        : '提交给 qBittorrent';
    return <button className={`download-action ${entry.download_status === 'failed' ? 'download-failed' : wasFiltered ? 'download-filtered' : ''}`} type="button" disabled={downloadingId === entry.id} title={title} onClick={() => void onSubmit(entry)}>{entry.download_status === 'failed' ? '重试' : wasFiltered ? '重新筛选' : '下载'}</button>;
  }
  if (entry.download_status === 'queued' || entry.download_status === 'running') return <span className="download-state pending">提交中</span>;
  const status = entry.download_status === 'completed' ? '完成'
    : entry.download_status === 'downloading' ? `${Math.round(Math.min(1, asNumber(entry.download_progress)) * 100)}%`
      : entry.download_status === 'waiting' ? '等待'
          : entry.download_status === 'paused' ? '暂停'
          : entry.download_status === 'removed' ? '已删除'
            : '已提交';
  return <span className={`download-status-button ${entry.download_status}`} title={entry.download_error || status}>{status}</span>;
}

function formatDuration(value: number | null) {
  if (value === null) return '—';
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 1024 * 1024 * 1024 ? 0 : 1)} MB`;
}

function jellyfinItemUrl(baseUrl: string, itemId: string | null) {
  if (!baseUrl || !itemId) return null;
  try {
    const url = new URL('web/index.html', `${baseUrl.replace(/\/+$/, '')}/`);
    url.hash = `!/details?id=${encodeURIComponent(itemId)}`;
    return url.toString();
  } catch { return null; }
}

function JellyfinCell({ entry, baseUrl }: { entry: ArchiveEntry; baseUrl: string }) {
  if (entry.jellyfin_status === 'available') {
    const itemUrl = jellyfinItemUrl(baseUrl, entry.jellyfin_item_id);
    return itemUrl ? <a className="jellyfin-status available jellyfin-status-link" href={itemUrl} target="_blank" rel="noreferrer" title={entry.jellyfin_item_name ? `在 Jellyfin 中打开：${entry.jellyfin_item_name}` : '在 Jellyfin 中打开该影片'}>已入库</a> : <span className="jellyfin-status available" title={entry.jellyfin_item_name || '已在 Jellyfin 中入库'}>已入库</span>;
  }
  if (entry.jellyfin_status === 'pending') return <span className="jellyfin-status pending">待同步</span>;
  if (entry.jellyfin_status === 'not_found') return <span className="jellyfin-status not-found">未入库</span>;
  if (entry.jellyfin_status === 'failed') return <span className="jellyfin-status failed" title={entry.jellyfin_error || 'Jellyfin 同步失败'}>同步失败</span>;
  return <span className="jellyfin-status muted">未启用</span>;
}

function ReleaseDateCell({ entry }: { entry: ArchiveEntry }) {
  if (entry.release_date) return <span className="release-date-value">{entry.release_date}</span>;
  if (entry.release_status === 'pending') return <span className="release-status pending">读取中…</span>;
  if (entry.release_status === 'unavailable') return <span className="release-status unavailable" title={entry.release_error ?? '详情页未找到符合规则的发行日期。'}>未找到</span>;
  if (entry.release_status === 'failed') return <span className="release-status failed" title={entry.release_error ?? '发行日期读取失败。'}>读取失败</span>;
  return <span className="release-status unsearched" title={entry.release_error ?? '尚未加入发行日期读取队列；请检查发行日期规则是否启用。'}>待读取</span>;
}

function ArchivePage({ subscriptions, onNotice }: { subscriptions: Subscription[]; onNotice: (message: string) => void }) {
  const [selected, setSelected] = useState<Subscription | null>(null);
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [archivePage, setArchivePage] = useState(1);
  const [archivePageSize, setArchivePageSize] = useState(50);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveQuery, setArchiveQuery] = useState('');
  const [releaseFrom, setReleaseFrom] = useState('');
  const [releaseTo, setReleaseTo] = useState('');
  const [inspectionRules, setInspectionRules] = useState<InspectionRules | null>(null);
  const [jellyfinBaseUrl, setJellyfinBaseUrl] = useState('');
  useEffect(() => {
    setSelected((current) => current ? subscriptions.find((item) => item.id === current.id) ?? current : null);
  }, [subscriptions]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [releaseBackfillBusy, setReleaseBackfillBusy] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [downloadBackfillBusy, setDownloadBackfillBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  useEffect(() => {
    void request<InspectionRules>('/api/inspection-rules').then(setInspectionRules).catch(() => setInspectionRules(null));
    void request<Pick<JellyfinSettings, 'url'>>('/api/settings/jellyfin').then((settings) => setJellyfinBaseUrl(settings.url)).catch(() => setJellyfinBaseUrl(''));
  }, []);
  const loadArchive = async (subscription: Subscription, silent = false, requestedPage = archivePage) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const params = new URLSearchParams({ subscriptionId: String(subscription.id), page: String(requestedPage), pageSize: String(archivePageSize) });
      if (archiveQuery.trim()) params.set('q', archiveQuery.trim());
      if (releaseFrom) params.set('releaseFrom', releaseFrom);
      if (releaseTo) params.set('releaseTo', releaseTo);
      const result = await request<ArchivePageResult>(`/api/archive?${params.toString()}`);
      setEntries(result.items);
      setArchiveTotal(result.total);
      setArchivePage(result.page);
    }
    catch (reason) { if (!silent) setError(reason instanceof Error ? reason.message : '无法读取内容档案。'); }
    finally { if (!silent) setLoading(false); }
  };
  const openArchive = async (subscription: Subscription) => {
    setArchivePage(1);
    setSelected(subscription);
    await loadArchive(subscription, false, 1);
  };
  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => void loadArchive(selected, true), 220);
    return () => window.clearTimeout(timer);
  }, [selected?.id, archivePage, archivePageSize, archiveQuery, releaseFrom, releaseTo]);
  useEffect(() => {
    if (!selected) return;
    return subscribeLive('archive', (event: LiveEvent) => {
      if (event.subscriptionId === selected.id) void loadArchive(selected, true);
    }, selected.id);
  }, [selected?.id, archivePage, archivePageSize, archiveQuery, releaseFrom, releaseTo]);
  const backfillReleaseDates = async () => {
    if (!selected) return;
    setReleaseBackfillBusy(true);
    try {
      const result = await request<{ queued: number; skipped: number }>(`/api/subscriptions/${selected.id}/release-backfill`, { method: 'POST' });
      onNotice(result.queued ? `已加入 ${result.queued} 项发行日期读取队列。` : '没有待读取或可重试的发行日期。');
      await loadArchive(selected, true);
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : '无法检索发行日期。'); }
    finally { setReleaseBackfillBusy(false); }
  };
  const backfillMagnets = async () => {
    if (!selected) return;
    setBackfillBusy(true);
    try {
      const result = await request<{ queued: number; skipped: number }>(`/api/subscriptions/${selected.id}/magnet-backfill`, { method: 'POST' });
      onNotice(result.queued ? `已加入 ${result.queued} 项磁力检索队列。` : '没有待补全或可重试的磁力链接。');
      await loadArchive(selected, true);
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : '无法补全磁力链接。'); }
    finally { setBackfillBusy(false); }
  };
  const retryMagnet = async (entry: ArchiveEntry) => {
    setRetryingId(entry.id);
    try {
      await request(`/api/archive/${entry.id}/magnet-retry`, { method: 'POST' });
      onNotice(`“${entry.content}”已加入磁力检索队列。`);
      if (selected) await loadArchive(selected, true);
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : '无法重新检索磁力链接。'); }
    finally { setRetryingId(null); }
  };
  const backfillDownloads = async () => {
    if (!selected) return;
    setDownloadBackfillBusy(true);
    try {
      const result = await request<{ queued: number; skipped: number }>(`/api/subscriptions/${selected.id}/download-backfill`, { method: 'POST' });
      onNotice(result.queued ? `已加入 ${result.queued} 项 qBittorrent 下载队列。` : '没有可提交的磁力链接。');
      await loadArchive(selected, true);
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : '无法加入 qBittorrent 下载队列。'); }
    finally { setDownloadBackfillBusy(false); }
  };
  const submitDownload = async (entry: ArchiveEntry) => {
    setDownloadingId(entry.id);
    try {
      await request(`/api/archive/${entry.id}/download`, { method: 'POST' });
      onNotice(`“${entry.content}”已加入 qBittorrent 下载队列。`);
      if (selected) await loadArchive(selected, true);
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : '无法提交下载。'); }
    finally { setDownloadingId(null); }
  };
  const copyMagnet = async (entry: ArchiveEntry) => {
    if (!entry.magnet_value) { onNotice('磁力链接不可用，请重新检索。'); return; }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(entry.magnet_value);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = entry.magnet_value;
        textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.append(textarea); textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('浏览器拒绝复制');
      }
      onNotice('磁力链接已复制到剪贴板。');
    } catch { onNotice('浏览器无法复制，请检查剪贴板权限。'); }
  };
  const archiveTotalPages = Math.max(1, Math.ceil(archiveTotal / archivePageSize));
  const clearArchiveFilters = () => { setArchiveQuery(''); setReleaseFrom(''); setReleaseTo(''); setArchivePage(1); };
  if (selected) return <section id="archive" className="archive-section">
    <div className="section-head"><div><button className="back-button" onClick={() => setSelected(null)}>← 内容档案</button><h2>{selected.name}</h2><p>{shortUrl(selected.url)} · 共 {selected.archive_count} 条归档内容{selected.full_scan_active ? ` · 全量 ${selected.initial_scan_pages_completed}/${selected.initial_scan_total ?? '?'}` : ''}</p><p className="archive-library-summary">影视库 · 已入库 {selected.jellyfin_available_count ?? 0}/{selected.archive_count}</p></div><div className="archive-actions"><button className="secondary" disabled={releaseBackfillBusy} onClick={() => void backfillReleaseDates()}>{releaseBackfillBusy ? '正在排队…' : '检索发行日期'}</button><button className="secondary" disabled={backfillBusy} onClick={() => void backfillMagnets()}>{backfillBusy ? '正在排队…' : '补全磁力链接'}</button><button className="secondary" disabled={downloadBackfillBusy} onClick={() => void backfillDownloads()}>{downloadBackfillBusy ? '正在排队…' : '提交可下载项'}</button><button className="quiet" onClick={() => void loadArchive(selected)}>↻ 刷新</button></div></div>
    <div className="archive-filter-bar"><input value={archiveQuery} onChange={(event) => { setArchiveQuery(event.target.value); setArchivePage(1); }} placeholder="筛选番号或标题" aria-label="筛选番号或标题" /><label>发行日期从<input type="date" value={releaseFrom} onChange={(event) => { setReleaseFrom(event.target.value); setArchivePage(1); }} /></label><label>至<input type="date" value={releaseTo} onChange={(event) => { setReleaseTo(event.target.value); setArchivePage(1); }} /></label>{(archiveQuery || releaseFrom || releaseTo) && <button className="quiet archive-filter-clear" type="button" onClick={clearArchiveFilters}>清除筛选</button>}</div>
    {loading ? <div className="empty">正在读取内容…</div> : error ? <div className="form-error">{error}</div> : entries.length === 0 ? <div className="empty-card archive-empty"><h3>尚无归档内容</h3><p>完成一次检查后，提取结果会出现在这里。</p></div> : <div className="archive-table-wrap"><table className="archive-table"><thead><tr><th className="archive-index">序号</th><th>番号</th><th>标题</th><th>发行日期</th><th>磁力链接</th><th>影视库</th><th>操作</th></tr></thead><tbody>{entries.map((entry, index) => { const detailUrl = archiveContentUrl(entry); const searchUrl = magnetSearchUrl(inspectionRules, entry.content); return <tr key={entry.id}><td className="archive-index">{index + 1}</td><td>{detailUrl ? <a className="archive-content-link" href={detailUrl} target="_blank" rel="noreferrer" title="打开所属网站的详情页"><code>{entry.content}</code></a> : <code>{entry.content}</code>}</td><td className="archive-title">{entry.title || '—'}</td><td><ReleaseDateCell entry={entry} /></td><td className="magnet-cell">{entry.magnet_status === 'found' ? <button className="magnet-action magnet-copy" type="button" onClick={() => void copyMagnet(entry)}>复制</button> : entry.magnet_status === 'skipped' ? <span className="magnet-action magnet-skipped" title="Jellyfin 已入库，自动跳过磁力检索">已跳过</span> : entry.magnet_status === 'pending' ? <span className="magnet-action magnet-pending">检索中</span> : entry.magnet_status === 'not_found' ? <button className="magnet-action magnet-retry" type="button" disabled={retryingId === entry.id} aria-busy={retryingId === entry.id} aria-label={retryingId === entry.id ? '正在加入磁力检索队列' : '未找到磁力链接，重新检索'} title={retryingId === entry.id ? '正在加入队列' : '未找到，点击重新检索'} onClick={() => void retryMagnet(entry)}>重试</button> : entry.magnet_status === 'failed' ? <button className="magnet-action magnet-retry magnet-failed" type="button" disabled={retryingId === entry.id} aria-busy={retryingId === entry.id} aria-label={retryingId === entry.id ? '正在加入磁力检索队列' : '磁力检索失败，重新检索'} title={retryingId === entry.id ? '正在加入队列' : '检索失败，点击重新检索'} onClick={() => void retryMagnet(entry)}>重试</button> : <span className="magnet-action">待补全</span>}</td><td className="jellyfin-cell"><JellyfinCell entry={entry} baseUrl={jellyfinBaseUrl} /></td><td className="download-cell">{entry.magnet_status === 'found' ? <DownloadCell entry={entry} downloadingId={downloadingId} onSubmit={submitDownload} /> : searchUrl ? <a className="download-action magnet-search-link" href={searchUrl} target="_blank" rel="noreferrer" title={`前往磁力搜索页面检索 ${entry.content}`}>搜索</a> : '—'}</td></tr>; })}</tbody></table></div>}
    {!loading && !error && <div className="archive-pagination"><span>共 {archiveTotal} 条 · 第 {archivePage} / {archiveTotalPages} 页</span><label>每页<select value={archivePageSize} onChange={(event) => { setArchivePageSize(Number(event.target.value)); setArchivePage(1); }}><option value={50}>50 条</option><option value={100}>100 条</option><option value={200}>200 条</option></select></label><button className="quiet" type="button" disabled={archivePage <= 1} onClick={() => setArchivePage((page) => page - 1)}>上一页</button><button className="quiet" type="button" disabled={archivePage >= archiveTotalPages} onClick={() => setArchivePage((page) => page + 1)}>下一页</button></div>}
  </section>;
  return <section id="archive" className="archive-section">
    <div className="section-head"><div><h2>内容档案</h2><p>按订阅查看首次获取到的内容。</p></div></div>
    {subscriptions.length === 0 ? <div className="empty-card archive-empty"><div className="empty-orbit">◌</div><h3>还没有订阅</h3><p>添加订阅并完成首次检查后，内容档案会自动建立。</p></div> : <div className="archive-subscription-grid">{subscriptions.map((subscription) => <button className="archive-subscription-card" key={subscription.id} onClick={() => void openArchive(subscription)}><span className="site-ident">{shortUrl(subscription.url).slice(0, 1).toUpperCase()}</span><span className="archive-card-copy"><strong>{subscription.name}</strong><small>{shortUrl(subscription.url)}</small></span><span className="archive-count"><b>{subscription.archive_count}</b><small>条内容</small></span><span className="archive-arrow">→</span></button>)}</div>}
  </section>;
}

const taskKindLabel: Record<TaskItem['kind'], string> = { check: '网页检查', full_scan: '全量检查', release: '发行日期', magnet: '磁力检索', library: '影视库匹配', download: '下载', library_sync: '影视库同步' };
const taskStatusLabel: Record<TaskStatus, string> = { queued: '排队中', running: '执行中', retrying: '等待重试', completed: '已完成', failed: '失败' };

type OperationScope = 'system' | 'check' | 'release' | 'magnet' | 'download' | 'library';

const operationDefinitions: Array<{ scope: OperationScope; service: string; label: string; description: string; kinds: TaskItem['kind'][] }> = [
  { scope: 'system', service: 'api', label: '网页服务', description: '网页接口、认证与系统级事件。', kinds: [] },
  { scope: 'check', service: 'capture', label: '网页检查', description: '订阅检查、计划任务与全量扫描。', kinds: ['check', 'full_scan'] },
  { scope: 'release', service: 'release', label: '发行日期', description: '详情页读取与发行日期补全。', kinds: ['release'] },
  { scope: 'magnet', service: 'magnet', label: '磁力检索', description: '搜索、详情页读取与磁力补全。', kinds: ['magnet'] },
  { scope: 'download', service: 'download', label: '下载', description: 'qBittorrent 提交、同步与完成状态。', kinds: ['download'] },
  { scope: 'library', service: 'library', label: '影视库', description: 'Jellyfin 单条匹配与媒体库同步。', kinds: ['library', 'library_sync'] }
];

const operationDefinition = (scope: OperationScope) => operationDefinitions.find((item) => item.scope === scope)!;

function taskMatchesScope(task: TaskItem, scope: OperationScope) {
  return operationDefinition(scope).kinds.includes(task.kind);
}

function TaskCenterPage({ data, error, scope }: { data: TasksResponse | null; error: string; scope: OperationScope }) {
  const [filter, setFilter] = useState<'all' | 'running' | 'queued' | 'failed' | 'completed'>('all');
  const definition = operationDefinition(scope);
  const service = data?.services.find((item) => item.name === definition.service);
  const scopedActive = (data?.active ?? []).filter((task) => taskMatchesScope(task, scope));
  const scopedHistory = (data?.history ?? []).filter((task) => taskMatchesScope(task, scope));
  const active = scopedActive.filter((task) => {
    if (filter === 'all') return true;
    if (filter === 'running') return task.status === 'running';
    if (filter === 'queued') return task.status === 'queued' || task.status === 'retrying';
    return false;
  });
  const history = scopedHistory.filter((task) => filter === 'all' || task.status === filter);
  const renderTask = (task: TaskItem) => {
    const progress = task.progress;
    const percent = progress?.total && progress.current !== null ? Math.max(0, Math.min(100, Math.round(progress.current / progress.total * 100))) : null;
    const description = progress?.label || (task.kind === 'check' ? task.status === 'running' ? '正在读取网页内容' : '单次检查完成' : null);
    return <article className={`task-entry ${task.status}`} key={task.id}>
      <div className="task-entry-head"><span className={`task-state ${task.status}`}>{taskStatusLabel[task.status]}</span><span className="task-kind">{taskKindLabel[task.kind]}</span>{task.priority >= 10 && <span className="task-priority">手动</span>}<time>{formatTime(task.startedAt ?? task.requestedAt ?? task.finishedAt)}</time></div>
      <div className="task-entry-copy"><strong>{task.subscriptionName ?? (task.kind === 'library_sync' ? 'Jellyfin 影视库' : '系统任务')}</strong>{task.content && <code title={task.content}>{task.content}</code>}{task.title && <span title={task.title}>{task.title}</span>}</div>
      {description && <p className="task-description">{description}</p>}
      {percent !== null && <div className="task-progress" aria-label={`${percent}%`}><i style={{ width: `${percent}%` }} /><span>{progress?.current} / {progress?.total}</span></div>}
      {task.status === 'retrying' && task.retryAfter && <p className="task-meta">将在 {formatTime(task.retryAfter)} 后重试（第 {task.attemptCount} 次）</p>}
      {task.error && <p className="task-error" title={task.error}>{task.error}</p>}
    </article>;
  };
  const serviceState = !service ? '状态读取中' : service.status === 'busy' ? '正在执行' : service.status === 'sleeping' ? '在线休眠' : service.healthy ? '在线待命' : service.status === 'missing' ? '未启动' : '需要注意';
  return <section className="task-center-page operation-task-panel">
    <div className="section-head"><div><p className="eyebrow">{definition.label}</p><h2>{definition.label}任务</h2><p>{definition.description}</p></div></div>
    <section className={`operation-worker-state ${service?.healthy ? service.status : 'error'}`}><div><strong>{serviceState}</strong><span>{service?.detail ?? '正在读取 Worker 心跳。'}</span></div><small>{service?.lastSeenAt ? `最近心跳 ${formatTime(service.lastSeenAt)}` : '尚未收到心跳'}</small></section>
    <div className="task-toolbar" role="group" aria-label="任务筛选">{([['all', '全部'], ['running', '执行中'], ['queued', '排队中'], ['failed', '失败'], ['completed', '最近完成']] as const).map(([key, label]) => <button key={key} type="button" className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div>
    {error ? <div className="form-error">{error}</div> : !data ? <div className="empty">正在读取任务状态…</div> : <>
      {(filter === 'all' || filter === 'running' || filter === 'queued') && <section className="task-list-section"><div className="task-list-heading"><h3>实时任务</h3><span>{active.length} 项</span></div>{active.length ? <div className="task-list">{active.map(renderTask)}</div> : <div className="empty-card task-empty"><h3>暂无匹配的实时任务</h3><p>新任务加入队列后会立即显示在这里。</p></div>}</section>}
      {(filter === 'all' || filter === 'failed' || filter === 'completed') && <section className="task-list-section"><div className="task-list-heading"><h3>最近记录</h3><span>最近 50 条</span></div>{history.length ? <div className="task-list">{history.map(renderTask)}</div> : <div className="empty-card task-empty"><h3>暂无匹配的历史任务</h3><p>任务完成或失败后会保留在这里。</p></div>}</section>}
    </>}
  </section>;
}

type OperationActivity =
  | { type: 'task'; id: string; at: string; level: 'success' | 'error'; task: TaskItem }
  | { type: 'log'; id: string; at: string; level: RuntimeLog['level']; log: RuntimeLog };

/**
 * A selected service is a small operational workspace, not two pages glued
 * together. Live queue work stays at the top; settled queue results and the
 * corresponding worker messages share one chronological activity stream.
 */
function ServiceOperationsPage({ data, error, scope }: { data: TasksResponse | null; error: string; scope: OperationScope }) {
  const definition = operationDefinition(scope);
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState('');
  const [filter, setFilter] = useState<'all' | 'tasks' | 'logs' | 'errors'>('all');
  const loadLogs = async () => {
    setLogsError('');
    try { setLogs(await request<RuntimeLog[]>(`/api/logs?limit=300&scope=${scope}`)); }
    catch (reason) { setLogsError(reason instanceof Error ? reason.message : '无法读取服务执行记录。'); }
    finally { setLogsLoading(false); }
  };
  useEffect(() => {
    setLogsLoading(true);
    void loadLogs();
    return subscribeLive('logs', () => void loadLogs());
  }, [scope]);
  const active = (data?.active ?? []).filter((task) => taskMatchesScope(task, scope));
  const history = (data?.history ?? []).filter((task) => taskMatchesScope(task, scope));
  const activities: OperationActivity[] = [
    ...history.map((task) => ({ type: 'task' as const, id: task.id, at: task.finishedAt ?? task.startedAt ?? task.requestedAt ?? '', level: task.status === 'failed' ? 'error' as const : 'success' as const, task })),
    ...logs.map((log) => ({ type: 'log' as const, id: `log-${log.id}`, at: log.created_at, level: log.level, log }))
  ].sort((left, right) => right.at.localeCompare(left.at));
  const visibleActivities = activities.filter((activity) => {
    if (filter === 'all') return true;
    if (filter === 'tasks') return activity.type === 'task';
    if (filter === 'logs') return activity.type === 'log';
    return activity.level === 'error';
  }).slice(0, 300);
  const running = active.filter((task) => task.status === 'running').length;
  const queued = active.filter((task) => task.status === 'queued' || task.status === 'retrying').length;
  const renderLiveTask = (task: TaskItem) => {
    return <article className={`operation-queue-entry ${task.status}`} key={task.id}>
      <header><span className={`task-state ${task.status}`}>{taskStatusLabel[task.status]}</span>{task.priority >= 10 && <span className="task-priority">手动</span>}<time>{formatTime(task.startedAt ?? task.requestedAt)}</time></header>
      <strong>{task.subscriptionName ?? (task.kind === 'library_sync' ? 'Jellyfin 影视库' : '系统任务')}</strong>
      <p>{[task.content, task.title].filter(Boolean).join(' · ') || task.progress?.label || '等待 Worker 开始处理'}</p>
      {task.status === 'retrying' && task.retryAfter && <small>将在 {formatTime(task.retryAfter)} 后重试</small>}
      {task.error && <small className="task-error" title={task.error}>{task.error}</small>}
    </article>;
  };
  return <section className="operation-detail-page">
    <section className="operation-queue-section"><div className="operation-section-heading"><div><h2>当前队列</h2><p>{definition.description}</p></div><span>{running} 执行中 · {queued} 排队</span></div>{error ? <div className="form-error">{error}</div> : !data ? <div className="empty">正在读取队列…</div> : active.length ? <div className="operation-queue-list">{active.map(renderLiveTask)}</div> : <div className="operation-queue-empty">当前没有执行或排队的项目。</div>}</section>
    <section className="operation-activity-section"><div className="operation-section-heading"><div><h2>执行记录</h2><p>任务完成、失败与 Worker 日志按发生时间汇总显示。</p></div><span>实时更新</span></div><div className="operation-activity-filter" role="group" aria-label="执行记录筛选">{([['all', '全部'], ['tasks', '任务结果'], ['logs', '运行日志'], ['errors', '异常']] as const).map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div>{logsError ? <div className="form-error">{logsError}</div> : logsLoading && !activities.length ? <div className="empty">正在读取执行记录…</div> : visibleActivities.length ? <div className="operation-activity-list">{visibleActivities.map((activity) => {
      if (activity.type === 'task') {
        const task = activity.task;
        const target = [task.subscriptionName, task.content, task.title].filter(Boolean).join(' · ') || '系统任务';
        const detail = task.error ?? task.progress?.label;
        return <article className={`operation-activity-entry ${activity.level}`} key={activity.id}><div className="operation-activity-meta"><span className={`task-state ${task.status}`}>{task.status === 'failed' ? '任务失败' : '任务完成'}</span><span>{taskKindLabel[task.kind]}</span><p title={target}>{target}</p>{detail && <small className={task.error ? 'task-error' : undefined} title={detail}>{detail}</small>}<time>{formatTime(activity.at)}</time></div></article>;
      }
      const log = activity.log;
      const isMagnetNotFound = log.level === 'info' && /^磁力检索(?:未找到|完成)/.test(log.message);
      const displayLevel = isMagnetNotFound ? 'success' : log.level;
      const source = log.subscription_name ? `${log.subscription_name}${log.subscription_url ? ` · ${shortUrl(log.subscription_url)}` : ''}` : 'Page Watch';
      return <article className={`operation-activity-entry ${displayLevel}`} key={activity.id}><div className="operation-activity-meta"><span className={`task-state ${displayLevel === 'error' ? 'failed' : displayLevel === 'success' ? 'completed' : 'queued'}`}>{displayLevel === 'error' ? '异常' : displayLevel === 'success' ? '完成' : '日志'}</span><span>Worker 日志</span><p title={log.message}>{log.message}</p><small title={source}>{source}</small><time>{formatTime(log.created_at)}</time></div></article>;
    })}</div> : <div className="operation-queue-empty">尚无此服务的执行记录。</div>}</section>
  </section>;
}

const metricWorkerLabel: Record<PerformanceMetrics['workers'][number]['scope'], string> = { capture: '网页检查', release: '发行日期', magnet: '磁力检索', library: '影视库', download: '下载' };
const retryReasonLabel: Record<string, string> = { rate_limited: '限流', timeout: '超时', dns: 'DNS', proxy: '代理', server_5xx: '服务端 5xx', network: '网络', transient_other: '其他暂时错误' };
const chromiumReasonLabel: Record<string, string> = { disconnected: '浏览器断连', proxy_changed: '代理变更', page_limit: '页数上限', age_limit: '运行时限', error: '读取异常' };

function PerformanceOverview({ metrics, error, integrations, range, onRange }: { metrics: PerformanceMetrics | null; error: string; integrations: TasksResponse['integrations']; range: PerformanceMetrics['range']; onRange: (range: PerformanceMetrics['range']) => void }) {
  const minuteTotals = new Map<string, number>();
  for (const point of metrics?.throughput ?? []) minuteTotals.set(point.minute, (minuteTotals.get(point.minute) ?? 0) + point.count);
  const trend = [...minuteTotals.entries()].slice(-60);
  const max = Math.max(1, ...trend.map(([, count]) => count));
  const retries = (metrics?.retries ?? []).sort((left, right) => right.count - left.count);
  const rebuilds = (metrics?.chromiumRebuilds ?? []).sort((left, right) => right.count - left.count);
  const runtime = metrics?.runtime ?? { containerMemoryBytes: null, apiRssBytes: null, runnerRssBytes: null, engineState: 'sleeping', engineLastStartedAt: null, engineStartCount: 0, webExecutorRssBytes: null, webExecutorState: 'offline', librarySyncRssBytes: null, librarySyncState: 'offline', browser: { state: 'unknown', activePages: null, queuedPages: null, navigationCount: null }, engineMemoryReclaim: { state: 'waiting', gcBeforeBytes: null, gcAfterBytes: null } };
  const reclaimState = runtime.engineMemoryReclaim.state === 'restarting'
    ? '正在安全重启执行引擎以回收内存'
    : runtime.engineMemoryReclaim.state === 'process_exit'
      ? '执行引擎已按空闲策略退出，RSS 已释放'
    : runtime.engineMemoryReclaim.state === 'gc_complete'
      ? `已执行受控 GC${runtime.engineMemoryReclaim.gcBeforeBytes !== null && runtime.engineMemoryReclaim.gcAfterBytes !== null ? `：${formatBytes(runtime.engineMemoryReclaim.gcBeforeBytes)} → ${formatBytes(runtime.engineMemoryReclaim.gcAfterBytes)}` : ''}`
      : runtime.engineMemoryReclaim.state === 'gc_unavailable'
        ? '受控 GC 不可用；达到条件时将安全重启执行引擎'
        : '已启用：队列和浏览器持续空闲后自动回收';
  return <section className="performance-overview" aria-label="长期性能指标">
    <div className="operation-section-heading"><div><h2>性能概览</h2><p>指标仅记录聚合计数与耗时；分钟数据保留 30 天，之后按小时汇总至 180 天。</p></div><div className="metric-range" role="group" aria-label="性能指标时间范围">{(['24h', '7d', '30d', '180d'] as const).map((item) => <button type="button" key={item} className={range === item ? 'active' : ''} onClick={() => onRange(item)}>{item}</button>)}</div></div>
    {!metrics ? <div className={`operation-queue-empty ${error ? 'metric-load-error' : ''}`}>{error || '正在读取长期性能指标…'}</div> : <>
      <div className="external-integrations" aria-label="外部服务状态">{integrations.map((integration) => {
        const label = integration.name === 'jellyfin' ? 'Jellyfin' : 'qBittorrent';
        const status = integration.status === 'healthy' ? '正常' : integration.status === 'degraded' ? '降级' : integration.status === 'disabled' ? '已停用' : integration.configured ? '未检测' : '未配置';
        return <article className={integration.status} key={integration.name}><strong>{label}</strong><span>{status}</span><small title={integration.detail ?? undefined}>{integration.status === 'degraded' ? (integration.detail ?? '最近连接失败，核心服务仍可使用。') : integration.status === 'disabled' ? '未纳入核心就绪检查' : integration.configured ? '不纳入 Docker 就绪门槛' : '尚未完成连接配置'}</small></article>;
      })}</div>
      <div className="performance-cards">
        <article><span>容器内存</span><strong>{formatBytes(runtime.containerMemoryBytes)}</strong><small>API {formatBytes(runtime.apiRssBytes)} · 引擎 {formatBytes(runtime.runnerRssBytes)}</small></article>
        <article><span>Jellyfin 缓存命中率</span><strong>{metrics.jellyfinCache.hitRate === null ? '—' : `${Math.round(metrics.jellyfinCache.hitRate * 100)}%`}</strong><small>{metrics.jellyfinCache.hit} 命中 · {metrics.jellyfinCache.miss} 未命中</small></article>
        <article><span>Chromium 重建</span><strong>{rebuilds.reduce((total, item) => total + item.count, 0)}</strong><small>{rebuilds.length ? rebuilds.map((item) => `${metricWorkerLabel[item.scope as keyof typeof metricWorkerLabel] ?? item.scope} ${chromiumReasonLabel[item.reason] ?? item.reason} ${item.count}`).join(' · ') : '当前范围内没有重建'}</small></article>
        <article><span>自动重试</span><strong>{retries.reduce((total, item) => total + item.count, 0)}</strong><small>{retries.length ? retries.slice(0, 3).map((item) => `${retryReasonLabel[item.reason] ?? item.reason} ${item.count}`).join(' · ') : '当前范围内没有自动重试'}</small></article>
      </div>
      <p className="browser-runtime-state">网页执行器：{runtime.webExecutorState === 'offline' ? '已回收（Chromium 不存在）' : runtime.webExecutorState === 'busy' ? '正在执行' : runtime.webExecutorState === 'browser_idle' ? '浏览器空闲待命' : '正在启动'}{runtime.webExecutorState === 'offline' ? '' : ` · RSS ${formatBytes(runtime.webExecutorRssBytes)}`} · 浏览器池：{runtime.browser.state === 'active' ? '正在渲染' : runtime.browser.state === 'idle' ? '空闲待命' : runtime.browser.state === 'closed' ? '已回收' : '状态读取中'} · {runtime.browser.activePages ?? 0} 页面执行中 · {runtime.browser.queuedPages ?? 0} 页面排队 · 本轮 {runtime.browser.navigationCount ?? 0} 次导航</p>
      <p className="browser-runtime-state">Jellyfin 同步器：{runtime.librarySyncState === 'offline' ? '已回收' : runtime.librarySyncState === 'running' ? '正在同步' : runtime.librarySyncState === 'starting' ? '正在启动' : runtime.librarySyncState}{runtime.librarySyncState === 'offline' ? '' : ` · RSS ${formatBytes(runtime.librarySyncRssBytes)}`}</p>
      <p className="browser-runtime-state">统一执行引擎：{runtime.engineState === 'sleeping' ? '在线休眠（有任务会立即启动）' : runtime.engineState === 'starting' ? '正在启动' : runtime.engineState === 'running' ? '正在执行或等待队列' : runtime.engineState === 'error' ? '最近一次异常退出，等待下一次唤醒' : runtime.engineState} · 本次运行已启动 {runtime.engineStartCount} 次{runtime.engineLastStartedAt ? ` · 最近启动 ${formatTime(runtime.engineLastStartedAt)}` : ''}</p>
      <p className="browser-runtime-state">空闲内存回收：{reclaimState}</p>
      <section className="throughput-chart"><header><strong>每分钟处理量</strong><small>最近 60 分钟</small></header><div className="throughput-bars" aria-label="最近 60 分钟处理量趋势">{trend.length ? trend.map(([minute, count]) => <i key={minute} title={`${formatTime(minute)}：${count} 项`} style={{ height: `${Math.max(4, Math.round(count / max * 100))}%` }} />) : <span>尚无处理记录</span>}</div></section>
      <div className="worker-performance-list">{metrics.workers.map((worker) => <article key={worker.scope}><strong>{metricWorkerLabel[worker.scope]}</strong><span>{worker.processed} 项</span><small>平均 {formatDuration(worker.averageDurationMs)}</small></article>)}</div>
    </>}
  </section>;
}

function OperationsCenterPage({ onSummary }: { onSummary: (summary: TasksResponse['summary']) => void }) {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [scope, setScope] = useState<OperationScope | null>(null);
  const [error, setError] = useState('');
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [metricsError, setMetricsError] = useState('');
  const [metricRange, setMetricRange] = useState<PerformanceMetrics['range']>('24h');
  const load = async () => {
    try {
      const [summary, active, history] = await Promise.all([
        request<Omit<TasksResponse, 'active' | 'history'>>('/api/tasks/summary'),
        request<Pick<TasksResponse, 'generatedAt' | 'active'>>('/api/tasks/active'),
        request<{ items: TaskItem[] }>('/api/tasks/history?limit=50')
      ]);
      const next: TasksResponse = { ...summary, active: active.active, history: history.items };
      setData(next); onSummary(next.summary); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取运行状态。'); }
  };
  useEffect(() => {
    void load();
    let timer: number | null = null;
    const refresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => { timer = null; void load(); }, 250);
    };
    const unsubscribers = [subscribeLive('task-summary', refresh), subscribeLive('task-active', refresh), subscribeLive('services', refresh)];
    return () => { if (timer !== null) window.clearTimeout(timer); unsubscribers.forEach((unsubscribe) => unsubscribe()); };
  }, []);
  useEffect(() => {
    if (scope) return;
    const loadMetrics = () => void Promise.all([
      request<Omit<PerformanceMetrics, 'throughput'>>(`/api/metrics/summary?range=${metricRange}`),
      request<Pick<PerformanceMetrics, 'throughput'>>('/api/metrics/timeseries')
    ]).then(([summary, timeseries]) => { setMetrics({ ...summary, ...timeseries }); setMetricsError(''); }).catch(() => {
      setMetrics(null);
      setMetricsError('性能指标接口暂不可用。请确认网页服务已更新并重新启动。');
    });
    loadMetrics();
    let timer: number | null = null;
    const refresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => { timer = null; loadMetrics(); }, 1_000);
    };
    const unsubscribe = subscribeLive('metrics', refresh);
    return () => { if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [metricRange, scope]);
  const summary = data?.summary;
  return <section id="operations" className="operations-center-page">
    <div className="section-head"><div><h2>运行中心</h2><p>选择一项服务，查看它自己的实时队列、任务进度和运行日志。</p></div><button type="button" className="quiet" onClick={() => void load()}>↻ 刷新</button></div>
    <section className="task-summary operation-summary" aria-label="运行概览">{[
      ['服务在线', summary?.servicesOnline ?? '—'], ['执行中', summary?.running ?? '—'], ['排队中', summary?.queued ?? '—'], ['等待重试', summary?.retrying ?? '—']
    ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    {!scope && <PerformanceOverview metrics={metrics} error={metricsError} integrations={data?.integrations ?? []} range={metricRange} onRange={setMetricRange} />}
    <section className="operation-service-panel"><div className="task-list-heading"><h3>服务</h3><span>点击查看对应任务与日志</span></div><div className="operation-service-grid">{operationDefinitions.map((definition) => {
      const service = data?.services.find((item) => item.name === definition.service);
      const tasks = (data?.active ?? []).filter((task) => taskMatchesScope(task, definition.scope));
      const running = tasks.filter((task) => task.status === 'running').length;
      const waiting = tasks.filter((task) => task.status === 'queued' || task.status === 'retrying').length;
      const progress = tasks.find((task) => task.progress?.total && task.progress.current !== null)?.progress ?? null;
      const percent = progress?.total && progress.current !== null ? Math.max(0, Math.min(100, Math.round(progress.current / progress.total * 100))) : null;
      return <button type="button" key={definition.scope} className={`operation-service ${scope === definition.scope ? 'selected' : ''} ${service?.healthy ? service.status : 'error'}`} onClick={() => setScope(definition.scope)}>
        <span className="operation-service-top"><strong>{definition.label}</strong><em>{service?.status === 'busy' ? '执行中' : service?.status === 'sleeping' ? '休眠' : service?.healthy ? '在线' : service?.status === 'missing' ? '未启动' : '注意'}</em></span>
        <small title={service?.detail}>{service?.detail ?? '正在读取服务状态。'}</small>
        {percent !== null && <div className="operation-service-progress" title={progress?.label ?? undefined}><i style={{ width: `${percent}%` }} /><span>{progress?.current} / {progress?.total}</span></div>}
        <footer>{definition.kinds.length ? <>{running} 执行中 · {waiting} 排队</> : '系统事件与网页接口状态'}<span>→</span></footer>
      </button>;
    })}</div></section>
    {scope ? <><div className="operation-detail-nav"><button type="button" className="quiet" onClick={() => setScope(null)}>← 返回服务概览</button><span>当前查看：{operationDefinition(scope).label}</span></div><ServiceOperationsPage key={scope} data={data} error={error} scope={scope} /></> : <div className="operation-empty"><span>◫</span><strong>选择一项服务查看详情</strong><p>进入后只显示该服务的任务队列、执行进度与执行记录，不再与其他服务混在一起。</p></div>}
  </section>;
}

function RuntimeLogsPage({ scope }: { scope: OperationScope }) {
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [filter, setFilter] = useState<'all' | RuntimeLog['level']>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadLogs = async () => {
    setError('');
    try { setLogs(await request<RuntimeLog[]>(`/api/logs?limit=300&scope=${scope}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取运行日志。'); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    setLoading(true);
    void loadLogs();
    return subscribeLive('logs', () => void loadLogs());
  }, [scope]);
  const visibleLogs = filter === 'all' ? logs : logs.filter((entry) => entry.level === filter);
  const levelLabel: Record<RuntimeLog['level'], string> = { info: '信息', success: '完成', error: '失败' };
  const sourceLabel: Record<RuntimeLog['source'], string> = { system: '系统', queue: '队列', worker: 'Worker', download: '下载', library: '影视库' };
  const definition = operationDefinition(scope);
  return <section id="logs" className="runtime-log-section operation-log-section">
    <div className="section-head"><div><p className="eyebrow">{definition.label}</p><h2>{definition.label}日志</h2><p>实时更新；仅显示此服务的记录，数据库仍保留最近 1,000 条全局日志。</p></div><button className="quiet" onClick={() => void loadLogs()}>↻ 刷新</button></div>
    <div className="log-toolbar" role="group" aria-label="日志级别筛选"><span>筛选</span>{(['all', 'info', 'success', 'error'] as const).map((level) => <button key={level} className={filter === level ? 'active' : ''} type="button" onClick={() => setFilter(level)}>{level === 'all' ? `全部 ${logs.length}` : levelLabel[level]}</button>)}</div>
    {loading ? <div className="empty">正在读取运行日志…</div> : error ? <div className="form-error">{error}</div> : visibleLogs.length === 0 ? <div className="empty-card runtime-log-empty"><div className="empty-orbit">≡</div><h3>尚无运行日志</h3><p>开始一次检查后，执行过程和错误信息会显示在这里。</p></div> : <div className="runtime-log-list">{visibleLogs.map((entry) => {
      const isFinishedMagnetNotFound = entry.level === 'info' && /^磁力检索(?:未找到|完成)/.test(entry.message);
      const displayLevel = isFinishedMagnetNotFound ? 'success' : entry.level;
      return <article className={`runtime-log-entry ${displayLevel}`} key={entry.id}><div className="runtime-log-meta"><span className={`log-level ${displayLevel}`}>{levelLabel[displayLevel]}</span><span>{sourceLabel[entry.source]}</span></div><p title={entry.message}>{entry.message}</p><footer>{entry.subscription_name ? <><strong>{entry.subscription_name}</strong><span>{entry.subscription_url ? shortUrl(entry.subscription_url) : ''}</span></> : <span>{entry.subscription_id ? '已删除订阅' : 'Page Watch'}</span>}{entry.job_id && <code>任务 #{entry.job_id}</code>}</footer><time className="runtime-log-time">{formatTime(entry.created_at)}</time></article>;
    })}</div>}
  </section>;
}

type ValueSource = 'text' | 'attribute';
type InspectionRules = {
  releaseDate: {
    enabled: boolean; urlTemplate: string; renderMode: 'static' | 'dynamic'; containerSelector: string; labelSelector: string; labelText: string; valueSelector: string; valueSource: ValueSource; valueAttribute: string; valueMatchPattern: string; requestIntervalMs: number;
  };
  magnet: {
    enabled: boolean; origins: string[]; searchUrlTemplate: string; itemSelector: string; filenameSelector: string; filenamePrefix: string; fallbackFilenamePrefixes: string[]; detailLinkSelector: string; detailPathPrefix: string; valueSelector: string; valueSource: ValueSource; valueAttribute: string; valueMatchPattern: string; requestIntervalMs: number;
  };
};

const defaultInspectionRules: InspectionRules = {
  releaseDate: { enabled: true, urlTemplate: '{{detailUrl}}', renderMode: 'dynamic', containerSelector: 'div.text-secondary', labelSelector: 'span', labelText: '发行日期', valueSelector: 'time', valueSource: 'attribute', valueAttribute: 'datetime', valueMatchPattern: '\\b(?:19\\d{2}|20\\d{2})-\\d{2}-\\d{2}(?!\\d)', requestIntervalMs: 800 },
  magnet: { enabled: true, origins: ['https://cilisousuo.co', 'https://cilisousuo.cc', 'https://cilisousuo.net'], searchUrlTemplate: '{{origin}}/search?q={{content}}', itemSelector: 'li.item', filenameSelector: '.filename', filenamePrefix: 'hhd800.com@', fallbackFilenamePrefixes: ['4k688.com@'], detailLinkSelector: 'a.link', detailPathPrefix: '/magnet/', valueSelector: 'input#input-magnet', valueSource: 'attribute', valueAttribute: 'value', valueMatchPattern: '^magnet:\\?', requestIntervalMs: 800 }
};

function freshDefaultInspectionRules() {
  return JSON.parse(JSON.stringify(defaultInspectionRules)) as InspectionRules;
}

function RuleFlow({ children }: { children: ReactNode }) {
  return <div className="rule-flow" aria-label="规则执行流程">{children}</div>;
}

type MissavPresetDraft = { presetId: number | null; preset: PresetForm };

function RulesLibrary({ open, onToggle, onNotice }: { open: boolean; onToggle: () => void; onNotice: (message: string) => void }) {
  const presetDraftRef = useRef<MissavPresetDraft | null>(null);
  const inspectionDraftRef = useRef<InspectionRules | null>(null);
  const [saving, setSaving] = useState(false);
  const saveAll = async () => {
    if (!presetDraftRef.current || !inspectionDraftRef.current) { onNotice('规则仍在读取，请稍后再保存。'); return; }
    setSaving(true);
    try {
      await request('/api/rules/missav', { method: 'PUT', body: JSON.stringify({ ...presetDraftRef.current, inspectionRules: inspectionDraftRef.current }) });
      onNotice('MissAV 检查规则已保存。');
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : 'MissAV 检查规则无法保存。'); }
    finally { setSaving(false); }
  };
  return <section id="rules-library" className={`rules-library ${open ? 'is-open' : ''}`}>
    <div className="section-head rules-library-head"><div><p className="eyebrow">MissAV</p><h2>MissAV 检查规则</h2><p>一条检查流程依次读取列表页内容、补全发行日期，再检索磁力链接。</p></div><button type="button" className="secondary" aria-expanded={open} onClick={onToggle}>{open ? '收起检查规则' : '检查规则'}</button></div>
    {open && <div className="rules-library-content"><div className="rules-library-workbench"><RuleFlow><code>MissAV 列表页</code><i>→</i><strong>番号与标题</strong><i>→</i><code>详情页</code><i>→</i><strong>发行日期</strong><i>→</i><code>磁力搜索</code><i>→</i><strong>磁力链接</strong></RuleFlow><SubscriptionPresetLibrary registerDraft={(draft) => { presetDraftRef.current = draft; }}><InspectionRulesPage embedded onNotice={onNotice} registerDraft={(draft) => { inspectionDraftRef.current = draft; }} /></SubscriptionPresetLibrary><div className="rule-save-actions"><button type="button" className="primary" disabled={saving} onClick={() => void saveAll()}>{saving ? '保存中…' : '保存规则'}</button></div></div></div>}
  </section>;
}

function SubscriptionReadingRules({ subscriptions, targetSubscriptionId, onSubscriptionsChanged, onNotice }: { subscriptions: Subscription[]; targetSubscriptionId: number | null; onSubscriptionsChanged: () => Promise<void>; onNotice: (message: string) => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<FormData>(blankForm);
  const [presets, setPresets] = useState<SubscriptionPreset[]>([]);
  const [preview, setPreview] = useState<{ title: string; content: string; items?: Array<{ content: string; title: string | null }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = subscriptions.find((item) => item.id === selectedId) ?? null;
  const update = <K extends keyof FormData>(key: K, value: FormData[K]) => setForm((old) => ({ ...old, [key]: value }));

  useEffect(() => {
    setSelectedId((current) => {
      const candidate = targetSubscriptionId ?? current;
      return subscriptions.some((item) => item.id === candidate) ? candidate : subscriptions[0]?.id ?? null;
    });
  }, [subscriptions, targetSubscriptionId]);
  useEffect(() => {
    if (!selected) return;
    setForm(subscriptionToForm(selected)); setPreview(null); setError('');
  }, [selectedId]);
  useEffect(() => { void request<SubscriptionPreset[]>('/api/subscription-presets').then(setPresets).catch(() => setPresets([])); }, []);

  function applyPreset(id: string) {
    const preset = presets.find((item) => String(item.id) === id);
    if (!preset) return;
    setForm((old) => ({ ...old, selector: preset.selector, renderMode: preset.render_mode, contentSource: preset.content_source, attributeName: preset.attribute_name ?? '', matchPattern: preset.match_pattern ?? '', titleSelector: preset.title_selector ?? '', titleContentSource: preset.title_content_source ?? 'text', titleAttributeName: preset.title_attribute_name ?? '', titleMatchPattern: preset.title_match_pattern ?? '', resultMode: preset.result_mode, paginationSelector: preset.pagination_selector ?? '', paginationParameter: preset.pagination_parameter ?? 'page', paginationMatchPattern: preset.pagination_match_pattern ?? '' }));
  }
  async function saveRules() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const saved = await request<Subscription>(`/api/subscriptions/${selected.id}`, { method: 'PUT', body: JSON.stringify(form) });
      setForm(subscriptionToForm(saved)); await onSubscriptionsChanged(); onNotice(`“${saved.name}”的读取规则已保存。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存读取规则。'); }
    finally { setBusy(false); }
  }
  async function previewCapture() {
    if (!selected) return;
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await request('/api/subscriptions/preview', { method: 'POST', body: JSON.stringify(form) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '预览失败。'); }
    finally { setBusy(false); }
  }
  async function fullScan() {
    if (!selected) return;
    setBusy(true); setError('');
    try { await request(`/api/subscriptions/${selected.id}/full-scan`, { method: 'POST' }); await onSubscriptionsChanged(); onNotice('已加入全量检查队列。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法开始全量检查。'); }
    finally { setBusy(false); }
  }
  async function clearArchive() {
    if (!selected || !window.confirm(`重置“${selected.name}”的检查数据？内容档案和当前对比基准都会删除，此操作不可恢复。`)) return;
    setBusy(true); setError('');
    try { await request(`/api/subscriptions/${selected.id}/archive`, { method: 'DELETE' }); await onSubscriptionsChanged(); onNotice('订阅数据已重置。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法重置订阅数据。'); }
    finally { setBusy(false); }
  }

  return <section className="subscription-reading-rules">
    <header className="subscription-rule-head"><div><span className="rule-kind">订阅级</span><h3>订阅页面读取规则</h3><p>内容、标题、分页及读取方式都在此配置；订阅编辑页只保留名称、地址和检查计划。</p></div><div className="subscription-rule-selects"><label>目标订阅<select value={selectedId ?? ''} disabled={!subscriptions.length || busy} onChange={(event) => setSelectedId(Number(event.target.value))}>{subscriptions.map((item) => <option key={item.id} value={item.id}>{item.name} · {shortUrl(item.url)}</option>)}</select></label><label>套用预设<select defaultValue="" disabled={!selected || busy} onChange={(event) => { applyPreset(event.target.value); event.currentTarget.value = ''; }}><option value="">选择预设规则</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label></div></header>
    {!selected ? <div className="empty rule-library-empty">请先新建一个订阅，再在这里设置它的页面读取规则。</div> : <>
      <RuleFlow><code>列表页</code><i>→</i><code>{form.selector || '内容 Selector'}</code><i>→</i><code>{form.matchPattern || '内容匹配'}</code><i>→</i><code>{form.titleSelector || '标题（可选）'}</code><i>→</i><code>{form.paginationSelector || '分页（可选）'}</code><i>→</i><strong>内容档案</strong></RuleFlow>
      <div className="rule-grid"><label>内容 CSS Selector<input disabled={busy} value={form.selector} onChange={(event) => update('selector', event.target.value)} placeholder="例如 a.text-secondary[alt]" /></label><label>读取方式<select disabled={busy} value={form.renderMode} onChange={(event) => update('renderMode', event.target.value as FormData['renderMode'])}><option value="static">HTML 抓取（优先）</option><option value="dynamic">浏览器渲染</option></select></label><label>提取内容<select disabled={busy} value={form.contentSource} onChange={(event) => update('contentSource', event.target.value as FormData['contentSource'])}><option value="text">标签中的文字</option><option value="attribute">指定属性的值</option></select></label>{form.contentSource === 'attribute' ? <label>属性名<input disabled={busy} value={form.attributeName} onChange={(event) => update('attributeName', event.target.value)} placeholder="例如 alt、href、data-id" /></label> : <div className="rule-hint">将直接读取所选标签的可见文字。</div>}<label>匹配范围<select disabled={busy} value={form.resultMode} onChange={(event) => update('resultMode', event.target.value as FormData['resultMode'])}><option value="first">仅第一项</option><option value="all">全部匹配项</option></select></label><label>内容匹配规则<input disabled={busy} value={form.matchPattern} onChange={(event) => update('matchPattern', event.target.value)} placeholder="可选；优先保存第一个括号" /></label></div>
      <section className="subscription-rule-section"><header><div><h4>标题读取</h4><p>与内容按页面内的条目顺序配对保存。</p></div><label className="toggle"><input type="checkbox" checked={Boolean(form.titleSelector)} disabled={busy} onChange={(event) => setForm((old) => event.target.checked ? { ...old, titleSelector: old.selector, titleContentSource: 'text', titleAttributeName: '', titleMatchPattern: old.titleMatchPattern } : { ...old, titleSelector: '', titleAttributeName: '', titleMatchPattern: '' })} /><span />读取并保存标题</label></header>{form.titleSelector && <div className="rule-grid"><label>标题 CSS Selector<input disabled={busy} value={form.titleSelector} onChange={(event) => update('titleSelector', event.target.value)} /></label><label>标题来源<select disabled={busy} value={form.titleContentSource} onChange={(event) => update('titleContentSource', event.target.value as FormData['titleContentSource'])}><option value="text">标签中的文字</option><option value="attribute">指定属性的值</option></select></label>{form.titleContentSource === 'attribute' ? <label>标题属性名<input disabled={busy} value={form.titleAttributeName} onChange={(event) => update('titleAttributeName', event.target.value)} placeholder="例如 alt" /></label> : <div className="rule-hint">将直接读取标题标签的可见文字。</div>}<label className="rule-wide">标题匹配规则<input disabled={busy} value={form.titleMatchPattern} onChange={(event) => update('titleMatchPattern', event.target.value)} placeholder="可选；优先保存第一个括号" /></label></div>}</section>
      <section className="subscription-rule-section"><header><div><h4>分页读取</h4><p>仅首次检查或点击全量检查时，依页码逐页读取。</p></div><label className="toggle"><input type="checkbox" checked={Boolean(form.paginationSelector)} disabled={busy} onChange={(event) => setForm((old) => event.target.checked ? { ...old, paginationSelector: old.paginationSelector || '#page-count', paginationParameter: old.paginationParameter || 'page', paginationMatchPattern: old.paginationMatchPattern || '(\\d+)' } : { ...old, paginationSelector: '', paginationMatchPattern: '' })} /><span />启用分页读取</label></header>{form.paginationSelector && <div className="rule-grid"><label>页数 CSS Selector<input disabled={busy} value={form.paginationSelector} onChange={(event) => update('paginationSelector', event.target.value)} placeholder="例如 .pagination-total" /></label><label>页码参数名<input disabled={busy} value={form.paginationParameter} onChange={(event) => update('paginationParameter', event.target.value)} placeholder="例如 page" /></label><label className="rule-wide">页数匹配规则<input disabled={busy} value={form.paginationMatchPattern} onChange={(event) => update('paginationMatchPattern', event.target.value)} placeholder="例如 (\\d+)" /><span className="field-note">系统使用正则第一个括号作为总页数，并在网址中追加页码参数。</span></label></div>}</section>
      {error && <p className="form-error">{error}</p>}{preview && <div className="preview rule-preview"><span>已提取 · {preview.title}</span>{preview.items?.length ? <div className="title-preview">{preview.items.slice(0, 8).map((entry, index) => <div key={`${entry.content}-${index}`}><code>{entry.content}</code><p>{entry.title || '未读取标题'}</p></div>)}</div> : <p>{preview.content}</p>}</div>}
      <footer className="subscription-rule-actions"><div><button type="button" className="secondary" disabled={busy} onClick={() => void previewCapture()}>{busy ? '处理中…' : '预览抽取'}</button>{selected.pagination_selector && <button type="button" className="secondary" disabled={busy} onClick={() => void fullScan()}>{busy ? '处理中…' : '全量检查'}</button>}<button type="button" className="secondary danger-button" disabled={busy} onClick={() => void clearArchive()}>重置订阅数据</button></div><button type="button" className="primary" disabled={busy} onClick={() => void saveRules()}>{busy ? '保存中…' : '保存读取规则'}</button></footer>
    </>}
  </section>;
}

function SubscriptionPresetLibrary({ children, registerDraft }: { children: ReactNode; registerDraft: (draft: MissavPresetDraft) => void }) {
  const [presets, setPresets] = useState<SubscriptionPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadPresets = async () => {
    try { setError(''); setPresets(await request<SubscriptionPreset[]>('/api/subscription-presets')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取检查规则。'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadPresets(); }, []);
  return <section className="subscription-preset-library">
    <div className="preset-library-head"><div><span className="rule-kind">流程第 1 步</span><h3>列表读取</h3><p>读取番号、标题和分页；新建 MissAV 订阅时选择一条列表规则即可填入。</p></div></div>
    {loading ? <p className="preset-library-loading">正在读取检查规则…</p> : error ? <p className="form-error">{error}</p> : <div className="preset-library-list">{presets.length ? presets.map((preset) => <span key={preset.id} title={preset.description || preset.selector}>{preset.name}</span>) : <span className="preset-library-empty">还没有检查规则</span>}</div>}
    <div className="rules-editor-content"><PresetManager embedded presets={presets} onClose={() => undefined} onChanged={loadPresets} registerDraft={registerDraft} />{children}</div>
  </section>;
}

function InspectionRulesPage({ onNotice, embedded = false, registerDraft }: { onNotice: (message: string) => void; embedded?: boolean; registerDraft?: (draft: InspectionRules) => void }) {
  const [form, setForm] = useState<InspectionRules>(freshDefaultInspectionRules);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void request<InspectionRules>('/api/inspection-rules')
      .then((rules) => setForm(rules))
      .catch((reason) => setError(reason instanceof Error ? reason.message : '无法读取检查规则。'))
      .finally(() => setLoading(false));
  }, []);
  const updateRelease = <K extends keyof InspectionRules['releaseDate']>(key: K, value: InspectionRules['releaseDate'][K]) => setForm((old) => ({ ...old, releaseDate: { ...old.releaseDate, [key]: value } }));
  const updateMagnet = <K extends keyof InspectionRules['magnet']>(key: K, value: InspectionRules['magnet'][K]) => setForm((old) => ({ ...old, magnet: { ...old.magnet, [key]: value } }));
  const save = async (rules = form, success = 'MissAV 补全规则已保存。', notify = true): Promise<boolean> => {
    setBusy(true); setError('');
    try {
      const saved = await request<InspectionRules>('/api/inspection-rules', { method: 'PUT', body: JSON.stringify(rules) });
      setForm(saved); if (notify) onNotice(success); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存检查规则。'); return false; }
    finally { setBusy(false); }
  };
  useEffect(() => { if (registerDraft) registerDraft(form); }, [form, registerDraft]);
  return <section id={embedded ? undefined : 'rules'} className={`inspection-rules-page ${embedded ? 'embedded' : ''}`}>
    {embedded ? <div className="embedded-rule-toolbar"><div><span className="rule-kind">流程第 2、3 步</span><h3>归档补全</h3><p>同一条 MissAV 检查流程中，先从详情页补全发行日期，再按番号检索磁力链接。</p></div><div className="inspection-rule-actions"><button type="button" className="secondary" disabled={loading || busy} onClick={() => void save(freshDefaultInspectionRules(), '已恢复并保存 MissAV 默认规则。')}>恢复默认值</button><button type="button" className="primary" disabled={loading || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存补全规则'}</button></div></div> : <div className="section-head"><div><h2>MissAV 检查规则</h2><p>网页内容、发行日期与磁力检索均按这里显示的条件执行。</p></div><div className="inspection-rule-actions"><button type="button" className="secondary" disabled={loading || busy} onClick={() => void save(freshDefaultInspectionRules(), '已恢复并保存 MissAV 默认规则。')}>恢复默认值</button><button type="button" className="primary" disabled={loading || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存规则'}</button></div></div>}
    {error && <p className="form-error">{error}</p>}
    {loading ? <div className="empty">正在读取检查规则…</div> : <div className="inspection-rule-list">
      <section className={`inspection-rule-card ${form.releaseDate.enabled ? '' : 'disabled'}`}>
        <header><div><span className="rule-kind">归档补全</span><h3>发行日期</h3><p>每条内容入档后，从详情页中定位带指定标签的日期字段。</p></div><label className="toggle"><input type="checkbox" checked={form.releaseDate.enabled} disabled={busy} onChange={(event) => updateRelease('enabled', event.target.checked)} /><span />启用</label></header>
        <RuleFlow><code>详情页地址</code><i>→</i><code>{form.releaseDate.containerSelector || '容器'}</code><i>→</i><code>{form.releaseDate.labelText || '字段标签'}</code><i>→</i><code>{form.releaseDate.valueSelector || '值'}</code><i>→</i><strong>发行日期</strong></RuleFlow>
        <div className="rule-grid"><label>详情页地址模板<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.urlTemplate} onChange={(event) => updateRelease('urlTemplate', event.target.value)} /><span className="field-note">可用：<code>{'{{detailUrl}}'}</code>、<code>{'{{baseUrl}}'}</code>、<code>{'{{content}}'}</code></span></label><label>读取方式<select disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.renderMode} onChange={(event) => updateRelease('renderMode', event.target.value as 'static' | 'dynamic')}><option value="dynamic">浏览器渲染</option><option value="static">HTML 抓取</option></select></label><label>字段容器 CSS Selector<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.containerSelector} onChange={(event) => updateRelease('containerSelector', event.target.value)} /></label><label>字段标签 CSS Selector<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.labelSelector} onChange={(event) => updateRelease('labelSelector', event.target.value)} /></label><label>只匹配这个字段标签<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.labelText} onChange={(event) => updateRelease('labelText', event.target.value)} placeholder="例如：发行日期" /></label><label>日期值 CSS Selector<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.valueSelector} onChange={(event) => updateRelease('valueSelector', event.target.value)} /></label><label>日期值来源<select disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.valueSource} onChange={(event) => updateRelease('valueSource', event.target.value as ValueSource)}><option value="attribute">指定属性</option><option value="text">标签文字</option></select></label>{form.releaseDate.valueSource === 'attribute' ? <label>日期属性名<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.valueAttribute} onChange={(event) => updateRelease('valueAttribute', event.target.value)} /></label> : <div className="rule-hint">将直接读取日期标签中的文字。</div>}<label>请求间隔（毫秒）<input type="number" min="250" max="60000" disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.requestIntervalMs} onChange={(event) => updateRelease('requestIntervalMs', Number(event.target.value))} /></label><label className="rule-wide">日期匹配规则<input disabled={busy || !form.releaseDate.enabled} value={form.releaseDate.valueMatchPattern} onChange={(event) => updateRelease('valueMatchPattern', event.target.value)} /><span className="field-note">优先保存正则第一个括号；最终必须是有效的 YYYY-MM-DD 日期。</span></label></div>
      </section>
      <section className={`inspection-rule-card ${form.magnet.enabled ? '' : 'disabled'}`}>
        <header><div><span className="rule-kind">归档补全</span><h3>磁力链接</h3><p>按归档内容搜索，筛选文件名前缀，再从详情页读取链接值。</p></div><label className="toggle"><input type="checkbox" checked={form.magnet.enabled} disabled={busy} onChange={(event) => updateMagnet('enabled', event.target.checked)} /><span />启用</label></header>
        <RuleFlow><code>检索节点</code><i>→</i><code>搜索页</code><i>→</i><code>{form.magnet.itemSelector || '结果项'}</code><i>→</i><code>{form.magnet.filenamePrefix || '前缀'}</code><i>→</i><code>详情页</code><i>→</i><strong>磁力链接</strong></RuleFlow>
        <div className="rule-grid"><label className="rule-wide">检索节点（每行一个）<textarea disabled={busy || !form.magnet.enabled} rows={3} value={form.magnet.origins.join('\n')} onChange={(event) => updateMagnet('origins', event.target.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))} /><span className="field-note">按延时排序使用；当前节点失败时会尝试下一个。</span></label><label className="rule-wide">搜索地址模板<input disabled={busy || !form.magnet.enabled} value={form.magnet.searchUrlTemplate} onChange={(event) => updateMagnet('searchUrlTemplate', event.target.value)} /><span className="field-note">必须包含 <code>{'{{origin}}'}</code> 与 <code>{'{{content}}'}</code>。</span></label><label>结果项 CSS Selector<input disabled={busy || !form.magnet.enabled} value={form.magnet.itemSelector} onChange={(event) => updateMagnet('itemSelector', event.target.value)} /></label><label>文件名 CSS Selector<input disabled={busy || !form.magnet.enabled} value={form.magnet.filenameSelector} onChange={(event) => updateMagnet('filenameSelector', event.target.value)} /></label><label>首选文件名前缀<input disabled={busy || !form.magnet.enabled} value={form.magnet.filenamePrefix} onChange={(event) => updateMagnet('filenamePrefix', event.target.value)} /><span className="field-note">仅匹配文件名开头；整页存在此项时优先使用。</span></label><label>后备文件名标记（每行一个）<textarea disabled={busy || !form.magnet.enabled} rows={2} value={form.magnet.fallbackFilenamePrefixes.join('\n')} onChange={(event) => updateMagnet('fallbackFilenamePrefixes', event.target.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))} /><span className="field-note">只在没有首选结果时依次匹配；可出现在番号后的路径中。</span></label><label>详情链接 CSS Selector<input disabled={busy || !form.magnet.enabled} value={form.magnet.detailLinkSelector} onChange={(event) => updateMagnet('detailLinkSelector', event.target.value)} /></label><label>详情路径前缀<input disabled={busy || !form.magnet.enabled} value={form.magnet.detailPathPrefix} onChange={(event) => updateMagnet('detailPathPrefix', event.target.value)} /></label><label>链接值 CSS Selector<input disabled={busy || !form.magnet.enabled} value={form.magnet.valueSelector} onChange={(event) => updateMagnet('valueSelector', event.target.value)} /></label><label>链接值来源<select disabled={busy || !form.magnet.enabled} value={form.magnet.valueSource} onChange={(event) => updateMagnet('valueSource', event.target.value as ValueSource)}><option value="attribute">指定属性</option><option value="text">标签文字</option></select></label>{form.magnet.valueSource === 'attribute' ? <label>链接属性名<input disabled={busy || !form.magnet.enabled} value={form.magnet.valueAttribute} onChange={(event) => updateMagnet('valueAttribute', event.target.value)} /></label> : <div className="rule-hint">将直接读取链接标签中的文字。</div>}<label>请求间隔（毫秒）<input type="number" min="250" max="60000" disabled={busy || !form.magnet.enabled} value={form.magnet.requestIntervalMs} onChange={(event) => updateMagnet('requestIntervalMs', Number(event.target.value))} /></label><label className="rule-wide">链接匹配规则<input disabled={busy || !form.magnet.enabled} value={form.magnet.valueMatchPattern} onChange={(event) => updateMagnet('valueMatchPattern', event.target.value)} /><span className="field-note">只有匹配的值才会保存，内容档案仍只显示“复制”按钮。</span></label></div>
      </section>
    </div>}
  </section>;
}

type QbittorrentSettings = {
  enabled: boolean;
  url: string;
  authMode: 'api_key' | 'password';
  apiKeyConfigured: boolean;
  username: string;
  passwordConfigured: boolean;
  category: string;
  savePath: string;
  tags: string;
  autoDownload: boolean;
  autoDownloadMinSizeMb: number;
  stopAfterDownload: boolean;
};

type QbittorrentForm = Omit<QbittorrentSettings, 'apiKeyConfigured' | 'passwordConfigured'> & { apiKey: string; password: string };

const blankQbittorrentForm: QbittorrentForm = {
  enabled: false, url: '', authMode: 'api_key', apiKey: '', username: '', password: '', category: '', savePath: '', tags: 'page-watch', autoDownload: false, autoDownloadMinSizeMb: 0, stopAfterDownload: false
};

function QbittorrentSettingsPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [form, setForm] = useState<QbittorrentForm>(blankQbittorrentForm);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof QbittorrentForm>(key: K, value: QbittorrentForm[K]) => setForm((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    void request<QbittorrentSettings>('/api/settings/qbittorrent').then((settings) => {
      setForm({ enabled: settings.enabled, url: settings.url, authMode: settings.authMode, apiKey: '', username: settings.username, password: '', category: settings.category, savePath: settings.savePath, tags: settings.tags, autoDownload: settings.autoDownload, autoDownloadMinSizeMb: settings.autoDownloadMinSizeMb, stopAfterDownload: settings.stopAfterDownload });
      setApiKeyConfigured(settings.apiKeyConfigured);
      setPasswordConfigured(settings.passwordConfigured);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '无法读取下载设置。')).finally(() => setLoading(false));
  }, []);
  const payload = () => {
    const { apiKey, password, ...settings } = form;
    return { ...settings, ...(apiKey ? { apiKey } : {}), ...(password ? { password } : {}) };
  };
  async function save(showNotice = true) {
    const settings = await request<QbittorrentSettings>('/api/settings/qbittorrent', { method: 'PUT', body: JSON.stringify(payload()) });
    setForm((old) => ({ ...old, apiKey: '', password: '' }));
    setApiKeyConfigured(settings.apiKeyConfigured);
    setPasswordConfigured(settings.passwordConfigured);
    if (showNotice) onNotice(settings.enabled ? 'qBittorrent 下载设置已保存。' : 'qBittorrent 下载已关闭。');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await save(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存下载设置。'); }
    finally { setBusy(false); }
  }
  async function testConnection() {
    setBusy(true); setError('');
    try { await save(false); await request('/api/settings/qbittorrent/test', { method: 'POST' }); onNotice('qBittorrent 连接测试成功。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'qBittorrent 连接测试失败。'); }
    finally { setBusy(false); }
  }
  return <><section id="downloads" className="qbit-settings-page">
    <div className="section-head"><div><h2>qBittorrent 下载</h2><p>磁力链接仅在后台提交给 qBittorrent，页面不会显示链接文本。</p></div></div>
    <form className="qbit-settings" onSubmit={submit}>
      <section className="qbit-card"><div className="qbit-card-head"><div><h3>连接设置</h3><p>填写 qBittorrent 的 Web UI 地址，而不是下载端口。</p></div><label className="toggle"><input type="checkbox" checked={form.enabled} disabled={loading || busy} onChange={(event) => update('enabled', event.target.checked)} /><span />启用下载</label></div>
      <label>Web UI 地址<input disabled={loading || busy} value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="例如 http://192.168.1.20:8080" /><span className="field-note">若 qBittorrent 在 NAS 上，请填写 NAS 可访问的局域网地址和 Web UI 端口。</span></label>
      <label>认证方式<select disabled={loading || busy} value={form.authMode} onChange={(event) => update('authMode', event.target.value as QbittorrentForm['authMode'])}><option value="api_key">API 密钥（推荐，qBittorrent 5.2+）</option><option value="password">用户名与密码（旧版兼容）</option></select></label>
      {form.authMode === 'api_key' ? <label>API 密钥<input type="password" autoComplete="off" disabled={loading || busy} value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder={apiKeyConfigured ? '已保存；留空则不修改' : '以 qbt_ 开头的 API 密钥'} /><span className="field-note">在 qBittorrent 的“设置 → Web UI → API Key”生成。密钥仅保存于服务端，不会再返回或显示。</span></label> : <div className="two-col"><label>用户名<input autoComplete="username" disabled={loading || busy} value={form.username} onChange={(event) => update('username', event.target.value)} placeholder="qBittorrent 用户名" /></label><label>密码<input type="password" autoComplete="current-password" disabled={loading || busy} value={form.password} onChange={(event) => update('password', event.target.value)} placeholder={passwordConfigured ? '已保存；留空则不修改' : 'qBittorrent 密码'} /><span className="field-note">密码仅保存于服务端，不会再返回或显示。</span></label></div>}</section>
      <section className="qbit-card"><div className="qbit-card-head"><div><h3>下载规则</h3><p>这些选项会在 qBittorrent 接收任务时一并带上。</p></div></div><div className="two-col"><label>分类<input disabled={loading || busy} value={form.category} onChange={(event) => update('category', event.target.value)} placeholder="可选，例如 movies" /></label><label>标签<input disabled={loading || busy} value={form.tags} onChange={(event) => update('tags', event.target.value)} placeholder="可选，多个标签用逗号分隔" /></label></div><label>保存路径<input disabled={loading || busy} value={form.savePath} onChange={(event) => update('savePath', event.target.value)} placeholder="可选，使用 qBittorrent 容器内可见的路径" /><span className="field-note">Docker 中的路径必须是 qBittorrent 容器已经挂载的目录，例如 <code>/downloads</code>。</span></label><label className="toggle qbit-auto-toggle"><input type="checkbox" checked={form.autoDownload} disabled={loading || busy || !form.enabled} onChange={(event) => update('autoDownload', event.target.checked)} /><span />新找到磁力链接后自动提交下载</label><label>最小单文件大小（MB）<input type="number" min="0" max="1048576" step="1" disabled={loading || busy || !form.enabled} value={form.autoDownloadMinSizeMb} onChange={(event) => update('autoDownloadMinSizeMb', Number(event.target.value))} /><span className="field-note">设为 0 不筛选。大于 0 时，Page Watch 提交给 qBittorrent 的任务会先读取种子文件列表，将小于该大小的广告、图片等文件设为“不下载”，仅下载达到该大小的文件。</span></label><label className="toggle qbit-auto-toggle"><input type="checkbox" checked={form.stopAfterDownload} disabled={loading || busy || !form.enabled} onChange={(event) => update('stopAfterDownload', event.target.checked)} /><span />下载完成后停止做种<span className="field-note">仅停止由本网站提交且已完成的任务。</span></label></section>
      {error && <p className="form-error">{error}</p>}
      <div className="qbit-form-actions"><button type="button" className="secondary" disabled={loading || busy} onClick={() => void testConnection()}>{busy ? '处理中…' : '保存并测试连接'}</button><button className="primary" disabled={loading || busy} type="submit">{busy ? '保存中…' : '保存下载设置'}</button></div>
    </form>
  </section><JellyfinSettingsPanel onNotice={onNotice} /></>;
}

type JellyfinSettings = {
  enabled: boolean;
  url: string;
  apiKeyConfigured: boolean;
  libraryIds: string[];
  syncIntervalMinutes: number;
  skipMagnetWhenAvailable: boolean;
  lastSyncedAt: string | null;
};

type JellyfinLibrary = { id: string; name: string; collectionType: string | null };
type JellyfinForm = Omit<JellyfinSettings, 'apiKeyConfigured' | 'lastSyncedAt'> & { apiKey: string };

const blankJellyfinForm: JellyfinForm = { enabled: false, url: '', apiKey: '', libraryIds: [], syncIntervalMinutes: 60, skipMagnetWhenAvailable: true };

function JellyfinSettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [form, setForm] = useState<JellyfinForm>(blankJellyfinForm);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof JellyfinForm>(key: K, value: JellyfinForm[K]) => setForm((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    void request<JellyfinSettings>('/api/settings/jellyfin').then((settings) => {
      setForm({ enabled: settings.enabled, url: settings.url, apiKey: '', libraryIds: settings.libraryIds, syncIntervalMinutes: settings.syncIntervalMinutes, skipMagnetWhenAvailable: settings.skipMagnetWhenAvailable });
      setApiKeyConfigured(settings.apiKeyConfigured);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '无法读取 Jellyfin 设置。')).finally(() => setLoading(false));
  }, []);
  const payload = () => {
    const { apiKey, ...settings } = form;
    return { ...settings, ...(apiKey ? { apiKey } : {}) };
  };
  const save = async (showNotice = true) => {
    const settings = await request<JellyfinSettings>('/api/settings/jellyfin', { method: 'PUT', body: JSON.stringify(payload()) });
    setForm((old) => ({ ...old, enabled: settings.enabled, url: settings.url, apiKey: '', libraryIds: settings.libraryIds, syncIntervalMinutes: settings.syncIntervalMinutes, skipMagnetWhenAvailable: settings.skipMagnetWhenAvailable }));
    setApiKeyConfigured(settings.apiKeyConfigured);
    if (showNotice) onNotice(settings.enabled ? 'Jellyfin 影视库设置已保存，等待同步。' : 'Jellyfin 影视库同步已关闭。');
  };
  const toggleLibrary = (id: string) => setForm((old) => ({ ...old, libraryIds: old.libraryIds.includes(id) ? old.libraryIds.filter((item) => item !== id) : [...old.libraryIds, id] }));
  async function testConnection() {
    setBusy(true); setError('');
    try {
      await save(false);
      const result = await request<{ server: { serverName: string; version: string | null }; libraries: JellyfinLibrary[] }>('/api/settings/jellyfin/test', { method: 'POST' });
      setLibraries(result.libraries);
      setForm((old) => old.libraryIds.length ? old : { ...old, libraryIds: result.libraries.map((library) => library.id) });
      onNotice(`Jellyfin 连接成功：${result.server.serverName}${result.server.version ? ` ${result.server.version}` : ''}。请选择媒体库后保存。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Jellyfin 连接测试失败。'); }
    finally { setBusy(false); }
  }
  async function syncNow() {
    setBusy(true); setError('');
    try {
      await save(false);
      const result = await request<{ queued: boolean; jobId: number }>('/api/settings/jellyfin/sync', { method: 'POST' });
      onNotice(result.queued ? `Jellyfin 全量同步已加入队列（任务 #${result.jobId}），可在运行中心查看进度。` : `Jellyfin 全量同步已在执行或排队中（任务 #${result.jobId}）。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Jellyfin 影视库同步失败。'); }
    finally { setBusy(false); }
  }
  return <section className="qbit-settings-page jellyfin-settings-page"><div className="section-head"><div><h2>Jellyfin 影视库</h2><p>同步指定媒体库后，内容档案会显示“已入库”或“未入库”。</p></div></div><form className="qbit-settings" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(''); void save().catch((reason) => setError(reason instanceof Error ? reason.message : '无法保存 Jellyfin 设置。')).finally(() => setBusy(false)); }}>
    <section className="qbit-card"><div className="qbit-card-head"><div><h3>连接与同步</h3><p>仅以只读方式查询 Jellyfin 媒体库，不会修改影片或元数据。</p></div><label className="toggle"><input type="checkbox" checked={form.enabled} disabled={loading || busy} onChange={(event) => update('enabled', event.target.checked)} /><span />启用影视库同步</label></div>
      <label>Jellyfin Web 地址<input disabled={loading || busy} value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="例如 http://192.168.1.20:8096" /><span className="field-note">填写 Jellyfin Web UI 的局域网地址和端口。</span></label>
      <label>API 密钥<input type="password" autoComplete="off" disabled={loading || busy} value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder={apiKeyConfigured ? '已保存；留空则不修改' : '在 Jellyfin 管理后台创建的 API 密钥'} /><span className="field-note">密钥仅保存于服务端，不会再返回或显示。</span></label>
      <label>同步间隔（分钟）<input type="number" min="5" max="1440" disabled={loading || busy || !form.enabled} value={form.syncIntervalMinutes} onChange={(event) => update('syncIntervalMinutes', Number(event.target.value))} /></label>
      <label className="toggle jellyfin-skip-toggle"><input type="checkbox" checked={form.skipMagnetWhenAvailable} disabled={loading || busy || !form.enabled} onChange={(event) => update('skipMagnetWhenAvailable', event.target.checked)} /><span />已入库时自动跳过磁力检索</label>
      {libraries.length > 0 && <fieldset className="jellyfin-libraries" disabled={loading || busy || !form.enabled}><legend>同步的媒体库</legend><div>{libraries.map((library) => <label key={library.id} className="library-choice"><input type="checkbox" checked={form.libraryIds.includes(library.id)} onChange={() => toggleLibrary(library.id)} /><span><b>{library.name}</b>{library.collectionType ? <small>{library.collectionType}</small> : null}</span></label>)}</div><span className="field-note">可多选；同步只读取所选媒体库中的影片项目。</span></fieldset>}
      {libraries.length === 0 && <p className="field-note jellyfin-library-hint">先保存并测试连接，即可读取并选择 Jellyfin 媒体库。</p>}
    </section>
    {error && <p className="form-error">{error}</p>}
    <div className="qbit-form-actions"><button type="button" className="secondary" disabled={loading || busy} onClick={() => void testConnection()}>{busy ? '处理中…' : '保存并检测媒体库'}</button><button type="button" className="secondary" disabled={loading || busy || !form.enabled || !form.libraryIds.length} onClick={() => void syncNow()}>{busy ? '正在同步…' : '立即同步影视库'}</button><button className="primary" disabled={loading || busy} type="submit">{busy ? '保存中…' : '保存影视库设置'}</button></div>
  </form></section>;
}

function Editor({ item, onClose, onSaved, onFullScan, onArchiveCleared }: { item: Subscription | null; onClose: () => void; onSaved: () => Promise<void>; onFullScan: () => Promise<void>; onArchiveCleared: () => Promise<void> }) {
  const [form, setForm] = useState<FormData>(item ? subscriptionToForm(item) : blankForm);
  const [presetId, setPresetId] = useState('');
  const [presets, setPresets] = useState<SubscriptionPreset[]>([]);
  const [preview, setPreview] = useState<{ title: string; content: string; items?: Array<{ content: string; title: string | null }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof FormData>(key: K, value: FormData[K]) => setForm((old) => ({ ...old, [key]: value }));
  const selectedPreset = presets.find((preset) => String(preset.id) === presetId);
  const loadPresets = async () => setPresets(await request<SubscriptionPreset[]>('/api/subscription-presets'));
  useEffect(() => { if (!item) void loadPresets().catch((reason) => setError(reason instanceof Error ? reason.message : '无法读取检查规则。')); }, [item]);
  function applyPreset(id: string) {
    setPresetId(id);
    const preset = presets.find((candidate) => String(candidate.id) === id);
    if (!preset) return;
    setForm((old) => ({ ...old, selector: preset.selector, renderMode: preset.render_mode, contentSource: preset.content_source, attributeName: preset.attribute_name ?? '', matchPattern: preset.match_pattern ?? '', titleSelector: preset.title_selector ?? '', titleContentSource: preset.title_content_source ?? 'text', titleAttributeName: preset.title_attribute_name ?? '', titleMatchPattern: preset.title_match_pattern ?? '', resultMode: preset.result_mode, paginationSelector: preset.pagination_selector ?? '', paginationParameter: preset.pagination_parameter ?? 'page', paginationMatchPattern: preset.pagination_match_pattern ?? '' }));
  }
  async function previewCapture() {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await request('/api/subscriptions/preview', { method: 'POST', body: JSON.stringify(form) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '预览失败。'); }
    finally { setBusy(false); }
  }
  async function fullScan() {
    if (!item) return;
    setBusy(true); setError('');
    try { await request(`/api/subscriptions/${item.id}/full-scan`, { method: 'POST' }); await onFullScan(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法开始全量检查。'); }
    finally { setBusy(false); }
  }
  async function clearArchive() {
    if (!item || !window.confirm(`重置“${item.name}”的检查数据？内容档案和当前对比基准都会删除，此操作不可恢复。`)) return;
    setBusy(true); setError('');
    try { await request(`/api/subscriptions/${item.id}/archive`, { method: 'DELETE' }); await onArchiveCleared(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法重置订阅数据。'); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await request(item ? `/api/subscriptions/${item.id}` : '/api/subscriptions', { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) });
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  return <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="editor-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="editor subscription-editor" onSubmit={submit}>
    <header><div><p className="eyebrow">网页订阅</p><h2 id="editor-title">{item ? '编辑订阅' : '新建订阅'}</h2></div><button type="button" className="close" onClick={onClose}>×</button></header>
    <div className="editor-body">
    {!item && <section className="subscription-rule-picker"><label>检查规则<select value={presetId} onChange={(event) => applyPreset(event.target.value)}><option value="">请选择检查规则</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>{selectedPreset && <p>{selectedPreset.description || '已填入内容、标题与分页读取条件。'}{form.paginationSelector ? ' 首次计划检查会自动读取全部分页；保存后也可手动全量检查。' : ''}</p>}</section>}
    <label>订阅名称<input autoFocus value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="例如：商品价格" /></label>
    <label>网页地址<input type="url" value={form.url} onChange={(e) => update('url', e.target.value)} placeholder="https://example.com/page" /></label>
    <ScheduleControls form={form} update={update} />
    {!item && <p className="editor-note">检查规则会在保存时一并写入订阅；规则内容可在订阅中心的“检查规则库”中维护。</p>}
    {error && <p className="form-error">{error}</p>}
    {preview && <div className="preview"><span>已提取 · {preview.title}</span>{preview.items?.length ? <div className="title-preview">{preview.items.slice(0, 8).map((entry, index) => <div key={`${entry.content}-${index}`}><code>{entry.content}</code><p>{entry.title || '未读取标题'}</p></div>)}</div> : <p>{preview.content}</p>}</div>}
    </div>
    <footer><div className="editor-footer-actions">{item?.pagination_selector && <button type="button" className="secondary" disabled={busy} onClick={() => void fullScan()}>{busy ? '处理中…' : '全量检查'}</button>}<button type="button" className="secondary" disabled={busy || (!item && !form.selector)} onClick={() => void previewCapture()}>{busy ? '处理中…' : '预览抽取'}</button>{item && <button type="button" className="secondary danger-button" disabled={busy} onClick={() => void clearArchive()}>重置订阅数据</button>}</div><button className="primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存订阅'}</button></footer>
  </form></div>;
}

function presetToForm(preset: SubscriptionPreset): PresetForm {
  return { name: preset.name, description: preset.description, selector: preset.selector, renderMode: preset.render_mode, contentSource: preset.content_source, attributeName: preset.attribute_name ?? '', matchPattern: preset.match_pattern ?? '', titleSelector: preset.title_selector ?? '', titleContentSource: preset.title_content_source ?? 'text', titleAttributeName: preset.title_attribute_name ?? '', titleMatchPattern: preset.title_match_pattern ?? '', resultMode: preset.result_mode, intervalMinutes: preset.interval_minutes, scheduleType: 'hourly', scheduleIntervalHours: Math.max(1, Math.round(preset.interval_minutes / 60)), scheduleTime: '09:00', scheduleWeekday: 1, isActive: Boolean(preset.is_active), paginationSelector: preset.pagination_selector ?? '', paginationParameter: preset.pagination_parameter ?? 'page', paginationMatchPattern: preset.pagination_match_pattern ?? '' };
}

function PresetManager({ presets, onClose, onChanged, embedded = false, registerDraft }: { presets: SubscriptionPreset[]; onClose: () => void; onChanged: () => Promise<void>; embedded?: boolean; registerDraft?: (draft: MissavPresetDraft) => void }) {
  const [editing, setEditing] = useState<SubscriptionPreset | 'new' | null>(null);
  const [form, setForm] = useState<PresetForm>(blankPresetForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof PresetForm>(key: K, value: PresetForm[K]) => setForm((old) => ({ ...old, [key]: value }));
  const startEdit = (preset: SubscriptionPreset | 'new') => { setEditing(preset); setForm(preset === 'new' ? { ...(embedded ? defaultMissavPresetForm : blankPresetForm) } : presetToForm(preset)); setError(''); };
  useEffect(() => {
    if (embedded && !editing) startEdit(presets[0] ?? 'new');
  }, [embedded, editing, presets]);
  const save = async (): Promise<boolean> => {
    if (!editing) return false;
    setBusy(true); setError('');
    try {
      await request(editing === 'new' ? '/api/subscription-presets' : `/api/subscription-presets/${editing.id}`, { method: editing === 'new' ? 'POST' : 'PUT', body: JSON.stringify(form) });
      await onChanged(); if (!embedded) setEditing(null); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存规则。'); return false; }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (registerDraft && editing) registerDraft({ presetId: editing === 'new' ? null : editing.id, preset: form });
  }, [editing, form, registerDraft]);
  const remove = async (preset: SubscriptionPreset) => {
    if (!window.confirm(`删除规则“${preset.name}”？`)) return;
    setBusy(true); setError('');
    try { await request(`/api/subscription-presets/${preset.id}`, { method: 'DELETE' }); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法删除规则。'); }
    finally { setBusy(false); }
  };
  if (editing) return <section className={`preset-manager ${embedded ? 'embedded' : ''}`} aria-label="编辑 MissAV 列表读取规则">
    <div className="preset-manager-head"><div><strong>{editing === 'new' ? '新建列表读取规则' : '列表读取规则'}</strong><small>保存后可在新建 MissAV 订阅时直接选择。</small></div>{!embedded && <button type="button" className="close" onClick={() => setEditing(null)}>×</button>}</div>
    <label>规则名称<input autoFocus value={form.name} maxLength={80} onChange={(event) => update('name', event.target.value)} /></label>
    <label>规则说明<input value={form.description} maxLength={200} onChange={(event) => update('description', event.target.value)} placeholder="可选，说明适用的网页和内容" /></label>
    <label>CSS Selector<input value={form.selector} onChange={(event) => update('selector', event.target.value)} placeholder="例如 a.text-secondary[alt]" /></label>
    <div className="two-col"><label>提取内容<select value={form.contentSource} onChange={(event) => update('contentSource', event.target.value as PresetForm['contentSource'])}><option value="text">标签中的文字</option><option value="attribute">指定属性的值</option></select></label>{form.contentSource === 'attribute' ? <label>属性名<input value={form.attributeName} onChange={(event) => update('attributeName', event.target.value)} placeholder="例如 alt" /></label> : <div className="attribute-hint">读取所选标签中的可见文字</div>}</div>
    <div className="two-col"><label>匹配范围<select value={form.resultMode} onChange={(event) => update('resultMode', event.target.value as PresetForm['resultMode'])}><option value="first">仅第一项</option><option value="all">全部匹配项</option></select></label><label>内容匹配规则<input value={form.matchPattern} onChange={(event) => update('matchPattern', event.target.value)} placeholder="可选的正则表达式" /></label></div>
    <section className="preset-title-settings"><label className="toggle"><input type="checkbox" checked={Boolean(form.titleSelector)} onChange={(event) => setForm((old) => event.target.checked ? { ...old, titleSelector: old.selector, titleContentSource: 'text', titleAttributeName: '', titleMatchPattern: old.titleMatchPattern } : { ...old, titleSelector: '', titleAttributeName: '', titleMatchPattern: '' })} /><span />同时读取标题</label>{form.titleSelector && <><label>标题 CSS Selector<input value={form.titleSelector} onChange={(event) => update('titleSelector', event.target.value)} /></label><div className="two-col"><label>标题来源<select value={form.titleContentSource} onChange={(event) => update('titleContentSource', event.target.value as PresetForm['titleContentSource'])}><option value="text">标签中的文字</option><option value="attribute">指定属性的值</option></select></label>{form.titleContentSource === 'attribute' ? <label>标题属性名<input value={form.titleAttributeName} onChange={(event) => update('titleAttributeName', event.target.value)} placeholder="例如 alt" /></label> : <div className="attribute-hint">按条目顺序与内容配对</div>}</div><label>标题匹配规则<input value={form.titleMatchPattern} onChange={(event) => update('titleMatchPattern', event.target.value)} placeholder="可选的正则表达式" /></label></>}</section>
    <section className="preset-title-settings"><label className="toggle"><input type="checkbox" checked={Boolean(form.paginationSelector)} onChange={(event) => setForm((old) => event.target.checked ? { ...old, paginationSelector: old.paginationSelector || '#page-count', paginationParameter: old.paginationParameter || 'page', paginationMatchPattern: old.paginationMatchPattern || '(\\d+)' } : { ...old, paginationSelector: '', paginationMatchPattern: '' })} /><span />包含分页读取</label>{form.paginationSelector && <><label>页数 CSS Selector<input value={form.paginationSelector} onChange={(event) => update('paginationSelector', event.target.value)} /></label><div className="two-col"><label>页码参数名<input value={form.paginationParameter} onChange={(event) => update('paginationParameter', event.target.value)} /></label><label>页数匹配规则<input value={form.paginationMatchPattern} onChange={(event) => update('paginationMatchPattern', event.target.value)} placeholder={'例如 /\\s*(\\d+)'} /></label></div></>}</section>
    <div className="two-col"><label>读取方式<select value={form.renderMode} onChange={(event) => update('renderMode', event.target.value as PresetForm['renderMode'])}><option value="static">HTML 抓取</option><option value="dynamic">浏览器渲染</option></select></label><label>检查间隔（分钟）<input type="number" min="1" max="10080" value={form.intervalMinutes} onChange={(event) => update('intervalMinutes', Number(event.target.value))} /></label></div>
    <label className="toggle"><input type="checkbox" checked={form.isActive} onChange={(event) => update('isActive', event.target.checked)} /><span />默认启用定时检查</label>{error && <p className="form-error">{error}</p>}<div className="preset-manager-actions">{!embedded && <button type="button" className="secondary" onClick={() => setEditing(null)}>返回列表</button>}<button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存列表规则'}</button></div>
  </section>;
  return <section className={`preset-manager ${embedded ? 'embedded' : ''}`} aria-label="管理 MissAV 列表读取规则">{!embedded && <div className="preset-manager-head"><div><strong>列表读取规则</strong><small>可自由新增、编辑或删除新建订阅可套用的列表读取规则。</small></div><button type="button" className="close" onClick={onClose}>×</button></div>}{error && <p className="form-error">{error}</p>}<div className="preset-rule-list">{presets.map((preset) => <article key={preset.id}><div><strong>{preset.name}</strong><small>{preset.description || preset.selector}</small></div><code>{preset.selector}</code><div><button type="button" onClick={() => startEdit(preset)}>编辑</button><button type="button" className="danger" disabled={busy} onClick={() => void remove(preset)}>删除</button></div></article>)}</div><div className="preset-manager-actions">{!embedded && <button type="button" className="secondary" onClick={onClose}>完成</button>}<button type="button" className="primary" onClick={() => startEdit('new')}>＋ 新建规则</button></div></section>;
}

function NetworkSettings({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [proxyUrl, setProxyUrl] = useState('');
  const [fromEnvironment, setFromEnvironment] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeSettings>({ profile: 'safe', browserIdleMinutes: 10 });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.all([
      request<{ proxyUrl: string; fromEnvironment: boolean }>('/api/settings/network'),
      request<RuntimeSettings>('/api/settings/runtime')
    ])
      .then(([network, nextRuntime]) => { setProxyUrl(network.proxyUrl); setFromEnvironment(network.fromEnvironment); setRuntime(nextRuntime); })
      .catch((reason) => setError(reason.message))
      .finally(() => setBusy(false));
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const [network] = await Promise.all([
        fromEnvironment ? Promise.resolve<{ active: boolean } | null>(null) : request<{ active: boolean }>('/api/settings/network', { method: 'PUT', body: JSON.stringify({ proxyUrl }) }),
        request<RuntimeSettings>('/api/settings/runtime', { method: 'PUT', body: JSON.stringify(runtime) })
      ]);
      onSaved(network ? (network.active ? '网络代理与运行性能已保存。' : '运行性能已保存，网络代理已关闭。') : '运行性能已保存。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存设置。'); }
    finally { setBusy(false); }
  }
  return <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="network-title"><form className="editor network-settings" onSubmit={save}>
    <header><div><p className="eyebrow">网络连接与运行性能</p><h2 id="network-title">网络代理</h2></div><button type="button" className="close" onClick={onClose}>×</button></header>
    <p className="network-copy">配置后，普通网页抓取和浏览器渲染都会通过同一个代理连接。</p>
    {fromEnvironment ? <div className="environment-note">当前代理由 Docker 的 <code>OUTBOUND_PROXY</code> 环境变量提供。请在部署配置中修改。</div> : <label>HTTP / HTTPS 代理地址<input disabled={busy} value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="例如 http://192.168.1.10:7890" /><span className="field-note">留空并保存即可关闭代理。NAS 中请填写代理服务的局域网 IP，不要填写 127.0.0.1。</span></label>}
    <section className="runtime-settings-card"><div><strong>运行性能</strong><small>MissAV 始终优先浏览器渲染；不会自动切换为高并发 HTTP 抓取。</small></div><div className="two-col"><label>浏览器模式<select disabled={busy} value={runtime.profile} onChange={(event) => setRuntime((current) => ({ ...current, profile: event.target.value as RuntimeSettings['profile'] }))}><option value="safe">稳妥：单页并发</option><option value="performance">性能：最多两页并发</option></select><span className="field-note">性能模式会提高内存占用和站点访问风险。</span></label><label>空闲回收<select disabled={busy} value={runtime.browserIdleMinutes} onChange={(event) => setRuntime((current) => ({ ...current, browserIdleMinutes: Number(event.target.value) as RuntimeSettings['browserIdleMinutes'] }))}><option value={5}>5 分钟</option><option value={10}>10 分钟（默认）</option><option value={20}>20 分钟</option></select><span className="field-note">没有浏览器任务时，Chromium 会自动退出。</span></label></div></section>
    {error && <p className="form-error">{error}</p>}
    <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy} type="submit">{busy ? '读取中…' : '保存设置'}</button></footer>
  </form></div>;
}

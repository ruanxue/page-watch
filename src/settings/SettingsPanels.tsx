import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { request } from '../api.js';

/**
 * 设置页：qBittorrent / Jellyfin / 网络代理 / 运行性能 / 通知 五个面板。
 *
 * 五个面板共用同一套交互约定：每段独立保存、独立报错，保存按钮只在有未保存
 * 修改时可用，成功与失败都显示在区块内的状态条里。
 */

// ===== 通知设置的数据形状 =====
type NotificationChannel = 'wecom' | 'dingtalk' | 'webhook';
type NotificationEvents = { content_discovered: boolean; operation_failed: boolean; magnet_found: boolean; download_completed: boolean; full_scan_completed: boolean };
type NotificationSettings = {
  enabled: boolean;
  channel: NotificationChannel;
  events: NotificationEvents;
  wecomWebhookConfigured: boolean;
  dingtalkWebhookConfigured: boolean;
  dingtalkSecretConfigured: boolean;
  webhookUrlConfigured: boolean;
  webhookHmacSecretConfigured: boolean;
};
type NotificationForm = NotificationSettings & {
  wecomWebhook: string;
  dingtalkWebhook: string;
  dingtalkSecret: string;
  webhookUrl: string;
  webhookHmacSecret: string;
};

const blankNotificationForm: NotificationForm = {
  enabled: false,
  channel: 'wecom',
  events: { content_discovered: true, operation_failed: true, magnet_found: false, download_completed: false, full_scan_completed: true },
  wecomWebhookConfigured: false,
  dingtalkWebhookConfigured: false,
  dingtalkSecretConfigured: false,
  webhookUrlConfigured: false,
  webhookHmacSecretConfigured: false,
  wecomWebhook: '',
  dingtalkWebhook: '',
  dingtalkSecret: '',
  webhookUrl: '',
  webhookHmacSecret: ''
};


// ===== 运行性能的数据形状 =====
type RuntimeSettings = { profile: 'safe' | 'performance'; browserIdleMinutes: 5 | 10 | 20 };

// ===== 通用表单骨架 =====
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

type SettingsAction = 'save' | 'verify' | 'sync' | 'test';
type SettingsStatus = { tone: 'error' | 'success'; message: string } | null;

/**
 * 设置页统一的状态机：任意时刻只有一个动作在进行，按钮只反映自己那一个动作，
 * 成功与失败都落在页面内状态条里，不再出现「成功用浮动提示、失败用页面红字」的分裂。
 */
function useSettingsActions() {
  const [pending, setPending] = useState<SettingsAction | ''>('');
  const [status, setStatus] = useState<SettingsStatus>(null);
  const run = async (action: SettingsAction, work: () => Promise<string | void>, fallback: string) => {
    setPending(action);
    setStatus(null);
    try {
      const message = await work();
      if (message) setStatus({ tone: 'success', message });
      return true;
    } catch (reason) {
      const message = reason instanceof Error && reason.message.trim() ? reason.message.trim() : fallback;
      setStatus({ tone: 'error', message });
      return false;
    } finally {
      setPending('');
    }
  };
  return { pending, status, setStatus, run };
}

function SettingsSection({ id, eyebrow, title, description, children, actions, status, loading, dirty, onSubmit }: {
  id?: string;
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
  actions: ReactNode;
  status: SettingsStatus;
  loading: boolean;
  dirty?: boolean;
  onSubmit: (event: FormEvent) => void;
}) {
  return <section id={id} className="settings-section">
    <form className="settings-form" onSubmit={onSubmit} noValidate>
      <header className="settings-head">
        <div className="settings-head-copy">
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          {description && <p className="settings-desc">{description}</p>}
        </div>
        {dirty && <span className="settings-dirty">有未保存的修改</span>}
      </header>
      <div className="settings-body">
        {loading ? <p className="settings-loading" role="status">正在读取设置…</p> : children}
      </div>
      {status && <p className={`settings-status ${status.tone}`} role={status.tone === 'error' ? 'alert' : 'status'}>{status.message}</p>}
      <footer className="settings-actions">{actions}</footer>
    </form>
  </section>;
}

function SettingsField({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <label className={`settings-field${wide ? ' wide' : ''}`}>
    <span className="settings-field-label">{label}</span>
    {children}
    {hint && <span className="settings-field-hint">{hint}</span>}
  </label>;
}

function SettingsToggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`settings-switch${disabled ? ' disabled' : ''}`}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span className="settings-switch-track" aria-hidden="true" />
    <span className="settings-switch-copy">{label}{hint && <small>{hint}</small>}</span>
  </label>;
}

/** 统一的动作按钮：主按钮永远只有一个，次要动作用次按钮，危险操作用危险按钮。 */
function SettingsActionButton({ tone = 'secondary', busy, disabled, onClick, type = 'button', children }: {
  tone?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  children: ReactNode;
}) {
  const className = tone === 'primary' ? 'primary' : tone === 'danger' ? 'secondary danger-button' : 'secondary';
  return <button className={className} type={type} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>{children}</button>;
}

function QbittorrentSettingsPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [form, setForm] = useState<QbittorrentForm>(blankQbittorrentForm);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState<QbittorrentForm | null>(null);
  const { pending, status, setStatus, run } = useSettingsActions();
  void onNotice;
  const busy = pending !== '';
  const dirty = baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);
  const update = <K extends keyof QbittorrentForm>(key: K, value: QbittorrentForm[K]) => setForm((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    void request<QbittorrentSettings>('/api/settings/qbittorrent').then((settings) => {
      const next: QbittorrentForm = {
        enabled: settings.enabled, url: settings.url, authMode: settings.authMode, apiKey: '',
        username: settings.username, password: '', category: settings.category, savePath: settings.savePath,
        tags: settings.tags, autoDownload: settings.autoDownload,
        autoDownloadMinSizeMb: settings.autoDownloadMinSizeMb, stopAfterDownload: settings.stopAfterDownload
      };
      setForm(next);
      setBaseline(next);
      setApiKeyConfigured(settings.apiKeyConfigured);
      setPasswordConfigured(settings.passwordConfigured);
    }).catch((reason) => setStatus({ tone: 'error', message: reason instanceof Error ? reason.message : '无法读取下载设置。' })).finally(() => setLoading(false));
  }, [setStatus]);
  const payload = () => {
    const { apiKey, password, ...settings } = form;
    return { ...settings, ...(apiKey ? { apiKey } : {}), ...(password ? { password } : {}) };
  };
  async function putSettings() {
    const settings = await request<QbittorrentSettings>('/api/settings/qbittorrent', { method: 'PUT', body: JSON.stringify(payload()) });
    const next = { ...form, apiKey: '', password: '' };
    setForm(next);
    setBaseline(next);
    setApiKeyConfigured(settings.apiKeyConfigured);
    setPasswordConfigured(settings.passwordConfigured);
    return settings;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    void run('save', async () => {
      const settings = await putSettings();
      return settings.enabled ? '下载设置已保存。' : '下载设置已保存，qBittorrent 下载当前关闭。';
    }, '无法保存下载设置。');
  };
  const testConnection = () => {
    if (busy) return;
    void run('verify', async () => {
      await putSettings();
      await request('/api/settings/qbittorrent/test', { method: 'POST' });
      return '连接测试成功，设置已保存。';
    }, 'qBittorrent 连接测试失败。');
  };
  const discard = () => {
    if (!baseline) return;
    setForm(baseline);
    setStatus(null);
  };
  return <>
    <SettingsSection
      id="downloads"
      eyebrow="下载与做种"
      title="qBittorrent 下载"
      description="把已归档内容提交到 qBittorrent。保存后立即生效，已提交的任务不受影响。"
      loading={loading}
      dirty={dirty}
      status={status}
      onSubmit={submit}
      actions={<>
        {dirty && <SettingsActionButton disabled={busy} onClick={discard}>撤销更改</SettingsActionButton>}
        <SettingsActionButton busy={pending === 'verify'} disabled={busy && pending !== 'verify'} onClick={testConnection}>{pending === 'verify' ? '正在连接…' : '保存并测试连接'}</SettingsActionButton>
        <SettingsActionButton tone="primary" type="submit" busy={pending === 'save'} disabled={busy || !dirty}>{pending === 'save' ? '保存中…' : '保存下载设置'}</SettingsActionButton>
      </>}
    >
      <div className="settings-group">
        <SettingsToggle label="启用 qBittorrent 下载" hint="关闭后不再提交新的下载任务。" checked={form.enabled} disabled={busy} onChange={(value) => update('enabled', value)} />
      </div>
      <div className="settings-grid">
        <SettingsField wide label="Web UI 地址" hint="包含协议与端口，例如 http://192.168.1.20:8080。">
          <input disabled={busy} value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="http://192.168.1.20:8080" />
        </SettingsField>
        <SettingsField label="认证方式" hint="qBittorrent 5.2 及以上推荐 API 密钥。">
          <select disabled={busy} value={form.authMode} onChange={(event) => update('authMode', event.target.value as QbittorrentForm['authMode'])}>
            <option value="api_key">API 密钥（推荐）</option>
            <option value="password">用户名与密码（旧版兼容）</option>
          </select>
        </SettingsField>
        {form.authMode === 'api_key'
          ? <SettingsField wide label="API 密钥" hint={apiKeyConfigured ? '已保存密钥；留空表示不修改。' : '在 qBittorrent 的 Web UI 选项中生成。'}>
            <input type="password" autoComplete="off" disabled={busy} value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder={apiKeyConfigured ? '已保存，留空则不修改' : 'API 密钥'} />
          </SettingsField>
          : <>
            <SettingsField label="用户名">
              <input autoComplete="username" disabled={busy} value={form.username} onChange={(event) => update('username', event.target.value)} placeholder="qBittorrent 用户名" />
            </SettingsField>
            <SettingsField label="密码" hint={passwordConfigured ? '已保存密码；留空表示不修改。' : undefined}>
              <input type="password" autoComplete="current-password" disabled={busy} value={form.password} onChange={(event) => update('password', event.target.value)} placeholder={passwordConfigured ? '已保存，留空则不修改' : '密码'} />
            </SettingsField>
          </>}
        <SettingsField label="分类" hint="可选，例如 movies。">
          <input disabled={busy} value={form.category} onChange={(event) => update('category', event.target.value)} placeholder="可选" />
        </SettingsField>
        <SettingsField label="标签" hint="可选，多个标签用逗号分隔。">
          <input disabled={busy} value={form.tags} onChange={(event) => update('tags', event.target.value)} placeholder="可选" />
        </SettingsField>
        <SettingsField wide label="保存路径" hint="必须是 qBittorrent 容器内可见的路径，例如 /downloads。">
          <input disabled={busy} value={form.savePath} onChange={(event) => update('savePath', event.target.value)} placeholder="使用 qBittorrent 默认路径" />
        </SettingsField>
      </div>
      <div className="settings-group-title">下载规则</div>
      <div className="settings-group">
        <SettingsToggle label="新找到磁力链接后自动提交下载" hint="订阅首次检查（含首次全量检查）发现的内容只检索磁力，不自动提交。" checked={form.autoDownload} disabled={busy || !form.enabled} onChange={(value) => update('autoDownload', value)} />
        <SettingsField label="最小单文件大小（MB）" hint="小于该值的文件不会下载；0 表示不限制。">
          <input type="number" min="0" max="1048576" step="1" disabled={busy || !form.enabled} value={form.autoDownloadMinSizeMb} onChange={(event) => update('autoDownloadMinSizeMb', Number(event.target.value))} />
        </SettingsField>
        <SettingsToggle label="下载完成后停止做种" hint="仅停止本网站提交的任务，不影响 qBittorrent 其他任务。" checked={form.stopAfterDownload} disabled={busy || !form.enabled} onChange={(value) => update('stopAfterDownload', value)} />
      </div>
    </SettingsSection>
    <JellyfinSettingsPanel onNotice={onNotice} />
  </>;
}

export function SettingsPage({ onNotice }: { onNotice: (message: string) => void }) {
  return <section id="settings" className="settings-page">
    <p className="settings-intro">所有设置都以「保存」为唯一提交入口：保存前显示未保存标记，保存失败会在对应区块内说明原因，不会静默丢弃修改。</p>
    <QbittorrentSettingsPage onNotice={onNotice} />
    <NetworkSettings embedded onSaved={onNotice} />
    <RuntimeSettingsPanel onNotice={onNotice} />
    <NotificationSettingsModal embedded onNotice={onNotice} />
  </section>;
}

export type JellyfinSettings = {
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
  const [baseline, setBaseline] = useState<JellyfinForm | null>(null);
  const { pending, status, setStatus, run } = useSettingsActions();
  void onNotice;
  const busy = pending !== '';
  const dirty = baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);
  const update = <K extends keyof JellyfinForm>(key: K, value: JellyfinForm[K]) => setForm((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    void request<JellyfinSettings>('/api/settings/jellyfin').then((settings) => {
      const next: JellyfinForm = {
        enabled: settings.enabled, url: settings.url, apiKey: '', libraryIds: settings.libraryIds,
        syncIntervalMinutes: settings.syncIntervalMinutes, skipMagnetWhenAvailable: settings.skipMagnetWhenAvailable
      };
      setForm(next);
      setBaseline(next);
      setApiKeyConfigured(settings.apiKeyConfigured);
    }).catch((reason) => setStatus({ tone: 'error', message: reason instanceof Error ? reason.message : '无法读取 Jellyfin 设置。' })).finally(() => setLoading(false));
  }, [setStatus]);
  const payload = () => {
    const { apiKey, ...settings } = form;
    return { ...settings, ...(apiKey ? { apiKey } : {}) };
  };
  const putSettings = async () => {
    const settings = await request<JellyfinSettings>('/api/settings/jellyfin', { method: 'PUT', body: JSON.stringify(payload()) });
    const next: JellyfinForm = {
      enabled: settings.enabled, url: settings.url, apiKey: '', libraryIds: settings.libraryIds,
      syncIntervalMinutes: settings.syncIntervalMinutes, skipMagnetWhenAvailable: settings.skipMagnetWhenAvailable
    };
    setForm(next);
    setBaseline(next);
    setApiKeyConfigured(settings.apiKeyConfigured);
    return settings;
  };
  const toggleLibrary = (id: string) => setForm((old) => ({ ...old, libraryIds: old.libraryIds.includes(id) ? old.libraryIds.filter((item) => item !== id) : [...old.libraryIds, id] }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    void run('save', async () => {
      const settings = await putSettings();
      return settings.enabled ? '影视库设置已保存，等待同步。' : '影视库设置已保存，同步当前关闭。';
    }, '无法保存 Jellyfin 设置。');
  };
  const testConnection = () => {
    if (busy) return;
    void run('verify', async () => {
      await putSettings();
      const result = await request<{ server: { serverName: string; version: string | null }; libraries: JellyfinLibrary[] }>('/api/settings/jellyfin/test', { method: 'POST' });
      setLibraries(result.libraries);
      setForm((old) => old.libraryIds.length ? old : { ...old, libraryIds: result.libraries.map((library) => library.id) });
      return `连接成功：${result.server.serverName}${result.server.version ? ` ${result.server.version}` : ''}。请选择媒体库后保存。`;
    }, 'Jellyfin 连接测试失败。');
  };
  const syncNow = () => {
    if (busy) return;
    void run('sync', async () => {
      await putSettings();
      const result = await request<{ queued: boolean; jobId: number }>('/api/settings/jellyfin/sync', { method: 'POST' });
      return result.queued ? `全量同步已加入队列（任务 #${result.jobId}），可在运行中心查看进度。` : `全量同步已在执行或排队中（任务 #${result.jobId}）。`;
    }, 'Jellyfin 影视库同步失败。');
  };
  const discard = () => {
    if (!baseline) return;
    setForm(baseline);
    setStatus(null);
  };
  const syncBlocked = !form.enabled || !form.libraryIds.length;
  return <SettingsSection
    eyebrow="影视库"
    title="Jellyfin 影视库"
    description="以只读方式查询媒体库，用于判断内容是否已入库；不会修改影片或元数据。"
    loading={loading}
    dirty={dirty}
    status={status}
    onSubmit={submit}
    actions={<>
      {dirty && <SettingsActionButton disabled={busy} onClick={discard}>撤销更改</SettingsActionButton>}
      <SettingsActionButton busy={pending === 'verify'} disabled={busy && pending !== 'verify'} onClick={testConnection}>{pending === 'verify' ? '正在连接…' : '保存并检测媒体库'}</SettingsActionButton>
      <SettingsActionButton busy={pending === 'sync'} disabled={(busy && pending !== 'sync') || syncBlocked} onClick={syncNow}>{pending === 'sync' ? '正在同步…' : '立即同步影视库'}</SettingsActionButton>
      <SettingsActionButton tone="primary" type="submit" busy={pending === 'save'} disabled={busy || !dirty}>{pending === 'save' ? '保存中…' : '保存影视库设置'}</SettingsActionButton>
    </>}
  >
    <div className="settings-group">
      <SettingsToggle label="启用影视库同步" hint="关闭后不再读取媒体库，档案中的入库状态保持最后一次结果。" checked={form.enabled} disabled={busy} onChange={(value) => update('enabled', value)} />
    </div>
    <div className="settings-grid">
      <SettingsField wide label="Jellyfin Web 地址" hint="填写 Web UI 的局域网地址和端口，例如 http://192.168.1.20:8096。">
        <input disabled={busy} value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="http://192.168.1.20:8096" />
      </SettingsField>
      <SettingsField wide label="API 密钥" hint={apiKeyConfigured ? '已保存密钥；留空表示不修改。' : '在 Jellyfin 控制台的「API 密钥」页面生成。'}>
        <input type="password" autoComplete="off" disabled={busy} value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} placeholder={apiKeyConfigured ? '已保存，留空则不修改' : 'API 密钥'} />
      </SettingsField>
      <SettingsField label="同步间隔（分钟）" hint="范围 5–1440；默认 60 分钟。">
        <input type="number" min="5" max="1440" disabled={busy || !form.enabled} value={form.syncIntervalMinutes} onChange={(event) => update('syncIntervalMinutes', Number(event.target.value))} />
      </SettingsField>
    </div>
    <div className="settings-group">
      <SettingsToggle label="已入库时自动跳过磁力检索" hint="仅在确认影片已入库时跳过，避免重复检索。" checked={form.skipMagnetWhenAvailable} disabled={busy || !form.enabled} onChange={(value) => update('skipMagnetWhenAvailable', value)} />
    </div>
    <fieldset className="settings-fieldset" disabled={busy || !form.enabled}>
      <legend>同步的媒体库</legend>
      {libraries.length === 0
        ? <p className="settings-fieldset-empty">先点击「保存并检测媒体库」，即可读取并选择要同步的媒体库。</p>
        : <div className="settings-library-grid">{libraries.map((library) => <label key={library.id} className="settings-library-choice">
          <input type="checkbox" checked={form.libraryIds.includes(library.id)} onChange={() => toggleLibrary(library.id)} />
          <span><b>{library.name}</b>{library.collectionType ? <small>{library.collectionType}</small> : null}</span>
        </label>)}</div>}
      <span className="settings-fieldset-note">可多选；同步只读取所选媒体库中的影片项目。</span>
    </fieldset>
    {syncBlocked && <p className="settings-hint">启用同步并至少选择一个媒体库后，「立即同步影视库」才可用。</p>}
  </SettingsSection>;
}


function NetworkSettings({ onClose, onSaved, embedded = false }: { onClose?: () => void; onSaved: (message: string) => void; embedded?: boolean }) {
  const [proxyUrl, setProxyUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [fromEnvironment, setFromEnvironment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState<{ proxyUrl: string; enabled: boolean } | null>(null);
  const { pending, status, setStatus, run } = useSettingsActions();
  void onSaved;
  const busy = pending !== '';
  const dirty = baseline !== null && (proxyUrl !== baseline.proxyUrl || enabled !== baseline.enabled);
  useEffect(() => {
    void request<{ proxyUrl: string; enabled: boolean; fromEnvironment: boolean }>('/api/settings/network')
      .then((network) => {
        setProxyUrl(network.proxyUrl);
        setEnabled(network.enabled);
        setFromEnvironment(network.fromEnvironment);
        setBaseline({ proxyUrl: network.proxyUrl, enabled: network.enabled });
      })
      .catch((reason) => setStatus({ tone: 'error', message: reason instanceof Error ? reason.message : '无法读取网络设置。' }))
      .finally(() => setLoading(false));
  }, [setStatus]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || fromEnvironment || !dirty) return;
    void run('save', async () => {
      const network = await request<{ active: boolean; enabled: boolean }>('/api/settings/network', { method: 'PUT', body: JSON.stringify({ proxyUrl, enabled }) });
      setEnabled(network.enabled);
      setBaseline({ proxyUrl, enabled: network.enabled });
      return network.active ? '网络代理已保存。' : '网络代理已保存，代理当前关闭。';
    }, '无法保存网络设置。');
  };
  const discard = () => {
    if (!baseline) return;
    setProxyUrl(baseline.proxyUrl);
    setEnabled(baseline.enabled);
    setStatus(null);
  };
  const section = <SettingsSection
    id={embedded ? 'network' : undefined}
    eyebrow="网络连接"
    title="网络代理"
    description="普通抓取、浏览器渲染与磁力检索都会使用这里的代理；仅支持 HTTP / HTTPS 代理。"
    loading={loading}
    dirty={dirty}
    status={status}
    onSubmit={submit}
    actions={<>
      {onClose && !embedded && <SettingsActionButton disabled={busy} onClick={onClose}>取消</SettingsActionButton>}
      {dirty && !fromEnvironment && <SettingsActionButton disabled={busy} onClick={discard}>撤销更改</SettingsActionButton>}
      <SettingsActionButton tone="primary" type="submit" busy={pending === 'save'} disabled={busy || fromEnvironment || !dirty}>{pending === 'save' ? '保存中…' : '保存设置'}</SettingsActionButton>
    </>}
  >
    {fromEnvironment
      ? <p className="settings-notice">当前代理由部署环境的 <code>OUTBOUND_PROXY</code> 环境变量提供，网页内无法修改。</p>
      : <>
        <div className="settings-group">
          <SettingsToggle label="启用代理" hint="关闭后所有抓取都会直连目标站点。" checked={enabled} disabled={busy} onChange={setEnabled} />
        </div>
        <div className="settings-grid">
          <SettingsField wide label="HTTP / HTTPS 代理地址" hint="例如 http://192.168.1.10:7890；代理在其他设备时请填写其局域网地址。">
            <input disabled={busy || !enabled} value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="http://192.168.1.10:7890" />
          </SettingsField>
        </div>
      </>}
  </SettingsSection>;
  return embedded ? section : <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="network-title">{section}</div>;
}

function RuntimeSettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [runtime, setRuntime] = useState<RuntimeSettings>({ profile: 'safe', browserIdleMinutes: 10 });
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState<RuntimeSettings | null>(null);
  const { pending, status, setStatus, run } = useSettingsActions();
  void onNotice;
  const busy = pending !== '';
  const dirty = baseline !== null && JSON.stringify(runtime) !== JSON.stringify(baseline);
  useEffect(() => {
    void request<RuntimeSettings>('/api/settings/runtime')
      .then((settings) => { setRuntime(settings); setBaseline(settings); })
      .catch((reason) => setStatus({ tone: 'error', message: reason instanceof Error ? reason.message : '无法读取运行性能设置。' }))
      .finally(() => setLoading(false));
  }, [setStatus]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !dirty) return;
    void run('save', async () => {
      const settings = await request<RuntimeSettings>('/api/settings/runtime', { method: 'PUT', body: JSON.stringify(runtime) });
      setRuntime(settings);
      setBaseline(settings);
      return '运行性能已保存，下一个任务开始生效。';
    }, '无法保存运行性能设置。');
  };
  const discard = () => {
    if (!baseline) return;
    setRuntime(baseline);
    setStatus(null);
  };
  return <SettingsSection
    id="runtime"
    eyebrow="执行引擎"
    title="运行性能"
    description="控制浏览器渲染的并发与回收节奏；任务始终优先使用浏览器渲染，不会退回高并发抓取。"
    loading={loading}
    dirty={dirty}
    status={status}
    onSubmit={submit}
    actions={<>
      {dirty && <SettingsActionButton disabled={busy} onClick={discard}>撤销更改</SettingsActionButton>}
      <SettingsActionButton tone="primary" type="submit" busy={pending === 'save'} disabled={busy || !dirty}>{pending === 'save' ? '保存中…' : '保存运行性能'}</SettingsActionButton>
    </>}
  >
    <div className="settings-grid">
      <SettingsField label="浏览器模式" hint="性能模式最多两页并发，会增加内存占用和站点访问风险。">
        <select disabled={busy} value={runtime.profile} onChange={(event) => setRuntime((current) => ({ ...current, profile: event.target.value as RuntimeSettings['profile'] }))}>
          <option value="safe">稳妥：单页并发</option>
          <option value="performance">性能：最多两页并发</option>
        </select>
      </SettingsField>
      <SettingsField label="空闲回收" hint="没有浏览器任务时，Chromium 会在该时长后退出并释放内存。">
        <select disabled={busy} value={runtime.browserIdleMinutes} onChange={(event) => setRuntime((current) => ({ ...current, browserIdleMinutes: Number(event.target.value) as RuntimeSettings['browserIdleMinutes'] }))}>
          <option value={5}>5 分钟</option>
          <option value={10}>10 分钟（默认）</option>
          <option value={20}>20 分钟</option>
        </select>
      </SettingsField>
    </div>
  </SettingsSection>;
}

function NotificationSettingsModal({ onClose, onNotice, embedded = false }: { onClose?: () => void; onNotice: (message: string) => void; embedded?: boolean }) {
  const [form, setForm] = useState<NotificationForm>(blankNotificationForm);
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState<NotificationForm | null>(null);
  const { pending, status, setStatus, run } = useSettingsActions();
  void onNotice;
  const busy = pending !== '';
  const dirty = baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);
  useEffect(() => {
    void request<NotificationSettings>('/api/settings/notifications')
      .then((settings) => {
        const next: NotificationForm = { ...settings, wecomWebhook: '', dingtalkWebhook: '', dingtalkSecret: '', webhookUrl: '', webhookHmacSecret: '' };
        setForm(next);
        setBaseline(next);
      })
      .catch((reason) => setStatus({ tone: 'error', message: reason instanceof Error ? reason.message : '无法读取通知设置。' }))
      .finally(() => setLoading(false));
  }, [setStatus]);
  const update = <K extends keyof NotificationForm>(key: K, value: NotificationForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const updateEvent = <K extends keyof NotificationEvents>(key: K, value: boolean) => setForm((current) => ({ ...current, events: { ...current.events, [key]: value } }));
  const configuredLabel = (configured: boolean) => configured ? '已保存，留空则不修改' : '';
  function payload() {
    const { wecomWebhook, dingtalkWebhook, dingtalkSecret, webhookUrl, webhookHmacSecret, ...settings } = form;
    return {
      ...settings,
      ...(wecomWebhook.trim() ? { wecomWebhook: wecomWebhook.trim() } : {}),
      ...(dingtalkWebhook.trim() ? { dingtalkWebhook: dingtalkWebhook.trim() } : {}),
      ...(dingtalkSecret.trim() ? { dingtalkSecret: dingtalkSecret.trim() } : {}),
      ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      ...(webhookHmacSecret.trim() ? { webhookHmacSecret: webhookHmacSecret.trim() } : {})
    };
  }
  async function putSettings() {
    const settings = await request<NotificationSettings>('/api/settings/notifications', { method: 'PUT', body: JSON.stringify(payload()) });
    const next: NotificationForm = { ...settings, wecomWebhook: '', dingtalkWebhook: '', dingtalkSecret: '', webhookUrl: '', webhookHmacSecret: '' };
    setForm(next);
    setBaseline(next);
    return settings;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !dirty) return;
    void run('save', async () => {
      const settings = await putSettings();
      return settings.enabled ? '通知设置已保存并启用。' : '通知设置已保存，通知当前关闭。';
    }, '无法保存通知设置。');
  };
  const test = () => {
    if (busy) return;
    void run('test', async () => {
      await putSettings();
      await request('/api/settings/notifications/test', { method: 'POST' });
      return '测试通知已发送，请到对应渠道确认。';
    }, '测试通知发送失败。');
  };
  const discard = () => {
    if (!baseline) return;
    setForm(baseline);
    setStatus(null);
  };
  const channelConfigured = form.channel === 'wecom' ? form.wecomWebhookConfigured : form.channel === 'dingtalk' ? form.dingtalkWebhookConfigured : form.webhookUrlConfigured;
  const channelInputPresent = form.channel === 'wecom' ? Boolean(form.wecomWebhook.trim()) : form.channel === 'dingtalk' ? Boolean(form.dingtalkWebhook.trim()) : Boolean(form.webhookUrl.trim());
  const testBlocked = !channelConfigured && !channelInputPresent;
  const section = <SettingsSection
    id={embedded ? 'notifications' : undefined}
    eyebrow="通知与告警"
    title="通知设置"
    description="一次只向一个主渠道发送。全量检索完成后发送汇总；中间重试不发送，相同失败 30 分钟内合并。"
    loading={loading}
    dirty={dirty}
    status={status}
    onSubmit={submit}
    actions={<>
      {onClose && !embedded && <SettingsActionButton disabled={busy} onClick={onClose}>关闭</SettingsActionButton>}
      {dirty && <SettingsActionButton disabled={busy} onClick={discard}>撤销更改</SettingsActionButton>}
      <SettingsActionButton busy={pending === 'test'} disabled={(busy && pending !== 'test') || testBlocked} onClick={test}>{pending === 'test' ? '正在发送…' : '保存并发送测试'}</SettingsActionButton>
      <SettingsActionButton tone="primary" type="submit" busy={pending === 'save'} disabled={busy || !dirty}>{pending === 'save' ? '保存中…' : '保存通知设置'}</SettingsActionButton>
    </>}
  >
    <div className="settings-group">
      <SettingsToggle label="启用通知" hint="关闭后不再发送任何通知，事件仍会记录在运行日志中。" checked={form.enabled} disabled={busy} onChange={(value) => update('enabled', value)} />
    </div>
    <div className="settings-grid">
      <SettingsField label="主通知渠道" hint="切换渠道不会删除其他渠道已保存的地址。">
        <select disabled={busy} value={form.channel} onChange={(event) => update('channel', event.target.value as NotificationChannel)}>
          <option value="wecom">企业微信机器人</option>
          <option value="dingtalk">钉钉机器人</option>
          <option value="webhook">通用 Webhook</option>
        </select>
      </SettingsField>
    </div>
    <div className="settings-group-title">通知事件</div>
    <div className="settings-group">
      <SettingsToggle label="发现新内容" checked={form.events.content_discovered} disabled={busy} onChange={(value) => updateEvent('content_discovered', value)} />
      <SettingsToggle label="全量检索完成汇总" checked={form.events.full_scan_completed} disabled={busy} onChange={(value) => updateEvent('full_scan_completed', value)} />
      <SettingsToggle label="任务最终失败" checked={form.events.operation_failed} disabled={busy} onChange={(value) => updateEvent('operation_failed', value)} />
      <SettingsToggle label="已找到磁力链接" checked={form.events.magnet_found} disabled={busy} onChange={(value) => updateEvent('magnet_found', value)} />
      <SettingsToggle label="qBittorrent 下载完成" checked={form.events.download_completed} disabled={busy} onChange={(value) => updateEvent('download_completed', value)} />
    </div>
    <div className="settings-group-title">渠道地址</div>
    <div className="settings-grid">
      {form.channel === 'wecom' && <SettingsField wide label="Webhook 地址" hint="地址保存在服务端数据库中且不回显；数据库与备份中为明文，请限制访问。">
        <input type="password" autoComplete="off" disabled={busy} value={form.wecomWebhook} onChange={(event) => update('wecomWebhook', event.target.value)} placeholder={configuredLabel(form.wecomWebhookConfigured)} />
      </SettingsField>}
      {form.channel === 'dingtalk' && <>
        <SettingsField wide label="Webhook 地址">
          <input type="password" autoComplete="off" disabled={busy} value={form.dingtalkWebhook} onChange={(event) => update('dingtalkWebhook', event.target.value)} placeholder={configuredLabel(form.dingtalkWebhookConfigured)} />
        </SettingsField>
        <SettingsField wide label="签名密钥（可选）" hint="机器人启用「加签」时填写，否则留空。">
          <input type="password" autoComplete="off" disabled={busy} value={form.dingtalkSecret} onChange={(event) => update('dingtalkSecret', event.target.value)} placeholder={configuredLabel(form.dingtalkSecretConfigured)} />
        </SettingsField>
      </>}
      {form.channel === 'webhook' && <>
        <SettingsField wide label="Webhook 地址" hint="以 JSON POST 发送。">
          <input type="password" autoComplete="off" disabled={busy} value={form.webhookUrl} onChange={(event) => update('webhookUrl', event.target.value)} placeholder={configuredLabel(form.webhookUrlConfigured)} />
        </SettingsField>
        <SettingsField wide label="HMAC 密钥（可选）" hint="签名在 X-Page-Watch-Signature，时间戳在 X-Page-Watch-Timestamp。">
          <input type="password" autoComplete="off" disabled={busy} value={form.webhookHmacSecret} onChange={(event) => update('webhookHmacSecret', event.target.value)} placeholder={configuredLabel(form.webhookHmacSecretConfigured)} />
        </SettingsField>
      </>}
    </div>
    {testBlocked && <p className="settings-hint">填写当前渠道的地址后，才能发送测试通知。</p>}
  </SettingsSection>;
  return embedded ? section : <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="notification-title">{section}</div>;
}

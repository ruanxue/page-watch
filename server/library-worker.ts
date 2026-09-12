import { appendRuntimeLog, getJellyfinSettings, getSetting, refreshSettings, reportWorkerHeartbeat } from './db.js';
import { syncJellyfinLibrary } from './jellyfin-sync.js';

const POLL_MS = 15_000;
let working = false;
let syncing = false;
let lastErrorLogAt = 0;

async function syncHeartbeat() {
  if (!syncing) return;
  await reportWorkerHeartbeat('library', '正在同步 Jellyfin 影视库', 'busy').catch(() => undefined);
}

function syncDue() {
  const last = Date.parse(getSetting('jellyfin_last_synced_at'));
  const interval = getJellyfinSettings().syncIntervalMinutes * 60_000;
  return !Number.isFinite(last) || Date.now() - last >= interval;
}

async function tick() {
  if (working) return;
  working = true;
  try {
    await refreshSettings();
    const settings = getJellyfinSettings();
    if (!settings.enabled) {
      await reportWorkerHeartbeat('library', 'Jellyfin 影视库同步未启用');
      return;
    }
    if (!settings.libraryIds.length) {
      await reportWorkerHeartbeat('library', '等待选择 Jellyfin 媒体库', 'error');
      return;
    }
    if (!syncDue()) {
      await reportWorkerHeartbeat('library', `Jellyfin 影视库将在下个计划周期同步（每 ${settings.syncIntervalMinutes} 分钟）`);
      return;
    }
    syncing = true;
    await syncHeartbeat();
    const result = await syncJellyfinLibrary('scheduled');
    syncing = false;
    await reportWorkerHeartbeat('library', `Jellyfin 已同步 ${result.scanned} 个媒体项目，匹配 ${result.matched} 条归档`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知 Jellyfin 同步错误';
    console.error(`Jellyfin library sync failed: ${message}`);
    await reportWorkerHeartbeat('library', `Jellyfin 同步失败：${message}`, 'error').catch(() => undefined);
    if (Date.now() - lastErrorLogAt >= 60_000) {
      lastErrorLogAt = Date.now();
      await appendRuntimeLog({ level: 'error', source: 'library', message: `Jellyfin 影视库同步失败：${message}` }).catch(() => undefined);
    }
  } finally { syncing = false; working = false; }
}

void appendRuntimeLog({ level: 'info', source: 'system', message: 'Jellyfin 影视库同步 Worker 已启动。' })
  .catch((error) => console.error(`Unable to save Jellyfin startup log: ${error instanceof Error ? error.message : String(error)}`));
console.log('Page Watch Jellyfin library worker started');
void tick();
setInterval(() => void tick(), POLL_MS);
const heartbeatTimer = setInterval(() => void syncHeartbeat(), 15_000);
heartbeatTimer.unref();

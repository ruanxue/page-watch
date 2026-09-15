import { refreshSettings, reportRuntimeMetrics } from './db.js';
import { syncJellyfinLibrary, type JellyfinSyncProgress } from './jellyfin-sync.js';
import { startRuntimeMemoryReporter } from './runtime-observability.js';

function send(message: unknown) { if (process.send) process.send(message); }

function finish(message: unknown, code: number) {
  if (process.send) {
    process.send(message, () => process.exit(code));
    return;
  }
  process.exit(code);
}

async function main() {
  const trigger = process.env.LIBRARY_SYNC_TRIGGER === 'manual' ? 'manual' : 'scheduled';
  await refreshSettings(true);
  send({ type: 'state', state: 'running', rssBytes: process.memoryUsage().rss });
  await reportRuntimeMetrics([{ key: 'library_sync_state', text: 'running' }, { key: 'library_sync_rss_bytes', value: process.memoryUsage().rss }]);
  const result = await syncJellyfinLibrary(trigger, async (progress: JellyfinSyncProgress) => {
    send({ type: 'progress', progress, rssBytes: process.memoryUsage().rss });
    await reportRuntimeMetrics([{ key: 'library_sync_state', text: progress.phase }, { key: 'library_sync_rss_bytes', value: process.memoryUsage().rss }]);
  });
  finish({ type: 'result', ok: true, result, rssBytes: process.memoryUsage().rss }, 0);
}

startRuntimeMemoryReporter('library_sync');
void main().catch((error) => {
  finish({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error), rssBytes: process.memoryUsage().rss }, 1);
});

process.once('disconnect', () => process.exit(0));

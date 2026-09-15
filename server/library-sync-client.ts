import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportRuntimeMetrics } from './db.js';
import type { JellyfinSyncProgress, JellyfinSyncResult } from './jellyfin-sync.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === 'production';

function executorPath() { return production ? path.join(directory, 'library-sync-executor.js') : path.resolve(process.cwd(), 'server', 'library-sync-executor.ts'); }

export class LibrarySyncClient {
  private child: ChildProcess | null = null;
  private rssBytes: number | null = null;

  snapshot() { return { active: Boolean(this.child?.connected), rssBytes: this.rssBytes }; }

  async run(trigger: 'manual' | 'scheduled', onProgress: (progress: JellyfinSyncProgress) => Promise<void> | void) {
    if (this.child?.connected) throw new Error('Jellyfin 同步器正在执行其他任务。');
    const child = fork(executorPath(), [], {
      cwd: production ? path.resolve(directory, '..') : process.cwd(),
      execArgv: production ? [] : ['--import', 'tsx'],
      env: { ...process.env, LIBRARY_SYNC_TRIGGER: trigger },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    this.child = child;
    await reportRuntimeMetrics([{ key: 'library_sync_state', text: 'starting' }]).catch(() => undefined);
    return new Promise<JellyfinSyncResult>((resolve, reject) => {
      let settled = false;
      const settle = (callback: (value?: any) => void, value?: any) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      child.on('message', (message: any) => {
        if (typeof message?.rssBytes === 'number') {
          this.rssBytes = message.rssBytes;
          void reportRuntimeMetrics([{ key: 'library_sync_rss_bytes', value: this.rssBytes }]).catch(() => undefined);
        }
        if (message?.type === 'progress' && message.progress) void onProgress(message.progress as JellyfinSyncProgress);
        if (message?.type === 'result') {
          if (message.ok) settle(resolve, message.result as JellyfinSyncResult);
          else settle(reject, new Error(message.error || 'Jellyfin 同步器执行失败。'));
        }
      });
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        this.rssBytes = null;
        void reportRuntimeMetrics([{ key: 'library_sync_rss_bytes', value: 0 }, { key: 'library_sync_state', text: 'offline' }]).catch(() => undefined);
        if (!settled) settle(reject, new Error(`Jellyfin 同步器意外退出（${signal ?? `退出码 ${code ?? '未知'}`}）。`));
      });
      child.once('error', (error) => settle(reject, error));
    });
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

export const librarySyncExecutor = new LibrarySyncClient();

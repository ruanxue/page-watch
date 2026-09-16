import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type EngineState = 'sleeping' | 'starting' | 'running' | 'stopping' | 'error';
export type EngineSnapshot = { state: EngineState; startedAt: string | null; lastStartedAt: string | null; lastExitAt: string | null; starts: number; detail: string | null };

type EngineMessage = { type?: string; state?: EngineState; detail?: string };

/**
 * The API owns the disposable execution-engine child. This keeps the public
 * HTTP/SSE process alive while allowing all queue handlers to leave memory
 * when there is no runnable work.
 */
export class ExecutionEngineController {
  private child: ChildProcess | null = null;
  private state: EngineState = 'sleeping';
  private startedAt: string | null = null;
  private lastStartedAt: string | null = null;
  private lastExitAt: string | null = null;
  private starts = 0;
  private detail: string | null = '按需休眠';
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private stopping = false;

  snapshot(): EngineSnapshot {
    return { state: this.state, startedAt: this.startedAt, lastStartedAt: this.lastStartedAt, lastExitAt: this.lastExitAt, starts: this.starts, detail: this.detail };
  }

  onChange(listener: (snapshot: EngineSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  async wake(reason = '有待处理任务') {
    this.stopping = false;
    // A user action should start work now, not leave an earlier crash-backoff
    // timer around to send a redundant wake later.
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child?.connected) {
      this.child.send({ type: 'wake', reason });
      return;
    }
    if (!this.startPromise) this.startPromise = this.start(reason);
    await this.startPromise;
  }

  private async start(reason: string) {
    this.state = 'starting';
    this.detail = reason;
    this.emit();
    const current = fileURLToPath(import.meta.url);
    const sourceDirectory = path.dirname(current);
    const production = process.env.NODE_ENV === 'production';
    const runnerPath = path.join(sourceDirectory, production ? 'runner.js' : 'runner.ts');
    const child = fork(runnerPath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: production ? ['--expose-gc'] : ['--expose-gc', '--import', 'tsx'],
      env: { ...process.env, PAGE_WATCH_WORKER_AUTOSTART: '0', PAGE_WATCH_DATABASE_INITIALIZE: '0', PAGE_WATCH_TELEMETRY_BUFFERED: '1' }
    });
    this.child = child;
    this.starts += 1;
    this.startedAt = new Date().toISOString();
    this.lastStartedAt = this.startedAt;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('统一执行引擎启动超时。')), 15_000);
      const ready = () => finish();
      child.once('error', (error) => finish(error));
      child.on('message', (message: EngineMessage) => {
        if (message?.type === 'ready') ready();
        if (message?.type === 'ready') this.restartAttempts = 0;
        if (message?.type === 'state' && message.state) {
          this.state = message.state;
          this.detail = message.detail ?? null;
          this.emit();
        }
      });
      child.once('exit', (code, signal) => {
        if (!settled) finish(new Error(`统一执行引擎未就绪即退出（${signal ? signal : `退出码 ${code ?? '未知'}`}）。`));
        if (this.child === child) {
          this.child = null;
          this.startedAt = null;
          this.lastExitAt = new Date().toISOString();
          // A signal is only expected when the API deliberately stopped the
          // child. Treat an OOM/SIGKILL or other external termination as a
          // failure so the controller's bounded backoff can recover it.
          const expectedStop = this.stopping || code === 76;
          this.state = expectedStop ? 'sleeping' : 'error';
          this.detail = code === 76 ? '队列空闲，已按需休眠' : `引擎退出${signal ? `（${signal}）` : `（退出码 ${code ?? '未知'}）`}`;
          this.emit();
          if (!expectedStop) this.scheduleRestart();
        }
      });
    }).finally(() => { this.startPromise = null; });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.state = 'stopping';
    this.emit();
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.restartAttempts += 1;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.restartAttempts - 1, 4));
    this.detail = `引擎异常退出，将在约 ${Math.ceil(delay / 1_000)} 秒后重试`;
    this.emit();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) void this.wake('引擎异常后的退避重试').catch(() => undefined);
    }, delay);
    this.restartTimer.unref();
  }
}

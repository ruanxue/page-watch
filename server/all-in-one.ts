import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type ManagedProcess = {
  name: string;
  entry: string;
  role: 'api' | 'runner';
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';
const resolvedProjectRoot = production ? path.resolve(projectRoot, '..') : projectRoot;
const tsxCli = path.join(resolvedProjectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const managedProcesses: ManagedProcess[] = [
  { name: '网页服务', entry: 'server/index.ts', role: 'api' },
  { name: '统一执行引擎', entry: 'server/runner.ts', role: 'runner' }
];

const children = new Map<string, ChildProcess>();
let stopping = false;
let runnerRecycleNotBefore = 0;
const workerEventToken = process.env.WORKER_EVENT_TOKEN || crypto.randomBytes(32).toString('hex');
const ENGINE_MEMORY_RECYCLE_EXIT_CODE = 75;

function startProcess(spec: ManagedProcess) {
  if (stopping) return;
  const entry = production ? path.join(resolvedProjectRoot, 'build', spec.entry.replace(/^server\//, 'server/').replace(/\.ts$/, '.js')) : spec.entry;
  const args = production ? [entry] : [tsxCli, entry];
  // The engine alone performs controlled GC after a large, fully idle batch.
  // The API stays untouched so browser sessions and SSE connections survive.
  if (spec.role === 'runner') args.unshift('--expose-gc');
  const child = spawn(process.execPath, args, {
    cwd: resolvedProjectRoot,
    env: {
      ...process.env,
      // 浏览器渲染仅由网页检查任务使用；设为全局变量不会影响其他任务，
      // 但可确保单容器部署时始终使用容器内的无头 Chromium。
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'true',
      WORKER_EVENT_TOKEN: workerEventToken,
      WORKER_EVENT_URL: process.env.WORKER_EVENT_URL || 'http://127.0.0.1:3030',
      RUNNER_INTERNAL_PORT: process.env.RUNNER_INTERNAL_PORT || '3031',
      ...(spec.role === 'runner' && runnerRecycleNotBefore ? { ENGINE_MEMORY_RECYCLE_NOT_BEFORE: new Date(runnerRecycleNotBefore).toISOString() } : {})
    },
    stdio: 'inherit'
  });
  children.set(spec.name, child);
  console.log(`[主管理器] 已启动：${spec.name}（PID ${child.pid ?? '未知'}）`);

  child.once('exit', (code, signal) => {
    children.delete(spec.name);
    if (stopping) return;
    const plannedMemoryRecycle = spec.role === 'runner' && code === ENGINE_MEMORY_RECYCLE_EXIT_CODE;
    if (plannedMemoryRecycle) {
      // A runner whose baseline is naturally above the threshold must not
      // loop forever. The fresh process gets a long quiet window first.
      runnerRecycleNotBefore = Date.now() + 30 * 60_000;
      console.log('[主管理器] 统一执行引擎已完成空闲内存回收，1 秒后恢复。');
      setTimeout(() => startProcess(spec), 1_000).unref();
      return;
    }
    console.error(`[主管理器] ${spec.name} 已退出（${signal ?? `退出码 ${code ?? '未知'}`}），5 秒后重启。`);
    setTimeout(() => startProcess(spec), 5_000).unref();
  });

  child.once('error', (error) => {
    console.error(`[主管理器] 无法启动 ${spec.name}：${error.message}`);
  });
}

function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.log(`[主管理器] 收到 ${signal}，正在停止全部任务。`);
  for (const child of children.values()) child.kill('SIGTERM');
  const forceExit = setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(0);
  }, 15_000);
  forceExit.unref();
  const watch = setInterval(() => {
    if (children.size > 0) return;
    clearInterval(watch);
    process.exit(0);
  }, 100);
  watch.unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

console.log('[主管理器] Page Watch 单容器模式已启动。');
for (const spec of managedProcesses) startProcess(spec);

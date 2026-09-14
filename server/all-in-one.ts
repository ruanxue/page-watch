import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type ManagedProcess = {
  name: string;
  entry: string;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const managedProcesses: ManagedProcess[] = [
  { name: '网页服务', entry: 'server/index.ts' },
  { name: '网页检查', entry: 'server/worker.ts' },
  { name: '发行日期', entry: 'server/release-worker.ts' },
  { name: '磁力检索', entry: 'server/magnet-worker.ts' },
  { name: 'qBittorrent 下载', entry: 'server/download-worker.ts' },
  { name: 'Jellyfin 同步', entry: 'server/library-worker.ts' }
];

const children = new Map<string, ChildProcess>();
let stopping = false;
const workerEventToken = process.env.WORKER_EVENT_TOKEN || crypto.randomBytes(32).toString('hex');

function startProcess(spec: ManagedProcess) {
  if (stopping) return;
  const child = spawn(process.execPath, [tsxCli, spec.entry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // 浏览器渲染仅由网页检查任务使用；设为全局变量不会影响其他任务，
      // 但可确保单容器部署时始终使用容器内的无头 Chromium。
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'true',
      WORKER_EVENT_TOKEN: workerEventToken,
      WORKER_EVENT_URL: process.env.WORKER_EVENT_URL || 'http://127.0.0.1:3030'
    },
    stdio: 'inherit'
  });
  children.set(spec.name, child);
  console.log(`[主管理器] 已启动：${spec.name}（PID ${child.pid ?? '未知'}）`);

  child.once('exit', (code, signal) => {
    children.delete(spec.name);
    if (stopping) return;
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

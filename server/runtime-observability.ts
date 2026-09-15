import fs from 'node:fs/promises';
import { reportRuntimeMetrics, type RuntimeMetric } from './db.js';

type BrowserSnapshot = {
  state: 'active' | 'idle' | 'closed';
  activePages: number;
  queuedPages: number;
  navigationCount: number;
};

async function readFirstNumber(paths: string[]) {
  for (const path of paths) {
    try {
      const value = Number((await fs.readFile(path, 'utf8')).trim());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      // cgroup v1/v2 layout depends on the NAS Docker host; try the next one.
    }
  }
  return null;
}

export async function reportRuntimeMemory(role: 'api' | 'runner', browser?: BrowserSnapshot) {
  const cgroupBytes = await readFirstNumber(['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']);
  const metrics: RuntimeMetric[] = [
    { key: `${role}_rss_bytes`, value: process.memoryUsage().rss },
    ...(role === 'runner' ? [{ key: 'container_memory_bytes', value: cgroupBytes }] : [])
  ];
  if (browser) {
    metrics.push(
      { key: 'browser_active_pages', value: browser.activePages },
      { key: 'browser_queued_pages', value: browser.queuedPages },
      { key: 'browser_navigation_count', value: browser.navigationCount },
      { key: 'browser_state', text: browser.state }
    );
  }
  await reportRuntimeMetrics(metrics);
}

export function startRuntimeMemoryReporter(role: 'api' | 'runner', browser?: () => BrowserSnapshot | undefined) {
  const report = () => void reportRuntimeMemory(role, browser?.()).catch(() => undefined);
  report();
  const timer = setInterval(report, 15_000);
  timer.unref();
  return report;
}

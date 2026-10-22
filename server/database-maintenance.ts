import { appendRuntimeLog, maintainPerformanceMetrics, rebuildSubscriptionProgress } from './db.js';

/** 每项独立收尾，指标清理失败也不能阻断业务统计校准。 */
export async function maintainDatabase() {
  for (const [label, maintain] of [['长期性能指标维护', maintainPerformanceMetrics], ['订阅统计校准', rebuildSubscriptionProgress]] as const) {
    try { await maintain(); }
    catch (error) {
      const detail = error instanceof Error ? error.message : '未知数据库错误';
      await appendRuntimeLog({ level: 'error', source: 'system', message: `${label}失败：${detail}` }).catch(() => undefined);
    }
  }
}

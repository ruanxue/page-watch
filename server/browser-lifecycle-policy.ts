export type TaskErrorContext = {
  /** 本次任务是否成功拿到了独立 context（失败在启动/建页面阶段时为 false）。 */
  contextCreated: boolean;
  /** 共享 Chromium 此刻是否仍然连着。 */
  browserConnected: boolean;
};

/**
 * 一次任务失败后，是否真的需要重建共享 Chromium。
 *
 * 页面级故障（导航超时、选择器不存在、内容解析失败）只影响这一页，共用浏览器
 * 仍然健康；重建它只会白白付出一次冷启动开销和内存尖峰，还会拖慢后续任务。
 * 只有浏览器本身不可用（启动失败、进程崩溃、连接断开）才值得重建。
 */
export function shouldRebuildBrowserAfterTaskError(context: TaskErrorContext) {
  return !context.contextCreated || !context.browserConnected;
}

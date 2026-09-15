export const MAX_JOB_ATTEMPTS = 3;

export function retryDelayMs(attempt: number) {
  const base = attempt === 1 ? 30_000 : 2 * 60_000;
  // Keep retries spread across services started at the same time. The small
  // jitter never changes the documented ~30 s / ~2 min cadence materially.
  return base + Math.floor(Math.random() * 5_001);
}

/**
 * Only retry failures that point to a transient connection or remote-service
 * problem. Rule/configuration mistakes are presented immediately so a worker
 * never hammers a target page with a request that cannot succeed.
 */
export function isRetryableJobError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message) return false;
  if (/选择器|正则|规则|配置|订阅已删除|未启用|密码|api 密钥|身份验证|401|403|404|无效/.test(message)) return false;
  return /fetch failed|timeout|timed out|econnreset|econnrefused|econnaborted|enetunreach|ehostunreach|eai_again|enotfound|dns|net::err|proxy|socket|network|429|5\d\d|无法解析/.test(message);
}

/** A safe, low-cardinality label for long-term telemetry. Never persist raw errors. */
export function retryReason(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/429|too many/.test(message)) return 'rate_limited';
  if (/timeout|timed out|aborted/.test(message)) return 'timeout';
  if (/eai_again|enotfound|dns|无法解析/.test(message)) return 'dns';
  if (/proxy/.test(message)) return 'proxy';
  if (/5\d\d|server error/.test(message)) return 'server_5xx';
  if (/econn|socket|network|enetwork|enetunreach|ehostunreach/.test(message)) return 'network';
  return 'transient_other';
}

export function retryDescription(attempt: number) {
  const label = attempt === 1 ? '约 30 秒' : '约 2 分钟';
  return `第 ${attempt}/${MAX_JOB_ATTEMPTS} 次失败，将在${label}后自动重试`;
}

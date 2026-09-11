export const MAX_JOB_ATTEMPTS = 3;

export function retryDelayMs(attempt: number) {
  return attempt === 1 ? 30_000 : 2 * 60_000;
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

export function retryDescription(attempt: number) {
  return `第 ${attempt}/${MAX_JOB_ATTEMPTS} 次失败，将在 ${Math.round(retryDelayMs(attempt) / 1000)} 秒后自动重试`;
}

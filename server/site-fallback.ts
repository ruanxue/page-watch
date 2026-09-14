/**
 * MissAV exposes compatible content from more than one public origin. Keep
 * this small routing rule separate from extraction rules: selectors continue
 * to describe the page, while this only supplies a second route when the
 * primary origin is unavailable.
 */
const missavPrimaryHosts = new Set(['missav123.com', 'www.missav123.com']);
const missavBackupOrigin = 'https://missav.live';

export function missavBackupUrl(url: URL) {
  if (!missavPrimaryHosts.has(url.hostname.toLowerCase())) return null;
  const backup = new URL(url.pathname + url.search + url.hash, missavBackupOrigin);
  return backup;
}

/**
 * Only availability failures trigger a host switch. Selector, regex and date
 * extraction errors must stay visible instead of being hidden by a retry on a
 * different domain.
 */
export function shouldTryMissavBackup(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /page\.goto:.*(?:timeout|net::)|\bnet::|fetch failed|\b(?:econnreset|econnrefused|enotfound|etimedout)\b|socket hang up|network error|请求超时|HTTP\s+(?:403|408|429|5\d\d)|返回 HTTP\s+(?:403|408|429|5\d\d)|安全验证拦截/i.test(message);
}

export function missavFallbackFailure(primary: URL, backup: URL, primaryError: unknown, backupError: unknown) {
  const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
  const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
  return new Error(`主站 ${primary.hostname} 暂不可用，已尝试备用站 ${backup.hostname}；备用站也未成功：${backupMessage}`, { cause: new Error(primaryMessage) });
}

import { nextSiteUrl, type SitesRule } from './site-list.js';

/**
 * MissAV 有多个可用的公开站点。站点列表由「检查规则」页面配置，这里只负责
 * 在可用性故障时给出下一个候选地址：选择器、正则等读取规则继续描述页面，
 * 换站不会掩盖规则错误。
 */

export function siteFallbackUrl(url: URL, sites: SitesRule) {
  return nextSiteUrl(url, sites);
}

/**
 * 只有可用性故障才换站。选择器、正则和日期提取错误必须暴露出来，而不是被
 * 另一个域名上的重试掩盖。
 */
export function shouldTryMissavBackup(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /page\.goto:.*(?:timeout|net::)|\bnet::|fetch failed|\b(?:econnreset|econnrefused|enotfound|etimedout)\b|socket hang up|network error|请求超时|HTTP\s+(?:403|408|429|5\d\d)|返回 HTTP\s+(?:403|408|429|5\d\d)|安全验证拦截/i.test(message);
}

export function missavFallbackFailure(primary: URL, backup: URL, primaryError: unknown, backupError: unknown) {
  const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
  const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
  // 当前地址可能就是配置里的第二个站点，此时 backup 会回到第一个站点，用
  // 「下一个站点」描述比「备用站」更准确。
  return new Error(`站点 ${primary.hostname} 暂不可用，已尝试 ${backup.hostname}；它也未能成功：${backupMessage}`, { cause: new Error(primaryMessage) });
}

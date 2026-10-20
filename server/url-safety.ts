import { setDefaultResultOrder } from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * URL validation deliberately has no dependency on capture/browser modules.
 * API validation must stay lightweight: importing the capture module would
 * otherwise pull Playwright and Cheerio into the long-lived API process.
 */
setDefaultResultOrder('ipv4first');

const blockedHosts = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

/**
 * 把 IPv4-mapped IPv6（`::ffff:127.0.0.1`、`0:0:0:0:0:ffff:7f00:1`）还原成 IPv4。
 * 这类地址在多数系统上等价于直接连接该 IPv4 地址，若不还原就会绕过内网判断。
 */
function ipv4FromMappedIpv6(value: string): string | null {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase();
  const match = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/.exec(host);
  if (!match) return null;
  const tail = match[1];
  if (net.isIP(tail) === 4) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function normalizeIp(value: string) {
  return ipv4FromMappedIpv6(value) ?? value.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isPrivateIp(value: string) {
  const hostname = normalizeIp(value);
  if (!net.isIP(hostname)) return false;
  if (hostname === '::1' || hostname === '::' || hostname === '0.0.0.0') return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')) return true;
  if (hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.')) return true;
  const [first, second] = hostname.split('.').map(Number);
  return first === 172 && second >= 16 && second <= 31;
}

function isIpv6Loopback(value: string) {
  return value.replace(/^\[|\]$/g, '').toLowerCase() === '::1';
}

export async function assertSafeUrl(raw: string, options: { allowUnresolvedViaProxy?: boolean; hasOutboundProxy?: boolean } = {}) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('请输入有效的网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http 或 https 地址。');
  if (blockedHosts.has(url.hostname.toLowerCase()) || isPrivateIp(url.hostname)) throw new Error('不允许访问本机或内网地址。');

  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length && !(options.allowUnresolvedViaProxy && options.hasOutboundProxy)) throw new Error('无法解析该网页地址。');
  const privateAddresses = addresses.filter((address) => isPrivateIp(address.address));
  const publicAddresses = addresses.filter((address) => !isPrivateIp(address.address));
  const mixedLoopbackOnly = publicAddresses.length > 0 && privateAddresses.length > 0 && privateAddresses.every((address) => isIpv6Loopback(address.address));
  if (privateAddresses.length > 0 && !mixedLoopbackOnly) {
    throw new Error(`不允许访问解析到内网的地址（${url.hostname}：${addresses.map((address) => address.address).join(', ')}）。`);
  }
  return url;
}

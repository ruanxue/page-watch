import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * HTTP 边界防护：代理信任、鉴权路径规范化、登录限流、内部令牌比较，
 * 以及带 ETag 的 JSON 响应。
 *
 * 这些判断与具体业务无关，独立成文件后 index.ts 只保留路由与业务编排。
 */

/**
 * trustProxy 决定 request.ip 是否采信 X-Forwarded-For。
 * - 未配置 / false：直连部署，不信任任何代理头，避免伪造 IP 绕过登录限流。
 * - true：信任所有上游（反代与容器在同一台机器时最省事）。
 * - 字符串：只信任指定地址或网段，例如 `172.16.0.0/12` 或 `127.0.0.1,172.17.0.1`。
 */
export function trustProxyOption(): boolean | string {
  const raw = process.env.APP_TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw;
}

/** 令牌比较必须走常量时间，避免通过响应耗时逐字节猜测内部令牌。 */
export function tokensMatch(given: unknown, expected: string) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 鉴权判断必须用「解码并规范化之后」的路径。
 * 路由匹配器会先对路径做百分号解码（例如 `/%61pi/subscriptions` 会命中
 * `/api/subscriptions`），如果这里仍拿原始字符串做前缀比对，就会出现
 * 「路由命中了、鉴权却被跳过」的越权访问。这里做两轮解码以覆盖双重编码，
 * 再把反斜杠与重复斜杠折叠，交给 URL 解析器消掉 `.` 与 `..` 段。
 */
export function authPath(url: string) {
  const raw = url.split('?')[0];
  try {
    let decoded = raw;
    for (let round = 0; round < 2; round += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return new URL(decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), 'http://page-watch.internal').pathname;
  } catch {
    return raw;
  }
}

type JsonReply = {
  header: (name: string, value: string) => unknown;
  code: (status: number) => { send: (value?: unknown) => unknown };
  send: (value: unknown) => unknown;
};

/** Authenticated API payloads are revalidated, never shared. The lightweight
 * ETag lets an inactive view keep its in-memory snapshot without re-downloading
 * identical task or subscription documents after it regains focus. */
export function privateJson(request: { headers: Record<string, string | string[] | undefined> }, reply: JsonReply, payload: unknown) {
  // `generatedAt` is intentionally informational. Excluding it from the
  // validator makes conditional GET useful when the underlying read model is
  // unchanged instead of defeating caching once per request.
  const cachePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== 'generatedAt'))
    : payload;
  const encoded = JSON.stringify(cachePayload);
  const etag = `"${createHash('sha1').update(encoded).digest('base64url')}"`;
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
  reply.header('Vary', 'Accept-Encoding, Cookie');
  reply.header('ETag', etag);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.send(payload);
}

const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
const loginWindowMs = 10 * 60_000;
const loginLimit = 7;
// 陌生 IP 的失败记录原本只在同一 IP 再次尝试时才清理，长期运行会只增不减。
// 定期裁剪 + 条数上限让这张表始终停留在「最近一个窗口」的量级。
const loginFailureEntryLimit = 200;

export function loginAllowed(ip: string) {
  const record = loginFailures.get(ip);
  if (!record) return true;
  if (record.lockedUntil > Date.now()) return false;
  if (Date.now() - record.firstAt > loginWindowMs) { loginFailures.delete(ip); return true; }
  return true;
}

/** 登录成功后清掉该地址的失败累计，避免历史失败继续累积到锁定阈值。 */
export function clearLoginFailures(ip: string) {
  loginFailures.delete(ip);
}

export function recordFailedLogin(ip: string) {
  const current = loginFailures.get(ip);
  const now = Date.now();
  const next = !current || now - current.firstAt > loginWindowMs ? { count: 1, firstAt: now, lockedUntil: 0 } : { ...current, count: current.count + 1 };
  if (next.count >= loginLimit) next.lockedUntil = now + loginWindowMs;
  loginFailures.set(ip, next);
  pruneLoginFailures(now);
}

/**
 * 只清理已经过了窗口且不在锁定期的记录；仍在锁定期的一律保留，
 * 否则超限裁剪会顺手把限流解除掉。
 */
export function pruneLoginFailures(now = Date.now()) {
  for (const [ip, record] of loginFailures) {
    if (record.lockedUntil > now) continue;
    if (now - record.firstAt > loginWindowMs) loginFailures.delete(ip);
  }
  if (loginFailures.size <= loginFailureEntryLimit) return;
  const removable = [...loginFailures.entries()]
    .filter(([, record]) => record.lockedUntil <= now)
    .sort((left, right) => left[1].firstAt - right[1].firstAt)
    .slice(0, loginFailures.size - loginFailureEntryLimit);
  for (const [ip] of removable) loginFailures.delete(ip);
}

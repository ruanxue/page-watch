type ErrorLike = {
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
};

type ErrorContext = {
  action: string;
  target?: string;
  proxyUrl?: string;
};

function isErrorLike(value: unknown): value is ErrorLike {
  return Boolean(value) && typeof value === 'object';
}

function safeProxyLabel(raw: string | undefined) {
  if (!raw) return '未配置';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '已配置（地址格式无效）';
  }
}

/**
 * Keeps the useful nested error from undici, Playwright and Node networking
 * failures. `fetch` normally exposes only "fetch failed" at the top level.
 */
export function describeError(error: unknown, context: ErrorContext) {
  const messages: string[] = [];
  const codes: string[] = [];
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  for (let depth = 0; depth < 8 && pending.length; depth += 1) {
    const current = pending.shift();
    if (!isErrorLike(current) || visited.has(current)) continue;
    visited.add(current);
    const message = typeof current.message === 'string' ? current.message.trim() : '';
    if (message && !messages.includes(message)) messages.push(message);
    const code = typeof current.code === 'string' ? current.code.trim() : '';
    if (code && !codes.includes(code)) codes.push(code);
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  if (!messages.length && typeof error === 'string' && error.trim()) messages.push(error.trim());
  const facts = [
    context.target ? `目标：${context.target}` : '',
    context.proxyUrl !== undefined ? `代理：${safeProxyLabel(context.proxyUrl)}` : '',
    codes.length ? `错误码：${codes.join(' → ')}` : ''
  ].filter(Boolean);
  return `${context.action}失败${facts.length ? `（${facts.join('；')}）` : ''}：${messages.join(' → ') || '未知错误'}`;
}

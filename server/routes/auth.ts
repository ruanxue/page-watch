import type { FastifyInstance } from 'fastify';
import { authenticate, clearSessionCookie, configurePassword, createSession, revokeSessions, sessionCookie, statusFor, validatePassword } from '../auth.js';
import { configureDatabase, databaseConfigurationError, databaseConfigurationSource, getJellyfinSettings, getQbittorrentSettings, getSetting, isDatabaseConfigured, setSetting } from '../db.js';
import { clearLoginFailures, loginAllowed, recordFailedLogin } from '../http-guards.js';

/**
 * 认证与首次安装：数据库连接引导、访问密码设置与登录、会话登出、集成引导状态。
 *
 * 这里是唯一能签发或吊销会话的入口；startOperationalServices 由 index 注入，
 * 因为数据库配置成功后需要拉起后台调度。
 */
export function registerAuthRoutes(app: FastifyInstance, deps: { startOperationalServices: () => void }) {
app.get('/api/setup/database', async () => ({ configured: isDatabaseConfigured(), source: databaseConfigurationSource(), error: databaseConfigurationError() }));
app.post('/api/setup/database', async (request, reply) => {
  try {
    await configureDatabase(request.body as Parameters<typeof configureDatabase>[0]);
    deps.startOperationalServices();
    return reply.code(201).send({ configured: true });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'PostgreSQL 连接或初始化失败。' });
  }
});
app.post('/api/auth/setup', async (request, reply) => {
  try {
    const password = (request.body as { password?: unknown }).password;
    validatePassword(password);
    await configurePassword(password);
    // External services are optional. Mark only brand-new installations for
    // the one-time guide; upgrades keep their established workflow intact.
    await setSetting('integration_onboarding_pending', '1');
    reply.header('Set-Cookie', sessionCookie(await createSession()));
    return reply.code(201).send({ authenticated: true });
  } catch (error) {
    return reply.code(error instanceof Error && error.message.includes('已设置') ? 409 : 400).send({ error: error instanceof Error ? error.message : '无法设置访问密码。' });
  }
});
app.post('/api/auth/login', async (request, reply) => {
  const ip = request.ip;
  if (!loginAllowed(ip)) return reply.code(429).send({ error: '登录尝试过于频繁，请 10 分钟后再试。' });
  const password = (request.body as { password?: unknown }).password;
  if (typeof password !== 'string' || !await authenticate(password)) {
    recordFailedLogin(ip);
    return reply.code(401).send({ error: '访问密码不正确。' });
  }
  clearLoginFailures(ip);
  reply.header('Set-Cookie', sessionCookie(await createSession()));
  return { authenticated: true };
});
app.post('/api/auth/logout', async (request, reply) => {
  // 递增会话版本，让这次登出同时吊销此前签发的所有 Cookie（含被窃取的那一份），
  // 而不只是清掉当前浏览器的 Cookie。仅在当前请求确实持有有效会话时才递增，
  // 否则任何人都能反复调用它把用户踢下线。
  if ((await statusFor(request.headers.cookie)).authenticated) await revokeSessions();
  reply.header('Set-Cookie', clearSessionCookie());
  return reply.code(204).send();
});

// The guide deliberately reports configuration only. It never probes external
// services: a NAS may be offline during installation and Page Watch remains
// fully usable for subscriptions, archives and rules without either service.
app.get('/api/setup/integrations', async () => {
  const jellyfin = getJellyfinSettings();
  const qbittorrent = getQbittorrentSettings();
  return {
    pending: getSetting('integration_onboarding_pending') === '1',
    jellyfin: {
      enabled: jellyfin.enabled,
      configured: Boolean(jellyfin.url && jellyfin.apiKey && jellyfin.libraryIds.length)
    },
    qbittorrent: {
      enabled: qbittorrent.enabled,
      configured: Boolean(qbittorrent.url && (qbittorrent.authMode === 'api_key' ? qbittorrent.apiKey : qbittorrent.username && qbittorrent.password))
    }
  };
});
app.post('/api/setup/integrations/complete', async () => {
  await setSetting('integration_onboarding_pending', '0');
  return { completed: true };
});
}

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getSetting, setSetting } from './db.js';

const scrypt = promisify(scryptCallback);
const passwordSettingKey = 'app_auth_password_hash';
const sessionSecretSettingKey = 'app_auth_session_secret';
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;
const passwordMinimumLength = 12;

type AuthStatus = { configured: boolean; authenticated: boolean };

function readCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return '';
  const prefix = `${name}=`;
  return cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? '';
}

async function sessionSecret() {
  const existing = getSetting(sessionSecretSettingKey);
  if (existing) return existing;
  const generated = randomBytes(32).toString('base64url');
  await setSetting(sessionSecretSettingKey, generated);
  return generated;
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function secureCookie() {
  return process.env.APP_SESSION_SECURE === 'true' ? '; Secure' : '';
}

export function sessionCookie(value: string) {
  return `page_watch_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureCookie()}`;
}

export function clearSessionCookie() {
  return `page_watch_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie()}`;
}

export async function createSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds;
  const payload = `v1.${expiresAt}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload, await sessionSecret())}`;
}

async function verifySession(value: string) {
  const [version, rawExpiresAt, nonce, signature, extra] = value.split('.');
  if (version !== 'v1' || !rawExpiresAt || !nonce || !signature || extra) return false;
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expected = sign(`${version}.${rawExpiresAt}.${nonce}`, await sessionSecret());
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return givenBuffer.length === expectedBuffer.length && timingSafeEqual(givenBuffer, expectedBuffer);
}

async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, expected, extra] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected || extra) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived);
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < passwordMinimumLength || password.length > 256) {
    throw new Error(`访问密码需为 ${passwordMinimumLength} 至 256 个字符。`);
  }
}

export async function statusFor(cookieHeader: string | undefined): Promise<AuthStatus> {
  const configured = Boolean(getSetting(passwordSettingKey));
  return { configured, authenticated: configured && await verifySession(readCookie(cookieHeader, 'page_watch_session')) };
}

export async function configurePassword(password: string) {
  validatePassword(password);
  if (getSetting(passwordSettingKey)) throw new Error('访问密码已设置，请直接登录。');
  await setSetting(passwordSettingKey, await passwordHash(password));
}

export async function authenticate(password: string) {
  const stored = getSetting(passwordSettingKey);
  return Boolean(stored) && await verifyPassword(password, stored);
}

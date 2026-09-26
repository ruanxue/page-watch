import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const encryptedPrefix = 'pwenc:';
const version1Prefix = 'pwenc:v1:';

function decodeLegacyApplicationEncryptionKey(raw: string) {
  const encoded = raw.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('APP_ENCRYPTION_KEY 必须是有效的 Base64URL 字符串。');
  let key: Buffer;
  try { key = Buffer.from(encoded, 'base64url'); }
  catch { throw new Error('APP_ENCRYPTION_KEY 必须是有效的 Base64URL 字符串。'); }
  if (key.length !== 32 || key.toString('base64url') !== encoded) throw new Error('APP_ENCRYPTION_KEY 解码后必须正好为 32 字节。');
  return key;
}

export const legacyApplicationEncryptionKeyPath = resolve(process.env.PAGE_WATCH_ENCRYPTION_KEY_PATH?.trim() || './data/app-encryption-key');

/** Reads a legacy key for the one-time migration. New deployments never create a key. */
export function readOptionalLegacyApplicationEncryptionKey(raw = process.env.APP_ENCRYPTION_KEY) {
  if (raw?.trim()) return decodeLegacyApplicationEncryptionKey(raw);
  try { return decodeLegacyApplicationEncryptionKey(readFileSync(legacyApplicationEncryptionKeyPath, 'utf8').trim()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Kept for the legacy storage tests and migration callers that require a key. */
export function readApplicationEncryptionKey(raw = process.env.APP_ENCRYPTION_KEY) {
  const key = readOptionalLegacyApplicationEncryptionKey(raw);
  if (!key) throw new Error('旧版加密配置需要原 APP_ENCRYPTION_KEY 或 data/app-encryption-key。未找到密钥，数据库中的 pwenc:v1 密文未修改。');
  return key;
}

export function isEncryptedSecret(value: string) {
  return value.startsWith(version1Prefix);
}

export function isPageWatchEncryptedValue(value: string) {
  return value.startsWith(encryptedPrefix);
}

/** Legacy decoder only. Current settings are stored and read as plaintext. */
export function decryptSecret(value: string, key: Buffer) {
  if (!isPageWatchEncryptedValue(value)) return value;
  if (!isEncryptedSecret(value)) throw new Error('不支持的加密配置版本。仅支持迁移旧版 pwenc:v1 数据。');
  const [, , encodedIv, encodedCiphertext, encodedTag, extra] = value.split(':');
  if (!encodedIv || encodedCiphertext === undefined || !encodedTag || extra) throw new Error('保存的 pwenc:v1 配置格式无效。');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('无法使用现有 APP_ENCRYPTION_KEY 解密旧版 pwenc:v1 配置。请确认使用升级前的密钥；迁移未修改数据库密文。');
  }
}

/** Kept only to preserve the old v1 format for compatibility tooling and tests. */
export function encryptSecret(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version1Prefix}${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;
}

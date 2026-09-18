import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const prefix = 'pwenc:v1:';

function decodeApplicationEncryptionKey(raw: string) {
  const encoded = raw.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('APP_ENCRYPTION_KEY 必须是有效的 Base64URL 字符串。');
  let key: Buffer;
  try { key = Buffer.from(encoded, 'base64url'); }
  catch { throw new Error('APP_ENCRYPTION_KEY 必须是有效的 Base64URL 字符串。'); }
  if (key.length !== 32 || key.toString('base64url') !== encoded) throw new Error('APP_ENCRYPTION_KEY 解码后必须正好为 32 字节。');
  return key;
}

const generatedKeyPath = resolve(process.env.PAGE_WATCH_ENCRYPTION_KEY_PATH?.trim() || './data/app-encryption-key');

function readOrCreateGeneratedKey() {
  try { return readFileSync(generatedKeyPath, 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(generatedKeyPath), { recursive: true });
  const generated = randomBytes(32).toString('base64url');
  try {
    // wx ensures two briefly overlapping startup processes never overwrite a
    // usable key. The loser reads the winner's value below.
    writeFileSync(generatedKeyPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    console.info(`APP_ENCRYPTION_KEY 未提供，已在持久目录创建本地加密密钥：${generatedKeyPath}`);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readFileSync(generatedKeyPath, 'utf8').trim();
  }
}

/**
 * Advanced deployments may keep the root key outside the data volume through
 * APP_ENCRYPTION_KEY. Personal installations can omit it: a random key is
 * then generated once inside the mounted data directory and reused on update.
 */
export function readApplicationEncryptionKey(raw = process.env.APP_ENCRYPTION_KEY) {
  return decodeApplicationEncryptionKey(raw?.trim() || readOrCreateGeneratedKey());
}

export function isEncryptedSecret(value: string) {
  return value.startsWith(prefix);
}

/** Versioned AES-256-GCM storage format. The key always remains outside MySQL. */
export function encryptSecret(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;
}

export function decryptSecret(value: string, key: Buffer) {
  if (!isEncryptedSecret(value)) return value;
  const [, , encodedIv, encodedCiphertext, encodedTag, extra] = value.split(':');
  // AES-GCM 对空字符串会产生合法的空密文段；IV 与认证标签仍必须存在。
  if (!encodedIv || encodedCiphertext === undefined || !encodedTag || extra) throw new Error('保存的敏感配置格式无效。请重新配置对应服务。');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('无法解密敏感配置。请确认 APP_ENCRYPTION_KEY 未变更；如密钥已遗失，请重新配置外部服务。');
  }
}

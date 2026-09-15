import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const prefix = 'pwenc:v1:';

export function readApplicationEncryptionKey(raw = process.env.APP_ENCRYPTION_KEY) {
  if (!raw?.trim()) throw new Error('缺少 APP_ENCRYPTION_KEY。请在部署 .env 中配置 32 字节 Base64URL 加密主密钥。');
  const encoded = raw.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('APP_ENCRYPTION_KEY 必须是有效的 Base64URL 字符串。');
  let key: Buffer;
  try { key = Buffer.from(encoded, 'base64url'); }
  catch { throw new Error('APP_ENCRYPTION_KEY 必须是有效的 Base64URL 字符串。'); }
  if (key.length !== 32 || key.toString('base64url') !== encoded) throw new Error('APP_ENCRYPTION_KEY 解码后必须正好为 32 字节。');
  return key;
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

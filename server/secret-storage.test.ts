import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSecret, encryptSecret, isEncryptedSecret, readApplicationEncryptionKey } from './secret-storage.js';

const testKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

test('encrypts and decrypts a versioned AES-GCM secret', () => {
  const ciphertext = encryptSecret('private-token', readApplicationEncryptionKey(testKey));
  assert.equal(isEncryptedSecret(ciphertext), true);
  assert.notEqual(ciphertext, 'private-token');
  assert.equal(decryptSecret(ciphertext, readApplicationEncryptionKey(testKey)), 'private-token');
});

test('encrypts and decrypts an empty secret', () => {
  const ciphertext = encryptSecret('', readApplicationEncryptionKey(testKey));
  assert.equal(isEncryptedSecret(ciphertext), true);
  assert.equal(decryptSecret(ciphertext, readApplicationEncryptionKey(testKey)), '');
});

test('rejects malformed keys and tampered ciphertext without returning a secret', () => {
  assert.throws(() => readApplicationEncryptionKey('short'), /32 字节/);
  assert.throws(() => readApplicationEncryptionKey('not a base64url key'), /Base64URL/);
  const encrypted = encryptSecret('private-token', readApplicationEncryptionKey(testKey));
  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 9)), /无法解密/);
  const parts = encrypted.split(':');
  parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
  const tampered = parts.join(':');
  assert.throws(() => decryptSecret(tampered, readApplicationEncryptionKey(testKey)), /无法解密/);
});

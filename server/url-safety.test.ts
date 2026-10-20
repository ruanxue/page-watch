import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateIp } from './url-safety.js';

test('blocks plain private and loopback IPv4 addresses', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
});

test('blocks loopback and link-local IPv6 addresses', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('[::1]'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

test('blocks IPv4-mapped IPv6 addresses that alias private IPv4', () => {
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateIp('::ffff:169.254.169.254'), true);
  // 十六进制写法：::ffff:7f00:1 等于 127.0.0.1
  assert.equal(isPrivateIp('::ffff:7f00:1'), true);
  assert.equal(isPrivateIp('0:0:0:0:0:ffff:7f00:1'), true);
  // 映射到公网地址时不应误判
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateIp('::ffff:808:808'), false);
});

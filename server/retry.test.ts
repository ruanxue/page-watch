import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableJobError, retryDelayMs } from './retry.js';

test('only retries transient failures', () => {
  assert.equal(isRetryableJobError(new Error('page.goto: Timeout 30000ms exceeded')), true);
  assert.equal(isRetryableJobError(new Error('网页返回 HTTP 403')), false);
  assert.equal(isRetryableJobError(new Error('内容匹配规则没有匹配到结果')), false);
});

test('treats a full local render queue as a transient failure', () => {
  assert.equal(isRetryableJobError(new Error('网页渲染排队已满（32 个等待中），请稍后重试。')), true);
});

test('retry backoff keeps a small bounded jitter', () => {
  const first = retryDelayMs(1);
  const second = retryDelayMs(2);
  assert.ok(first >= 30_000 && first <= 35_000);
  assert.ok(second >= 120_000 && second <= 125_000);
});

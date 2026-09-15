import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRuntimeSettings } from './runtime-settings.js';

test('defaults invalid browser runtime settings to the safe single-page profile', () => {
  assert.deepEqual(normalizeRuntimeSettings({}), { profile: 'safe', browserIdleMinutes: 10 });
  assert.deepEqual(normalizeRuntimeSettings({ profile: 'unknown' as 'safe', browserIdleMinutes: 12 as 10 }), { profile: 'safe', browserIdleMinutes: 10 });
});

test('retains the explicitly supported performance and idle settings', () => {
  assert.deepEqual(normalizeRuntimeSettings({ profile: 'performance', browserIdleMinutes: 5 }), { profile: 'performance', browserIdleMinutes: 5 });
  assert.deepEqual(normalizeRuntimeSettings({ profile: 'safe', browserIdleMinutes: 20 }), { profile: 'safe', browserIdleMinutes: 20 });
});

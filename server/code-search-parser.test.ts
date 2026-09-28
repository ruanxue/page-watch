import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMissavActressSubscriptionUrl, findMissavFilmCandidate, normalizeMissavActressIdentity, normalizeProductCode, productCodeKey, productCodeKeys, productCodeSearchPatterns, safeMissavDetailUrl } from './code-search-parser.js';

test('normalizes separated and compact product codes', () => {
  assert.equal(normalizeProductCode(' MEYD-568 '), 'MEYD-568');
  assert.equal(normalizeProductCode('meyd568'), 'MEYD-568');
  assert.equal(normalizeProductCode('ssis_270'), 'SSIS-270');
  assert.equal(normalizeProductCode('bad code'), null);
  assert.equal(productCodeKey('MEYD-568'), 'meyd-568');
  assert.deepEqual(productCodeKeys('meyd-568-uncensored-leak'), ['meyd-568']);
  assert.deepEqual(productCodeKeys('A different title mentions MEYD568.'), ['meyd-568']);
  assert.deepEqual(productCodeSearchPatterns('meyd568'), ['%meyd-568%', '%meyd_568%', '%meyd 568%', '%meyd568%']);
});

test('selects a result only when its code exactly matches, even when it is not first', () => {
  const anchors = [
    { href: '/cn/ure-140-uncensored-leak#search', alt: 'ure-140-uncensored-leak', text: 'URE-140 奈奈美蒂娜首次与原创作品合作' },
    { href: '/cn/meyd-568-sample#search', alt: 'meyd-568-sample', text: 'MEYD-568 七海蒂娜作品' }
  ];
  assert.deepEqual(findMissavFilmCandidate(anchors, 'meyd568', 'https://missav123.com/cn/search/meyd568'), {
    code: 'MEYD-568', title: '七海蒂娜作品', detailUrl: 'https://missav123.com/cn/meyd-568-sample'
  });
  assert.equal(findMissavFilmCandidate(anchors, 'MEYD-56', 'https://missav123.com/cn/search/meyd56'), null);
});

test('accepts MissAV detail links with a dm route while rejecting other destinations', () => {
  const base = 'https://missav123.com/cn/search/fjin073';
  const anchors = [
    { href: 'https://missav123.com/dm11/cn/fjin-073-uncensored-leak', alt: 'fjin-073-uncensored-leak', text: '' },
    { href: 'https://missav123.com/dm11/cn/fjin-073-uncensored-leak', alt: 'fjin-073-uncensored-leak', text: 'FJIN-073 与不爱交际的邻家大屁股女孩水川淳进行一周的完全勃起挤奶性爱 - 水川润' },
    { href: 'https://missav123.com/dm14/cn/fjin-073', alt: 'fjin-073', text: 'FJIN-073 另一版本' }
  ];
  assert.deepEqual(findMissavFilmCandidate(anchors, 'FJIN-073', base), {
    code: 'FJIN-073',
    title: '与不爱交际的邻家大屁股女孩水川淳进行一周的完全勃起挤奶性爱 - 水川润',
    detailUrl: 'https://missav123.com/dm11/cn/fjin-073-uncensored-leak'
  });
  assert.equal(safeMissavDetailUrl('https://evil.example/dm11/cn/fjin-073', base), null);
  assert.equal(safeMissavDetailUrl('https://missav123.com/dm11/cn/search/fjin073', base), null);
});

test('uses the actress profile identity and adds the individual filter', () => {
  const href = 'https://missav123.com/dm34/cn/actresses/%E4%B8%83%E6%B5%B7%E8%92%82%E5%A8%9C';
  assert.equal(normalizeMissavActressIdentity(href), '七海蒂娜');
  assert.equal(buildMissavActressSubscriptionUrl(href), `${href}?filters=individual`);
  assert.equal(normalizeMissavActressIdentity('https://example.com/cn/actresses/test'), null);
});

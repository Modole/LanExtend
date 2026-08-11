'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RELEASE_PAGE_URL,
  compareVersions,
  isAllowedReleaseUrl,
  parseReleasePageUrl,
  parseReleasePayload,
  parseVersion
} = require('../src/core/updates');

test('semantic release versions compare numerically', () => {
  assert.deepEqual(parseVersion('v0.2.0'), [0, 2, 0]);
  assert.equal(compareVersions('0.10.0', '0.2.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.throws(() => parseVersion('1.0'), /版本号/);
});

test('release payload reports updates and rejects untrusted release URLs', () => {
  const available = parseReleasePayload({
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/Modole/LanExtend/releases/tag/v0.2.0',
    draft: false,
    prerelease: false,
    published_at: '2026-08-11T00:00:00Z'
  }, '0.1.0');
  assert.equal(available.updateAvailable, true);
  assert.equal(available.latestVersion, '0.2.0');
  assert.equal(available.releaseUrl.endsWith('/tag/v0.2.0'), true);

  const fallback = parseReleasePayload({
    tag_name: 'v0.2.0',
    html_url: 'https://example.com/download',
    draft: false,
    prerelease: false
  }, '0.2.0');
  assert.equal(fallback.updateAvailable, false);
  assert.equal(fallback.releaseUrl, RELEASE_PAGE_URL);
});

test('only this repository release URLs are accepted', () => {
  assert.equal(isAllowedReleaseUrl('https://github.com/Modole/LanExtend/releases/latest'), true);
  assert.equal(isAllowedReleaseUrl('https://github.com/Modole/LanExtend/releases/tag/v1.0.0'), true);
  assert.equal(isAllowedReleaseUrl('https://github.com/other/repo/releases/tag/v1.0.0'), false);
  assert.equal(isAllowedReleaseUrl('http://github.com/Modole/LanExtend/releases/latest'), false);
});

test('release page redirect safely provides a fallback version', () => {
  const info = parseReleasePageUrl(
    'https://github.com/Modole/LanExtend/releases/tag/v0.2.0',
    '0.1.0'
  );
  assert.equal(info.latestVersion, '0.2.0');
  assert.equal(info.updateAvailable, true);
  assert.throws(
    () => parseReleasePageUrl('https://github.com/other/repo/releases/tag/v9.0.0', '0.2.0'),
    /地址无效/
  );
  assert.throws(
    () => parseReleasePageUrl('https://github.com/Modole/LanExtend/releases/latest', '0.2.0'),
    /稳定版本号/
  );
});

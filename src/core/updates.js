'use strict';

const GITHUB_REPOSITORY = 'Modole/LanExtend';
const RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const RELEASE_PAGE_URL = `https://github.com/${GITHUB_REPOSITORY}/releases/latest`;
const MAX_RELEASE_RESPONSE_BYTES = 256 * 1024;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error('版本号格式无效');
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function isAllowedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && !url.port
      && !url.username
      && !url.password
      && url.pathname.startsWith(`/${GITHUB_REPOSITORY}/releases/`);
  } catch {
    return false;
  }
}

function parseReleasePayload(payload, currentVersion) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub 返回的版本信息无效');
  }
  if (payload.draft === true || payload.prerelease === true) {
    throw new Error('最新版本不是稳定公开版本');
  }
  const latestVersion = String(payload.tag_name || '').replace(/^v/, '');
  parseVersion(currentVersion);
  parseVersion(latestVersion);
  const releaseUrl = isAllowedReleaseUrl(payload.html_url)
    ? payload.html_url
    : RELEASE_PAGE_URL;
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl,
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : null
  };
}

function parseReleasePageUrl(value, currentVersion) {
  if (!isAllowedReleaseUrl(value)) throw new Error('GitHub 发布页地址无效');
  const url = new URL(value);
  const match = url.pathname.match(/^\/Modole\/LanExtend\/releases\/tag\/v?(\d+\.\d+\.\d+)\/?$/);
  if (!match) throw new Error('GitHub 发布页不包含稳定版本号');
  const latestVersion = match[1];
  parseVersion(currentVersion);
  parseVersion(latestVersion);
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl: url.toString(),
    publishedAt: null
  };
}

module.exports = {
  GITHUB_REPOSITORY,
  MAX_RELEASE_RESPONSE_BYTES,
  RELEASE_API_URL,
  RELEASE_PAGE_URL,
  compareVersions,
  isAllowedReleaseUrl,
  parseReleasePageUrl,
  parseReleasePayload,
  parseVersion
};

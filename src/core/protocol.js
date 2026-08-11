'use strict';

const net = require('node:net');
const { MAX_BEACON_BYTES, MAX_SIGNAL_BYTES, PROTOCOL_VERSION } = require('./constants');

const MAX_DISCONNECT_REASON_BYTES = 120;

const SIGNAL_TYPES = new Set([
  'hello',
  'offer',
  'answer',
  'ice',
  'disconnect',
  'ping',
  'pong'
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isPrivateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function sanitizeName(value, fallback = 'LanExtend') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return cleaned || fallback;
}

function parseJson(raw, maxBytes) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('消息超过大小限制');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('消息不是有效 JSON');
  }
  if (!isPlainObject(parsed)) throw new Error('消息结构无效');
  return parsed;
}

function parseSignalMessage(raw) {
  const message = parseJson(raw, MAX_SIGNAL_BYTES);
  if (!SIGNAL_TYPES.has(message.type)) throw new Error('不支持的信令类型');
  if (message.protocol !== PROTOCOL_VERSION) throw new Error('协议版本不兼容');

  if (message.type === 'hello') {
    if (!isNonEmptyString(message.hostId) || !isNonEmptyString(message.name, 64)) {
      throw new Error('hello 消息缺少主端信息');
    }
  }

  if (message.type === 'offer' || message.type === 'answer') {
    if (!isPlainObject(message.sdp)
      || message.sdp.type !== message.type
      || !isNonEmptyString(message.sdp.sdp, 220_000)) {
      throw new Error('SDP 消息无效');
    }
  }

  if (message.type === 'ice' && message.candidate !== null) {
    if (!isPlainObject(message.candidate)
      || !isNonEmptyString(message.candidate.candidate, 8_192)) {
      throw new Error('ICE candidate 无效');
    }
  }

  if ((message.type === 'ping' || message.type === 'pong')
    && (!Number.isFinite(message.timestamp) || message.timestamp < 0)) {
    throw new Error('心跳消息无效');
  }

  if (message.type === 'disconnect' && message.reason !== undefined
    && (typeof message.reason !== 'string'
      || Buffer.byteLength(message.reason, 'utf8') > MAX_DISCONNECT_REASON_BYTES)) {
    throw new Error('断开原因无效');
  }

  return message;
}

function makeSignal(type, payload = {}) {
  if (!SIGNAL_TYPES.has(type)) throw new Error(`未知信令类型: ${type}`);
  return { type, protocol: PROTOCOL_VERSION, ...payload };
}

function truncateUtf8(value, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes 必须是非负整数');
  const parts = [];
  let used = 0;
  for (const character of String(value)) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    parts.push(character);
    used += size;
  }
  return parts.join('');
}

function makeBeacon(receiver) {
  return {
    type: 'lanextend.receiver',
    protocol: PROTOCOL_VERSION,
    id: receiver.id,
    name: sanitizeName(receiver.name, 'Windows 子端'),
    port: receiver.port,
    platform: 'win32',
    authMode: 'none',
    capabilities: ['video', 'fullscreen']
  };
}

function parseBeacon(raw, remoteAddress) {
  const beacon = parseJson(raw, MAX_BEACON_BYTES);
  if (beacon.type !== 'lanextend.receiver' || beacon.protocol !== PROTOCOL_VERSION) {
    throw new Error('不是兼容的 LanExtend 广播');
  }
  if (!isNonEmptyString(beacon.id, 128)
    || !isNonEmptyString(beacon.name, 64)
    || !isValidPort(beacon.port)) {
    throw new Error('广播内容无效');
  }
  if (remoteAddress && !isPrivateIPv4(remoteAddress)) {
    throw new Error('来源地址不在受支持的内网范围');
  }
  return {
    id: beacon.id,
    name: sanitizeName(beacon.name, 'Windows 子端'),
    host: remoteAddress,
    port: beacon.port,
    platform: beacon.platform === 'win32' ? 'win32' : 'unknown',
    capabilities: Array.isArray(beacon.capabilities)
      ? beacon.capabilities.filter((item) => typeof item === 'string').slice(0, 8)
      : [],
    authMode: 'none',
    online: true,
    discoveredAt: Date.now()
  };
}

module.exports = {
  MAX_DISCONNECT_REASON_BYTES,
  isPlainObject,
  isPrivateIPv4,
  isValidPort,
  makeBeacon,
  makeSignal,
  parseBeacon,
  parseSignalMessage,
  sanitizeName,
  truncateUtf8
};

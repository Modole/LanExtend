'use strict';

const net = require('node:net');
const {
  MAX_BEACON_BYTES,
  MAX_FILE_ENTRIES,
  MAX_FILE_TRANSFER_BYTES,
  MAX_SIGNAL_BYTES,
  PROTOCOL_VERSION
} = require('./constants');

const MAX_DISCONNECT_REASON_BYTES = 120;

const SIGNAL_TYPES = new Set([
  'hello',
  'offer',
  'answer',
  'ice',
  'disconnect',
  'ping',
  'pong',
  'control',
  'input',
  'clipboard',
  'file-offer',
  'file-status'
]);

const CONTROL_ACTIONS = new Set([
  'share-start',
  'share-ready',
  'share-stop',
  'active',
  'inactive',
  'error'
]);

const INPUT_KINDS = new Set(['pointer', 'button', 'wheel', 'key', 'releaseAll']);
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle', 'other']);
const MAX_CLIPBOARD_BYTES = 128 * 1024;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isPortableFileName(value) {
  return isNonEmptyString(value, 180)
    && value !== '.' && value !== '..'
    && !/[\u0000-\u001f<>:"/\\|?*]/.test(value)
    && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
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

  if (message.type === 'control') {
    if (!CONTROL_ACTIONS.has(message.action)) throw new Error('控制消息无效');
    if (message.clipboard !== undefined && typeof message.clipboard !== 'boolean') {
      throw new Error('控制消息的剪贴板设置无效');
    }
    if (message.files !== undefined && typeof message.files !== 'boolean') {
      throw new Error('控制消息的文件剪贴板设置无效');
    }
    if (message.screen !== undefined) {
      if (!isPlainObject(message.screen)
        || !Number.isInteger(message.screen.width)
        || !Number.isInteger(message.screen.height)
        || message.screen.width < 320 || message.screen.width > 7680
        || message.screen.height < 240 || message.screen.height > 4320) {
        throw new Error('控制消息的屏幕信息无效');
      }
    }
    if (message.message !== undefined && !isNonEmptyString(message.message, 512)) {
      throw new Error('控制消息的说明无效');
    }
  }

  if (message.type === 'input') {
    const event = message.event;
    if (!isPlainObject(event) || !INPUT_KINDS.has(event.kind)) throw new Error('输入事件无效');
    if (event.kind === 'pointer'
      && (!Number.isInteger(event.x) || !Number.isInteger(event.y)
        || event.x < -32_768 || event.x > 32_768 || event.y < -32_768 || event.y > 32_768)) {
      throw new Error('鼠标坐标无效');
    }
    if (event.kind === 'button'
      && (!MOUSE_BUTTONS.has(event.button) || typeof event.down !== 'boolean')) {
      throw new Error('鼠标按键事件无效');
    }
    if (event.kind === 'wheel'
      && (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)
        || Math.abs(event.deltaX) > 1000 || Math.abs(event.deltaY) > 1000)) {
      throw new Error('滚轮事件无效');
    }
    if (event.kind === 'key'
      && (!Number.isInteger(event.vk) || event.vk < 0 || event.vk > 255
        || typeof event.down !== 'boolean')) {
      throw new Error('键盘事件无效');
    }
  }

  if (message.type === 'clipboard') {
    if (typeof message.text !== 'string'
      || Buffer.byteLength(message.text, 'utf8') > MAX_CLIPBOARD_BYTES
      || !isNonEmptyString(message.revision, 160)) {
      throw new Error('剪贴板消息无效');
    }
  }

  if (message.type === 'file-offer') {
    const transfer = message.transfer;
    if (!isPlainObject(transfer)
      || !isNonEmptyString(transfer.id, 64)
      || !/^[0-9a-f-]{36}$/.test(transfer.id)
      || !isValidPort(transfer.port)
      || !Number.isInteger(transfer.itemCount)
      || transfer.itemCount < 1 || transfer.itemCount > MAX_FILE_ENTRIES
      || !Number.isSafeInteger(transfer.totalBytes)
      || transfer.totalBytes < 0 || transfer.totalBytes > MAX_FILE_TRANSFER_BYTES
      || !Array.isArray(transfer.names) || transfer.names.length < 1 || transfer.names.length > 16
      || transfer.names.some((name) => !isPortableFileName(name))
      || !Number.isSafeInteger(transfer.expiresAt) || transfer.expiresAt < 0) {
      throw new Error('文件传输清单无效');
    }
    if (transfer.warnings !== undefined
      && (!Array.isArray(transfer.warnings)
        || transfer.warnings.length > 8
        || transfer.warnings.some((warning) => !isNonEmptyString(warning, 240)))) {
      throw new Error('文件传输提示无效');
    }
  }

  if (message.type === 'file-status') {
    if (!isNonEmptyString(message.transferId, 64)
      || !/^[0-9a-f-]{36}$/.test(message.transferId)
      || !['receiving', 'completed', 'canceled', 'error'].includes(message.status)
      || (message.bytes !== undefined
        && (!Number.isSafeInteger(message.bytes) || message.bytes < 0 || message.bytes > MAX_FILE_TRANSFER_BYTES))
      || (message.totalBytes !== undefined
        && (!Number.isSafeInteger(message.totalBytes)
          || message.totalBytes < 0 || message.totalBytes > MAX_FILE_TRANSFER_BYTES))
      || (message.message !== undefined && !isNonEmptyString(message.message, 512))) {
      throw new Error('文件传输状态无效');
    }
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
    capabilities: ['video', 'fullscreen', 'input', 'clipboard', 'files'],
    display: receiver.display
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
    display: isPlainObject(beacon.display)
      && Number.isInteger(beacon.display.width)
      && Number.isInteger(beacon.display.height)
      ? {
          width: Math.max(320, Math.min(7680, beacon.display.width)),
          height: Math.max(240, Math.min(4320, beacon.display.height)),
          scaleFactor: Number.isFinite(beacon.display.scaleFactor) ? beacon.display.scaleFactor : 1
        }
      : null,
    online: true,
    discoveredAt: Date.now()
  };
}

module.exports = {
  CONTROL_ACTIONS,
  INPUT_KINDS,
  MAX_CLIPBOARD_BYTES,
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

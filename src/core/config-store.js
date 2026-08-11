'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, SIGNAL_PORT } = require('./constants');
const { isPrivateIPv4, isValidPort, sanitizeName } = require('./protocol');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function defaultState() {
  const state = clone(DEFAULTS);
  state.receiver.id = crypto.randomUUID();
  state.receiver.name = sanitizeName(os.hostname(), 'Windows 子端');
  return state;
}

function sanitizeHost(input = {}, previous = DEFAULTS.host) {
  return {
    width: clampInteger(input.width, 800, 7680, previous.width),
    height: clampInteger(input.height, 600, 4320, previous.height),
    fps: clampInteger(input.fps, 15, 60, previous.fps),
    bitrateMbps: clampInteger(input.bitrateMbps, 2, 80, previous.bitrateMbps),
    hiDPI: typeof input.hiDPI === 'boolean' ? input.hiDPI : previous.hiDPI,
    autoReconnect: typeof input.autoReconnect === 'boolean'
      ? input.autoReconnect
      : previous.autoReconnect,
    lastDeviceId: typeof input.lastDeviceId === 'string'
      ? input.lastDeviceId.slice(0, 128)
      : input.lastDeviceId === null ? null : previous.lastDeviceId,
    lastSourceId: typeof input.lastSourceId === 'string'
      ? input.lastSourceId.slice(0, 256)
      : input.lastSourceId === null ? null : previous.lastSourceId
  };
}

function sanitizeReceiver(input = {}, previous = DEFAULTS.receiver) {
  return {
    id: typeof input.id === 'string' && input.id.length <= 128 ? input.id : previous.id,
    name: sanitizeName(input.name, previous.name || 'Windows 子端'),
    port: isValidPort(input.port) ? input.port : previous.port || SIGNAL_PORT,
    autoFullscreen: typeof input.autoFullscreen === 'boolean'
      ? input.autoFullscreen
      : previous.autoFullscreen
  };
}

function sanitizeDevice(input) {
  if (!input || typeof input !== 'object') return null;
  const host = typeof input.host === 'string' ? input.host : '';
  if (!input.id || !isValidPort(input.port) || !isPrivateIPv4(host)) return null;
  return {
    id: String(input.id).slice(0, 128),
    name: sanitizeName(input.name, 'Windows 子端'),
    host,
    port: input.port,
    lastSeen: Number.isFinite(input.lastSeen) ? input.lastSeen : Date.now(),
    lastConnected: Number.isFinite(input.lastConnected) ? input.lastConnected : null
  };
}

class ConfigStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, options.filename || 'settings.json');
    this.state = this.#load();
    // Persist immediately so the receiver UUID is stable even when the user
    // never changes a setting during the first run. This also rewrites a
    // malformed file with a validated default state.
    this.#persist();
  }

  #load() {
    const fallback = defaultState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const state = {
        schemaVersion: 1,
        host: sanitizeHost(parsed.host, fallback.host),
        receiver: sanitizeReceiver(parsed.receiver, fallback.receiver),
        rememberedDevices: Array.isArray(parsed.rememberedDevices)
          ? parsed.rememberedDevices.map(sanitizeDevice).filter(Boolean).slice(0, 32)
          : []
      };
      if (!state.receiver.id) state.receiver.id = fallback.receiver.id;
      return state;
    } catch {
      return fallback;
    }
  }

  get() {
    return clone(this.state);
  }

  updateSettings(patch = {}) {
    if (patch.host) this.state.host = sanitizeHost(patch.host, this.state.host);
    if (patch.receiver) {
      const next = sanitizeReceiver(patch.receiver, this.state.receiver);
      next.id = this.state.receiver.id;
      this.state.receiver = next;
    }
    this.#persist();
    return this.get();
  }

  rememberDevice(device, connected = false) {
    const sanitized = sanitizeDevice({
      ...device,
      lastSeen: Date.now(),
      lastConnected: connected ? Date.now() : device.lastConnected
    });
    if (!sanitized) throw new Error('设备地址必须是有效的私有 IPv4 地址');
    const index = this.state.rememberedDevices.findIndex((item) => item.id === sanitized.id);
    if (index >= 0) {
      const previous = this.state.rememberedDevices[index];
      sanitized.lastConnected = connected ? sanitized.lastConnected : previous.lastConnected;
      this.state.rememberedDevices[index] = sanitized;
    } else {
      this.state.rememberedDevices.unshift(sanitized);
    }
    this.state.rememberedDevices = this.state.rememberedDevices
      .sort((a, b) => (b.lastConnected || b.lastSeen) - (a.lastConnected || a.lastSeen))
      .slice(0, 32);
    if (connected) this.state.host.lastDeviceId = sanitized.id;
    this.#persist();
    return sanitized;
  }

  forgetDevice(id) {
    this.state.rememberedDevices = this.state.rememberedDevices.filter((item) => item.id !== id);
    if (this.state.host.lastDeviceId === id) this.state.host.lastDeviceId = null;
    this.#persist();
    return this.get();
  }

  #persist() {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = {
  ConfigStore,
  defaultState,
  sanitizeDevice,
  sanitizeHost,
  sanitizeReceiver
};

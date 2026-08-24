'use strict';

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const {
  DISCOVERY_PORT,
  MAX_SIGNAL_BYTES,
  PROTOCOL_VERSION,
  SIGNAL_PORT
} = require('./constants');
const {
  isPrivateIPv4,
  makeBeacon,
  parseBeacon,
  parseSignalMessage,
  truncateUtf8
} = require('./protocol');

function ipv4ToInt(address) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function broadcastAddresses() {
  const addresses = new Set(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.netmask) continue;
      const ip = ipv4ToInt(entry.address);
      const mask = ipv4ToInt(entry.netmask);
      addresses.add(intToIpv4((ip | (~mask >>> 0)) >>> 0));
    }
  }
  return [...addresses];
}

class DiscoveryAdvertiser extends EventEmitter {
  constructor(receiver, options = {}) {
    super();
    this.receiver = receiver;
    this.port = options.port ?? DISCOVERY_PORT;
    this.intervalMs = options.intervalMs ?? 1_500;
    this.socket = null;
    this.timer = null;
  }

  async start() {
    if (this.socket) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (error) => this.emit('error', error));
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        this.socket.once('error', onError);
        this.socket.bind(0, '0.0.0.0', () => {
          this.socket.off('error', onError);
          this.socket.setBroadcast(true);
          resolve();
        });
      });
    } catch (error) {
      this.socket?.close();
      this.socket = null;
      throw error;
    }
    this.#send();
    this.timer = setInterval(() => this.#send(), this.intervalMs);
    this.timer.unref?.();
  }

  #send() {
    if (!this.socket) return;
    const payload = Buffer.from(JSON.stringify(makeBeacon(this.receiver)));
    for (const address of broadcastAddresses()) {
      this.socket.send(payload, this.port, address, (error) => {
        if (error) this.emit('warning', error);
      });
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }
}

class DiscoveryListener extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port ?? DISCOVERY_PORT;
    this.staleMs = options.staleMs ?? 6_000;
    this.socket = null;
    this.devices = new Map();
    this.pruneTimer = null;
  }

  async start() {
    if (this.socket) return;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (raw, remote) => {
      try {
        const device = parseBeacon(raw, remote.address);
        const previous = this.devices.get(device.id);
        this.devices.set(device.id, { ...previous, ...device });
        this.emit('device', this.devices.get(device.id));
        this.emit('changed', this.list());
      } catch (error) {
        this.emit('warning', error);
      }
    });
    this.socket.on('error', (error) => this.emit('error', error));
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        this.socket.once('error', onError);
        this.socket.bind(this.port, '0.0.0.0', () => {
          this.socket.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.socket?.close();
      this.socket = null;
      throw error;
    }
    this.pruneTimer = setInterval(() => this.#prune(), 2_000);
    this.pruneTimer.unref?.();
  }

  #prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.devices) {
      if (now - device.discoveredAt > this.staleMs) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('changed', this.list());
  }

  list() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  stop() {
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.socket?.close();
    this.socket = null;
    this.devices.clear();
  }
}

class SignalServer extends EventEmitter {
  constructor(receiver, options = {}) {
    super();
    this.receiver = receiver;
    this.host = options.host || '0.0.0.0';
    this.port = options.port ?? receiver.port ?? SIGNAL_PORT;
    this.server = null;
    this.sessions = new Map();
  }

  async start() {
    if (this.server) return;
    this.server = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: MAX_SIGNAL_BYTES,
      perMessageDeflate: false
    });
    this.server.on('connection', (socket, request) => this.#accept(socket, request));
    this.server.on('error', (error) => this.emit('error', error));
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        this.server.once('error', onError);
        this.server.once('listening', () => {
          this.server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      const failedServer = this.server;
      this.server = null;
      failedServer?.close();
      throw error;
    }
  }

  #accept(socket, request) {
    const origin = request.headers.origin;
    if (origin && origin !== 'file://' && origin !== 'null') {
      socket.close(1008, '不允许网页来源连接');
      return;
    }
    const rawAddress = request.socket.remoteAddress || '';
    const remoteAddress = rawAddress.startsWith('::ffff:') ? rawAddress.slice(7) : rawAddress;
    if (!isPrivateIPv4(remoteAddress)) {
      socket.close(1008, '仅允许私有局域网地址');
      return;
    }
    if ([...this.sessions.values()].some((session) => session.socket.readyState === 1)) {
      socket.close(1013, '子端当前正在使用');
      return;
    }
    const id = crypto.randomUUID();
    const session = {
      id,
      socket,
      remoteAddress,
      connectedAt: Date.now(),
      helloReceived: false,
      activityTimer: null
    };
    this.sessions.set(id, session);
    socket.send(JSON.stringify({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      receiver: {
        id: this.receiver.id,
        name: this.receiver.name,
        port: this.port,
        authMode: 'none',
        capabilities: this.receiver.capabilities || ['video', 'fullscreen', 'input', 'clipboard', 'files'],
        display: this.receiver.display || null
      },
      transportSecurity: 'none'
    }));
    this.emit('connected', {
      id: session.id,
      remoteAddress: session.remoteAddress,
      connectedAt: session.connectedAt
    });

    const refreshActivityTimeout = (milliseconds) => {
      clearTimeout(session.activityTimer);
      session.activityTimer = setTimeout(() => {
        socket.close(1008, session.helloReceived ? '会话心跳超时' : '等待 hello 超时');
      }, milliseconds);
      session.activityTimer.unref?.();
    };
    refreshActivityTimeout(10_000);

    socket.on('message', (raw) => {
      try {
        const message = parseSignalMessage(raw);
        if (!session.helloReceived) {
          if (message.type !== 'hello') {
            socket.close(1008, '第一条信令必须是 hello');
            return;
          }
          session.helloReceived = true;
        } else if (message.type === 'hello') {
          socket.close(1008, 'hello 只能发送一次');
          return;
        }
        refreshActivityTimeout(20_000);
        this.emit('message', { sessionId: id, remoteAddress, message });
      } catch (error) {
        this.emit('warning', error);
        socket.close(1008, '信令格式无效');
      }
    });
    socket.on('close', (code, reason) => {
      clearTimeout(session.activityTimer);
      this.sessions.delete(id);
      this.emit('disconnected', { sessionId: id, code, reason: reason.toString() });
    });
    socket.on('error', (error) => this.emit('warning', error));
  }

  send(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session || session.socket.readyState !== 1) return false;
    const normalized = parseSignalMessage(JSON.stringify(message));
    session.socket.send(JSON.stringify(normalized));
    return true;
  }

  disconnect(sessionId, reason = '由子端断开') {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.socket.close(1000, truncateUtf8(reason, 123));
    return true;
  }

  async stop() {
    if (!this.server) return;
    for (const session of this.sessions.values()) session.socket.terminate();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = {
  DiscoveryAdvertiser,
  DiscoveryListener,
  SignalServer,
  broadcastAddresses,
  intToIpv4,
  ipv4ToInt
};

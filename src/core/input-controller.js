'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { InputLayoutRouter, findEntry, hasAdjacentEdge } = require('./input-layout');

const CLIPBOARD_MAX_BYTES = 128 * 1024;

const MAC_KEY_TO_WINDOWS_VK = new Map([
  [0, 0x41], [1, 0x53], [2, 0x44], [3, 0x46], [4, 0x48], [5, 0x47], [6, 0x5A],
  [7, 0x58], [8, 0x43], [9, 0x56], [11, 0x42], [12, 0x51], [13, 0x57], [14, 0x45],
  [15, 0x52], [16, 0x59], [17, 0x54], [18, 0x31], [19, 0x32], [20, 0x33], [21, 0x34],
  [22, 0x36], [23, 0x35], [24, 0xBB], [25, 0x39], [26, 0x37], [27, 0xBD], [28, 0x38],
  [29, 0x30], [30, 0xDD], [31, 0x4F], [32, 0x55], [33, 0xDB], [34, 0x49], [35, 0x50],
  [36, 0x0D], [37, 0x4C], [38, 0x4A], [39, 0xDE], [40, 0x4B], [41, 0xBA], [42, 0xDC],
  [43, 0xBC], [44, 0xBF], [45, 0x4E], [46, 0x4D], [47, 0xBE], [48, 0x09], [49, 0x20],
  [50, 0xC0], [51, 0x08], [53, 0x1B],
  // 在 Windows 上保留 Mac 的常用操作习惯：Command -> Ctrl，Option -> Alt，Control -> Win。
  [54, 0xA3], [55, 0xA2], [56, 0xA0], [57, 0x14], [58, 0xA4], [59, 0x5B],
  [60, 0xA1], [61, 0xA5], [62, 0x5C],
  [65, 0x6E], [67, 0x6A], [69, 0x6B], [71, 0x0C], [75, 0x6F], [76, 0x0D],
  [78, 0x6D], [81, 0x6A], [82, 0x60], [83, 0x61], [84, 0x62], [85, 0x63], [86, 0x64],
  [87, 0x65], [88, 0x66], [89, 0x67], [91, 0x68], [92, 0x69],
  [96, 0x74], [97, 0x75], [98, 0x76], [99, 0x72], [100, 0x77], [101, 0x78],
  [103, 0x7A], [105, 0x7C], [107, 0x7D], [109, 0x79], [111, 0x7B],
  [114, 0x2D], [115, 0x24], [116, 0x21], [117, 0x2E], [118, 0x73], [119, 0x23],
  [120, 0x71], [121, 0x22], [122, 0x70], [123, 0x25], [124, 0x27], [125, 0x28], [126, 0x26]
]);

function macKeyCodeToWindowsVk(keyCode) {
  return MAC_KEY_TO_WINDOWS_VK.get(Number(keyCode)) ?? null;
}

class JsonLineProcess extends EventEmitter {
  constructor(command, args, options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.child = null;
    this.buffer = '';
    this.stderrBuffer = '';
    this.shutdownTimer = null;
    this.pendingRequests = new Map();
  }

  async start(timeoutMs = 5000) {
    if (this.child) return;
    this.stderrBuffer = '';
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-4096);
      const warning = text.trim();
      if (warning) this.emit('warning', warning);
    });
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      this.#rejectPending(this.#exitError('输入助手已退出', code, signal));
      if (this.child === child) this.child = null;
      this.emit('exit', { code, signal });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('输入助手启动超时')), timeoutMs);
      const ready = (message) => {
        if (message?.event !== 'ready') return;
        clearTimeout(timer);
        this.off('message', ready);
        if (message.trusted === false) reject(new Error('macOS 尚未授予辅助功能权限'));
        else resolve(message);
      };
      this.on('message', ready);
      child.once('error', (error) => {
        clearTimeout(timer);
        this.off('message', ready);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.off('message', ready);
        reject(this.#exitError('输入助手提前退出', code, signal));
      });
    });
  }

  #exitError(prefix, code, signal) {
    const marker = code ?? signal ?? 'unknown';
    const detail = this.stderrBuffer.trim().replace(/\s+/g, ' ').slice(0, 600);
    return new Error(`${prefix} (${marker})${detail ? `：${detail}` : ''}`);
  }

  #consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const pending = typeof message?.requestId === 'string'
          ? this.pendingRequests.get(message.requestId)
          : null;
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(message.requestId);
          if (message.ok === false) pending.reject(new Error(message.error || '输入助手请求失败'));
          else pending.resolve(message);
          continue;
        }
        this.emit('message', message);
      } catch {
        this.emit('warning', `输入助手返回了无法识别的内容：${line.slice(0, 160)}`);
      }
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  request(command, payload = {}, timeoutMs = 4000) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('输入助手尚未运行'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`输入助手请求超时：${command}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      if (!this.send({ command, requestId, ...payload })) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new Error('无法写入输入助手'));
      }
    });
  }

  #rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.send({ command: 'quit' });
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = setTimeout(() => {
      if (this.child === child) child.kill('SIGTERM');
    }, 800);
    this.shutdownTimer.unref?.();
  }
}

class MacInputController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.executable = options.executable;
    this.platform = options.platform || process.platform;
    this.process = null;
    this.router = null;
    this.running = false;
    this.active = false;
    this.ignoreEntryUntil = 0;
    this.edgeDelayMs = 0;
    this.entryCandidate = null;
    this.pendingPointer = null;
    this.pointerTimer = null;
  }

  get supported() {
    return this.platform === 'darwin' && Boolean(this.executable) && fs.existsSync(this.executable);
  }

  status() {
    return { supported: this.supported, running: this.running, active: this.active };
  }

  async start(layout) {
    if (!this.supported) throw new Error('macOS 键鼠捕获助手不可用，请先构建原生组件');
    this.router = new InputLayoutRouter(layout);
    if (!hasAdjacentEdge(this.router.locals, this.router.remote)) {
      this.router = null;
      throw new Error('Windows 布局必须与至少一台 Mac 显示器共享一段边缘');
    }
    this.edgeDelayMs = Math.max(0, Math.min(1000, Number(layout?.edgeDelayMs) || 0));
    this.entryCandidate = null;
    if (!this.process) {
      const processWrapper = new JsonLineProcess(this.executable, []);
      this.process = processWrapper;
      processWrapper.on('message', (message) => this.#handle(message));
      processWrapper.on('warning', (message) => this.emit('warning', message));
      processWrapper.on('error', (error) => this.emit('error', error));
      processWrapper.on('exit', () => {
        if (this.process === processWrapper) this.process = null;
        const wasRunning = this.running;
        this.running = false;
        this.active = false;
        if (wasRunning) this.emit('status', this.status());
      });
      try {
        await processWrapper.start();
      } catch (error) {
        processWrapper.stop();
        if (this.process === processWrapper) this.process = null;
        throw error;
      }
    }
    this.running = true;
    this.active = false;
    this.process.send({ command: 'deactivate' });
    this.emit('status', this.status());
    return this.status();
  }

  #handle(message) {
    if (!this.running || !this.router) return;
    if (message.event === 'move') {
      if (!this.active) {
        if (Date.now() < this.ignoreEntryUntil) return;
        const point = { x: message.x, y: message.y };
        const delta = { x: message.dx, y: message.dy };
        const candidate = findEntry(this.router.locals, this.router.remote, point, delta);
        if (!candidate) {
          this.entryCandidate = null;
          return;
        }
        const candidateKey = `${candidate.local.id}:${candidate.edge}`;
        if (!this.entryCandidate || this.entryCandidate.key !== candidateKey) {
          this.entryCandidate = { key: candidateKey, since: Date.now() };
          if (this.edgeDelayMs > 0) return;
        }
        if (Date.now() - this.entryCandidate.since < this.edgeDelayMs) return;
        const entry = this.router.tryEnter(point, delta);
        this.entryCandidate = null;
        if (entry) this.#activate(entry.point);
        return;
      }
      const result = this.router.move(message.dx, message.dy);
      if (!result) return;
      if (result.exited) this.#deactivate(result.localPoint);
      else this.#queuePointer(result.point);
      return;
    }
    if (!this.active) return;
    if (message.event === 'button') {
      this.#flushPointer();
      this.emit('outbound', { type: 'input', event: {
        kind: 'button', button: message.button, down: Boolean(message.down), clicks: message.clicks || 1
      } });
    } else if (message.event === 'scroll') {
      this.#flushPointer();
      this.emit('outbound', { type: 'input', event: {
        kind: 'wheel', deltaX: Number(message.deltaX) || 0, deltaY: Number(message.deltaY) || 0
      } });
    } else if (message.event === 'key') {
      this.#flushPointer();
      const vk = macKeyCodeToWindowsVk(message.keyCode);
      if (vk !== null) this.emit('outbound', { type: 'input', event: {
        kind: 'key', vk, down: Boolean(message.down), repeat: Boolean(message.repeat)
      } });
    } else if (message.event === 'release') {
      this.#deactivate(this.router.forceExit());
    }
  }

  #activate(point) {
    this.active = true;
    this.process.send({ command: 'activate' });
    this.emit('outbound', { type: 'control', action: 'active' });
    this.emit('outbound', { type: 'input', event: {
      kind: 'pointer', x: Math.round(point.x), y: Math.round(point.y)
    } });
    this.emit('status', this.status());
  }

  #queuePointer(point) {
    this.pendingPointer = { x: Math.round(point.x), y: Math.round(point.y) };
    if (this.pointerTimer) return;
    this.pointerTimer = setTimeout(() => this.#flushPointer(), 8);
    this.pointerTimer.unref?.();
  }

  #flushPointer() {
    clearTimeout(this.pointerTimer);
    this.pointerTimer = null;
    if (!this.pendingPointer) return;
    const point = this.pendingPointer;
    this.pendingPointer = null;
    this.emit('outbound', { type: 'input', event: { kind: 'pointer', ...point } });
  }

  #deactivate(localPoint) {
    this.#flushPointer();
    this.active = false;
    this.router.active = false;
    this.ignoreEntryUntil = Date.now() + 450;
    this.emit('outbound', { type: 'input', event: { kind: 'releaseAll' } });
    this.emit('outbound', { type: 'control', action: 'inactive' });
    this.process.send({ command: 'deactivate' });
    this.process.send({ command: 'warp', x: Math.round(localPoint.x), y: Math.round(localPoint.y) });
    this.emit('status', this.status());
  }

  async readClipboardFiles() {
    if (!this.process) return { paths: [], revision: null };
    const response = await this.process.request('clipboard-read');
    return {
      paths: Array.isArray(response.paths) ? response.paths.filter((item) => typeof item === 'string') : [],
      revision: Number.isFinite(response.revision) ? response.revision : null
    };
  }

  async writeClipboardFiles(paths) {
    if (!this.process) throw new Error('macOS 输入助手尚未运行');
    return this.process.request('clipboard-write', { paths });
  }

  stop() {
    if (this.active) this.#deactivate(this.router?.forceExit() || { x: 20, y: 20 });
    this.running = false;
    this.active = false;
    this.router = null;
    this.entryCandidate = null;
    clearTimeout(this.pointerTimer);
    this.pointerTimer = null;
    this.pendingPointer = null;
    this.process?.stop();
    this.process = null;
    this.emit('status', this.status());
  }
}

class WindowsInputController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.script = options.script;
    this.platform = options.platform || process.platform;
    this.process = null;
  }

  get supported() {
    return this.platform === 'win32' && Boolean(this.script) && fs.existsSync(this.script);
  }

  async start() {
    if (!this.supported) throw new Error('Windows 键鼠注入助手不可用');
    if (this.process) return { supported: true, running: true };
    const wrapper = new JsonLineProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.script
    ]);
    this.process = wrapper;
    wrapper.on('warning', (message) => this.emit('warning', message));
    wrapper.on('error', (error) => this.emit('error', error));
    wrapper.on('exit', () => {
      if (this.process === wrapper) this.process = null;
      this.emit('status', { supported: this.supported, running: false });
    });
    try {
      await wrapper.start(8000);
    } catch (error) {
      wrapper.stop();
      if (this.process === wrapper) this.process = null;
      throw error;
    }
    this.emit('status', { supported: true, running: true });
    return { supported: true, running: true };
  }

  send(event) {
    return this.process?.send({ command: 'input', event }) || false;
  }

  async readClipboardFiles() {
    if (!this.process) return { paths: [], revision: null };
    const response = await this.process.request('clipboard-read');
    return {
      paths: Array.isArray(response.paths) ? response.paths.filter((item) => typeof item === 'string') : [],
      revision: Number.isFinite(response.revision) ? response.revision : null
    };
  }

  async writeClipboardFiles(paths) {
    if (!this.process) throw new Error('Windows 输入助手尚未运行');
    return this.process.request('clipboard-write', { paths });
  }

  stop() {
    this.process?.send({ command: 'input', event: { kind: 'releaseAll' } });
    this.process?.stop();
    this.process = null;
    this.emit('status', { supported: this.supported, running: false });
  }
}

class ClipboardSync extends EventEmitter {
  constructor(options) {
    super();
    this.readText = options.readText;
    this.writeText = options.writeText;
    this.send = options.send;
    this.intervalMs = options.intervalMs || 500;
    this.origin = options.origin || `clipboard-${Date.now()}`;
    this.shouldSkip = typeof options.shouldSkip === 'function' ? options.shouldSkip : () => false;
    this.lastText = '';
    this.skippedForFiles = false;
    this.sequence = 0;
    this.timer = null;
  }

  start(sendInitial = true) {
    if (this.timer) return;
    this.lastText = String(this.readText() || '');
    this.skippedForFiles = this.shouldSkip();
    if (sendInitial && !this.skippedForFiles
      && Buffer.byteLength(this.lastText, 'utf8') <= CLIPBOARD_MAX_BYTES) this.#send(this.lastText);
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  poll() {
    if (this.shouldSkip()) {
      this.skippedForFiles = true;
      return false;
    }
    const text = String(this.readText() || '');
    const forceSend = this.skippedForFiles;
    this.skippedForFiles = false;
    if (!forceSend && text === this.lastText) return false;
    this.lastText = text;
    if (Buffer.byteLength(text, 'utf8') > CLIPBOARD_MAX_BYTES) {
      this.emit('warning', '剪贴板文本过大，本次未同步');
      return false;
    }
    this.#send(text);
    return true;
  }

  #send(text) {
    this.sequence += 1;
    this.send({ type: 'clipboard', text, revision: `${this.origin}:${this.sequence}` });
  }

  applyRemote(message) {
    if (typeof message?.text !== 'string') return false;
    if (Buffer.byteLength(message.text, 'utf8') > CLIPBOARD_MAX_BYTES) return false;
    const clipboardHasFiles = this.shouldSkip();
    const forceWrite = this.skippedForFiles || clipboardHasFiles;
    this.skippedForFiles = false;
    if (!forceWrite && message.text === this.lastText) return true;
    this.lastText = message.text;
    this.writeText(message.text);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  CLIPBOARD_MAX_BYTES,
  ClipboardSync,
  MacInputController,
  WindowsInputController,
  macKeyCodeToWindowsVk
};

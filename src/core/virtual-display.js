'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function validateDisplayOptions(input = {}) {
  const width = Number(input.width);
  const height = Number(input.height);
  const fps = Number(input.fps);
  if (!Number.isInteger(width) || width < 800 || width > 7680 || width % 2 !== 0) {
    throw new Error('宽度必须是 800–7680 之间的偶数');
  }
  if (!Number.isInteger(height) || height < 600 || height > 4320 || height % 2 !== 0) {
    throw new Error('高度必须是 600–4320 之间的偶数');
  }
  if (!Number.isInteger(fps) || fps < 15 || fps > 60) {
    throw new Error('刷新率必须是 15–60');
  }
  const hiDPI = Boolean(input.hiDPI);
  if (hiDPI && (width * 2 > 7680 || height * 2 > 7680)) {
    throw new Error('HiDPI 的 2× 物理帧缓冲区不能超过 7680×7680');
  }
  return {
    width,
    height,
    fps,
    hiDPI,
    name: String(input.name || 'LanExtend Display').replace(/[\r\n\u0000]/g, '').slice(0, 64),
    serial: Number.isInteger(input.serial) && input.serial > 0
      ? Math.min(input.serial, 0xffff_ffff)
      : 1
  };
}

function helperPath({ isPackaged = false, resourcesPath = process.resourcesPath, projectRoot }) {
  if (process.platform !== 'darwin') return null;
  return isPackaged
    ? path.join(resourcesPath, 'native', 'lanextend-vdisplay')
    : path.join(projectRoot, 'native', 'macos', '.build', 'lanextend-vdisplay');
}

class VirtualDisplayManager extends EventEmitter {
  constructor(options) {
    super();
    this.executable = options.executable;
    this.child = null;
    this.display = null;
    this.stderr = '';
  }

  getStatus() {
    return {
      supported: process.platform === 'darwin'
        && Boolean(this.executable)
        && fs.existsSync(this.executable),
      running: Boolean(this.child && !this.child.killed),
      display: this.display,
      helperPath: this.executable
    };
  }

  async probe(timeoutMs = 4_000) {
    if (process.platform !== 'darwin' || !this.executable) {
      return { supported: false, reason: '当前平台不是 macOS' };
    }
    const result = await this.#runOnce(['--probe'], timeoutMs);
    return { ...result, supported: Boolean(result.available ?? result.supported) };
  }

  async create(input) {
    if (this.child) await this.destroy();
    const options = validateDisplayOptions(input);
    if (!this.executable) throw new Error('未找到 macOS 虚拟显示 helper，请先运行 npm run build:native');

    const args = [
      'create',
      '--width', String(options.width),
      '--height', String(options.height),
      '--fps', String(options.fps),
      '--name', options.name,
      '--serial', String(options.serial)
    ];
    if (options.hiDPI) args.push('--hidpi');

    const child = spawn(this.executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.stderr = '';
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_384);
      this.emit('log', this.stderr);
    });

    let buffer = '';
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`创建虚拟显示器超时${this.stderr ? `：${this.stderr.trim()}` : ''}`));
      }, 8_000);

      const finish = (callback, value) => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onEarlyExit);
        callback(value);
      };
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.event === 'ready' && Number.isInteger(event.displayId)) {
              finish(resolve, event);
              return;
            }
            if (event.event === 'error') {
              finish(reject, new Error(event.message || '虚拟显示器创建失败'));
              return;
            }
          } catch {
            // Ignore diagnostic lines; the helper's contract is JSONL.
          }
        }
      };
      const onError = (error) => finish(reject, error);
      const onEarlyExit = (code) => finish(
        reject,
        new Error(`虚拟显示 helper 提前退出 (${code})${this.stderr ? `：${this.stderr.trim()}` : ''}`)
      );
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onEarlyExit);
    });

    try {
      this.display = await ready;
    } catch (error) {
      child.kill('SIGTERM');
      if (this.child === child) this.child = null;
      throw error;
    }

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        const previous = this.display;
        this.child = null;
        this.display = null;
        this.emit('stopped', { code, signal, previous });
      }
    });
    this.emit('ready', this.display);
    return this.display;
  }

  async destroy(timeoutMs = 3_000) {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.display = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.emit('stopped', { intentional: true });
  }

  async #runOnce(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('helper 探测超时'));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `helper 探测失败 (${code})`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()));
        } catch {
          reject(new Error('helper 返回了无法识别的探测结果'));
        }
      });
    });
  }
}

module.exports = {
  VirtualDisplayManager,
  helperPath,
  validateDisplayOptions
};

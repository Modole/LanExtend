'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { MAX_FILE_ENTRIES, MAX_FILE_TRANSFER_BYTES } = require('./constants');
const { isPrivateIPv4, isValidPort } = require('./protocol');

const STREAM_MAGIC = Buffer.from('LEXFILE1', 'ascii');
const DIGEST_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ROOT_ITEMS = 16;
const MAX_ENTRIES = MAX_FILE_ENTRIES;
const MAX_TOTAL_BYTES = MAX_FILE_TRANSFER_BYTES;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OFFER_TTL_MS = 15 * 60 * 1000;

function truncateUtf16(value, maximum) {
  let result = String(value).slice(0, maximum);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) result = result.slice(0, -1);
  return result;
}

function portableSegment(value, fallback = '未命名') {
  let cleaned = truncateUtf16(String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, ''), 180);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function uniqueName(name, used) {
  const parsed = path.parse(name);
  let candidate = name;
  let index = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const suffix = ` (${index})`;
    const extension = truncateUtf16(parsed.ext, 80);
    const stemLength = Math.max(1, 180 - suffix.length - extension.length);
    const stem = truncateUtf16(parsed.name || '文件', stemLength);
    candidate = `${stem}${suffix}${extension}`;
    index += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

async function buildTransferPlan(inputPaths, options = {}) {
  const maxEntries = options.maxEntries || MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes || MAX_TOTAL_BYTES;
  const roots = [...new Set((inputPaths || []).map((item) => path.resolve(String(item))))];
  if (!roots.length) throw new Error('文件剪贴板中没有可传输的路径');
  if (roots.length > MAX_ROOT_ITEMS) throw new Error(`顶层项目超过 ${MAX_ROOT_ITEMS} 项限制`);

  const entries = [];
  const names = [];
  const warnings = [];
  const usedRootNames = new Set();
  let totalBytes = 0;

  const append = async (sourcePath, relativePath) => {
    if (entries.length >= maxEntries) throw new Error(`文件数量超过 ${maxEntries} 项限制`);
    const stat = await fsp.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      warnings.push(`已跳过符号链接：${relativePath}`);
      return;
    }
    if (stat.isDirectory()) {
      entries.push({
        sourcePath,
        relativePath,
        type: 'directory',
        size: 0,
        mtimeMs: Math.max(0, Math.round(stat.mtimeMs || Date.now()))
      });
      const children = await fsp.readdir(sourcePath);
      children.sort((left, right) => left.localeCompare(right));
      const usedChildNames = new Set();
      for (const child of children) {
        const childName = uniqueName(portableSegment(child), usedChildNames);
        await append(path.join(sourcePath, child), path.posix.join(relativePath, childName));
      }
      return;
    }
    if (!stat.isFile()) {
      warnings.push(`已跳过不支持的项目：${relativePath}`);
      return;
    }
    totalBytes += stat.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw new Error(`文件总大小超过 ${Math.round(maxTotalBytes / 1024 / 1024 / 1024)} GiB 限制`);
    }
    entries.push({
      sourcePath,
      relativePath,
      type: 'file',
      size: stat.size,
      mtimeMs: Math.max(0, Math.round(stat.mtimeMs || Date.now()))
    });
  };

  for (const rootPath of roots) {
    const rootName = uniqueName(portableSegment(path.basename(rootPath)), usedRootNames);
    const before = entries.length;
    await append(rootPath, rootName);
    if (entries.length > before) names.push(rootName);
  }
  if (!entries.length) throw new Error('所选项目中没有可传输的普通文件或目录');
  return { entries, names, totalBytes, itemCount: entries.length, warnings };
}

function normalizedRemoteAddress(value) {
  const address = String(value || '');
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function writeChunk(response, chunk) {
  if (response.destroyed) return Promise.reject(new Error('文件接收端已断开'));
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('文件接收端已断开')); };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

function frameHeader(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_HEADER_BYTES) throw new Error('文件条目头部过大');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(payload.length);
  return [length, payload];
}

class FileTransferServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '0.0.0.0';
    this.port = options.port ?? 0;
    this.offerTtlMs = options.offerTtlMs || DEFAULT_OFFER_TTL_MS;
    this.server = null;
    this.transfers = new Map();
    this.activeResponses = new Map();
    this.pruneTimer = null;
    this.idleTimer = null;
  }

  async start() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.server) return this.address();
    const server = http.createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('transfer failed');
        } else if (!response.destroyed) response.destroy();
        this.emit('warning', error);
      });
    });
    this.server = server;
    server.on('error', (error) => this.emit('error', error));
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(this.port, this.host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    this.pruneTimer.unref?.();
    return this.address();
  }

  address() {
    const address = this.server?.address();
    return { host: this.host, port: typeof address === 'object' && address ? address.port : null };
  }

  async register(inputPaths) {
    const plan = await buildTransferPlan(inputPaths);
    await this.start();
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + this.offerTtlMs;
    this.transfers.set(id, { id, ...plan, expiresAt });
    return {
      id,
      port: this.address().port,
      itemCount: plan.itemCount,
      totalBytes: plan.totalBytes,
      names: plan.names,
      expiresAt,
      warnings: plan.warnings.slice(0, 8).map((warning) => truncateUtf16(warning, 240))
    };
  }

  async #handle(request, response) {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' });
      response.end();
      return;
    }
    const remoteAddress = normalizedRemoteAddress(request.socket.remoteAddress);
    if (!isPrivateIPv4(remoteAddress)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const match = /^\/v1\/transfers\/([0-9a-f-]{36})\/stream$/.exec(new URL(request.url, 'http://lanextend.local').pathname);
    const transfer = match ? this.transfers.get(match[1]) : null;
    if (!transfer || transfer.expiresAt < Date.now()) {
      response.writeHead(404);
      response.end();
      return;
    }
    this.activeResponses.set(transfer.id, response);
    response.writeHead(200, {
      'content-type': 'application/vnd.lanextend.file-stream',
      'cache-control': 'no-store',
      'x-lanextend-transfer-id': transfer.id
    });
    let transferredBytes = 0;
    try {
      await writeChunk(response, STREAM_MAGIC);
      for (const entry of transfer.entries) {
        const current = await fsp.lstat(entry.sourcePath);
        if (entry.type === 'file' && (!current.isFile() || current.size !== entry.size)) {
          throw new Error(`传输期间文件发生变化：${entry.relativePath}`);
        }
        if (entry.type === 'directory' && !current.isDirectory()) {
          throw new Error(`传输期间目录发生变化：${entry.relativePath}`);
        }
        const [length, header] = frameHeader({
          path: entry.relativePath,
          type: entry.type,
          size: entry.size,
          mtimeMs: entry.mtimeMs
        });
        await writeChunk(response, length);
        await writeChunk(response, header);
        if (entry.type !== 'file') continue;
        const hash = crypto.createHash('sha256');
        let entryBytes = 0;
        for await (const chunk of fs.createReadStream(entry.sourcePath, { highWaterMark: 256 * 1024 })) {
          entryBytes += chunk.length;
          if (entryBytes > entry.size) throw new Error(`传输期间文件变大：${entry.relativePath}`);
          hash.update(chunk);
          await writeChunk(response, chunk);
          transferredBytes += chunk.length;
          this.emit('progress', {
            transferId: transfer.id,
            direction: 'send',
            status: 'sending',
            name: transfer.names.join('、'),
            bytes: transferredBytes,
            totalBytes: transfer.totalBytes
          });
        }
        if (entryBytes !== entry.size) throw new Error(`传输期间文件变小：${entry.relativePath}`);
        await writeChunk(response, hash.digest());
      }
      const end = Buffer.alloc(4);
      await writeChunk(response, end);
      response.end();
      this.emit('progress', {
        transferId: transfer.id,
        direction: 'send',
        status: 'sent',
        name: transfer.names.join('、'),
        bytes: transfer.totalBytes,
        totalBytes: transfer.totalBytes
      });
    } finally {
      this.activeResponses.delete(transfer.id);
      this.#scheduleIdleStop();
    }
  }

  cancel(transferId) {
    const response = this.activeResponses.get(transferId);
    if (response && !response.destroyed) response.destroy(new Error('传输已取消'));
    this.activeResponses.delete(transferId);
    const canceled = this.transfers.delete(transferId) || Boolean(response);
    this.#scheduleIdleStop();
    return canceled;
  }

  release(transferId) {
    const released = this.transfers.delete(transferId);
    this.#scheduleIdleStop();
    return released;
  }

  prune() {
    const now = Date.now();
    for (const [id, transfer] of this.transfers) {
      if (transfer.expiresAt < now && !this.activeResponses.has(id)) this.transfers.delete(id);
    }
    this.#scheduleIdleStop();
  }

  #scheduleIdleStop() {
    if (!this.server || this.transfers.size || this.activeResponses.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.stop().catch((error) => this.emit('warning', error));
    }, 30_000);
    this.idleTimer.unref?.();
  }

  async stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    for (const response of this.activeResponses.values()) response.destroy();
    this.activeResponses.clear();
    this.transfers.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

class StreamReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async #fill() {
    if (this.buffer.length || this.ended) return;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return;
    }
    this.buffer = Buffer.from(next.value);
  }

  async readSome(maximum) {
    await this.#fill();
    if (!this.buffer.length) throw new Error('文件流意外结束');
    const length = Math.min(maximum, this.buffer.length);
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  async readExact(length) {
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await this.readSome(length - offset);
      chunk.copy(output, offset);
      offset += chunk.length;
    }
    return output;
  }
}

function safeDestination(root, relativePath) {
  if (typeof relativePath !== 'string' || Buffer.byteLength(relativePath, 'utf8') > 4096) {
    throw new Error('文件相对路径无效');
  }
  const segments = relativePath.split('/');
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..'
    || segment.includes('\\') || portableSegment(segment) !== segment)) {
    throw new Error('文件相对路径不安全');
  }
  const destination = path.resolve(root, ...segments);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(prefix)) throw new Error('文件路径超出接收目录');
  return destination;
}

async function finishWritable(stream) {
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

class FileTransferClient {
  constructor(options) {
    this.cacheDirectory = options.cacheDirectory;
    this.maxEntries = options.maxEntries || MAX_ENTRIES;
    this.maxTotalBytes = options.maxTotalBytes || MAX_TOTAL_BYTES;
  }

  async receive(offer, host, options = {}) {
    if (!offer || typeof offer.id !== 'string' || !/^[0-9a-f-]{36}$/.test(offer.id)
      || !isValidPort(offer.port) || !isPrivateIPv4(host)
      || !Number.isInteger(offer.itemCount) || offer.itemCount < 1 || offer.itemCount > this.maxEntries
      || !Number.isSafeInteger(offer.totalBytes) || offer.totalBytes < 0 || offer.totalBytes > this.maxTotalBytes
      || !Array.isArray(offer.names) || offer.names.length < 1 || offer.names.length > 16
      || offer.names.some((name) => typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > 512)
      || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= Date.now()) {
      throw new Error('文件传输地址无效');
    }
    const partial = path.join(this.cacheDirectory, `${offer.id}.partial`);
    const destinationRoot = path.join(this.cacheDirectory, offer.id);
    await fsp.mkdir(this.cacheDirectory, { recursive: true });
    await fsp.rm(partial, { recursive: true, force: true });
    await fsp.mkdir(partial, { recursive: true });

    const request = http.get({
      host,
      port: offer.port,
      path: `/v1/transfers/${offer.id}/stream`,
      headers: { 'user-agent': 'LanExtend file clipboard' }
    });
    const abort = () => request.destroy(Object.assign(new Error('文件传输已取消'), { code: 'ABORT_ERR' }));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    request.setTimeout(30_000, () => request.destroy(new Error('文件传输等待数据超时')));

    try {
      const response = await new Promise((resolve, reject) => {
        request.once('response', resolve);
        request.once('error', reject);
      });
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`文件源返回 HTTP ${response.statusCode}`);
      }
      const reader = new StreamReader(response);
      const magic = await reader.readExact(STREAM_MAGIC.length);
      if (!magic.equals(STREAM_MAGIC)) throw new Error('文件流协议不兼容');
      let entries = 0;
      let receivedBytes = 0;
      const rootNames = new Set();
      const seenPaths = new Set();

      while (true) {
        const length = (await reader.readExact(4)).readUInt32BE(0);
        if (length === 0) break;
        if (length > MAX_HEADER_BYTES) throw new Error('文件条目头部超过限制');
        let header;
        try {
          header = JSON.parse((await reader.readExact(length)).toString('utf8'));
        } catch {
          throw new Error('文件条目头部无效');
        }
        entries += 1;
        if (entries > this.maxEntries) throw new Error('文件条目数量超过限制');
        if (!header || !['file', 'directory'].includes(header.type)
          || !Number.isSafeInteger(header.size) || header.size < 0
          || (header.type === 'directory' && header.size !== 0)) {
          throw new Error('文件条目参数无效');
        }
        const relative = String(header.path || '');
        if (seenPaths.has(relative)) throw new Error('文件流包含重复路径');
        seenPaths.add(relative);
        rootNames.add(relative.split('/')[0]);
        const destination = safeDestination(partial, relative);
        if (header.type === 'directory') {
          await fsp.mkdir(destination, { recursive: true });
          continue;
        }
        if (receivedBytes + header.size > this.maxTotalBytes) throw new Error('文件总大小超过限制');
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        const hash = crypto.createHash('sha256');
        let remaining = header.size;
        try {
          while (remaining > 0) {
            const chunk = await reader.readSome(Math.min(256 * 1024, remaining));
            hash.update(chunk);
            if (!output.write(chunk)) await once(output, 'drain');
            remaining -= chunk.length;
            receivedBytes += chunk.length;
            options.onProgress?.({
              transferId: offer.id,
              direction: 'receive',
              status: 'receiving',
              name: (offer.names || []).join('、'),
              bytes: receivedBytes,
              totalBytes: offer.totalBytes
            });
          }
          await finishWritable(output);
        } catch (error) {
          output.destroy();
          throw error;
        }
        const declaredDigest = await reader.readExact(DIGEST_BYTES);
        if (!crypto.timingSafeEqual(hash.digest(), declaredDigest)) {
          throw new Error(`文件完整性校验失败：${relative}`);
        }
        const mtime = Number(header.mtimeMs);
        if (Number.isFinite(mtime) && mtime > 0) {
          const date = new Date(mtime);
          await fsp.utimes(destination, date, date).catch(() => {});
        }
      }
      if (!entries || !rootNames.size) throw new Error('文件流为空');
      if (entries !== offer.itemCount || receivedBytes !== offer.totalBytes) {
        throw new Error('文件流与传输清单不一致');
      }
      if (rootNames.size !== offer.names.length || offer.names.some((name) => !rootNames.has(name))) {
        throw new Error('文件流顶层项目与传输清单不一致');
      }
      await fsp.rm(destinationRoot, { recursive: true, force: true });
      await fsp.rename(partial, destinationRoot);
      const paths = [...rootNames].map((name) => safeDestination(destinationRoot, name));
      return { transferId: offer.id, paths, bytes: receivedBytes, entries };
    } catch (error) {
      request.destroy();
      await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

class FileTransferManager extends EventEmitter {
  constructor(options) {
    super();
    this.cacheDirectory = options.cacheDirectory;
    this.retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;
    this.server = new FileTransferServer(options.server);
    this.client = new FileTransferClient({ cacheDirectory: this.cacheDirectory });
    this.receives = new Map();
    this.server.on('progress', (event) => this.emit('progress', event));
    this.server.on('warning', (error) => this.emit('warning', error));
    this.server.on('error', (error) => this.emit('error', error));
  }

  async start() {
    await this.cleanupCache();
    return this.server.start();
  }

  createOffer(paths) {
    return this.server.register(paths);
  }

  async receive(offer, host) {
    if (this.receives.has(offer.id)) return this.receives.get(offer.id).promise;
    const controller = new AbortController();
    const promise = this.client.receive(offer, host, {
      signal: controller.signal,
      onProgress: (event) => this.emit('progress', event)
    }).then((result) => {
      this.emit('progress', {
        transferId: offer.id,
        direction: 'receive',
        status: 'completed',
        name: (offer.names || []).join('、'),
        bytes: offer.totalBytes,
        totalBytes: offer.totalBytes,
        paths: result.paths
      });
      return result;
    }).finally(() => this.receives.delete(offer.id));
    this.receives.set(offer.id, { controller, promise });
    return promise;
  }

  cancel(transferId) {
    const receive = this.receives.get(transferId);
    if (receive) receive.controller.abort();
    const served = this.server.cancel(transferId);
    if (receive || served) {
      this.emit('progress', {
        transferId,
        status: 'canceled',
        direction: receive ? 'receive' : 'send',
        bytes: 0,
        totalBytes: 0
      });
      return true;
    }
    return false;
  }

  release(transferId) {
    return this.server.release(transferId);
  }

  async cleanupCache(now = Date.now()) {
    await fsp.mkdir(this.cacheDirectory, { recursive: true });
    const entries = await fsp.readdir(this.cacheDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith('.partial')) {
        if (entry.name.endsWith('.partial')) {
          await fsp.rm(path.join(this.cacheDirectory, entry.name), { recursive: true, force: true });
        }
        continue;
      }
      const target = path.join(this.cacheDirectory, entry.name);
      const stat = await fsp.stat(target).catch(() => null);
      if (stat && now - stat.mtimeMs > this.retentionMs) {
        await fsp.rm(target, { recursive: true, force: true });
      }
    }
  }

  async stop() {
    for (const receive of this.receives.values()) receive.controller.abort();
    await Promise.allSettled([...this.receives.values()].map((item) => item.promise));
    this.receives.clear();
    await this.server.stop();
  }
}

class FileClipboardSync extends EventEmitter {
  constructor(options) {
    super();
    this.readFiles = options.readFiles;
    this.writeFiles = options.writeFiles;
    this.createOffer = options.createOffer;
    this.send = options.send;
    this.intervalMs = options.intervalMs || 650;
    this.lastFingerprint = '';
    this.timer = null;
    this.polling = false;
  }

  async start(sendInitial = true) {
    if (this.timer) return;
    try {
      if (sendInitial) await this.poll();
      else {
        const snapshot = await this.readFiles();
        this.lastFingerprint = this.#fingerprint(
          Array.isArray(snapshot) ? snapshot : snapshot?.paths,
          Array.isArray(snapshot) ? null : snapshot?.revision
        );
      }
    } catch (error) {
      this.emit('warning', error.message);
    }
    this.timer = setInterval(() => this.poll().catch((error) => this.emit('warning', error.message)), this.intervalMs);
    this.timer.unref?.();
  }

  #fingerprint(paths, revision = null) {
    const pathList = (paths || []).map((item) => path.resolve(String(item))).join('\n');
    return pathList ? `${revision ?? 'paths'}\n${pathList}` : '';
  }

  async poll() {
    if (this.polling) return false;
    this.polling = true;
    try {
      const snapshot = await this.readFiles();
      const paths = Array.isArray(snapshot) ? snapshot : snapshot?.paths;
      const revision = Array.isArray(snapshot) ? null : snapshot?.revision;
      const fingerprint = this.#fingerprint(paths, revision);
      if (!fingerprint || fingerprint === this.lastFingerprint) return false;
      this.lastFingerprint = fingerprint;
      const transfer = await this.createOffer(paths);
      this.send({ type: 'file-offer', transfer });
      this.emit('offer', transfer);
      for (const warning of transfer.warnings || []) this.emit('warning', warning);
      return true;
    } finally {
      this.polling = false;
    }
  }

  async applyRemote(paths) {
    if (!this.#fingerprint(paths)) return false;
    const result = await this.writeFiles(paths);
    this.lastFingerprint = this.#fingerprint(paths, result?.revision);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  DEFAULT_RETENTION_MS,
  FileClipboardSync,
  FileTransferClient,
  FileTransferManager,
  FileTransferServer,
  MAX_ENTRIES,
  MAX_TOTAL_BYTES,
  STREAM_MAGIC,
  buildTransferPlan,
  portableSegment,
  safeDestination
};

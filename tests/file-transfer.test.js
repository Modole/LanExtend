'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  FileClipboardSync,
  FileTransferClient,
  FileTransferManager,
  FileTransferServer,
  buildTransferPlan,
  portableSegment,
  safeDestination
} = require('../src/core/file-transfer');

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanextend-files-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const folder = path.join(source, '资料');
  await fsp.mkdir(path.join(folder, '子目录'), { recursive: true });
  await fsp.writeFile(path.join(folder, '说明.txt'), '跨设备文件剪贴板\n', 'utf8');
  await fsp.writeFile(path.join(folder, '子目录', 'payload.bin'), Buffer.from([0, 1, 2, 3, 255]));
  await fsp.writeFile(path.join(source, '单独.txt'), 'standalone', 'utf8');
  return { directory, source, folder };
}

test('file transfer plans preserve folders and sanitize portable names', async (t) => {
  const { source, folder } = await fixture(t);
  const plan = await buildTransferPlan([folder, path.join(source, '单独.txt')]);
  assert.deepEqual(plan.names, ['资料', '单独.txt']);
  assert.equal(plan.itemCount, 5);
  assert.equal(plan.totalBytes, Buffer.byteLength('跨设备文件剪贴板\n') + 5 + Buffer.byteLength('standalone'));
  assert.ok(plan.entries.some((entry) => entry.relativePath === '资料/子目录/payload.bin'));
  assert.equal(portableSegment('bad:name?.txt'), 'bad_name_.txt');
  assert.equal(portableSegment('CON.txt'), '_CON.txt');
  await assert.rejects(
    buildTransferPlan(Array.from({ length: 17 }, (_, index) => path.join(source, `item-${index}`))),
    /顶层项目超过 16/
  );
});

test('streaming transfer round-trips multiple files with SHA-256 verification', async (t) => {
  const { directory, source, folder } = await fixture(t);
  const server = new FileTransferServer({ host: '127.0.0.1', port: 0 });
  await server.start();
  t.after(() => server.stop());
  const offer = await server.register([folder, path.join(source, '单独.txt')]);
  const client = new FileTransferClient({ cacheDirectory: path.join(directory, 'cache') });
  const progress = [];
  const result = await client.receive(offer, '127.0.0.1', {
    onProgress: (event) => progress.push(event.bytes)
  });
  assert.equal(await fsp.readFile(path.join(result.paths[0], '说明.txt'), 'utf8'), '跨设备文件剪贴板\n');
  assert.deepEqual(
    await fsp.readFile(path.join(result.paths[0], '子目录', 'payload.bin')),
    Buffer.from([0, 1, 2, 3, 255])
  );
  assert.equal(await fsp.readFile(result.paths[1], 'utf8'), 'standalone');
  assert.equal(result.bytes, offer.totalBytes);
  assert.equal(progress.at(-1), offer.totalBytes);
});

test('file clipboard offers changes once and suppresses a remote echo', async () => {
  let localPaths = ['/tmp/source.txt'];
  let written = null;
  const sent = [];
  const sync = new FileClipboardSync({
    readFiles: async () => localPaths,
    writeFiles: async (paths) => { written = paths; localPaths = paths; },
    createOffer: async () => ({
      id: '00000000-0000-4000-8000-000000000001',
      port: 47773,
      itemCount: 1,
      totalBytes: 12,
      names: ['source.txt'],
      expiresAt: Date.now() + 1000
    }),
    send: (message) => sent.push(message)
  });
  assert.equal(await sync.poll(), true);
  assert.equal(await sync.poll(), false);
  await sync.applyRemote(['/tmp/received.txt']);
  assert.deepEqual(written, ['/tmp/received.txt']);
  assert.equal(await sync.poll(), false);
  assert.equal(sent.length, 1);
});

test('file clipboard polling failures warn without preventing sharing startup', async () => {
  const warnings = [];
  const sync = new FileClipboardSync({
    readFiles: async () => { throw new Error('clipboard busy'); },
    writeFiles: async () => ({}),
    createOffer: async () => { throw new Error('not reached'); },
    send: () => {},
    intervalMs: 60_000
  });
  sync.on('warning', (message) => warnings.push(message));
  await sync.start(true);
  assert.deepEqual(warnings, ['clipboard busy']);
  sync.stop();
});

test('cache cleanup removes expired transfer directories and safe paths reject traversal', async (t) => {
  const { directory } = await fixture(t);
  const cache = path.join(directory, 'cache');
  const expired = path.join(cache, 'expired');
  await fsp.mkdir(expired, { recursive: true });
  const old = new Date(Date.now() - 10_000);
  await fsp.utimes(expired, old, old);
  const manager = new FileTransferManager({ cacheDirectory: cache, retentionMs: 1000 });
  await manager.cleanupCache();
  assert.equal(fs.existsSync(expired), false);
  assert.throws(() => safeDestination(cache, '../outside'), /不安全/);
});

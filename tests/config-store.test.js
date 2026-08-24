'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/core/config-store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lanextend-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('store creates a stable receiver identity and persists settings', (t) => {
  const directory = temporaryDirectory(t);
  const first = new ConfigStore(directory);
  const identity = first.get().receiver.id;
  assert.match(identity, /^[0-9a-f-]{36}$/i);
  first.updateSettings({ host: { width: 2560, height: 1440, fps: 60 } });

  const second = new ConfigStore(directory);
  assert.equal(second.get().receiver.id, identity);
  assert.equal(second.get().host.width, 2560);
  assert.equal(second.get().host.height, 1440);
  assert.equal(second.get().host.fps, 60);
  const mode = fs.statSync(path.join(directory, 'settings.json')).mode & 0o777;
  if (process.platform === 'win32') assert.ok(mode & 0o200, 'settings file should be writable');
  else assert.equal(mode, 0o600);
});

test('receiver identity survives a no-op first run', (t) => {
  const directory = temporaryDirectory(t);
  const firstIdentity = new ConfigStore(directory).get().receiver.id;
  assert.equal(fs.existsSync(path.join(directory, 'settings.json')), true);
  const secondIdentity = new ConfigStore(directory).get().receiver.id;
  assert.equal(secondIdentity, firstIdentity);
});

test('partial setting update preserves connection memory', (t) => {
  const store = new ConfigStore(temporaryDirectory(t));
  store.updateSettings({ host: { lastDeviceId: 'abc', lastSourceId: 'screen:2:0' } });
  store.updateSettings({ host: { bitrateMbps: 20 } });
  assert.equal(store.get().host.lastDeviceId, 'abc');
  assert.equal(store.get().host.lastSourceId, 'screen:2:0');
  assert.equal(store.get().host.bitrateMbps, 20);
});

test('input sharing layout and clipboard settings are durable', (t) => {
  const directory = temporaryDirectory(t);
  const store = new ConfigStore(directory);
  store.updateSettings({ inputSharing: {
    lastDeviceId: 'win-input',
    clipboard: true,
    fileClipboard: false,
    edgeDelayMs: 160,
    layouts: [{ deviceId: 'win-input', x: 2560, y: 0, width: 1920, height: 1080 }]
  } });
  const reloaded = new ConfigStore(directory).get().inputSharing;
  assert.equal(reloaded.lastDeviceId, 'win-input');
  assert.equal(reloaded.clipboard, true);
  assert.equal(reloaded.fileClipboard, false);
  assert.equal(reloaded.edgeDelayMs, 160);
  assert.deepEqual(reloaded.layouts[0], {
    deviceId: 'win-input', x: 2560, y: 0, width: 1920, height: 1080
  });
});

test('remembering, reconnecting and forgetting a device is durable', (t) => {
  const directory = temporaryDirectory(t);
  const store = new ConfigStore(directory);
  store.rememberDevice({
    id: 'win-1', name: 'Office', host: '192.168.5.9', port: 47772
  }, true);
  assert.equal(store.get().host.lastDeviceId, 'win-1');
  assert.ok(store.get().rememberedDevices[0].lastConnected);

  const reloaded = new ConfigStore(directory);
  assert.equal(reloaded.get().rememberedDevices[0].host, '192.168.5.9');
  reloaded.forgetDevice('win-1');
  assert.equal(reloaded.get().rememberedDevices.length, 0);
  assert.equal(reloaded.get().host.lastDeviceId, null);
});

test('invalid persisted values fall back safely', (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
    host: { width: 1, height: 'huge', fps: 500 },
    receiver: { id: 'stable', name: '\u0000', port: 90_000 },
    rememberedDevices: [{ id: 'bad', host: '8.8.8.8', port: 47772 }]
  }));
  const state = new ConfigStore(directory).get();
  assert.equal(state.host.width, 1920);
  assert.equal(state.receiver.id, 'stable');
  assert.equal(state.receiver.port, 47772);
  assert.deepEqual(state.rememberedDevices, []);
});

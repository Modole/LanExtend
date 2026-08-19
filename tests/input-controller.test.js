'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardSync, macKeyCodeToWindowsVk } = require('../src/core/input-controller');

test('Mac physical keys map to Windows shortcuts and navigation keys', () => {
  assert.equal(macKeyCodeToWindowsVk(8), 0x43);
  assert.equal(macKeyCodeToWindowsVk(55), 0xA2);
  assert.equal(macKeyCodeToWindowsVk(123), 0x25);
  assert.equal(macKeyCodeToWindowsVk(10_000), null);
});

test('clipboard synchronization sends changes and does not echo remote text', () => {
  let local = 'first';
  const sent = [];
  const sync = new ClipboardSync({
    readText: () => local,
    writeText: (text) => { local = text; },
    send: (message) => sent.push(message),
    origin: 'test',
    intervalMs: 60_000
  });
  sync.start(true);
  assert.equal(sent[0].text, 'first');
  local = 'second';
  assert.equal(sync.poll(), true);
  assert.equal(sent[1].text, 'second');
  sync.applyRemote({ text: 'remote' });
  assert.equal(local, 'remote');
  assert.equal(sync.poll(), false);
  assert.equal(sent.length, 2);
  sync.stop();
});

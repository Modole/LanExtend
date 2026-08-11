'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_DISCONNECT_REASON_BYTES,
  isPrivateIPv4,
  makeBeacon,
  makeSignal,
  parseBeacon,
  parseSignalMessage,
  sanitizeName,
  truncateUtf8
} = require('../src/core/protocol');

test('private IPv4 validation accepts LAN ranges and rejects public/invalid values', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.10', '127.0.0.1']) {
    assert.equal(isPrivateIPv4(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '192.167.1.1', 'localhost', '::1']) {
    assert.equal(isPrivateIPv4(address), false, address);
  }
});

test('beacon round-trips and uses packet source as host', () => {
  const beacon = makeBeacon({ id: 'receiver-1', name: '会议室\n屏幕', port: 47772 });
  const parsed = parseBeacon(Buffer.from(JSON.stringify(beacon)), '192.168.20.8');
  assert.equal(parsed.id, 'receiver-1');
  assert.equal(parsed.name, '会议室屏幕');
  assert.equal(parsed.host, '192.168.20.8');
  assert.equal(parsed.online, true);
  assert.equal(parsed.authMode, 'none');
  assert.throws(
    () => parseBeacon(Buffer.from(JSON.stringify(beacon)), '8.8.8.8'),
    /内网范围/
  );
});

test('signal validation accepts SDP and ICE messages', () => {
  const offer = makeSignal('offer', { sdp: { type: 'offer', sdp: 'v=0\r\n' } });
  assert.deepEqual(parseSignalMessage(JSON.stringify(offer)), offer);
  const ice = makeSignal('ice', {
    candidate: { candidate: 'candidate:1 1 UDP 1 192.168.1.3 5000 typ host' }
  });
  assert.deepEqual(parseSignalMessage(JSON.stringify(ice)), ice);
});

test('signal validation rejects unknown type, wrong version and oversized name', () => {
  assert.throws(() => parseSignalMessage('{"type":"root","protocol":1}'), /不支持/);
  assert.throws(() => parseSignalMessage('{"type":"ping","protocol":2,"timestamp":1}'), /版本/);
  assert.throws(() => parseSignalMessage(JSON.stringify({
    type: 'hello', protocol: 1, hostId: 'x', name: 'a'.repeat(65)
  })), /主端信息/);
});

test('disconnect reasons use a bounded UTF-8 representation', () => {
  const accepted = makeSignal('disconnect', { reason: '中'.repeat(MAX_DISCONNECT_REASON_BYTES / 3) });
  assert.deepEqual(parseSignalMessage(JSON.stringify(accepted)), accepted);
  assert.throws(
    () => parseSignalMessage(JSON.stringify(makeSignal('disconnect', {
      reason: '🧪'.repeat((MAX_DISCONNECT_REASON_BYTES / 4) + 1)
    }))),
    /断开原因/
  );
  const truncated = truncateUtf8('🧪'.repeat(100), 123);
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 123);
  assert.equal(truncated.includes('\ufffd'), false);
});

test('name sanitizer removes control characters and enforces fallback', () => {
  assert.equal(sanitizeName('  A\u0000B\n  '), 'AB');
  assert.equal(sanitizeName('   ', 'fallback'), 'fallback');
});

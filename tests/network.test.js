'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WebSocket } = require('ws');
const { SignalServer, intToIpv4, ipv4ToInt } = require('../src/core/network');
const { makeSignal } = require('../src/core/protocol');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.once(event, resolve);
    if (event !== 'error') target.once('error', reject);
  });
}

test('IPv4 integer conversion round-trips', () => {
  for (const address of ['0.0.0.0', '10.20.30.40', '192.168.255.1', '255.255.255.255']) {
    assert.equal(intToIpv4(ipv4ToInt(address)), address);
  }
});

test('signal server welcomes one host and forwards validated messages', async (t) => {
  const port = await unusedPort();
  const server = new SignalServer({ id: 'receiver-1', name: 'Windows', port }, {
    host: '127.0.0.1', port
  });
  await server.start();
  t.after(() => server.stop());

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const first = await once(socket, 'message');
  const welcome = JSON.parse(first.toString());
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.receiver.id, 'receiver-1');

  const received = once(server, 'message');
  socket.send(JSON.stringify(makeSignal('hello', { hostId: 'mac-1', name: 'Mac' })));
  const event = await received;
  assert.equal(event.message.type, 'hello');

  const response = once(socket, 'message');
  assert.equal(server.send(event.sessionId, makeSignal('pong', { timestamp: 123 })), true);
  assert.equal(JSON.parse((await response).toString()).type, 'pong');
  socket.close();
});

test('signal server rejects a second concurrent host', async (t) => {
  const port = await unusedPort();
  const server = new SignalServer({ id: 'receiver-1', name: 'Windows', port }, {
    host: '127.0.0.1', port
  });
  await server.start();
  t.after(() => server.stop());
  const first = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(first, 'message');
  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  const code = await once(second, 'close');
  assert.equal(code, 1013);
  first.close();
});

test('signal server rejects browser origins outside the packaged app', async (t) => {
  const port = await unusedPort();
  const server = new SignalServer({ id: 'receiver-1', name: 'Windows', port }, {
    host: '127.0.0.1', port
  });
  await server.start();
  t.after(() => server.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: 'https://untrusted.example'
  });
  const code = await once(socket, 'close');
  assert.equal(code, 1008);
});

test('signal server requires hello before SDP or ICE', async (t) => {
  const port = await unusedPort();
  const server = new SignalServer({ id: 'receiver-1', name: 'Windows', port }, {
    host: '127.0.0.1', port
  });
  await server.start();
  t.after(() => server.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'message');
  socket.send(JSON.stringify(makeSignal('offer', {
    sdp: { type: 'offer', sdp: 'v=0\r\n' }
  })));
  const code = await once(socket, 'close');
  assert.equal(code, 1008);
});

test('signal server safely truncates multibyte WebSocket close reasons', async (t) => {
  const port = await unusedPort();
  const server = new SignalServer({ id: 'receiver-1', name: 'Windows', port }, {
    host: '127.0.0.1', port
  });
  await server.start();
  t.after(() => server.stop());

  const connected = once(server, 'connected');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, 'message');
  const session = await connected;
  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  assert.equal(server.disconnect(session.id, '🧪'.repeat(100)), true);
  const event = await closed;
  assert.equal(event.code, 1000);
  assert.ok(Buffer.byteLength(event.reason, 'utf8') <= 123);
  assert.equal(event.reason.includes('\ufffd'), false);
});

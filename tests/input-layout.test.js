'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InputLayoutRouter,
  defaultRemoteRect,
  findEntry,
  hasAdjacentEdge,
  snapRemoteRect
} = require('../src/core/input-layout');

const locals = [
  { id: 'top-left', x: 0, y: 0, width: 2560, height: 1080 },
  { id: 'bottom-left', x: 0, y: 1080, width: 2560, height: 1080 },
  { id: 'bottom-right', x: 2560, y: 1080, width: 2560, height: 1080 }
];
const remote = { id: 'windows', x: 2560, y: 0, width: 1920, height: 1080 };

test('default layout places Windows to the right of the top Mac display', () => {
  assert.deepEqual(defaultRemoteRect(locals, 1920, 1080, 'windows'), remote);
});

test('cursor enters Windows only through a touching edge and matching direction', () => {
  const entry = findEntry(locals, remote, { x: 2559, y: 400 }, { x: 8, y: 0 });
  assert.equal(entry.edge, 'right');
  assert.equal(entry.local.id, 'top-left');
  assert.deepEqual(entry.remotePoint, { x: 1, y: 400 });
  assert.equal(findEntry(locals, remote, { x: 2559, y: 400 }, { x: -8, y: 0 }), null);
});

test('router returns to the adjacent Mac display through the reciprocal edge', () => {
  const router = new InputLayoutRouter({ locals, remote });
  assert.ok(router.tryEnter({ x: 2559, y: 400 }, { x: 4, y: 0 }));
  const exited = router.move(-8, 0);
  assert.equal(exited.exited, true);
  assert.equal(exited.local.id, 'top-left');
  assert.equal(exited.localPoint.x, 2558);
});

test('dragged Windows layout snaps to a nearby Mac edge', () => {
  const snapped = snapRemoteRect({ ...remote, x: 2608, y: 100 }, locals, 80);
  assert.equal(snapped.x, 2560);
  assert.equal(snapped.y, 100);
});

test('input sharing requires a real overlapping display edge', () => {
  const single = [{ id: 'mac', x: 0, y: 0, width: 1920, height: 1080 }];
  assert.equal(hasAdjacentEdge(single, { x: 1920, y: 200, width: 1920, height: 1080 }), true);
  assert.equal(hasAdjacentEdge(single, { x: 1920, y: 1080, width: 1920, height: 1080 }), false);
  assert.equal(hasAdjacentEdge(single, { x: 2400, y: 0, width: 1920, height: 1080 }), false);
});

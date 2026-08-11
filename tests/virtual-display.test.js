'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDisplayOptions } = require('../src/core/virtual-display');

test('virtual display options are normalized', () => {
  assert.deepEqual(validateDisplayOptions({
    width: 1920,
    height: 1080,
    fps: 60,
    hiDPI: true,
    name: 'Remote\nDisplay',
    serial: 123
  }), {
    width: 1920,
    height: 1080,
    fps: 60,
    hiDPI: true,
    name: 'RemoteDisplay',
    serial: 123
  });
});

test('virtual display rejects unsafe or unsupported dimensions', () => {
  assert.throws(() => validateDisplayOptions({ width: 1919, height: 1080, fps: 30 }), /偶数/);
  assert.throws(() => validateDisplayOptions({ width: 1920, height: 599, fps: 30 }), /高度/);
  assert.throws(() => validateDisplayOptions({ width: 1920, height: 1080, fps: 120 }), /刷新率/);
  assert.throws(
    () => validateDisplayOptions({ width: 7680, height: 4320, fps: 30, hiDPI: true }),
    /帧缓冲区/
  );
});

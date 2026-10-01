import assert from 'node:assert/strict';
import test from 'node:test';
import { HostBlink } from '../src/host-blink.js';

const config = { blinkInterval: 4000, blinkIntervalRandom: 1000,
  closingDuration: 100, closedDuration: 50, openingDuration: 150 };

test('host blink uses the WebGAL symmetric random interval and zero floor', () => {
  for (const [random, expected] of [[0, 3000], [0.125, 3250], [0.5, 4000], [0.875, 4750], [1, 5000]]) {
    const blink = new HostBlink(config, () => random);
    assert.equal(blink.nextBlinkTimeLeft, expected);
  }
  assert.equal(new HostBlink({ ...config, blinkInterval: 300 }, () => 0.125).nextBlinkTimeLeft, 0);
  assert.equal(new HostBlink({}, () => 0.5).nextBlinkTimeLeft, 86400000);
});

test('host blink preserves C2 strict Idle boundary and one phase per frame', () => {
  const randomValues = [0.5, 0.125];
  let calls = 0;
  const blink = new HostBlink(config, () => randomValues[calls++]);
  assert.equal(blink.update(4000), 0);
  assert.equal(blink.eyeState, 'Idle');
  assert.equal(calls, 1);
  assert.equal(blink.update(37), 0);
  assert.equal(blink.eyeState, 'Closing');
  assert.equal(blink.nextBlinkTimeLeft, 3250);
  assert.equal(calls, 2);
  assert.ok(Math.abs(blink.update(37) - 0.37) < 1e-12);
  assert.equal(blink.update(63), 1);
  assert.equal(blink.eyeState, 'Closed');
  assert.equal(blink.closedTimer, 0);
  assert.equal(blink.update(23), 1);
  assert.equal(blink.eyeState, 'Closed');
  assert.equal(blink.update(27), 1);
  assert.equal(blink.eyeState, 'Opening');
  assert.ok(Math.abs(blink.update(45) - 0.7) < 1e-12);
  assert.equal(blink.update(105), 0);
  assert.equal(blink.eyeState, 'Idle');
  assert.equal(blink.nextBlinkTimeLeft, 3250);
  assert.equal(calls, 2);
});

test('host blink discards overshoot instead of advancing multiple states', () => {
  const blink = new HostBlink({ ...config, blinkInterval: 0, blinkIntervalRandom: 0 }, () => 0.5);
  assert.equal(blink.update(1), 0);
  assert.equal(blink.update(1000), 1);
  assert.equal(blink.eyeState, 'Closed');
  assert.equal(blink.closedTimer, 0);
  assert.equal(blink.update(1000), 1);
  assert.equal(blink.eyeState, 'Opening');
  assert.equal(blink.update(1000), 0);
  assert.equal(blink.eyeState, 'Idle');
  assert.equal(blink.update(0), 0);
  assert.equal(blink.eyeState, 'Idle');
});

test('changing blink parameters recalculates interval without resetting an active blink', () => {
  const blink = new HostBlink({ ...config, blinkInterval: 0, blinkIntervalRandom: 0 }, () => 0.125);
  blink.update(1);
  blink.update(37);
  blink.setParameters(config);
  assert.equal(blink.eyeState, 'Closing');
  assert.equal(blink.eyeParamValue, 0.63);
  assert.equal(blink.nextBlinkTimeLeft, 3250);
  blink.update(63);
  blink.update(23);
  blink.setParameters({ blinkInterval: 5000 });
  assert.equal(blink.eyeState, 'Closed');
  assert.equal(blink.closedTimer, 23);
  assert.equal(blink.nextBlinkTimeLeft, 4250);
  assert.equal(blink.update(27), 1);
  assert.equal(blink.eyeState, 'Opening');
});

test('zero phase durations retain C2 next-update transitions for positive deltas', () => {
  const blink = new HostBlink({ blinkInterval: 0, blinkIntervalRandom: 0,
    closingDuration: 0, closedDuration: 0, openingDuration: 0 }, () => 0.5);
  assert.equal(blink.update(1), 0);
  assert.equal(blink.update(1), 1);
  assert.equal(blink.eyeState, 'Closed');
  assert.equal(blink.update(1), 1);
  assert.equal(blink.eyeState, 'Opening');
  assert.equal(blink.update(1), 0);
  assert.equal(blink.eyeState, 'Idle');
});

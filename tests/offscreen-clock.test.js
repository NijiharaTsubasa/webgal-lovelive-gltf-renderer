import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OffscreenCharacter } from '../src/offscreen-character.js';
import { ModelPhysics } from '../src/model-physics.js';
import { HostBlink } from '../src/host-blink.js';

function actorFixture(update = () => {}) {
  const calls = [];
  const actor = Object.assign(Object.create(OffscreenCharacter.prototype), {
    disposed: false,
    blink: { update(ms) { calls.push(['blink', ms]); } },
    applyHostInputs() { calls.push(['inputs']); },
    character: { update(delta) { calls.push(['animation', delta]); update(delta); },
      render() { calls.push(['render']); } },
  });
  return { actor, calls };
}

test('offscreen forwards complete animation intervals while retaining the blink cap', () => {
  for (const delta of [0, .025, .05, .1, .15, .25, 5, -1]) {
    const { actor, calls } = actorFixture();
    actor.update(delta);
    assert.deepEqual(calls, [['blink', Math.min(Math.max(0, delta), .1) * 1000],
      ['inputs'], ['animation', Math.max(0, delta)], ['render']]);
  }
});

test('non-finite clocks fail before mutating blink or animation; disposed actors stay inert', () => {
  const { actor, calls } = actorFixture();
  for (const delta of [NaN, Infinity, -Infinity]) assert.throws(() => actor.update(delta), /finite/);
  assert.deepEqual(calls, []);
  actor.disposed = true;
  actor.update(NaN);
  assert.deepEqual(calls, []);
});

test('offscreen reaches the existing two-step recovery without losing animation time', () => {
  const root = new THREE.Group(), bone = new THREE.Object3D();
  root.add(bone);
  const physics = new ModelPhysics(root, [{ physics: { colliders: [], springs: [{
    node: 0, tail: [0, -.5, 0], radius: .01, stiffness: 1.5,
    damping: .8, gravity: [0, 0, 0], colliders: [],
  }] }, resolve: () => bone }]);
  try {
    physics.advance(0, () => {});
    let time = 0, steps = 0, poses = 0;
    const step = physics.step.bind(physics);
    physics.step = () => { steps++; step(); };
    const { actor } = actorFixture(delta => physics.advance(delta, dt => { time += dt; poses++; }));
    actor.update(.005);
    actor.update(.25);
    actor.update(5);
    assert.ok(Math.abs(time - 5.255) < 1e-12);
    assert.equal(poses, 2);
    assert.equal(steps, 4);
    assert.equal(physics.frameAccumulator, 0);
  } finally { physics.destroy(); }
});

test('a long interval preserves the blink single-branch transition and discarded overshoot', () => {
  const { actor } = actorFixture();
  actor.blink = new HostBlink({ blinkInterval: 0, blinkIntervalRandom: 0 }, () => .5);
  actor.update(5);
  assert.equal(actor.blink.eyeState, 'Closing');
  assert.equal(actor.blink.eyeParamValue, 1);
  actor.update(5);
  assert.equal(actor.blink.eyeState, 'Closed');
  assert.equal(actor.blink.closedTimer, 0);
});

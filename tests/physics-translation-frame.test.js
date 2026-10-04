import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ModelPhysics } from '../src/model-physics.js';

const STEP = 1 / 60;

function fixture(scale = 1) {
  const root = new THREE.Group();
  root.scale.setScalar(scale);
  const hips = new THREE.Object3D(); hips.name = 'Hips';
  const head = new THREE.Object3D(); head.name = 'Head'; head.position.y = 1;
  const hair = new THREE.Object3D(); hair.position.z = -.1;
  root.add(hips); hips.add(head); head.add(hair);
  const sim = new ModelPhysics(root, [{
    physics: { colliders: [], springs: [{
      node: 0, tail: [0, -.5, 0], radius: .01,
      stiffness: 1.5, damping: .8, gravity: [0, 0, 0], colliders: [],
    }] },
    resolve: () => hair,
  }]);
  sim.advance(0, () => {});
  return { root, hips, head, hair, sim };
}

function sameRotation(a, b, message) {
  assert.ok(a.angleTo(b) < 1e-6, `${message}: angular difference ${a.angleTo(b)}`);
}

test('continuous whole-rig translation preserves local spring motion at different scales', () => {
  for (const scale of [.01, 1, 100]) {
    const stationary = fixture(scale), moving = fixture(scale);
    try {
      for (let frame = 0; frame < 120; frame++) {
        const rotation = .35 * Math.sin(frame * STEP * 3);
        stationary.sim.advance(STEP, () => { stationary.head.rotation.x = rotation; });
        moving.sim.advance(STEP, () => {
          moving.head.rotation.x = rotation;
          moving.hips.position.set(frame * .005, Math.sin(frame * .08) * .03, -frame * .025);
        });
        sameRotation(moving.hair.quaternion, stationary.hair.quaternion,
          `scale ${scale}, frame ${frame}: common translation must not bend the hair`);
      }
    } finally {
      stationary.sim.destroy(); moving.sim.destroy();
    }
  }
});

test('head rotation retains secondary motion while the common translation is removed', () => {
  const stationary = fixture(), moving = fixture();
  try {
    stationary.sim.advance(STEP, () => { stationary.head.rotation.x = .6; });
    moving.sim.advance(STEP, () => {
      moving.head.rotation.x = .6;
      moving.hips.position.set(.1, .1, -.2);
    });
    assert.ok(stationary.hair.quaternion.angleTo(new THREE.Quaternion()) > .05,
      'local head rotation must still produce spring lag');
    sameRotation(moving.hair.quaternion, stationary.hair.quaternion,
      'the local head response must remain the same during travel');
  } finally {
    stationary.sim.destroy(); moving.sim.destroy();
  }
});

test('whole-rig teleport still resets once and recovers to the new pose', () => {
  for (const scale of [.01, 1, 100]) {
    const live = fixture(scale), fresh = fixture(scale);
    let resets = 0;
    const joint = live.sim.records[0].joint;
    const reset = joint.reset.bind(joint);
    joint.reset = () => { resets++; reset(); };
    try {
      for (let frame = 0; frame < 20; frame++) {
        live.sim.advance(STEP, () => {
          live.head.rotation.x = .3 * Math.sin(frame * .2);
          live.hips.position.z -= .025;
        });
      }
      assert.equal(resets, 0, 'continuous travel must not repeatedly reset springs');
      live.sim.advance(STEP, () => {
        live.hips.position.set(12, 3, -4);
        live.head.rotation.x = -.4;
      });
      assert.equal(resets, 1, `scale ${scale}: teleport must reset exactly once`);
      fresh.hips.position.copy(live.hips.position);
      fresh.head.rotation.copy(live.head.rotation);
      fresh.sim.reset(2);
      fresh.sim.advance(STEP, () => {});
      sameRotation(live.hair.quaternion, fresh.hair.quaternion,
        `scale ${scale}: recovery must match a fresh solver at the destination`);
      assert.ok(live.hair.quaternion.toArray().every(Number.isFinite));
    } finally {
      live.sim.destroy(); fresh.sim.destroy();
    }
  }
});

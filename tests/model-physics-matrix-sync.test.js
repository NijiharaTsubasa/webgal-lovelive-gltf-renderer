import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ModelPhysics } from '../src/model-physics.js';

function fixture(alwaysRefresh = false, Physics = ModelPhysics) {
  const outer = new THREE.Group(), root = new THREE.Group(), chest = new THREE.Group();
  outer.scale.set(1.3, .9, 1.1); outer.rotation.set(.1, .2, -.1);
  outer.add(root); root.add(chest); chest.rotation.set(.1, -.1, .2);
  const left = new THREE.Object3D(), right = new THREE.Object3D(), child = new THREE.Object3D();
  left.position.x = -.45; right.position.x = .45; child.position.y = -.4;
  chest.add(left, right); left.add(child);
  const body = new THREE.Object3D(); body.position.y = -1; chest.add(body);
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  root.add(mesh);
  const nodes = [left, right, child, body];
  const physics = {
    colliders: [{ shape: 'capsule', node: 3, offset: [0, -.1, 0], radius: .22, tail: { node: 3, offset: [0, .1, 0] } }],
    // Deliberately declare the child first; the solver must still sort parents first.
    springs: [2, 0, 1].map(node => ({ node, tail: [0, node === 2 ? -.35 : -1, 0], radius: .03,
      stiffness: 1, damping: .8, gravity: [0, -.02, 0], colliders: [0] })),
    collisionEdges: [{ springs: [1, 2], colliders: [0] }],
  };
  outer.updateMatrixWorld(true);
  const sim = new Physics(root, [{ physics, resolve: i => nodes[i] }]);
  if (alwaysRefresh) outer.traverse(node => {
    const original = node.updateWorldMatrix;
    node.updateWorldMatrix = function(_parents, children, force) { return original.call(this, true, children, force); };
  });
  return { outer, root, chest, nodes, body, mesh, sim };
}

function snapshot(f) {
  return {
    nodes: f.nodes.map(n => [n.quaternion.toArray(), n.matrixWorld.toArray()]),
    records: f.sim.records.map(r => [r.bone.quaternion.toArray(), r.anchor.matrixWorld.toArray()]),
    colliders: f.sim.colliders.map(r => [r.shape.offset.toArray(), r.shape.tail.toArray(), r.shape.radius]),
    bind: f.mesh.bindMatrixInverse.toArray(),
  };
}

function animate(f, i) {
  f.outer.position.x = Math.sin(i * .03) * .1;
  f.outer.rotation.y = Math.sin(i * .02) * .15;
  f.chest.rotation.z = Math.sin(i * .06) * .12;
  f.nodes[0].rotation.x = Math.sin(i * .04) * .08;
  f.nodes[1].rotation.z = Math.cos(i * .05) * .1;
}

test('physics synchronized steps match forced ancestor refresh with moving parents, chains and edges', () => {
  const fast = fixture(), refreshed = fixture(true);
  for (let i = 0; i < 90; i++) {
    if (i === 35) { fast.sim.reset(); refreshed.sim.reset(); }
    const dt = i === 60 ? .25 : 1 / 60;
    for (const f of [fast, refreshed]) f.sim.advance(dt, () => animate(f, i), () => {
      // Model a Behavior changing a parent after physics; syncPose must see it.
      if (i % 7 === 0) f.chest.rotation.y += .025;
    });
    assert.deepEqual(snapshot(fast), snapshot(refreshed), `frame ${i}`);
  }
  fast.sim.destroy(); refreshed.sim.destroy();
});

test('public physics methods refresh changed ancestors and preserve SkinnedMesh bind updates', () => {
  for (const method of ['updateColliders', 'step', 'solveCollisionEdges', 'syncPose', 'update']) {
    const lazy = fixture(), flushed = fixture();
    for (const f of [lazy, flushed]) {
      f.sim.advance(0, () => {});
      f.outer.position.set(.5, -.2, .3); f.outer.rotation.y = .6;
      f.body.position.z = .08; f.root.position.y = .15;
    }
    flushed.outer.updateMatrixWorld(true);
    for (const f of [lazy, flushed]) f.sim[method](...(method === 'update' ? [1 / 60] : []));
    if (method === 'updateColliders') {
      assert.deepEqual(snapshot(lazy).colliders, snapshot(flushed).colliders);
    } else {
      assert.deepEqual(snapshot(lazy), snapshot(flushed), method);
      assert.deepEqual(lazy.mesh.bindMatrixInverse.toArray(), lazy.mesh.matrixWorld.clone().invert().toArray());
    }
    lazy.sim.destroy(); flushed.sim.destroy();
  }
});

test('internal collider sampling does not repeatedly refresh the outer parent', () => {
  const f = fixture(); f.sim.advance(0, () => {});
  let parents = 0;
  const update = f.outer.updateWorldMatrix;
  f.outer.updateWorldMatrix = function(...args) { parents++; return update.apply(this, args); };
  f.sim.refreshWorldMatrices(); parents = 0;
  for (let i = 0; i < 10; i++) f.sim.updateColliders(true);
  assert.equal(parents, 0);
  f.body.position.x += .1; f.sim.updateColliders();
  assert.ok(parents > 0);
  f.sim.destroy();
});

test('snapshot fast path refreshes resolved bones and capsule endpoints outside the root after reparenting', () => {
  const lazy = fixture(), flushed = fixture();
  for (const f of [lazy, flushed]) {
    const sibling = new THREE.Group(), tailParent = new THREE.Group(), tail = new THREE.Object3D();
    f.outer.add(sibling, tailParent); sibling.add(f.body, f.nodes[0]); tailParent.add(tail);
    f.sim.colliders[0].tailNode = tail;
    f.sibling = sibling; f.tailParent = tailParent;
  }
  for (let i = 0; i < 60; i++) {
    for (const f of [lazy, flushed]) {
      f.sim.beforeAnimation();
      f.sibling.position.x = Math.sin(i * .02) * .15;
      f.sibling.rotation.z = Math.sin(i * .04) * .12;
      f.tailParent.position.set(.03, -.9, Math.cos(i * .03) * .1);
      f.tailParent.scale.set(1, .9 + i / 300, 1.1);
    }
    flushed.outer.updateMatrixWorld(true);
    lazy.sim.update(1 / 60); flushed.sim.update(1 / 60);
    assert.deepEqual(snapshot(lazy), snapshot(flushed), `external frame ${i}`);
  }
  lazy.sim.destroy(); flushed.sim.destroy();
});

test('teleport detection refreshes Hips reparented outside every physics-owned subtree', () => {
  const scene = new THREE.Group(), root = new THREE.Group(), external = new THREE.Group();
  scene.add(root, external);
  const hips = new THREE.Object3D(); hips.name = 'Hips';
  const head = new THREE.Object3D(); head.name = 'Head'; head.position.y = 1;
  const spring = new THREE.Object3D(); spring.position.y = .8;
  root.add(hips, spring); hips.add(head);
  const sim = new ModelPhysics(root, [{ physics: {
    colliders: [], springs: [{ node: 0, tail: [0, -.4, 0], radius: .01,
      stiffness: 1, damping: .8, gravity: [0, 0, 0], colliders: [] }],
  }, resolve: () => spring }]);
  sim.advance(0, () => {});
  let resets = 0;
  const reset = sim.records[0].joint.reset.bind(sim.records[0].joint);
  sim.records[0].joint.reset = () => { resets++; reset(); };
  external.add(hips);
  external.position.x = .01;
  sim.advance(1 / 60, () => {});
  assert.equal(sim.previousReferencePosition.x, .01, 'ordinary movement must read the external parent transform');
  assert.equal(resets, 0, 'ordinary movement must retain particle state');
  external.position.x = 3;
  sim.advance(1 / 60, () => {});
  assert.equal(sim.previousReferencePosition.x, 3);
  assert.equal(resets, 1, 'external Hips teleport must reset the solver');
  assert.equal(sim.warmupSteps, 2, 'teleports retain the existing two-step recovery');
  sim.destroy();
});

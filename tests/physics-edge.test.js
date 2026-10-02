import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ModelPhysics, validatePhysics } from "../src/model-physics.js";
import { PhysicsEdgeContact } from "../src/physics-edge.js";

function fixture(shape = "sphere", scale = 1, edges = true) {
  const root = new THREE.Group(); root.scale.setScalar(scale); root.rotation.set(.2, .3, -.1);
  const bones = [-.45, .45].map((x) => { const bone = new THREE.Object3D(); bone.position.set(x, 0, 0); root.add(bone); return bone; });
  const body = new THREE.Object3D(); body.position.set(0, -1, 0); root.add(body);
  const collider = { shape, node: 2, offset: [0, 0, 0], radius: .22 };
  if (shape === "capsule") { collider.offset = [0, -.15, 0]; collider.tail = { node: 2, offset: [0, .15, 0] }; }
  const physics = { colliders: [collider], springs: bones.map((_, node) => ({ node, tail: [0, -1, 0], radius: .03,
    stiffness: 1, damping: .8, gravity: [0, 0, 0], colliders: [0] })) };
  if (edges) physics.collisionEdges = [{ springs: [0, 1], colliders: [0] }];
  const nodes = [...bones, body];
  const sim = new ModelPhysics(root, [{ physics, resolve: (i) => nodes[i] }]);
  const distance = () => {
    const [a, b] = bones.map((bone) => bone.localToWorld(new THREE.Vector3(0, -1, 0)));
    return new PhysicsEdgeContact().query(a, b, .03 * scale, .03 * scale, sim.colliders[0]).distance;
  };
  return { root, bones, physics, sim, distance };
}

test("collision edge detects middle penetration while both endpoints are clear", () => {
  for (const shape of ["sphere", "capsule"]) for (const scale of [.01, 1, 10]) {
    const original = fixture(shape, scale, false);
    original.sim.advance(0, () => {});
    assert.ok(original.distance() < -.24 * scale);
    const f = fixture(shape, scale);
    f.sim.advance(0, () => {});
    assert.ok(f.distance() > -1e-4 * scale, `${shape}/${scale}: ${f.distance()}`);
    for (const bone of f.bones) assert.ok(Math.abs(bone.localToWorld(new THREE.Vector3(0, -1, 0)).distanceTo(bone.getWorldPosition(new THREE.Vector3())) - scale) < 1e-7 * scale);
    for (let i = 0; i < 120; i++) f.sim.advance(1 / 60, () => {});
    assert.ok(f.distance() > -1e-4 * scale);
    f.sim.reset(); f.sim.advance(0, () => {});
    assert.ok(f.distance() > -1e-4 * scale);
    f.sim.beforeAnimation();
    f.bones.forEach((bone) => assert.ok(bone.quaternion.angleTo(new THREE.Quaternion()) < 1e-7));
    f.sim.destroy(); original.sim.destroy();
  }
});

test("collision edges validate component-local spring indices", () => {
  const f = fixture();
  validatePhysics(f.physics);
  for (const edge of [{ springs: [0, 0], colliders: [0] }, { springs: [0, 2], colliders: [0] },
    { springs: [0, 1], colliders: [1] }, { springs: [0], colliders: [] }]) {
    assert.throws(() => validatePhysics({ ...f.physics, collisionEdges: [edge] }));
  }
  f.sim.destroy();
});

test("symmetric center contacts choose a feasible tangent rather than stretching the edge", () => {
  const f = fixture(); f.root.rotation.set(0, 0, 0);
  f.sim.reset(); f.sim.advance(0, () => {});
  assert.ok(f.distance() > -1e-4, `${f.distance()}`);
  f.sim.destroy();
});

test("ring edges settle, survive loops, and remain inexpensive at production-sized counts", () => {
  const root = new THREE.Group(), body = new THREE.Object3D(); body.position.y = -1;
  const bones = Array.from({ length: 8 }, (_, i) => {
    const node = new THREE.Object3D(); node.position.set(.45 * Math.cos(i * Math.PI / 4), 0, .45 * Math.sin(i * Math.PI / 4));
    root.add(node); return node;
  });
  root.add(body);
  const physics = { colliders: [{ shape: "sphere", node: 8, offset: [0, 0, 0], radius: .43 }],
    springs: bones.map((_, node) => ({ node, tail: [0, -1, 0], radius: .03, stiffness: 1,
      damping: .8, gravity: [0, 0, 0], colliders: [0] })),
    collisionEdges: bones.map((_, i) => ({ springs: [i, (i + 1) % 8], colliders: [0] })) };
  const nodes = [...bones, body], sim = new ModelPhysics(root, [{ physics, resolve: (i) => nodes[i] }]);
  sim.advance(0, () => {});
  const start = performance.now();
  for (let i = 0; i < 600; i++) {
    sim.advance(1 / 60, () => { root.position.z = (i % 60) / 60; });
    for (const bone of bones) assert.ok(bone.quaternion.toArray().every(Number.isFinite));
  }
  assert.ok(performance.now() - start < 3000, "600 steps of eight edges must finish within a conservative 3-second budget");
  const query = new PhysicsEdgeContact();
  for (const edge of physics.collisionEdges) {
    const [a, b] = edge.springs.map((i) => bones[i].localToWorld(new THREE.Vector3(0, -1, 0)));
    assert.ok(query.query(a, b, .03, .03, sim.colliders[0]).distance > -.002);
  }
  sim.destroy();
});

test("post-physics pose synchronization preserves animation base and corrected particles", () => {
  const f = fixture("sphere", 1, false);
  f.sim.advance(0, () => {});
  f.bones[0].rotation.x = -.4;
  const corrected = f.bones[0].quaternion.clone();
  f.sim.syncPose();
  assert.ok(f.bones[0].quaternion.angleTo(corrected) < 1e-7);
  f.sim.beforeAnimation();
  assert.ok(f.bones[0].quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
  f.sim.update(0);
  assert.ok(f.bones[0].quaternion.angleTo(corrected) < 1e-7);
  f.sim.destroy();
});

test("post-physics hook runs per fixed step and after discontinuity without accumulating a new base", () => {
  const f = fixture("sphere", 1, false), phases = [];
  const after = () => { phases.push("post"); f.bones[0].rotation.x = -.4; };
  f.sim.advance(.05, () => { phases.push("animate"); }, after);
  assert.deepEqual(phases, ["animate", "post", "animate", "post", "animate", "post"]);
  f.sim.beforeAnimation(); assert.ok(f.bones[0].quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
  phases.length = 0;
  f.sim.advance(1, () => { phases.push("animate"); }, after);
  assert.deepEqual(phases, ["animate", "post"]);
  f.sim.destroy();
});

test("tapered edges, planes, panels and collapsed edges have finite contacts", () => {
  const f = fixture();
  const query = new PhysicsEdgeContact();
  const a = new THREE.Vector3(-1, -1, 0), b = new THREE.Vector3(1, -1, 0);
  for (const shape of ["plane", "panel"]) {
    f.physics.colliders[0] = shape === "plane"
      ? { shape, node: 2, offset: [0, 0, 0], normal: [0, 0, 1] }
      : { shape, node: 2, offset: [0, 0, 0], halfAxes: [[.2, 0, 0], [0, .2, 0]] };
    const nodes = [...f.bones, f.root.children[2]];
    const sim = new ModelPhysics(f.root, [{ physics: f.physics, resolve: (i) => nodes[i] }]);
    query.query(a, b, .01, .08, sim.colliders[0]);
    assert.ok(Number.isFinite(query.distance)); assert.ok(query.normal.toArray().every(Number.isFinite));
    query.query(a, a, .01, .08, sim.colliders[0]);
    assert.ok(Number.isFinite(query.distance));
    sim.destroy();
  }
  f.sim.destroy();
});

test("a narrow finite panel crossing between sample locations still collides", () => {
  const root = new THREE.Group(), bone = new THREE.Object3D(), panel = new THREE.Object3D();
  panel.position.x = .1234567; root.add(bone, panel);
  const physics = { springs: [], colliders: [{ shape: "panel", node: 1, offset: [0, 0, 0],
    halfAxes: [[.00001, 0, 0], [0, .2, 0]] }] };
  const sim = new ModelPhysics(root, [{ physics, resolve: (i) => [bone, panel][i] }]);
  const contact = new PhysicsEdgeContact().query(new THREE.Vector3(-1, 0, -.1), new THREE.Vector3(1, 0, -.1),
    .01, .01, sim.colliders[0]);
  assert.ok(contact.distance < -.1099, `${contact.distance}`);
  assert.ok(contact.normal.toArray().every(Number.isFinite));
  sim.destroy();
});

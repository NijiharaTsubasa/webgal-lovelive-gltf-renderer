import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ModelPhysics, validatePhysics, createModelPhysics, maximumStretch } from "../src/model-physics.js";
import { composeHumanoidHeadBody } from "../src/skeleton-composer.js";
import { PhysicsPanelShape } from "../src/physics-panel.js";

test("finite panels accept independent half axes and reject degenerate geometry", () => {
  const panel = { shape: "panel", node: 0, offset: [0, 0, 0], halfAxes: [[1, 0, 0], [.3, 1, 0]] };
  validatePhysics({ colliders: [panel], springs: [] });
  for (const halfAxes of [undefined, [], [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [-2, 0, 0]], [[1, NaN, 0], [0, 1, 0]]]) {
    assert.throws(() => validatePhysics({ colliders: [{ ...panel, halfAxes }], springs: [] }), /halfAxes/);
  }
});

test("finite panels resolve front/back interior, rounded edges and corners, but not distant outside points", () => {
  const shape = new PhysicsPanelShape(), matrix = new THREE.Matrix4(), normal = new THREE.Vector3();
  const query = (point, expected, expectedNormal) => {
    const distance = shape.calculateCollision(matrix, new THREE.Vector3(...point), .2, normal);
    assert.ok(Math.abs(distance - expected) < 1e-10, `${point}: ${distance} vs ${expected}`);
    assert.ok(normal.toArray().every(Number.isFinite));
    if (expectedNormal) assert.ok(normal.distanceTo(new THREE.Vector3(...expectedNormal)) < 1e-10);
  };
  query([.3, .5, .1], -.1, [0, 0, 1]);
  query([.3, .5, -.7], -.9, [0, 0, 1]);
  query([0, 0, 0], -.2, [0, 0, 1]);
  query([1.1, 0, 0], -.1, [1, 0, 0]);
  query([1.1, 1.1, 0], Math.sqrt(.02) - .2);
  query([3, 0, -.1], Math.sqrt(4.01) - .2);
  query([0, 0, .4], .2, [0, 0, 1]);
});

test("finite panel closest edge is correct under affine skew and rotation", () => {
  const shape = new PhysicsPanelShape(), normal = new THREE.Vector3();
  shape.halfAxes[1].set(1, 1, 0);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.4, -.8, .3));
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(.3, .4, -.5), rotation, new THREE.Vector3(2, 2, 2));
  // Closest point on u=1 edge to (2,0) is (1.5,.5), not (1,0).
  const point = new THREE.Vector3(2, 0, 0).applyMatrix4(matrix);
  const distance = shape.calculateCollision(matrix, point, .2, normal);
  assert.ok(Math.abs(distance - (Math.sqrt(2) - .2)) < 1e-10);
  assert.ok(normal.distanceTo(new THREE.Vector3(1, -1, 0).normalize().applyQuaternion(rotation)) < 1e-10);
});

test("panel binding and animated nonuniform transforms preserve finite half axes without metadata mutation", async () => {
  const f = fixture(); f.body.name = "Hips";
  const discarded = new THREE.Object3D(); discarded.name = "Hips";
  const binding = new THREE.Matrix4().makeScale(2, 1, .5).multiply(new THREE.Matrix4().makeRotationZ(.5));
  binding.setPosition(.1, .2, .3);
  f.body.rotation.set(.2, -.4, .1); f.body.scale.set(.5, 2, 1);
  f.physics.colliders[0] = { shape: "panel", node: 1, offset: [.2, .1, -.3], halfAxes: [[.4, 0, 0], [0, .3, 0]] };
  const original = structuredClone(f.physics);
  const sim = await createModelPhysics(f.root, [{ component: { name: "panel", physics: f.physics },
    nodeBindings: new Map([[discarded, { node: f.body, localMatrix: binding }]]),
    gltf: { parser: { getDependencies: async () => [f.bone, discarded] } } }]);
  const shape = sim.colliders[0].shape;
  for (const scale of [1, 1.3]) {
    f.body.scale.x = scale; sim.updateColliders();
    const world = f.body.matrixWorld.clone().multiply(binding), linear = new THREE.Matrix3().setFromMatrix4(world);
    assert.ok(shape.offset.distanceTo(new THREE.Vector3(...original.colliders[0].offset).applyMatrix4(world)) < 1e-12);
    shape.halfAxes.forEach((axis, i) => assert.ok(axis.distanceTo(new THREE.Vector3(...original.colliders[0].halfAxes[i]).applyMatrix3(linear)) < 1e-12));
    const n = shape.halfAxes[0].clone().cross(shape.halfAxes[1]).normalize();
    const query = shape.offset.clone().addScaledVector(n, -.1), out = new THREE.Vector3();
    assert.ok(Math.abs(shape.calculateCollision(sim.colliders[0].collider.colliderMatrix, query, .02, out) + .12) < 1e-10);
    assert.ok(out.distanceTo(n) < 1e-10);
  }
  assert.deepEqual(f.physics, original); sim.destroy();
});

function fixture() {
  const root = new THREE.Group();
  const bone = new THREE.Object3D(); bone.name = "skirt";
  const body = new THREE.Object3D(); body.position.set(0.15, -0.9, 0);
  root.add(bone, body);
  const physics = {
    colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: 0.25 }],
    springs: [{ node: 0, tail: [0, -1, 0], radius: 0.03, stiffness: 1, damping: 0.8, gravity: [0, 0, 0], colliders: [0] }],
  };
  const nodes = [bone, body];
  return { root, bone, body, physics, nodes, create: () => new ModelPhysics(root, [{ physics, resolve: (i) => nodes[i] }]) };
}

test("a frame-sized whole-character teleport settles springs at the new pose", () => {
  const make = (scale = 1) => {
    const root = new THREE.Group(); root.scale.setScalar(scale);
    const hips = new THREE.Object3D(); hips.name = "Hips";
    const head = new THREE.Object3D(); head.name = "Head"; head.position.y = 1;
    const hair = new THREE.Object3D(); hair.position.set(0, .8, -.1);
    root.add(hips); hips.add(head, hair);
    const sim = new ModelPhysics(root, [{ physics: { colliders: [], springs: [{
      node: 0, tail: [0, -.5, 0], radius: .01, stiffness: 1.5,
      damping: .8, gravity: [0, 0, 0], colliders: [],
    }] }, resolve: () => hair }]);
    return { root, hips, hair, sim };
  };
  for (const scale of [.01, 1, 100]) {
    const live = make(scale), fresh = make(scale);
    let resets = 0;
    const reset = live.sim.records[0].joint.reset.bind(live.sim.records[0].joint);
    live.sim.records[0].joint.reset = () => { resets++; reset(); };
    live.sim.advance(0, () => {});
    resets = 0;
    // Continuous travel retains inertia; only the discontinuous return resets.
    for (let i = 0; i < 60; i++) live.sim.advance(1 / 60, () => { live.hips.position.z -= .02; });
    assert.equal(resets, 0);
    live.sim.advance(.01, () => {});
    live.sim.advance(.02, () => { live.hips.position.z += 12; });
    assert.equal(resets, 1, `teleport at scale ${scale} must not become a physical impulse`);
    assert.ok(Math.abs(live.sim.frameAccumulator - (.03 - 1 / 60)) < 1e-10,
      'Teleport recovery must retain fractional animation time');
    fresh.hips.position.copy(live.hips.position);
    fresh.sim.reset(2); fresh.sim.advance(1 / 60, () => {});
    assert.ok(live.hair.quaternion.angleTo(fresh.hair.quaternion) < 1e-6);
    let steps = 0;
    live.sim.advance(1 / 300, () => { steps++; });
    assert.equal(steps, 1);
    live.sim.destroy(); fresh.sim.destroy();
  }
});

test("physics validates only current fields and rejects invalid references", () => {
  const { physics } = fixture();
  validatePhysics(physics);
  assert.throws(() => validatePhysics({ ...physics, springs: [{ ...physics.springs[0], colliders: [1] }] }));
  assert.throws(() => validatePhysics({ ...physics, springs: [{ ...physics.springs[0], tail: [0, 0, 0] }] }));
  assert.throws(() => validatePhysics({ ...physics, springs: [...physics.springs, ...physics.springs] }));
  assert.throws(() => validatePhysics({ ...physics, springs: [{ ...physics.springs[0], damping: 2 }] }));
});

test("cloth declarations validate mesh identity, pins and collision references", () => {
  const { physics } = fixture();
  const cloth = { node: 2, primitive: 0, fixed: [0, 1], radius: .003,
    stiffness: 12, damping: .8, gravity: [0, 0, 0], colliders: [0] };
  validatePhysics({ ...physics, springs: [], cloths: [cloth] });
  for (const invalid of [{ node: -1 }, { primitive: .5 }, { fixed: [0, 0] },
    { fixed: [-1] }, { fixed: [] }, { radius: NaN }, { stiffness: -1 }, { damping: 1.1 },
    { gravity: [0, Infinity, 0] }, { colliders: [1] }]) {
    assert.throws(() => validatePhysics({ ...physics, cloths: [{ ...cloth, ...invalid }] }));
  }
  assert.throws(() => validatePhysics({ ...physics, cloths: [cloth, cloth] }));
  assert.throws(() => validatePhysics({ ...physics, cloths: {} }));
});

test("mesh lifecycle follows bone update and shares restore/reset/dispose boundaries", () => {
  const f = fixture(), sim = f.create(), calls = [];
  sim.meshCloth = Object.fromEntries(["beforeAnimation", "update", "setEnabled", "reset", "destroy"]
    .map((name) => [name, () => calls.push(name)]));
  sim.beforeAnimation(); sim.update(1 / 60);
  assert.deepEqual(calls, ["beforeAnimation", "update"]);
  sim.setEnabled(false); calls.length = 0;
  sim.update(1 / 60);
  assert.deepEqual(calls, []);
  sim.destroy();
  assert.deepEqual(calls, ["beforeAnimation", "destroy"]);
});

test("model advance samples animation and colliders together on each fixed step", () => {
  const f = fixture(), sim = f.create(), times = [], observed = [];
  let time = 0;
  const update = sim.update.bind(sim);
  sim.update = (dt) => { observed.push({ dt, x: f.body.position.x }); update(dt); };
  sim.advance(.05, (dt) => { time += dt; times.push(time); f.body.position.x = time; });
  assert.equal(times.length, 3);
  assert.deepEqual(observed.map((v) => v.x), times);
  assert.ok(observed.every((v) => Math.abs(v.dt - 1 / 60) < 1e-12));
  sim.advance(1 / 120, (dt) => { time += dt; });
  assert.equal(observed.length, 3);
  sim.advance(1 / 120, (dt) => { time += dt; });
  assert.equal(observed.length, 4);
  assert.ok(Math.abs(time - 4 / 60) < 1e-12);
  sim.destroy();
});

test("background discontinuity preserves elapsed animation time and settles at the new pose", () => {
  const f = fixture(), sim = f.create();
  let time = 0;
  sim.advance(0, () => {});
  sim.advance(.005, (dt) => { time += dt; });
  sim.advance(5, (dt) => { time += dt; f.bone.position.x = time; });
  assert.ok(Math.abs(time - 5.005) < 1e-12);
  assert.equal(sim.needsReset, false);
  assert.equal(sim.frameAccumulator, 0);
  assert.ok(f.bone.quaternion.toArray().every(Number.isFinite));
  sim.destroy();
});

test("repeated long frames do not restart the thirty-step settling loop", () => {
  const f = fixture(), sim = f.create();
  sim.advance(0, () => {});
  let steps = 0, time = 0;
  const step = sim.step.bind(sim);
  sim.step = () => { steps += 1; step(); };
  for (let i = 0; i < 5; i += 1) sim.advance(.2, (dt) => { time += dt; });
  assert.equal(time, 1);
  assert.equal(steps, 10, `long frames must settle in two steps each, not thirty: ${steps}`);
  sim.destroy();
});

test("initial overlap is reduced without changing bone length or baseline", () => {
  const f = fixture(); const sim = f.create();
  const endpoint = () => f.bone.localToWorld(new THREE.Vector3(0, -1, 0));
  f.root.updateMatrixWorld(true);
  const before = endpoint().distanceTo(f.body.position);
  sim.update(1 / 60);
  const after = endpoint().distanceTo(f.body.position);
  assert.ok(after > before + 0.07, `${before} -> ${after}`);
  assert.ok(Math.abs(endpoint().length() - 1) < 1e-6);
  sim.beforeAnimation();
  assert.ok(f.bone.quaternion.angleTo(new THREE.Quaternion()) < 1e-8);
  sim.destroy();
});

test("animation remains the reference and toggle restores it", () => {
  const f = fixture(); const sim = f.create();
  for (let i = 0; i < 60; i += 1) {
    sim.beforeAnimation();
    f.bone.rotation.z = 0.15;
    sim.update(1 / 60);
    assert.ok(f.bone.quaternion.toArray().every(Number.isFinite));
  }
  sim.setEnabled(false);
  assert.ok(Math.abs(f.bone.rotation.z - 0.15) < 1e-6);
  sim.beforeAnimation(); sim.update(1 / 60);
  assert.ok(Math.abs(f.bone.rotation.z - 0.15) < 1e-6);
});

test("fixed steps behave consistently at 30 and 120 Hz", () => {
  function run(rate) {
    const f = fixture(); const sim = f.create();
    for (let i = 0; i < rate; i += 1) { sim.beforeAnimation(); sim.update(1 / rate); }
    return f.bone.quaternion;
  }
  assert.ok(run(30).angleTo(run(120)) < 1e-6);
});

test("capsule endpoints follow different animated nodes", () => {
  const f = fixture();
  f.physics.colliders[0] = { shape: "capsule", node: 1, offset: [0, -0.2, 0], radius: 0.25, tail: { node: 0, offset: [0.15, -0.4, 0] } };
  const sim = f.create(); sim.update(1 / 60);
  assert.ok(f.bone.quaternion.toArray().every(Number.isFinite));
  f.body.position.x = 0.4; sim.beforeAnimation(); sim.update(1 / 60);
  assert.ok(Math.abs(sim.colliders[0].shape.offset.x - 0.4) < 1e-7);
});

test("component indices rebind discarded head core to authoritative body core", async () => {
  const f = fixture(); f.body.name = "Hips";
  const oldHeadHips = new THREE.Object3D(); oldHeadHips.name = "Hips";
  const sim = await createModelPhysics(f.root, [{
    component: { name: "head", physics: f.physics },
    gltf: { parser: { getDependencies: async () => [f.bone, oldHeadHips] } },
  }]);
  assert.equal(sim.colliders[0].node, f.body);
});

test("physics cannot control Humanoid core bones", () => {
  const f = fixture(); f.bone.name = "Hips";
  assert.throws(f.create, /Humanoid/);
});

test("sphere center and capsule axis overlaps remain finite", () => {
  for (const capsule of [false, true]) {
    const f = fixture(); f.body.position.set(0, -1, 0);
    if (capsule) Object.assign(f.physics.colliders[0], { shape: "capsule", tail: { node: 1, offset: [0, 0.5, 0] } });
    const sim = f.create();
    for (let i = 0; i < 30; i += 1) { sim.beforeAnimation(); sim.update(1 / 60); }
    assert.ok(f.bone.quaternion.toArray().every(Number.isFinite));
  }
});

test("missing optional head core collider follows composition ancestor", async () => {
  const f = fixture();
  const hips = new THREE.Object3D(); hips.name = "Hips"; f.root.add(hips);
  const chest = new THREE.Object3D(); chest.name = "Chest"; hips.add(chest);
  const head = new THREE.Group();
  const oldHips = new THREE.Object3D(); oldHips.name = "Hips"; head.add(oldHips);
  const oldChest = new THREE.Object3D(); oldChest.name = "Chest"; oldHips.add(oldChest);
  const upper = new THREE.Object3D(); upper.name = "UpperChest"; upper.position.y = .2; oldChest.add(upper);
  const composition = composeHumanoidHeadBody(f.root, head);
  const sim = await createModelPhysics(f.root, [{
    component: { name: "head", physics: f.physics }, nodeBindings: composition.nodeBindings,
    gltf: { parser: { getDependencies: async () => [f.bone, upper] } },
  }]);
  assert.equal(sim.colliders[0].node, chest);
  assert.ok(Math.abs(sim.colliders[0].shape.offset.y - .2) < 1e-6);
  chest.position.y = 1; sim.updateColliders();
  assert.ok(Math.abs(sim.colliders[0].shape.offset.y - 1.2) < 1e-6);
});

test("collapsed capsules remain finite while animated parents do not accumulate local drift", () => {
  const f = fixture();
  const parent = new THREE.Object3D();
  f.root.add(parent); parent.add(f.bone, f.body);
  f.body.position.set(0, -1, 0);
  f.physics.colliders[0] = {
    shape: "capsule", node: 1, offset: [0, 0, 0], radius: 0.25,
    tail: { node: 1, offset: [0, 0, 0] },
  };
  const localPosition = f.bone.position.clone();
  const sim = f.create();
  const base = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.12);
  for (let i = 0; i < 600; i += 1) {
    sim.beforeAnimation();
    if (i) assert.ok(f.bone.quaternion.angleTo(base) < 1e-7, `baseline drift at frame ${i}`);
    f.bone.quaternion.copy(base);
    parent.rotation.y = 0.4 * Math.sin(i / 30);
    parent.position.x = 0.2 * Math.sin(i / 60);
    sim.update(1 / 120);
    assert.ok(f.bone.quaternion.toArray().every(Number.isFinite));
    assert.ok(Math.abs(f.bone.quaternion.length() - 1) < 1e-7);
    assert.ok(f.bone.position.distanceTo(localPosition) < 1e-12);
  }
  sim.destroy();
  assert.ok(f.bone.quaternion.angleTo(base) < 1e-7);
});

test("plane offset and inverse-transpose normal follow rotated nonuniform nodes", () => {
  const f = fixture();
  f.body.position.set(0.3, 0.2, -0.1);
  f.body.rotation.set(0.2, 0.4, -0.3);
  f.body.scale.set(2, 0.5, 1.5);
  const normal = new THREE.Vector3(1, 1, 0).normalize();
  const offset = new THREE.Vector3(0.1, 0.2, 0.3);
  f.physics.colliders[0] = { shape: "plane", node: 1, offset: offset.toArray(), normal: normal.toArray() };
  const sim = f.create();
  const record = sim.colliders[0];
  const worldPoint = offset.clone().applyMatrix4(f.body.matrixWorld);
  const worldNormal = normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(f.body.matrixWorld));
  assert.ok(record.shape.offset.distanceTo(worldPoint) < 1e-12);
  assert.ok(record.shape.normal.distanceTo(worldNormal) < 1e-12);
  for (const signedDistance of [-0.2, 0.2]) {
    const query = worldPoint.clone().addScaledVector(worldNormal, signedDistance);
    const resultNormal = new THREE.Vector3();
    const distance = record.shape.calculateCollision(record.collider.colliderMatrix, query, 0.03, resultNormal);
    assert.ok(Math.abs(distance - (signedDistance - 0.03)) < 1e-12);
    assert.ok(resultNormal.distanceTo(worldNormal) < 1e-12);
  }
  sim.destroy();
});

test("reenabling starts from current animation and destroy restores it without touching TRS", () => {
  const f = fixture(); const sim = f.create();
  sim.update(1 / 60);
  sim.setEnabled(false);
  const base = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3);
  f.bone.quaternion.copy(base);
  f.bone.position.set(0.02, 0.1, -0.02);
  f.bone.scale.set(1.1, 1.1, 1.1);
  sim.update(1 / 60);
  sim.setEnabled(true);
  sim.beforeAnimation(); sim.update(1 / 60);
  const actual = f.bone.quaternion.clone();
  const fresh = fixture();
  fresh.bone.quaternion.copy(base);
  fresh.bone.position.copy(f.bone.position);
  fresh.bone.scale.copy(f.bone.scale);
  const freshSim = fresh.create(); freshSim.update(1 / 60);
  assert.ok(actual.angleTo(fresh.bone.quaternion) < 1e-7, "reenable retained old particle history");
  sim.destroy(); sim.destroy();
  assert.ok(f.bone.quaternion.angleTo(base) < 1e-7);
  assert.deepEqual(f.bone.position.toArray(), [0.02, 0.1, -0.02]);
  assert.deepEqual(f.bone.scale.toArray(), [1.1, 1.1, 1.1]);
  assert.equal(sim.records.length, 0);
  assert.equal(sim.colliders.length, 0);
  freshSim.destroy();
});

test("collision radii conservatively include shear from nonuniform animated parents", () => {
  const shear = new THREE.Matrix4().set(1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  assert.ok(Math.abs(maximumStretch(shear) - (1 + Math.sqrt(5)) / 2) < 1e-12);
  assert.equal(maximumStretch(new THREE.Matrix4().makeScale(0, 0, 0)), 0);
  assert.equal(maximumStretch(new THREE.Matrix4().makeScale(-2, 1, 0.5)), 2);
  const f = fixture();
  const parent = new THREE.Object3D();
  parent.scale.set(2, 1, 1);
  f.root.add(parent); parent.add(f.bone, f.body);
  f.bone.rotation.z = Math.PI / 4;
  f.body.rotation.z = Math.PI / 4;
  const sim = f.create();
  assert.ok(f.body.getWorldScale(new THREE.Vector3()).x < 1.6, "fixture must contain shear");
  assert.ok(Math.abs(sim.colliders[0].shape.radius - 0.5) < 1e-12);
  assert.ok(Math.abs(sim.records[0].joint.settings.hitRadius - 0.06) < 1e-12);
  // Rotate again as an animation would: the outer scale remains the same.
  f.body.rotation.z = Math.PI / 3;
  sim.updateColliders();
  assert.ok(Math.abs(sim.colliders[0].shape.radius - 0.5) < 1e-12);
  sim.destroy();
});

test("composition binding transforms preserve collider offset and shear envelope without mutating metadata", async () => {
  const f = fixture(); f.body.name = "Hips";
  const oldHips = new THREE.Object3D(); oldHips.name = "Hips";
  const transform = new THREE.Matrix4().makeScale(2, 1, 1)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 4));
  transform.setPosition(0.1, 0.2, 0.3);
  f.physics.colliders[0].offset = [0.2, 0.3, -0.1];
  const original = structuredClone(f.physics);
  const sim = await createModelPhysics(f.root, [{
    component: { name: "head", physics: f.physics },
    nodeBindings: new Map([[oldHips, { node: f.body, localMatrix: transform }]]),
    gltf: { parser: { getDependencies: async () => [f.bone, oldHips] } },
  }]);
  const expected = new THREE.Vector3(...original.colliders[0].offset)
    .applyMatrix4(transform).applyMatrix4(f.body.matrixWorld);
  assert.ok(sim.colliders[0].shape.offset.distanceTo(expected) < 1e-12);
  assert.ok(Math.abs(sim.colliders[0].shape.radius - 0.5) < 1e-12);
  assert.deepEqual(f.physics, original);
  sim.destroy();
});

test("collision projection onto the joint pivot cannot poison the solver", () => {
  const f = fixture();
  f.body.position.set(0, -2, 0);
  // Collider radius + particle radius = 2: a direct push lands exactly on
  // the pivot. Normalizing that zero-length bone must not yield NaN.
  f.physics.colliders[0].radius = 1.97;
  const sim = f.create();
  assert.doesNotThrow(() => sim.update(1 / 60));
  assert.ok(f.bone.quaternion.toArray().every(Number.isFinite));
  assert.ok(Math.abs(f.bone.quaternion.length() - 1) < 1e-7);
  sim.destroy();
});

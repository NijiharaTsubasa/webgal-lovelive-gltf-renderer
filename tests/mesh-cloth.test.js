import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { clothTopology, vertexSkinMatrix, createMeshCloth } from "../src/mesh-cloth.js";
import { morphTerms } from "../src/cloth-geometry.js";
import { createJoltClothSolver } from "../src/jolt-cloth-solver.js";

test("backstops do not add impulses when transported animation moves behind the previous reference", async () => {
  const initial = [[0, 0, 0], [.1, 0, 0], [0, .1, 0]].map((v) => new THREE.Vector3(...v));
  const sim = await createJoltClothSolver({ positions: initial, indices: [0, 1, 2], fixed: new Set([0]),
    radius: .003, damping: .8, colliders: [] });
  try {
    const moved = initial.map((p) => p.clone().add(new THREE.Vector3(0, 0, -.1)));
    sim.step({ targets: moved, previousTargets: initial, stiffness: 0,
      gravity: [0, 0, 0], delta: 1 / 60, colliders: [] });
    assert.ok(sim.positions[0].distanceTo(moved[0]) < 1e-6, "native backstop displaced the zero-mass anchor");
    sim.positions.forEach((p, i) => assert.ok(p.distanceTo(moved[i]) < 1e-6,
      `vertex ${i}: native skin interpolation repeated the already applied animation transport`));
  } finally { sim.destroy(); }
});

test("native cloth backstops follow the animated surface normal without freezing outward motion", async () => {
  const reference = [[0, 0, 0], [.1, 0, 0], [0, .1, 0]].map((v) => new THREE.Vector3(...v));
  const sim = await createJoltClothSolver({ positions: reference, indices: [0, 1, 2], fixed: new Set(),
    radius: .003, damping: .8, colliders: [] });
  const previous = reference.map((p) => p.clone());
  try {
    // Normals must come from current skin targets, not the initial +Z plane.
    for (let frame = 0; frame <= 60; frame++) {
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), frame / 60 * Math.PI / 2);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      const targets = reference.map((p) => p.clone().applyQuaternion(rotation));
      sim.step({ targets, previousTargets: previous, stiffness: 0, gravity: normal.clone().multiplyScalar(-60).toArray(),
        delta: 1 / 60, colliders: [] });
      sim.positions.forEach((p, i) => assert.ok(p.clone().sub(targets[i]).dot(normal) > -1e-5,
        `frame ${frame}, vertex ${i}: cloth folded behind its animated surface`));
      targets.forEach((p, i) => previous[i].copy(p));
    }
    // Resets/seeks must replace both the current and previous native skin state.
    const moved = reference.map((p) => p.clone().add(new THREE.Vector3(10, -3, 5)));
    sim.reset(moved, []);
    for (let frame = 0; frame < 5; frame++) sim.step({ targets: moved, previousTargets: moved,
      stiffness: 0, gravity: [0, 0, -60], delta: 1 / 60, colliders: [] });
    sim.positions.forEach((p, i) => assert.ok(p.distanceTo(moved[i]) < 1e-5, "reset retained the old backstop"));
    sim.step({ targets: moved, previousTargets: moved, stiffness: 0,
      gravity: [0, 0, 60], delta: 1 / 60, colliders: [] });
    sim.positions.forEach((p, i) => assert.ok(p.z - moved[i].z > .001, "outward cloth response was frozen"));
    const outward = sim.positions.map((p) => p.clone());
    sim.step({ targets: moved, previousTargets: moved, stiffness: 0,
      gravity: [0, 0, 0], delta: 1 / 60, colliders: [] });
    sim.positions.forEach((p, i) => assert.ok(p.z > outward[i].z + 1e-5,
      "updating the animated reference discarded physical velocity"));
  } finally { sim.destroy(); }
});

test("native finite panels contact the front, have finite bounds, and do not recover deep backside initial states", async () => {
  for (const [x, z] of [[0, .01], [3, .01], [0, -.1]]) {
    const targets = [[x, 0, z], [x + .1, 0, z], [x, .1, z]].map((v) => new THREE.Vector3(...v));
    const pose = { shape: "panel", p: new THREE.Vector3(), q: new THREE.Quaternion(),
      halfAxes: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(.2, 1, 0)] };
    const sim = await createJoltClothSolver({ positions: targets, indices: [0, 1, 2], fixed: new Set(),
      radius: .02, damping: .8, colliders: [pose] });
    try {
      for (let i = 0; i < 5; i++) sim.step({ targets, previousTargets: targets, stiffness: 0,
        gravity: [0, 0, 0], delta: 1 / 60, colliders: [pose] });
      if (x === 0 && z > 0) assert.ok(sim.positions.every((p) => p.z >= .019), `front contact: ${sim.positions.map((p) => p.z)}`);
      else sim.positions.forEach((p, i) => assert.ok(p.distanceTo(targets[i]) < 1e-6,
        z < 0 ? "native triangle contacts do not pull deeply embedded initial points back to the front" : "finite panel must not become an infinite plane"));
    } finally { sim.destroy(); }
  }
});

test("native cloth accepts finite skew panels and updates their animated geometry", async () => {
  const f = fixture();
  f.collider.position.set(0, 0, -.01);
  f.physics.colliders[0] = { shape: "panel", node: 1, offset: [0, 0, 0], halfAxes: [[.7, 0, 0], [.1, .7, 0]] };
  const sim = await f.create(), cloth = sim.records[0], solver = cloth.solver;
  for (let i = 0; i < 10; i++) {
    sim.beforeAnimation(); f.collider.scale.set(1 + i * .01, .9, 1);
    f.collider.rotation.z = i * .02; f.root.updateMatrixWorld(true); sim.update(1 / 60);
    assert.equal(cloth.solver, solver);
    const pose = cloth.colliderPoses()[0];
    assert.ok(pose.halfAxes[0].distanceTo(new THREE.Vector3(.7, 0, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(f.collider.matrixWorld))) < 1e-12);
    assert.ok(cloth.positions[12].z >= .009, `center must be in front of finite panel: ${cloth.positions[12].z}`);
    assert.ok(cloth.positions.every((p) => p.toArray().every(Number.isFinite)));
  }
  sim.destroy();
});

function fixture() {
  const root = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(2, 2, 4, 4);
  const count = geometry.getAttribute("position").count;
  const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) weights[i * 4] = 1;
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(indices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bone = new THREE.Bone(); root.add(bone, mesh);
  mesh.bind(new THREE.Skeleton([bone]));
  const collider = new THREE.Object3D(); collider.position.set(0.12, -0.35, 0.08); root.add(collider);
  const cloth = { node: 0, primitive: 0, fixed: [0, 1, 2, 3, 4], radius: 0.02,
    stiffness: 12, damping: 0.8, gravity: [0, 0, 0], colliders: [0] };
  const physics = { springs: [], colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: 0.55 }], cloths: [cloth] };
  const nodes = [mesh, collider];
  const create = () => createMeshCloth(root, [{ physics, resolve: (i) => nodes[i] }]);
  return { root, mesh, bone, collider, geometry, cloth, physics, nodes, create };
}

test("cloth fixed indices are bounded and topology retains skin bindings", () => {
  const f = fixture();
  const topology = clothTopology(f.geometry, f.cloth.fixed);
  assert.equal(topology.vertices.length, 25);
  assert.equal(topology.indices.length, 96);
  assert.throws(() => clothTopology(f.geometry, [-1]), /fixed/);
  assert.throws(() => clothTopology(f.geometry, [25]), /fixed/);
  assert.throws(() => clothTopology(f.geometry, []), /fixed/);
  f.geometry.setIndex([0, 1, 5]);
  assert.throws(() => clothTopology(f.geometry, [24]), /未被 primitive/);
  const subset = clothTopology(f.geometry, [0]);
  assert.equal(subset.vertices.length, 3);
  assert.equal(subset.mapping[24], -1);
});

test("inverse weighted skin matrix undoes skinning with rotation and nonuniform scaling", () => {
  const f = fixture();
  f.root.scale.set(1.2, 0.9, 1.4); f.root.rotation.y = 0.35;
  f.bone.rotation.x = 0.4; f.bone.position.z = 0.25;
  f.root.updateMatrixWorld(true);
  const original = new THREE.Vector3().fromBufferAttribute(f.geometry.getAttribute("position"), 7);
  const displayed = f.mesh.getVertexPosition(7, new THREE.Vector3());
  assert.ok(displayed.applyMatrix4(vertexSkinMatrix(f.mesh, 7).invert()).distanceTo(original) < 1e-6);
});

test("real soft body reduces overlap, pins follow skinning and toggle restores attributes", async () => {
  const f = fixture();
  const sourcePosition = f.geometry.getAttribute("position");
  const sourceNormal = f.geometry.getAttribute("normal");
  const originalArray = Array.from(sourcePosition.array);
  const sharedPass = new THREE.Mesh(f.geometry, f.mesh.material);
  const sim = await f.create();
  assert.equal(sharedPass.geometry, f.geometry);
  sim.beforeAnimation(); sim.update(1 / 60);
  const center = f.mesh.getVertexPosition(17, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld);
  assert.ok(center.distanceTo(f.collider.position) >= 0.50, `distance ${center.distanceTo(f.collider.position)}`);
  assert.deepEqual(Array.from(sourcePosition.array), originalArray);
  assert.ok([...f.geometry.getAttribute("position").array, ...f.geometry.getAttribute("normal").array].every(Number.isFinite));
  sim.beforeAnimation();
  f.bone.position.x = 0.25; f.bone.rotation.z = 0.15; f.root.updateMatrixWorld(true);
  const expected = f.mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld);
  sim.update(1 / 60);
  const actual = f.mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld);
  assert.ok(actual.distanceTo(expected) < 1e-5);
  sim.setEnabled(false);
  assert.deepEqual(Array.from(f.geometry.getAttribute("position").array), originalArray);
  sim.destroy();
  assert.equal(f.geometry.getAttribute("position"), sourcePosition);
  assert.equal(f.geometry.getAttribute("normal"), sourceNormal);
  assert.equal(f.mesh.frustumCulled, true);
});

test("changing cross-node capsule dimensions preserve the solver and contact clearance", async () => {
  const f = fixture();
  const tail = new THREE.Object3D(); tail.position.set(.12, -.7, .08);
  f.root.add(tail); f.nodes.push(tail);
  f.physics.colliders[0] = { shape: "capsule", node: 1, offset: [0, 0, 0], radius: 0.3,
    tail: { node: 2, offset: [0, 0, 0] } };
  const sim = await f.create();
  const solver = sim.records[0].solver;
  const local = new THREE.Vector3();
  for (let i = 0; i < 21; i += 1) {
    sim.beforeAnimation(); f.collider.position.y += 0.005;
    f.collider.scale.set(1 + i * .005, 1, 1);
    if (i === 20) tail.position.copy(f.collider.position);
    f.root.updateMatrixWorld(true);
    if (i === 10) sim.reset();
    sim.update(1 / 60);
    assert.ok(Array.from(f.geometry.getAttribute("position").array).every(Number.isFinite));
    const cloth = sim.records[0], collider = cloth.colliders[0];
    const pose = cloth.colliderPose(collider);
    assert.equal(cloth.solver, solver, "dimension changes must not rebuild the solver");
    assert.ok(Math.abs(pose.radius - .3 * (1 + i * .005)) < 1e-6);
    if (i === 20) assert.ok(pose.height < 1e-8, "coincident endpoints become a sphere");
    const inverseRotation = pose.q.clone().invert();
    for (let j = 0; j < cloth.positions.length; j++) {
      if (cloth.topology.fixed.has(j)) continue;
      local.copy(cloth.positions[j]).sub(pose.p).applyQuaternion(inverseRotation);
      const distance = Math.hypot(local.x, Math.max(0, Math.abs(local.y) - pose.height / 2), local.z);
      assert.ok(distance >= pose.radius + f.cloth.radius - 1e-5, `frame ${i}, vertex ${j}: capsule distance ${distance}`);
    }
  }
  sim.destroy();
});

test("relative Morph remains part of the animated cloth baseline without feedback", async () => {
  const f = fixture();
  const count = f.geometry.getAttribute("position").count;
  const delta = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) delta[i * 3 + 2] = 0.12;
  f.geometry.morphAttributes.position = [new THREE.BufferAttribute(delta, 3)];
  f.geometry.morphTargetsRelative = true;
  f.mesh.updateMorphTargets(); f.mesh.morphTargetInfluences[0] = 0.5;
  const sim = await f.create();
  for (let i = 0; i < 15; i += 1) {
    sim.beforeAnimation(); f.root.updateMatrixWorld(true);
    const expected = f.mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld);
    sim.update(1 / 60);
    const actual = f.mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld);
    assert.ok(actual.distanceTo(expected) < 1e-5);
    assert.ok(Math.abs(actual.z - 0.06) < 1e-5);
  }
  sim.destroy();
});

test("world normal writeback inverts skin-normal transform rather than double skinning", async () => {
  const f = fixture();
  f.root.scale.set(1.2, 0.9, 1.4); f.root.rotation.y = 0.35;
  f.bone.rotation.x = 0.4; f.bone.position.z = 0.25;
  f.root.updateMatrixWorld(true);
  const sim = await f.create(); sim.beforeAnimation(); sim.update(1 / 60);
  const cloth = sim.records[0], vertex = 17;
  const expected = cloth.normals[cloth.topology.mapping[vertex]].clone().normalize();
  const actual = new THREE.Vector3().fromBufferAttribute(f.geometry.getAttribute("normal"), vertex)
    .applyMatrix3(new THREE.Matrix3().setFromMatrix4(vertexSkinMatrix(f.mesh, vertex)))
    .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(f.mesh.matrixWorld));
  assert.ok(actual.distanceTo(expected) < 1e-5);
  sim.destroy();
});

test("no mesh cloth avoids loading or changing model data", async () => {
  const f = fixture(), position = f.geometry.getAttribute("position");
  const sim = await createMeshCloth(f.root, []);
  sim.beforeAnimation(); sim.update(0); sim.reset(); sim.setEnabled(false); sim.destroy();
  assert.equal(f.geometry.getAttribute("position"), position);
});

test("animated rest shape follows changing skin stretch instead of collapsing toward initial links", async () => {
  for (const rate of [30, 60, 120]) {
    const f = fixture();
    f.physics.colliders = []; f.cloth.colliders = [];
    const sim = await f.create();
    sim.beforeAnimation(); sim.update(0);
    const persistentSolver = sim.records[0].solver;
    const expected = new THREE.Vector3(), actual = new THREE.Vector3();
    for (let frame = 1; frame <= rate; frame += 1) {
      sim.beforeAnimation();
      const t = frame / rate;
      f.bone.scale.x = 1 + .3 * t; f.bone.position.x = .2 * t;
      f.bone.rotation.y = .25 * t;
      f.root.updateMatrixWorld(true);
      f.mesh.getVertexPosition(22, expected).applyMatrix4(f.mesh.matrixWorld);
      sim.update(1 / rate);
      assert.equal(sim.records[0].solver, persistentSolver, "animation must reuse the initialized solver");
      f.mesh.getVertexPosition(22, actual).applyMatrix4(f.mesh.matrixWorld);
      assert.ok(actual.distanceTo(expected) < .001, `${rate} Hz frame ${frame}: ${actual.distanceTo(expected)}`);
    }
    sim.destroy();
  }
});

test("initial collider placement does not inject a world-origin-dependent impulse", async () => {
  const results = [];
  for (const offset of [0, 10]) {
    const f = fixture();
    f.root.position.x = offset; f.root.updateMatrixWorld(true);
    const sim = await f.create(); sim.beforeAnimation(); sim.update(0);
    results.push(sim.records[0].positions.map((p) => p.clone().sub(f.root.position)));
    sim.destroy();
  }
  for (let i = 0; i < results[0].length; i += 1) {
    assert.ok(results[0][i].distanceTo(results[1][i]) < 1e-4, `vertex ${i} depends on world origin`);
  }
});

test("two-step reset resolves native cloth contacts immediately after a large teleport", async () => {
  const f = fixture(), sim = await f.create();
  sim.beforeAnimation(); sim.update(0);
  for (const offset of [[10, 0, 0], [0, -10, 0], [0, 0, 20]]) {
    sim.beforeAnimation(); f.root.position.fromArray(offset); f.root.updateMatrixWorld(true);
    // The first native step refreshes cached cloth bounds; the second must
    // resolve the new-position contacts before this reset frame is drawn.
    sim.reset(2); sim.update(0);
    const cloth = sim.records[0], pose = cloth.colliderPose(cloth.colliders[0]);
    cloth.positions.forEach((p, i) => {
      if (cloth.topology.fixed.has(i)) {
        assert.ok(p.distanceTo(cloth.targets[i]) < 1e-6);
      } else {
        const clearance = p.distanceTo(pose.p) - pose.radius - f.cloth.radius;
        assert.ok(clearance >= -1e-5, `teleport ${offset}, vertex ${i}: clearance ${clearance}`);
      }
    });
  }
  sim.destroy();
});

test("animated reference lengths recover compressed particles without rebuilding the solver", async () => {
  const f = fixture(); f.physics.colliders = []; f.cloth.colliders = [];
  f.cloth.stiffness = 0;
  const sim = await f.create(); sim.beforeAnimation(); sim.update(0);
  const cloth = sim.records[0];
  const solver = cloth.solver;
  const compressed = cloth.targets.map((p, i) => {
    const value = p.clone();
    if (!cloth.topology.fixed.has(i)) value.x *= .2;
    return value;
  });
  solver.reset(compressed, cloth.colliderPoses(), cloth.radius());
  for (let i = 0; i < 60; i += 1) cloth.step(1);
  // The native cloth may fold after extreme compression. Measure the material
  // edge lengths, not the projected X span of that folded surface.
  const lengths = [20, 21, 22, 23].map((i) => solver.positions[i].distanceTo(solver.positions[i + 1]));
  const recoveredLength = lengths.reduce((sum, length) => sum + length, 0);
  assert.equal(cloth.solver, solver);
  assert.ok(recoveredLength > 1.8, `reference edges retained their compressed rest lengths: ${recoveredLength}`);
  for (const length of lengths) assert.ok(Math.abs(length - .5) < .06, `reference edge length was not restored: ${length}`);
  sim.destroy();
});

test("native cloth contacts keep movable vertices outside moving colliders", async () => {
  const f = fixture(); const sim = await f.create();
  for (let frame = 0; frame < 30; frame += 1) {
    sim.beforeAnimation();
    f.collider.position.x = .12 + .2 * Math.sin(frame / 10);
    f.root.updateMatrixWorld(true); sim.update(1 / 60);
    const cloth = sim.records[0];
    for (let i = 0; i < cloth.positions.length; i += 1) {
      if (cloth.topology.fixed.has(i)) continue;
      const distance = cloth.positions[i].distanceTo(f.collider.position);
      assert.ok(distance >= .55 + .02 - 1e-6, `frame ${frame}, vertex ${i}: ${distance}`);
    }
  }
  sim.destroy();
});

test("plane contacts respect transformed normals and the mesh-scaled cloth radius", async () => {
  const f = fixture();
  f.root.scale.setScalar(1.5); f.root.rotation.y = .3;
  f.collider.position.set(0, 0, -.01);
  f.physics.colliders[0] = { shape: "plane", node: 1, offset: [0, 0, 0], normal: [0, 0, 1] };
  f.root.updateMatrixWorld(true);
  const sim = await f.create();
  sim.beforeAnimation(); sim.update(0);
  const cloth = sim.records[0], solver = cloth.solver;
  for (const scale of [1.5, 2]) {
    sim.beforeAnimation(); f.root.scale.setScalar(scale); f.root.updateMatrixWorld(true);
    sim.reset(); sim.update(1 / 60);
    const pose = cloth.colliderPose(cloth.colliders[0]);
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.q);
    cloth.positions.forEach((p, i) => {
      if (!cloth.topology.fixed.has(i)) {
        const distance = p.clone().sub(pose.p).dot(normal);
        assert.ok(distance >= f.cloth.radius * scale - 1e-5, `scale ${scale}, vertex ${i}: ${distance}`);
      }
    });
    assert.equal(cloth.solver, solver);
  }
  sim.destroy();
});

test("independent cloth instances do not share colliders and survive another instance's destruction", async () => {
  const a = fixture(), b = fixture();
  b.physics.colliders = []; b.cloth.colliders = [];
  const first = await a.create(), second = await b.create();
  for (let frame = 0; frame < 4; frame++) {
    first.beforeAnimation(); first.update(1 / 60);
    second.beforeAnimation(); second.update(1 / 60);
  }
  const baseline = second.records[0].targets[17];
  assert.ok(second.records[0].positions[17].distanceTo(baseline) < 1e-5);
  assert.ok(first.records[0].positions[17].distanceTo(baseline) > .05);
  first.destroy(); first.destroy();
  const solver = second.records[0].solver;
  for (let frame = 0; frame < 4; frame++) {
    second.beforeAnimation(); b.bone.position.x += .01; b.root.updateMatrixWorld(true);
    second.update(1 / 60);
    assert.equal(second.records[0].solver, solver);
    second.records[0].positions.forEach((p, i) => assert.ok(p.distanceTo(second.records[0].targets[i]) < 1e-5));
  }
  second.destroy(); second.destroy();
});

test("cloth collisions survive partial disposal and complete destroy/recreate cycles", async () => {
  const a = fixture(), b = fixture();
  const first = await a.create();
  let second = await b.create();
  first.beforeAnimation(); first.update(1 / 60);
  first.destroy();
  const checkContacts = () => {
    const cloth = second.records[0];
    cloth.positions.forEach((p, i) => {
      if (!cloth.topology.fixed.has(i)) {
        assert.ok(p.distanceTo(b.collider.position) >= .57 - 1e-6,
          `vertex ${i} lost native collision after another solver was destroyed`);
      }
    });
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let frame = 0; frame < 8; frame++) {
      second.beforeAnimation(); b.collider.position.x = .12 + .1 * Math.sin(frame);
      b.root.updateMatrixWorld(true); second.update(1 / 60); checkContacts();
    }
    second.destroy();
    if (cycle < 2) second = await b.create();
  }
});

test("stepping or warming one cloth does not advance another cloth's simulation clock", async () => {
  const run = async (withOther) => {
    const f = fixture();
    f.cloth.gravity = [0, -2, 0];
    const sim = await f.create();
    sim.beforeAnimation(); sim.update(1 / 60);
    let other;
    if (withOther) {
      const g = fixture();
      other = await g.create();
      for (let i = 0; i < 20; i++) {
        other.beforeAnimation(); other.update(1 / 60);
      }
      other.reset(); other.beforeAnimation(); other.update(0);
    }
    for (let i = 0; i < 3; i++) {
      sim.beforeAnimation(); sim.update(1 / 60);
    }
    const positions = sim.records[0].positions.map((p) => p.clone());
    other?.destroy(); sim.destroy();
    return positions;
  };
  const alone = await run(false), besideAnother = await run(true);
  alone.forEach((p, i) => assert.ok(p.distanceTo(besideAnother[i]) < 1e-6,
    `vertex ${i}: unrelated cloth steps changed the simulation clock`));
});

test("cached skin palettes match Three for blended animated bones and Morphs", async () => {
  const f = fixture(), second = new THREE.Bone();
  f.root.add(second); second.position.y = .3; f.root.updateMatrixWorld(true);
  f.mesh.bind(new THREE.Skeleton([f.bone, second]));
  const joints = f.geometry.getAttribute("skinIndex"), weights = f.geometry.getAttribute("skinWeight");
  for (let i = 0; i < weights.count; i += 1) {
    joints.setXY(i, 0, 1); weights.setXY(i, .25, .75);
  }
  const delta = new Float32Array(weights.count * 3);
  for (let i = 0; i < weights.count; i += 1) delta[i * 3 + 2] = .12;
  f.geometry.morphAttributes.position = [new THREE.BufferAttribute(delta, 3)];
  f.geometry.morphTargetsRelative = true; f.mesh.updateMorphTargets(); f.mesh.morphTargetInfluences[0] = .4;
  f.physics.colliders = []; f.cloth.colliders = [];
  f.cloth.fixed = Array.from({ length: weights.count }, (_, i) => i);
  const sim = await f.create();
  for (let frame = 0; frame < 10; frame += 1) {
    sim.beforeAnimation(); second.rotation.z = frame * .025; f.bone.position.x = frame * .01;
    f.root.scale.set(1.1, .9, 1.2); f.root.updateMatrixWorld(true);
    const expected = Array.from({ length: weights.count }, (_, i) => f.mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld));
    sim.update(1 / 60);
    expected.forEach((p, i) => assert.ok(p.distanceTo(sim.records[0].targets[i]) < 1e-6));
  }
  assert.equal(sim.records[0].skinBindings.length, 1);
  sim.destroy();
});

test("skin palette cache ignores unused vertices with empty bindings", async () => {
  const f = fixture();
  f.geometry.setIndex([0, 1, 5]); f.cloth.fixed = [0];
  f.geometry.getAttribute("skinWeight").setXYZW(24, 0, 0, 0, 0);
  const sim = await f.create(); sim.beforeAnimation(); sim.update(1 / 60);
  assert.equal(sim.records[0].inverseSkin[24], undefined);
  assert.ok(sim.records[0].positions.every((p) => p.toArray().every(Number.isFinite)));
  sim.destroy();
});

// Allocation-heavy reference of the original writeback. Keep the arithmetic
// order independent of the production scratch objects to catch aliasing.
function referenceWriteback(cloth) {
  const positions = cloth.solver.positions.map((p, i) => cloth.topology.fixed.has(i)
    ? cloth.targets[i].clone() : p.clone().add(cloth.targets[i]).sub(cloth.previousTargets[i]));
  const normals = positions.map(() => new THREE.Vector3());
  const edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
  for (let i = 0; i < cloth.topology.indices.length; i += 3) {
    const [a, b, c] = cloth.topology.indices.slice(i, i + 3);
    edgeA.subVectors(positions[b], positions[a]); edgeB.subVectors(positions[c], positions[a]);
    edgeA.cross(edgeB);
    normals[a].add(edgeA); normals[b].add(edgeA); normals[c].add(edgeA);
  }
  const position = cloth.sourcePosition.clone(), normal = cloth.sourceNormal.clone();
  const p = new THREE.Vector3(), n = new THREE.Vector3(), morph = new THREE.Vector3();
  const normalInverse = new THREE.Matrix3();
  for (let i = 0; i < position.count; i++) {
    const index = cloth.topology.mapping[i];
    if (index < 0) continue;
    const base = morphTerms(cloth.mesh, i, "position", morph);
    p.copy(positions[index]).applyMatrix4(cloth.inverseWorld).applyMatrix4(cloth.inverseSkin[i]).sub(morph).divideScalar(base);
    position.setXYZ(i, p.x, p.y, p.z);
    normalInverse.setFromMatrix4(cloth.inverseSkin[i]);
    n.copy(normals[index]);
    if (n.lengthSq() > 1e-20) {
      n.normalize().applyMatrix3(cloth.normalToLocal).applyMatrix3(normalInverse).normalize();
      const normalBase = morphTerms(cloth.mesh, i, "normal", morph);
      n.sub(morph).divideScalar(normalBase);
    } else n.fromBufferAttribute(cloth.sourceNormal, i);
    normal.setXYZ(i, n.x, n.y, n.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", position); geometry.setAttribute("normal", normal);
  geometry.morphAttributes = cloth.geometry.morphAttributes;
  geometry.morphTargetsRelative = cloth.geometry.morphTargetsRelative;
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

test("cloth writeback matches the original arithmetic with animated bones and non-endpoint Morphs", async () => {
  for (const relative of [true, false]) {
    const f = fixture(), second = new THREE.Bone();
    f.root.add(second); second.position.y = .23; f.root.updateMatrixWorld(true);
    f.mesh.bind(new THREE.Skeleton([f.bone, second]));
    const joints = f.geometry.getAttribute("skinIndex"), weights = f.geometry.getAttribute("skinWeight");
    for (let i = 0; i < weights.count; i++) {
      const weight = i % 2 ? .28125 : .625;
      joints.setXY(i, 0, 1); weights.setXY(i, weight, 1 - weight);
    }
    for (const attribute of ["position", "normal"]) {
      const source = f.geometry.getAttribute(attribute), morph = source.clone();
      for (let i = 0; i < source.count; i++) {
        morph.setXYZ(i, (relative ? 0 : source.getX(i)) + .013 * Math.sin(i),
          (relative ? 0 : source.getY(i)) + .017 * Math.cos(i),
          (relative ? 0 : source.getZ(i)) + .021);
      }
      f.geometry.morphAttributes[attribute] = [morph];
    }
    f.geometry.morphTargetsRelative = relative; f.mesh.updateMorphTargets();
    f.mesh.morphTargetInfluences[0] = .17;
    let paletteUpdates = 0;
    const originalUpdate = f.mesh.skeleton.update.bind(f.mesh.skeleton);
    f.mesh.skeleton.update = () => { paletteUpdates++; originalUpdate(); };
    const sim = await f.create();
    try {
      for (let frame = 0; frame < 12; frame++) {
        sim.beforeAnimation();
        f.bone.position.x = .011 * frame; second.rotation.set(.019 * frame, -.013 * frame, .023 * frame);
        f.root.rotation.y = .031 * frame; f.root.scale.set(1.13, .91, 1.07);
        f.mesh.morphTargetInfluences[0] = [.17, .63, .41][frame % 3];
        f.root.updateMatrixWorld(true);
        const targets = Array.from({ length: weights.count }, (_, i) => f.mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld));
        sim.update([1 / 120, 1 / 60, 1 / 30][frame % 3]);
        const cloth = sim.records[0], expected = referenceWriteback(cloth);
        targets.forEach((p, i) => assert.ok(p.distanceTo(cloth.targets[i]) < 1e-12));
        assert.deepEqual(cloth.position.array, expected.getAttribute("position").array);
        assert.deepEqual(cloth.normal.array, expected.getAttribute("normal").array);
        assert.deepEqual(cloth.geometry.boundingBox, expected.boundingBox);
        assert.deepEqual(cloth.geometry.boundingSphere, expected.boundingSphere);
        expected.dispose();
      }
      assert.equal(paletteUpdates, 0, "CPU cloth must not regenerate the unused GPU bone palette");
    } finally { sim.destroy(); }
  }
});

test("cloth writeback still rejects each non-finite coordinate before writing geometry", async () => {
  const f = fixture(), sim = await f.create();
  try {
    sim.beforeAnimation(); sim.update(0);
    const cloth = sim.records[0], point = cloth.solver.positions[17], original = point.clone();
    const before = cloth.position.array.slice();
    for (const coordinate of ["x", "y", "z"]) {
      for (const invalid of [NaN, Infinity, -Infinity]) {
        point.copy(original); point[coordinate] = invalid;
        assert.throws(() => cloth.writeGeometry(), /cloth 求解产生非有限坐标/);
        assert.deepEqual(cloth.position.array, before);
      }
    }
    point.copy(original);
  } finally { sim.destroy(); }
});

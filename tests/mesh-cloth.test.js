import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { clothTopology, vertexSkinMatrix, createMeshCloth } from "../src/mesh-cloth.js";
import { buildClothProxy } from "../src/cloth-proxy.js";
import { ProxyClothSolver, COLLIDER, COLLIDER_STRIDE } from "../src/proxy-cloth-solver.js";

const STEP = 1 / 60;

/** A 2 m x 2 m hanging sheet in the XY plane (normal +Z), pinned along its top row. */
function fixture({ segments = 16, colliders = [], gravity = [0, 0, 0], extra } = {}) {
  const root = new THREE.Group();
  const geometry = extra ?? new THREE.PlaneGeometry(2, 2, segments, segments);
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bone = new THREE.Bone(); root.add(bone, mesh);
  mesh.bind(new THREE.Skeleton([bone]));
  const collider = new THREE.Object3D(); root.add(collider);
  const position = geometry.getAttribute("position");
  const top = Math.max(...Array.from({ length: count }, (_, i) => position.getY(i)));
  const fixed = Array.from({ length: count }, (_, i) => i).filter((i) => position.getY(i) > top - 1e-6);
  const cloth = { node: 0, primitive: 0, fixed, radius: .003, stiffness: 12, damping: .8, gravity,
    colliders: colliders.map((_, i) => i) };
  const physics = { springs: [], colliders, cloths: [cloth] };
  const nodes = [mesh, collider];
  const create = () => createMeshCloth(root, [{ physics, resolve: (i) => nodes[i] }]);
  root.updateMatrixWorld(true);
  return { root, mesh, bone, collider, geometry, cloth, physics, nodes, create };
}

function run(f, sim, frames, before = () => {}) {
  for (let i = 0; i < frames; i++) {
    sim.beforeAnimation(); before(i); f.root.updateMatrixWorld(true); sim.update(STEP);
  }
}

/** Displayed world position, after the GPU's own skinning of the written attribute. */
function world(mesh, index) {
  mesh.updateMatrixWorld(true);
  return mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
}

function vertexAt(f, x, y) {
  const position = f.geometry.getAttribute("position");
  let best = 0;
  for (let i = 1; i < position.count; i++) {
    if (Math.hypot(position.getX(i) - x, position.getY(i) - y) < Math.hypot(position.getX(best) - x, position.getY(best) - y)) best = i;
  }
  return best;
}

function moving(f) {
  const fixed = new Set(f.cloth.fixed);
  return Array.from({ length: f.geometry.getAttribute("position").count }, (_, i) => i).filter((i) => !fixed.has(i));
}

test("cloth fixed indices are bounded and topology retains skin bindings", () => {
  const f = fixture({ segments: 4 });
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
  const f = fixture({ segments: 4 });
  f.root.scale.set(1.2, 0.9, 1.4); f.root.rotation.y = 0.35;
  f.bone.rotation.x = 0.4; f.bone.position.z = 0.25;
  f.root.updateMatrixWorld(true);
  const original = new THREE.Vector3().fromBufferAttribute(f.geometry.getAttribute("position"), 7);
  const displayed = f.mesh.getVertexPosition(7, new THREE.Vector3());
  assert.ok(displayed.applyMatrix4(vertexSkinMatrix(f.mesh, 7).invert()).distanceTo(original) < 1e-6);
});

/** Two layers of the same sheet (a lining 2 mm behind), a seam and a loose tag. */
function layeredGeometry() {
  const outer = new THREE.PlaneGeometry(2, 2, 8, 8);
  const lining = new THREE.PlaneGeometry(2, 2, 8, 8).translate(0, 0, -.002);
  const tag = new THREE.PlaneGeometry(.2, .2, 1, 1).translate(0, -.6, .01);
  const merged = [outer, lining, tag];
  const positions = [], normals = [], indices = [];
  let base = 0;
  for (const g of merged) {
    positions.push(...g.getAttribute("position").array);
    normals.push(...g.getAttribute("normal").array);
    indices.push(...Array.from(g.index.array, (i) => i + base));
    base += g.getAttribute("position").count;
  }
  // A UV seam: duplicate the outer sheet's centre vertex and use the copy in one triangle.
  const centre = 40, seam = base;
  positions.push(...outer.getAttribute("position").array.slice(centre * 3, centre * 3 + 3));
  normals.push(0, 0, 1);
  const t = indices.findIndex((v, i) => v === centre && i < outer.index.count);
  indices[t] = seam;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return { geometry, outer: 81, lining: 81, tag: 4, centre, seam };
}

test("proxy reduction joins seams and layers, and attaches detached pieces to the garment", () => {
  const layered = layeredGeometry();
  const f = fixture({ extra: layered.geometry });
  const proxy = buildClothProxy(f.geometry, f.cloth.fixed);
  assert.ok(proxy.count < proxy.topology.vertices.length / 2, `expected a reduction, got ${proxy.count} proxies`);
  assert.equal(proxy.renderCluster[layered.centre], proxy.renderCluster[layered.seam], "a UV seam split the proxy");
  assert.equal(proxy.renderCluster[layered.centre], proxy.renderCluster[layered.outer + layered.centre], "the lining separated from its layer");
  // Every proxy island must be linked to a fixed particle.
  const parent = Array.from({ length: proxy.count }, (_, i) => i);
  const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
  for (let e = 0; e < proxy.edges.length; e += 2) parent[find(proxy.edges[e])] = find(proxy.edges[e + 1]);
  const anchored = new Set([...proxy.fixed.keys()].filter((i) => proxy.fixed[i]).map(find));
  for (let i = 0; i < proxy.count; i++) assert.ok(anchored.has(find(i)), `proxy ${i} floats free of the garment`);
  // Weights form a partition of unity over existing proxies.
  for (const v of proxy.members) {
    let total = 0;
    for (let k = 0; k < 4; k++) if (proxy.weights.indices[v * 4 + k] >= 0) total += proxy.weights.weights[v * 4 + k];
    assert.ok(Math.abs(total - 1) < 1e-5, `vertex ${v} weights sum to ${total}`);
  }
});

test("source proxy clusters are honoured and validated", () => {
  const f = fixture({ segments: 4 });
  const count = f.geometry.getAttribute("position").count;
  // Rows of the sheet as proxies: five per row, two columns merged.
  const vertices = Array.from({ length: count }, (_, i) => Math.floor(i / 5) * 3 + Math.min(2, (i % 5) >> 1));
  const proxy = buildClothProxy(f.geometry, f.cloth.fixed, { vertices });
  assert.equal(proxy.count, 15);
  assert.ok(proxy.fixed.some(Boolean) && !proxy.fixed.every(Boolean));
  assert.throws(() => buildClothProxy(f.geometry, f.cloth.fixed, { vertices: vertices.slice(1) }), /覆盖全部/);
  assert.throws(() => buildClothProxy(f.geometry, f.cloth.fixed, { vertices: vertices.map((v, i) => i ? v : -1) }), /无效/);
});

test("fixed regions away from moving cloth are left to animation", () => {
  const f = fixture({ segments: 16 });
  const position = f.geometry.getAttribute("position");
  // Only the bottom row moves.
  const fixed = Array.from({ length: position.count }, (_, i) => i).filter((i) => position.getY(i) > -.99);
  const proxy = buildClothProxy(f.geometry, fixed);
  const full = buildClothProxy(f.geometry, fixed, { vertices: Array.from({ length: position.count }, (_, i) => i) });
  assert.ok(full.count < position.count, "far fixed proxies were not dropped");
  assert.ok(proxy.members.every((v) => position.getY(v) < 0), "a distant fixed vertex is still sampled");
});

test("at rest the cloth reproduces the animated skinning exactly", async () => {
  const f = fixture();
  const source = Array.from(f.geometry.getAttribute("position").array);
  const sim = await f.create();
  try {
    run(f, sim, 20, (i) => { f.bone.rotation.set(.3, .2 + i * .01, -.1); f.bone.position.set(.4, -.2, .1); f.root.scale.set(1.1, .9, 1); });
    const animated = f.mesh.clone(); animated.geometry = f.geometry.clone();
    animated.geometry.setAttribute("position", new THREE.Float32BufferAttribute(source, 3));
    animated.skeleton = f.mesh.skeleton; animated.bindMatrix = f.mesh.bindMatrix; animated.bindMatrixInverse = f.mesh.bindMatrixInverse;
    f.root.add(animated); f.root.updateMatrixWorld(true);
    for (let i = 0; i < source.length / 3; i++) {
      // Rigid animation of the whole sheet is pure transport: no deformation.
      assert.ok(world(f.mesh, i).distanceTo(world(animated, i)) < 1e-4, `vertex ${i} drifted from its skinned pose`);
    }
  } finally { sim.destroy(); }
});

test("pins follow skinning and movable vertices stay clear of a sphere pushing into the cloth", async () => {
  const f = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .3 }] });
  const sim = await f.create();
  try {
    run(f, sim, 90, (i) => {
      f.collider.position.set(0, -.3, -.4 + Math.min(1, i / 45) * .45);
      f.bone.position.x = Math.sin(i * .1) * .05;
    });
    const centre = f.collider.getWorldPosition(new THREE.Vector3());
    for (const i of moving(f)) assert.ok(world(f.mesh, i).distanceTo(centre) > .3 + .002, `vertex ${i} is inside the sphere`);
    const skin = vertexSkinMatrix(f.mesh, f.cloth.fixed[0]).premultiply(f.mesh.matrixWorld);
    const pinned = new THREE.Vector3().fromBufferAttribute(sim.records[0].sourcePosition, f.cloth.fixed[0]).applyMatrix4(skin);
    assert.ok(world(f.mesh, f.cloth.fixed[0]).distanceTo(pinned) < 1e-6, "a fixed vertex left its skinned pose");
    assert.ok(world(f.mesh, vertexAt(f, 0, -.3)).z > .1, "the sphere did not push the cloth");
  } finally { sim.destroy(); }
});

test("a collider crossing the cloth within one frame pushes it instead of tunnelling", async () => {
  // Wider than the proxy spacing: thinner bodies can pass between sparse
  // particles, as with point collision in the source engine.
  const f = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .2 }] });
  f.collider.position.set(0, -.25, -.4);
  const sim = await f.create();
  try {
    run(f, sim, 5);
    // 0.5 m in one 1/60 s step: the sphere centre ends in front of the sheet.
    run(f, sim, 1, () => f.collider.position.set(0, -.25, .1));
    const centre = f.collider.getWorldPosition(new THREE.Vector3());
    let checked = 0;
    for (const i of moving(f)) {
      const p = world(f.mesh, i);
      if (Math.hypot(p.x - centre.x, p.y - centre.y) > .1) continue;
      checked++;
      assert.ok(p.z > centre.z, `vertex ${i} was left behind the sphere`);
    }
    assert.ok(checked > 0, "no vertex lies in the sphere's path");
  } finally { sim.destroy(); }
});

test("the fabric between sparse proxy particles clears a limb, not just the particles", async () => {
  // Source proxies of 4 x 4 vertex blocks (0.5 m apart); a sphere presses
  // between four of them from behind.
  const f = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .15 }] });
  const position = f.geometry.getAttribute("position");
  const block = (i) => Math.min(3, Math.floor((position.getX(i) + 1) / .5)) + 4 * Math.min(3, Math.floor((1 - position.getY(i)) / .5));
  f.cloth.proxy = { vertices: Array.from({ length: position.count }, (_, i) => block(i)) };
  f.collider.position.set(0, -.5, -.3);
  const sim = await f.create();
  try {
    run(f, sim, 60, (i) => f.collider.position.set(0, -.5, -.3 + Math.min(1, i / 30) * .35));
    const centre = f.collider.getWorldPosition(new THREE.Vector3());
    for (const i of moving(f)) assert.ok(world(f.mesh, i).distanceTo(centre) > .15 + .002, `vertex ${i} sags into the sphere`);
  } finally { sim.destroy(); }
});

test("a lining pushed by a limb stays behind the fabric in front of it", async () => {
  // Outer sheet with a lining 5 mm behind it, both in one cloth primitive.
  const outer = new THREE.PlaneGeometry(2, 2, 16, 16), lining = outer.clone().translate(0, 0, -.005);
  const n = outer.getAttribute("position").count;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([...outer.getAttribute("position").array, ...lining.getAttribute("position").array], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([...outer.getAttribute("normal").array, ...outer.getAttribute("normal").array], 3));
  geometry.setIndex([...outer.index.array, ...Array.from(outer.index.array, (i) => i + n)]);
  const f = fixture({ extra: geometry, colliders: [{ shape: "capsule", node: 1, offset: [0, 0, 0], radius: .12, tail: { node: 1, offset: [.6, -.4, 0] } }] });
  const sim = await f.create();
  try {
    run(f, sim, 90, (i) => { f.collider.position.set(-.3, -.2, -.25 + Math.min(1, i / 40) * .3); f.collider.rotation.z = Math.sin(i * .1) * .4; });
    let pushed = 0;
    for (let i = 0; i < n; i++) {
      const front = world(f.mesh, i), back = world(f.mesh, i + n);
      pushed = Math.max(pushed, front.z);
      assert.ok(back.z < front.z + 1e-4, `lining vertex ${i} came through the outer fabric`);
    }
    assert.ok(pushed > .05, "the limb never reached the cloth");
  } finally { sim.destroy(); }
});

test("cloth never folds behind its animated surface", async () => {
  const f = fixture({ gravity: [0, 0, -60] });
  const sim = await f.create(), record = sim.records[0];
  try {
    run(f, sim, 60);
    for (const i of moving(f)) assert.ok(world(f.mesh, i).z > -1e-5, `vertex ${i} folded behind the sheet`);
    // The simulated proxies themselves respect it, not only their writeback.
    for (let i = 0; i < record.proxy.count; i++) assert.ok(record.solver.positions[i * 3 + 2] > -1e-5, `proxy ${i} folded behind the sheet`);
  } finally { sim.destroy(); }
});

test("double-sided cloth has no backstop where its faces disagree on the outside", async () => {
  // Back faces first: same positions, reversed winding and normals.
  const front = new THREE.PlaneGeometry(2, 2, 16, 16), count = front.getAttribute("position").count;
  const positions = [...front.getAttribute("position").array, ...front.getAttribute("position").array];
  const normals = [...Array.from({ length: count }, () => [0, 0, -1]).flat(), ...front.getAttribute("normal").array];
  const index = Array.from(front.index.array);
  const back = [];
  for (let t = 0; t < index.length; t += 3) back.push(index[t], index[t + 2], index[t + 1]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex([...back, ...index.map((i) => i + count)]);
  for (const gravity of [[0, 0, 60], [0, 0, -60]]) {
    const f = fixture({ extra: geometry.clone(), gravity });
    const sim = await f.create();
    try {
      run(f, sim, 60);
      const z = world(f.mesh, vertexAt(f, 0, -.9)).z;
      assert.ok(Math.sign(z) === Math.sign(gravity[2]) && Math.abs(z) > .05, `the cloth could not move towards ${gravity[2]}: z=${z}`);
    } finally { sim.destroy(); }
  }
});

test("displacement stays within the motion limit and relaxes back to the animation", async () => {
  const f = fixture({ gravity: [0, 0, 400] });
  const sim = await f.create(), record = sim.records[0];
  try {
    run(f, sim, 120);
    const { positions } = record.solver, { targets, maxDistance } = record;
    let pushed = 0;
    for (let i = 0; i < record.proxy.count; i++) {
      const d = Math.hypot(positions[i * 3] - targets[i * 3], positions[i * 3 + 1] - targets[i * 3 + 1], positions[i * 3 + 2] - targets[i * 3 + 2]);
      assert.ok(d <= maxDistance[i] + 1e-9, `proxy ${i} exceeds its motion limit`);
      pushed = Math.max(pushed, d);
    }
    assert.ok(pushed > .1, "the force did not move the cloth");
    f.cloth.gravity = [0, 0, 0];
    run(f, sim, 90);
    for (const i of moving(f)) assert.ok(Math.abs(world(f.mesh, i).z) < .01, `vertex ${i} did not return to its animated pose`);
  } finally { sim.destroy(); }
});

test("a detached piece without fixed vertices follows its garment", async () => {
  const layered = layeredGeometry();
  const f = fixture({ extra: layered.geometry });
  const sim = await f.create();
  try {
    run(f, sim, 120, (i) => { f.bone.position.set(Math.sin(i * .2) * .3, 0, Math.cos(i * .15) * .2); f.bone.rotation.y = Math.sin(i * .1) * .5; });
    const tag = layered.outer + layered.lining;
    const anchor = world(f.mesh, 58), sheet = new THREE.Vector3().fromBufferAttribute(f.geometry.getAttribute("position"), 58);
    for (let k = 0; k < layered.tag; k++) {
      const offset = new THREE.Vector3().fromBufferAttribute(sim.records[0].sourcePosition, tag + k).sub(sheet);
      const now = world(f.mesh, tag + k).sub(anchor);
      assert.ok(now.distanceTo(offset.applyQuaternion(f.bone.quaternion)) < .08, `tag vertex ${k} drifted from the sheet`);
    }
  } finally { sim.destroy(); }
});

test("toggling and destroying restore the source attributes", async () => {
  const f = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .4 }] });
  f.collider.position.set(0, -.5, .2);
  const sourcePosition = f.geometry.getAttribute("position"), sourceNormal = f.geometry.getAttribute("normal");
  const original = Array.from(sourcePosition.array);
  const sim = await f.create();
  try {
    run(f, sim, 20);
    assert.notDeepEqual(Array.from(f.geometry.getAttribute("position").array), original, "the cloth did not deform");
    sim.setEnabled(false);
    assert.deepEqual(Array.from(f.geometry.getAttribute("position").array), original);
    sim.update(STEP);
    assert.deepEqual(Array.from(f.geometry.getAttribute("position").array), original, "a disabled cloth still wrote geometry");
    sim.setEnabled(true); run(f, sim, 5);
  } finally { sim.destroy(); }
  assert.equal(f.geometry.getAttribute("position"), sourcePosition);
  assert.equal(f.geometry.getAttribute("normal"), sourceNormal);
  assert.deepEqual(Array.from(sourcePosition.array), original, "the source attribute was modified");
});

test("relative Morph remains part of the animated baseline without feedback", async () => {
  const f = fixture();
  const count = f.geometry.getAttribute("position").count;
  const delta = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) delta[i * 3 + 2] = .05;
  f.geometry.morphAttributes.position = [new THREE.BufferAttribute(delta, 3)];
  f.geometry.morphTargetsRelative = true;
  f.mesh.updateMorphTargets(); f.mesh.morphTargetInfluences[0] = 1;
  const sim = await f.create();
  try {
    run(f, sim, 30);
    for (let i = 0; i < count; i++) assert.ok(Math.abs(world(f.mesh, i).z - .05) < 1e-4, `vertex ${i} lost or doubled its Morph`);
    f.mesh.morphTargetInfluences[0] = 0;
    run(f, sim, 30);
    for (let i = 0; i < count; i++) assert.ok(Math.abs(world(f.mesh, i).z) < .01, `vertex ${i} kept the removed Morph`);
  } finally { sim.destroy(); }
});

test("tapered capsule pieces collapse into one collider without shrinking it", async () => {
  // Converter output: a 0.1 -> 0.05 m taper split into piecewise envelopes.
  const pieces = 5, colliders = [];
  for (let i = 0; i < pieces; i++) {
    const a = i / pieces, b = (i + 1) / pieces;
    colliders.push({ shape: "capsule", node: 1, offset: [0, -a, 0], radius: Math.max(.1 - .05 * a, .1 - .05 * b),
      tail: { node: 1, offset: [0, -b, 0] } });
  }
  colliders.push({ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .02 });
  const f = fixture({ colliders });
  f.collider.position.set(0, .2, -.06);
  const sim = await f.create();
  try {
    const shapes = sim.records[0].colliders;
    assert.equal(shapes.length, 2);
    assert.deepEqual(shapes[0].radius, [.1, .06]);
    run(f, sim, 30);
    // The rebuilt cone still encloses the source taper everywhere.
    let touched = false;
    for (const i of moving(f)) {
      const local = world(f.mesh, i).sub(f.collider.getWorldPosition(new THREE.Vector3()));
      if (local.y > 0 || local.y < -1) continue;
      const taper = .1 - .05 * -local.y, distance = Math.hypot(local.x, local.z);
      assert.ok(distance >= taper + .003 - 1e-6, `vertex ${i} is inside the tapered capsule`);
      touched ||= distance < taper + .01;
    }
    assert.ok(touched, "the capsule never touched the cloth");
  } finally { sim.destroy(); }
});

test("steep tapered capsules are the envelope of their spheres, not a radius-per-projection cone", async () => {
  // A short, strongly tapered thigh piece (0.095 -> 0.13 m over 8.5 cm),
  // as the converter splits it; lying across the sheet just behind it.
  const pieces = 8, colliders = [];
  for (let i = 0; i < pieces; i++) {
    const a = i / pieces, b = (i + 1) / pieces;
    colliders.push({ shape: "capsule", node: 1, offset: [-.04 + .085 * a, 0, 0], radius: .09 + .04 * b,
      tail: { node: 1, offset: [-.04 + .085 * b, 0, 0] } });
  }
  const f = fixture({ colliders });
  f.collider.position.set(.1, -.4, -.12);
  const sim = await f.create();
  try {
    assert.equal(sim.records[0].colliders.length, 1);
    run(f, sim, 30);
    const [r0, r1] = sim.records[0].colliders[0].radius, start = new THREE.Vector3(-.04, 0, 0), axis = new THREE.Vector3(.085, 0, 0);
    let touched = false;
    for (const i of moving(f)) {
      const local = world(f.mesh, i).sub(f.collider.getWorldPosition(new THREE.Vector3()));
      let clearance = Infinity;
      for (let k = 0; k <= 400; k++) {
        const u = k / 400;
        clearance = Math.min(clearance, local.distanceTo(start.clone().addScaledVector(axis, u)) - (r0 + (r1 - r0) * u));
      }
      assert.ok(clearance >= .003 - 2e-4, `vertex ${i} is ${(.003 - clearance) * 1000} mm inside the tapered capsule`);
      touched ||= clearance < .01;
    }
    assert.ok(touched, "the capsule never touched the cloth");
  } finally { sim.destroy(); }
});

test("finite panels contact the front, have finite bounds and leave deep backside states alone", async () => {
  const cases = [
    { offset: [0, -.3, -.01], expect: "front" },
    { offset: [5, -.3, -.01], expect: "untouched" },
    { offset: [0, -.3, .2], expect: "untouched" },
  ];
  for (const { offset, expect } of cases) {
    const f = fixture({ colliders: [{ shape: "panel", node: 1, offset: [0, 0, 0], halfAxes: [[.5, 0, 0], [.1, .5, 0]] }] });
    f.collider.position.fromArray(offset);
    const sim = await f.create();
    try {
      run(f, sim, 30);
      const near = moving(f).filter((i) => Math.abs(world(f.mesh, i).x - offset[0]) < .3 && Math.abs(world(f.mesh, i).y - offset[1]) < .3);
      for (const i of near) {
        const z = world(f.mesh, i).z;
        if (expect === "front") assert.ok(z >= offset[2] + .002, `vertex ${i} passed through the panel front`);
        else assert.ok(Math.abs(z) < 1e-4, `vertex ${i} was moved by a panel it does not touch`);
      }
    } finally { sim.destroy(); }
  }
});

test("plane contacts respect transformed normals and the mesh-scaled gap", async () => {
  const f = fixture({ colliders: [{ shape: "plane", node: 1, offset: [0, 0, 0], normal: [0, 1, 0] }] });
  f.collider.rotation.x = Math.PI / 2; f.collider.position.set(0, 0, .05);
  f.root.scale.setScalar(2);
  const sim = await f.create();
  try {
    run(f, sim, 30);
    for (const i of moving(f)) assert.ok(world(f.mesh, i).z >= .1 + .006 - 1e-6, `vertex ${i} is behind the scaled plane`);
  } finally { sim.destroy(); }
});

test("independent cloth instances keep separate colliders and state", async () => {
  const a = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .3 }] });
  const b = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .3 }] });
  a.collider.position.set(0, -.4, .1); b.collider.position.set(0, -.4, -5);
  const simA = await a.create(), simB = await b.create();
  try {
    run(a, simA, 30); run(b, simB, 30);
    simA.destroy();
    run(b, simB, 10);
    for (const i of moving(b)) assert.ok(Math.abs(world(b.mesh, i).z) < 1e-4, "another instance's collider moved this cloth");
  } finally { simA.destroy(); simB.destroy(); }
});

test("non-finite animation is rejected before it reaches the geometry", async () => {
  const f = fixture();
  const sim = await f.create();
  try {
    run(f, sim, 2);
    f.bone.position.x = NaN; f.root.updateMatrixWorld(true);
    assert.throws(() => sim.update(STEP), /非有限|不可逆/);
  } finally { sim.destroy(); }
});

test("a limb thinner than the particle spacing pushes the fabric instead of threading between particles", async () => {
  // Every vertex is its own particle, 0.5 m apart; a thin horizontal limb
  // sweeps through between two rows, touching no particle.
  const f = fixture({ segments: 4, colliders: [{ shape: "capsule", node: 1, offset: [-.12, 0, 0], radius: .04, tail: { node: 1, offset: [.12, 0, 0] } }] });
  f.cloth.proxy = { vertices: Array.from({ length: f.geometry.getAttribute("position").count }, (_, i) => i) };
  f.collider.position.set(0, -.25, -.3);
  const sim = await f.create();
  try {
    run(f, sim, 60, (i) => f.collider.position.set(0, -.25, -.3 + Math.min(1, i / 30) * .4));
    // The edge between the particles above and below the limb's path must
    // have been carried in front of it, not left behind it.
    const x = sim.records[0].solver.positions, a = vertexAt(f, 0, 0), b = vertexAt(f, 0, -.5);
    const middle = (x[a * 3 + 2] + x[b * 3 + 2]) / 2;
    assert.ok(middle > .1 + .04, `the fabric between two particles is ${((.14 - middle) * 1000).toFixed(0)} mm short of clearing the limb`);
  } finally { sim.destroy(); }
});

test("cloth authored across a thin limb stays as authored at rest", async () => {
  // A belt pendant draped over the hips: in the starting pose the fabric
  // between two particles already runs through a thin collider.
  const f = fixture({ segments: 4, colliders: [{ shape: "capsule", node: 1, offset: [-.12, 0, 0], radius: .04, tail: { node: 1, offset: [.12, 0, 0] } }] });
  f.cloth.proxy = { vertices: Array.from({ length: f.geometry.getAttribute("position").count }, (_, i) => i) };
  // The fabric cuts through the front of the limb, 1 cm behind it.
  f.collider.position.set(0, -.25, -.01);
  const sim = await f.create();
  try {
    run(f, sim, 60);
    const rest = sim.records[0].restPosition;
    let worst = 0;
    for (const i of moving(f)) worst = Math.max(worst, world(f.mesh, i).distanceTo(new THREE.Vector3().fromArray(rest, i * 3)));
    assert.ok(worst < 1e-3, `the cloth moved ${(worst * 1000).toFixed(1)} mm away from its authored pose`);
  } finally { sim.destroy(); }
});

test("a seam fixed on only one of its vertex copies stays put on every copy", async () => {
  // Non-indexed: every position has a copy per triangle, as at UV seams. The
  // configuration lists only the first copy of each top-row position.
  const geometry = new THREE.PlaneGeometry(2, 2, 8, 8).toNonIndexed();
  const f = fixture({ extra: geometry });
  const position = geometry.getAttribute("position"), seen = new Set();
  f.cloth.fixed = [];
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i)},${position.getY(i)}`;
    if (position.getY(i) > 1 - 1e-6 && !seen.has(key)) { seen.add(key); f.cloth.fixed.push(i); }
  }
  const sim = await f.create();
  try {
    run(f, sim, 30, () => { f.bone.position.x = .05; });
    const rest = sim.records[0].restPosition;
    for (let i = 0; i < position.count; i++) {
      const expected = new THREE.Vector3().fromArray(rest, i * 3).add(new THREE.Vector3(.05, 0, 0));
      const error = world(f.mesh, i).distanceTo(expected);
      assert.ok(error < 1e-4, `vertex ${i} at ${position.getX(i).toFixed(2)},${position.getY(i).toFixed(2)} is ${(error * 1000).toFixed(1)} mm off`);
    }
  } finally { sim.destroy(); }
});

test("explicit proxy groups are kept apart even for coincident vertices", async () => {
  // Two copies of one position assigned to different source groups (as a
  // converter may when a vertex sits on a group boundary): both groups stay.
  const geometry = new THREE.PlaneGeometry(2, 2, 8, 8).toNonIndexed();
  const f = fixture({ extra: geometry });
  const position = geometry.getAttribute("position");
  const block = (i) => Math.min(1, Math.floor((position.getX(i) + 1) / 1)) + 2 * Math.min(1, Math.floor((1 - position.getY(i)) / 1));
  const groups = Array.from({ length: position.count }, (_, i) => block(i));
  // A copy at the centre column, mid height, joins the neighbouring block.
  const copies = [];
  for (let i = 0; i < position.count; i++) if (Math.abs(position.getX(i)) < 1e-6 && Math.abs(position.getY(i) + .5) < 1e-6) copies.push(i);
  assert.ok(copies.length >= 2);
  const other = groups[copies[0]] ^ 1;
  groups[copies[1]] = other;
  f.cloth.proxy = { vertices: groups };
  const sim = await f.create();
  try {
    const { renderCluster } = sim.records[0].proxy;
    assert.notEqual(renderCluster[copies[0]], renderCluster[copies[1]], "the two source groups were merged");
    run(f, sim, 10);
    const rest = sim.records[0].restPosition;
    for (const i of copies) assert.ok(world(f.mesh, i).distanceTo(new THREE.Vector3().fromArray(rest, i * 3)) < 1e-4, `copy ${i} left its rest pose`);
  } finally { sim.destroy(); }
});

/** A skinned sphere mesh of the given radius following `bone`, as a body part. */
function bodySphere(root, bone, radius) {
  const geometry = new THREE.SphereGeometry(radius, 48, 24);
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([bone]));
  return mesh;
}

test("cloth clears the body mesh where it bulges out of the limb's collider", async () => {
  // The collider is 2 cm smaller than the skinned body around it.
  const f = fixture({ colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .15 }] });
  const bone = new THREE.Bone(); bone.name = "Hips"; f.root.add(bone); f.nodes[1] = bone;
  bodySphere(f.root, bone, .17);
  bone.position.set(0, -.3, -.4);
  const sim = await f.create();
  try {
    assert.ok(sim.body?.count > 0, "the body around the collider was not picked up");
    run(f, sim, 90, (i) => bone.position.set(0, -.3, -.4 + Math.min(1, i / 45) * .45));
    const centre = bone.getWorldPosition(new THREE.Vector3());
    let touched = false;
    for (const i of moving(f)) {
      const distance = world(f.mesh, i).distanceTo(centre);
      assert.ok(distance > .17, `vertex ${i} is ${((.17 - distance) * 1000).toFixed(1)} mm inside the body`);
      touched ||= distance < .18;
    }
    assert.ok(touched, "the body never reached the cloth");
  } finally { sim.destroy(); }
});

test("body surface the cloth already covers at load is left to the authored layering", async () => {
  const { BodySurface } = await import("../src/body-surface.js");
  const root = new THREE.Group(), bone = new THREE.Bone(); bone.name = "Hips"; root.add(bone);
  bodySphere(root, bone, .17);
  // A cloth patch 1 mm in front of the sphere's +Z pole.
  const cloth = [];
  for (let x = -.03; x <= .03; x += .005) for (let y = -.03; y <= .03; y += .005) cloth.push(x, y, Math.sqrt(.171 ** 2 - x * x - y * y));
  const body = BodySurface.create(root, new Set(), () => 0, cloth, new Set(["Hips"]));
  // Hair or fingers near a capsule are not part of the limb it stands for.
  assert.equal(BodySurface.create(root, new Set(), () => 0, cloth, new Set(["Head"])), null);
  assert.ok(body.openCount > 100, "the uncovered body was dropped");
  const P = body.position;
  body.update([-1, -1, -1, 1, 1, 1]);
  let covered = 0;
  for (let p = 0; p < body.count; p++) {
    if (body.covered[p]) { covered++; continue; }
    assert.ok(Math.hypot(P[p * 3], P[p * 3 + 1]) > .02 || P[p * 3 + 2] < 0, `covered point ${p} still collides`);
  }
  assert.ok(covered > 0, "nothing was covered");
  // A cloth point right there is left where it is.
  const x = [0, 0, .16], before = x.slice();
  assert.equal(body.collide(x, 0, .003, [0, 0, .16], 0, (reference, r) => r), false);
  assert.deepEqual(x, before);
});

test("a lining keeps its depth along the simulated surface where the cloth turns away from the animation", async () => {
  // Outer sheet with a lining 1 cm behind it; a large sphere tilts the lower
  // sheet forward, away from its animated (vertical) pose.
  const outer = new THREE.PlaneGeometry(2, 2, 16, 16), lining = outer.clone().translate(0, 0, -.01);
  const n = outer.getAttribute("position").count;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([...outer.getAttribute("position").array, ...lining.getAttribute("position").array], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([...outer.getAttribute("normal").array, ...outer.getAttribute("normal").array], 3));
  geometry.setIndex([...outer.index.array, ...Array.from(outer.index.array, (i) => i + n)]);
  const f = fixture({ extra: geometry, colliders: [{ shape: "sphere", node: 1, offset: [0, 0, 0], radius: .7 }] });
  f.collider.position.set(0, -1.1, -.9);
  const sim = await f.create();
  try {
    run(f, sim, 90, (i) => f.collider.position.set(0, -1.1, -.9 + Math.min(1, i / 45) * 1.1));
    const position = f.geometry.getAttribute("position");
    let turned = 0;
    for (let v = 0; v < n; v++) {
      const x = position.getX(v), y = position.getY(v);
      if (Math.abs(x) > .4 || y > -.2 || y < -.8) continue;
      const a = world(f.mesh, v), b = world(f.mesh, v + n);
      const side = world(f.mesh, vertexAt(f, x + .125, y)).sub(world(f.mesh, vertexAt(f, x - .125, y)));
      const down = world(f.mesh, vertexAt(f, x, y - .125)).sub(world(f.mesh, vertexAt(f, x, y + .125)));
      const normal = down.cross(side).normalize();
      turned = Math.max(turned, Math.acos(Math.min(1, normal.z)));
      const depth = a.clone().sub(b).dot(normal);
      assert.ok(depth > .006, `lining at ${x.toFixed(2)},${y.toFixed(2)} is ${(depth * 1000).toFixed(1)} mm behind the fabric`);
    }
    assert.ok(turned > 1.2, `the cloth only turned ${turned.toFixed(2)} rad`);
  } finally { sim.destroy(); }
});

test("cloth pinched in a closed crease stays in it instead of coming out behind the limb", () => {
  // A thigh folded up against the belly: their colliders overlap and the
  // skinned front of a skirt lies in both. Pushed out wherever it has drifted
  // to, the cloth slides round the thigh and comes out on its far side, where
  // nothing pushes it back.
  const solver = new ProxyClothSolver({ count: 2, edges: new Uint32Array([0, 1]), bends: new Uint32Array(0),
    fixed: new Uint8Array([1, 0]), colliderTypes: [COLLIDER.capsule, COLLIDER.capsule], colliderLimbs: new Int8Array([1, 0]) });
  const colliders = new Float64Array(2 * COLLIDER_STRIDE);
  colliders.set([-.2, 0, 0, .2, 0, 0, .05, .05]);
  colliders.set([-.2, 0, .06, .2, 0, .06, .05, .05], COLLIDER_STRIDE);
  const targets = new Float64Array([0, .3, .04, 0, 0, .03]);
  // The left thigh (segment 1) is folded against the trunk: its crease is closed.
  const step = (closedSegments) => solver.step({ targets, normals: null, colliders, radius: new Float64Array([.01, .01]),
    stiffness: 1, damping: .5, gravity: [0, 0, 0], delta: STEP, closedSegments });
  solver.reset(targets, colliders);
  // Squeezed to just behind the thigh's axis.
  solver.positions.set([0, 0, -.01], 3);
  for (let i = 0; i < 30; i++) {
    step(1 << 1);
    assert.ok(solver.positions[5] > -.03, `step ${i}: the cloth came out behind the thigh (z ${solver.positions[5].toFixed(3)})`);
  }
  // With the crease open (a kick) contact stays as it was: cloth on the far
  // side of a fast limb is not pulled through it.
  solver.reset(targets, colliders);
  solver.positions.set([0, 0, -.01], 3);
  step(0);
  assert.ok(solver.positions[5] < -.05, "cloth was pulled through an open limb");
});

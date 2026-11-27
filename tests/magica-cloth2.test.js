import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { Hierarchy } from "../src/unity-springbone.js";
import { decodeMagicaCloth2, evaluateAnimationCurve, convertFloatArray } from "../src/magica-cloth2/data.js";
import { MagicaClothTeam, simulationPower } from "../src/magica-cloth2/cloth.js";
import { createTeam, teamFrameTime } from "../src/magica-cloth2/team.js";
import { solveTriangleBending } from "../src/magica-cloth2/constraints.js";
import { MagicaClothBinding } from "../src/magica-cloth2/three-binding.js";
import { buildBoneCloth } from "../src/magica-cloth2/build.js";
import { buildMeshCloth } from "../src/magica-cloth2/build-mesh.js";
import { prebuildMagicaCloth2 } from "../src/magica-cloth2/prebuild.js";
import { createModelPhysics, ModelPhysics } from "../src/model-physics.js";

// converter physics.source.magicaCloth2 of 3d_costume_1001103101 (Kaho), trimmed to the skirt (MeshCloth, edge
// collision, 9 colliders), back hair (BoneCloth with triangles) and necktie (BoneCloth, no colliders)
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/magica-cloth2/3d_costume_1001103101.json", import.meta.url), "utf8"));
const byBuild = (decoded, id) => decoded.cloths.find((c) => c.buildId === `Extension_MagicaCloth_${id}`);

function hierarchyWorld(h) {
  return (id) => {
    const m = h.matrix(id);
    return { matrix: [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1],
      position: [m[3], m[7], m[11]], rotation: h.rotation(id),
      scale: [Math.hypot(m[0], m[4], m[8]), Math.hypot(m[1], m[5], m[9]), Math.hypot(m[2], m[6], m[10])] };
  };
}
const finite = (list) => list.every((v) => v.every(Number.isFinite));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("MagicaCloth2 PreBuild data decodes into consistent proxy meshes and constraints", () => {
  const decoded = decodeMagicaCloth2(fixture());
  const skirt = byBuild(decoded, "Skirt"), hair = byBuild(decoded, "BackHair"), tie = byBuild(decoded, "Necktie");
  assert.equal(skirt.proxy.count, 154);
  assert.equal(skirt.proxy.isBoneCloth, false);
  assert.equal(skirt.proxy.triangles.length, 273 * 3);
  assert.equal(skirt.mappings.length, 1);
  assert.equal(skirt.mappings[0].referenceIndices.length, 1191);
  assert.equal(skirt.colliders.length, 9);
  assert.equal(skirt.params.colliderCollisionConstraint.mode, 2);
  assert.equal(hair.proxy.isBoneCloth, true);
  assert.equal(hair.proxy.count, 25);
  assert.equal(tie.colliders.length, 0);
  for (const c of [skirt, hair, tie]) {
    const n = c.proxy.count;
    assert.equal(c.proxy.transformIds.length, c.proxy.isBoneCloth ? n + 1 : c.proxy.transformIds.length);
    assert.ok(c.proxy.parent.every((p) => p >= -1 && p < n) && c.proxy.root.every((r) => r >= -1 && r < n));
    // distance links: Pack12_20 (count, start) inside the data arrays
    for (const pack of c.distance.index) assert.ok((pack & 0xfffff) + (pack >>> 20) <= c.distance.data.length);
    assert.ok([...c.distance.data].every((v) => v < n));
    if (c.bending) for (const pair of c.bending.pairs) assert.ok(pair.every((v) => v < n) && new Set(pair).size === 4);
    // every proxy vertex is fixed or moving (Flag_Fixed / Flag_Move), depth in [0, 1]
    assert.ok(c.proxy.attr.every((a) => (a & 0x03) !== 0) && c.proxy.depth.every((d) => d >= 0 && d <= 1));
  }
  assert.ok(hair.bending.pairs.length > 0, "BackHair triangle bending pairs survive the uint64 round trip");
});

test("MagicaCloth2 parameters follow GetClothParameters (curves, 20 % damping / restoration)", () => {
  const curve = { m_Curve: [{ time: 0, value: 0.5, inSlope: 0, outSlope: 0, weightedMode: 0 }, { time: 1, value: 1, inSlope: 1.6037737, outSlope: 1.6037737, weightedMode: 0 }] };
  assert.equal(evaluateAnimationCurve(curve, 0), 0.5);
  assert.equal(evaluateAnimationCurve(curve, 1), 1);
  // Hermite: h00 y0 + h10 m0 + h01 y1 + h11 m1 at t = 0.5 -> 0.5 * 0.5 + 0.5 * 1 - 0.125 * 1.6037737
  assert.ok(Math.abs(evaluateAnimationCurve(curve, 0.5) - (0.75 - 0.125 * 1.6037737)) < 1e-12);
  assert.deepEqual(convertFloatArray({ value: 0.3, useCurve: 0, curve }), new Array(16).fill(0.3));
  const sampled = convertFloatArray({ value: 0.4, useCurve: 1, curve });
  assert.ok(Math.abs(sampled[0] - 0.2) < 1e-7 && Math.abs(sampled[15] - 0.4) < 1e-7);
  const skirt = byBuild(decodeMagicaCloth2(fixture()), "Skirt");
  assert.ok(Math.abs(skirt.params.dampingCurveData[15] - 0.4 * 0.2) < 1e-7);
  // game: 50 Hz -> t = 90 / 50 = 1.8
  assert.deepEqual(simulationPower(50).map((x) => +x.toFixed(6)), [1.8, +Math.sqrt(1.8).toFixed(6), +Math.pow(1.8, 0.3).toFixed(6), +Math.pow(1.8, 1.8).toFixed(6)]);
});

test("MagicaCloth2 curves: weighted keys with the default 1/3 weights evaluate exactly like unweighted keys", () => {
  // motionConstraint.backstopDistance of the 3033 skirts (the only weighted keys in the game data)
  const keys = (mode) => ({ m_Curve: [
    { time: 0, value: 0, inSlope: 1, outSlope: 0.26190475, weightedMode: 0, inWeight: 0, outWeight: 0.33333334 },
    { time: 0.63157894, value: 0.16540799, inSlope: 0.26190475, outSlope: 2.265021, weightedMode: mode, inWeight: 0.33333334, outWeight: 0.33333334 },
    { time: 1, value: 1, inSlope: 2.265021, outSlope: 1, weightedMode: 0, inWeight: 0.33333334, outWeight: 0 }] });
  const plain = keys(0), weighted = keys(3);
  for (let i = 0; i <= 100; i++) assert.equal(evaluateAnimationCurve(weighted, i / 100), evaluateAnimationCurve(plain, i / 100));
  const odd = keys(3);
  odd.m_Curve[1].outWeight = 0.5;
  assert.throws(() => evaluateAnimationCurve(odd, 0.8), /out-weight/);
  odd.m_Curve[1].weightedMode = 1;   // only the in side is weighted: the odd out weight is ignored, as in Unity
  assert.equal(evaluateAnimationCurve(odd, 0.8), evaluateAnimationCurve(plain, 0.8));
});

test("MagicaCloth2 time: 50 simulation steps per 60 frames, at most 5 per frame", () => {
  const team = createTeam({ initScale: [1, 1, 1], centerTransformIndex: 0 }, { inertiaConstraint: {} }, { initLocalGravityDirection: [0, -1, 0] });
  let steps = 0;
  for (let f = 0; f < 600; f++) {
    teamFrameTime(team, 1 / 60, 1 / 50, 5);
    steps += team.updateCount;
    team.nowUpdateTime += team.updateCount / 50;   // what SimulationStepTeamUpdate does once per step
    team.timeReset = false;
  }
  assert.ok(Math.abs(steps - 500) <= 1, `${steps} steps`);
  teamFrameTime(team, 0.5, 1 / 50, 5);
  assert.equal(team.updateCount, 5);
  assert.equal(team.skipCount, 20);
});

test("MagicaCloth2 triangle bending keeps a bent quad at its rest angle", () => {
  // v0, v1 opposite corners, v2-v3 the shared edge; rest: folded 90 degrees
  const pos = [[0, 0, 1], [1, 0, 0], [0, 0, 0], [0, 1, 0]];
  const s = {
    count: 4, attr: [0x01, 0x02, 0x01, 0x01], depth: [0, 1, 0, 0], friction: [0, 0, 0, 0],
    nextPos: pos.map((p) => p.slice()), tmpVecA: new Int32Array(12), tmpCount: new Int32Array(4),
    bending: { pairs: [[0, 1, 2, 3]], restAngleOrVolume: Float32Array.from([Math.PI / 2]), signOrVolume: Int8Array.from([1]) },
  };
  const team = { scaleRatio: 1, params: { triangleBendingConstraint: { method: 2, stiffness: 1 } } };
  s.nextPos[1] = [0.9, 0, 0.45];   // disturb the free corner
  const angle = () => {
    const [p0, p1, p2, p3] = s.nextPos, e = [p3[0] - p2[0], p3[1] - p2[1], p3[2] - p2[2]];
    const n1 = new THREE.Vector3(...p2).sub(new THREE.Vector3(...p0)).cross(new THREE.Vector3(...p3).sub(new THREE.Vector3(...p0))).normalize();
    const n2 = new THREE.Vector3(...p3).sub(new THREE.Vector3(...p1)).cross(new THREE.Vector3(...p2).sub(new THREE.Vector3(...p1))).normalize();
    return Math.acos(n1.dot(n2)) * Math.sign(new THREE.Vector3().crossVectors(n1, n2).dot(new THREE.Vector3(...e)));
  };
  const before = Math.abs(angle() - Math.PI / 2);
  for (let i = 0; i < 20; i++) solveTriangleBending(s, team, [1, 1, 1, 1]);
  assert.ok(Math.abs(angle() - Math.PI / 2) < before * 0.05, `${angle()} vs ${Math.PI / 2}`);
  assert.deepEqual(s.nextPos[0], pos[0], "fixed vertices are not moved");
});

test("MagicaCloth2 teams start at the base pose and stay finite and bounded under motion", () => {
  const source = fixture();
  const decoded = decodeMagicaCloth2(source);
  const h = new Hierarchy(source.transforms);
  const world = hierarchyWorld(h);
  const teams = decoded.cloths.map((c) => new MagicaClothTeam(c));
  const restLocal = new Map();
  for (const t of teams) if (t.proxy.isBoneCloth) t.proxy.transformIds.slice(0, t.proxy.count).forEach((id) => restLocal.set(id, h.localRot.get(id)));
  const skirtTeam = teams.find((t) => !t.proxy.isBoneCloth);
  // frame 1 (stabilization: blend weight 0): output = skinned base pose
  for (const t of teams) {
    const out = t.frame(1 / 60, world);
    if (out.bones) {
      out.bones.forEach((b, v) => {
        if (!b?.localRotation) return;
        // normalized first: float32 quaternions are ~1e-7 off unit length, which angleTo turns into ~0.03 deg
        const q = new THREE.Quaternion(...b.localRotation).normalize(), r = new THREE.Quaternion(...restLocal.get(t.proxy.transformIds[v])).normalize();
        assert.ok(q.angleTo(r) < 1e-3 * Math.PI / 180, `${t.def.buildId} bone ${v}: ${q.angleTo(r)}`);
      });
    } else {
      const m = out.meshes[0], center = world(m.mapping.centerTransformId);
      let max = 0;
      m.positions.forEach((p, k) => { if (p) max = Math.max(max, dist(p, mPoint(center.matrix, m.mapping.localPositions[k]))); });
      assert.ok(max < 1e-5, `skirt render vertices at the base pose: ${max}`);
      assert.equal(m.positions.filter(Boolean).length, 1018);
    }
  }
  // sway the prefab root 15 cm at 1 Hz for 4 s
  const roots = source.transforms.filter((t) => t.parentId === null).map((t) => t.id);
  const rest = roots.map((id) => h.localPos.get(id).slice());
  let maxLag = 0;
  for (let f = 1; f < 240; f++) {
    roots.forEach((id, i) => h.setLocal(id, { pos: [rest[i][0] + 0.15 * Math.sin(2 * Math.PI * f / 60), rest[i][1], rest[i][2]] }));
    for (const t of teams) {
      t.frame(1 / 60, world);
      assert.ok(finite(t.state.positions) && finite(t.state.rotations), `${t.def.buildId} frame ${f}`);
    }
    const s = skirtTeam.state;
    s.positions.forEach((p, v) => { if (s.attr[v] & 2) maxLag = Math.max(maxLag, dist(p, s.basePos[v])); });
  }
  assert.ok(maxLag > 0.005 && maxLag < 0.25, `skirt lag behind its base pose: ${maxLag}`);
});
const mPoint = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

// three.js scene for the fixture: every transform an Object3D (glTF frame = Unity X mirror), the skirt renderer a
// SkinnedMesh whose vertices are the mapping mesh's rest positions, skinned rigidly to the renderer transform.
function sceneFor(source) {
  const root = new THREE.Group();
  const objects = [], byId = new Map();
  source.transforms.forEach((t, i) => {
    const o = new THREE.Object3D();
    o.name = t.name;
    o.position.set(-t.localPosition[0], t.localPosition[1], t.localPosition[2]);
    o.quaternion.set(t.localRotation[0], -t.localRotation[1], -t.localRotation[2], t.localRotation[3]);
    o.scale.fromArray(t.localScale);
    t.node = i; objects.push(o); byId.set(t.id, o);
  });
  source.transforms.forEach((t) => (t.parentId === null ? root : byId.get(t.parentId)).add(byId.get(t.id)));
  root.updateMatrixWorld(true);
  const skirt = decodeMagicaCloth2(source).cloths.find((c) => c.mappings?.length).mappings[0];
  const rendererIndex = source.transforms.findIndex((t) => t.id === skirt.renderer.transformId);
  for (const c of source.components) {
    for (const s of c.fields.serializeData2?.preBuildData?.uniquePreBuildData?.renderSetupDataList ?? []) {
      s.renderer.mesh.node = rendererIndex; s.renderer.mesh.primitives = 1;
    }
  }
  const n = Math.max(...skirt.referenceIndices) + 1;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3);
  skirt.referenceIndices.forEach((vi, k) => {
    const p = skirt.localPositions[k], q = skirt.localNormals[k];
    position.set([-p[0], p[1], p[2]], vi * 3); normal.set([-q[0], q[1], q[2]], vi * 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
  const holder = objects[rendererIndex], bone = new THREE.Bone();
  holder.add(bone);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  holder.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([bone]), mesh.matrixWorld);
  return { root, objects, mesh, resolve: (i) => objects[i], resolvePrimitive: () => mesh };
}

test("MagicaCloth2 three binding: base pose reproduces the rest mesh, motion moves bones and vertices, release restores", () => {
  const source = fixture();
  const { root, mesh, resolve, resolvePrimitive } = sceneFor(source);
  const binding = new MagicaClothBinding(source, root, { resolve, resolvePrimitive });
  assert.equal(binding.teams.length, 3);
  assert.equal(binding.mirror, true);
  assert.ok(binding.rmsFitError < 1e-6);
  const original = mesh.geometry.getAttribute("position").array.slice();
  const vertexWorld = (vi) => mesh.localToWorld(mesh.getVertexPosition(vi, new THREE.Vector3()));
  const map = binding.meshes[0].mapping;
  const moving = map.referenceIndices.filter((_, k) => (map.attr[k] & 0x02) && !(map.attr[k] & 0x01));
  const rest = new Map(moving.map((vi) => [vi, vertexWorld(vi)]));
  const restBones = binding.bones.map((b) => b.node.getWorldPosition(new THREE.Vector3()));
  binding.update(1 / 60);
  let max = 0;
  for (const vi of moving) max = Math.max(max, vertexWorld(vi).distanceTo(rest.get(vi)));
  assert.ok(max < 1e-5, `frame 1 vertices ${max}`);
  binding.bones.forEach((b, i) => assert.ok(b.node.getWorldPosition(new THREE.Vector3()).distanceTo(restBones[i]) < 1e-5));
  for (let f = 1; f < 90; f++) {
    binding.restore();
    root.position.x = 0.2 * Math.sin(2 * Math.PI * f / 60);
    root.updateMatrixWorld(true);
    binding.update(1 / 60);
  }
  root.position.x = 0; root.updateMatrixWorld(true);
  let vmax = 0, bmax = 0;
  for (const vi of moving) vmax = Math.max(vmax, vertexWorld(vi).distanceTo(rest.get(vi)));
  binding.bones.forEach((b, i) => { bmax = Math.max(bmax, b.node.getWorldPosition(new THREE.Vector3()).distanceTo(restBones[i])); });
  assert.ok(vmax > 1e-3 && Number.isFinite(vmax), `vertices moved ${vmax}`);
  assert.ok(bmax > 1e-3 && Number.isFinite(bmax), `bones moved ${bmax}`);
  binding.release();
  assert.deepEqual(mesh.geometry.getAttribute("position").array, original);
  binding.bones.forEach((b, i) => assert.ok(b.node.getWorldPosition(new THREE.Vector3()).distanceTo(restBones[i]) < 1e-9));
});

test("ModelPhysics runs MagicaCloth2 after the other physics and drops the generic springs it replaces", () => {
  const source = fixture();
  const { root, resolve, resolvePrimitive } = sceneFor(source);
  const hairBone = decodeMagicaCloth2(source).cloths.find((c) => c.buildId.endsWith("BackHair"));
  const movingIndex = hairBone.proxy.attr.findIndex((a) => a & 0x02);
  const node = source.transforms.findIndex((t) => t.id === hairBone.proxy.transformIds[movingIndex]);
  const physics = { colliders: [], springs: [{ node, tail: [0, -0.1, 0], radius: 0, stiffness: 1, damping: 0.5, gravity: [0, 0, 0], colliders: [] }],
    source: { magicaCloth2: source } };
  const model = new ModelPhysics(root, [{ physics, resolve, resolvePrimitive }]);
  assert.equal(model.records.length, 0, "generic spring on a MagicaCloth2 bone is skipped");
  assert.equal(model.sourceMagica[0].teams.length, 3);
  assert.equal(model.magicaMeshes.size, 1);
  const order = [];
  const target = resolve(node), rest = target.getWorldPosition(new THREE.Vector3());
  for (let f = 0; f < 60; f++) {
    model.advance(1 / 60, () => { root.position.x = 0.2 * Math.sin(2 * Math.PI * f / 60); order.push("animate"); }, () => order.push("after"));
  }
  assert.deepEqual(order.slice(0, 4), ["animate", "after", "animate", "after"]);
  root.position.x = 0; root.updateMatrixWorld(true);
  model.advance(1 / 60, () => {});
  assert.ok(target.getWorldPosition(new THREE.Vector3()).distanceTo(rest) > 1e-3, "BackHair bone simulated");
  model.setEnabled(false);
  root.updateMatrixWorld(true);
  assert.ok(target.getWorldPosition(new THREE.Vector3()).distanceTo(rest) < 1e-9, "disabled physics restores the bone");
  model.destroy();
});

test("the mesh cloth option skips MagicaCloth2 mesh decoding and binding while keeping its bone simulation", async () => {
  for (const meshClothEnabled of [false, true]) {
    const source = fixture();
    const { root, objects, mesh } = sceneFor(source);
    const physics = { source: { magicaCloth2: source } };
    const nodes = objects.map((object) => object === mesh.parent ? { mesh: 0 } : {});
    let primitiveLookups = 0;
    const parser = {
      getDependencies: async () => objects,
      associations: new Map([[mesh, { meshes: 0, primitives: 0 }]]),
      get json() { primitiveLookups++; return { nodes }; },
    };
    const model = await createModelPhysics(root, [{ component: { physics }, gltf: { parser } }], { meshClothEnabled });
    try {
      const binding = model.sourceMagica[0];
      const expectedMeshes = Number(meshClothEnabled);
      assert.equal(binding.decoded.cloths.filter((cloth) => cloth.clothType === 0).length, expectedMeshes);
      assert.equal(primitiveLookups, expectedMeshes);
      assert.equal(model.magicaMeshes.size, expectedMeshes);
      assert.equal(binding.teams.filter((team) => team.proxy.isBoneCloth).length, 2);
      const initial = binding.drivenObjects.map((bone) => bone.quaternion.clone());
      for (let frame = 0; frame < 60; frame++) {
        model.advance(1 / 60, () => {
          root.position.x = 0.2 * Math.sin(2 * Math.PI * frame / 60);
          root.updateMatrixWorld(true);
        });
      }
      assert.ok(binding.drivenObjects.some((bone, index) => bone.quaternion.angleTo(initial[index]) > 1e-3));
    } finally {
      model.destroy();
    }
  }
});

// ------------------------------------------------------------------ runtime BoneCloth build (no PreBuild data)
// 3d_costume_3020103101 trimmed to two BoneCloths with custom skinning: SleeveR (SequentialNonLoopMesh) and
// SleeveRibbon (AutomaticMesh)
const fixture2 = () => JSON.parse(readFileSync(new URL("./fixtures/magica-cloth2/3d_costume_3020103101.json", import.meta.url), "utf8"));

test("ModelPhysics: a bone a MagicaCloth2 cloth leaves invalid follows the animation, its fallback spring is dropped", () => {
  // 2004104201's back ribbon: the selection data marks the root invalid and only the end point movable, so the game's
  // MagicaCloth never moves the skinned root.  Reproduced on the necktie: chain 02's root invalid, its end movable.
  const source = fixture();
  const tie = source.components.filter((c) => c.class === "MagicaCloth")[2];
  delete tie.fields.serializeData2.preBuildData;
  tie.fields.serializeData2.selectionData.attributes[0] = { Value: 0 };
  const { root, resolve, resolvePrimitive } = sceneFor(source);
  const def = decodeMagicaCloth2(source).cloths.find((c) => c.transformId === tie.transformId);
  const v = def.proxy.attr.findIndex((a, i) => a === 0 && def.proxy.parent.some((p, j) => p === i && (def.proxy.attr[j] & 0x02)));
  assert.ok(v >= 0, "an invalid bone with a movable child");
  const node = source.transforms.findIndex((t) => t.id === def.proxy.transformIds[v]);
  const physics = { colliders: [], springs: [{ node, tail: [0, -0.1, 0], radius: 0, stiffness: 1, damping: 0.5, gravity: [0, 0, 0], colliders: [] }],
    source: { magicaCloth2: source } };
  const model = new ModelPhysics(root, [{ physics, resolve, resolvePrimitive }]);
  assert.equal(model.records.length, 0, "no fallback spring on the invalid bone");
  assert.ok(!model.sourceMagica[0].drivenObjects.includes(resolve(node)) && model.sourceMagica[0].coveredObjects.includes(resolve(node)));
  const target = resolve(node), rest = target.quaternion.clone();
  for (let f = 0; f < 60; f++) model.advance(1 / 60, () => { root.position.x = 0.2 * Math.sin(2 * Math.PI * f / 60); root.updateMatrixWorld(true); });
  assert.ok(target.quaternion.angleTo(rest) < 1e-6, "the invalid bone keeps its animated (rest) rotation");
  model.destroy();
});

const b64Ints = (f, size) => {
  if (Array.isArray(f)) return f.flatMap((k) => (typeof k === "object" ? [k.x, k.y] : [k]));
  const b = Buffer.from(f.base64, "base64"), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: b.byteLength / size }, (_, i) => (size === 2 ? v.getUint16(i * 2, true) : v.getUint32(i * 4, true)));
};
const angleDeg = (a, b) => Math.acos(Math.min(1, Math.max(-1, a.reduce((s, x, k) => s + x * b[k], 0) / (Math.hypot(...a) * Math.hypot(...b))))) * 180 / Math.PI;
const unitQ = (q) => { const n = Math.hypot(...q); return q.map((x) => x / n); };

test("MagicaCloth2 runtime BoneCloth build reproduces the game's PreBuild data", () => {
  let checked = 0;
  for (const source of [fixture(), fixture2()]) {
    const decoded = decodeMagicaCloth2(source);
    const raws = source.components.filter((c) => c.class === "MagicaCloth");
    decoded.cloths.forEach((def, k) => {
      if (def.clothType !== 1) return;
      const raw = raws[k], pm = raw.fields.serializeData2.preBuildData.sharePreBuildData.proxyMesh;
      const b = buildBoneCloth(source.transforms, { transformId: raw.transformId, ...raw.fields }, def.params);
      const p = def.proxy, q = b.proxy, name = def.buildId;
      assert.ok(b.build.siblingOrder, `${name}: transform table carries the child order`);
      // topology and every order that comes from C# / Unity.Collections containers
      for (const key of ["transformIds", "attr", "triangles", "lines", "edges", "parent", "root", "centerFixedList",
        "childIndex", "childData", "skinBoneTransformIndices"]) {
        assert.deepEqual(Array.from(q[key]), Array.from(p[key]), `${name}.${key}`);
      }
      assert.deepEqual(q.baseLine, { flags: p.baseLine.flags, start: p.baseLine.start, count: p.baseLine.count, data: p.baseLine.data }, `${name}.baseLine`);
      assert.deepEqual(q.vertexToTriangles.map(String), p.vertexToTriangles.map(String), `${name}.vertexToTriangles`);
      assert.deepEqual(Array.from(b.build.vertexToVertex.index), b64Ints(pm.vertexToVertexIndexArray, 4), `${name} vertexToVertex index`);
      assert.deepEqual(b.build.vertexToVertex.data, b64Ints(pm.vertexToVertexDataArray, 2), `${name} vertexToVertex data`);
      assert.deepEqual(b.build.edgeToTriangles.flatMap(([x, y]) => [x, y]), b64Ints(pm.edgeToTrianglesKeys, 4), `${name} edgeToTriangles keys`);
      assert.deepEqual(Array.from(b.distance.index), Array.from(def.distance.index), `${name} distance index`);
      assert.deepEqual(Array.from(b.distance.data), Array.from(def.distance.data), `${name} distance data`);
      assert.equal(!!b.bending, !!def.bending, `${name} bending`);
      if (def.bending) assert.deepEqual(b.bending.pairs.map(String), def.bending.pairs.map(String), `${name} bending pairs`);
      assert.deepEqual(q.boneWeights.map((w) => w.i.join()), p.boneWeights.map((w) => w.i.join()), `${name} bone weight indices`);
      // values: float32 rounding only
      const close = (a, c, tol, label) => a.forEach((v, i) => v.forEach((x, j) => assert.ok(Math.abs(x - c[i][j]) <= tol, `${name}.${label}[${i}]`)));
      close(q.localPositions, p.localPositions, 1e-6, "localPositions");
      close(q.boneWeights.map((w) => w.w), p.boneWeights.map((w) => w.w), 1e-6, "boneWeights");
      close(q.skinBoneBindPoses, p.skinBoneBindPoses, 1e-5, "skinBoneBindPoses");
      close(q.vertexLocalPositions, p.vertexLocalPositions, 1e-6, "vertexLocalPositions");
      q.localNormals.forEach((n, i) => assert.ok(angleDeg(n, p.localNormals[i]) < 1e-3, `${name} normal ${i}`));
      q.localTangents.forEach((t, i) => assert.ok(angleDeg(t, p.localTangents[i]) < 1e-3, `${name} tangent ${i}`));
      Array.from(b.distance.dist).forEach((d, i) => assert.ok(Math.abs(d - def.distance.dist[i]) < 1e-6, `${name} distance ${i}`));
      if (def.bending) Array.from(b.bending.restAngleOrVolume).forEach((r, i) => assert.ok(Math.abs(r - def.bending.restAngleOrVolume[i]) < 1e-3, `${name} rest ${i}`));
      b.initLocalGravityDirection.forEach((x, i) => assert.ok(Math.abs(x - def.initLocalGravityDirection[i]) < 1e-6, `${name} gravity`));
      checked++;
    });
  }
  assert.equal(checked, 4);   // BackHair, Necktie, SleeveR, SleeveRibbon
});

test("MagicaCloth2 BoneCloths without PreBuild data are built at decode time and start at the base pose", () => {
  for (const source of [fixture(), fixture2()]) {
    for (const c of source.components) if (c.class === "MagicaCloth" && c.fields.serializeData.clothType === 1) delete c.fields.serializeData2.preBuildData;
    const decoded = decodeMagicaCloth2(source);
    const h = new Hierarchy(source.transforms), world = hierarchyWorld(h);
    for (const def of decoded.cloths.filter((d) => d.clothType === 1)) {
      assert.equal(def.prebuilt, false);
      assert.equal(def.runtimeBuild, true, def.error);
      const team = new MagicaClothTeam(def);
      const out = team.frame(1 / 60, world);
      out.bones.forEach((b, v) => {
        if (!b?.localRotation) return;
        const id = team.proxy.transformIds[v];
        const q = new THREE.Quaternion(...b.localRotation).normalize(), r = new THREE.Quaternion(...h.localRot.get(id)).normalize();
        assert.ok(q.angleTo(r) < 1e-3 * Math.PI / 180, `${def.transformId} bone ${v}: ${q.angleTo(r)}`);
        assert.ok(dist(b.localPosition, h.localPos.get(id)) < 1e-6, `${def.buildId} bone ${v} position`);
      });
      const pivot = team.proxy.transformIds[team.proxy.centerFixedList[0]];
      for (let f = 0; f < 120; f++) {
        h.setLocal(pivot, { rot: unitQ([0, Math.sin(f / 10) * 0.2, 0, 1]) });
        team.frame(1 / 60, world);
        assert.ok(finite(team.state.positions), `${def.buildId} frame ${f}`);
      }
    }
  }
  // a MeshCloth without PreBuild data needs the original mesh (converter meshData); without it, it is reported
  const source = fixture();
  delete source.components.find((c) => c.class === "MagicaCloth" && c.fields.serializeData.clothType === 0).fields.serializeData2.preBuildData;
  const skirt = decodeMagicaCloth2(source).cloths.find((d) => d.clothType === 0);
  assert.throws(() => new MagicaClothTeam(skirt), /meshData/);
});

// ------------------------------------------------------------------ runtime MeshCloth build (no PreBuild data)
// Two MeshCloths whose PreBuild the runtime build reproduces exactly (in general the vertex numbering can differ,
// see build-mesh.js): Belt_B (SimpleDistance reduction) and RibbonTie (ShapeDistance reduction, normal alignment).
const meshFixtures = () => ["3020103202", "3026103101"].map((id) => JSON.parse(readFileSync(new URL(`./fixtures/magica-cloth2/3d_costume_${id}.json`, import.meta.url), "utf8")));

test("MagicaCloth2 runtime MeshCloth build reproduces the game's PreBuild data", () => {
  let checked = 0;
  for (const source of meshFixtures()) {
    const decoded = decodeMagicaCloth2(source);
    const raws = source.components.filter((c) => c.class === "MagicaCloth");
    decoded.cloths.forEach((def, k) => {
      if (def.clothType !== 0) return;
      const raw = raws[k], pm = raw.fields.serializeData2.preBuildData.sharePreBuildData.proxyMesh;
      const b = buildMeshCloth(source.transforms, { transformId: raw.transformId, ...raw.fields }, def.params);
      const p = def.proxy, q = b.proxy, name = def.buildId;
      for (const key of ["transformIds", "attr", "triangles", "lines", "edges", "parent", "centerFixedList", "childIndex", "childData", "skinBoneTransformIndices"]) {
        assert.deepEqual(Array.from(q[key]), Array.from(p[key]), `${name}.${key}`);
      }
      assert.equal(q.centerTransformIndex, p.centerTransformIndex);
      assert.deepEqual(q.baseLine, { flags: p.baseLine.flags, start: p.baseLine.start, count: p.baseLine.count, data: p.baseLine.data }, `${name}.baseLine`);
      assert.deepEqual(Array.from(b.build.vertexToVertex.index), b64Ints(pm.vertexToVertexIndexArray, 4), `${name} vertexToVertex`);
      assert.deepEqual(q.boneWeights.map((w) => w.i.join()), p.boneWeights.map((w) => w.i.join()), `${name} bone weight indices`);
      assert.deepEqual(Array.from(b.distance.data), Array.from(def.distance.data), `${name} distance`);
      assert.equal(!!b.bending, !!def.bending, `${name} bending`);
      if (def.bending) assert.deepEqual(b.bending.pairs.map(String), def.bending.pairs.map(String), `${name} bending pairs`);
      const close = (a, c, tol, label) => a.forEach((v, i) => v.forEach((x, j) => assert.ok(Math.abs(x - c[i][j]) <= tol, `${name}.${label}[${i}]`)));
      close(q.localPositions, p.localPositions, 1e-6, "localPositions");
      close(q.boneWeights.map((w) => w.w), p.boneWeights.map((w) => w.w), 1e-6, "boneWeights");
      close(q.skinBoneBindPoses, p.skinBoneBindPoses, 1e-5, "skinBoneBindPoses");
      q.localNormals.forEach((n, i) => assert.ok(angleDeg(n, p.localNormals[i]) < 0.02, `${name} normal ${i}`));
      const bb = pm.boundingBox;
      close([b.build.boundingBox.min, b.build.boundingBox.max], [[bb.Min.x, bb.Min.y, bb.Min.z], [bb.Max.x, bb.Max.y, bb.Max.z]], 1e-6, "boundingBox");
      // render vertex -> proxy mapping
      const pmap = def.mappings[0], qmap = b.mappings[0];
      assert.deepEqual(qmap.referenceIndices, pmap.referenceIndices, `${name} mapping vertices (selection)`);
      assert.deepEqual(qmap.attr, pmap.attr, `${name} mapping attributes`);
      assert.deepEqual(qmap.boneWeights.map((w) => w.i.join()), pmap.boneWeights.map((w) => w.i.join()), `${name} mapping proxy vertices`);
      close(qmap.boneWeights.map((w) => w.w), pmap.boneWeights.map((w) => w.w), 1e-5, "mapping weights");
      close(qmap.localPositions, pmap.localPositions, 1e-6, "mapping localPositions");
      close([qmap.toProxyMatrix], [pmap.toProxyMatrix], 1e-6, "toProxyMatrix");
      assert.equal(qmap.centerTransformId, pmap.centerTransformId);
      checked++;
    });
  }
  assert.equal(checked, 2);
});

test("MagicaCloth2 MeshCloths without PreBuild data are built from the original mesh and start at the base pose", () => {
  for (const source of meshFixtures()) {
    for (const c of source.components) if (c.class === "MagicaCloth") delete c.fields.serializeData2.preBuildData;
    const h = new Hierarchy(source.transforms), world = hierarchyWorld(h);
    const def = decodeMagicaCloth2(source).cloths.find((d) => d.clothType === 0);
    assert.equal(def.runtimeBuild, true, def.error);
    const team = new MagicaClothTeam(def);
    const out = team.frame(1 / 60, world);
    const m = out.meshes[0], center = world(m.mapping.centerTransformId);
    let max = 0, written = 0;
    m.positions.forEach((p, k) => { if (p) { written++; max = Math.max(max, dist(p, mPoint(center.matrix, m.mapping.localPositions[k]))); } });
    assert.ok(written > 0 && max < 1e-5, `render vertices at the base pose: ${max} over ${written}`);
    const pivot = team.proxy.transformIds[team.proxy.skinBoneTransformIndices[0]];
    const rest = h.localRot.get(pivot);
    for (let f = 0; f < 120; f++) {
      h.setLocal(pivot, { rot: unitQ([rest[0], rest[1] + Math.sin(f / 10) * 0.2, rest[2], rest[3]]) });
      team.frame(1 / 60, world);
      assert.ok(finite(team.state.positions), `${def.transformId} frame ${f}`);
    }
  }
});

// ------------------------------------------------------------------ conversion-time prebuild (prebuild.js)
const builtMeshes = (d) => JSON.parse(JSON.stringify({ proxy: d.proxy, mappings: d.mappings, distance: d.distance, bending: d.bending, g: d.initLocalGravityDirection },
  (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
test("MagicaCloth2 prebuild: runtimePreBuild decodes to exactly the runtime build and replaces meshData", () => {
  for (const source of [fixture(), fixture2(), ...meshFixtures()]) {
    // keep the game PreBuild of the first of several cloths (and of MeshCloths without meshData), build the rest
    const cloths = source.components.filter((c) => c.class === "MagicaCloth");
    const expected = cloths.map((c, i) => {
      const sd = c.fields.serializeData;
      if ((i === 0 && cloths.length > 1) || (sd.clothType === 0 && !sd.sourceRenderers[0].meshData)) return "prebuilt";
      delete c.fields.serializeData2.preBuildData;
      return "built";
    });
    assert.ok(expected.includes("built"));
    const runtime = decodeMagicaCloth2(structuredClone(source));
    const report = prebuildMagicaCloth2(source);
    assert.deepEqual(report.map((r) => r.status), expected, JSON.stringify(report));
    const converted = JSON.parse(JSON.stringify(source));
    const check = (data) => {
      const decoded = decodeMagicaCloth2(data);
      decoded.cloths.forEach((def, i) => {
        assert.equal(def.error, undefined);
        assert.equal(def.prebuilt, expected[i] === "prebuilt");
        assert.equal(!!def.runtimePreBuild, expected[i] === "built");
        assert.deepEqual(builtMeshes(def), builtMeshes(runtime.cloths[i]), `cloth ${i}`);
      });
    };
    check(converted);
    converted.components.filter((c) => c.class === "MagicaCloth").forEach((c, i) => {
      assert.equal(!!c.runtimePreBuild, expected[i] === "built");
      if (expected[i] === "built") for (const r of c.fields.serializeData.sourceRenderers ?? []) assert.equal(r?.meshData, undefined);
    });
    // running it again: BoneCloths are rebuilt, MeshCloths (meshData gone) keep their result
    const again = prebuildMagicaCloth2(converted);
    assert.deepEqual(again.map((r) => r.status), cloths.map((c, i) => (expected[i] !== "built" ? expected[i] : c.fields.serializeData.clothType === 1 ? "built" : "kept")));
    check(JSON.parse(JSON.stringify(converted)));
  }
});

test("MagicaCloth2 inertia anchor: moving the whole character (avatar root) adds no cloth inertia", () => {
  // skirt display positions per frame, mapped into the root's rest frame
  const run = (move, anchored) => {
    const source = fixture();
    const h = new Hierarchy(source.transforms), world = hierarchyWorld(h);
    const rootId = source.transforms.find((t) => t.parentId === null).id;
    const restMatrix = new THREE.Matrix4().fromArray(world(rootId).matrix), rest = h.localPos.get(rootId).slice();
    const team = new MagicaClothTeam(byBuild(decodeMagicaCloth2(source), "Skirt"), { anchorTransformId: anchored ? rootId : null });
    const frames = [];
    for (let f = 0; f < 180; f++) {
      if (move) h.setLocal(rootId, { pos: [rest[0] + 0.3 * Math.sin(2 * Math.PI * f / 60), rest[1], rest[2] + 0.01 * f], rot: unitQ([0, Math.sin(f / 20) * 0.3, 0, 1]) });
      team.frame(1 / 60, world);
      const toRest = restMatrix.clone().multiply(new THREE.Matrix4().fromArray(world(rootId).matrix).invert());
      frames.push(team.state.positions.map((p, v) => (team.state.attr[v] & 2 ? new THREE.Vector3(...p).applyMatrix4(toRest).toArray() : null)));
    }
    return frames;
  };
  const still = run(false, false);
  const deviation = (frames) => Math.max(...frames.map((ps, f) => Math.max(...ps.map((p, v) => (p ? dist(p, still[f][v]) : 0)))));
  const free = deviation(run(true, false)), anchored = deviation(run(true, true));
  assert.ok(free > 0.05, `without the anchor the moving character swings the skirt (${free})`);
  assert.ok(anchored < 1e-4, `anchored: the skirt moves as if the character stood still (${anchored})`);
});

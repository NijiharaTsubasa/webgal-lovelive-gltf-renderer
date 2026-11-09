import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { SpringRig, qmul, testMotion } from "../src/unity-springbone.js";
import { ModelPhysics, validatePhysics } from "../src/model-physics.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/unity-springbone/${name}`, import.meta.url), "utf8"));
const doc = fixture("3d_costume_2019102201.json");
const rootIdOf = (rig) => [...rig.h.parent].find(([, p]) => p === null)[0];
const angleDeg = (a, b) => {
  const rel = qmul([-a[0], -a[1], -a[2], a[3]], b);
  return 2 * Math.atan2(Math.hypot(rel[0], rel[1], rel[2]), Math.abs(rel[3])) * 180 / Math.PI;
};

test("unity SpringBone matches the Python reference implementation frame by frame", () => {
  // trace = springbone_ref.py --trace (checked against libil2cpp.so + UnityChan SpringBone), same costume and motion
  const trace = fixture("trace_2019102201.json");
  const rig = SpringRig.fromJSON(doc);
  const h = rig.h, root = rootIdOf(rig);
  const r0 = h.localRot.get(root), p0 = h.localPos.get(root);
  let worstAngle = 0, worstTip = 0;
  trace.frames.forEach((ref, i) => {
    const [q, dx] = testMotion(i);
    rig.setLocal(root, { rot: qmul(q, r0), pos: [p0[0] + dx, p0[1], p0[2]] });
    rig.step();
    trace.ids.forEach((id, k) => {
      const e = ref[k], tip = rig.bones.get(id).curr;
      worstAngle = Math.max(worstAngle, angleDeg(e, h.localRot.get(id)));
      worstTip = Math.max(worstTip, Math.hypot(tip[0] - e[4], tip[1] - e[5], tip[2] - e[6]));
    });
  });
  assert.ok(worstAngle < 1e-6, `rotation differs by ${worstAngle} deg`);
  assert.ok(worstTip < 1e-9, `tip differs by ${worstTip} m`);
});

test("reset restarts every enabled bone at rest with zero velocity", () => {
  const rig = SpringRig.fromJSON(doc);
  const root = rootIdOf(rig);
  const r0 = rig.h.localRot.get(root);
  for (let i = 0; i < 40; i++) { rig.setLocal(root, { rot: qmul(testMotion(i)[0], r0) }); rig.step(); }
  rig.reset();
  for (const b of rig.bones.values()) {
    if (!b.enabled) continue;
    assert.deepEqual(b.curr, b.prev);
    assert.ok(angleDeg(b.initialLocalRot, rig.h.localRot.get(b.node)) < 1e-9);
  }
});

// A three.js copy of the costume that differs from Unity by an X mirror (glTF), a turn, a scale, a translation,
// a random rest re-orientation of every node (a "normalized" skeleton) and missing pivot / collider nodes.
function buildThreeCostume(source) {
  const ref = SpringRig.fromJSON(source), h = ref.h;
  const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const S = 1.3, T = new THREE.Vector3(.2, -.1, .4);
  const toThreePos = (p) => new THREE.Vector3(-p[0], p[1], p[2]).applyQuaternion(R).multiplyScalar(S).add(T);
  const toThreeRot = (u) => qmul([R.x, R.y, R.z, R.w], [u[0], -u[1], -u[2], u[3]]);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const skip = new Set(source.components.filter((c) => /Pivot|Collider/.test(c.class)).map((c) => c.transformId));
  const root = new THREE.Group(), objects = [], nodeOf = new Map();
  const build = (id, parentObject, parentPose) => {
    if (skip.has(id)) return;
    const o = new THREE.Object3D();
    o.name = `node_${objects.length}`;           // names are irrelevant: binding goes through node indices
    const offset = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(rnd() - .5, rnd() - .5, rnd() - .5).normalize(), rnd() * Math.PI);
    const pose = { pos: toThreePos(h.position(id)), rot: new THREE.Quaternion(...toThreeRot(h.rotation(id))).multiply(offset) };
    const inverse = parentPose.rot.clone().invert();
    o.position.copy(pose.pos.clone().sub(parentPose.pos).applyQuaternion(inverse));
    o.quaternion.copy(inverse.multiply(pose.rot));
    parentObject.add(o);
    nodeOf.set(id, objects.length);
    objects.push(o);
    for (const c of h.children.get(id) || []) build(c, o, pose);
  };
  build(rootIdOf(ref), root, { pos: new THREE.Vector3(), rot: new THREE.Quaternion() });
  root.updateMatrixWorld(true);
  const data = structuredClone(source);
  for (const t of data.transforms) t.node = nodeOf.has(t.id) ? nodeOf.get(t.id) : null;
  return { root, objects, nodeOf, data, toThreeRot, R };
}

test("ModelPhysics drives source SpringBone data through a re-oriented, mirrored three.js skeleton exactly", () => {
  const { root, objects, nodeOf, data } = buildThreeCostume(doc);
  const physics = { colliders: [], springs: [], source: { unitySpringBone: data } };
  validatePhysics(physics);
  const model = new ModelPhysics(root, [{ physics, resolve: (index) => objects[index] }]);
  assert.ok(model.sourceSprings[0].binding.report.rmsFitError < 1e-9);
  assert.equal(model.sourceSprings[0].binding.report.springBonesDriven, model.sourceSprings[0].rig.drivenIds.length);

  // pure Unity-space reference with the same reset + settling and the same motion
  const ref = SpringRig.fromJSON(doc), h = ref.h, rootId = rootIdOf(ref);
  const r0 = h.localRot.get(rootId), p0 = h.localPos.get(rootId);
  ref.reset();
  for (let i = 0; i < 30; i++) ref.step();
  const rootObject = objects[nodeOf.get(rootId)];
  const rest = { q: rootObject.quaternion.clone(), p: rootObject.position.clone() };
  const binding = model.sourceSprings[0].binding;
  let worst = 0;
  for (let frame = 0; frame < 90; frame++) {
    const [q, dx] = testMotion(frame);
    model.advance(1 / 60, () => {
      // the same root motion expressed on the three.js node: Unity world -> three via the fitted mapping
      const unityRot = qmul(q, r0);
      const parentInv = rootObject.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      const rootQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(root.matrixWorld));
      const world = rootQ.clone().multiply(new THREE.Quaternion(...qmul(binding._toThree(unityRot), binding.offset.get(rootId))));
      rootObject.quaternion.copy(parentInv.multiply(world));
      const local = [p0[0] + dx, p0[1], p0[2]];
      const m = binding.mirror ? [-local[0], local[1], local[2]] : local;
      rootObject.position.copy(new THREE.Vector3(...m).applyQuaternion(new THREE.Quaternion(...binding.R))
        .multiplyScalar(binding.scale).add(new THREE.Vector3(...binding.T)));
      rootObject.updateMatrixWorld(true);
    });
    ref.setLocal(rootId, { rot: qmul(q, r0), pos: [p0[0] + dx, p0[1], p0[2]] });
    ref.step();
    for (const id of ref.drivenIds) {
      if (!nodeOf.has(id)) continue;
      const o = objects[nodeOf.get(id)];
      const got = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(
        new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(root.matrixWorld).invert(), o.matrixWorld)));
      const want = qmul(binding._toThree(h.rotation(id)), binding.offset.get(id));
      worst = Math.max(worst, angleDeg([got.x, got.y, got.z, got.w], want));
    }
  }
  assert.ok(worst < 1e-6, `spring bones differ from the Unity-space reference by ${worst} deg`);
  void rest;
});

test("source SpringBone validation and node ownership", () => {
  const bad = structuredClone(doc);
  bad.transforms[0].localRotation = [0, 0, 1];
  assert.throws(() => validatePhysics({ colliders: [], springs: [], source: { unitySpringBone: bad } }), /transform/);
  const orphan = structuredClone(doc);
  orphan.components.push({ class: "SpringBone", transformId: "missing", fields: {} });
  assert.throws(() => validatePhysics({ colliders: [], springs: [], source: { unitySpringBone: orphan } }), /component/);

  // a generic spring on a node that the source data drives as well
  const { root, objects, nodeOf, data } = buildThreeCostume(doc);
  const ref = SpringRig.fromJSON(doc);
  const driven = nodeOf.get(ref.drivenIds[0]);
  const physics = { colliders: [], springs: [{ node: driven, tail: [0, -.1, 0], radius: 0, stiffness: 1, damping: .5, gravity: [0, 0, 0], colliders: [] }],
    source: { unitySpringBone: data } };
  assert.throws(() => new ModelPhysics(root, [{ physics, resolve: (index) => objects[index] }]), /重复控制节点/);
});

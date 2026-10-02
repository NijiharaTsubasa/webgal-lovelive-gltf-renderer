import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { composeHumanoidHeadBody } from '../src/skeleton-composer.js';

function rig(offset, angle, scale = 1) {
  const root = new T.Group(), hips = new T.Bone(), head = new T.Bone();
  root.position.set(offset, .07, -.09); root.rotation.y = angle * .3; root.scale.setScalar(scale);
  hips.name = 'Hips'; head.name = 'Head'; head.position.set(offset * .2, 1.3, .08); head.rotation.z = angle;
  root.add(hips); hips.add(head); root.updateMatrixWorld(true);
  return { root, hips, head };
}
function skin(owner, parent, bones, weights, offset = .03) {
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute([.14, 1.6, .07], 3));
  geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute([0, bones.length > 1 ? 1 : 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new T.Float32BufferAttribute([...weights, ...Array(4 - weights.length).fill(0)], 4));
  const mesh = new T.SkinnedMesh(geometry, new T.MeshBasicMaterial()); parent.add(mesh);
  owner.root.updateMatrixWorld(true);
  const inverses = bones.map((bone, i) => bone.matrixWorld.clone().invert().multiply(
    new T.Matrix4().makeRotationX(.3 + i * .2).setPosition(offset + i * .04, .11, -.04)));
  const bind = new T.Matrix4().makeRotationZ(.12).setPosition(.01, -.04, .02);
  mesh.bind(new T.Skeleton(bones, inverses), bind);
  owner.root.updateMatrixWorld(true);
  return mesh;
}
function point(mesh) { return mesh.getVertexPosition(0, new T.Vector3()).applyMatrix4(mesh.matrixWorld); }
function near(a, b) { assert.ok(a.distanceTo(b) < 1e-7, `${a.toArray()} vs ${b.toArray()}`); }
function movedPoint(before, oldTarget, newTarget) {
  return before.clone().applyMatrix4(oldTarget.clone().invert()).applyMatrix4(newTarget);
}

test('general inverseBind and mesh bind matrix survive different root and joint frames', () => {
  const body = rig(.16, .31, 1.1), source = rig(-.09, -.27, .9);
  const mesh = skin(source, source.root, [source.head], [1]);
  const before = point(mesh), bind = mesh.bindMatrix.clone();
  composeHumanoidHeadBody(body.root, source.root);
  near(point(mesh), before); assert.ok(mesh.bindMatrix.equals(bind));
  const targetBefore = body.head.matrixWorld.clone();
  body.head.rotateX(.43); body.head.position.z += .05; body.root.updateMatrixWorld(true);
  near(point(mesh), movedPoint(before, targetBefore, body.head.matrixWorld));
});

test('transplanted auxiliary-owned skins retain both core and auxiliary source bindings', () => {
  const body = rig(.1, .2), source = rig(-.1, -.4);
  const hair = new T.Bone(); hair.name = 'Hair'; hair.position.set(.08, .09, -.04); source.head.add(hair);
  const mesh = skin(source, hair, [source.head, hair], [.4, .6]);
  const before = point(mesh), auxBefore = hair.matrixWorld.clone();
  const result = composeHumanoidHeadBody(body.root, source.root);
  assert.equal(result.skins, 1); assert.equal(mesh.skeleton.bones[0], body.head); assert.equal(mesh.skeleton.bones[1], hair);
  assert.equal(hair.parent, body.head); near(point(mesh), before);
  assert.ok(hair.matrixWorld.elements.every((v,i) => Math.abs(v - auxBefore.elements[i]) < 1e-12));
  const targetBefore = body.head.matrixWorld.clone();
  body.head.rotateY(-.37); body.root.updateMatrixWorld(true);
  near(point(mesh), movedPoint(before, targetBefore, body.head.matrixWorld));
});

test('missing optional bone fallback preserves its effective source mapping through animation', () => {
  const body = rig(.1, -.2), source = rig(-.2, .3);
  const jaw = new T.Bone(); jaw.name = 'Jaw'; jaw.position.set(.03, -.04, .06); jaw.rotation.x = .18; source.head.add(jaw);
  const mesh = skin(source, source.root, [jaw], [1]); const before = point(mesh);
  const result = composeHumanoidHeadBody(body.root, source.root);
  assert.deepEqual(result.fallbackBones, [{ source: 'Jaw', target: 'Head' }]);
  near(point(mesh), before);
  const targetBefore = body.head.matrixWorld.clone(); body.head.rotateZ(.29); body.root.updateMatrixWorld(true);
  near(point(mesh), movedPoint(before, targetBefore, body.head.matrixWorld));
});

test('same named joint in multiple skins retains each mesh-specific inverseBind', () => {
  const body = rig(.2, -.13), source = rig(-.1, .44);
  const a = skin(source, source.root, [source.head], [1], .03);
  const b = skin(source, source.root, [source.head], [1], -.12);
  const before = [point(a), point(b)]; const result = composeHumanoidHeadBody(body.root, source.root);
  assert.equal(result.skins, 2); near(point(a), before[0]); near(point(b), before[1]);
  assert.ok(!a.skeleton.boneInverses[0].equals(b.skeleton.boneInverses[0]));
});

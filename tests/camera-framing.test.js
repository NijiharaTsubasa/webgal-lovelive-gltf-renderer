import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { frameCharacterCamera } from '../src/camera-framing.js';

function actor(height, width = 0.5) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.1));
  mesh.position.y = height / 2;
  return mesh;
}

test('fixed framing preserves relative heights without normalizing individual bounds', () => {
  const small = new THREE.PerspectiveCamera(35, 0.75, 0.01, 100);
  const tall = small.clone();
  const framing = { viewHeight: 1.3, centerY: 1.16 };
  frameCharacterCamera(small, actor(1.54), framing);
  frameCharacterCamera(tall, actor(1.57, 2), framing);
  assert.deepEqual(small.position.toArray(), tall.position.toArray());
  assert.deepEqual(small.quaternion.toArray(), tall.quaternion.toArray());
  small.updateMatrixWorld(); tall.updateMatrixWorld();
  const shortTop = new THREE.Vector3(0, 1.54, 0).project(small);
  const tallTop = new THREE.Vector3(0, 1.57, 0).project(tall);
  assert.ok(tallTop.y > shortTop.y);
  assert.ok(Math.abs(tallTop.y - shortTop.y - 2 * 0.03 / 1.3) < 1e-12);
});

test('unspecified framing still auto-fits standalone actors', () => {
  const small = new THREE.PerspectiveCamera(35, 0.75, 0.01, 100);
  const tall = small.clone();
  frameCharacterCamera(small, actor(1));
  frameCharacterCamera(tall, actor(2));
  assert.ok(tall.position.z > small.position.z);
});

test('group composition offsets shift a portrait without changing scale or relative heights', () => {
  const viewHeight = 1.36 / 1.18;
  const framing = { viewHeight, centerY: 1.16, groupOffsets: { llas: 100 * viewHeight / 1800 } };
  const a = new THREE.PerspectiveCamera(35, .75, .01, 100), b = a.clone(), c = a.clone();
  frameCharacterCamera(a, actor(1.54), framing, 'llas');
  frameCharacterCamera(b, actor(1.57), framing, 'llas');
  frameCharacterCamera(c, actor(1.54), framing, 'hasunosora');
  for (const camera of [a,b,c]) camera.updateMatrixWorld();
  assert.equal(a.position.z, c.position.z);
  assert.deepEqual(a.position.toArray(), b.position.toArray());
  const p = new THREE.Vector3(0,1.54,0);
  assert.ok(Math.abs((p.clone().project(c).y - p.clone().project(a).y) * 1800 / 2 - 100) < 1e-9);
  const tall = new THREE.Vector3(0,1.57,0).project(b);
  assert.ok(Math.abs(tall.y - p.clone().project(a).y - 2 * .03 / viewHeight) < 1e-9);
});

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

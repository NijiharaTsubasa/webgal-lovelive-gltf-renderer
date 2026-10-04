import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { collectMaterialTextures, prepareSceneTextures, registerCompiledUniforms } from '../src/texture-preparation.js';

function fixture() {
  const map = new THREE.Texture(), runtime = new THREE.Texture();
  const target = new THREE.WebGLRenderTarget(8, 8);
  const material = new THREE.MeshStandardMaterial({ map });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  const uniforms = { custom: new THREE.Uniform([{ image: runtime }, map, target.texture]) };
  uniforms.cycle = uniforms;
  registerCompiledUniforms(material, uniforms);
  const events = [];
  const renderer = { getContext: () => ({ isContextLost: () => false }), initTexture: texture => events.push(texture) };
  return { scene, material, map, runtime, target, renderer, events };
}

test('prepares compiled runtime samplers and material maps once, yielding between uploads', async () => {
  const f = fixture();
  assert.deepEqual([...collectMaterialTextures(f.scene)], [f.map, f.runtime]);
  const yieldTask = async () => f.events.push('yield');
  await prepareSceneTextures(f.renderer, f.scene, { yieldTask });
  assert.deepEqual(f.events, [f.map, 'yield', f.runtime, 'yield']);
  f.events.length = 0;
  await prepareSceneTextures(f.renderer, f.scene, { yieldTask });
  assert.deepEqual(f.events, []);
  f.runtime.needsUpdate = true;
  await prepareSceneTextures(f.renderer, f.scene, { yieldTask });
  assert.deepEqual(f.events, [f.runtime, 'yield']);
});

test('cancellation between uploads leaves the remaining texture unprepared', async () => {
  const f = fixture(); let cancelled = false;
  await prepareSceneTextures(f.renderer, f.scene, { cancelled: () => cancelled, yieldTask: async () => { cancelled = true; } });
  assert.deepEqual(f.events, [f.map]);
  await prepareSceneTextures(f.renderer, f.scene, { yieldTask: async () => {} });
  assert.deepEqual(f.events, [f.map, f.runtime]);
});

test('context loss aborts preparation and each renderer owns its own upload cache', async () => {
  const f = fixture();
  await prepareSceneTextures(f.renderer, f.scene, { yieldTask: async () => {} });
  const second = { ...f.renderer, initTexture: texture => f.events.push(texture) };
  await prepareSceneTextures(second, f.scene, { yieldTask: async () => {} });
  assert.equal(f.events.length, 4);
  const lost = { ...f.renderer, getContext: () => ({ isContextLost: () => true }) };
  await assert.rejects(prepareSceneTextures(lost, f.scene), /context is lost/);
});

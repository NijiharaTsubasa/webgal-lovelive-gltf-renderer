import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CharacterRenderer } from '../src/character-renderer.js';
import { HostResourceCatalog } from '../src/host-resource-catalog.js';

function glb() {
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: 'Hips' }] });
  const chunk = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const bytes = new ArrayBuffer(20 + chunk.length);
  const view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).set(chunk);
  return bytes;
}

for (const model of ['model.glb', './model.glb', '../character/model.glb']) {
test(`default character loading consumes prefetched GLB bytes for independent instances (${model})`, async () => {
  const url = 'https://game.test/models/character/model.glb';
  const calls = [];
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async source => {
      calls.push(source);
      assert.equal(source, url);
      return new Response(glb());
    },
  });
  const entry = { config: 'https://game.test/models/character/config.json',
    basePath: 'https://game.test/models/character/',
    component: { name: 'Fixture', role: 'integrated', model, humanoidScale: 1 } };
  await catalog.preloadModelDependencies(entry);
  function character() {
    return new CharacterRenderer({ renderer: { state: { setMaterial() {} },
      getContext: () => ({ colorMask() {} }) }, scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(), fetchResource: source => catalog.response(source) });
  }
  const a = character(), b = character();
  try {
    await Promise.all([a.load([entry], ''), b.load([entry], '')]);
    assert.deepEqual(calls, [url]);
    assert.notEqual(a.root, b.root);
    assert.notEqual(a.root.children[0], b.root.children[0]);
    a.root.children[0].position.x = 7;
    assert.equal(b.root.children[0].position.x, 0);
  } finally { a.dispose(); b.dispose(); }
});
}

test('default GLB loader reports failed responses and can retry', async () => {
  let attempts = 0;
  const character = new CharacterRenderer({ renderer: {}, scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(), fetchResource: async () => ++attempts === 1
      ? new Response('', { status: 503 }) : new Response(glb()) });
  await assert.rejects(character.loader.loadAsync('https://game.test/model.glb'), /503/);
  assert.ok((await character.loader.loadAsync('https://game.test/model.glb')).scene);
  character.dispose();
});

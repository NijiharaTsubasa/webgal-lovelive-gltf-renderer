import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CharacterRenderSurface, OffscreenCharacter } from '../src/offscreen-character.js';
import { CharacterRenderer } from '../src/character-renderer.js';
import { CharacterResourceOwner } from '../src/character-resource-owner.js';

function fixture() {
  const calls = [];
  const renderer = { debug: {}, domElement: {}, setSize() {}, setClearColor() {},
    dispose() { calls.push('renderer'); }, forceContextLoss() { calls.push('context'); } };
  return { calls, surface: new CharacterRenderSurface({ renderer }) };
}
function actor(surface, name) {
  const value = { name, prepared: true, disposed: false,
    dispose() { this.disposed = true; surface.detach(this); } };
  surface.attach(value); return value;
}
test('resident actor switches retain the same context and disposal belongs to surface', () => {
  const { calls, surface } = fixture();
  const a = actor(surface, 'a'), b = actor(surface, 'b');
  surface.activate(a); assert.throws(() => surface.assertDrawable(b), /in use/);
  surface.activate(b); surface.assertDrawable(b);
  a.dispose(); assert.equal(surface.active, b); assert.deepEqual(calls, []);
  surface.dispose(); surface.dispose();
  assert.equal(b.disposed, true); assert.deepEqual(calls, ['renderer', 'context']);
});
test('surface serializes preparation and rejects overwriting another active actor', async () => {
  const { surface } = fixture(); const a = actor(surface, 'a'), b = actor(surface, 'b');
  const events = []; let release;
  const first = surface.prepare(a, async () => { events.push('a'); await new Promise(resolve => { release = resolve; }); events.push('a-ready'); });
  const second = surface.prepare(b, async () => { events.push('b'); });
  await Promise.resolve(); assert.deepEqual(events, ['a']);
  assert.throws(() => surface.activate(b), /preparing/);
  release(); await Promise.all([first, second]); assert.deepEqual(events, ['a', 'a-ready', 'b']);
  surface.activate(a); await assert.rejects(surface.prepare(b, () => assert.fail('must not draw')), /active character/);
  surface.dispose();
});
test('disposing surface cancels queued preparation and always releases context after actor errors', async () => {
  const { surface, calls } = fixture(); const a = actor(surface, 'a');
  a.dispose = () => { a.disposed = true; throw new Error('actor failure'); };
  const queued = surface.prepare(a, () => assert.fail('disposed surface must not prepare'));
  assert.throws(() => surface.dispose(), /actor failure/); await queued;
  assert.deepEqual(calls, ['renderer', 'context']);
});
test('offscreen borrowed surface disposal retains other resident actor and context', () => {
  const { surface, calls } = fixture(); const a = actor(surface, 'a'), b = actor(surface, 'b');
  a.disposed = false; a.surface = surface; a.ownsSurface = false;
  a.character = { dispose() {} }; a.renderer = surface.renderer;
  OffscreenCharacter.prototype.dispose.call(a);
  assert.equal(surface.actors.has(a), false); assert.equal(surface.actors.has(b), true);
  assert.deepEqual(calls, []); surface.dispose();
});
test('resource owner disposes shared source/pass resources once after adapter restoration', () => {
  const geometry = new THREE.BufferGeometry(), material = new THREE.MeshBasicMaterial();
  const source = new THREE.Mesh(geometry, material), pass = new THREE.Mesh(geometry, material);
  const root = new THREE.Group(); root.add(source, pass);
  const owner = new CharacterResourceOwner().capture(root);
  const cloned = geometry.clone(); source.geometry = cloned;
  let count = 0; geometry.addEventListener('dispose', () => count++);
  material.dispose(); source.geometry = geometry; cloned.dispose();
  owner.dispose(); owner.dispose(); assert.equal(count, 1);
});
test('late parsed resources are immediately released after cancellation', () => {
  const owner = new CharacterResourceOwner(); owner.dispose();
  const geometry = new THREE.BufferGeometry(); let disposed = 0;
  geometry.addEventListener('dispose', () => disposed++);
  owner.capture(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())); assert.equal(disposed, 1);
});
test('warm keys do not reuse actors prepared on a different surface', () => {
  const options = { modelUrl: 'https://example.test/a.json', indexUrl: 'https://example.test/index.json' };
  const a = fixture().surface, b = fixture().surface;
  assert.notEqual(OffscreenCharacter.warmKey({ ...options, surface: a }), OffscreenCharacter.warmKey({ ...options, surface: b }));
  assert.equal(OffscreenCharacter.warmKey({ ...options, surface: a }), OffscreenCharacter.warmKey({ ...options, surface: a }));
  a.dispose(); b.dispose();
});

test('cancelled model load releases parsed source resources before attaching them', async () => {
  let finish;
  const character = new CharacterRenderer({ loader: { loadAsync: () => new Promise(resolve => { finish = resolve; }) } });
  const geometry = new THREE.BufferGeometry(); let disposed = 0;
  geometry.addEventListener('dispose', () => disposed++);
  const root = new THREE.Group(); root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  const pending = character.load([{ basePath: '/fixture/', component: { role: 'integrated', model: 'model.glb' } }], '');
  character.clear();
  finish({ scene: root, parser: { associations: new Map(), json: { nodes: [] } } });
  assert.equal(await pending, null); assert.equal(disposed, 1); assert.equal(character.root, null);
});
test('failed composed load releases late successful source without double disposing shared geometry', async () => {
  let finish;
  const character = new CharacterRenderer({ loader: { loadAsync: url => url.includes('head')
    ? Promise.reject(new Error('head failed')) : new Promise(resolve => { finish = resolve; }) } });
  const geometry = new THREE.BufferGeometry(); let disposed = 0;
  geometry.addEventListener('dispose', () => disposed++);
  const root = new THREE.Group(); const material = new THREE.MeshBasicMaterial();
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const pending = character.load(['head', 'body'].map(role => ({ group: 'fixture', basePath: '/fixture/', component: { role, model: `${role}.glb` } })), '');
  await assert.rejects(pending, /head failed/);
  finish({ scene: root, parser: { associations: new Map(), json: { nodes: [] } } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(disposed, 1); assert.equal(character.root, null);
});

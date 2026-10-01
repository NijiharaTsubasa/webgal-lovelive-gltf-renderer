import test from 'node:test';
import assert from 'node:assert/strict';
import { HostResourceCatalog } from '../src/host-resource-catalog.js';
import { OffscreenCharacter } from '../src/offscreen-character.js';

function fixture() {
  const calls = [];
  const data = {
    'https://game.test/game/3d/resources.json': { resources: [
      { type: 'motion', name: 'idle', config: 'motion/config.json' },
    ] },
    'https://game.test/game/3d/motion/config.json': { components: [
      { type: 'motion', name: 'idle', src: 'idle.json' },
    ] },
    'https://game.test/game/3d/motion/idle.json': { clips: [] },
    'https://game.test/game/3d/model/config.json': { components: [
      { type: 'model', name: 'character', role: 'integrated', model: 'character.glb' },
    ] },
  };
  return { calls, catalog: new HostResourceCatalog('https://game.test/game/3d/resources.json', {
    fetchResource: async url => { calls.push(url); return {
      ok: true, json: async () => data[url], arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(data[url])).buffer,
    }; },
  }) };
}

test('catalog resolves names through authoritative manifests and caches concurrent preloads', async () => {
  const { catalog, calls } = fixture();
  await catalog.load();
  await Promise.all([catalog.preload('motion', 'idle'), catalog.preload('motion', 'idle')]);
  assert.equal(calls.filter(url => url.endsWith('idle.json')).length, 1);
  assert.equal((await catalog.resolve(catalog.find('motion', 'idle'))).component.src, 'idle.json');
});

test('playback consumes preloaded bytes without refetching or sharing consumed response bodies', async () => {
  const { catalog, calls } = fixture();
  await catalog.load();
  await catalog.preload('motion', 'idle');
  const url = 'https://game.test/game/3d/motion/idle.json';
  const first = await catalog.response(url);
  const second = await catalog.response(url);
  assert.deepEqual(await first.json(), {clips:[]});
  assert.deepEqual(await second.json(), {clips:[]});
  assert.equal(calls.filter(item => item === url).length, 1);
});

test('direct model paths work without a model index entry', async () => {
  const { catalog } = fixture();
  await catalog.load();
  const model = await catalog.model('model/config.json');
  assert.equal(model.basePath, 'https://game.test/game/3d/model/');
  assert.equal(model.name, 'character');
});

test('failed requests can be retried', async () => {
  let attempts = 0;
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async () => ({ ok: ++attempts > 1, status: 503, json: async () => ({ resources: [] }) }),
  });
  await assert.rejects(catalog.load(), /503/);
  await catalog.load();
  assert.equal(attempts, 2);
});

test('fetch dependency is invoked without rebinding its receiver to the catalog', async () => {
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: function () {
      assert.equal(this, undefined);
      return Promise.resolve({ ok: true, json: async () => ({ resources: [] }) });
    },
  });
  await catalog.load();
});

test('missing optional default motion does not prevent model dependency preload', async () => {
  const { catalog } = fixture();
  await catalog.load();
  const json = new TextEncoder().encode(JSON.stringify({ materials: [] }));
  const glb = new ArrayBuffer(20 + json.length);
  const view = new DataView(glb);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(12, json.length, true);
  new Uint8Array(glb, 20).set(json);
  catalog.fetch = async () => glb;
  await catalog.preloadModelDependencies({ config: 'https://game.test/model/config.json',
    component: { model: 'model.glb', defaultMotion: 'not-installed' } });
});

test('default motion falls back to static pose, while explicit missing motions still fail', async () => {
  const { catalog } = fixture();
  await catalog.load();
  const selected = [];
  const actor = { catalog, motionGeneration: 0, disposed: false,
    character: { config: { defaultMotion: 'not-installed' }, selectMotion: async value => selected.push(value) } };
  await OffscreenCharacter.prototype.setMotion.call(actor, '');
  assert.deepEqual(selected, [null]);
  await assert.rejects(OffscreenCharacter.prototype.setMotion.call(actor, 'explicit-missing'), /Resource not found/);
});

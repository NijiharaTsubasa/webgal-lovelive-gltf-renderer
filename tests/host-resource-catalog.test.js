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

function behaviorDependencies({ indexed = false, available = false } = {}) {
  const json = new TextEncoder().encode(JSON.stringify({ materials: [] }));
  const glb = new ArrayBuffer(20 + json.length);
  const view = new DataView(glb);
  view.setUint32(0, 0x46546c67, true); view.setUint32(12, json.length, true);
  new Uint8Array(glb, 20).set(json);
  const calls = [];
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async url => {
      calls.push(url);
      if (url.endsWith('model.glb')) return { ok: true, arrayBuffer: async () => glb };
      if (url.endsWith('behavior.json')) return { ok: true, json: async () => ({ components: [
        { type: 'behavior', namespace: 'Example', name: 'Optional', script: 'optional.js' },
      ] }) };
      return { ok: available, status: 503, arrayBuffer: async () => new Uint8Array([1]).buffer };
    },
  });
  if (indexed) catalog.entries.push({ type: 'behavior', name: 'Example.Optional', config: 'https://game.test/behavior.json' });
  const model = required => ({ config: 'https://game.test/model.json', component: {
    model: 'model.glb', behaviors: [{ name: 'Example.Optional', required, parameters: {} }],
  } });
  return { catalog, model, calls, recover() { available = true; } };
}

test('missing optional Behavior can reach model loading while required missing Behavior rejects', async () => {
  const { catalog, model } = behaviorDependencies();
  await catalog.preloadModelDependencies(model(false));
  await assert.rejects(catalog.preloadModelDependencies(model(true)), /Resource not found/);
});

test('optional script fetch failures do not block preload or poison recovery; required failures reject', async () => {
  const f = behaviorDependencies({ indexed: true });
  await f.catalog.preloadModelDependencies(f.model(false));
  await assert.rejects(f.catalog.preloadModelDependencies(f.model(true)), /503/);
  f.recover();
  await f.catalog.preloadModelDependencies(f.model(true));
  assert.equal(f.calls.filter(url => url.endsWith('optional.js')).length, 3);
});

test('completed entry capacity uses least-recently-read order', async () => {
  const calls = new Map();
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async url => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return { ok: true, json: async () => ({ url }) };
    },
  });
  for (let i = 0; i < 256; i++) await catalog.fetch(`item-${i}`);
  await catalog.fetch('item-0');
  await catalog.fetch('item-256');
  await catalog.fetch('item-0');
  assert.equal(calls.get('item-0'), 1, 'a cache read makes the oldest entry recent');
  await catalog.fetch('item-1');
  assert.equal(calls.get('item-1'), 2, 'the least recently used entry is fetched again');
});

test('byte budget evicts completed entries while returned data remains usable', async () => {
  const size = 24 * 1024 * 1024;
  const calls = new Map();
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async url => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return { ok: true, arrayBuffer: async () => {
        const bytes = new ArrayBuffer(size);
        new Uint8Array(bytes)[0] = url.charCodeAt(0);
        return bytes;
      } };
    },
  });
  const held = await catalog.fetch('a', 'bytes');
  await catalog.fetch('b', 'bytes');
  await catalog.fetch('a', 'bytes');
  await catalog.fetch('c', 'bytes');
  await catalog.fetch('a', 'bytes');
  assert.equal(calls.get('a'), 1);
  await catalog.fetch('b', 'bytes');
  assert.equal(calls.get('b'), 2);
  assert.equal(held.byteLength, size);
  assert.equal(new Uint8Array(held)[0], 'a'.charCodeAt(0), 'eviction must not detach readers buffers');
});

test('oversized responses are single-flight but not retained and do not flush useful entries', async () => {
  const calls = new Map();
  const large = new ArrayBuffer(64 * 1024 * 1024 + 1);
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async url => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return { ok: true, arrayBuffer: async () => url === 'large' ? large : new ArrayBuffer(3) };
    },
  });
  await catalog.fetch('small', 'bytes');
  const [a, b] = await Promise.all([catalog.fetch('large', 'bytes'), catalog.fetch('large', 'bytes')]);
  assert.equal(a, b);
  assert.equal(calls.get('large'), 1);
  await catalog.fetch('large', 'bytes');
  assert.equal(calls.get('large'), 2);
  await catalog.fetch('small', 'bytes');
  assert.equal(calls.get('small'), 1);
});

test('JSON values count toward the byte budget', async () => {
  const calls = new Map();
  const text = 'x'.repeat(2 * 1024 * 1024);
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async url => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return { ok: true, json: async () => ({ text }) };
    },
  });
  for (let i = 0; i < 17; i++) await catalog.fetch(`json-${i}`);
  await catalog.fetch('json-16');
  assert.equal(calls.get('json-16'), 1);
  await catalog.fetch('json-0');
  assert.equal(calls.get('json-0'), 2);
});

test('completed cache churn cannot evict or duplicate an in-flight request', async () => {
  let release;
  let slowCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async url => {
      if (url === 'slow') { slowCalls++; await gate; }
      return { ok: true, json: async () => ({ url }) };
    },
  });
  const first = catalog.fetch('slow');
  for (let i = 0; i < 300; i++) await catalog.fetch(`quick-${i}`);
  const second = catalog.fetch('slow');
  assert.equal(slowCalls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(a, { url: 'slow' });
});

test('concurrent body decode failure is removed so the next request can retry', async () => {
  let attempts = 0;
  const catalog = new HostResourceCatalog('https://game.test/resources.json', {
    fetchResource: async () => {
      const attempt = ++attempts;
      return { ok: true, json: async () => {
        if (attempt === 1) throw new SyntaxError('invalid JSON');
        return { resources: [] };
      } };
    },
  });
  const results = await Promise.allSettled([catalog.load(), catalog.load()]);
  assert.equal(attempts, 1);
  assert.ok(results.every(result => result.status === 'rejected' && /invalid JSON/.test(result.reason.message)));
  await catalog.load();
  assert.equal(attempts, 2);
  await catalog.load();
  assert.equal(attempts, 2);
});

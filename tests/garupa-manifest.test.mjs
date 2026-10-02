import test from 'node:test';
import assert from 'node:assert/strict';
import { expandParameterManifest, ExpressionAdapterRegistry, parameterResourceUrl } from '../src/garupa/manifest.js';
import { ParameterStore, sharedParameters } from '../src/garupa/player.js';

test('parameter packages mix resource kinds without binding source files to target models', () => {
  const components = [
    { type: 'garupa-motion', name: 'anon/sample', src: 'sample.mtn', fade_in: 0 },
    { type: 'garupa-expression', name: 'anon/sample', src: 'face/sample.exp.json' },
    { type: 'shader', name: 'example' },
  ];
  const entries = expandParameterManifest({ components }, 'source/config.json');
  assert.equal(entries.length, 2);
  assert.deepEqual(expandParameterManifest({ components: [] }, 'config.json'), []);
  for (const field of ['fade_in', 'fade_out']) {
    assert.throws(() => expandParameterManifest({ components: [{ ...components[0], [field]: 'bad' }] }, 'config.json'), /有限数值/);
  }
  assert.equal(parameterResourceUrl(entries[1], '/packages/'), '/packages/source/face/sample.exp.json');
  assert.throws(() => expandParameterManifest({ components: [components[0], components[0]] }, 'config.json'), /重复/);
  for (const src of ['../sample.mtn', '/sample.mtn', 'https://example.com/sample.mtn', 'C:\\sample.mtn']) {
    assert.throws(() => expandParameterManifest({ components: [{ ...components[0], src }] }, 'config.json'), /包内/);
  }
});

test('adapter lookup is by target motionGroup, with absent, conflicting and retryable imports', async () => {
  const [entry] = expandParameterManifest({ components: [
    { type: 'garupa-expression-adapter', name: 'face', motionGroup: 'example', script: 'face.js' },
  ] }, 'deps/config.json');
  const factory = () => null;
  let calls = 0;
  const registry = new ExpressionAdapterRegistry([entry], '/packages/', async url => {
    assert.equal(url, '/packages/deps/face.js');
    if (++calls === 1) throw new Error('temporary');
    return { createExpressionAdapter: factory };
  });
  assert.equal(await registry.factory('missing'), null);
  await assert.rejects(registry.factory('example'), /temporary/);
  assert.equal(await registry.factory('example'), factory);
  assert.equal(await registry.factory('example'), factory);
  assert.equal(calls, 2);
  assert.throws(() => new ExpressionAdapterRegistry([entry, entry], '/'), /冲突/);
});

test('shared defaults include rare controls and storage preserves finite values beyond measured ranges', () => {
  const { defaults, ranges } = sharedParameters({ defaults: { PARAM_HAND_R_01_001: 1 }, ranges: {} });
  assert.equal(defaults.PARAM_EYE_R_OPEN, 1);
  assert.equal(defaults.PARAM_MOUTH_SWITCH, 0);
  const store = new ParameterStore(defaults, ranges);
  store.setParamFloat('PARAM_MOUTH_FORM_01', -3.5);
  store.setParamFloat('EXTRA', 7);
  assert.equal(store.getParamFloat('PARAM_MOUTH_FORM_01'), -3.5);
  assert.equal(store.getParamFloat('EXTRA'), 7);
  assert.throws(() => store.setParamFloat('EXTRA', Infinity), /非有限/);
  assert.equal(store.getParamFloat('EXTRA'), 7);
});

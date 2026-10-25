import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceGLTFLoader } from '../src/resource-gltf-loader.js';

test('resource loader calls host fetch without substituting itself as receiver', async () => {
  const bytes = new ArrayBuffer(17), parsed = { scene: {} };
  const loader = new ResourceGLTFLoader(function hostFetch(url) {
    assert.equal(this, undefined);
    assert.equal(url, 'https://example.test/models/body.glb');
    return Promise.resolve({ ok: true, arrayBuffer: async () => bytes });
  });
  loader.parseAsync = async (actual, base) => {
    assert.equal(actual, bytes); assert.equal(base, 'https://example.test/models/'); return parsed;
  };
  assert.equal(await loader.loadAsync('https://example.test/models/body.glb'), parsed);
});

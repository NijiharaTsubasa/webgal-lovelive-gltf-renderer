import assert from 'node:assert/strict';
import test from 'node:test';
import { ShaderRegistry } from '../src/parameterized-renderer.js';

const manifest = () => ({ components: [{ type: 'shader', name: 'example', src: 'glsl/vertex.glsl',
  script: 'runtime.js', samplers: [], passes: [{ id: 'Forward', sections: { vertexPrelude: 'PRELUDE' } }],
}] });

test('shader registry loads the selected package URLs and caches source/module preparation', async () => {
  const registry = new ShaderRegistry(), requests = [], module = { default: class {} };
  registry.registerPackage(manifest(), {
    source: 'https://example.test/packages/deps/config.json',
    loadText: async url => { requests.push(url); return '// @section PRELUDE\nfloat test;\n// @end'; },
    loadModule: async url => { requests.push(url); return module; },
  });
  const [first, second] = await Promise.all([registry.loadShader('example'), registry.loadShader('example')]);
  assert.equal(first, second);
  assert.equal(first.scriptModule, module);
  assert.equal(first.passes[0].sections.vertexPrelude, 'float test;');
  assert.deepEqual(requests, ['https://example.test/packages/deps/glsl/vertex.glsl',
    'https://example.test/packages/deps/runtime.js']);
  await assert.rejects(registry.loadShader('missing'), /Shader not found/);
});

test('shader registry retries a failed source load and rejects conflicting package identities', async () => {
  const registry = new ShaderRegistry();
  let attempt = 0;
  const loaders = { source: 'https://example.test/deps/config.json',
    loadText: async () => { if (++attempt === 1) throw new Error('network failure');
      return '// @section PRELUDE\nfloat test;\n// @end'; },
    loadModule: async () => ({}),
  };
  registry.registerPackage(manifest(), loaders);
  await assert.rejects(registry.loadShader('example'), /network failure/);
  assert.ok(await registry.loadShader('example'));
  assert.equal(attempt, 2);
  registry.registerPackage(manifest(), loaders);
  assert.throws(() => registry.registerPackage(manifest(), { ...loaders,
    source: 'https://example.test/another/config.json' }), /Duplicate shader name/);
});

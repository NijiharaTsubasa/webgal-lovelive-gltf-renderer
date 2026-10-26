import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createGltfTextureBinding } from '../src/sampler-bindings.js';
import { createShaderRuntimeScope } from '../src/parameterized-renderer.js';
import { ResourcePackages } from '../src/resource-packages.js';

function fixture() {
  const requests = [];
  const definition = { extras: { colorSpace: 'srgb' } };
  const texture = new THREE.Texture();
  const parser = { json: { textures: [definition] }, async getDependency(kind, index) {
    requests.push({ kind, index });
    assert.equal(kind, 'texture'); assert.equal(index, 0);
    return texture;
  } };
  return { definition, parser, requests, texture };
}

test('ordinary bindings apply texture-level anisotropy and keep the loader texture unchanged', () => {
  const loader = new THREE.Texture(); loader.anisotropy = 8; loader.userData.anisotropy = 8;
  const requested = createGltfTextureBinding(loader, { extras: { colorSpace: 'linear', anisotropy: 2 } });
  const defaults = createGltfTextureBinding(loader, { extras: { colorSpace: 'linear' } });
  assert.equal(requested.anisotropy, 2); assert.equal(requested.userData.anisotropy, 2);
  assert.equal(defaults.anisotropy, 1); assert.equal(Object.hasOwn(defaults.userData, 'anisotropy'), false);
  assert.equal(loader.anisotropy, 8); assert.equal(loader.userData.anisotropy, 8);
  requested.dispose(); defaults.dispose(); loader.dispose();
});

for (const value of [0, -1, 1.5, null, '2', NaN, Infinity, 2 ** 53]) {
  test(`anisotropy ${String(value)} is rejected for image bindings`, () => {
    const texture = new THREE.Texture();
    try {
      assert.throws(() => createGltfTextureBinding(texture, { extras: { anisotropy: value } }), /anisotropy must be/);
    } finally { texture.dispose(); }
  });
}

test('custom shader shares one image binding and disposes it once', async () => {
  const f = fixture();
  const packages = new ResourcePackages({ fetchResource: async () => ({ ok: true, text: async () => '// image fixture' }) });
  packages.register({ components: [{ type: 'shader', name: 'image-fixture', src: 'fixture.glsl',
    samplers: [{ name: 'Main', type: 'sampler2D', missing: { behavior: 'error' } }],
    passes: [{ id: 'Forward', sections: {} }] }] }, 'https://image.test/config.json');
  const source = new THREE.MeshStandardMaterial();
  source.userData = { shader: 'image-fixture', textures: { Main: 0 }, passes: [{ id: 'Forward' }] };
  const geometry = new THREE.PlaneGeometry(1, 1), root = new THREE.Group();
  const a = new THREE.Mesh(geometry, source), b = new THREE.Mesh(geometry, source); root.add(a, b);
  const scope = createShaderRuntimeScope({ state: { setMaterial() {} }, getContext: () => ({ colorMask() {} }) }, packages.shaders);
  try {
    await scope.applyCustomShaders({ parser: f.parser }, root);
    const compile = material => {
      const shader = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
      material.onBeforeCompile(shader); return shader.uniforms.uMain.value;
    };
    const binding = compile(a.material);
    assert.equal(compile(b.material), binding);
    assert.notEqual(binding, f.texture);
    assert.equal(binding.userData.colorSpace, 'srgb');
    assert.equal(binding.generateMipmaps, f.texture.generateMipmaps);
    assert.deepEqual(f.requests, [{ kind: 'texture', index: 0 }]);
    let bindingDisposals = 0, imageDisposals = 0;
    binding.addEventListener('dispose', () => bindingDisposals++);
    f.texture.addEventListener('dispose', () => imageDisposals++);
    scope.dispose(); scope.dispose();
    assert.equal(bindingDisposals, 1); assert.equal(imageDisposals, 1);
  } finally { scope.dispose(); geometry.dispose(); source.dispose(); }
});

for (const [maximum, passes] of [[16, true], [1, false], [null, false]]) {
  test(`custom shader anisotropy request 2 ${passes ? 'loads' : 'fails closed'} with host cap ${maximum ?? 'unavailable'}`, async () => {
    const f = fixture(); f.definition.extras.anisotropy = 2; let capabilityReads = 0;
    const packages = new ResourcePackages({ fetchResource: async () => ({ ok: true, text: async () => '// anisotropy fixture' }) });
    packages.register({ components: [{ type: 'shader', name: 'anisotropy-fixture', src: 'fixture.glsl',
      samplers: [{ name: 'Main', type: 'sampler2D', missing: { behavior: 'error' } }],
      passes: [{ id: 'Forward', sections: {} }] }] }, 'https://anisotropy.test/config.json');
    const source = new THREE.MeshStandardMaterial(); source.userData = { shader: 'anisotropy-fixture', textures: { Main: 0 }, passes: [{ id: 'Forward' }] };
    const geometry = new THREE.PlaneGeometry(1, 1), root = new THREE.Group();
    const a = new THREE.Mesh(geometry, source), b = new THREE.Mesh(geometry, source); root.add(a, b);
    const renderer = { state: { setMaterial() {} }, getContext: () => ({ colorMask() {} }) };
    if (maximum !== null) renderer.capabilities = { getMaxAnisotropy() { capabilityReads++; return maximum; } };
    const scope = createShaderRuntimeScope(renderer, packages.shaders);
    try {
      if (passes) {
        await scope.applyCustomShaders({ parser: f.parser }, root);
        const shader = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
        a.material.onBeforeCompile(shader);
        assert.equal(shader.uniforms.uMain.value.anisotropy, 2);
        assert.equal(capabilityReads, 1, 'shared texture capability is checked only once at load time');
      } else {
        await assert.rejects(scope.applyCustomShaders({ parser: f.parser }, root), /requested anisotropy 2 exceeds host capability/);
        assert.deepEqual(f.requests, [], 'unsupported state fails before loading the image');
      }
    } finally { scope.dispose(); geometry.dispose(); source.dispose(); }
  });
}

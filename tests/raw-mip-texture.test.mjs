import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createRawMipTextureBinding } from '../src/raw-mip-texture.js';
import { createGltfTextureBinding, resolveSamplerTextures } from '../src/sampler-bindings.js';
import { createShaderRuntimeScope } from '../src/parameterized-renderer.js';
import { ResourcePackages } from '../src/resource-packages.js';

function fixture({ format = 'rgba8', colorSpace = 'srgb', dimensions = [[2, 2], [1, 1]], sampler } = {}) {
  const stride = format === 'rgba16f' ? 8 : 4, requests = [];
  const data = dimensions.map(([w, h], level) => Uint8Array.from({ length: w * h * stride }, (_, i) => (i * 37 + level * 11) & 255).buffer);
  let offset = 0;
  const bufferViews = data.map(bytes => { const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength }; offset += bytes.byteLength; return view; });
  const definition = { name: 'raw-source', extras: { colorSpace, rawMipChain: { format,
    levels: dimensions.map(([width, height], bufferView) => ({ bufferView, width, height })) } } };
  const json = { buffers: [{ byteLength: offset }], bufferViews, textures: [definition] };
  if (sampler) { definition.sampler = 0; json.samplers = [sampler]; }
  const parser = { json, async getDependency(kind, index) {
    requests.push({ kind, index }); assert.equal(kind, 'bufferView', 'raw custom binding must not load a PNG/loader texture'); return data[index];
  } };
  return { parser, definition, data, requests };
}

function refreshStoredViews(f) {
  let offset = 0;
  f.parser.json.bufferViews = f.data.map(bytes => {
    const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength }; offset += bytes.byteLength; return view;
  });
  f.parser.json.buffers[0].byteLength = offset;
}
async function deflate(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
}
async function compressedFixture(options) {
  const f = fixture(options); f.raw = f.data.slice();
  for (let i = 0; i < f.data.length; i++) f.data[i] = await deflate(f.data[i]);
  f.definition.extras.rawMipChain.compression = 'deflate'; refreshStoredViews(f);
  return f;
}

for (const [format, colorSpace] of [['rgba8', 'srgb'], ['rgba16f', 'linear']]) {
  test(`zlib-wrapped deflate roundtrips every ${format} mip pixel bit without changing texture semantics`, async () => {
    const f = await compressedFixture({ format, colorSpace });
    const texture = await createRawMipTextureBinding(f.parser, f.definition);
    assert.equal(texture.generateMipmaps, false); assert.equal(texture.flipY, false);
    for (let i = 0; i < f.raw.length; i++) {
      if (format === 'rgba8') assert.deepEqual(texture.mipmaps[i].data, new Uint8Array(f.raw[i]));
      else {
        const original = new DataView(f.raw[i]);
        assert.deepEqual([...texture.mipmaps[i].data], Array.from({ length: f.raw[i].byteLength / 2 }, (_, j) => original.getUint16(j * 2, true)));
      }
    }
    texture.dispose();
  });
}

for (const [name, mutate, expected] of [
  ['bad stream', async f => { f.data[0] = new Uint8Array([1, 2, 3, 4]).buffer; }, /invalid deflate stream/],
  ['truncated compressed input', async f => { f.data[0] = f.data[0].slice(0, -2); }, /invalid deflate stream/],
  ['extra output', async f => { f.data[0] = await deflate(new Uint8Array(f.raw[0].byteLength + 1)); }, /decompressed output exceeds expected/],
  ['short output', async f => { f.data[0] = await deflate(new Uint8Array(f.raw[0].byteLength - 1)); }, /decompressed output has.*expected/],
  ['trailing compressed junk', async f => { f.data[0] = new Uint8Array([...new Uint8Array(f.data[0]), 1, 2, 3]).buffer; }, /invalid deflate stream/],
]) test(`deflate rejects ${name} without texture fallback`, async () => {
  const f = await compressedFixture(); await mutate(f); refreshStoredViews(f);
  await assert.rejects(createRawMipTextureBinding(f.parser, f.definition), expected);
});

test('compressed bytes remain bounded by declared bufferView and buffer lengths', async () => {
  const f = await compressedFixture(); f.parser.json.buffers[0].byteLength--;
  await assert.rejects(createRawMipTextureBinding(f.parser, f.definition), /exceeds its buffer/); assert.deepEqual(f.requests, []);
});

test('rgba8 preserves all mip bytes, row order, sRGB and glTF sampler settings without generating mips', async () => {
  const f = fixture({ sampler: { minFilter: 9986, magFilter: 9728, wrapS: 33648, wrapT: 33071 } });
  const unused = new THREE.Texture(); unused.clone = () => assert.fail('raw binding must not clone the PNG texture');
  const texture = await createGltfTextureBinding(unused, f.definition, f.parser);
  assert.ok(texture.isDataTexture); assert.equal(texture.type, THREE.UnsignedByteType);
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace); assert.equal(texture.userData.colorSpace, 'srgb');
  assert.equal(texture.generateMipmaps, false); assert.equal(texture.flipY, false); assert.equal(texture.unpackAlignment, 1);
  assert.equal(texture.minFilter, THREE.NearestMipmapLinearFilter); assert.equal(texture.magFilter, THREE.NearestFilter);
  assert.equal(texture.wrapS, THREE.MirroredRepeatWrapping); assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(texture.mipmaps.length, 2); assert.equal(texture.image.data, texture.mipmaps[0].data);
  for (let i = 0; i < 2; i++) assert.deepEqual(texture.mipmaps[i].data, new Uint8Array(f.data[i]));
  texture.dispose(); unused.dispose();
});

test('ordinary bindings apply texture-level anisotropy and keep the loader texture unchanged', () => {
  const loader = new THREE.Texture(); loader.anisotropy = 8; loader.userData.anisotropy = 8;
  const requested = createGltfTextureBinding(loader, { extras: { colorSpace: 'linear', anisotropy: 2 } });
  const defaults = createGltfTextureBinding(loader, { extras: { colorSpace: 'linear' } });
  assert.equal(requested.anisotropy, 2); assert.equal(requested.userData.anisotropy, 2);
  assert.equal(defaults.anisotropy, 1); assert.equal(Object.hasOwn(defaults.userData, 'anisotropy'), false);
  assert.equal(loader.anisotropy, 8); assert.equal(loader.userData.anisotropy, 8);
  requested.dispose(); defaults.dispose(); loader.dispose();
});

for (const compressed of [false, true]) test(`${compressed ? 'deflate' : 'raw'} bindings apply explicit anisotropy and default to one`, async () => {
  const f = compressed ? await compressedFixture() : fixture();
  f.definition.extras.anisotropy = 2;
  const requested = await createGltfTextureBinding(null, f.definition, f.parser);
  assert.equal(requested.anisotropy, 2);
  delete f.definition.extras.anisotropy;
  const defaults = await createGltfTextureBinding(null, f.definition, f.parser);
  assert.equal(defaults.anisotropy, 1);
  requested.dispose(); defaults.dispose();
});

for (const value of [0, -1, 1.5, null, '2', NaN, Infinity, 2 ** 53]) test(`anisotropy ${String(value)} is rejected for ordinary and raw bindings`, async () => {
  const loader = new THREE.Texture();
  assert.throws(() => createGltfTextureBinding(loader, { extras: { anisotropy: value } }), /anisotropy must be/);
  const f = fixture(); f.definition.extras.anisotropy = value;
  await assert.rejects(createGltfTextureBinding(null, f.definition, f.parser), /anisotropy must be/);
  assert.deepEqual(f.requests, []); loader.dispose();
});

test('rgba16f preserves little-endian binary16 bit patterns including subnormals, signed zero and NaNs', async () => {
  const f = fixture({ format: 'rgba16f', colorSpace: 'linear', dimensions: [[1, 1]] });
  const words = [0x3555, 0x0001, 0x8000, 0x7e21];
  words.forEach((word, i) => new DataView(f.data[0]).setUint16(i * 2, word, true));
  const texture = await createRawMipTextureBinding(f.parser, f.definition);
  assert.equal(texture.type, THREE.HalfFloatType); assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.deepEqual([...texture.image.data], words);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter); assert.equal(texture.magFilter, THREE.LinearFilter);
  assert.equal(texture.wrapS, THREE.RepeatWrapping); assert.equal(texture.wrapT, THREE.RepeatWrapping);
  texture.dispose();
});

test('non-power-of-two dimensions halve independently and linear rgba8 is supported', async () => {
  const f = fixture({ colorSpace: 'linear', dimensions: [[3, 5], [1, 2], [1, 1]] });
  const texture = await createRawMipTextureBinding(f.parser, f.definition);
  assert.deepEqual(texture.mipmaps.map(m => [m.width, m.height]), [[3, 5], [1, 2], [1, 1]]);
  assert.equal(texture.colorSpace, THREE.NoColorSpace); texture.dispose();
});

test('mipmap filters require a full chain while non-mipmap filters preserve an explicit partial chain', async () => {
  const fullRequired = fixture({ dimensions: [[2, 2]] });
  await assert.rejects(createRawMipTextureBinding(fullRequired.parser, fullRequired.definition), /every level through 1x1/);
  assert.deepEqual(fullRequired.requests, []);
  const partial = fixture({ dimensions: [[5, 3], [2, 1]], sampler: { minFilter: 9729 } });
  const texture = await createRawMipTextureBinding(partial.parser, partial.definition);
  assert.equal(texture.mipmaps.length, 2); assert.equal(texture.generateMipmaps, false); texture.dispose();
});

const invalidCases = [
  ['format', f => { f.definition.extras.rawMipChain.format = 'rgb8'; }, /unsupported format/],
  ['unknown compression', f => { f.definition.extras.rawMipChain.compression = 'gzip'; }, /compression must be absent or deflate/],
  ['null compression', f => { f.definition.extras.rawMipChain.compression = null; }, /compression must be absent or deflate/],
  ['missing color space', f => { delete f.definition.extras.colorSpace; }, /colorSpace/],
  ['sRGB half', f => { f.definition.extras.rawMipChain.format = 'rgba16f'; }, /srgb requires rgba8/],
  ['null descriptor', f => { f.definition.extras.rawMipChain = null; }, /descriptor must be an object/],
  ['empty levels', f => { f.definition.extras.rawMipChain.levels = []; }, /nonempty array/],
  ['invalid dimensions', f => { f.definition.extras.rawMipChain.levels[0].width = 0; }, /width must be/],
  ['fractional view', f => { f.definition.extras.rawMipChain.levels[0].bufferView = .5; }, /bufferView must be/],
  ['negative view', f => { f.definition.extras.rawMipChain.levels[0].bufferView = -1; }, /bufferView must be/],
  ['view out of range', f => { f.definition.extras.rawMipChain.levels[0].bufferView = 2; }, /bufferView is out of range/],
  ['wrong byte length', f => { f.parser.json.bufferViews[0].byteLength--; }, /byteLength.*must equal/],
  ['view exceeds buffer', f => { f.parser.json.buffers[0].byteLength = 0; }, /exceeds its buffer/],
  ['negative offset', f => { f.parser.json.bufferViews[0].byteOffset = -1; }, /byteOffset must be/],
  ['null offset', f => { f.parser.json.bufferViews[0].byteOffset = null; }, /byteOffset must be/],
  ['wrong buffer', f => { f.parser.json.bufferViews[0].buffer = 1; }, /bufferView.buffer is out of range/],
  ['stride', f => { f.parser.json.bufferViews[0].byteStride = 16; }, /tightly packed/],
  ['extra level after 1x1', f => { f.definition.extras.rawMipChain.levels.push({ ...f.definition.extras.rawMipChain.levels[1] }); }, /dimensions must halve/],
  ['wrong next dimensions', f => { f.definition.extras.rawMipChain.levels[1].width = 2; f.parser.json.bufferViews[1].byteLength = 8; f.parser.json.buffers[0].byteLength += 4; }, /dimensions must halve/],
  ['sampler out of range', f => { f.definition.sampler = 0; }, /texture.sampler is out of range/],
  ['unknown filter', f => { f.definition.sampler = 0; f.parser.json.samplers = [{ minFilter: 9999 }]; }, /sampler.minFilter/],
  ['null filter', f => { f.definition.sampler = 0; f.parser.json.samplers = [{ minFilter: null }]; }, /sampler.minFilter/],
  ['mipmap mag filter', f => { f.definition.sampler = 0; f.parser.json.samplers = [{ magFilter: 9987 }]; }, /sampler.magFilter/],
  ['unknown wrap', f => { f.definition.sampler = 0; f.parser.json.samplers = [{ wrapT: 0 }]; }, /sampler wrapping/],
];
for (const [name, modify, pattern] of invalidCases) test(`raw metadata rejects ${name} before loading or falling back`, async () => {
  const f = fixture(); modify(f);
  await assert.rejects(createRawMipTextureBinding(f.parser, f.definition), pattern); assert.deepEqual(f.requests, []);
});

test('actual parser bytes must match the declared level byte count', async () => {
  const f = fixture(); f.data[0] = new ArrayBuffer(1);
  await assert.rejects(createRawMipTextureBinding(f.parser, f.definition), /decoded bufferView bytes/);
});

test('raw layers cannot silently enter the existing canvas array-texture path', async () => {
  const f = fixture(), texture = await createRawMipTextureBinding(f.parser, f.definition);
  await assert.rejects(resolveSamplerTextures([{ name: 'Layer', type: 'sampler2DArray', missing: { behavior: 'error' } }], { Layer: [texture] }), /rawMipChain supports sampler2D only/);
  texture.dispose();
});

test('custom shader binding reads raw bufferViews once per glTF entry and disposes the DataTexture once', async () => {
  const f = fixture(); let bound;
  const packages = new ResourcePackages({ fetchResource: async () => ({ ok: true, text: async () => '// raw fixture' }) });
  packages.register({ components: [{ type: 'shader', name: 'raw-mip-fixture', src: 'fixture.glsl',
    samplers: [{ name: 'Main', type: 'sampler2D', missing: { behavior: 'error' } }],
    passes: [{ id: 'Forward', sections: {} }] }] }, 'https://raw.test/config.json');
  const source = new THREE.MeshStandardMaterial(); source.userData = { shader: 'raw-mip-fixture', textures: { Main: 0 }, passes: [{ id: 'Forward' }] };
  const geometry = new THREE.PlaneGeometry(1, 1), root = new THREE.Group();
  const a = new THREE.Mesh(geometry, source), b = new THREE.Mesh(geometry, source); root.add(a, b);
  const scope = createShaderRuntimeScope({ state: { setMaterial() {} }, getContext: () => ({ colorMask() {} }) }, packages.shaders);
  try {
    await scope.applyCustomShaders({ parser: f.parser }, root);
    const shader = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
    a.material.onBeforeCompile(shader); bound = shader.uniforms.uMain.value;
    assert.ok(bound.isDataTexture); assert.equal(bound.mipmaps.length, 2);
    const other = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
    b.material.onBeforeCompile(other); assert.equal(other.uniforms.uMain.value, bound);
    assert.deepEqual(f.requests, [{ kind: 'bufferView', index: 0 }, { kind: 'bufferView', index: 1 }]);
    let disposed = 0; bound.addEventListener('dispose', () => disposed++);
    scope.dispose(); scope.dispose(); assert.equal(disposed, 1);
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
        assert.deepEqual(f.requests, [], 'unsupported state fails before loading or decoding raw texture data');
      }
    } finally { scope.dispose(); geometry.dispose(); source.dispose(); }
  });
}

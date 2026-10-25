import * as THREE from 'three';

const filters = new Map([[9728, THREE.NearestFilter], [9729, THREE.LinearFilter],
  [9984, THREE.NearestMipmapNearestFilter], [9985, THREE.LinearMipmapNearestFilter],
  [9986, THREE.NearestMipmapLinearFilter], [9987, THREE.LinearMipmapLinearFilter]]);
const wrapping = new Map([[33071, THREE.ClampToEdgeWrapping], [33648, THREE.MirroredRepeatWrapping], [10497, THREE.RepeatWrapping]]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
export const hasRawMipChain = textureDef => own(textureDef?.extras, 'rawMipChain');

export function textureAnisotropy(textureDef) {
  const value = textureDef?.extras?.anisotropy;
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('texture.extras.anisotropy must be a positive safe integer >= 1');
  return value;
}

function fail(message) { throw new Error(`rawMipChain: ${message}`); }
function integer(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

async function inflateLevel(bytes, expected, index) {
  if (typeof DecompressionStream !== 'function') fail('compression=deflate requires native DecompressionStream support');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const output = new Uint8Array(expected); let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > expected - offset) fail(`level ${index} decompressed output exceeds expected ${expected} bytes`);
      output.set(value, offset); offset += value.byteLength;
    }
    if (offset !== expected) fail(`level ${index} decompressed output has ${offset} bytes; expected ${expected}`);
    return output.buffer;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new Error(`rawMipChain: level ${index} invalid deflate stream: ${error.message}`, { cause: error });
  } finally { reader.releaseLock(); }
}

// Raw rows have the same top-to-bottom ordering as the glTF PNG image path.
// DataTexture.mipmaps includes level zero; no image decode or mip generation
// participates in this custom-sampler binding.
export async function createRawMipTextureBinding(parser, textureDef) {
  if (!parser?.json || typeof parser.getDependency !== 'function') fail('a glTF parser is required');
  const definition = object(textureDef, 'texture');
  const anisotropy = textureAnisotropy(definition);
  const chain = object(definition.extras?.rawMipChain, 'descriptor');
  if (chain.compression !== undefined && chain.compression !== 'deflate') fail('compression must be absent or deflate');
  const colorSpace = definition.extras?.colorSpace;
  if (!['linear', 'srgb'].includes(colorSpace)) fail('texture.extras.colorSpace must be linear or srgb');
  if (!['rgba8', 'rgba16f'].includes(chain.format)) fail(`unsupported format ${String(chain.format)}`);
  if (colorSpace === 'srgb' && chain.format !== 'rgba8') fail('srgb requires rgba8; rgba16f requires linear');
  if (!Array.isArray(chain.levels) || chain.levels.length === 0) fail('levels must be a nonempty array including level zero');
  let sampler = {};
  if (definition.sampler !== undefined) {
    integer(definition.sampler, 0, 'texture.sampler');
    if (!Array.isArray(parser.json.samplers) || definition.sampler >= parser.json.samplers.length) fail('texture.sampler is out of range');
    sampler = object(parser.json.samplers[definition.sampler], 'sampler');
  }
  const minFilter = sampler.minFilter === undefined ? 9987 : sampler.minFilter;
  const magFilter = sampler.magFilter === undefined ? 9729 : sampler.magFilter;
  const wrapS = sampler.wrapS === undefined ? 10497 : sampler.wrapS;
  const wrapT = sampler.wrapT === undefined ? 10497 : sampler.wrapT;
  if (!filters.has(minFilter)) fail('unsupported sampler.minFilter');
  if (![9728, 9729].includes(magFilter)) fail('unsupported sampler.magFilter');
  if (!wrapping.has(wrapS) || !wrapping.has(wrapT)) fail('unsupported sampler wrapping');
  const bytesPerPixel = chain.format === 'rgba8' ? 4 : 8;
  const layouts = chain.levels.map((rawLevel, index) => {
    const level = object(rawLevel, `level ${index}`);
    integer(level.width, 1, `level ${index} width`); integer(level.height, 1, `level ${index} height`);
    integer(level.bufferView, 0, `level ${index} bufferView`);
    if (!Array.isArray(parser.json.bufferViews) || level.bufferView >= parser.json.bufferViews.length) fail(`level ${index} bufferView is out of range`);
    const view = object(parser.json.bufferViews[level.bufferView], `bufferView ${level.bufferView}`);
    integer(view.buffer, 0, 'bufferView.buffer');
    if (!Array.isArray(parser.json.buffers) || view.buffer >= parser.json.buffers.length) fail('bufferView.buffer is out of range');
    const buffer = object(parser.json.buffers[view.buffer], `buffer ${view.buffer}`);
    const bufferLength = integer(buffer.byteLength, 0, 'buffer.byteLength');
    const offset = integer(view.byteOffset === undefined ? 0 : view.byteOffset, 0, 'bufferView.byteOffset');
    const length = integer(view.byteLength, 1, 'bufferView.byteLength');
    const expected = level.width * level.height * bytesPerPixel;
    if (!Number.isSafeInteger(expected)) fail(`level ${index} byte count is not a safe integer`);
    if (chain.compression === undefined && length !== expected) fail(`level ${index} byteLength ${length} must equal ${expected}`);
    if (offset > bufferLength || length > bufferLength - offset) fail(`bufferView ${level.bufferView} exceeds its buffer`);
    if (view.byteStride !== undefined) fail('raw pixel bufferViews must be tightly packed without byteStride');
    return { ...level, expected, storedLength: length };
  });
  for (let index = 1; index < layouts.length; index++) {
    const previous = layouts[index - 1], current = layouts[index];
    if ((previous.width === 1 && previous.height === 1)
      || current.width !== Math.max(1, Math.floor(previous.width / 2))
      || current.height !== Math.max(1, Math.floor(previous.height / 2))) fail(`level ${index} dimensions must halve the previous level, stopping at 1x1`);
  }
  const last = layouts.at(-1);
  if (minFilter >= 9984 && (last.width !== 1 || last.height !== 1)) fail('mipmap minFilter requires every level through 1x1');
  const levels = await Promise.all(layouts.map(async (level, index) => {
    const stored = await parser.getDependency('bufferView', level.bufferView);
    if (!(stored instanceof ArrayBuffer) || stored.byteLength !== level.storedLength) fail(`level ${index} decoded bufferView bytes do not match its declared byteLength`);
    const bytes = chain.compression === 'deflate' ? await inflateLevel(stored, level.expected, index) : stored;
    let data;
    if (chain.format === 'rgba8') data = new Uint8Array(bytes);
    else {
      // Read explicit little endian regardless of host byte order; preserve
      // binary16 bits, including NaN/Inf, without conversion to Float32.
      const view = new DataView(bytes); data = new Uint16Array(bytes.byteLength / 2);
      for (let i = 0; i < data.length; i++) data[i] = view.getUint16(i * 2, true);
    }
    return { width: level.width, height: level.height, data };
  }));
  const texture = new THREE.DataTexture(levels[0].data, levels[0].width, levels[0].height,
    THREE.RGBAFormat, chain.format === 'rgba8' ? THREE.UnsignedByteType : THREE.HalfFloatType);
  texture.name = definition.name ?? '';
  texture.userData = { ...definition.extras };
  texture.colorSpace = colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.mipmaps = levels; texture.generateMipmaps = false;
  texture.flipY = false; texture.unpackAlignment = 1;
  texture.minFilter = filters.get(minFilter); texture.magFilter = filters.get(magFilter);
  texture.wrapS = wrapping.get(wrapS); texture.wrapT = wrapping.get(wrapT);
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

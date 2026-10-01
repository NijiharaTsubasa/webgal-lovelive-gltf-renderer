import * as THREE from "three";

const SUPPORTED_SAMPLER_TYPES = new Set(["sampler2D", "sampler2DArray"]);
const MISSING_BEHAVIORS = new Set(["error", "constant", "resource"]);
const TEXTURE_COLOR_SPACES = new Set(["linear", "srgb"]);
const constantTextureCache = new Map();

function samplerLabel(context, name) {
  return `${context ? `${context}: ` : ""}sampler ${name || "<unnamed>"}`;
}

function isPackageRelativeUri(uri) {
  if (typeof uri !== "string" || !uri || uri.includes("\\")) return false;
  if (uri.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return false;
  const parts = uri.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function validateSamplerDescriptors(samplers, context = "") {
  if (!Array.isArray(samplers)) {
    throw new Error(`${context || "Shader config"}: samplers must be an array`);
  }

  const names = new Set();
  for (const descriptor of samplers) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error(`${context || "Shader config"}: every sampler must be a descriptor object`);
    }
    const { name, type, missing } = descriptor;
    if (typeof name !== "string" || !name) {
      throw new Error(`${context || "Shader config"}: sampler descriptor requires a non-empty name`);
    }
    if (names.has(name)) {
      throw new Error(`${context || "Shader config"}: duplicate sampler ${name}`);
    }
    names.add(name);
    if (!SUPPORTED_SAMPLER_TYPES.has(type)) {
      throw new Error(`${samplerLabel(context, name)}: unsupported type ${String(type)}`);
    }
    if (!missing || typeof missing !== "object" || Array.isArray(missing)) {
      throw new Error(`${samplerLabel(context, name)}: missing policy is required`);
    }
    if (!MISSING_BEHAVIORS.has(missing.behavior)) {
      throw new Error(`${samplerLabel(context, name)}: unsupported missing behavior ${String(missing.behavior)}`);
    }
    if (missing.behavior === "constant") {
      if (!Array.isArray(missing.value)
          || missing.value.length !== 4
          || !missing.value.every(Number.isFinite)) {
        throw new Error(`${samplerLabel(context, name)}: constant value must contain four finite numbers`);
      }
    }
    if (missing.behavior === "resource") {
      if (type === "sampler2DArray") {
        throw new Error(`${samplerLabel(context, name)}: array resource fallback is unsupported`);
      }
      if (!isPackageRelativeUri(missing.uri)) {
        throw new Error(`${samplerLabel(context, name)}: resource uri must be package-relative`);
      }
      if (!TEXTURE_COLOR_SPACES.has(missing.colorSpace)) {
        throw new Error(`${samplerLabel(context, name)}: resource colorSpace must be linear or srgb`);
      }
    }
  }
  return samplers;
}

function applyTextureColorSpace(texture, colorSpace, context, name) {
  if (!TEXTURE_COLOR_SPACES.has(colorSpace)) {
    throw new Error(`${samplerLabel(context, name)}: texture colorSpace must be linear or srgb`);
  }
  const target = colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (texture.colorSpace !== target) {
    texture.colorSpace = target;
    texture.needsUpdate = true;
  }
  return texture;
}

function constantTexture(descriptor) {
  const value = descriptor.missing.value;
  const key = `${descriptor.type}:${value.join(",")}`;
  if (!constantTextureCache.has(key)) {
    const texture = descriptor.type === "sampler2DArray"
      ? new THREE.DataArrayTexture(new Float32Array(value), 1, 1, 1)
      : new THREE.DataTexture(new Float32Array(value), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    if (descriptor.type === "sampler2DArray") {
      texture.format = THREE.RGBAFormat;
      texture.type = THREE.FloatType;
    }
    texture.name = `constant:${value.join(",")}`;
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    constantTextureCache.set(key, texture);
  }
  return constantTextureCache.get(key);
}

function arrayTexture(layers, context, name) {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error(`${samplerLabel(context, name)}: array texture requires at least one layer`);
  }
  const first = layers[0];
  const colorSpace = first?.userData?.colorSpace;
  if (!TEXTURE_COLOR_SPACES.has(colorSpace)) {
    throw new Error(`${samplerLabel(context, name)}: texture colorSpace must be linear or srgb`);
  }
  const width = first.image?.width;
  const height = first.image?.height;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`${samplerLabel(context, name)}: invalid layer dimensions`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!context2d) throw new Error(`${samplerLabel(context, name)}: canvas 2D context unavailable`);
  const pixels = new Uint8Array(width * height * 4 * layers.length);
  for (const [index, layer] of layers.entries()) {
    if (!layer?.isTexture || layer.image?.width !== width || layer.image?.height !== height
        || layer.userData?.colorSpace !== colorSpace
        || layer.wrapS !== first.wrapS || layer.wrapT !== first.wrapT
        || layer.magFilter !== first.magFilter || layer.minFilter !== first.minFilter
        || layer.generateMipmaps !== first.generateMipmaps) {
      throw new Error(`${samplerLabel(context, name)}: layer ${index} has incompatible texture data`);
    }
    context2d.clearRect(0, 0, width, height);
    context2d.drawImage(layer.image, 0, 0);
    pixels.set(context2d.getImageData(0, 0, width, height).data, index * width * height * 4);
  }
  const texture = new THREE.DataArrayTexture(pixels, width, height, layers.length);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = first.wrapS;
  texture.wrapT = first.wrapT;
  texture.magFilter = first.magFilter;
  texture.minFilter = first.minFilter;
  texture.generateMipmaps = first.generateMipmaps;
  texture.needsUpdate = true;
  return texture;
}

export async function resolveSamplerTextures(
  samplers,
  materialTextures = {},
  loadResource = null,
  context = "",
) {
  validateSamplerDescriptors(samplers, context);
  const resolved = {};

  for (const descriptor of samplers) {
    const { name, missing } = descriptor;
    if (Object.prototype.hasOwnProperty.call(materialTextures, name)) {
      const texture = materialTextures[name];
      if (descriptor.type === "sampler2DArray") {
        resolved[name] = arrayTexture(texture, context, name);
        continue;
      }
      if (!texture?.isTexture) {
        throw new Error(`${samplerLabel(context, name)}: declared material value is not a valid texture`);
      }
      resolved[name] = applyTextureColorSpace(
        texture,
        texture.userData?.colorSpace,
        context,
        name,
      );
      continue;
    }

    if (missing.behavior === "error") {
      throw new Error(`${samplerLabel(context, name)}: required material texture is missing`);
    }
    if (missing.behavior === "constant") {
      resolved[name] = constantTexture(descriptor);
      continue;
    }
    if (typeof loadResource !== "function") {
      throw new Error(`${samplerLabel(context, name)}: no shader resource loader is available`);
    }
    const texture = await loadResource(missing.uri);
    if (!texture?.isTexture) {
      throw new Error(`${samplerLabel(context, name)}: shader resource is not a valid texture`);
    }
    resolved[name] = applyTextureColorSpace(texture, missing.colorSpace, context, name);
  }

  return resolved;
}

// GLTFLoader copies image.extras to Texture.userData, but the conversion
// contract stores color space on glTF texture.extras because one image may be
// referenced by textures with different sampling semantics. Clone the cached
// loader texture per glTF texture entry and make that entry authoritative.
export function createGltfTextureBinding(texture, textureDef) {
  if (!texture?.isTexture) return texture;

  const binding = texture.clone();
  binding.userData = { ...(texture.userData || {}) };
  if (Object.prototype.hasOwnProperty.call(textureDef?.extras || {}, "colorSpace")) {
    binding.userData.colorSpace = textureDef.extras.colorSpace;
  } else {
    delete binding.userData.colorSpace;
  }
  return binding;
}

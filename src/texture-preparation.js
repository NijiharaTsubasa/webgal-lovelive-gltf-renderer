const compiledUniforms = new WeakMap();
const uploadedVersions = new WeakMap();

export const yieldPreparationTask = () => new Promise(resolve => setTimeout(resolve, 16));

export function registerCompiledUniforms(material, uniforms) {
  let variants = compiledUniforms.get(material);
  if (!variants) compiledUniforms.set(material, variants = new Set());
  variants.add(uniforms);
}

export function collectMaterialTextures(scene) {
  const textures = new Set(), visited = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value.isTexture) {
      // Render target storage belongs to its owner; uploading it as a sampler
      // before that target is initialized can allocate a different GL texture.
      if (!value.isRenderTargetTexture) textures.add(value);
      return;
    }
    if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
      for (const child of Object.values(value)) collect(child);
    }
  }
  scene.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value?.isTexture) collect(value);
      for (const uniforms of [material.uniforms, ...(compiledUniforms.get(material) ?? [])]) {
        for (const uniform of Object.values(uniforms ?? {})) collect(uniform?.value);
      }
    }
  });
  return textures;
}

export async function prepareSceneTextures(renderer, scene, {
  cancelled = () => false,
  yieldTask = yieldPreparationTask,
} = {}) {
  let versions = uploadedVersions.get(renderer);
  if (!versions) uploadedVersions.set(renderer, versions = new WeakMap());
  for (const texture of collectMaterialTextures(scene)) {
    if (cancelled()) return;
    if (renderer.getContext().isContextLost()) throw new Error('Character WebGL context is lost');
    if (versions.get(texture) === texture.version) continue;
    renderer.initTexture(texture);
    versions.set(texture, texture.version);
    // Each actual upload yields to foreground animation before the next one.
    await yieldTask();
  }
}

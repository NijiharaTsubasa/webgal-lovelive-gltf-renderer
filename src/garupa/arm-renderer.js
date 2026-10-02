import * as THREE from 'three';

const ATTRIBUTE = 'garupaArmRegions';
// Measured Float32 transition of the source forearm drawable relative to the
// central body. This shared 3D grouping does not reproduce every source piece.
const BACK_TRANSITION = 0.7971428632736206;

export function armDrawsInFront(change = 0) {
  return Math.fround(change) < BACK_TRANSITION;
}

function regionOf(node) {
  for (let current = node; current; current = current.parent) {
    if (/^Left(LowerArm|Hand)$/.test(current.name)) return 0;
    if (/^Right(LowerArm|Hand)$/.test(current.name)) return 1;
    if (current.name === 'LeftUpperArm') return 2;
    if (current.name === 'RightUpperArm') return 3;
    if (/^(Left|Right)Shoulder$|^(Hips|Spine|Chest|UpperChest|Neck|Head)$/.test(current.name)) return -1;
  }
  return -1;
}

export function armRegionWeights(mesh) {
  const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
  const values = new Float32Array(position.count * 4);
  const regions = mesh.skeleton?.bones.map(regionOf);
  const rigidRegion = regionOf(mesh.parent);
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (regions && skinIndex && skinWeight) {
      for (let slot = 0; slot < skinWeight.itemSize; slot++) {
        const region = regions[skinIndex.getComponent(vertex, slot)];
        if (region >= 0) values[vertex * 4 + region] += skinWeight.getComponent(vertex, slot);
      }
    } else if (rigidRegion >= 0) values[vertex * 4 + rigidRegion] = 1;
  }
  return values;
}

const array = value => Array.isArray(value) ? value : value ? [value] : [];
const drawable = object => object.isMesh || object.isLine || object.isPoints || object.isSprite;

// Owns only the default parameter-motion drawing adaptation. It does not tick
// runtimes, replace renderer.render, or call another complete frame pipeline.
export class ParameterArmRenderer {
  constructor(root) {
    this.root = root;
    this.layer = { value: 0 };
    this.front = { value: new THREE.Vector2(1, 1) };
    this.materials = new Map();
    this.geometries = [];
    this.meshes = [];
    this.disposed = false;
    const geometries = new Map();
    try {
      root.traverse(mesh => {
        if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
        const original = mesh.geometry;
        const signature = mesh.skeleton
          ? mesh.skeleton.bones.map(regionOf).join(',')
          : 'rigid:' + regionOf(mesh.parent);
        let variants = geometries.get(original);
        if (!variants) geometries.set(original, variants = new Map());
        let geometry = variants.get(signature);
        if (!geometry) {
          geometry = original;
          if (variants.size) {
            // Isolate only the container when bone-role indexing differs.
            // Physics continues writing the original live attribute buffers.
            geometry = original.clone();
            geometry.attributes = { ...original.attributes };
            geometry.index = original.index;
            geometry.morphAttributes = original.morphAttributes;
          }
          const previous = geometry.getAttribute(ATTRIBUTE);
          geometry.setAttribute(ATTRIBUTE, new THREE.BufferAttribute(armRegionWeights(mesh), 4));
          this.geometries.push({ geometry, previous, owned: geometry !== original });
          variants.set(signature, geometry);
        }
        mesh.geometry = geometry;
        this.meshes.push({ mesh, original, geometry });
        for (const material of new Set([
          ...array(mesh.material), ...array(mesh.userData.__baseMaterials),
          ...array(mesh.userData.__parameterizedMaterials),
        ])) this.decorate(material);
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  decorate(material) {
    if (this.materials.has(material)) return;
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey;
    const hadDefaults = Object.hasOwn(material, 'defaultAttributeValues');
    const previousDefaults = material.defaultAttributeValues;
    // Expression workspaces can restore a geometry created before this
    // adapter. An absent region attribute denotes the ordinary body layer.
    const defaults = { ...previousDefaults, [ATTRIBUTE]: [0, 0, 0, 0] };
    material.defaultAttributeValues = defaults;
    const programKey = previousKey === THREE.Material.prototype.customProgramCacheKey
      ? () => previousCompile.toString()
      : () => previousKey.call(material);
    const compile = (shader, ...args) => {
      previousCompile.call(material, shader, ...args);
      if (this.disposed) return;
      const anchor = 'void main() {';
      if (!shader.vertexShader.includes(anchor) || !shader.fragmentShader.includes(anchor)) {
        throw new Error('Parameter arm rendering requires shader main: ' + material.name);
      }
      Object.assign(shader.uniforms, { uGarupaArmLayer: this.layer, uGarupaArmFront: this.front });
      shader.vertexShader = 'attribute vec4 ' + ATTRIBUTE + ';\nvarying vec4 vGarupaArmRegions;\n'
        + shader.vertexShader.replace(anchor, anchor + '\nvGarupaArmRegions = ' + ATTRIBUTE + ';');
      shader.fragmentShader = [
        'varying vec4 vGarupaArmRegions;',
        'uniform float uGarupaArmLayer;',
        'uniform vec2 uGarupaArmFront;',
      ].join('\n') + '\n' + shader.fragmentShader.replace(anchor, anchor + [
        '',
        'if (uGarupaArmLayer > 0.5) {',
        '  bool distal = max(vGarupaArmRegions.x, vGarupaArmRegions.y) >= 0.5;',
        '  bool front = (vGarupaArmRegions.x >= vGarupaArmRegions.y ? uGarupaArmFront.x : uGarupaArmFront.y) > 0.5;',
        '  if (uGarupaArmLayer < 1.5) { if (!distal || front) discard; }',
        '  else if (uGarupaArmLayer < 2.5) { if (distal) discard; }',
        '  else if (uGarupaArmLayer < 3.5) { if (!distal || !front) discard; }',
        '  else if (uGarupaArmLayer < 4.5) { if (max(vGarupaArmRegions.z, vGarupaArmRegions.w) < 0.5) discard; }',
        '  else {',
        '    float upper = vGarupaArmRegions.x >= vGarupaArmRegions.y ? vGarupaArmRegions.z : vGarupaArmRegions.w;',
        '    if (!distal || front || upper <= 0.0) discard;',
        '  }',
        '}',
      ].join('\n'));
    };
    const key = () => programKey() + (this.disposed ? '' : ':garupa-arm-regions');
    this.materials.set(material, {
      previousCompile, previousKey, compile, key, hadDefaults, previousDefaults, defaults,
    });
    material.onBeforeCompile = compile;
    material.customProgramCacheKey = key;
    material.needsUpdate = true;
  }

  setParameters(parameters) {
    this.front.value.set(armDrawsInFront(parameters.PARAM_ARM_L_CHANGE) ? 1 : 0,
      armDrawsInFront(parameters.PARAM_ARM_R_CHANGE) ? 1 : 0);
  }

  drawArmDepth(renderer, scene, camera, layer, outside) {
    const objects = [], materials = new Map();
    const outsideObjects = new Set(outside.map(([object]) => object));
    const previousLayer = this.layer.value;
    try {
      for (const [object, mask] of outside) {
        objects.push([object, object.layers.mask]);
        object.layers.mask = mask;
      }
      const depthObjects = [...this.meshes.map(({ mesh }) => mesh), ...outside.map(([object]) => object)];
      for (const mesh of depthObjects) {
        if (!array(mesh.material).length) continue;
        if (!outsideObjects.has(mesh)) objects.push([mesh, mesh.layers.mask]);
        if (mesh.userData.__parameterizedPassObject && !outsideObjects.has(mesh)) {
          mesh.layers.mask = 0;
          continue;
        }
        for (const material of array(mesh.material)) {
          if (materials.has(material)) continue;
          materials.set(material, {
            visible: material.visible, colorWrite: material.colorWrite,
            stencilWriteMask: material.stencilWriteMask,
            hasMask: Object.hasOwn(material.userData, '__unityColorWriteMask'),
            mask: material.userData.__unityColorWriteMask,
          });
          material.visible = material.visible && material.depthWrite;
          material.colorWrite = false;
          material.userData.__unityColorWriteMask = 0;
          if (outsideObjects.has(mesh)) material.stencilWriteMask = 0;
        }
      }
      this.layer.value = layer;
      renderer.render(scene, camera);
    } finally {
      this.layer.value = previousLayer;
      for (const [object, mask] of objects) object.layers.mask = mask;
      for (const [material, state] of materials) {
        material.visible = state.visible;
        material.colorWrite = state.colorWrite;
        material.stencilWriteMask = state.stencilWriteMask;
        if (state.hasMask) material.userData.__unityColorWriteMask = state.mask;
        else delete material.userData.__unityColorWriteMask;
      }
    }
  }

  drawScene(renderer, scene, camera) {
    if (this.disposed || scene.overrideMaterial) {
      renderer.render(scene, camera);
      return;
    }
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const outside = [];
    scene.traverse(object => {
      if (!drawable(object)) return;
      for (let parent = object; parent; parent = parent.parent) if (parent === this.root) return;
      outside.push([object, object.layers.mask]);
    });
    try {
      const layers = [];
      if (!this.front.value.x || !this.front.value.y) layers.push(1);
      layers.push(2);
      if (this.front.value.x || this.front.value.y) layers.push(3);
      for (const [index, layer] of layers.entries()) {
        this.layer.value = layer;
        // Draw the surrounding scene once. Later depth prepasses retain its
        // occlusion without painting the ground over an already drawn rear arm.
        for (const [object, mask] of outside) object.layers.mask = index === 0 ? mask : 0;
        if (index !== 0) renderer.clear(false, true, false);
        if (layer === 2 && index !== 0) {
          // Preserve the elbow's local occlusion across the body/rear split.
          // Only the shared upper/lower skinning region contributes depth;
          // the rest of the rear forearm stays behind the body layer.
          this.drawArmDepth(renderer, scene, camera, 5, outside);
        }
        if (layer === 3) this.drawArmDepth(renderer, scene, camera, 4, outside);
        renderer.render(scene, camera);
        scene.background = null;
        renderer.autoClear = false;
        renderer.shadowMap.autoUpdate = false;
      }
    } finally {
      this.layer.value = 0;
      for (const [object, mask] of outside) object.layers.mask = mask;
      scene.background = background;
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.layer.value = 0;
    for (const { mesh, original, geometry } of this.meshes) {
      if (mesh.geometry === geometry) mesh.geometry = original;
    }
    for (const [material, state] of this.materials) {
      if (material.onBeforeCompile === state.compile) material.onBeforeCompile = state.previousCompile;
      if (material.customProgramCacheKey === state.key) material.customProgramCacheKey = state.previousKey;
      if (material.defaultAttributeValues === state.defaults) {
        if (state.hadDefaults) material.defaultAttributeValues = state.previousDefaults;
        else delete material.defaultAttributeValues;
      }
      material.needsUpdate = true;
    }
    for (const { geometry, previous, owned } of this.geometries) {
      if (previous) geometry.setAttribute(ATTRIBUTE, previous);
      else geometry.deleteAttribute(ATTRIBUTE);
      if (owned) geometry.dispose();
    }
  }
}

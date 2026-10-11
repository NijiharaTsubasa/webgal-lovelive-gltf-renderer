const SECTION_POSITIONS = new Set([
  "vertexPrelude",
  "vertexSkinNormal",
  "vertexSkinning",
  "vertexInject",
  "vertexProject",
  "fragmentPrelude",
  "fragmentFunctions",
  "fragmentAfterColor",
  "fragmentBody",
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function validateId(id, label) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`${label} id must be a non-empty string`);
  }
}

function validateUniqueIds(passes, label) {
  if (!Array.isArray(passes) || passes.length === 0) {
    throw new Error(`${label} passes must be a non-empty array`);
  }
  const ids = new Set();
  for (const [index, pass] of passes.entries()) {
    requireObject(pass, `${label} passes[${index}]`);
    validateId(pass.id, `${label} passes[${index}]`);
    if (ids.has(pass.id)) throw new Error(`${label} duplicate pass id: ${pass.id}`);
    ids.add(pass.id);
  }
}

function validateSectionNames(value, label) {
  const names = Array.isArray(value) ? value : [value];
  if (names.length === 0 || names.some((name) => typeof name !== "string" || !name.trim())) {
    throw new Error(`${label} must be a non-empty section name or array of section names`);
  }
}

export function validateShaderPasses(shader, label = "shader") {
  validateUniqueIds(shader.passes, label);
  for (const pass of shader.passes) {
    const sections = requireObject(pass.sections, `${label} pass ${pass.id} sections`);
    for (const [position, names] of Object.entries(sections)) {
      if (!SECTION_POSITIONS.has(position)) {
        throw new Error(`${label} pass ${pass.id}: unknown injection position ${position}`);
      }
      validateSectionNames(names, `${label} pass ${pass.id} sections.${position}`);
    }
    if (pass.renderState !== undefined) {
      requireObject(pass.renderState, `${label} pass ${pass.id} renderState`);
      if (pass.renderState.renderQueue !== undefined) {
        throw new Error(`${label} pass ${pass.id}: renderQueue is material-wide`);
      }
    }
  }
}

export function mergeRenderStates(...states) {
  const merged = {};
  for (const state of states) {
    if (state === undefined) continue;
    requireObject(state, "renderState");
    for (const [key, value] of Object.entries(state)) {
      if (value === null) throw new Error(`renderState.${key} cannot be null`);
      if (["blend", "stencil", "offset"].includes(key)) {
        requireObject(value, `renderState.${key}`);
        merged[key] = { ...(merged[key] || {}), ...value };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function mergeMap(label, ...maps) {
  const merged = {};
  for (const map of maps) {
    if (map === undefined) continue;
    requireObject(map, label);
    for (const [key, value] of Object.entries(map)) {
      if (value === null) throw new Error(`${label}.${key} cannot be null`);
      merged[key] = value;
    }
  }
  return merged;
}

export function resolveMaterialPasses(shader, extras, label = "material") {
  validateShaderPasses(shader, `Shader ${shader.name || "<unnamed>"}`);
  requireObject(extras, label);
  validateUniqueIds(extras.passes, label);
  const definitions = new Map(shader.passes.map((pass) => [pass.id, pass]));
  return extras.passes.map((materialPass) => {
    const definition = definitions.get(materialPass.id);
    if (!definition) {
      throw new Error(`${label} references unknown Shader pass: ${materialPass.id}`);
    }
    if (materialPass.renderState?.renderQueue !== undefined) {
      throw new Error(`${label} pass ${materialPass.id}: renderQueue is material-wide`);
    }
    return {
      id: materialPass.id,
      sections: definition.sections,
      shaderParams: mergeMap("shaderParams", extras.shaderParams, materialPass.shaderParams),
      textures: mergeMap("textures", extras.textures, materialPass.textures),
      renderState: mergeRenderStates(
        definition.renderState,
        extras.renderState,
        materialPass.renderState,
      ),
      extras: materialPass.extras === undefined
        ? {}
        : requireObject(materialPass.extras, `${label} pass ${materialPass.id} extras`),
    };
  });
}

export function sectionNamesForPosition(value) {
  return Array.isArray(value) ? value : [value];
}

export function createDefaultPassObject(mesh, material, passId) {
  const object = mesh.clone();
  object.name = `${mesh.name || "mesh"}_${passId}`;
  object.material = material;
  if (mesh.parent) mesh.parent.add(object);
  const inheritedOnBeforeRender = object.onBeforeRender;
  object.onBeforeRender = function syncDefaultPass(...args) {
    const sourceMorphs = mesh.morphTargetInfluences;
    const targetMorphs = object.morphTargetInfluences;
    if (sourceMorphs && targetMorphs) {
      for (let index = 0; index < sourceMorphs.length; index += 1) {
        targetMorphs[index] = sourceMorphs[index];
      }
    }
    if (typeof inheritedOnBeforeRender === "function") {
      inheritedOnBeforeRender.apply(this, args);
    }
  };
  return object;
}

export function realizeMaterialPass(mesh, shaderName, material, materialPass, resolvedTextures, runtimes, passIndex, sourceAvailable, scope) {
  const label = `Shader ${shaderName} pass ${materialPass.id}`;
  for (const runtime of runtimes) {
    if (typeof runtime.configurePass !== "function") continue;
    const result = runtime.configurePass(materialPass.id, material, mesh, materialPass, resolvedTextures);
    if (result !== undefined) throw new Error(`${label}: configurePass() must not return a value`);
  }
  let objects = [];
  for (const runtime of runtimes) {
    if (typeof runtime.createPassObjects !== "function") continue;
    const result = runtime.createPassObjects(materialPass.id, material, mesh, materialPass, resolvedTextures);
    if (!Array.isArray(result)) throw new Error(`${label}: createPassObjects() must return Object3D[]`);
    if (!result.length) continue;
    if (objects.length) throw new Error(`${label}: multiple createPassObjects() providers`);
    if (new Set(result).size !== result.length || result.some(object => !object?.isObject3D || object === mesh)) {
      throw new Error(`${label}: createPassObjects() requires unique additional Object3D instances`);
    }
    objects = result;
  }
  if (!objects.length && sourceAvailable) return { sourceMaterial: material, objects: [] };
  if (!objects.length) {
    const object = createDefaultPassObject(mesh, material, materialPass.id);
    scope.defaultPassObjects.push(object);
    objects = [object];
  }
  for (const object of objects) {
    object.userData.__parameterizedPassObject = true;
    object.userData.__parameterizedPassId = materialPass.id;
    object.userData.__parameterizedPassOrder = passIndex;
    object.userData.__parameterizedBaseVisible = mesh.visible;
    object.renderOrder = (materialPass.renderState.renderQueue ?? mesh.renderOrder) + passIndex / 1000;
  }
  return { sourceMaterial: null, objects };
}

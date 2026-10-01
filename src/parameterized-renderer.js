import * as THREE from "three";
import { applyRenderQueue } from "./render-order.js";
import {
  createGltfTextureBinding,
  resolveSamplerTextures,
  validateSamplerDescriptors,
} from "./sampler-bindings.js";
import { applyRenderState, installUnityColorMaskSupport } from "./unity-render-state.js";
import { validateResourceManifest } from "./resource-manifest.js";
import {
  createDefaultPassObject,
  resolveMaterialPasses,
  sectionNamesForPosition,
  validateShaderPasses,
} from "./shader-passes.js";

export { applyRenderState } from "./unity-render-state.js";

// ============================================================================
// Generic custom shader loader + binder
// ----------------------------------------------------------------------------
// Hosts register external resource manifests. Each shader
// component references its own GLSL, script, and auxiliary resources relative
// to that manifest. GLSL sources use // @section NAME markers; each Shader
// pass maps standard injection positions to package-defined section names.
//
// The binder never hardcodes knowledge of specific shaders. It reads config,
// parses sections, injects them into a base PBR material, and auto-binds
// uniforms from extras.shaderParams / extras.textures.
// ============================================================================

// Parse // @section NAME ... // @end blocks from a GLSL source string.
function parseSections(glsl) {
  const sections = {};
  const re = /\/\/ @section (\S+)\r?\n([\s\S]*?)\r?\n\/\/ @end/g;
  let m;
  while ((m = re.exec(glsl)) !== null) {
    sections[m[1]] = m[2];
  }
  return sections;
}

function packageResourceUrl(source, relative) {
  if (typeof relative !== "string" || !relative.trim()) {
    throw new Error(`${source}: resource path must be a non-empty string`);
  }
  return new URL(relative.replaceAll("\\", "/"), source).href;
}

// Registry lifetime belongs to the host, not the module. No game resources
// are bundled here; loaders read the actual package selected by the host.
export class ShaderRegistry {
  constructor() {
    this.definitions = new Map();
    this.shaders = new Map();
    this.textures = new Map();
  }

  registerPackage(config, { source, loadText, loadModule }) {
    validateResourceManifest(config, source);
    const sourceUrl = new URL(source, globalThis.location?.href).href;
    const entries = config.components.filter((entry) => entry.type === "shader");
    const names = new Set();
    for (const component of entries) {
      if (typeof component.name !== "string" || !component.name.trim()) {
        throw new Error(`${source}: shader name must be a non-empty string`);
      }
      if (names.has(component.name)) throw new Error(`Duplicate shader name: ${component.name}`);
      names.add(component.name);
      const existing = this.definitions.get(component.name);
      if (existing && (existing.source !== sourceUrl || JSON.stringify(existing.component) !== JSON.stringify(component))) {
        throw new Error(`Duplicate shader name: ${component.name}`);
      }
      validateSamplerDescriptors(component.samplers, `Shader ${component.name}`);
      validateShaderPasses(component, `Shader ${component.name}`);
    }
    for (const component of entries) {
      if (!this.definitions.has(component.name)) {
        this.definitions.set(component.name, { component, source: sourceUrl, loadText, loadModule });
      }
    }
  }

  async loadShader(name) {
    if (!this.shaders.has(name)) {
      const definition = this.definitions.get(name);
      if (!definition) throw new Error(`Shader not found: ${name}`);
      const pending = this.prepareShader(name, definition);
      this.shaders.set(name, pending);
      pending.catch(() => { if (this.shaders.get(name) === pending) this.shaders.delete(name); });
    }
    return this.shaders.get(name);
  }

  async prepareShader(name, definition) {
    const config = definition.component;
    const mainGlsl = await definition.loadText(packageResourceUrl(definition.source, config.src));
    const scriptModule = config.script
      ? await definition.loadModule(packageResourceUrl(definition.source, config.script)) : null;
    const all = parseSections(mainGlsl);
    const passes = config.passes.map((pass) => {
      const sections = {};
      for (const [position, configuredNames] of Object.entries(pass.sections)) {
        sections[position] = sectionNamesForPosition(configuredNames).map((sectionName) => {
          const code = all[sectionName];
          if (code === undefined) {
            throw new Error(`Shader ${name} pass ${pass.id}: section ${sectionName} not found`);
          }
          return code;
        }).join("\n");
      }
      return { ...pass, sections };
    });
    return { component: config, passes, samplers: config.samplers || [], scriptModule };
  }

  async loadTexture(name, uri) {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Shader not found: ${name}`);
    const url = packageResourceUrl(definition.source, uri);
    if (!this.textures.has(url)) {
      const pending = new THREE.TextureLoader().loadAsync(url);
      this.textures.set(url, pending);
      pending.catch(() => { if (this.textures.get(url) === pending) this.textures.delete(url); });
    }
    return this.textures.get(url);
  }
}

export const defaultShaderRegistry = new ShaderRegistry();
export async function loadShader(name, registry = defaultShaderRegistry) {
  return registry.loadShader(name);
}

// ============================================================================
// Parameterized shader rendering for three.js
// ----------------------------------------------------------------------------
// This is an OPTIONAL binding for host-provided shader resource packages.
// It is generic engine glue specific to three.js, NOT a generic "any shader"
// tool: the actual shader logic lives in the .glsl files, and the per-material
// parameters are read from each model.glb material extras:
//
//   extras.shader         = "melpot-toon"        (dispatch id; host routes on this)
//   extras.programCacheKey = "<shader>:<mat>"    (three.js program cache key)
//   extras.textures       = { slot: textureIndex }  (glTF texture indices;
//                                                    texture.extras.colorSpace required)
//   extras.shaderParams   = { key: value }       (values shared by declared passes)
//   extras.renderState    = { ... }              (generic render state)
//   extras.passes         = [{ id, ...overrides }] (ordered execution plan)
//
//   import * as parameterizedRenderer from "./parameterized-renderer.js";
//   await parameterizedRenderer.applyCustomShaders(gltf, gltf.scene);
// ============================================================================

// === Universal section injector =================================
// Rules table: maps each section name to where and how it should be injected
// into three.js's MeshStandardMaterial vertex/fragment shader source. Any
// every section must have an explicit injection rule.
//
// Rules:
//   stage: 'vertex' | 'fragment'
//   type:  'prepend' | 'insertAfter' | 'insertBefore' | 'replace'
//   anchor: (for insert*/replace) the substring in the shader source to
//           match against; a missing anchor is a compatibility error.
const FRAGMENT_ANCHOR = "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;";

const SECTION_INJECT_RULES = {
  // ----- vertex -----
  vertexPrelude:    { stage: "vertex", type: "prepend" },
  vertexSkinNormal: { stage: "vertex", type: "insertAfter", anchor: "#include <skinnormal_vertex>" },
  vertexSkinning:   { stage: "vertex", type: "insertAfter", anchor: "#include <skinning_vertex>" },
  vertexInject:     { stage: "vertex", type: "insertAfter", anchor: "#include <skinning_vertex>" },
  vertexProject:    { stage: "vertex", type: "insertAfter", anchor: "#include <project_vertex>" },
  // ----- fragment -----
  fragmentPrelude:    { stage: "fragment", type: "prepend" },
  fragmentFunctions:  { stage: "fragment", type: "insertBefore", anchor: "void main() {" },
  fragmentAfterColor: { stage: "fragment", type: "insertAfter", anchor: "#include <color_fragment>" },
  fragmentBody:       { stage: "fragment", type: "replace", anchor: FRAGMENT_ANCHOR },
};

// Apply the given sections to a shader object (in place). Mutates shader.vertexShader
// and shader.fragmentShader. Unknown sections and missing anchors fail closed
// instead of leaving a partially applied custom shader.
//
// Sections that share the same stage+type+anchor (e.g. two `insertAfter
// #include <skinning_vertex>` rules) are batched into a single string replace,
// so earlier insertions are not overwritten by later ones.
function injectSections(shader, sections) {
  // Group sections by stage+type+anchor so repeated anchors don't overwrite.
  // For 'replace' type, duplicate keys collapse to the first one.
  const groups = new Map();
  for (const [name, code] of Object.entries(sections)) {
    const rule = SECTION_INJECT_RULES[name];
    if (!code) continue;
    if (!rule) throw new Error(`Unknown shader section: ${name}`);
    const key = `${rule.stage}|${rule.type}|${rule.anchor ?? ""}`;
    if (rule.type === "replace" && groups.has(key)) {
      // First wins for replace.
      continue;
    } else if (rule.type === "replace") {
      groups.set(key, { rule, codes: [code] });
    } else {
      if (!groups.has(key)) groups.set(key, { rule, codes: [] });
      groups.get(key).codes.push(code);
    }
  }

  for (const { rule, codes } of groups.values()) {
    const isVertex = rule.stage === "vertex";
    const target = isVertex ? shader.vertexShader : shader.fragmentShader;
    let next;
    switch (rule.type) {
      case "prepend":
        next = codes.join("\n") + "\n" + target;
        break;
      case "insertAfter":
        if (!target.includes(rule.anchor)) {
          throw new Error(`Shader injection anchor not found: ${rule.anchor}`);
        }
        next = target.replace(
          rule.anchor,
          `${rule.anchor}\n\t${codes.join("\n\t")}`,
        );
        break;
      case "insertBefore":
        if (!target.includes(rule.anchor)) {
          throw new Error(`Shader injection anchor not found: ${rule.anchor}`);
        }
        next = target.replace(
          rule.anchor,
          `${codes.join("\n\t")}\n${rule.anchor}`,
        );
        break;
      case "replace":
        if (!target.includes(rule.anchor)) {
          throw new Error(`Shader injection anchor not found: ${rule.anchor}`);
        }
        next = target.replace(rule.anchor, codes.join("\n"));
        break;
      default:
        throw new Error(`Unsupported shader injection type: ${rule.type}`);
    }
    if (isVertex) shader.vertexShader = next;
    else shader.fragmentShader = next;
  }
  return shader;
}

function makePatcher(preparedShader, materialPass, tex, runtimes) {
  return (shader) => {
    const { samplers } = preparedShader;
    injectSections(shader, materialPass.sections);
    Object.assign(shader.uniforms, autoBindParams(samplers, tex, materialPass.shaderParams));
    // Runtime-owned uniforms are merged last so static material metadata
    // cannot replace the live objects updated by onBeforeRender().
    for (const runtime of runtimes) {
      if (typeof runtime.getUniforms === "function") {
        Object.assign(shader.uniforms, runtime.getUniforms(materialPass.id, materialPass));
      }
    }
  };
}

function makePassMaterial(shaderName, preparedShader, source, materialPass, tex, runtimes, material = source.clone()) {
  const baseCacheKey = source.userData.programCacheKey || `${shaderName}:${source.name || "material"}`;
  material.customProgramCacheKey = () => `${baseCacheKey}:pass:${materialPass.id}`;
  material.userData.__parameterizedShader = shaderName;
  material.userData.__parameterizedPassId = materialPass.id;
  material.userData.__parameterizedShaderRuntimes = runtimes;
  material.onBeforeCompile = makePatcher(preparedShader, materialPass, tex, runtimes);
  applyRenderState(material, materialPass.renderState);
  return material;
}

// Swap between parameterized materials and the original PBR materials.
export function setParameterizedRenderingEnabled(root, enabled) {
  root.traverse((object) => {
    if (object.userData.__parameterizedPassObject) {
      object.visible = enabled && object.userData.__parameterizedBaseVisible !== false;
      return;
    }
    if (!object.isMesh || object.userData.__baseMaterials === undefined) return;
    object.material = enabled ? object.userData.__parameterizedMaterials : object.userData.__baseMaterials;
  });
}

// ============================================================================
// Generic custom-shader binding
// ----------------------------------------------------------------------------
// Any material whose `extras.shader` resolves to a loaded shader package is
// bound through `makePatcher`. The binder is engine-glue: it does not know
// what a specific shader is, only how to attach metadata to a
// MeshStandardMaterial.
// ============================================================================

// Construct and initialize every runtime class exported by the Shader script.
// One runtime set is shared by all declared passes of a source material.
function instantiateShaderRuntime(material, rendererArg, preparedShader, mesh, scope) {
  const mod = preparedShader.scriptModule;
  if (!mod) return [];

  // A package may export several runtime classes (e.g. TimeRuntime + LightSyncRuntime).
  // Construct each one and register it. `getUniforms()` of all of them is
  // merged into shader.uniforms at compile time.
  const classes = [];
  if (typeof mod.default === "function") classes.push(mod.default);
  for (const v of Object.values(mod)) {
    if (typeof v === "function" && v !== mod.default) classes.push(v);
  }
  if (!classes.length) return [];

  const runtimes = [];
  for (const Ctor of classes) {
    const runtime = new Ctor(THREE, rendererArg, material, mesh);
    scope.runtimes.push(runtime);
    if (typeof runtime.init === "function") runtime.init(rendererArg);
    runtimes.push(runtime);
  }
  material.userData.__parameterizedShaderRuntimes = runtimes;
  return runtimes;
}

// Per-frame tick: drive every active runtime's onBeforeRender().
// Host must call this BEFORE the main scene render so runtimes can write to
// their own render targets.
export function tickShaderRuntimes(scene, camera, scope = defaultShaderScope) {
  for (const runtime of scope.runtimes) {
    if (typeof runtime.onBeforeRender === "function") runtime.onBeforeRender(scope.renderer, scene, camera);
  }
}

// Dispose all active runtimes (call on scene unload).
export function disposeShaderRuntimes(scope = defaultShaderScope) {
  for (const runtime of scope.runtimes) {
    if (typeof runtime.destroy === "function") runtime.destroy();
  }
  scope.runtimes.length = 0;
  for (const object of scope.defaultPassObjects) {
    object.removeFromParent();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  }
  scope.defaultPassObjects.length = 0;
}

// Low-level preview hosts use the default scope. CharacterRenderer owns a
// separate scope for each model load so unload and cancellation stay local.
const defaultShaderScope = { renderer: null, registry: defaultShaderRegistry, runtimes: [], defaultPassObjects: [], disposed: false };
export function setShaderRenderer(r) {
  installUnityColorMaskSupport(r);
  defaultShaderScope.renderer = r;
}

export function createShaderRuntimeScope(renderer, registry = defaultShaderRegistry) {
  installUnityColorMaskSupport(renderer);
  const scope = { renderer, registry, runtimes: [], defaultPassObjects: [], disposed: false };
  return {
    applyCustomShaders: (gltf, root) => applyCustomShaders(gltf, root, renderer, scope),
    tick: (scene, camera) => tickShaderRuntimes(scene, camera, scope),
    dispose() {
      scope.disposed = true;
      disposeShaderRuntimes(scope);
    },
  };
}

// Ask the Shader runtime to realize one declared material pass. No runtime
// result selects the generic same-mesh implementation; one result overrides
// it with either the pass material or runtime-owned Object3D instances.
function realizeMaterialPass(mesh, shaderName, material, materialPass, resolvedTextures, runtimes, passIndex, sourceAvailable, scope) {
  const results = [];
  for (const runtime of runtimes) {
    if (typeof runtime.createPass !== "function") continue;
    const result = runtime.createPass(materialPass.id, material, mesh, materialPass, resolvedTextures);
    if (result !== undefined && result !== null) results.push(result);
  }
  if (results.length === 0 && sourceAvailable) {
    return { sourceMaterial: material, objects: [] };
  }
  if (results.length === 0) {
    const object = createDefaultPassObject(mesh, material, materialPass.id);
    scope.defaultPassObjects.push(object);
    results.push(object);
  }
  if (results.length !== 1) {
    material.dispose();
    throw new Error(`Shader ${shaderName} pass ${materialPass.id} has multiple createPass() results`);
  }

  const values = Array.isArray(results[0]) ? results[0] : [results[0]];
  if (!values.length) {
    material.dispose();
    throw new Error(`Shader ${shaderName} pass ${materialPass.id}: createPass() returned an empty array`);
  }
  if (values.length === 1 && values[0] === material) {
    return { sourceMaterial: material, objects: [] };
  }
  for (const object of values) {
    if (!object?.isObject3D) {
      material.dispose();
      throw new Error(
        `Shader ${shaderName} pass ${materialPass.id}: createPass() must return its material or Object3D`,
      );
    }
    object.userData.__parameterizedPassObject = true;
    object.userData.__parameterizedPassId = materialPass.id;
    object.userData.__parameterizedPassOrder = passIndex;
    object.userData.__parameterizedBaseVisible = mesh.visible;
    const queue = materialPass.renderState.renderQueue ?? mesh.renderOrder;
    object.renderOrder = queue + passIndex / 1000;
  }
  return { sourceMaterial: null, objects: values };
}

// ============================================================================
// applyCustomShaders — unified entry point
// Walks the scene for any material with userData.shader (set by the
// converter from glTF extras), loads the matching shader package, and
// attaches the appropriate onBeforeCompile + render state. Replaces the
// per-shader apply*ToScene() functions.
// ============================================================================
export async function applyCustomShaders(gltf, root, rendererArg, scope = defaultShaderScope) {
  const parser = gltf.parser;
  const rendererInstance = rendererArg || scope.renderer;
  const jobs = [];
  const textureBindings = new Map();

  const getTextureBinding = (index) => {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid glTF texture index: ${String(index)}`);
    }
    if (!textureBindings.has(index)) {
      textureBindings.set(index, Promise.resolve(parser.getDependency("texture", index)).then(
        (texture) => createGltfTextureBinding(texture, parser.json?.textures?.[index]),
      ));
    }
    return textureBindings.get(index);
  };

  root.traverse((object) => {
    if (!object.isMesh) return;
    const base = object.material;
    const materials = Array.isArray(base) ? base : [base];

    // Skip meshes without any metadata-driven custom shader
    if (!materials.some((m) => m.userData?.shader)) return;

    jobs.push((async () => {
      const out = materials.slice();
      const sourcePassStates = [];
      const sourcePassOrders = [];
      const passRegistry = [];

      for (let i = 0; i < materials.length; i++) {
        const mat = materials[i];
        const shaderName = mat.userData.shader;
        if (!shaderName) continue;
        const shader = await loadShader(shaderName, scope.registry);
        const materialPasses = resolveMaterialPasses(
          shader.component,
          mat.userData,
          `Material ${mat.name || i}`,
        ).map((materialPass) => ({
          ...materialPass,
          sections: shader.passes.find((pass) => pass.id === materialPass.id).sections,
        }));

        const resolvedPasses = [];
        for (const materialPass of materialPasses) {
          const textures = {};
          for (const [slot, index] of Object.entries(materialPass.textures)) {
            if (Array.isArray(index)) {
              if (index.length === 0) throw new Error(`Material ${mat.name || i}: ${slot} has no array layers`);
              textures[slot] = await Promise.all(index.map(getTextureBinding));
            } else {
              textures[slot] = await getTextureBinding(index);
            }
          }
          const resolvedTextures = await resolveSamplerTextures(
            shader.samplers,
            textures,
            (uri) => scope.registry.loadTexture(shaderName, uri),
            `Shader ${shaderName} pass ${materialPass.id}`,
          );
          resolvedPasses.push({ materialPass, resolvedTextures });
        }

        if (scope.disposed) throw new Error("Shader runtime scope has been disposed");
        const firstClone = mat.clone();
        const runtimes = instantiateShaderRuntime(firstClone, rendererInstance, shader, object, scope);
        let sourceResult = null;
        const registeredPasses = [];
        for (const [passIndex, prepared] of resolvedPasses.entries()) {
          const passMaterial = makePassMaterial(
            shaderName,
            shader,
            mat,
            prepared.materialPass,
            prepared.resolvedTextures,
            runtimes,
            passIndex === 0 ? firstClone : undefined,
          );
          const result = realizeMaterialPass(
            object,
            shaderName,
            passMaterial,
            prepared.materialPass,
            prepared.resolvedTextures,
            runtimes,
            passIndex,
            sourceResult === null,
            scope,
          );
          if (result.sourceMaterial) {
            if (sourceResult) {
              throw new Error(`Material ${mat.name || i}: multiple passes returned their material`);
            }
            sourceResult = { material: result.sourceMaterial, pass: prepared.materialPass, passIndex };
          }
          registeredPasses.push({
            id: prepared.materialPass.id,
            material: result.sourceMaterial,
            objects: result.objects,
          });
        }
        if (!sourceResult) {
          throw new Error(`Material ${mat.name || i}: one pass must return its material for the source mesh`);
        }
        out[i] = sourceResult.material;
        sourcePassStates.push(sourceResult.pass.renderState);
        sourcePassOrders.push(sourceResult.passIndex);
        passRegistry[i] = registeredPasses;
      }

      applyRenderQueue(object, sourcePassStates);
      const uniqueOrders = [...new Set(sourcePassOrders)];
      if (uniqueOrders.length > 1) {
        throw new Error(`Object ${object.name || "<unnamed>"}: source materials use different pass orders`);
      }
      object.renderOrder += (uniqueOrders[0] || 0) / 1000;

      object.userData.__baseMaterials = base;
      object.userData.__parameterizedMaterials = Array.isArray(base) ? out : out[0];
      object.userData.__parameterizedPassesByMaterial = passRegistry;
      object.material = object.userData.__parameterizedMaterials;
    })());
  });

  // Finish every material job before reporting failure: the caller can then
  // dispose this scope without another pending job registering new runtimes.
  const results = await Promise.allSettled(jobs);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

// === Automatic uniform binding =================================
// Builds the uniforms object from the material's `shaderParams` and texture
// map. Sampler uniforms are emitted first in the order listed in
// the shader component's samplers (preserving GLSL declaration order —
// three.js binds samplers to texture units in the order they appear in
// shader.uniforms). Each
// remaining key in shaderParams becomes a `u + key` uniform with a value
// inferred from the param's structure (number / 2-4 element array).
//
// No GLSL parsing — the renderer stays unaware of shader internals.

function autoBindValue(val) {
  if (typeof val === "number") return val;
  if (Array.isArray(val)) {
    if (val.length === 2) return new THREE.Vector2(val[0], val[1]);
    if (val.length === 3) return new THREE.Vector3(val[0], val[1], val[2]);
    if (val.length === 4) return new THREE.Vector4(val[0], val[1], val[2], val[3]);
  }
  return val;
}

export function autoBindParams(samplers, texMap, params) {
  const uniforms = {};
  // Sampler uniforms — emit in the order listed by the shader component.
  // three.js binds samplers to texture units in the order they appear in
  // shader.uniforms, so the GLSL declaration order must be preserved here.
  for (const descriptor of samplers || []) {
    uniforms["u" + descriptor.name] = { value: texMap[descriptor.name] };
  }
  // Other uniforms — params is the constraint-checked shaderParams field;
  // each key is a uniform name (without "u" prefix) paired with its value.
  for (const [key, val] of Object.entries(params || {})) {
    if (uniforms["u" + key]) continue; // already bound as a sampler
    uniforms["u" + key] = { value: autoBindValue(val) };
  }
  return uniforms;
}
export function getShaderRuntimes(material) {
  return material?.userData?.__parameterizedShaderRuntimes ?? [];
}

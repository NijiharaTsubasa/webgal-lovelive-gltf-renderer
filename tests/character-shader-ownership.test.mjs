import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CharacterRenderer } from '../src/character-renderer.js';
import { CharacterResourceOwner } from '../src/character-resource-owner.js';
import { ResourcePackages } from '../src/resource-packages.js';
import { createShaderRuntimeScope, getShaderRuntimes } from '../src/parameterized-renderer.js';
import { composeHumanoidHeadBody } from '../src/skeleton-composer.js';

function fixture({ integrated = false } = {}) {
  const constructed = [], configured = [], destroyed = [], dependencies = [], resources = new Map();
  function watch(resource, label) {
    assert.ok(!resources.has(resource), `resource registered once: ${label}`);
    const record = { label, disposed: 0 };
    resource.addEventListener('dispose', () => { record.disposed++; });
    resources.set(resource, record);
    return resource;
  }
  class OwnershipRuntime {
    constructor(_THREE, _renderer, material, mesh) {
      this.role = material.userData.fixtureRole; this.mesh = mesh;
      constructed.push({ role: this.role, mesh });
    }
    configurePass(id, material, mesh, _metadata, textures) {
      assert.equal(id, 'Forward');
      assert.equal(mesh, this.mesh);
      watch(material, `${this.role}:bound-material`);
      // A part's newly added helpers intentionally share its texture binding.
      if (!resources.has(textures.MainTex)) watch(textures.MainTex, `${this.role}:bound-texture`);
      configured.push({ role: this.role, material, mesh, texture: textures.MainTex });
    }
    getUniforms() { return {}; } // Check the standard sampler binder, not a replacement.
    destroy() { destroyed.push(this.role); }
  }
  const packages = new ResourcePackages({
    fetchResource: async url => {
      assert.equal(url, 'https://ownership.test/runtime/sampler.glsl');
      return { ok: true, text: async () => '// Empty sections deliberately preserve the standard shader.\n' };
    },
    loadModule: async url => {
      assert.equal(url, 'https://ownership.test/runtime/runtime.js');
      return { default: OwnershipRuntime };
    },
  });
  packages.register({ components: [{ type: 'shader', name: 'ownership-sampler', src: 'sampler.glsl', script: 'runtime.js',
    samplers: [{ name: 'MainTex', type: 'sampler2D', missing: { behavior: 'error' } }],
    passes: [{ id: 'Forward', sections: {} }],
  }] }, 'https://ownership.test/runtime/config.json');

  function part(role, index, textureCount, colorSpace) {
    const root = new THREE.Group(); root.name = `${role}-scene`;
    const hips = new THREE.Bone(); hips.name = 'Hips'; root.add(hips);
    const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1.37; hips.add(head);
    const texture = watch(new THREE.Texture(), `${role}:loader-texture`);
    texture.name = `${role}-only-texture`;
    texture.userData.colorSpace = colorSpace === 'srgb' ? 'linear' : 'srgb';
    const geometry = watch(new THREE.PlaneGeometry(.31, .73), `${role}:geometry`);
    const material = watch(new THREE.MeshStandardMaterial({ map: texture }), `${role}:source-material`);
    material.name = `${role}-source-material`;
    material.userData = { fixtureRole: role, shader: 'ownership-sampler', shaderParams: {}, textures: { MainTex: index }, passes: [{ id: 'Forward' }] };
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `${role}-source-mesh`; root.add(mesh);
    const json = { nodes: [{ name: 'Hips' }, { name: 'Head' }, { name: mesh.name }],
      textures: Array.from({ length: textureCount }, () => ({ extras: { colorSpace } })) };
    const parser = {
      json, associations: new Map([[hips, { nodes: 0 }], [head, { nodes: 1 }], [mesh, { nodes: 2, meshes: 0, primitives: 0 }]]),
      async getDependency(kind, requested) {
        dependencies.push({ role, kind, index: requested });
        assert.equal(kind, 'texture');
        assert.ok(Number.isInteger(requested) && requested >= 0 && requested < json.textures.length,
          `${role} parser: texture index ${requested} is outside its own range [0,${json.textures.length})`);
        assert.equal(requested, index, `${role} parser was asked for another part's texture`);
        return texture;
      },
    };
    return { role, root, mesh, texture, material, geometry, gltf: { scene: root, parser } };
  }
  const head = integrated ? null : part('head', 3, 4, 'srgb');
  const body = part(integrated ? 'integrated' : 'body', 0, 1, 'linear');
  const renderer = { state: { setMaterial() {} }, getContext: () => ({ colorMask() {} }), render() {} };
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const loader = { async loadAsync(url) {
    if (head && url === 'https://ownership.test/models/head/model.glb') return head.gltf;
    if (url === `https://ownership.test/models/${body.role}/model.glb`) return body.gltf;
    throw new Error(`Unexpected model URL ${url}`);
  } };
  const entries = (integrated ? ['integrated'] : ['head', 'body']).map(role => ({ group: 'fixture-humanoid', basePath: `models/${role}`,
    component: { type: 'model', name: role, role, model: 'model.glb', humanoidScale: 1 } }));
  return { head, body, packages, renderer, scene, camera, loader, entries, constructed, configured, destroyed, dependencies, resources, watch };
}

function initializeWith(f, initialize) {
  f.entries.at(-1).component.behaviors = [{ name: 'Ownership.Initialize', required: true, parameters: {} }];
  f.packages.behaviors.registerPackage({ components: [{ type: 'behavior', namespace: 'Ownership', name: 'Initialize', script: 'initialize.js' }] }, {
    loadModule: async () => ({ default: class {
      constructor(context) { this.context = context; }
      Start() { this.cleanup = initialize(this.context); }
      OnDestroy() { this.cleanup?.(); }
    } }),
  });
}

function helperMesh(f, original, name) {
  const material = f.watch(original.material.clone(), `${name}:behavior-source-material`);
  const mesh = new THREE.Mesh(original.geometry, material); mesh.name = name;
  return { mesh, cleanup() { mesh.removeFromParent(); material.dispose(); } };
}

function assertDisposedOnce(f) {
  for (const { label, disposed } of f.resources.values()) assert.equal(disposed, 1, label);
}

test('CharacterRenderer composition keeps each mesh with its original glTF texture parser and binds it once', async t => {
  const f = fixture();
  const actor = new CharacterRenderer({ renderer: f.renderer, scene: f.scene, camera: f.camera,
    resourcePackages: f.packages, loader: f.loader });
  t.after(() => actor.dispose());
  const result = await actor.load(f.entries, 'https://ownership.test/');
  assert.equal(result.root, f.body.root);
  assert.equal(f.head.root.children.length, 0, 'the head scene is genuinely emptied by composition');
  assert.equal(f.head.mesh.parent, f.body.root);
  assert.deepEqual(f.dependencies.slice().sort((a, b) => a.role.localeCompare(b.role)),
    [{ role: 'body', kind: 'texture', index: 0 }, { role: 'head', kind: 'texture', index: 3 }]);
  assert.equal(f.constructed.length, 2, 'one runtime for each original mesh, never a third body traversal of head');
  assert.deepEqual(f.constructed.map(item => item.role).sort(), ['body', 'head']);
  assert.equal(f.configured.length, 2);
  for (const original of [f.head, f.body]) {
    const [binding] = f.configured.filter(item => item.mesh === original.mesh);
    assert.ok(binding);
    assert.equal(binding.role, original.role);
    assert.notEqual(binding.texture, original.texture, 'standard binding isolates a glTF texture entry');
    assert.equal(binding.texture.source, original.texture.source, 'the image source must come from this part parser');
    assert.equal(binding.texture.colorSpace, original.role === 'head' ? THREE.SRGBColorSpace : THREE.NoColorSpace);
    assert.equal(original.mesh.userData.__baseMaterials, original.material, 'source material is captured once');
    assert.equal(getShaderRuntimes(original.mesh.material).length, 1);
    const shader = { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: 'void main() {}' };
    original.mesh.material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.uMainTex.value, binding.texture, 'standard sampler binder retains the correct part texture');
  }
  actor.dispose();
  assert.equal(actor.root, null); assert.equal(actor.shaderScope, null); assert.equal(actor.modelResources, null);
  assert.equal(f.scene.children.length, 0);
  assert.deepEqual(f.destroyed.slice().sort(), ['body', 'head']);
  assertDisposedOnce(f);
  actor.dispose();
  assertDisposedOnce(f);
});

test('legacy post-compose part.root traversal is a failing control for the same head-index3/body-index0 fixture', async () => {
  const f = fixture(), owner = new CharacterResourceOwner();
  owner.capture(f.head.root); owner.capture(f.body.root);
  composeHumanoidHeadBody(f.body.root, f.head.root);
  const scope = createShaderRuntimeScope(f.renderer, f.packages.shaders);
  try {
    // Exact old binding order, reconstructed only inside this negative control.
    await assert.rejects(async () => {
      for (const part of [f.head, f.body]) await scope.applyCustomShaders(part.gltf, part.root);
    }, /body parser: texture index 3 is outside its own range/);
    assert.ok(f.dependencies.some(call => call.role === 'body' && call.index === 3));
    assert.ok(!f.dependencies.some(call => call.role === 'head'), 'old traversal never visits the emptied head scene');
  } finally { scope.dispose(); owner.dispose(); }
  assertDisposedOnce(f);
});

test('composed initialization additions use the live body parser and removed source meshes are not initialized', async t => {
  const f = fixture(); let helper;
  initializeWith(f, context => {
    assert.equal(context.root, f.body.root);
    f.head.mesh.removeFromParent();
    helper = helperMesh(f, f.body, 'body-start-helper'); context.root.add(helper.mesh);
    return helper.cleanup;
  });
  const actor = new CharacterRenderer({ renderer: f.renderer, scene: f.scene, camera: f.camera, resourcePackages: f.packages, loader: f.loader });
  t.after(() => actor.dispose());
  await actor.load(f.entries, 'https://ownership.test/');
  assert.equal(f.constructed.length, 2);
  assert.deepEqual(new Set(f.constructed.map(item => item.mesh)), new Set([f.body.mesh, helper.mesh]));
  assert.ok(!f.constructed.some(item => item.mesh === f.head.mesh), 'detached original is not given a shader runtime');
  assert.deepEqual(f.dependencies, [{ role: 'body', kind: 'texture', index: 0 }], 'new helpers share the live body parser texture cache');
  const bound = f.configured.find(item => item.mesh === helper.mesh);
  assert.equal(bound.texture.source, f.body.texture.source);
  actor.dispose(); assertDisposedOnce(f);
});

test('integrated initialization replacements receive their own parser instead of the removed snapshot mesh', async t => {
  const f = fixture({ integrated: true }); let helper;
  initializeWith(f, context => {
    f.body.mesh.removeFromParent();
    helper = helperMesh(f, f.body, 'integrated-start-replacement'); context.root.add(helper.mesh);
    return helper.cleanup;
  });
  const actor = new CharacterRenderer({ renderer: f.renderer, scene: f.scene, camera: f.camera, resourcePackages: f.packages, loader: f.loader });
  t.after(() => actor.dispose());
  await actor.load(f.entries, 'https://ownership.test/');
  assert.deepEqual(f.constructed.map(item => item.mesh), [helper.mesh]);
  assert.deepEqual(f.dependencies, [{ role: 'integrated', kind: 'texture', index: 0 }]);
  assert.equal(f.configured[0].texture.source, f.body.texture.source);
  actor.dispose(); assertDisposedOnce(f);
});

for (const nested of [false, true]) {
  test(`initialization helper under ${nested ? 'nested' : 'detached'} head part root keeps that part parser and binds once`, async t => {
    const f = fixture(); let helper;
    initializeWith(f, context => {
      helper = helperMesh(f, f.head, 'head-part-start-helper'); f.head.root.add(helper.mesh);
      if (nested) context.root.add(f.head.root);
      return helper.cleanup;
    });
    const actor = new CharacterRenderer({ renderer: f.renderer, scene: f.scene, camera: f.camera, resourcePackages: f.packages, loader: f.loader });
    t.after(() => actor.dispose());
    await actor.load(f.entries, 'https://ownership.test/');
    assert.equal(f.head.root.parent, nested ? f.body.root : null);
    assert.equal(f.constructed.length, 3);
    assert.equal(f.constructed.filter(item => item.mesh === helper.mesh).length, 1);
    assert.equal(f.configured.find(item => item.mesh === helper.mesh).texture.source, f.head.texture.source);
    assert.equal(f.configured.find(item => item.mesh === f.head.mesh).texture.source, f.head.texture.source);
    assert.deepEqual(f.dependencies.slice().sort((a, b) => a.role.localeCompare(b.role)),
      [{ role: 'body', kind: 'texture', index: 0 }, { role: 'head', kind: 'texture', index: 3 }]);
    actor.dispose(); assertDisposedOnce(f);
  });
}

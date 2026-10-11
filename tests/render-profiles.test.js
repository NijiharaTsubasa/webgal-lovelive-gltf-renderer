import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RenderProfileRegistry, createRenderProfileScope } from '../src/render-profiles.js';
import { CharacterRenderer } from '../src/character-renderer.js';
import { ShaderRegistry, createShaderRuntimeScope, getShaderRuntimes } from '../src/parameterized-renderer.js';
import { validateModelManifest } from '../src/model-manifest.js';
import { ResourcePackages } from '../src/resource-packages.js';

function rendererFixture() {
  return {
    target: { name: 'external' }, viewport: new THREE.Vector4(1, 2, 30, 40), scissor: new THREE.Vector4(3, 4, 10, 20),
    scissorTest: true, color: new THREE.Color(.2, .3, .4), alpha: .6,
    autoClear: true, autoClearColor: true, autoClearDepth: false, autoClearStencil: true,
    getRenderTarget() { return this.target; }, setRenderTarget(value) { this.target = value; },
    getViewport(out) { return out.copy(this.viewport); }, setViewport(value) { this.viewport.copy(value); },
    getScissor(out) { return out.copy(this.scissor); }, setScissor(value) { this.scissor.copy(value); },
    getScissorTest() { return this.scissorTest; }, setScissorTest(value) { this.scissorTest = value; },
    getClearColor(out) { return out.copy(this.color); }, getClearAlpha() { return this.alpha; },
    setClearColor(color, alpha) { this.color.copy(color); this.alpha = alpha; }, render() {},
  };
}
const profileFixture = overrides => ({ attach() {}, detach() {}, prepare() {}, render() {}, destroy() {}, ...overrides });

test('profile registry resolves module once and checks required Shaders', async () => {
  const registry = new RenderProfileRegistry();
  const calls = [];
  registry.registerPackage({ components: [{ type: 'render-profile', name: 'fixture', script: './profile.js', requiredShaders: ['shader'] }] },
    { source: 'https://example.test/config.json', loadModule: async url => { calls.push(url); return { createRenderProfile() {} }; } });
  const shaders = { async loadShader(name) { calls.push(name); } };
  assert.equal(await registry.load('fixture', shaders), await registry.load('fixture', shaders));
  assert.deepEqual(calls, ['shader', 'https://example.test/profile.js', 'shader']);
  await assert.rejects(registry.load('missing', shaders), /not found/);
  assert.throws(() => registry.registerPackage({ components: [{ type: 'render-profile', name: 'bad', script: 'a', requiredShaders: ['x', 'x'] }] },
    { source: 'https://example.test/config.json' }), /unique/);
});

test('profile draw restores external renderer state on normal and exceptional exits', () => {
  for (const fail of [false, true]) {
    const renderer = rendererFixture(), target = renderer.target;
    const profile = createRenderProfileScope(profileFixture({ render(frame) {
      assert.equal(frame.time, 3); assert.equal(frame.delta, .02); assert.equal(frame.target, target);
      frame.viewport.set(9, 9, 9, 9);
      renderer.target = null; renderer.viewport.set(0, 0, 1, 1); renderer.scissor.set(0, 0, 2, 2);
      renderer.scissorTest = false; renderer.autoClear = false; renderer.autoClearDepth = true;
      renderer.color.setRGB(1, 1, 1); renderer.alpha = 0;
      if (fail) throw new Error('fixture error');
    } }), renderer);
    if (fail) assert.throws(() => profile.render({}, {}, 3, .02), /fixture error/);
    else profile.render({}, {}, 3, .02);
    assert.equal(renderer.target, target); assert.deepEqual(renderer.viewport.toArray(), [1, 2, 30, 40]);
    assert.deepEqual(renderer.scissor.toArray(), [3, 4, 10, 20]); assert.equal(renderer.scissorTest, true);
    assert.equal(renderer.autoClear, true); assert.equal(renderer.autoClearDepth, false);
    assert.deepEqual(renderer.color.toArray(), [.2, .3, .4]); assert.equal(renderer.alpha, .6);
  }
});

test('profile frame uses physical pixels and restores distinct logical globals and active RT state at DPR 2', () => {
  for (const useTarget of [false, true]) {
    const renderer = rendererFixture(); renderer.getPixelRatio = () => 2;
    renderer.actualViewport = new THREE.Vector4(); renderer.actualScissor = new THREE.Vector4();
    const globalViewport = renderer.viewport.clone(), globalScissor = renderer.scissor.clone();
    const target = { viewport: new THREE.Vector4(5, 6, 64, 48), scissor: new THREE.Vector4(7, 8, 30, 20), scissorTest: false };
    renderer.setViewport = function(value) { this.viewport.copy(value); this.actualViewport.copy(value).multiplyScalar(2); };
    renderer.setScissor = function(value) { this.scissor.copy(value); this.actualScissor.copy(value).multiplyScalar(2); };
    renderer.getCurrentViewport = function(out) { return out.copy(this.actualViewport); };
    renderer.setRenderTarget = function(value) { this.target = value;
      this.actualViewport.copy(value?.viewport ?? this.viewport.clone().multiplyScalar(2));
      this.actualScissor.copy(value?.scissor ?? this.scissor.clone().multiplyScalar(2));
      this.actualScissorTest = value?.scissorTest ?? this.scissorTest;
    };
    renderer.state = { viewport(value) { renderer.actualViewport.copy(value); }, scissor(value) { renderer.actualScissor.copy(value); },
      setScissorTest(value) { renderer.actualScissorTest = value; } };
    renderer.setRenderTarget(useTarget ? target : null);
    const expectedViewport = renderer.actualViewport.clone(), expectedScissor = renderer.actualScissor.clone();
    const expectedTest = renderer.actualScissorTest;
    const profile = createRenderProfileScope(profileFixture({ render(frame) {
      assert.deepEqual(frame.viewport.toArray(), expectedViewport.toArray());
      assert.deepEqual(frame.scissor.toArray(), expectedScissor.toArray()); assert.equal(frame.scissorTest, expectedTest);
      renderer.setViewport(new THREE.Vector4(0, 0, 1, 1)); renderer.setScissor(new THREE.Vector4(0, 0, 1, 1)); renderer.setRenderTarget(null);
    } }), renderer);
    profile.render({}, {}, 0, 0);
    assert.deepEqual(renderer.viewport.toArray(), globalViewport.toArray()); assert.deepEqual(renderer.scissor.toArray(), globalScissor.toArray());
    assert.deepEqual(renderer.actualViewport.toArray(), expectedViewport.toArray()); assert.deepEqual(renderer.actualScissor.toArray(), expectedScissor.toArray());
    assert.equal(renderer.actualScissorTest, expectedTest); assert.deepEqual(target.viewport.toArray(), [5, 6, 64, 48]);
    assert.deepEqual(target.scissor.toArray(), [7, 8, 30, 20]);
  }
});

test('profiles allow successive scopes and multiple roots, reject nested draws and returning render values', () => {
  const renderer = rendererFixture(), events = [];
  const a = createRenderProfileScope(profileFixture({ attach(root) { events.push(root); }, detach(root) { events.push(root); }, destroy() { events.push('destroy'); } }), renderer);
  const b = createRenderProfileScope(profileFixture({ render() { a.render({}, {}, 0, 0); } }), renderer);
  a.attach('root1'); a.attach('root1'); a.attach('root2'); a.render({}, {}, 0, 0);
  assert.throws(() => b.render({}, {}, 0, 0), /Only one/);
  a.render({}, {}, 0, 0); a.dispose(); a.dispose();
  assert.deepEqual(events, ['root1', 'root2', 'root1', 'root2', 'destroy']);
  const invalid = createRenderProfileScope(profileFixture({ render() { return {}; } }), renderer);
  assert.throws(() => invalid.render({}, {}, 0, 0), /return no value/);
});

test('cancelled asynchronous profile preparation releases resources created after cancellation', async () => {
  const events = [], renderer = rendererFixture(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const scope = createRenderProfileScope(profileFixture({ async prepare() { await gate; events.push('created'); },
    detach() { events.push('detach'); }, destroy() { events.push('destroy'); } }), renderer);
  scope.attach({}); const pending = scope.prepare({}, {}, 0, 0);
  await Promise.resolve(); scope.dispose(); release(); await pending; await Promise.resolve();
  assert.deepEqual(events, ['created', 'detach', 'destroy']);
});

test('asynchronous attachment finishes before cancellation cleanup and restores its renderer state', async () => {
  const renderer = rendererFixture(), target = renderer.target, calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const scope = createRenderProfileScope(profileFixture({ async attach() { renderer.target = null; await gate; calls.push('attached'); },
    detach() { calls.push('detached'); }, destroy() { calls.push('destroyed'); } }), renderer);
  const attaching = scope.attach({}); scope.dispose(); release(); await attaching;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['attached', 'detached', 'destroyed']); assert.equal(renderer.target, target);
});

test('CharacterRenderer selects profile after one Shader tick and uses host playback time', async () => {
  const calls = [], renderer = rendererFixture(); renderer.render = () => calls.push('default');
  const character = new CharacterRenderer({ renderer, scene: {}, camera: {} });
  character.elapsedTime = 7; character.frameDelta = .04;
  character.shaderScope = { tick() { calls.push('tick'); } };
  character.renderProfileScope = createRenderProfileScope(profileFixture({ prepare(frame) { calls.push(['prepare', frame.time, frame.delta]); },
    render(frame) { calls.push(['profile', frame.time, frame.delta]); } }), renderer);
  await character.prepareRenderResources(); character.render(); character.shadersEnabled = false; character.render();
  assert.deepEqual(calls, [['prepare', 7, .04], 'tick', ['profile', 7, .04], 'tick', 'default']);
});

test('model profile declarations and head/body combination reject invalid or mismatched profiles before clearing the actor', async () => {
  const component = { type: 'model', name: 'fixture', role: 'body', model: 'a.glb', humanoidScale: 1, group: 'g', renderProfile: '' };
  assert.throws(() => validateModelManifest({ components: [component] }), /renderProfile/);
  const actor = new CharacterRenderer({ renderer: {}, scene: {}, camera: {} });
  const existing = {}; actor.root = existing;
  await assert.rejects(actor.load([{ group: 'g', component: { ...component, role: 'head', renderProfile: 'a' } },
    { group: 'g', component: { ...component, renderProfile: 'b' } }], ''), /renderProfile/);
  assert.equal(actor.root, existing);
});

test('auxiliary pass material shares Shader runtime and resolves metadata without creating objects', async () => {
  const calls = [], registry = new ShaderRegistry();
  registry.registerPackage({ components: [{ type: 'shader', name: 'fixture', src: 'shader', script: 'runtime', samplers: [],
    passes: [{ id: 'Forward', sections: {} }, { id: 'Depth', sections: {}, extras: { auxiliary: true } }] }] },
  { source: 'https://example.test/config.json', loadText: async () => '', loadModule: async () => ({ default: class {
    constructor() { calls.push('construct'); }
    configurePass(id, material, mesh, pass) { calls.push(['configure', id, pass.shaderParams, pass.extras]); }
    createPassObjects(id) { calls.push(['objects', id]); return []; }
    destroy() { calls.push('destroy'); }
  } }) });
  const source = new THREE.MeshStandardMaterial(); source.userData = { shader: 'fixture', shaderParams: { value: .5 }, textures: {}, passes: [{ id: 'Forward' }] };
  const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.PlaneGeometry(), source); root.add(mesh);
  const scope = createShaderRuntimeScope({ state: { setMaterial() {} }, getContext: () => ({ colorMask() {} }) }, registry);
  await scope.applyCustomShaders({ parser: {} }, root);
  const [a, b] = await Promise.all([scope.createPassMaterial(mesh.material, 'Depth', mesh), scope.createPassMaterial(source, 'Depth', mesh)]);
  assert.equal(a, b); assert.equal(a.isMaterial, true); assert.equal(root.children.length, 1);
  assert.equal(getShaderRuntimes(a)[0], getShaderRuntimes(mesh.material)[0]);
  assert.equal(a.userData.materialPass.id, 'Depth');
  assert.deepEqual(calls, ['construct', ['configure', 'Forward', { value: .5 }, {}], ['objects', 'Forward'],
    ['configure', 'Depth', { value: .5 }, { auxiliary: true }]]);
  await assert.rejects(scope.createPassMaterial(source, 'Unknown', mesh), /unknown auxiliary/);
  let released = 0; a.addEventListener('dispose', () => released++); scope.dispose();
  assert.equal(released, 1); assert.equal(calls.at(-1), 'destroy');
  await assert.rejects(scope.createPassMaterial(source, 'Depth', mesh), /disposed/);
});

test('loading owns profile attachment and clear releases only its own scope', async () => {
  const calls = [], packages = new ResourcePackages({ loadModule: async () => ({ createRenderProfile() {
    return profileFixture({ attach(root) { calls.push(['attach', root]); }, detach(root) { calls.push(['detach', root]); }, destroy() { calls.push('destroy'); } });
  } }) });
  packages.register({ components: [{ type: 'render-profile', name: 'fixture', script: 'profile.js', requiredShaders: [] }] }, 'https://example.test/config.json');
  const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()));
  const renderer = rendererFixture(); renderer.state = { setMaterial() {} }; renderer.getContext = () => ({ colorMask() {} });
  const actor = new CharacterRenderer({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), resourcePackages: packages,
    loader: { async loadAsync() { return { scene: root, parser: { json: { nodes: [] }, associations: new Map() } }; } } });
  await actor.load([{ basePath: '', component: { role: 'integrated', model: 'model.glb', humanoidScale: 1, renderProfile: 'fixture' } }], 'https://example.test/');
  assert.equal(calls[0][0], 'attach'); assert.equal(calls[0][1], root);
  actor.clear(); assert.deepEqual(calls, [['attach', root], ['detach', root], 'destroy']);
  assert.equal(actor.root, null); assert.equal(actor.renderProfileScope, null);
});

test('additional pass objects retain source scope identity and unknown material/mesh pairs cannot instantiate runtimes', async () => {
  let constructed = 0; const registry = new ShaderRegistry();
  registry.registerPackage({ components: [{ type: 'shader', name: 'fixture', src: 'shader', script: 'runtime', samplers: [],
    passes: [{ id: 'Front', sections: {} }, { id: 'Back', sections: {} }, { id: 'Depth', sections: {} }] }] },
  { source: 'https://example.test/config.json', loadText: async () => '', loadModule: async () => ({ default: class {
    constructor(THREE, renderer, material, mesh) { constructed++; this.mesh = mesh; }
  } }) });
  const source = new THREE.MeshStandardMaterial(); source.userData = { shader: 'fixture', textures: {}, shaderParams: {}, passes: [{ id: 'Front' }, { id: 'Back' }] };
  const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.PlaneGeometry(), source); root.add(mesh);
  const scope = createShaderRuntimeScope({ state: { setMaterial() {} }, getContext: () => ({ colorMask() {} }) }, registry);
  await scope.applyCustomShaders({ parser: {} }, root);
  const additional = root.children.find(child => child !== mesh);
  const auxiliary = await scope.createPassMaterial(additional.material, 'Depth', additional);
  assert.equal(constructed, 1); assert.equal(getShaderRuntimes(auxiliary)[0], getShaderRuntimes(mesh.material)[0]);
  const unknownMesh = new THREE.Mesh(new THREE.PlaneGeometry(), source);
  await assert.rejects(scope.createPassMaterial(mesh.material, 'Depth', unknownMesh), /registered/);
  await assert.rejects(scope.createPassMaterial(new THREE.MeshStandardMaterial(), 'Depth', mesh), /registered/);
  assert.equal(constructed, 1); scope.dispose();
});

test('cancelled profile module load never attaches and releases model resources', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  const packages = new ResourcePackages({ loadModule: async () => { calls.push('loading'); await gate; return { createRenderProfile() { assert.fail('cancelled factory invoked'); } }; } });
  packages.register({ components: [{ type: 'render-profile', name: 'fixture', script: 'profile.js', requiredShaders: [] }] }, 'https://example.test/config.json');
  const root = new THREE.Group(), geometry = new THREE.PlaneGeometry(); let released = 0; geometry.addEventListener('dispose', () => released++);
  root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  const renderer = rendererFixture(); renderer.state = { setMaterial() {} }; renderer.getContext = () => ({ colorMask() {} });
  const actor = new CharacterRenderer({ renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), resourcePackages: packages,
    loader: { async loadAsync() { return { scene: root, parser: { json: { nodes: [] }, associations: new Map() } }; } } });
  const loading = actor.load([{ basePath: '', component: { role: 'integrated', model: 'model.glb', humanoidScale: 1, renderProfile: 'fixture' } }], 'https://example.test/');
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 0));
  actor.clear(); release(); assert.equal(await loading, null); assert.equal(released, 1);
  assert.equal(actor.shaderScope, null); assert.equal(actor.renderProfileScope, null);
});

test('profile destroy failures do not prevent Shader and model cleanup', () => {
  const actor = new CharacterRenderer({ renderer: {}, scene: new THREE.Scene(), camera: {} }); const calls = [];
  actor.root = new THREE.Group(); actor.scene.add(actor.root);
  actor.renderProfileScope = { dispose() { calls.push('profile'); throw new Error('destroy failed'); } };
  actor.shaderScope = { dispose() { calls.push('shader'); } }; actor.modelResources = { dispose() { calls.push('model'); } };
  assert.throws(() => actor.clear(), /destroy failed/); assert.deepEqual(calls, ['profile', 'shader', 'model']);
  assert.equal(actor.root, null); assert.equal(actor.scene.children.length, 0);
});

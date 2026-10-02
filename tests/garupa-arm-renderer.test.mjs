import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ParameterArmRenderer, armDrawsInFront, armDrawOrder, armRegionWeights } from '../src/garupa/arm-renderer.js';
import { setParameterizedRenderingEnabled } from '../src/parameterized-renderer.js';

const ATTRIBUTE = 'garupaArmRegions';
const BACK = 0.7971428632736206;
const FRONT_NEIGHBOR = 0.7971428036689758;

function bone(name, parent) {
  const result = new THREE.Bone(); result.name = name; parent?.add(result); return result;
}
function rig() {
  const chest = bone('Chest'), bones = [chest], named = { Chest: chest };
  for (const side of ['Left', 'Right']) {
    let parent = chest;
    for (const name of ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'IndexProximal', 'IndexDistal']) {
      const item = bone(side + name, parent); named[item.name] = item; bones.push(item); parent = item;
    }
  }
  return { bones, named };
}
function geometry(count = 3) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  result.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  result.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  result.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(count * 3), 3)];
  result.morphTargetsRelative = true;
  return result;
}
function skinned(g, bones, influences, material = new THREE.MeshStandardMaterial()) {
  const indices = new Uint16Array(g.attributes.position.count * 4), weights = new Float32Array(indices.length);
  for (let vertex = 0; vertex < influences.length; vertex++) for (let slot = 0; slot < influences[vertex].length; slot++) {
    const [index, weight] = influences[vertex][slot]; indices[vertex * 4 + slot] = index; weights[vertex * 4 + slot] = weight;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(g, material); mesh.skeleton = new THREE.Skeleton(bones); return mesh;
}
function shader() {
  return { uniforms: {}, vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' };
}
function materialState(material) {
  return {
    visible: material.visible, colorWrite: material.colorWrite, depthTest: material.depthTest,
    depthWrite: material.depthWrite, depthFunc: material.depthFunc, side: material.side,
    blending: material.blending, stencilWrite: material.stencilWrite, stencilFunc: material.stencilFunc,
    stencilRef: material.stencilRef, stencilFuncMask: material.stencilFuncMask,
    stencilWriteMask: material.stencilWriteMask, stencilFail: material.stencilFail,
    stencilZFail: material.stencilZFail, stencilZPass: material.stencilZPass,
    hasColorMask: Object.hasOwn(material.userData, '__unityColorWriteMask'), colorMask: material.userData.__unityColorWriteMask,
  };
}
function mockRenderer(adaptation, failureLayer, failureSide) {
  const result = {
    autoClear: true, shadowMap: { autoUpdate: true }, frames: [], clears: [], events: [],
    clear(...args) { this.clears.push(args); this.events.push(['clear', ...args]); },
    render(scene, camera) {
      const draws = [];
      // Match Three traversal: a layers mismatch skips this object's draw, not
      // traversal of its children; visible=false suppresses the whole subtree.
      function visit(object) {
        if (!object.visible) return;
        if ((object.isMesh || object.isLine || object.isPoints || object.isSprite) && object.layers.test(camera.layers)) {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material?.visible) draws.push({ object, material, state: materialState(material) });
          }
        }
        for (const child of object.children) visit(child);
      }
      visit(scene);
      this.events.push(['render', adaptation.layer.value]);
      this.frames.push({ layer: adaptation.layer.value, side: adaptation.side.value, background: scene.background, autoClear: this.autoClear, draws });
      if (adaptation.layer.value === failureLayer && (failureSide === undefined || adaptation.side.value === failureSide)) throw new Error('synthetic draw failure');
    },
  };
  return result;
}
function sceneFixture() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), root = new THREE.Group();
  scene.background = new THREE.Color('#123456'); scene.add(root);
  const source = new THREE.MeshStandardMaterial({ depthWrite: true, stencilWrite: true, stencilRef: 9 });
  source.stencilFunc = THREE.NotEqualStencilFunc; source.stencilZPass = THREE.ReplaceStencilOp;
  source.userData.__unityColorWriteMask = 7;
  const noDepth = new THREE.MeshStandardMaterial({ depthWrite: false, depthTest: false, stencilWrite: true, stencilRef: 4 });
  const outline = new THREE.MeshStandardMaterial({ depthWrite: true, side: THREE.BackSide, stencilWrite: true, stencilRef: 3 });
  outline.userData.__parameterizedPassId = 'Outline';
  const baseMesh = new THREE.Mesh(geometry(), [source, noDepth]); baseMesh.name = 'source';
  const passMesh = new THREE.Mesh(geometry(), outline); passMesh.name = 'outline'; passMesh.userData.__parameterizedPassObject = true;
  const hiddenMesh = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial()); hiddenMesh.name = 'hidden'; hiddenMesh.visible = false;
  root.add(baseMesh, passMesh, hiddenMesh);
  baseMesh.layers.mask = 3; passMesh.layers.mask = 5;
  const outsideMaterial = new THREE.MeshStandardMaterial({ depthWrite: true, stencilWrite: true, stencilRef: 13 });
  outsideMaterial.stencilWriteMask = 0x3f;
  outsideMaterial.userData.__unityColorWriteMask = 3;
  const outside = new THREE.Mesh(geometry(), outsideMaterial); outside.name = 'outside'; scene.add(outside);
  return { scene, camera, root, source, noDepth, outline, baseMesh, passMesh, hiddenMesh, outside };
}

test('arm regions follow lower arm, hand and finger ancestry while retaining separate upper-arm weights', () => {
  const { bones, named } = rig(), index = name => bones.indexOf(named[name]);
  const mesh = skinned(geometry(), bones, [
    [[index('Chest'), .1], [index('LeftUpperArm'), .2], [index('LeftLowerArm'), .3], [index('LeftIndexDistal'), .4]],
    [[index('RightUpperArm'), .1], [index('RightLowerArm'), .2], [index('RightHand'), .3], [index('Chest'), .4]],
    [[index('LeftShoulder'), .5], [index('Chest'), .5]],
  ]);
  const weights = armRegionWeights(mesh), expected = [.7, 0, .2, 0, 0, .5, 0, .1, 0, 0, 0, 0];
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(weights[i] - expected[i]) < 1e-7, `component ${i}`);
  const accessory = new THREE.Mesh(geometry(1), new THREE.MeshStandardMaterial()); named.RightIndexDistal.add(accessory);
  assert.deepEqual(Array.from(armRegionWeights(accessory)), [0, 1, 0, 0]);
});

test('CHANGE uses the observed Float32 neighbor boundary independently on both arms', () => {
  assert.equal(armDrawsInFront(), true);
  assert.equal(armDrawsInFront(0), true); assert.equal(armDrawsInFront(1), false);
  assert.equal(armDrawsInFront(FRONT_NEIGHBOR), true); assert.equal(armDrawsInFront(BACK), false);
  const midpoint = (FRONT_NEIGHBOR + BACK) / 2;
  assert.equal(armDrawsInFront(midpoint - 1e-10), true);
  assert.equal(armDrawsInFront(midpoint + 1e-10), false);
  const adaptation = new ParameterArmRenderer(new THREE.Group());
  adaptation.setParameters({ PARAM_ARM_L_CHANGE: FRONT_NEIGHBOR, PARAM_ARM_R_CHANGE: BACK });
  assert.deepEqual(adaptation.front.value.toArray(), [1, 0]);
  adaptation.setParameters({ PARAM_ARM_L_CHANGE: BACK, PARAM_ARM_R_CHANGE: FRONT_NEIGHBOR });
  assert.deepEqual(adaptation.front.value.toArray(), [0, 1]);
  adaptation.setParameters({}); assert.deepEqual(adaptation.front.value.toArray(), [1, 1]); adaptation.dispose();
});

test('material identity, defines, live uniforms and existing compile/key contexts survive decoration', () => {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial(), mesh = new THREE.Mesh(geometry(), material);
  root.add(mesh); const defines = material.defines = { STANDARD: '', LLAS_CHEEK_ON: 1, LLAS_MATCAP_ON: 1 };
  const live = { value: .25 }, runtime = { material }, userData = material.userData;
  userData.__parameterizedShaderRuntimes = [runtime]; let calls = 0;
  const renderer = {};
  const originalCompile = material.onBeforeCompile = function(program, receivedRenderer) {
    assert.equal(this, material); assert.equal(receivedRenderer, renderer); calls++;
    program.uniforms.sourceLive = live; program.fragmentShader = '// original fragment\n' + program.fragmentShader;
  };
  const originalKey = material.customProgramCacheKey = function() { assert.equal(this, material); return 'source:flags'; };
  const adaptation = new ParameterArmRenderer(root), program = shader(); material.onBeforeCompile(program, renderer);
  assert.equal(mesh.material, material); assert.equal(material.defines, defines); assert.equal(material.userData, userData);
  assert.equal(runtime.material, material); assert.equal(program.uniforms.sourceLive, live); assert.equal(calls, 1);
  live.value = .75; assert.equal(program.uniforms.sourceLive.value, .75);
  assert.equal(program.uniforms.uGarupaArmLayer, adaptation.layer); assert.equal(program.uniforms.uGarupaArmFront, adaptation.front);
  assert.equal(program.uniforms.uGarupaArmSide, adaptation.side);
  assert.match(program.fragmentShader, /original fragment/); assert.match(program.vertexShader, /garupaArmRegions/);
  assert.equal(material.customProgramCacheKey(), 'source:flags:garupa-arm-regions');
  adaptation.dispose(); assert.equal(material.onBeforeCompile, originalCompile); assert.equal(material.customProgramCacheKey, originalKey);
});

test('base and parameterized material switching uses already decorated original materials', () => {
  const root = new THREE.Group(), base = new THREE.MeshStandardMaterial(), parameterized = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geometry(), parameterized); root.add(mesh);
  mesh.userData.__baseMaterials = base; mesh.userData.__parameterizedMaterials = parameterized;
  const adaptation = new ParameterArmRenderer(root);
  for (const enabled of [false, true, false]) {
    setParameterizedRenderingEnabled(root, enabled);
    assert.equal(mesh.material, enabled ? parameterized : base);
    const program = shader(); mesh.material.onBeforeCompile(program, {});
    assert.equal(program.uniforms.uGarupaArmLayer, adaptation.layer);
    assert.match(program.fragmentShader, /uGarupaArmFront/);
  }
  adaptation.dispose();
});

test('default Three program keys keep distinct existing compile hooks in separate GPU programs', () => {
  const root = new THREE.Group(), first = new THREE.MeshStandardMaterial(), second = new THREE.MeshStandardMaterial();
  first.onBeforeCompile = function(program) { program.fragmentShader = '#define SOURCE_FEATURE 1\n' + program.fragmentShader; };
  second.onBeforeCompile = function(program) { program.fragmentShader = '#define SOURCE_FEATURE 2\n' + program.fragmentShader; };
  const originalFirst = first.customProgramCacheKey(), originalSecond = second.customProgramCacheKey();
  assert.notEqual(originalFirst, originalSecond);
  root.add(new THREE.Mesh(geometry(), first), new THREE.Mesh(geometry(), second));
  const adaptation = new ParameterArmRenderer(root);
  try {
    assert.notEqual(first.customProgramCacheKey(), second.customProgramCacheKey(), 'wrapping must not merge distinct original shader programs');
    const firstShader = shader(), secondShader = shader();
    first.onBeforeCompile(firstShader, {}); second.onBeforeCompile(secondShader, {});
    assert.match(firstShader.fragmentShader, /SOURCE_FEATURE 1/); assert.match(secondShader.fragmentShader, /SOURCE_FEATURE 2/);
  } finally { adaptation.dispose(); }
});

test('different bone-role variants retain live physics attributes, index and morph buffers', () => {
  const root = new THREE.Group(), original = geometry(), previous = new THREE.BufferAttribute(new Float32Array(12).fill(.125), 4);
  original.setAttribute(ATTRIBUTE, previous);
  const left = skinned(original, [bone('LeftLowerArm')], [[[0, 1]], [[0, 1]], [[0, 1]]]);
  const right = new THREE.SkinnedMesh(original, new THREE.MeshStandardMaterial()); right.skeleton = new THREE.Skeleton([bone('RightLowerArm')]);
  root.add(left, right); let originalDisposals = 0; original.addEventListener('dispose', () => originalDisposals++);
  const adaptation = new ParameterArmRenderer(root), variant = right.geometry;
  assert.equal(left.geometry, original); assert.notEqual(variant, original);
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) assert.equal(variant.attributes[name], original.attributes[name]);
  assert.equal(variant.index, original.index); assert.equal(variant.morphAttributes, original.morphAttributes);
  assert.equal(variant.morphTargetsRelative, true);
  assert.deepEqual(Array.from(left.geometry.getAttribute(ATTRIBUTE).array.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(variant.getAttribute(ATTRIBUTE).array.slice(0, 4)), [0, 1, 0, 0]);
  // Simulate a Cloth runtime retaining and mutating the original buffers.
  original.attributes.position.setXYZ(0, 7, 8, 9); original.attributes.normal.setXYZ(0, .1, .2, .3);
  original.morphAttributes.position[0].setX(0, .75); original.index.setX(0, 2);
  assert.equal(variant.attributes.position.getX(0), 7); assert.equal(variant.attributes.normal.getZ(0), Math.fround(.3));
  assert.equal(variant.morphAttributes.position[0].getX(0), .75); assert.equal(variant.index.getX(0), 2);
  let variantDisposals = 0; variant.addEventListener('dispose', () => variantDisposals++);
  adaptation.dispose(); adaptation.dispose();
  assert.equal(left.geometry, original); assert.equal(right.geometry, original); assert.equal(original.getAttribute(ATTRIBUTE), previous);
  assert.equal(originalDisposals, 0); assert.equal(variantDisposals, 1);
});

test('layer rendering preserves every regular pass and stencil, with source-only rear and upper depth passes', () => {
  const f = sceneFixture(), adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation);
  adaptation.setParameters({ PARAM_ARM_L_CHANGE: 0, PARAM_ARM_R_CHANGE: 1 });
  const states = [f.source, f.noDepth, f.outline].map(materialState), background = f.scene.background;
  const outsideState = materialState(f.outside.material);
  adaptation.drawScene(renderer, f.scene, f.camera);
  assert.deepEqual(renderer.frames.map(frame => frame.layer), [1, 5, 2, 4, 3]);
  assert.deepEqual(renderer.clears, [[false, true, false], [false, true, false]]);
  // The depth written for the rear elbow must survive until the body draw.
  assert.deepEqual(renderer.events, [
    ['render', 1], ['clear', false, true, false], ['render', 5], ['render', 2],
    ['clear', false, true, false], ['render', 4], ['render', 3],
  ]);
  for (const frame of renderer.frames.filter(frame => [1, 2, 3].includes(frame.layer))) {
    for (const material of [f.source, f.noDepth, f.outline]) {
      const draw = frame.draws.find(item => item.material === material); assert.ok(draw, `pass at layer ${frame.layer}`);
      assert.deepEqual(draw.state, states[[f.source, f.noDepth, f.outline].indexOf(material)]);
    }
    assert.equal(frame.draws.some(item => item.object === f.hiddenMesh), false);
    assert.equal(frame.draws.some(item => item.object === f.outside), frame.layer === 1);
  }
  for (const layer of [5, 4]) {
    const depth = renderer.frames.find(frame => frame.layer === layer);
    assert.deepEqual(depth.draws.map(draw => draw.material), [f.source, f.outside.material], `only character and outside depth-writing sources at layer ${layer}`);
    assert.equal(depth.draws[0].object, f.baseMesh);
    assert.deepEqual(depth.draws[0].state, { ...states[0], colorWrite: false, colorMask: 0 });
    assert.equal(depth.draws[1].object, f.outside);
    assert.deepEqual(depth.draws[1].state, { ...outsideState, colorWrite: false, colorMask: 0, stencilWriteMask: 0 });
    assert.equal(depth.draws.some(draw => draw.object === f.passMesh), false);
  }
  assert.equal(f.scene.background, background); assert.equal(renderer.autoClear, true); assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.deepEqual([f.source, f.noDepth, f.outline].map(materialState), states);
  assert.deepEqual(materialState(f.outside.material), outsideState);
  assert.equal(f.baseMesh.layers.mask, 3); assert.equal(f.passMesh.layers.mask, 5); assert.equal(adaptation.layer.value, 0);
  adaptation.dispose();
});

test('an external drawable ancestor does not hide character descendants when its own layer is excluded', () => {
  const f = sceneFixture(); f.scene.remove(f.root); f.outside.add(f.root);
  const adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation);
  adaptation.setParameters({ PARAM_ARM_L_CHANGE: 0, PARAM_ARM_R_CHANGE: 1 });
  adaptation.drawScene(renderer, f.scene, f.camera);
  for (const frame of renderer.frames) assert.ok(frame.draws.some(draw => draw.object === f.baseMesh), `nested source at layer ${frame.layer}`);
  assert.equal(f.outside.visible, true); assert.equal(f.root.visible, true); assert.equal(f.outside.layers.mask, 1);
  adaptation.dispose();
});

test('all draw failure stages restore scene, masks and temporary source material state', () => {
  for (const failureLayer of [1, 5, 2, 4, 3]) {
    const f = sceneFixture(), adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation, failureLayer);
    adaptation.setParameters({ PARAM_ARM_L_CHANGE: 0, PARAM_ARM_R_CHANGE: 1 });
    const background = f.scene.background, states = [f.source, f.noDepth, f.outline].map(materialState);
    const outsideState = materialState(f.outside.material);
    renderer.autoClear = false; renderer.shadowMap.autoUpdate = false;
    assert.throws(() => adaptation.drawScene(renderer, f.scene, f.camera), /synthetic draw failure/);
    assert.equal(f.scene.background, background); assert.equal(renderer.autoClear, false); assert.equal(renderer.shadowMap.autoUpdate, false);
    assert.equal(f.baseMesh.layers.mask, 3); assert.equal(f.passMesh.layers.mask, 5); assert.equal(f.outside.layers.mask, 1);
    assert.deepEqual([f.source, f.noDepth, f.outline].map(materialState), states); assert.equal(adaptation.layer.value, 0);
    assert.deepEqual(materialState(f.outside.material), outsideState);
    assert.equal(Object.hasOwn(f.noDepth.userData, '__unityColorWriteMask'), false);
    adaptation.dispose(); adaptation.dispose();
  }
});

test('outside color draws once while later depth passes preserve occlusion without color or stencil writes', () => {
  for (const [left, right] of [[0, 0], [1, 1], [0, 1]]) {
    const f = sceneFixture();
    const noDepth = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial({ depthWrite: false, stencilWrite: true }));
    const outline = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial({ depthWrite: true, side: THREE.BackSide }));
    outline.userData.__parameterizedPassObject = true;
    f.scene.add(noDepth, outline);
    const objects = [f.outside, noDepth, outline], states = objects.map(object => materialState(object.material));
    const adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation);
    adaptation.setParameters({ PARAM_ARM_L_CHANGE: left, PARAM_ARM_R_CHANGE: right });
    adaptation.drawScene(renderer, f.scene, f.camera);
    const first = renderer.frames[0];
    for (let i = 0; i < objects.length; i++) {
      const colorDraws = renderer.frames.flatMap(frame => frame.draws.filter(draw => draw.object === objects[i] && draw.state.colorWrite));
      assert.equal(colorDraws.length, 1, 'surrounding geometry must not paint over a previously drawn rear arm');
      assert.deepEqual(colorDraws[0].state, states[i]);
      assert.ok(first.draws.some(draw => draw.object === objects[i]));
    }
    for (const frame of renderer.frames.slice(1)) {
      const outsideDraws = frame.draws.filter(draw => objects.includes(draw.object));
      if (frame.layer === 4 || frame.layer === 5 || frame.layer === 6) {
        assert.deepEqual(outsideDraws.map(draw => draw.object), [f.outside, outline]);
        assert.deepEqual(outsideDraws[0].state, { ...states[0], colorWrite: false, colorMask: 0, stencilWriteMask: 0 });
        assert.deepEqual(outsideDraws[1].state, { ...states[2], colorWrite: false, hasColorMask: true, colorMask: 0, stencilWriteMask: 0 });
      } else assert.deepEqual(outsideDraws, []);
    }
    assert.deepEqual(objects.map(object => materialState(object.material)), states);
    assert.ok(objects.every(object => object.layers.mask === 1));
    adaptation.dispose();
  }
});

test('empty front or back layers are skipped without changing first-layer clearing and background', () => {
  for (const [change, expectedLayers, expectedClears] of [[0, [2, 4, 3, 4, 3], 2], [1, [1, 6, 1, 5, 2], 2]]) {
    const f = sceneFixture(), adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation);
    adaptation.setParameters({ PARAM_ARM_L_CHANGE: change, PARAM_ARM_R_CHANGE: change });
    const background = f.scene.background;
    adaptation.drawScene(renderer, f.scene, f.camera);
    assert.deepEqual(renderer.frames.map(frame => frame.layer), expectedLayers);
    assert.equal(renderer.clears.length, expectedClears);
    assert.ok(renderer.clears.every(args => args[0] === false && args[1] === true && args[2] === false));
    assert.equal(renderer.frames[0].background, background); assert.equal(renderer.frames[0].autoClear, true);
    for (const frame of renderer.frames.slice(1)) { assert.equal(frame.background, null); assert.equal(frame.autoClear, false); }
    assert.equal(f.scene.background, background); assert.equal(renderer.autoClear, true);
    assert.equal(renderer.shadowMap.autoUpdate, true); adaptation.dispose();
  }
});

test('hand order follows measured integer buckets with left last at equal order', () => {
  for (const [change, order] of [[-1, 700], [0, 700], [.00009, 700], [.00011, 699], [.4, 557], [.4001, 557], [.5, 522], [1, 345], [2, 345]]) {
    assert.equal(armDrawOrder(change), order, `CHANGE ${change}`);
  }
  for (const [left, right, sides] of [[0, 0, [1, 0]], [.4, 0, [0, 1]], [.4001, .4, [1, 0]], [.9, .95, [1, 0]], [.95, .9, [0, 1]]]) {
    const f = sceneFixture(), adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation);
    adaptation.setParameters({ PARAM_ARM_L_CHANGE: left, PARAM_ARM_R_CHANGE: right });
    adaptation.drawScene(renderer, f.scene, f.camera);
    const arms = renderer.frames.filter(frame => frame.layer === 1 || frame.layer === 3);
    assert.deepEqual(arms.map(frame => frame.side), sides);
    assert.equal(adaptation.side.value, -1);
    adaptation.dispose();
  }
});

test('second-arm color and scene-depth failures restore masks, side and material state', () => {
  for (const [change, layer] of [[0, 3], [1, 6], [1, 1]]) {
    const f = sceneFixture(), adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation, layer, 0);
    const states = [f.source, f.noDepth, f.outline, f.outside.material].map(materialState);
    const background = f.scene.background;
    adaptation.setParameters({ PARAM_ARM_L_CHANGE: change, PARAM_ARM_R_CHANGE: change });
    assert.throws(() => adaptation.drawScene(renderer, f.scene, f.camera), /synthetic draw failure/);
    assert.deepEqual([f.source, f.noDepth, f.outline, f.outside.material].map(materialState), states);
    assert.equal(adaptation.layer.value, 0); assert.equal(adaptation.side.value, -1);
    assert.equal(f.baseMesh.layers.mask, 3); assert.equal(f.passMesh.layers.mask, 5); assert.equal(f.outside.layers.mask, 1);
    assert.equal(f.scene.background, background); assert.equal(renderer.autoClear, true); assert.equal(renderer.shadowMap.autoUpdate, true);
    adaptation.dispose();
  }
});

test('constructor failure unwinds earlier attributes and material hooks without disposing source geometry', () => {
  const root = new THREE.Group(), good = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial());
  const originalCompile = good.material.onBeforeCompile, originalKey = good.material.customProgramCacheKey;
  const badMaterial = new THREE.MeshStandardMaterial();
  Object.defineProperty(badMaterial, 'onBeforeCompile', { configurable: true, get() { throw Error('synthetic decoration failure'); } });
  const bad = new THREE.Mesh(geometry(), badMaterial); root.add(good, bad);
  assert.throws(() => new ParameterArmRenderer(root), /synthetic decoration failure/);
  assert.equal(good.material.onBeforeCompile, originalCompile); assert.equal(good.material.customProgramCacheKey, originalKey);
  assert.equal(good.geometry.getAttribute(ATTRIBUTE), undefined); assert.equal(bad.geometry.getAttribute(ATTRIBUTE), undefined);
});

test('dispose preserves a later hook wrapper and makes the captured arm hook inert', () => {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial(); root.add(new THREE.Mesh(geometry(), material));
  material.customProgramCacheKey = () => 'original-key';
  const adaptation = new ParameterArmRenderer(root), decoratedCompile = material.onBeforeCompile, decoratedKey = material.customProgramCacheKey;
  const laterCompile = material.onBeforeCompile = (...args) => decoratedCompile(...args);
  const laterKey = material.customProgramCacheKey = () => decoratedKey() + ':later';
  adaptation.dispose(); adaptation.dispose();
  assert.equal(material.onBeforeCompile, laterCompile); assert.equal(material.customProgramCacheKey, laterKey);
  const program = shader(); material.onBeforeCompile(program, {});
  assert.equal(program.uniforms.uGarupaArmLayer, undefined); assert.doesNotMatch(program.fragmentShader, /vGarupaArmRegions/);
  assert.equal(material.customProgramCacheKey(), 'original-key:later');
});

test('dispose leaves a geometry restored by a later face workspace attached and alive', () => {
  const root = new THREE.Group(), original = geometry(), workspaceGeometry = geometry();
  workspaceGeometry.attributes.position.setX(0, .75);
  const material = new THREE.MeshStandardMaterial(), face = new THREE.Mesh(original, material); root.add(face);
  let originalDisposals = 0, workspaceDisposals = 0;
  original.addEventListener('dispose', () => originalDisposals++);
  workspaceGeometry.addEventListener('dispose', () => workspaceDisposals++);
  const adaptation = new ParameterArmRenderer(root);
  assert.ok(original.getAttribute(ATTRIBUTE));
  // An expression workspace can restore a mesh created before arm decoration.
  face.geometry = workspaceGeometry;
  assert.equal(face.geometry.getAttribute(ATTRIBUTE), undefined);
  assert.deepEqual(material.defaultAttributeValues[ATTRIBUTE], [0, 0, 0, 0]);
  adaptation.dispose(); adaptation.dispose();
  assert.equal(face.geometry, workspaceGeometry);
  assert.equal(face.geometry.attributes.position.getX(0), .75);
  assert.equal(original.getAttribute(ATTRIBUTE), undefined);
  assert.equal(workspaceGeometry.getAttribute(ATTRIBUTE), undefined);
  assert.equal(originalDisposals, 0); assert.equal(workspaceDisposals, 0);
});

test('zero vec4 defaults preserve existing attribute values and restore prior property ownership', () => {
  const root = new THREE.Group(), existing = new THREE.MeshStandardMaterial(), absent = new THREE.MeshStandardMaterial();
  const color = [1, .5, .25], priorArm = [.1, .2, .3, .4], defaults = { color, [ATTRIBUTE]: priorArm };
  existing.defaultAttributeValues = defaults;
  assert.equal(Object.hasOwn(absent, 'defaultAttributeValues'), false);
  root.add(new THREE.Mesh(geometry(), existing), new THREE.Mesh(geometry(), absent));
  const adaptation = new ParameterArmRenderer(root);
  assert.notEqual(existing.defaultAttributeValues, defaults);
  assert.equal(existing.defaultAttributeValues.color, color);
  assert.deepEqual(existing.defaultAttributeValues[ATTRIBUTE], [0, 0, 0, 0]);
  assert.deepEqual(absent.defaultAttributeValues[ATTRIBUTE], [0, 0, 0, 0]);
  assert.equal(defaults[ATTRIBUTE], priorArm); assert.deepEqual(priorArm, [.1, .2, .3, .4]);
  // Existing live default arrays remain shared while the arm fallback is active.
  color[1] = .75; assert.equal(existing.defaultAttributeValues.color[1], .75);
  adaptation.dispose(); adaptation.dispose();
  assert.equal(existing.defaultAttributeValues, defaults);
  assert.equal(existing.defaultAttributeValues[ATTRIBUTE], priorArm);
  assert.equal(existing.defaultAttributeValues.color, color);
  assert.equal(Object.hasOwn(absent, 'defaultAttributeValues'), false);
});

test('override-material and disposed drawing fall through to one untouched renderer call', () => {
  const f = sceneFixture(), adaptation = new ParameterArmRenderer(f.root), renderer = mockRenderer(adaptation), background = f.scene.background;
  f.scene.overrideMaterial = new THREE.MeshBasicMaterial(); adaptation.drawScene(renderer, f.scene, f.camera);
  assert.equal(renderer.frames.length, 1); assert.deepEqual(renderer.clears, []); assert.equal(f.scene.background, background);
  f.scene.overrideMaterial = null; adaptation.dispose(); renderer.frames.length = 0;
  adaptation.drawScene(renderer, f.scene, f.camera);
  assert.equal(renderer.frames.length, 1); assert.deepEqual(renderer.clears, []); assert.equal(f.scene.background, background);
});

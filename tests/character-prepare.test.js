import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CharacterRenderer } from '../src/character-renderer.js';
import { ModelPhysics } from '../src/model-physics.js';
import { OffscreenCharacter } from '../src/offscreen-character.js';
import { HostBlink } from '../src/host-blink.js';

function offscreenFixture({ character, ...options }) {
  return Object.assign(Object.create(OffscreenCharacter.prototype), {
    disposed: false, scene: {}, camera: {}, mouth: null, blink: new HostBlink({}, () => .5),
    character: { setBlink() {}, setSpeech() {}, ...character }, ...options,
  });
}

function fixture() {
  const scene = new THREE.Scene(), root = new THREE.Group(), hair = new THREE.Object3D();
  root.add(hair); scene.add(root);
  const character = new CharacterRenderer({ renderer: {}, scene, camera: new THREE.PerspectiveCamera() });
  character.root = root;
  character.config = { humanoidScale: 1 };
  character.physics = new ModelPhysics(root, [{ physics: { colliders: [], springs: [{
    node: 0, tail: [0, -.5, 0], radius: .01, stiffness: 1.5,
    damping: .8, gravity: [0, 0, 0], colliders: [],
  }] }, resolve: () => hair }]);
  const steps = [], expression = { time: 0, count: 0 };
  character.externalExpressionDriver = { beginFrame() {}, update(delta) { expression.time += delta; expression.count++; } };
  character.behaviors = { beforeMotion(delta) { steps.push(delta); }, afterMotion() {}, afterPhysics() {}, setMotion() {}, destroy() {} };
  return { character, steps, expression };
}

test('zero-time prepare evaluates expressions on a settled fixed-step actor', () => {
  const { character, steps, expression } = fixture();
  character.update(0); steps.length = 0; expression.count = 0;
  assert.equal(character.physics.needsReset, false);
  character.prepareFrame();
  assert.deepEqual(steps, [0]); assert.equal(expression.count, 1);
  assert.equal(expression.time, 0); assert.equal(character.elapsedTime, 0);
  assert.equal(character.physics.frameAccumulator, 0);
  character.prepareFrame();
  assert.equal(expression.count, 2); assert.equal(expression.time, 0);
  character.dispose();
});

test('pending motion commits and settles before preparation returns without advancing time', () => {
  const { character, steps, expression } = fixture();
  character.update(0); steps.length = 0;
  let resetCount = 0;
  const reset = character.physics.reset.bind(character.physics);
  character.physics.reset = (...args) => { resetCount++; return reset(...args); };
  character.pendingMotion = { generation: character.motionGeneration };
  character.prepareFrame();
  assert.equal(character.pendingMotion, null);
  assert.equal(resetCount, 1);
  assert.equal(character.physics.needsReset, false);
  assert.deepEqual(steps, [0]); assert.equal(character.elapsedTime, 0); assert.equal(expression.time, 0);
  character.prepareFrame(); assert.equal(resetCount, 1);
  character.dispose();
});

test('prepare preserves subframe time even when physics is disabled or has no springs', () => {
  for (const mode of ['enabled', 'disabled', 'empty']) {
    const { character, expression } = fixture();
    if (mode === 'disabled') character.physics.setEnabled(false);
    if (mode === 'empty') {
      character.physics.destroy();
      character.physics = new ModelPhysics(character.root, []);
    }
    character.physics.frameAccumulator = .012;
    character.elapsedTime = 3;
    expression.time = 2;
    character.prepareFrame();
    assert.equal(character.elapsedTime, 3, mode);
    assert.equal(expression.time, 2, mode);
    assert.equal(character.physics.frameAccumulator, .012, mode);
    character.dispose();
  }
});

test('render resources are realized before asynchronous compilation and actual runtime drawing', async () => {
  const events = [];
  const actor = offscreenFixture({
    character: { prepareFrame() { events.push('state-and-variants'); }, render() { events.push('runtime-render'); } },
    renderer: { async compileAsync() { events.push('compile'); } } });
  await OffscreenCharacter.prototype.prepare.call(actor);
  assert.deepEqual(events, ['state-and-variants', 'compile', 'runtime-render']);
});

test('prepare applies current host mouth and closed eyes before its first frame without ticking blink', async () => {
  for (const mouth of [.8, null]) {
    const inputs = {};
    const actor = offscreenFixture({ mouth, character: {
      parameterPlayer: {},
      setBlink(value) { inputs.blink = value; },
      setSpeech(value) { inputs.speech = value; },
      setParameterBlink(value) { inputs.parameterBlink = value; },
      setParameterSpeech(value) { inputs.parameterSpeech = value; },
      prepareFrame() {
        assert.deepEqual(inputs, { blink: 1, speech: mouth ?? 0, parameterBlink: 1, parameterSpeech: mouth });
      },
      render() {},
    }, renderer: { async compileAsync() {} } });
    actor.blink.eyeState = 'Closed';
    actor.blink.eyeParamValue = 0;
    // Even update(0) would advance this state boundary to Opening.
    actor.blink.closedTimer = actor.blink.closedDuration;
    const before = { ...actor.blink };
    await actor.prepare();
    await actor.prepare();
    assert.deepEqual({ ...actor.blink }, before);
  }
});

test('normal updates advance the blink clock once and apply the resulting host inputs', () => {
  const actor = offscreenFixture({ mouth: .6, character: {
    setBlink(value) { assert.equal(value, .25); },
    setSpeech(value) { assert.equal(value, .6); },
    update(delta) { assert.equal(delta, .025); },
    render() {},
  } });
  actor.blink.eyeState = 'Closing';
  actor.update(.025);
  assert.equal(actor.blink.eyeParamValue, .75);
});

test('parameter pose preparation retains normal materials and draws after shader runtime passes', () => {
  const draws = [];
  const character = new CharacterRenderer({ renderer: { render(scene, camera) {
    assert.equal(scene, character.scene); assert.equal(camera, character.camera); draws.push('draw');
  } }, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
  character.root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
  character.root.add(mesh);
  let parameterTime = 2;
  character.parameterPlayer = { parameters: {}, update(delta) { parameterTime += delta; }, dispose() {} };
  character.parameterBody = { applyParameters() {}, restore() {} };
  const geometry = mesh.geometry, material = mesh.material;
  const key = material.customProgramCacheKey(), version = material.version;
  character.prepareFrame();
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(material.customProgramCacheKey(), key);
  assert.equal(parameterTime, 2);
  character.prepareFrame();
  assert.equal(mesh.material.version, version);
  character.shaderScope = { tick(scene, camera) {
    assert.equal(scene, character.scene); assert.equal(camera, character.camera); draws.push('runtime');
  }, dispose() {} };
  character.render();
  assert.deepEqual(draws, ['runtime', 'draw']);
  character.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
});

test('an actor disposed during compile cannot render into its released context', async () => {
  let finish;
  const actor = offscreenFixture({ character: {
    prepareFrame() {}, render() { assert.fail('disposed actor rendered'); },
  }, renderer: { compileAsync: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = OffscreenCharacter.prototype.prepare.call(actor);
  actor.disposed = true; finish(); await pending;
});

test('lost GPU contexts reject preparation before compile, after compile, or after drawing', async () => {
  for (const phase of ['initial', 'compile', 'render']) {
    let lost = phase === 'initial', compiled = false, rendered = false;
    const actor = offscreenFixture({ character: {
      prepareFrame() {}, render() { rendered = true; if (phase === 'render') lost = true; },
    }, renderer: {
      getContext: () => ({ isContextLost: () => lost }),
      async compileAsync() { compiled = true; if (phase === 'compile') lost = true; },
    } });
    await assert.rejects(actor.prepare(), /WebGL context is lost/);
    assert.equal(compiled, phase !== 'initial');
    assert.equal(rendered, phase === 'render');
  }
});

test('GPU disposal and context release still run if actor or renderer cleanup throws', () => {
  const events = [];
  const actor = { disposed: false, character: { dispose() { events.push('character'); throw new Error('character'); } },
    renderer: { dispose() { events.push('renderer'); throw new Error('renderer'); }, forceContextLoss() { events.push('context'); } } };
  assert.throws(() => OffscreenCharacter.prototype.dispose.call(actor), /renderer/);
  assert.deepEqual(events, ['character', 'renderer', 'context']);
  OffscreenCharacter.prototype.dispose.call(actor);
  assert.equal(events.length, 3);
});

test('warm identity separates initial playback state and ignores demand identity', () => {
  const options = { modelUrl: 'https://example.test/model/config.json', indexUrl: 'https://example.test/resources.json' };
  assert.notEqual(OffscreenCharacter.warmKey(options), OffscreenCharacter.warmKey({ ...options, motion: 'wave' }));
  assert.notEqual(OffscreenCharacter.warmKey(options), OffscreenCharacter.warmKey({ ...options, expression: 'smile' }));
  assert.equal(OffscreenCharacter.warmKey(options), OffscreenCharacter.warmKey({ ...options, motion: '', expression: '', preloadId: 'other' }));
});


test('warm identity separates mesh cloth construction and normalizes the default', () => {
  const options = { modelUrl: 'https://example.test/model/config.json', indexUrl: 'https://example.test/resources.json' };
  assert.equal(OffscreenCharacter.warmKey(options), OffscreenCharacter.warmKey({ ...options, meshClothEnabled: true }));
  assert.notEqual(OffscreenCharacter.warmKey(options), OffscreenCharacter.warmKey({ ...options, meshClothEnabled: false }));
  for (const value of [null, 0, 1, 'false']) {
    assert.throws(() => OffscreenCharacter.warmKey({ ...options, meshClothEnabled: value }), /meshClothEnabled must be boolean/);
    assert.throws(() => new CharacterRenderer({ meshClothEnabled: value }), /meshClothEnabled must be boolean/);
  }
});

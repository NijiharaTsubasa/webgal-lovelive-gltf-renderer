import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CharacterFocus } from '../src/character-focus.js';
import { CharacterRenderer } from '../src/character-renderer.js';
import { ExpressionAdapterRegistry } from '../src/garupa/manifest.js';

function skeleton() {
  const root = new THREE.Group(); let parent = root;
  for (const name of ['Chest', 'Neck', 'Head']) {
    const node = new THREE.Bone(); node.name = name; parent.add(node); parent = node;
  }
  return root;
}

test('anatomical joint axes do not turn model yaw into roll, including transformed roots', () => {
  const root = skeleton();
  root.quaternion.setFromEuler(new THREE.Euler(.15, -.4, .08));
  const chest = root.getObjectByName('Chest');
  // Both delivered game rigs use X=-modelY, Y=-modelZ, Z=modelX.
  chest.quaternion.set(-.5, .5, -.5, .5);
  const head = root.getObjectByName('Head');
  root.updateMatrixWorld(true);
  const inverse = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  const binding = head.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverse);
  const focus = new CharacterFocus(); focus.bind(root);
  focus.set({ x: 1, y: 0, instant: true }); focus.apply();
  const deformation = head.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverse).multiply(binding.clone().invert());
  const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(-.31), THREE.MathUtils.degToRad(21.415), 0, 'YXZ'));
  assert.ok(deformation.angleTo(expected) < 1e-7);
  focus.restore(); focus.set({ x: 0, y: 1, instant: true }); focus.apply();
  const up = head.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverse).multiply(binding.clone().invert());
  assert.ok(up.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(-9.725), THREE.MathUtils.degToRad(-.025), 0, 'YXZ'))) < 1e-7);
  focus.restore();
  assert.ok(head.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverse).angleTo(binding) < 1e-7);
});

test('focus clamps inputs, changes continuously, reverses and releases without accumulating', () => {
  const root = skeleton(), focus = new CharacterFocus(); focus.bind(root);
  focus.set({ x: 5, y: -5, instant: true });
  assert.equal(focus.x, 1); assert.equal(focus.y, -1);
  focus.apply(); const expected = root.getObjectByName('Head').quaternion.clone();
  for (let i = 0; i < 100; i++) { focus.restore(); focus.apply(); }
  assert.ok(expected.angleTo(root.getObjectByName('Head').quaternion) < 1e-7);
  focus.set({ x: -1, y: 1 }); focus.update(.01);
  assert.ok(focus.x < 1 && focus.x > -1);
  focus.set({ x: 0, y: 0 }); for (let i = 0; i < 100; i++) focus.update(.1);
  focus.restore(); focus.apply();
  assert.ok(root.getObjectByName('Head').quaternion.angleTo(new THREE.Quaternion()) < 1e-7);
});

test('focus preserves strong authored head rotation and optional neck is not required', () => {
  const root = skeleton(), focus = new CharacterFocus(); focus.bind(root);
  const head = root.getObjectByName('Head');
  head.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
  const authored = head.quaternion.clone(); focus.set({ x: 1, instant: true }); focus.apply();
  assert.ok(head.getWorldQuaternion(new THREE.Quaternion()).angleTo(authored) < .01);
  focus.restore(); assert.ok(head.quaternion.angleTo(authored) < 1e-7);
});

for (const parameterBody of [false, true]) for (const parameterFace of [false, true]) {
  test(`body/face ownership ${parameterBody}/${parameterFace} applies body Focus once and exactly one gaze`, () => {
    const root = skeleton();
    const character = new CharacterRenderer({ scene: new THREE.Scene(), renderer: {}, camera: {} });
    character.root = root; character.focus.bind(root);
    const head = root.getObjectByName('Head');
    const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, -.15, .05));
    const writeBody = () => head.quaternion.copy(base);
    if (parameterBody) character.parameterBody = { applyParameters(parameters) {
      assert.equal(parameters.PARAM_ANGLE_X, 30 * character.focus.x);
      assert.equal(parameters.PARAM_ANGLE_Y, 30 * character.focus.y);
      assert.ok(Math.abs(parameters.PARAM_ANGLE_Z + 30 * character.focus.x * character.focus.y) < 1e-10);
      assert.equal(parameters.PARAM_BODY_ANGLE_X, 10 * character.focus.x);
      writeBody();
    } };
    else character.motion = { update: writeBody };
    character.parameterPlayer = { update() { this.parameters = { PARAM_EYE_BALL_X: .2, PARAM_EYE_BALL_Y: .3 }; } };
    character.parameterFaceActive = parameterFace;
    let nativeGazes = 0, faceGazes = 0;
    character.focusAdapter = { restore() {}, apply({x,y}) { nativeGazes++; assert.equal(x, .5); assert.equal(y, -.5); } };
    if (parameterFace) character.externalExpressionDriver = { beginFrame() {}, update() {
      faceGazes++; assert.equal(character.parameterPlayer.parameters.PARAM_EYE_BALL_X, .7);
      assert.equal(character.parameterPlayer.parameters.PARAM_EYE_BALL_Y, -.2);
    } };
    character.setFocus({ x: .5, y: -.5, instant: true }); character.update(.016);
    assert.ok(parameterBody ? head.quaternion.angleTo(base) < 1e-7 : head.quaternion.angleTo(base) > .05);
    const expected = head.quaternion.clone(); character.update(.016);
    assert.ok(expected.angleTo(head.quaternion) < 1e-7);
    assert.equal(nativeGazes, parameterFace ? 0 : 2); assert.equal(faceGazes, parameterFace ? 2 : 0);
    character.setFocus({ x: 0, y: 0, instant: true });
    character.focusAdapter = null; character.externalExpressionDriver = null;
    character.parameterFaceActive = false; character.update(.016);
    assert.ok(head.quaternion.angleTo(base) < 1e-7);
  });
}

test('focus adapter export uses the cached expression module and absence remains optional', async () => {
  let imports = 0;
  const expression = () => {}, focus = () => {};
  const registry = new ExpressionAdapterRegistry([{ type: 'garupa-expression-adapter', name: 'fixture',
    basePath: '', component: { script: 'adapter.js', motionGroup: 'fixture' } }], '', async () => {
    imports++; return { createExpressionAdapter: expression, createFocusAdapter: focus };
  });
  assert.equal(await registry.focusFactory('fixture'), focus);
  assert.equal(await registry.factory('fixture'), expression); assert.equal(imports, 1);
  assert.equal(await registry.focusFactory('missing'), null);
});

test('native nonzero gaze releases its geometry before parameter adapter captures its underlay', async () => {
  const character = new CharacterRenderer({ scene: new THREE.Scene(), renderer: {}, camera: {} });
  const root = skeleton(), native = new THREE.BufferGeometry();
  native.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const mesh = new THREE.Mesh(native); root.add(mesh);
  character.root = root; character.focus.bind(root);
  const focusGeometry = native.clone(); focusGeometry.attributes.position.setX(0, 2);
  character.focusAdapter = {
    restore() { mesh.geometry = native; },
    apply() { mesh.geometry = focusGeometry; },
    dispose() { mesh.geometry = native; focusGeometry.dispose(); },
  };
  character.parameterPlayer = { parameters: {}, dispose() {} };
  let captured, parameterGeometry;
  character.parameterAdapters = { async factory() { return () => {
    captured = mesh.geometry;
    parameterGeometry = captured.clone();
    return {
      restore() { mesh.geometry = captured; },
      apply() {
        parameterGeometry.attributes.position.setX(0, captured.attributes.position.getX(0) + 3);
        mesh.geometry = parameterGeometry;
      },
      dispose() { mesh.geometry = captured; parameterGeometry.dispose(); },
    };
  }; } };
  character.setFocus({ x: 1, instant: true }); character.applyFocusEyes();
  assert.equal(mesh.geometry, focusGeometry);
  assert.equal(mesh.geometry.attributes.position.getX(0), 2);
  await character.setParameterFace(true);
  assert.equal(captured, native);
  character.externalExpressionDriver.update(0); character.applyFocusEyes();
  assert.equal(mesh.geometry, parameterGeometry);
  assert.equal(mesh.geometry.attributes.position.getX(0), 3);
  await character.setParameterFace(false);
  assert.equal(mesh.geometry, native);
  character.applyFocusEyes(); assert.equal(mesh.geometry, focusGeometry);
  assert.equal(mesh.geometry.attributes.position.getX(0), 2);
  character.setFocus({ x: 0, instant: true });
  character.focusAdapter.restore(); assert.equal(mesh.geometry, native);
  character.dispose(); assert.equal(mesh.geometry, native);
});

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ExpressionController, registerExpressionNodes } from "../src/expression-controller.js";
import { formatNativeExpression, parseNativeExpression, isNativeExpression } from "../src/native-expression.js";
import { validateExpressionDefinitions } from "../src/model-manifest.js";

function fixture() {
  const root = new THREE.Group();
  const face = new THREE.Object3D();
  root.add(face);
  face.morphTargetDictionary = { eyes: 0, close: 1, smile: 2, a: 3, i: 4 };
  face.morphTargetInfluences = [0, 0, 0, 0, 0];
  registerExpressionNodes({scene: root, parser: {associations: new Map([[face, {nodes: 0, primitives: 0}]]), json: {nodes: [{name: "Face"}]}}});
  const definition = {
    morphPoses: Object.keys(face.morphTargetDictionary).map(name => ({name, targets: {Face: {[name]: 1}}})),
    expressionGroups: [
      {name: "arbitrary-face-name", type: "eye", states: [
        {name: "Open", poses: {eyes: 1}, controls: {blink: {eyes: 0, close: 1}}},
        {name: "Closed", poses: {close: 1}},
      ]},
      {name: "arbitrary-mouth-name", type: "mouth", states: [
        {name: "Smile", poses: {smile: 1}},
        {name: "A", poses: {a: 1}, controls: {visemes: {a: {a: 1}, i: {i: 1}}}},
      ]},
    ],
    defaultExpression: {eye: "Open", closed: "Smile", open: "A"},
  };
  return {controller: new ExpressionController(root, definition), face, definition};
}

test("native expression names round-trip separators, Unicode, percent and absent groups", () => {
  const selected = {eye: "悲しい/眼%", closed: "Smile", open: "口:A"};
  assert.deepEqual(parseNativeExpression(formatNativeExpression(selected)), selected);
  assert.deepEqual(parseNativeExpression("3d:Open//"), {eye: "Open"});
  assert.equal(isNativeExpression("anon/angry01"), false);
  assert.throws(() => parseNativeExpression("3d:eye/mouth"));
  assert.throws(() => parseNativeExpression("3d:%xx//"));
});

test("mouth interpolates complete selected endpoints, independent of eye and group names", () => {
  const {controller: c, face} = fixture();
  c.setBlink(.25); c.setSpeech(.6); c.update();
  assert.deepEqual(face.morphTargetInfluences, [.75, .25, .4, .6, 0]);
  c.setSpeech(0); c.update();
  assert.deepEqual(face.morphTargetInfluences, [.75, .25, 1, 0, 0]);
  c.setSpeech(1); c.update();
  assert.deepEqual(face.morphTargetInfluences, [.75, .25, 0, 1, 0]);
  c.setExpression({eye: "Closed", closed: "A", open: "A"}, 0);
  c.setBlink(.7); c.setSpeech(.3); c.update();
  assert.deepEqual(face.morphTargetInfluences, [0, 1, 0, 1, 0]);
});

test("visemes replace speech and remaining weight belongs to selected closed mouth", () => {
  const {controller: c, face} = fixture();
  c.setSpeech(1); c.setVisemes({a: .4, i: .2}); c.update();
  assert.ok(Math.abs(face.morphTargetInfluences[2] - .4) < 1e-12);
  assert.deepEqual(face.morphTargetInfluences.slice(3), [.4, .2]);
  c.setSpeech(.25); c.update();
  assert.deepEqual(face.morphTargetInfluences, [1, 0, .75, .25, 0]);
});

test("interrupted combinations blend from rendered result and preserve open controls", () => {
  const {controller: c, face} = fixture();
  c.setSpeech(.5); c.update();
  c.setExpression({eye: "Closed", closed: "A", open: "A"}, 1); c.update(.5);
  assert.deepEqual(face.morphTargetInfluences, [.5, .5, .25, .75, 0]);
  c.setExpression({eye: "Open", closed: "Smile", open: "A"}, 1); c.update(.5);
  assert.deepEqual(face.morphTargetInfluences, [.75, .25, .375, .625, 0]);
  assert.equal(c.getState().speech, .5);
});

test("selection validation rejects missing references without changing current selection", () => {
  const {controller: c, definition} = fixture();
  c.update(); const before = c.getState();
  assert.throws(() => c.setExpression({eye: "Open", closed: "Missing", open: "A"}));
  c.update(); assert.deepEqual(c.getState().selections, before.selections);
  definition.defaultExpression.open = "Missing";
  assert.throws(() => validateExpressionDefinitions(definition));
  delete definition.defaultExpression;
  definition.expressionGroups[1].type = "eye";
  assert.throws(() => validateExpressionDefinitions(definition));
});

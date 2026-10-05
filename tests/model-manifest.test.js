import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { expandModelManifest, validateModelManifest } from "../src/model-manifest.js";
import { IdlePose } from "../src/idle-pose.js";

function composedManifest() {
  return {
    components: [
      {
        type: "model",
        name: "018_cos_base",
        group: "garupa",
        motionGroup: "garupa",
        role: "head",
        model: "head.glb",
        morphPoses: [],
        expressionGroups: [],
        humanoidScale: 1.52,
      },
      {
        type: "model",
        name: "018_cos_base",
        group: "garupa",
        motionGroup: "garupa",
        role: "body",
        model: "body.glb",
        humanoidScale: 1.48,
      },
    ],
  };
}

test("manifest expands self-contained head and body entries", () => {
  const manifest = composedManifest();
  manifest.components.push({ type: "future-resource", enabled: true });
  const entries = expandModelManifest(
    manifest,
    "bangdream/018_cos_base/config.json",
  );

  assert.deepEqual(entries.map((entry) => entry.key), [
    "bangdream/018_cos_base/config.json#model:018_cos_base:head",
    "bangdream/018_cos_base/config.json#model:018_cos_base:body",
  ]);
  assert.deepEqual(entries.map((entry) => entry.basePath), [
    "bangdream/018_cos_base",
    "bangdream/018_cos_base",
  ]);
  assert.deepEqual(entries.map((entry) => entry.component.humanoidScale), [1.52, 1.48]);
  assert.deepEqual(entries.map((entry) => entry.motionGroup), ["garupa", "garupa"]);
});

test("integrated model may omit group and ignores unknown additive fields", () => {
  const manifest = {
    components: [{
      type: "model",
      name: "SCSch011KahDeA",
      role: "integrated",
      model: "model.glb",
      morphPoses: [],
        expressionGroups: [],
      humanoidScale: 0.9,
      futureRenderingHint: "supported",
    }],
  };

  assert.equal(validateModelManifest(manifest), manifest);
});

test("manifest rejects duplicate roles and mixed integrated layouts", () => {
  const duplicate = composedManifest();
  duplicate.components[1] = { ...duplicate.components[0], model: "other.glb" };
  assert.throws(() => validateModelManifest(duplicate), /role head 不能重复/);

  const mixed = composedManifest();
  mixed.components.push({
    type: "model",
    name: "018_cos_base",
    role: "integrated",
    model: "model.glb",
    morphPoses: [],
        expressionGroups: [],
    humanoidScale: 1,
  });
  assert.throws(() => validateModelManifest(mixed), /integrated 不能与 head 或 body 共存/);
});

test("body omits facial fields and composed manifests require group", () => {
  const facialBody = composedManifest();
  facialBody.components[1].expressionGroups = [];
  assert.throws(() => validateModelManifest(facialBody), /body 不应声明表情字段/);

  const missingGroup = composedManifest();
  delete missingGroup.components[0].group;
  assert.throws(() => validateModelManifest(missingGroup), /group 必须是非空字符串/);
});

test("motionGroup is optional but must be a non-empty string when present", () => {
  const legacy = composedManifest();
  delete legacy.components[0].motionGroup;
  delete legacy.components[1].motionGroup;
  assert.equal(validateModelManifest(legacy), legacy);

  const invalid = composedManifest();
  invalid.components[0].motionGroup = "";
  assert.throws(() => validateModelManifest(invalid), /motionGroup 存在时必须是非空字符串/);
});

test("legacy flat configs are not accepted", () => {
  assert.throws(() => validateModelManifest({
    type: "head",
    group: "garupa",
    name: "legacy",
    model: "model.glb",
  }), /顶层只能包含 components/);
});

test("defaultExpression references existing eye and both mouth states", () => {
  const manifest = composedManifest();
  manifest.components[0].expressionGroups = [
    {name:"face",type:"eye",states:[{name:"Neutral",poses:{}}]},
    {name:"lips",type:"mouth",states:[{name:"N",poses:{}},{name:"A",poses:{}}]},
  ];
  manifest.components[0].defaultExpression = {eye:"Neutral",closed:"N",open:"A"};
  assert.equal(validateModelManifest(manifest), manifest);

  manifest.components[0].defaultExpression.open = "Missing";
  assert.throws(
    () => validateModelManifest(manifest),
    /defaultExpression.open 必须引用 mouth 状态/,
  );
});

test("optional idlePose keeps zero-muscle bones as the action reference", () => {
  const manifest = composedManifest();
  const body = manifest.components[1];
  body.defaultMotion = "mot_00_00010";
  body.idlePose = { tracks: [
    { bone: "Hips", rotation: [0, 0, 0, 1], translation: [0, 0.25, 0] },
    { bone: "Spine", rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] },
  ] };
  assert.equal(validateModelManifest(manifest), manifest);

  const root = new THREE.Group();
  const frame = new THREE.Group();
  frame.position.set(1, 0, 2);
  root.add(frame);
  const hips = new THREE.Bone();
  hips.name = "Hips";
  hips.position.set(0, 1, 0);
  frame.add(hips);
  const spine = new THREE.Bone();
  spine.name = "Spine";
  spine.position.y = 0.2;
  hips.add(spine);
  const referencePosition = hips.position.clone();
  const referenceRotation = spine.quaternion.clone();
  const idle = new IdlePose(root, 2, body.idlePose);
  idle.apply();
  assert.ok(Math.abs(hips.position.y - 1.5) < 1e-8);
  assert.ok(spine.quaternion.angleTo(new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4)) < 1e-8);
  idle.restore();
  assert.ok(hips.position.distanceTo(referencePosition) < 1e-8);
  assert.ok(spine.quaternion.angleTo(referenceRotation) < 1e-8);

  body.idlePose.tracks[1].translation = [0, 0, 0];
  assert.throws(() => validateModelManifest(manifest), /只有 Hips/);
  delete body.idlePose.tracks[1].translation;
  body.defaultMotion = "";
  assert.throws(() => validateModelManifest(manifest), /defaultMotion/);
});

test("expression recipe references, states and complete default combinations are validated", () => {
  const manifest = composedManifest();
  const face = manifest.components[0];
  face.morphPoses = [{name:"eye",targets:{Face:{close:-0.5}}}];
  face.expressionGroups = [{name:"face",type:"eye",states:[{name:"Joy",poses:{eye:2},controls:{blink:{eye:0}}}]}];
  face.defaultExpression={eye:"Joy"};
  assert.equal(validateModelManifest(manifest),manifest);
  face.expressionGroups[0].states[0].poses.unknown=1;
  assert.throws(()=>validateModelManifest(manifest),/未知 Morph 配方/);
  delete face.expressionGroups[0].states[0].poses.unknown;
  face.defaultExpression={};
  assert.throws(()=>validateModelManifest(manifest),/defaultExpression.eye/);
  face.defaultExpression={eye:"Missing"};
  assert.throws(()=>validateModelManifest(manifest),/defaultExpression.eye/);
});
test("finite unbounded Morph and recipe values are allowed without field whitelist",()=>{
  const manifest=composedManifest();
  const face=manifest.components[0];
  face.morphPoses=[{name:"raw",targets:{Face:{mouth:2}},futureRenderingHint:true}];
  assert.equal(validateModelManifest(manifest),manifest);
  for(const value of [NaN,Infinity,"0.5",{}]){
    face.morphPoses[0].targets.Face.mouth=value;
    assert.throws(()=>validateModelManifest(manifest),/Morph 权重/);
  }
  face.morphPoses[0].targets.Face.mouth=-2;
  face.morphPoses.push({...face.morphPoses[0]});
  assert.throws(()=>validateModelManifest(manifest),/重复名称/);
});
test("required arrays, nonempty states and duplicate names are rejected",()=>{
  const manifest=composedManifest();
  const face=manifest.components[0];
  delete face.morphPoses;
  assert.throws(()=>validateModelManifest(manifest),/morphPoses/);
  face.morphPoses=[];
  face.expressionGroups=[{name:"face",type:"eye",states:[]}];
  assert.throws(()=>validateModelManifest(manifest),/states/);
  face.expressionGroups=[{name:"face",type:"eye",states:[{name:"same",poses:{}},{name:"same",poses:{}}]}];
  assert.throws(()=>validateModelManifest(manifest),/重复名称/);
});
test("control independence compares expanded Morph deltas, not recipe names",()=>{
  const manifest=composedManifest();
  const face=manifest.components[0];
  face.morphPoses=[
    {name:"left",targets:{Face:{eye:1}}},
    {name:"other",targets:{Face:{eye:2}}},
  ];
  face.expressionGroups=[
    {name:"face",type:"eye",states:[{name:"N",poses:{},controls:{blink:{left:1}}}]},
    {name:"mouth",type:"mouth",states:[{name:"N",poses:{}},{name:"A",poses:{other:1}}]},
  ];
  assert.throws(()=>validateModelManifest(manifest),/同一实际 Morph/);
  face.expressionGroups[1].states[0].poses.other=1;
  assert.equal(validateModelManifest(manifest),manifest);
});

test("manifest accepts Behavior declarations without interpreting parameters", () => {
  const manifest = composedManifest();
  manifest.components[0].behaviors = [{
    name: "Garupa.AvatarScaler",
    required: false,
    parameters: { profile: { height: 1.55 }, opaque: [null, true, 3] },
  }];
  manifest.components[1].behaviors = [{
    name: "Garupa.AvatarScaler",
    required: true,
    parameters: { binding: { useScaling: true } },
  }];

  assert.equal(validateModelManifest(manifest), manifest);
});

test("manifest rejects malformed and duplicate Behavior declarations", () => {
  const missingField = composedManifest();
  missingField.components[0].behaviors = [{
    name: "Garupa.AvatarScaler",
    required: false,
  }];
  assert.throws(() => validateModelManifest(missingField), /parameters 必须存在/);

  const invalidRequired = composedManifest();
  invalidRequired.components[0].behaviors = [{
    name: "Garupa.AvatarScaler",
    required: "false",
    parameters: null,
  }];
  assert.throws(() => validateModelManifest(invalidRequired), /required 必须为 boolean/);

  const duplicate = composedManifest();
  duplicate.components[0].behaviors = [
    { name: "Garupa.AvatarScaler", required: false, parameters: {} },
    { name: "Garupa.AvatarScaler", required: false, parameters: {} },
  ];
  assert.throws(() => validateModelManifest(duplicate), /重复 Behavior Garupa\.AvatarScaler/);
});

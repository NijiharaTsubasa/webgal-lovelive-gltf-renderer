import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { MotionPlayer, validatePoseSlots } from "../src/motion-player.js";

function clip(id, tracks) {
  return { id, tracks };
}

test("pose slots accept disjoint finger-rotation clips", () => {
  const clips = new Map([
    ["left", clip("left", [{ bone: "LeftIndexProximal", rotation: [0, 0, 0, 1] }])],
    ["right", clip("right", [{ bone: "RightThumbDistal", rotation: [0, 0, 0, 1] }])],
  ]);
  assert.doesNotThrow(() => validatePoseSlots([
    { id: "left", options: [{ id: "a", clip: "left" }] },
    { id: "right", options: [{ id: "a", clip: "right" }] },
  ], clips));
});

test("pose slots reject non-finger tracks and cross-slot overlap", () => {
  assert.throws(() => validatePoseSlots([
    { id: "bad", options: [{ id: "a", clip: "arm" }] },
  ], new Map([["arm", clip("arm", [{ bone: "LeftLowerArm", rotation: [0, 0, 0, 1] }])]])), /只能覆盖手指旋转/);

  const clips = new Map([
    ["a", clip("a", [{ bone: "LeftIndexProximal", rotation: [0, 0, 0, 1] }])],
    ["b", clip("b", [{ bone: "LeftIndexProximal", rotation: [0, 0, 0, 1] }])],
  ]);
  assert.throws(() => validatePoseSlots([
    { id: "one", options: [{ id: "a", clip: "a" }] },
    { id: "two", options: [{ id: "b", clip: "b" }] },
  ], clips), /姿势槽骨骼重叠/);
});

function groupMotion() {
  return {
    clips: [{
      id: "idle",
      duration: 1,
      sampleRate: 1,
      frames: 2,
      tracks: [],
      groupTracks: [{
        kind: "morph",
        node: "face_Base_obj",
        property: "mouth_a",
        values: [0.25, 0.75],
      }],
    }],
    auxiliaryClips: [],
    leftHandPoses: [],
    rightHandPoses: [],
    program: {
      parameters: [],
      commands: {},
      baseLayer: "Base Layer",
      layers: [{
        id: "Base Layer",
        blend: "override",
        weight: 1,
        initialState: "idle",
        states: [{ id: "idle", clip: "idle", speed: 1, loop: true, transitions: [] }],
      }],
      poseSlots: [],
    },
  };
}

function oneBoneMotion(bone) {
  return {
    clips: [{
      id: "idle",
      duration: 1,
      sampleRate: 1,
      frames: 2,
      tracks: [{ bone, rotation: [0, 0, 0, 1, 0, 0, 0, 1] }],
    }],
    auxiliaryClips: [],
    leftHandPoses: [],
    rightHandPoses: [],
    program: {
      parameters: [],
      commands: {},
      baseLayer: "Base Layer",
      layers: [{
        id: "Base Layer",
        blend: "override",
        weight: 1,
        initialState: "idle",
        states: [{ id: "idle", clip: "idle", speed: 1, loop: true, transitions: [] }],
      }],
      poseSlots: [],
    },
  };
}

function conditionalMotion(parameter, condition) {
  const motion = oneBoneMotion("Hips");
  motion.program.parameters = [parameter];
  motion.program.commands = {
    fire: [{ parameter: parameter.id, value: true }],
  };
  const layer = motion.program.layers[0];
  layer.states.push({
    id: "done",
    clip: "idle",
    speed: 1,
    loop: true,
    transitions: [],
  });
  layer.states[0].transitions = [{
    to: "done",
    exitTime: null,
    duration: 0,
    offset: 0,
    conditions: [condition],
  }];
  return motion;
}

test("one joint-local motion drives different reference axes and bone lengths without model branches", () => {
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(.4, -.3, .2));
  const motion = oneBoneMotion("LeftLowerArm");
  motion.clips[0].tracks[0].rotation = [...delta.toArray(), ...delta.toArray()];
  for (const [angle, length] of [[.8, .2], [-.6, .5]]) {
    const root = new THREE.Group();
    root.rotation.y = .7;
    const parent = new THREE.Bone(); parent.rotation.z = -.4;
    const bone = new THREE.Bone(); bone.name = "LeftLowerArm";
    bone.position.y = length;
    bone.quaternion.setFromEuler(new THREE.Euler(.2, angle, -.5));
    root.add(parent); parent.add(bone);
    const reference = bone.quaternion.clone();
    const player = new MotionPlayer(root, 1, motion);
    player.update(0);
    assert.ok(bone.quaternion.angleTo(reference.clone().multiply(delta)) < 1e-7);
    assert.equal(bone.position.y, length);
    player.dispose();
    assert.ok(bone.quaternion.angleTo(reference) < 1e-7);
  }
});

test("joint-local additive and finger poses use the same nonidentity reference frame", () => {
  const root = new THREE.Group();
  const finger = new THREE.Bone(); finger.name = "LeftIndexProximal";
  finger.quaternion.setFromEuler(new THREE.Euler(.7, -.3, .4)); root.add(finger);
  const reference = finger.quaternion.clone();
  const base = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .5);
  const additive = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -.4);
  const pose = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), .8);
  const motion = oneBoneMotion(finger.name);
  motion.clips[0].tracks[0].rotation = [...base.toArray(), ...base.toArray()];
  const makeClip = (id, rotation) => ({...motion.clips[0], id, tracks:[{bone:finger.name, rotation:[...rotation.toArray(), ...rotation.toArray()]}]});
  motion.auxiliaryClips = [makeClip("add", additive)];
  motion.leftHandPoses = [makeClip("pose", pose)];
  motion.program.layers.push({id:"Add", blend:"additive", weight:.5, initialState:"add", states:[{id:"add", clip:"add", speed:1, loop:true, transitions:[]}]});
  motion.program.poseSlots = [{id:"left", default:null, options:[{id:"fixed",clip:"pose"}]}];
  const player = new MotionPlayer(root, 1, motion); player.update(0);
  const weighted = new THREE.Quaternion().slerp(additive, .5);
  assert.ok(finger.quaternion.angleTo(reference.clone().multiply(base).multiply(weighted)) < 1e-7);
  player.poseSlots.get("left").selected = "fixed"; player.update(0);
  assert.ok(finger.quaternion.angleTo(reference.clone().multiply(pose)) < 1e-7);
});

test("numeric transition conditions follow the declared parameter type", () => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "Hips";
  root.add(hips);
  const motion = conditionalMotion(
    { id: "amount", type: "float", default: 0.75 },
    { parameter: "amount", operator: "greater", value: 0.5 },
  );

  const player = new MotionPlayer(root, 1, motion);
  player.update(0);

  assert.equal(player.bodyLayer.state.id, "done");
});

test("a trigger resets after the transition that consumes it", () => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "Hips";
  root.add(hips);
  const motion = conditionalMotion(
    { id: "go", type: "trigger", default: false },
    { parameter: "go", operator: "isTrue" },
  );

  const player = new MotionPlayer(root, 1, motion);
  assert.equal(player.command("fire"), true);
  player.update(0);

  assert.equal(player.bodyLayer.state.id, "done");
  assert.equal(player.parameters.get("go"), false);
});

test("all standardized condition operators select transitions deterministically", () => {
  const cases = [
    [{ id: "p", type: "float", default: 0.25 }, { parameter: "p", operator: "less", value: 0.5 }],
    [{ id: "p", type: "int", default: 2 }, { parameter: "p", operator: "greater", value: 1 }],
    [{ id: "p", type: "int", default: 2 }, { parameter: "p", operator: "less", value: 3 }],
    [{ id: "p", type: "int", default: 2 }, { parameter: "p", operator: "equals", value: 2 }],
    [{ id: "p", type: "int", default: 2 }, { parameter: "p", operator: "notEquals", value: 3 }],
    [{ id: "p", type: "bool", default: true }, { parameter: "p", operator: "isTrue" }],
    [{ id: "p", type: "bool", default: false }, { parameter: "p", operator: "isFalse" }],
  ];
  for (const [parameter, condition] of cases) {
    const root = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = "Hips";
    root.add(hips);
    const player = new MotionPlayer(root, 1, conditionalMotion(parameter, condition));
    player.update(0);
    assert.equal(player.bodyLayer.state.id, "done", `${parameter.type}/${condition.operator}`);
  }
});

test("commands reject values that do not match the declared parameter type", () => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "Hips";
  root.add(hips);
  const motion = conditionalMotion(
    { id: "go", type: "trigger", default: false },
    { parameter: "go", operator: "isTrue" },
  );
  motion.program.commands.fire[0].value = 1;
  const player = new MotionPlayer(root, 1, motion);

  assert.throws(() => player.command("fire"), /动作参数赋值无效: go/);
  assert.equal(player.parameters.get("go"), false);
});

test("humanoid motion rejects ambiguous logical bone names", () => {
  const root = new THREE.Group();
  const first = new THREE.Bone();
  const second = new THREE.Bone();
  first.name = "Hips";
  second.userData.name = "Hips";
  root.add(first, second);
  assert.throws(
    () => new MotionPlayer(root, 1, oneBoneMotion("Hips")),
    /动作骨骼 Hips 必须恰好命中一个节点，实际 2/,
  );
});

function morphRoot() {
  const root = new THREE.Group();
  const face = new THREE.Object3D();
  face.name = "face_Base_obj";
  face.morphTargetDictionary = { mouth_a: 0 };
  face.morphTargetInfluences = [0];
  root.add(face);
  return { root, face };
}

test("group tracks play only when motionGroup matches and restore on dispose", () => {
  const matching = morphRoot();
  const player = new MotionPlayer(matching.root, 1, groupMotion(), "garupa", "garupa");
  assert.equal(player.groupTrackDeclaredCount, 1);
  assert.equal(player.groupTrackResolvedCount, 1);
  player.update(0);
  assert.equal(matching.face.morphTargetInfluences[0], 0.25);
  player.dispose();
  assert.equal(matching.face.morphTargetInfluences[0], 0);

  const fallback = morphRoot();
  const fallbackPlayer = new MotionPlayer(fallback.root, 1, groupMotion(), "hasunosora", "garupa");
  assert.equal(fallbackPlayer.groupTrackDeclaredCount, 1);
  assert.equal(fallbackPlayer.groupTrackResolvedCount, 0);
  fallbackPlayer.update(0);
  assert.equal(fallback.face.morphTargetInfluences[0], 0);
});

test("group tracks resolve the original glTF node name retained by GLTFLoader", () => {
  const { root, face } = morphRoot();
  face.name = "face_Base_obj_Renderer";
  face.userData.name = "face_Base_obj Renderer";
  const motion = groupMotion();
  motion.clips[0].groupTracks[0].node = "face_Base_obj Renderer";

  const player = new MotionPlayer(root, 1, motion, "garupa", "garupa");
  assert.equal(player.groupTrackDeclaredCount, 1);
  assert.equal(player.groupTrackResolvedCount, 1);
  player.update(0);
  assert.equal(face.morphTargetInfluences[0], 0.25);
});

test("group tracks do not select sanitized aliases or ambiguous original names", () => {
  const sanitized = morphRoot();
  sanitized.face.name = "face_Base_obj_Renderer";
  sanitized.face.userData.name = "face_Base_obj Renderer";
  const sanitizedMotion = groupMotion();
  sanitizedMotion.clips[0].groupTracks[0].node = "face_Base_obj_Renderer";
  const sanitizedPlayer = new MotionPlayer(sanitized.root, 1, sanitizedMotion, "garupa", "garupa");
  assert.equal(sanitizedPlayer.groupTrackResolvedCount, 0);

  const ambiguous = morphRoot();
  const duplicate = ambiguous.face.clone();
  duplicate.morphTargetDictionary = { mouth_a: 0 };
  duplicate.morphTargetInfluences = [0];
  ambiguous.root.add(duplicate);
  const ambiguousPlayer = new MotionPlayer(ambiguous.root, 1, groupMotion(), "garupa", "garupa");
  assert.equal(ambiguousPlayer.groupTrackResolvedCount, 0);
});

test("non-zero state transition crossfades source and target clips", () => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "Hips";
  root.add(hips);
  const identity = [0, 0, 0, 1];
  const halfTurn = [0, 0, 1, 0];
  const motion = {
    clips: [
      { id: "in", duration: 1, sampleRate: 1, frames: 2, tracks: [{
        bone: "Hips", rotation: [...identity, ...identity], translation: [0, 0, 0, 0, 0, 0],
      }] },
      { id: "loop", duration: 1, sampleRate: 1, frames: 2, tracks: [{
        bone: "Hips", rotation: [...halfTurn, ...halfTurn], translation: [2, 0, 0, 2, 0, 0],
      }] },
    ],
    auxiliaryClips: [], leftHandPoses: [], rightHandPoses: [],
    program: {
      parameters: [], commands: {}, baseLayer: "Base Layer", poseSlots: [],
      layers: [{
        id: "Base Layer", blend: "override", weight: 1, initialState: "in",
        states: [
          { id: "in", clip: "in", speed: 1, loop: false, transitions: [{
            to: "loop", exitTime: 1, duration: 0.25, offset: 0, conditions: [],
          }] },
          { id: "loop", clip: "loop", speed: 1, loop: true, transitions: [] },
        ],
      }],
    },
  };
  const player = new MotionPlayer(root, 1, motion);

  player.update(1.125);
  assert.ok(Math.abs(hips.position.x - 1) < 1e-6);
  assert.ok(hips.quaternion.angleTo(new THREE.Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2)) < 1e-6);

  player.update(0.125);
  assert.ok(Math.abs(hips.position.x - 2) < 1e-6);
  assert.ok(hips.quaternion.angleTo(new THREE.Quaternion(...halfTurn)) < 1e-6);
});

test("an immediate condition-only transition advances with the target state speed", () => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = "Hips";
  root.add(hips);
  const motion = oneBoneMotion("Hips");
  motion.clips[0].id = "source";
  motion.clips.push({ ...motion.clips[0], id: "target" });
  const layer = motion.program.layers[0];
  layer.states = [
    { id: "source", clip: "source", speed: 0.5, loop: false, transitions: [{
      to: "target", exitTime: null, duration: 0, offset: 0.1, conditions: [],
    }] },
    { id: "target", clip: "target", speed: 2, loop: false, transitions: [] },
  ];
  layer.initialState = "source";

  const player = new MotionPlayer(root, 1, motion);
  player.update(0.2);

  assert.equal(player.bodyLayer.state.id, "target");
  assert.ok(Math.abs(player.bodyLayer.time - 0.5) < 1e-12);
});

function assertReadonlyPlain(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertReadonlyPlain(child);
}

test("motion definition exposes readonly descriptors without sample arrays or runtime objects", () => {
  const motion = groupMotion();
  motion.auxiliaryClips.push({ ...motion.clips[0], id: "aux", groupTracks: [], tracks: [{
    bone: "Hips", translation: [0, 0, 0, 1, 1, 1],
  }] });
  motion.leftHandPoses.push({ ...motion.clips[0], id: "left", groupTracks: [], tracks: [{
    bone: "LeftIndexProximal", rotation: [0, 0, 0, 1, 0, 0, 0, 1],
  }] });
  motion.rightHandPoses.push({ ...motion.leftHandPoses[0], id: "right" });
  const resource = { type: "motion", name: "idle", motionGroup: "test", src: "idle.json", basePath: "/private" };
  const player = new MotionPlayer(new THREE.Group(), 1, motion);
  const definition = player.getDefinition(resource);
  assertReadonlyPlain(definition);
  assert.deepEqual(definition.resource, { type: "motion", name: "idle", motionGroup: "test" });
  assert.deepEqual(definition.program, motion.program);
  assert.deepEqual(definition.clips.map((item) => item.id), ["idle", "aux", "left", "right"]);
  assert.deepEqual(definition.clips[0].groupTracks, [{ kind: "morph", node: "face_Base_obj", property: "mouth_a" }]);
  assert.deepEqual(definition.clips[1].tracks, [{ bone: "Hips", rotation: false, translation: true }]);
  assert.deepEqual(definition.clips[2].tracks, [{ bone: "LeftIndexProximal", rotation: true, translation: false }]);
  assert.equal(Object.hasOwn(definition.clips[0], "tracksByBone"), false);
  assert.equal(Object.hasOwn(definition.clips[0].groupTracks[0], "values"), false);
  resource.name = "changed";
  motion.program.layers[0].states[0].speed = 2;
  assert.equal(definition.resource.name, "idle");
  assert.equal(definition.program.layers[0].states[0].speed, 1);
  assert.throws(() => { definition.program.layers.push({}); }, TypeError);
});

test("motion snapshots retain held end frames, remain immutable, and clear on disposal", () => {
  const motion = groupMotion();
  motion.program.layers[0].states[0].loop = false;
  const player = new MotionPlayer(new THREE.Group(), 1, motion);
  assert.equal(player.getState(), null);
  player.update(0.5);
  const previous = player.getState();
  assertReadonlyPlain(previous);
  assert.deepEqual(previous.layers[0], {
    id: "Base Layer", state: "idle", time: 0.5, transition: null,
    samples: [{ state: "idle", clip: "idle", time: 0.5, frame: 0, weight: 1 }],
  });
  assert.strictEqual(player.getState(), previous);
  assert.throws(() => { previous.layers[0].samples[0].time = 99; }, TypeError);
  player.update(2);
  assert.equal(previous.layers[0].time, 0.5);
  assert.equal(player.getState().layers[0].samples[0].frame, 1);
  assert.equal(player.getState().layers[0].time, 1);
  player.dispose();
  assert.equal(player.getState(), null);
  assert.equal(previous.layers[0].time, 0.5);
});

test("motion queries publish consumed triggers only after successful evaluation", () => {
  const motion = conditionalMotion(
    { id: "go", type: "trigger", default: false },
    { parameter: "go", operator: "isTrue" },
  );
  const root = new THREE.Group();
  const player = new MotionPlayer(root, 1, motion);
  player.update(0);
  const previous = player.getState();
  player.command("fire");
  assert.strictEqual(player.getState(), previous);
  assert.deepEqual(previous.parameters, { go: false });
  assert.equal(previous.layers[0].state, "idle");
  player.update(0);
  assert.deepEqual(player.getState().parameters, { go: false });
  assert.equal(player.getState().layers[0].state, "done");
  const completed = player.getState();
  root.updateMatrixWorld = () => { throw new Error("evaluation failed"); };
  assert.throws(() => player.update(0.25), /evaluation failed/);
  assert.strictEqual(player.getState(), completed);
});

test("a stop command remains a program transition rather than unloading query state", () => {
  const motion = conditionalMotion(
    { id: "stop", type: "bool", default: false },
    { parameter: "stop", operator: "isTrue" },
  );
  motion.program.commands.stop = motion.program.commands.fire;
  delete motion.program.commands.fire;
  motion.program.layers[0].states[1].loop = false;
  const player = new MotionPlayer(new THREE.Group(), 1, motion);
  player.update(0);
  const previous = player.getState();
  player.command("stop");
  assert.equal(player.getState().parameters.stop, false);
  player.update(2);
  assert.equal(player.getState().parameters.stop, true);
  assert.equal(player.getState().layers[0].state, "done");
  assert.equal(player.getState().layers[0].samples[0].time, 1);
  assert.equal(previous.parameters.stop, false);
});

test("motion snapshots report layer clocks, transition samples and layer-local weights", () => {
  const motion = groupMotion();
  motion.clips.push({ ...motion.clips[0], id: "target", groupTracks: [] });
  const base = motion.program.layers[0];
  base.states[0].loop = false;
  base.states[0].transitions = [{ to: "target-state", exitTime: 1, duration: 0.5, offset: 0, conditions: [] }];
  base.states.push({ id: "target-state", clip: "target", speed: 1, loop: true, transitions: [] });
  motion.program.layers.push({
    id: "Add", blend: "additive", weight: 0.3, initialState: "add",
    states: [{ id: "add", clip: "target", speed: 2, loop: true, transitions: [] }],
  });
  const { root } = morphRoot();
  const player = new MotionPlayer(root, 1, motion, "test", "test");
  player.update(1.125);
  const snapshot = player.getState();
  assert.deepEqual(snapshot.layers[0], {
    id: "Base Layer", state: "idle", time: 1.125,
    transition: { to: "target-state", elapsed: 0.125, duration: 0.5 },
    samples: [
      { state: "idle", clip: "idle", time: 1, frame: 1, weight: 0.75 },
      { state: "target-state", clip: "target", time: 0.125, frame: 0, weight: 0.25 },
    ],
  });
  assert.deepEqual(snapshot.layers[1], {
    id: "Add", state: "add", time: 0.25, transition: null,
    samples: [{ state: "add", clip: "target", time: 0.25, frame: 0, weight: 1 }],
  });
  assert.deepEqual(snapshot.groupTracks, {
    matching: true, clip: "idle", time: 1, frame: 1,
    tracks: [{ kind: "morph", node: "face_Base_obj", property: "mouth_a" }],
  });
  player.update(0.375);
  assert.equal(player.getState().layers[0].state, "target-state");
  assert.equal(player.getState().layers[0].transition, null);
  assert.deepEqual(player.getState().groupTracks.tracks, []);
  assert.equal(snapshot.layers[0].state, "idle");
});

test("pose queries retain evaluated selections and report wrapped sampling without weights", () => {
  const motion = groupMotion();
  motion.leftHandPoses = [{ ...motion.clips[0], id: "pose", groupTracks: [], tracks: [{
    bone: "LeftIndexProximal", rotation: [0, 0, 0, 1, 0, 0, 0, 1],
  }] }];
  motion.program.poseSlots = [{ id: "left", default: null, options: [{ id: "fixed", clip: "pose" }] }];
  const player = new MotionPlayer(new THREE.Group(), 1, motion);
  player.update(0);
  const previous = player.getState();
  assert.deepEqual(previous.poseSlots, [{ id: "left", selected: null, sample: null }]);
  assert.equal(player.setPose("left", "fixed"), true);
  assert.strictEqual(player.getState(), previous);
  player.update(1.25);
  assert.deepEqual(player.getState().poseSlots, [{
    id: "left", selected: "fixed", sample: { clip: "pose", time: 0.25, frame: 0 },
  }]);
  player.setPose("left", null);
  assert.equal(player.getState().poseSlots[0].selected, "fixed");
  player.update(0);
  assert.deepEqual(player.getState().poseSlots, [{ id: "left", selected: null, sample: null }]);
});

test("group queries distinguish matching declarations from tracks actually resolved this frame", () => {
  const motion = groupMotion();
  motion.clips[0].groupTracks.push({ kind: "visibility", node: "missing", property: "visible", values: [0, 1] });
  for (const [modelGroup, motionGroup, matching, count] of [
    ["test", "test", true, 1], ["other", "test", false, 0], [null, null, false, 0],
  ]) {
    const { root } = morphRoot();
    const player = new MotionPlayer(root, 1, motion, modelGroup, motionGroup);
    player.update(0.25);
    assert.equal(player.getState().groupTracks.matching, matching);
    assert.equal(player.getState().groupTracks.tracks.length, count);
    assert.equal(player.getState().groupTracks.clip, "idle");
    assert.equal(player.getDefinition({ type: "motion", name: "sample" }).clips[0].groupTracks.length, 2);
  }
});

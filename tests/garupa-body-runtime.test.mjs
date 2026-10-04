import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Bone, Group, Vector3 } from 'three';
import bodyCalibration from '../src/garupa/body-calibration.js';
import { createFixedBodyEvaluator } from '../src/garupa/body-mapping.mjs';
import { ParameterBodyPose } from '../src/garupa/body-pose.js';
import { MotionPlayer } from '../src/motion-player.js';

test('shared runtime body mapping uses persistent calibration without source playback dependencies', async () => {
  const seen = new Set();
  async function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const text = await readFile(url, 'utf8');
    assert.doesNotMatch(text, /source-data|source-core|node-source|loadMotion|parseMtn|sampleMtn/);
    assert.doesNotMatch(text, /\beval\s*\(|new\s+Function\b|\bfetch\s*\(|\b(?:window|document)\s*\.|ShaderMaterial|WebGLRenderer/);
    for (const match of text.matchAll(/(?:import\s+(?:[^;]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) {
        assert.equal(specifier, 'three');
        continue;
      }
      const target = new URL(specifier, url);
      assert.ok(target.pathname.includes('/src/garupa/'));
      if (/\.(?:mjs|js)$/.test(target.pathname)) await visit(target);
    }
  }
  await visit(new URL('../src/garupa/body-mapping.mjs', import.meta.url));
  await visit(new URL('../src/garupa/body-calibration.js', import.meta.url));
  assert.deepEqual([...seen].map(value => new URL(value).pathname.split('/').at(-1)).sort(), [
    'body-arm-depth.mjs', 'body-arm-twist.mjs', 'body-calibration.js',
    'body-joint-space.mjs', 'body-mapping.mjs', 'source-arm-order.mjs',
  ]);
  const pose = createFixedBodyEvaluator(bodyCalibration)({});
  assert.deepEqual(Object.keys(pose.rotations), bodyCalibration.seed.bones.map(bone => bone.name));
  assert.ok(pose.hipsTranslation.every(Number.isFinite));
  for (const rotation of Object.values(pose.rotations)) {
    assert.equal(rotation.length, 4);
    assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-10);
  }
});

function targetRig(lengthScale) {
  const scene = new Group();
  scene.position.set(-2, 1.3, .4);
  scene.rotation.set(.21, -.37, .13);
  scene.scale.set(1.2, .9, 1.1);
  const root = new Group();
  root.position.set(3, -1.7, .2);
  root.rotation.set(-.18, .41, -.27);
  root.scale.set(.8, 1.15, 1.3);
  scene.add(root);
  const carrier = new Group();
  carrier.name = 'armature';
  carrier.position.set(.2, -.3, .4);
  carrier.rotation.set(.31, -.23, .19);
  carrier.scale.set(1.1, .85, 1.2);
  root.add(carrier);
  const nodes = new Map(bodyCalibration.seed.bones.map((metadata, index) => {
    const node = new Bone();
    node.name = metadata.name;
    node.position.set(.03 * Math.sin(index), lengthScale * (.04 + index / 2000), .017 * Math.cos(index));
    node.rotation.set(.1 * Math.sin(index), -.13 * Math.cos(index), .04 * (index % 5));
    return [node.name, node];
  }));
  for (const metadata of bodyCalibration.seed.bones) {
    (nodes.get(metadata.parent) ?? carrier).add(nodes.get(metadata.name));
  }
  scene.updateMatrixWorld(true);
  return { root, nodes };
}

function motionFor(pose) {
  return {
    clips: [{ id: 'body', duration: 1, sampleRate: 1, frames: 2,
      tracks: Object.entries(pose.rotations).map(([bone, rotation]) => ({
        bone, rotation: [...rotation, ...rotation],
        ...(bone === 'Hips' ? { translation: [...pose.hipsTranslation, ...pose.hipsTranslation] } : {}),
      })) }],
    auxiliaryClips: [], leftHandPoses: [], rightHandPoses: [],
    program: { parameters: [], commands: {}, baseLayer: 'body', poseSlots: [],
      layers: [{ id: 'body', blend: 'override', weight: 1, initialState: 'body',
        states: [{ id: 'body', clip: 'body', speed: 1, loop: false, transitions: [] }] }] },
  };
}

const parameterCases = [
  {},
  { PARAM_POSITION_X: .42, PARAM_POSITION_Y: -.25, PARAM_BODY_ANGLE_X: -11,
    PARAM_BODY_ANGLE_Z: 6, PARAM_ANGLE_X: 17, PARAM_ANGLE_Y: -13,
    PARAM_ARM_L_01_002: 28, PARAM_ARM_R_CHANGE: .9 },
  { PARAM_POSITION_Y: .61, PARAM_ROTATION_Z: 8, PARAM_UPPER_BODY: -.3,
    PARAM_HAND_L_01_001: 0, PARAM_HAND_L_04_001: 1,
    PARAM_HAND_R_01_001: 0, PARAM_HAND_R_09_001: 1 },
];

function snapshot(nodes) {
  return new Map([...nodes].map(([name, node]) => [name, {
    position: node.position.clone(), rotation: node.quaternion.clone(), matrix: node.matrixWorld.clone(),
  }]));
}

function assertPoseMatches(nodes, expected, label) {
  for (const [name, node] of nodes) {
    const pose = expected.get(name);
    assert.ok(node.position.distanceTo(pose.position) < 1e-11, `${label} ${name} local position`);
    assert.ok(node.quaternion.angleTo(pose.rotation) < 1e-7, `${label} ${name} local rotation`);
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(node.matrixWorld.elements[i] - pose.matrix.elements[i]) < 1e-10,
        `${label} ${name} world matrix[${i}]`);
    }
  }
}

test('parameter body pose matches standard motion for transformed roots, parents and different target scales', () => {
  const evaluate = createFixedBodyEvaluator(bodyCalibration);
  for (const humanoidScale of [.6, 1.85]) {
    for (const parameters of parameterCases) {
      const actual = targetRig(humanoidScale), reference = targetRig(humanoidScale);
      const pose = evaluate(parameters);
      const baselineHips = actual.nodes.get('Hips').getWorldPosition(new Vector3())
        .applyMatrix4(actual.root.matrixWorld.clone().invert());
      const player = new MotionPlayer(reference.root, humanoidScale, motionFor(pose));
      player.update(0);
      reference.root.updateMatrixWorld(true);
      const body = new ParameterBodyPose(actual.root, humanoidScale);
      body.applyParameters(parameters);
      assertPoseMatches(actual.nodes, snapshot(reference.nodes), `scale=${humanoidScale}`);
      const modelHips = actual.nodes.get('Hips').getWorldPosition(new Vector3())
        .applyMatrix4(actual.root.matrixWorld.clone().invert());
      const expectedHips = baselineHips.add(new Vector3().fromArray(pose.hipsTranslation).multiplyScalar(humanoidScale));
      assert.ok(modelHips.distanceTo(expectedHips) < 1e-11, 'Hips translation is normalized model-space delta');
      player.dispose();
      body.restore();
      assertPoseMatches(actual.nodes, snapshot(reference.nodes), 'restored');
    }
  }
});

test('parameter changes, repeated application and restore do not accumulate deformation', () => {
  const { root, nodes } = targetRig(1.37);
  const baseline = snapshot(nodes);
  const body = new ParameterBodyPose(root, 1.37);
  const expected = parameterCases.map(parameters => {
    body.applyParameters(parameters);
    const pose = snapshot(nodes);
    body.restore();
    assertPoseMatches(nodes, baseline, 'baseline between samples');
    return pose;
  });
  for (let cycle = 0; cycle < 12; cycle++) {
    for (let index = 0; index < parameterCases.length; index++) {
      body.applyParameters(parameterCases[index]);
      body.applyParameters(parameterCases[index]);
      assertPoseMatches(nodes, expected[index], `cycle=${cycle}, sample=${index}`);
    }
    body.restore();
    assertPoseMatches(nodes, baseline, `cycle=${cycle} restored`);
  }
});

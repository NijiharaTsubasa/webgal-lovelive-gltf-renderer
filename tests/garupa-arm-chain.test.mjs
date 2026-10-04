import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import calibration from '../src/garupa/body-calibration.js';
import { createFixedBodyEvaluator } from '../src/garupa/body-mapping.mjs';
import { standardToWorld } from '../src/garupa/body-joint-space.mjs';

const evaluate = createFixedBodyEvaluator(calibration);
const quaternion = values => new Quaternion().fromArray(values);
const sides = ['Left', 'Right'];
const handIds = Object.keys(calibration.seed.hands);
function handInput(side, id) {
  return Object.fromEntries(handIds.map(hand => [
    `PARAM_HAND_${side[0]}_${side === 'Right' && hand === '07' ? '09' : hand}_001`,
    Number(hand === id),
  ]));
}

test('all seven hand recipes retain the authored shoulder, elbow and wrist endpoints', () => {
  for (const upper of [-24, 7, 24]) for (const lower of [-8, 0, 17, 35, 57]) for (const change of [0, .84, 1]) {
    const parameters = Object.fromEntries(sides.flatMap(side => [
      [`PARAM_ARM_${side[0]}_01_001`, upper], [`PARAM_ARM_${side[0]}_01_002`, lower],
      [`PARAM_ARM_${side[0]}_CHANGE`, change],
    ]));
    let reference;
    for (const id of handIds) {
      const pose = evaluate({ ...parameters, ...handInput('Left', id), ...handInput('Right', id) });
      const fk = standardToWorld(calibration.seed.bones, pose.rotations, pose.hipsTranslation, calibration.seed.humanScale);
      reference ??= fk;
      for (const side of sides) for (const part of ['Shoulder', 'UpperArm', 'LowerArm', 'Hand']) {
        const name = side + part;
        assert.ok(new Vector3().fromArray(fk[name].position).distanceTo(new Vector3().fromArray(reference[name].position)) < 1e-8,
          `hand ${id}, ${name}, upper ${upper}, lower ${lower}, depth ${change}`);
      }
    }
  }
});

test('whole arm chains stay continuous through elbow direction and front/back changes for every hand', () => {
  for (const id of handIds) for (const side of sides) {
    let previous;
    for (let frame = 0; frame <= 256; frame++) {
      const t = frame / 256;
      const pose = evaluate({ ...handInput(side, id),
        [`PARAM_ARM_${side[0]}_01_001`]: -25 + t * 50,
        [`PARAM_ARM_${side[0]}_01_002`]: -10 + t * 70,
        [`PARAM_ARM_${side[0]}_01_003`]: -10 + t * 20,
        [`PARAM_ARM_${side[0]}_CHANGE`]: t,
      });
      if (previous) for (const part of ['Shoulder', 'UpperArm', 'LowerArm', 'Hand']) {
        const name = side + part;
        const angle = quaternion(previous.rotations[name]).angleTo(quaternion(pose.rotations[name]));
        assert.ok(angle < .15, `${id} ${name} frame ${frame}: ${angle * 180 / Math.PI} degrees`);
      }
      previous = pose;
    }
  }
});

test('soyo thinking transition avoids an extra forearm twist when the other arm enters the overlap gate', () => {
  // soyo/gacha_e297_01 source frames 149 -> 150. The unchanged left forearm
  // previously picked up a 41-degree step from the other arm's movement.
  const shared = { PARAM_HAND_R_01_001: 0, PARAM_HAND_R_06_001: 1,
    PARAM_HAND_L_01_001: 0, PARAM_HAND_L_06_001: .98 };
  const from = { ...shared, PARAM_ARM_R_01_001: -3.97, PARAM_ARM_R_01_002: 17.57, PARAM_ARM_R_01_003: -3.56,
    PARAM_ARM_L_01_001: -8.88, PARAM_ARM_L_01_002: 37.45, PARAM_ARM_L_01_003: -.75,
    PARAM_BODY_ANGLE_X: 1.29, PARAM_BODY_ANGLE_Y: .56, PARAM_BODY_ANGLE_Z: -5.3,
    PARAM_UPPER_BODY: -.161, PARAM_ROTATION_Z: .129 };
  const to = { ...shared, PARAM_ARM_R_01_001: -.85, PARAM_ARM_R_01_002: 19.91, PARAM_ARM_R_01_003: -3.64,
    PARAM_ARM_L_01_001: -6.49, PARAM_ARM_L_01_002: 37.62, PARAM_ARM_L_01_003: -.98,
    PARAM_BODY_ANGLE_X: 1.78, PARAM_BODY_ANGLE_Y: .3, PARAM_BODY_ANGLE_Z: -5.04,
    PARAM_UPPER_BODY: -.162, PARAM_ROTATION_Z: .144 };
  const start=evaluate(from),end=evaluate(to);
  assert.ok(quaternion(start.rotations.LeftLowerArm).angleTo(quaternion(end.rotations.LeftLowerArm)) < 5*Math.PI/180);
  let previous=start;
  for(let i=1;i<=100;i++) {
    const parameters=Object.fromEntries(Object.keys(from).map(key=>[key,from[key]+(to[key]-from[key])*i/100]));
    const current=evaluate(parameters);
    assert.ok(quaternion(previous.rotations.LeftLowerArm).angleTo(quaternion(current.rotations.LeftLowerArm)) < .1*Math.PI/180);
    previous=current;
  }
});

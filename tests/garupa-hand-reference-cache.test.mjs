import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Quaternion, Vector3 } from 'three';
import calibration from '../src/garupa/body-calibration.js';
import { createFixedBodyEvaluator } from '../src/garupa/body-mapping.mjs';
import { standardToWorld, worldToStandard } from '../src/garupa/body-joint-space.mjs';
import { createFixedBodyEvaluator as createReferenceEvaluator } from './fixtures/body-mapping-before-hand-cache.mjs';

const sides = ['Left', 'Right'];
const handIds = Object.keys(calibration.seed.hands);
const parameter = (side, id) => `PARAM_HAND_${side[0]}_${side === 'Right' && id === '07' ? '09' : id}_001`;
const weights = (side, entries = {}) => Object.fromEntries(handIds.map(id => [parameter(side, id), entries[id] ?? 0]));
const hands = (left, right) => ({ ...weights('Left', left), ...weights('Right', right) });

function randomGenerator(seed = 0x514e8c27) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed + .5) / 4294967296;
  };
}

function bodyParameters(random) {
  const between = (a, b) => a + (b - a) * random();
  const input = {};
  for (const curve of calibration.bodyCurves) {
    input[curve.id] = between(curve.samples[0][0], curve.samples.at(-1)[0]);
  }
  for (const side of sides) {
    for (const curve of Object.values(calibration.arms[side].curves)) {
      input[curve.id] = between(curve.samples[0][0], curve.samples.at(-1)[0]);
    }
    input[`PARAM_ARM_${side[0]}_CHANGE`] = between(0, 1);
  }
  input.PARAM_ANGLE_X = between(-30, 30);
  input.PARAM_ANGLE_Y = between(-30, 30);
  return input;
}

function assertEquivalent(actual, reference, label) {
  // deepStrictEqual compares every numeric component exactly, including signed
  // zero; angular tolerance or rounding would hide changes to the arithmetic.
  assert.deepStrictEqual(actual.rotations, reference.rotations, `${label}: rotations`);
  assert.deepStrictEqual(Object.keys(actual.rotations), Object.keys(reference.rotations), `${label}: bone order`);
  assert.deepStrictEqual(actual.hipsTranslation, reference.hipsTranslation, `${label}: hipsTranslation`);
  assert.deepStrictEqual(actual.diagnostics, reference.diagnostics, `${label}: diagnostics`);
}

test('all hand templates and different left/right hands match the previous evaluator under changing body and arms', () => {
  const actual = createFixedBodyEvaluator(calibration), reference = createReferenceEvaluator(calibration);
  const random = randomGenerator();
  for (const left of handIds) for (const right of handIds) {
    const fixedHands = hands({ [left]: 1 }, { [right]: 1 });
    for (let frame = 0; frame < 5; frame++) {
      const input = { ...fixedHands, ...bodyParameters(random) };
      assertEquivalent(actual(input), reference(input), `${left}/${right} frame ${frame}`);
    }
  }
});

test('fractional mixing, neutral completion, hidden hands, tiny weights and return transitions remain exact', () => {
  const actual = createFixedBodyEvaluator(calibration), reference = createReferenceEvaluator(calibration);
  const random = randomGenerator(0xb93c104d);
  const cases = [
    hands({}, {}),
    hands({ '01': .2 }, { '01': .9999999999999999 }),
    hands({ '02': .19 }, { '07': .31 }),
    hands({ '01': .07, '03': .29 }, { '01': .21, '06': .11 }),
    hands({ '02': .2, '04': .3, '07': .5 }, { '01': .17, '03': .23, '05': .6 }),
    hands({ '02': .7, '03': 1.2, '04': .8 }, { '03': 2.3, '05': .4 }),
    hands({ '01': -1, '02': Number.MIN_VALUE }, { '01': -3, '07': Number.EPSILON }),
    hands({ '02': .2 }, { '07': .31 }),
    hands({}, {}),
  ];
  for (let cycle = 0; cycle < 3; cycle++) for (let index = 0; index < cases.length; index++) {
    const input = { ...cases[index], ...bodyParameters(random) };
    assertEquivalent(actual(input), reference(input), `case ${index}, cycle ${cycle}`);
    assertEquivalent(actual(input), reference(input), `cached case ${index}, cycle ${cycle}`);
  }
  const hidden = actual(hands({}, {}));
  assert.deepStrictEqual(hidden.diagnostics.hiddenHands, ['Left', 'Right']);
  const visibleNeutral = actual(hands({ '01': 1 }, { '01': 1 }));
  assert.deepStrictEqual(visibleNeutral.diagnostics.hiddenHands, []);
  assert.deepStrictEqual(hidden.rotations, visibleNeutral.rotations);
});

test('4096 seeded non-endpoint samples preserve exact values on cache hits and misses', () => {
  const actual = createFixedBodyEvaluator(calibration), reference = createReferenceEvaluator(calibration);
  const random = randomGenerator(0x45aa29d1);
  let fixedHands;
  for (let sample = 0; sample < 4096; sample++) {
    // Repeated hand weights with independently changing pose parameters exercise
    // the intended steady-state hit path, interleaved with exact input changes.
    if (sample % 4 === 0) {
      const sets = sides.map(() => {
        const count = 1 + Math.floor(random() * 3);
        const entries = {};
        for (let i = 0; i < count; i++) {
          const id = handIds[Math.floor(random() * handIds.length)];
          entries[id] = random() * (sample % 8 === 0 ? .24 : 1.4);
        }
        return entries;
      });
      fixedHands = hands(...sets);
    }
    const input = { ...fixedHands, ...bodyParameters(random) };
    assertEquivalent(actual(input), reference(input), `seeded sample ${sample}`);
  }
});

test('returned mutable arrays cannot poison cached fingers, references or later evaluator results', () => {
  const actual = createFixedBodyEvaluator(calibration), reference = createReferenceEvaluator(calibration);
  const input = { ...hands({ '02': .23, '04': .31 }, { '03': .27, '07': .61 }),
    PARAM_ARM_L_01_002: 37.4, PARAM_BODY_ANGLE_Z: -3.2 };
  const first = actual(input), second = actual(input), expected = reference(input);
  for (const name of Object.keys(first.rotations)) assert.notStrictEqual(first.rotations[name], second.rotations[name]);
  assert.notStrictEqual(first.hipsTranslation, second.hipsTranslation);
  assert.notStrictEqual(first.diagnostics.hiddenHands, second.diagnostics.hiddenHands);
  for (const rotation of Object.values(first.rotations)) rotation.fill(999);
  first.hipsTranslation.fill(-999); first.diagnostics.hiddenHands.push('caller-mutation');
  assertEquivalent(second, expected, 'prior output stays independent');
  assertEquivalent(actual(input), expected, 'cache after output mutation');
  input[parameter('Left', '02')] = .29;
  assertEquivalent(actual(input), reference(input), 'same caller input object mutated');
});

test('separate evaluators use their own calibration and never share output storage', () => {
  const altered = structuredClone(calibration);
  const finger = altered.seed.bones.find(bone => bone.name.startsWith('LeftIndex')).name;
  altered.seed.hands['03'].rotations[finger] = new Quaternion()
    .setFromAxisAngle(new Vector3(1, 0, 0), .217).toArray();
  const first = createFixedBodyEvaluator(calibration), second = createFixedBodyEvaluator(altered);
  const references = [createReferenceEvaluator(calibration), createReferenceEvaluator(altered)];
  const input = hands({ '03': .37, '05': .41 }, { '07': 1 });
  for (let frame = 0; frame < 6; frame++) {
    const one = first(input), two = second(input);
    assertEquivalent(one, references[0](input), `first evaluator ${frame}`);
    assertEquivalent(two, references[1](input), `second evaluator ${frame}`);
    assert.notDeepStrictEqual(one.rotations[finger], two.rotations[finger]);
    assert.notStrictEqual(one.rotations[finger], two.rotations[finger]);
  }
});

test('only the last exact active tuple is cached per side and per evaluator', async () => {
  // Test-only import instrumentation observes the real solver without adding
  // counters, exports or diagnostic entry points to the production module.
  const url = new URL('../src/garupa/body-mapping.mjs', import.meta.url);
  let source = await readFile(url, 'utf8');
  const anchor = 'import {distributeArmTwist} from';
  assert.equal(source.split(anchor).length, 2);
  source = source.replace(anchor, 'import {distributeArmTwist as originalDistributeArmTwist} from');
  source = source.replace(/from '([^']+)'/g, (_, specifier) =>
    `from '${specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)}'`);
  source += '\nlet calls=0; function distributeArmTwist(...args){calls++;return originalDistributeArmTwist(...args);}'
    + '\nexport const readTwistCalls=()=>calls;\n';
  const instrumented = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const evaluate = instrumented.createFixedBodyEvaluator(calibration);
  const verify = (input, count) => {
    const output = evaluate(input);
    assert.equal(instrumented.readTwistCalls(), count);
    return output;
  };
  verify({}, 2);
  verify({ PARAM_BODY_ANGLE_X: 4.7, PARAM_ARM_L_01_002: 31.8 }, 2);
  assert.deepStrictEqual(verify(hands({}, {}), 2).diagnostics.hiddenHands, ['Left', 'Right']);
  const a = hands({ '02': .2 }, { '01': 1 });
  verify(a, 3); verify({ ...a, PARAM_ANGLE_X: 9.3 }, 3);
  verify({ ...a, [parameter('Left', '02')]: .2 + Number.EPSILON }, 4);
  const b = hands({ '02': .2 + Number.EPSILON }, { '07': 1 });
  verify(b, 5);
  verify({ ...b, [parameter('Left', '02')]: .7 }, 6);
  verify(b, 7); // Returning to A recalculates: no history of earlier keys.
  const other = instrumented.createFixedBodyEvaluator(calibration);
  other(b); assert.equal(instrumented.readTwistCalls(), 9);
  verify(b, 9); // The second evaluator did not disturb the first one's entries.
});

test('center FK preserves exact poses and output bone order when parents follow children', () => {
  const random = randomGenerator(0x649e21ab);
  const orders = [
    bones => bones.reverse(),
    bones => bones.sort((a, b) => a.name.localeCompare(b.name)),
    bones => [...bones.slice(17), ...bones.slice(0, 17)],
  ];
  for (const [index, reorder] of orders.entries()) {
    const reordered = structuredClone(calibration);
    reordered.seed.bones = reorder(reordered.seed.bones);
    const actual = createFixedBodyEvaluator(reordered), reference = createReferenceEvaluator(reordered);
    for (let frame = 0; frame < 16; frame++) {
      const input = { ...hands({ '02': .19, '05': .37 }, { '03': .43 }), ...bodyParameters(random) };
      const output = actual(input);
      assertEquivalent(output, reference(input), `bone order ${index}, frame ${frame}`);
      assert.deepStrictEqual(Object.keys(output.rotations), reordered.seed.bones.map(bone => bone.name));
    }
  }
});

test('full neutral FK still rejects missing bones and cycles outside the center ancestors', () => {
  for (const [label, mutate] of [
    ['missing ancestor', bones => bones.filter(bone => bone.name !== 'UpperChest')],
    ['missing excluded parent', bones => {
      bones.find(bone => bone.name === 'LeftToes').parent = 'MissingToeParent';
      return bones;
    }],
    ['excluded cycle', bones => {
      bones.find(bone => bone.name === 'LeftToes').parent = 'LeftToes';
      return bones;
    }],
    ['ancestor cycle', bones => {
      bones.find(bone => bone.name === 'Chest').parent = 'LeftUpperArm';
      return bones;
    }],
  ]) {
    const invalid = structuredClone(calibration);
    invalid.seed.bones = mutate(invalid.seed.bones);
    let expected;
    assert.throws(() => createReferenceEvaluator(invalid), error => {
      expected = error;
      return /Missing reference bone|Cyclic reference skeleton/.test(error.message);
    }, label);
    assert.throws(() => createFixedBodyEvaluator(invalid), error =>
      error.constructor === expected.constructor && error.message === expected.message, label);
  }
});

test('per-frame center FK visits only the eight ancestors with unchanged per-bone results', async () => {
  const url = new URL('../src/garupa/body-mapping.mjs', import.meta.url);
  let source = await readFile(url, 'utf8');
  const anchor = 'orientSegment, standardToWorld, worldToStandard';
  assert.equal(source.split(anchor).length, 2);
  source = source.replace(anchor, 'orientSegment, standardToWorld as originalStandardToWorld, worldToStandard');
  source = source.replace(/from '([^']+)'/g, (_, specifier) =>
    `from '${specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)}'`);
  source += '\nconst fkCalls=[]; function standardToWorld(...args){'
    + 'const result=originalStandardToWorld(...args);fkCalls.push({bones:args[0],result});return result;}'
    + '\nexport const readFKCalls=()=>fkCalls;\n';
  const instrumented = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const evaluate = instrumented.createFixedBodyEvaluator(calibration);
  assert.equal(instrumented.readFKCalls().length, 1);
  assert.strictEqual(instrumented.readFKCalls()[0].bones, calibration.seed.bones);
  const input = { ...hands({ '02': .17, '06': .53 }, { '07': .43 }), ...bodyParameters(randomGenerator()) };
  const output = evaluate(input);
  const calls = instrumented.readFKCalls();
  assert.equal(calls.length, 2);
  const expectedNames = ['Hips', 'Spine', 'Chest', 'LeftShoulder', 'RightShoulder',
    'LeftUpperArm', 'RightUpperArm', 'UpperChest'];
  assert.deepStrictEqual(calls[1].bones.map(bone => bone.name), expectedNames);
  assert.deepStrictEqual(calls[1].bones, calibration.seed.bones.filter(bone => expectedNames.includes(bone.name)));
  const full = standardToWorld(calibration.seed.bones, output.rotations,
    calibration.seed.hands['01'].hipsTranslation, calibration.seed.humanScale);
  for (const name of expectedNames) assert.deepStrictEqual(calls[1].result[name], full[name], name);
  evaluate({ ...input, PARAM_BODY_ANGLE_X: 7.13 });
  assert.strictEqual(calls[2].bones, calls[1].bones, 'the ancestor list is compiled once per evaluator');
});

test('finger overrides retain world deformation for non-finger children in either bone order', () => {
  const random = randomGenerator(0x632dc718);
  for (const reversed of [false, true]) {
    const altered = structuredClone(calibration);
    const finger = altered.seed.bones.find(bone => bone.name.startsWith('LeftIndex')).name;
    altered.seed.bones.find(bone => bone.name === 'LeftToes').parent = finger;
    if (reversed) altered.seed.bones.reverse();
    const actual = createFixedBodyEvaluator(altered), reference = createReferenceEvaluator(altered);
    for (let frame = 0; frame < 32; frame++) {
      const input = { ...hands({ '03': .29, '05': .43 }, { '07': .37 }), ...bodyParameters(random) };
      assertEquivalent(actual(input), reference(input), `finger parent reversed=${reversed}, frame=${frame}`);
    }
  }
});

test('world-to-standard overrides skip joint conversion, preserve parent deformation and copy output arrays', () => {
  const bones = structuredClone(calibration.seed.bones);
  const finger = bones.find(bone => bone.name.startsWith('LeftIndex'));
  bones.find(bone => bone.name === 'LeftToes').parent = finger.name;
  const world = calibration.seed.hands['03'].worldRotations;
  const expected = worldToStandard(bones, world);
  const replacement = [.17, -.23, .31, .89];
  const overrides = { [finger.name]: replacement };
  // An overridden joint frame is never read, but its bind rotation and world
  // deformation must still be evaluated for its non-overridden child.
  Object.defineProperty(finger, 'jointFrame', { get() { throw new Error('unused joint conversion'); } });
  const actual = worldToStandard(bones, world, overrides);
  assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));
  for (const bone of bones) assert.deepStrictEqual(actual[bone.name],
    bone.name === finger.name ? replacement : expected[bone.name], bone.name);
  assert.notStrictEqual(actual[finger.name], replacement);
  actual[finger.name].fill(999);
  assert.deepStrictEqual(replacement, [.17, -.23, .31, .89]);
  assert.deepStrictEqual(worldToStandard(bones, world, overrides)[finger.name], replacement);
});

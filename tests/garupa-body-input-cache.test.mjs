import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import calibration from '../src/garupa/body-calibration.js';
import {createFixedBodyEvaluator} from '../src/garupa/body-mapping.mjs';
import {createFixedBodyEvaluator as referenceEvaluator} from './fixtures/body-mapping-before-hand-cache.mjs';
import {standardToWorld} from '../src/garupa/body-joint-space.mjs';
import {Quaternion} from 'three';

function assertPreservedPose(actual, reference, data = calibration) {
  assert.deepStrictEqual(actual.hipsTranslation, reference.hipsTranslation);
  assert.deepStrictEqual(actual.diagnostics, reference.diagnostics);
  for (const name of Object.keys(actual.rotations)) {
    if (!/^(Left|Right)(UpperArm|LowerArm|Hand)$/.test(name))
      assert.deepStrictEqual(actual.rotations[name], reference.rotations[name], name);
  }
  if (!Object.values(actual.rotations).flat().every(Number.isFinite)) return;
  const a = standardToWorld(data.seed.bones, actual.rotations, actual.hipsTranslation, data.seed.humanScale);
  const b = standardToWorld(data.seed.bones, reference.rotations, reference.hipsTranslation, data.seed.humanScale);
  for (const side of ['Left', 'Right']) assert.ok(new Quaternion().fromArray(a[side+'Hand'].rotation)
    .angleTo(new Quaternion().fromArray(b[side+'Hand'].rotation)) < 1e-7, `${side} world palm`);
}

async function instrumentedModule() {
  const url=new URL('../src/garupa/body-mapping.mjs',import.meta.url);
  let source=await readFile(url,'utf8');
  const anchor='export function interpolateCurve(samples,value) {';
  assert.equal(source.split(anchor).length,2);
  source=source.replace(anchor,`${anchor}\n calls.push({samples,value});`);
  source=source.replace(/from '([^']+)'/g,(_,id)=>
    `from '${id.startsWith('.')?new URL(id,url).href:import.meta.resolve(id)}'`);
  source+='\nconst calls=[]; export function takeCalls(){return calls.splice(0);}\n';
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('head layers and independent body/arm inputs invalidate only their own last result',async()=>{
  const module=await instrumentedModule(),evaluate=module.createFixedBodyEvaluator(calibration);
  module.takeCalls();
  const p={...calibration.defaults,PARAM_ANGLE_X:0,PARAM_ANGLE_Y:0,PARAM_BODY_ANGLE_X:0};
  evaluate(p);
  assert.equal(module.takeCalls().length,26);
  evaluate({...p,PARAM_MOUTH_OPEN_Y:.71,PARAM_EYE_L_OPEN:.2});
  assert.equal(module.takeCalls().length,0,'face inputs do not invalidate body curves');
  p.PARAM_ANGLE_X=7.125;evaluate(p);
  assert.equal(module.takeCalls().length,1,'X alone reuses all seven Y rows');
  p.PARAM_ANGLE_Y=-4.375;evaluate(p);
  assert.equal(module.takeCalls().length,8,'Y updates seven rows and final interpolation');
  p.PARAM_BREATH=.234;evaluate(p);
  assert.deepStrictEqual(module.takeCalls().map(c=>c.samples),[calibration.bodyCurves.find(c=>c.id==='PARAM_BREATH').samples]);
  p.PARAM_ARM_L_01_001=11.125;evaluate(p);
  assert.deepStrictEqual(module.takeCalls().map(c=>c.samples),[calibration.arms.Left.curves.upper.samples]);
  p.PARAM_ARM_L_01_002=14.25;evaluate(p);
  assert.deepStrictEqual(module.takeCalls().map(c=>c.samples),[
    calibration.arms.Left.curves.lower.samples,calibration.arms.Left.curves.lower.segments]);
  p.PARAM_ARM_R_01_003=3.125;evaluate(p);
  assert.deepStrictEqual(module.takeCalls().map(c=>c.samples),[calibration.arms.Right.curves.wrist.samples]);
  p.PARAM_BODY_ANGLE_X=-0;evaluate(p);
  assert.equal(module.takeCalls().length,2,'signed zero invalidates body response and yaw');
  p.PARAM_BODY_ANGLE_X=Number.MIN_VALUE;evaluate(p);
  assert.equal(module.takeCalls().length,2,'tiny changes are not rounded away');
  p.PARAM_BODY_ANGLE_X=-0;evaluate(p);
  assert.equal(module.takeCalls().length,2,'A-B-A recomputes: only one entry per curve');
  evaluate(p);assert.equal(module.takeCalls().length,0);
  const second=module.createFixedBodyEvaluator(calibration);
  second(p);assert.equal(module.takeCalls().length,26,'evaluator caches are independent');
  evaluate(p);assert.equal(module.takeCalls().length,0);
});

test('4096 changing, repeated and defaulted inputs match fresh evaluators and preserve non-arm semantics',()=>{
  const actual=createFixedBodyEvaluator(calibration),reference=referenceEvaluator(calibration);
  let seed=0x4182ab3d;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)+.5)/4294967296;
  const curves=[...calibration.bodyCurves,...Object.values(calibration.arms).flatMap(a=>Object.values(a.curves))];
  let input={};
  for(let frame=0;frame<4096;frame++) {
    if(frame%16===0)input={};
    else if(frame%4===0) {
      for(const curve of curves)input[curve.id]=curve.samples[0][0]+random()*(curve.samples.at(-1)[0]-curve.samples[0][0]);
      input.PARAM_ANGLE_X=-30+60*random();input.PARAM_ANGLE_Y=-30+60*random();
      for(const side of ['L','R']) {
        input[`PARAM_ARM_${side}_CHANGE`]=random();
        input[`PARAM_HAND_${side}_01_001`]=.17;
        input[`PARAM_HAND_${side}_03_001`]=random()*.23;
      }
    } else if(frame%4===1)input.PARAM_BREATH=random();
    else if(frame%4===2)input.PARAM_ANGLE_X=-30+60*random();
    else input.PARAM_MOUTH_OPEN_Y=random();
    const output=actual(input),expected=createFixedBodyEvaluator(calibration)(input);
    assert.deepStrictEqual(output,expected,`frame ${frame}`);
    assert.deepStrictEqual(Object.keys(output.rotations),Object.keys(expected.rotations));
    assertPreservedPose(output,reference(input));
  }
});

test('cached outputs stay private, calibration instances stay isolated, and special inputs remain exact',()=>{
  const altered=structuredClone(calibration);
  altered.bodyCurves[0].samples[2][1][0]+=.031;
  altered.head.samples[0].angles[0]+=.137;
  altered.arms.Left.curves.lower.segments[0][1][1]+=.017;
  const evaluators=[createFixedBodyEvaluator(calibration),createFixedBodyEvaluator(altered)];
  const references=[referenceEvaluator(calibration),referenceEvaluator(altered)];
  const inputs=[{}, {PARAM_ANGLE_X:-30,PARAM_ANGLE_Y:-30,PARAM_ANGLE_Z:-15,PARAM_ARM_L_01_002:0},
    {PARAM_BODY_ANGLE_X:-0,PARAM_ANGLE_X:-0,PARAM_ANGLE_Y:-0,PARAM_ARM_L_01_002:-0},
    {PARAM_BODY_ANGLE_X:Number.MIN_VALUE,PARAM_ANGLE_X:Number.EPSILON,PARAM_ANGLE_Y:Number.MIN_VALUE},
    {PARAM_ANGLE_X:NaN,PARAM_ANGLE_Y:NaN,PARAM_BODY_ANGLE_X:NaN},
    {PARAM_ANGLE_X:Infinity,PARAM_ANGLE_Y:-Infinity},{}];
  for(const input of inputs)for(let index=0;index<2;index++) {
    const evaluate=evaluators[index],data=index ? altered : calibration;
    const expected=createFixedBodyEvaluator(data)(input);
    const first=evaluate(input),second=evaluate({...input});
    assert.deepStrictEqual(first,expected);assert.deepStrictEqual(second,expected);
    assertPreservedPose(first,references[index](input),data);
    for(const [name,rotation]of Object.entries(first.rotations)) {
      assert.notStrictEqual(rotation,second.rotations[name]);rotation.fill(42);
    }
    first.hipsTranslation.fill(42);first.diagnostics.hiddenHands.push('mutation');
    assert.deepStrictEqual(second,expected);
    assert.deepStrictEqual(evaluate(input),expected);
  }
});

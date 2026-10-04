import test from 'node:test';
import assert from 'node:assert/strict';
import {Quaternion,Vector3} from 'three';
import {createArmDepthAdjustment} from '../src/garupa/body-arm-depth.mjs';
import calibration from '../src/garupa/body-calibration.js';
import {createFixedBodyEvaluator} from '../src/garupa/body-mapping.mjs';
import {standardToWorld} from '../src/garupa/body-joint-space.mjs';
import {createFixedBodyEvaluator as referenceEvaluator} from './fixtures/body-mapping-before-hand-cache.mjs';

const identity=[0,0,0,1];
function fixture(scale=1,rightX=0) {
  const bones=[];
  for(const [side,sign] of [['Left',1],['Right',-1]]) {
    const offset=side==='Right'?rightX:0;
    const points=[[sign*.15+offset,.3,0],[sign*.1+offset,0,.04],[-sign*.1+offset,.15,.07]];
    for(const [i,part] of ['UpperArm','LowerArm','Hand'].entries()) bones.push({
      name:side+part,parent:i?side+['UpperArm','LowerArm'][i-1]:null,
      position:points[i].map(value=>value*scale),rotation:identity.slice(),
    });
  }
  return {bones,world:Object.fromEntries(bones.map(bone=>[bone.name,identity.slice()]))};
}
const q=a=>new Quaternion().fromArray(a);
const v=a=>new Vector3().fromArray(a);

test('overlapping fronts advance the source-nearer upper arm with a shortest swing only',()=>{
  for(const [left,right,front] of [[0,0,'Left'],[.0001,0,'Left'],[.4,0,'Right']]) {
    const {bones,world}=fixture(),before=structuredClone(world);
    createArmDepthAdjustment(bones)(world,left,right);
    const name=front+'UpperArm';
    assert.ok(q(world[name]).angleTo(q(before[name]))>0);
    for(const bone of bones)if(bone.name!==name)assert.deepEqual(world[bone.name],before[bone.name]);
    const S=v(bones.find(b=>b.name===name).position);
    const E=v(bones.find(b=>b.name===front+'LowerArm').position);
    const original=E.sub(S),changed=original.clone().applyQuaternion(q(world[name]));
    const swing=new Quaternion().setFromUnitVectors(original.clone().normalize(),changed.clone().normalize());
    assert.ok(swing.angleTo(q(world[name]))<1e-7,'no additional axial roll');
    const increment=changed.z/changed.length()-original.z/original.length();
    assert.ok(increment>0&&increment<=.12+1e-12);
    assert.ok(Math.abs(original.length()-changed.length())<1e-12);
  }
});

test('separated projections and a rear arm leave all world rotations untouched',()=>{
  for(const [offset,left,right]of [[1,0,0],[0,1,0],[0,0,1],[0,1,1]]) {
    const {bones,world}=fixture(1,offset),before=structuredClone(world);
    createArmDepthAdjustment(bones)(world,left,right);
    assert.deepEqual(world,before);
  }
});

test('uniform scale and bone declaration order do not affect the depth adjustment',()=>{
  const base=fixture();createArmDepthAdjustment(base.bones)(base.world,0,0);
  for(const scale of [.001,.1,2,100]) {
    const f=fixture(scale);f.bones.reverse();createArmDepthAdjustment(f.bones)(f.world,0,0);
    for(const name of Object.keys(f.world))assert.ok(q(f.world[name]).angleTo(q(base.world[name]))<1e-7);
  }
});

test('degenerate chains stay finite and independent authored frames do not accumulate',()=>{
  const zero=fixture(0);createArmDepthAdjustment(zero.bones)(zero.world,0,0);
  assert.ok(Object.values(zero.world).flat().every(Number.isFinite));
  const f=fixture(),adjust=createArmDepthAdjustment(f.bones),original=structuredClone(f.world);
  adjust(f.world,0,0);const expected=structuredClone(f.world);
  for(let i=0;i<20;i++) {
    const frame=structuredClone(original);adjust(frame,0,0);assert.deepEqual(frame,expected);
  }
});

test('seven hand templates and body yaw preserve palms, finger rotations, hips and non-arm bones',()=>{
  const evaluate=createFixedBodyEvaluator(calibration),reference=referenceEvaluator(calibration);
  const ids=Object.keys(calibration.seed.hands);
  for(const yaw of [-30,-15,0,15,30])for(const left of ids)for(const right of ids) {
    const p={PARAM_BODY_ANGLE_X:yaw,PARAM_ARM_L_01_002:24,PARAM_ARM_R_01_002:27};
    for(const [side,active]of [['L',left],['R',right]])for(const id of ids)
      p[`PARAM_HAND_${side}_${side==='R'&&id==='07'?'09':id}_001`]=Number(id===active);
    const a=evaluate(p),b=reference(p);
    assert.deepEqual(a.hipsTranslation,b.hipsTranslation);
    for(const name of Object.keys(a.rotations))if(!/^(Left|Right)(UpperArm|LowerArm|Hand)$/.test(name))
      assert.deepEqual(a.rotations[name],b.rotations[name]);
    const afk=standardToWorld(calibration.seed.bones,a.rotations,a.hipsTranslation,calibration.seed.humanScale);
    const bfk=standardToWorld(calibration.seed.bones,b.rotations,b.hipsTranslation,calibration.seed.humanScale);
    for(const side of ['Left','Right'])assert.ok(q(afk[side+'Hand'].rotation).angleTo(q(bfk[side+'Hand'].rotation))<1e-7);
  }
});

test('order buckets and front thresholds do not introduce finite pose jumps',()=>{
  const evaluate=createFixedBodyEvaluator(calibration);
  const base={PARAM_ARM_L_01_002:20,PARAM_ARM_R_01_002:20};
  const boundaries=[.0001,.00010001,.08,.70,.7971428632736206];
  for(const boundary of boundaries)for(const right of [0,.1,.7]) {
    const a=evaluate({...base,PARAM_ARM_L_CHANGE:boundary-1e-8,PARAM_ARM_R_CHANGE:right});
    const b=evaluate({...base,PARAM_ARM_L_CHANGE:boundary+1e-8,PARAM_ARM_R_CHANGE:right});
    for(const name of Object.keys(a.rotations))assert.ok(q(a.rotations[name]).angleTo(q(b.rotations[name]))<1e-5,
      `${name} at left=${boundary}, right=${right}`);
  }
});

test('near-parallel forearms keep stable depth through the idle-to-kandou blend',()=>{
  // anon/idle01 end -> anon/kandou02 start, blend .67548 -> .67550.
  // Closest-point distance barely changes, while its interpolated Z can move
  // from one end of the forearm to the other; depth must not follow that point.
  const from={PARAM_ARM_L_01_001:19.8678,PARAM_ARM_L_01_002:21.18540452,PARAM_ARM_L_CHANGE:.32452,
    PARAM_ARM_R_01_001:16.13284904,PARAM_ARM_R_01_002:18.93988,PARAM_ARM_R_CHANGE:0,
    PARAM_BODY_ANGLE_X:3.35096,PARAM_BODY_ANGLE_Y:-.8713692,PARAM_BODY_ANGLE_Z:-2.69541988,
    PARAM_UPPER_BODY:.0067548,PARAM_ROTATION_Z:0};
  const to={PARAM_ARM_L_01_001:19.8675,PARAM_ARM_L_01_002:21.1858245,PARAM_ARM_L_CHANGE:.3245,
    PARAM_ARM_R_01_001:16.133149,PARAM_ARM_R_01_002:18.9405,PARAM_ARM_R_CHANGE:0,
    PARAM_BODY_ANGLE_X:3.351,PARAM_BODY_ANGLE_Y:-.871395,PARAM_BODY_ANGLE_Z:-2.6954405,
    PARAM_UPPER_BODY:.006755,PARAM_ROTATION_Z:0};
  const evaluate=createFixedBodyEvaluator(calibration),a=evaluate(from),b=evaluate(to);
  for(const name of ['LeftUpperArm','LeftLowerArm','RightUpperArm','RightLowerArm'])
    assert.ok(q(a.rotations[name]).angleTo(q(b.rotations[name])) < .01*Math.PI/180,name);
});


test('lowered front hands gain waist clearance while raised and rear arms retain their depth',()=>{
  const evaluate=createFixedBodyEvaluator(calibration);
  const frame=(lower,change=0)=>{
    const pose=evaluate({PARAM_ARM_L_01_002:lower,PARAM_ARM_L_CHANGE:change,PARAM_ARM_R_CHANGE:1});
    const world=standardToWorld(calibration.seed.bones,pose.rotations,pose.hipsTranslation,calibration.seed.humanScale);
    const upper=v(world.LeftLowerArm.position).sub(v(world.LeftUpperArm.position));
    const forearm=v(world.LeftHand.position).sub(v(world.LeftLowerArm.position));
    return {pose,depth:upper.z/upper.length(),downward:-forearm.y/Math.hypot(forearm.x,forearm.y)};
  };
  for(const [lower,change,depth]of [[0,0,.55],[30,0,.45],[0,1,-.18]])
    assert.ok(Math.abs(frame(lower,change).depth-depth)<1e-12);
  for(const boundary of [.35,.85]) {
    let low=10,high=20;
    for(let i=0;i<45;i++) {
      const middle=(low+high)/2;
      if(frame(middle).downward>boundary)low=middle;else high=middle;
    }
    const at=(low+high)/2,a=frame(at-1e-7),b=frame(at+1e-7);
    assert.ok(Math.abs(frame(at).downward-boundary)<1e-10);
    for(const name of Object.keys(a.pose.rotations))
      assert.ok(q(a.pose.rotations[name]).angleTo(q(b.pose.rotations[name]))<1e-6,`${name} at down=${boundary}`);
  }
});

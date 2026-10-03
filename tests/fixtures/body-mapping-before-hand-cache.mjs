// Test-only numerical oracle: body-mapping.mjs at dbe9a538e77205d8c8c93e7c0741bc34eb1c7c46.
// Original SHA-256: b0efeaa5d14074469213c20c8d099c11749667d63966b4db2890abd313301854.
// Only the two relative dependency imports were relocated for this fixture.
// Shared authoring rules. Source curves are measured offline; depth is an
// explicit shared 3D convention. No model, motion identity, fitting, or Unity.
import {Quaternion, Vector3} from 'three';
import {blendRotations, orientSegment, standardToWorld, worldToStandard} from '../../src/garupa/body-joint-space.mjs';
import {distributeArmTwist} from '../../src/garupa/body-arm-twist.mjs';

const radians = d => d*Math.PI/180;
const quat = a => new Quaternion().fromArray(a).normalize();
const vec = a => new Vector3().fromArray(a);
const turn = (axis, degrees) => new Quaternion().setFromAxisAngle(vec(axis),radians(degrees));
const zTurn = degrees => turn([0,0,1],degrees);
const difference = (a,b) => a.map((v,i)=>v-b[i]);

export function interpolateCurve(samples,value) {
  let i=0;
  while(i<samples.length-2&&samples[i+1][0]<value)i++;
  const [x,a]=samples[i],[y,b]=samples[i+1];
  const t=Math.max(0,Math.min(1,(value-x)/(y-x)));
  return Array.isArray(a)?a.map((v,k)=>v+(b[k]-v)*t):a+(b-a)*t;
}

function headAngles(table,x,y) {
  const alongX=table.axis.map(a=>[a,interpolateCurve(table.samples.filter(s=>s.input[0]===a)
    .map(s=>[s.input[1],s.angles]),y)]);
  return interpolateCurve(alongX,x);
}

export function createFixedBodyEvaluator(calibration) {
  const {seed}=calibration,bones=seed.bones,neutral=seed.hands['01'];
  const metadata=Object.fromEntries(bones.map(b=>[b.name,b]));
  const neutralFK=standardToWorld(bones,neutral.rotations,neutral.hipsTranslation,seed.humanScale);
  const center = pose => vec(pose.LeftUpperArm.position).add(vec(pose.RightUpperArm.position)).multiplyScalar(.5);
  const shoulderWidth=vec(neutralFK.LeftUpperArm.position).distanceTo(vec(neutralFK.RightUpperArm.position));
  const armReferences=Object.fromEntries(['Left','Right'].map(side=>[side,Object.fromEntries(Object.entries(seed.hands).map(([id,pose])=>{
    const upper=quat(pose.worldRotations[side+'UpperArm']),lower=quat(pose.worldRotations[side+'LowerArm']);
    return [id,{upper:upper.toArray(),lower:upper.clone().invert().multiply(lower).toArray(),
      hand:lower.clone().invert().multiply(quat(pose.worldRotations[side+'Hand'])).toArray()}];
  }))]));
  return input => {
    const p={...calibration.defaults,...input};
    const response={};
    for(const curve of calibration.bodyCurves)response[curve.id]=interpolateCurve(curve.samples,p[curve.id]);
    const total=Array(8).fill(0);
    for(const r of Object.values(response))r.forEach((v,i)=>{total[i]+=v;});
    const globalRoll=-(response.PARAM_ROTATION_Z?.[4]??0);
    const bodyRoll=-total[4],headRoll=-total[5];
    const bodyYaw=interpolateCurve(calibration.bodyYaw,p.PARAM_BODY_ANGLE_X);
    const torso=zTurn(bodyRoll).multiply(turn([0,1,0],bodyYaw)),global=zTurn(globalRoll);
    const [yaw,pitch]=headAngles(calibration.head,p.PARAM_ANGLE_X,p.PARAM_ANGLE_Y);
    const head=zTurn(headRoll).multiply(turn([0,1,0],yaw)).multiply(turn([1,0,0],pitch));
    const world={};
    for(const bone of bones) {
      const upper=['Spine','Chest','UpperChest','Neck','Head'].includes(bone.name)||/^(Left|Right)(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(bone.name);
      const movement=bone.name==='Head'?head:upper?torso:global;
      world[bone.name]=movement.clone().multiply(quat(neutral.worldRotations[bone.name])).toArray();
    }
    const fingerRotations={},diagnostics={hiddenHands:[],depthConvention:'shared-front-back'};
    for(const side of ['Left','Right']) {
      const arm=calibration.arms[side],code=side[0];
      let active=Object.keys(seed.hands).map(id=>({id,weight:Math.max(0,p[`PARAM_HAND_${code}_${side==='Right'&&id==='07'?'09':id}_001`]??0)})).filter(e=>e.weight>0);
      const totalHandWeight=active.reduce((sum,e)=>sum+e.weight,0);
      if(!totalHandWeight)diagnostics.hiddenHands.push(side);
      // We cannot hide the hand in the standard skeletal motion. Complete
      // missing image opacity with the neutral hand continuously; normalizing
      // a tiny incoming weight to 100% would jump from the all-zero fallback.
      if(totalHandWeight<1) {
        const neutralHand=active.find(e=>e.id==='01');
        if(neutralHand)neutralHand.weight+=1-totalHandWeight;
        else active.unshift({id:'01',weight:1-totalHandWeight});
      }
      // Mix the approved arm chain in parent-relative space. Independently
      // mixing world hand/forearm rotations can choose opposite shortest arcs.
      const referenceUpper=quat(blendRotations(active.map(({id,weight})=>({weight,rotation:armReferences[side][id].upper}))));
      const referenceLower=referenceUpper.clone().multiply(quat(blendRotations(active.map(({id,weight})=>({weight,rotation:armReferences[side][id].lower})))));
      const handReference=referenceLower.clone().multiply(quat(blendRotations(active.map(({id,weight})=>({weight,rotation:armReferences[side][id].hand})))));
      const referenceChain={
        [metadata[side+'UpperArm'].parent]:neutral.worldRotations[metadata[side+'UpperArm'].parent],
        [side+'UpperArm']:referenceUpper.toArray(),[side+'LowerArm']:referenceLower.toArray(),[side+'Hand']:handReference.toArray(),
      };
      distributeArmTwist(metadata,referenceChain,side);
      referenceUpper.fromArray(referenceChain[side+'UpperArm']);
      referenceLower.fromArray(referenceChain[side+'LowerArm']);
      const delta=Object.fromEntries(Object.entries(arm.curves).map(([part,c])=>[part,interpolateCurve(c.samples,p[c.id])]));
      const bodyArm=total[side==='Right'?6:7];
      const angleUpper=-(delta.upper+bodyArm);
      const change=p[`PARAM_ARM_${code}_CHANGE`];
      // CHANGE is draw order, not depth. This continuous depth choice is a
      // 3D authoring approximation; its silhouette must be visually verified.
      const crossing=Math.max(0,Math.min(1,(change-.74)/.20));
      const back=crossing*crossing*(3-2*crossing);
      const depthSign=1-2*back;
      const direction=(part,angle,depth)=>{
        const [x,y]=arm.directions[part],planar=new Vector3(x,y,0).normalize().applyQuaternion(zTurn(angle));
        return planar.multiplyScalar(Math.sqrt(1-depth*depth)).add(new Vector3(0,0,depth)).toArray();
      };
      const measured=interpolateCurve(arm.curves.lower.segments,p[arm.curves.lower.id]);
      const baseAngle=Math.atan2(arm.directions.lower[1],arm.directions.lower[0]);
      const segmentTurn=Math.atan2(-measured[1],measured[0])-baseAngle;
      const actualLowerAngle=-(delta.upper+bodyArm)+segmentTurn*180/Math.PI;
      const lowerDepth=Math.sqrt(Math.max(.04,1-Math.min(1,measured[2])**2));
      // Transport each approved template's arm twist along the authored
      // planar angle. An elbow-plane cross product is singular at straight
      // arms and would invent a 180-degree roll when the source crosses it.
      // Keeping template 01 arms for all hands would dump the other templates'
      // forearm twist into the wrist, even though the hand world pose is right.
      for(const [part,bone,child,angle,depth]of [
        ['upper','UpperArm','LowerArm',angleUpper,.18*depthSign],
        ['lower','LowerArm','Hand',actualLowerAngle,lowerDepth*depthSign]]) {
        const desired=direction(part,0,depth);
        const referenceRotation=part==='upper'?referenceUpper:referenceLower;
        const localDirection=vec(difference(metadata[side+child].position,metadata[side+bone].position))
          .applyQuaternion(quat(metadata[side+bone].rotation).invert());
        const referenceDirection=localDirection.applyQuaternion(referenceRotation).toArray();
        world[side+bone]=zTurn(angle).multiply(quat(orientSegment(referenceRotation.toArray(),referenceDirection,desired))).toArray();
      }
      const handRoll=-(delta.upper+delta.lower+delta.wrist+bodyArm);
      world[side+'Hand']=zTurn(handRoll).multiply(handReference).toArray();
      for(const bone of bones.filter(b=>b.name.startsWith(side)&&/(Thumb|Index|Middle|Ring|Little)/.test(b.name)))
        fingerRotations[bone.name]=blendRotations(active.map(e=>({weight:e.weight,rotation:seed.hands[e.id].rotations[bone.name]})));
    }
    const rotations={...worldToStandard(bones,world),...fingerRotations};
    const fk=standardToWorld(bones,rotations,neutral.hipsTranslation,seed.humanScale);
    // One common translation moves both shoulders and head. It never adds
    // independent clavicle shrug or per-bone translations.
    const rootResponse=response.PARAM_ROTATION_Z;
    const localShift=new Vector3(total[0]-rootResponse[0],-(total[1]-rootResponse[1]),0).applyQuaternion(global);
    const desired=center(neutralFK).add(localShift.add(new Vector3(rootResponse[0],-rootResponse[1],0)).multiplyScalar(shoulderWidth));
    const correction=desired.sub(center(fk)).multiplyScalar(1/seed.humanScale);
    const hipsTranslation=vec(neutral.hipsTranslation).add(correction).toArray();
    return {rotations,hipsTranslation,diagnostics};
  };
}

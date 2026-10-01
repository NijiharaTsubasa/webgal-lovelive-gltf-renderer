// Shared 3D authoring convention, not a Unity muscle solver: two axial
// degrees of freedom preserve the three segment endpoints and hand facing.
import {Quaternion,Vector3} from 'three';

const q=a=>new Quaternion().fromArray(a).normalize();
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const unwrap=(a,near)=>near+wrap(a-near);

/** Equalize anatomical X twist on the reference arm, before source motion.
 * Joint X measures roll; actual bone segments define the two rotation axes
 * so rounding in Avatar frames cannot move the elbow/wrist. The hand is fixed.
 * Angle continuation follows the input reference branch, never playback state.
 */
export function distributeArmTwist(metadata,world,side) {
  const names=['UpperArm','LowerArm','Hand'].map(p=>side+p);
  const bones=names.map(n=>metadata[n]);
  const frames=bones.map(b=>q(b.jointFrame));
  const rest=bones.map(b=>q(b.rotation));
  const base=names.map((n,i)=>q(world[n]).multiply(rest[i].clone().invert()));
  const parent=metadata[bones[0].parent];
  const parentD=q(world[parent.name]).multiply(q(parent.rotation).invert());
  const axes=bones.slice(0,2).map((b,i)=>new Vector3().fromArray(b.position)
    .sub(new Vector3().fromArray(bones[i+1].position)).normalize().applyQuaternion(base[i]));
  const evaluate=(angles,near)=>{
    const d=base.map((v,i)=>i<2?new Quaternion().setFromAxisAngle(axes[i],angles[i]).multiply(v):v.clone());
    const twist=d.map((v,i)=>{
      const local=frames[i].clone().invert().multiply((i?d[i-1]:parentD).clone().invert()).multiply(v).multiply(frames[i]);
      const a=2*Math.atan2(local.x,local.w);
      return near?unwrap(a,near[i]):wrap(a);
    });
    return {d,twist,error:[twist[0]-twist[1],twist[1]-twist[2]]};
  };
  let angles=[0,0],state=evaluate(angles);
  for(let iteration=0;iteration<8;iteration++) {
    const [a,b]=state.error;
    if(Math.max(Math.abs(a),Math.abs(b))<1e-7)break;
    const h=1e-4;
    const x=evaluate([angles[0]+h,angles[1]],state.twist),y=evaluate([angles[0],angles[1]+h],state.twist);
    const j00=(x.error[0]-a)/h,j10=(x.error[1]-b)/h,j01=(y.error[0]-a)/h,j11=(y.error[1]-b)/h;
    const det=j00*j11-j01*j10;
    if(Math.abs(det)<1e-8)break;
    let dx=(-a*j11+j01*b)/det,dy=(-j00*b+j10*a)/det;
    const scale=Math.min(1,(Math.PI/4)/Math.max(Math.abs(dx),Math.abs(dy)));
    dx*=scale;dy*=scale;
    angles=[angles[0]+dx,angles[1]+dy];state=evaluate(angles,state.twist);
  }
  for(let i=0;i<2;i++)world[names[i]]=state.d[i].multiply(rest[i]).normalize().toArray();
  return Math.max(...state.error.map(Math.abs));
}

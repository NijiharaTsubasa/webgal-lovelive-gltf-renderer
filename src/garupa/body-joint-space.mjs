// Shared coordinates only, not a Humanoid muscle solver. All arrays use glTF axes.
import { Quaternion, Vector3 } from 'three';

const q = value => new Quaternion().fromArray(value).normalize();
const v = value => new Vector3().fromArray(value);

/** World rotations on the reference rig -> the existing anatomical joint basis. */
export function worldToStandard(bones, worldRotations) {
  const deformations = Object.fromEntries(bones.map(b =>
    [b.name, q(worldRotations[b.name]).multiply(q(b.rotation).invert())]));
  return Object.fromEntries(bones.map(b => {
    const frame = q(b.jointFrame);
    const parent = b.parent ? deformations[b.parent] : new Quaternion();
    return [b.name, frame.clone().invert().multiply(parent.clone().invert())
      .multiply(deformations[b.name]).multiply(frame).normalize().toArray()];
  }));
}

/** Diagnostic forward kinematics, same right-multiplied joint-frame contract. */
export function standardToWorld(bones, rotations, hipsTranslation = [0, 0, 0], humanScale = 1) {
  const metadata = new Map(bones.map(b => [b.name, b]));
  const result = {}, visiting = new Set();
  function visit(name) {
    if (result[name]) return result[name];
    if (visiting.has(name)) throw new Error(`Cyclic reference skeleton: ${name}`);
    const bone = metadata.get(name);
    if (!bone) throw new Error(`Missing reference bone: ${name}`);
    visiting.add(name);
    const parent = bone.parent ? visit(bone.parent) : null;
    const parentDeformation = parent ? q(parent.deformation) : new Quaternion();
    const frame = q(bone.jointFrame);
    const deformation = parentDeformation.clone().multiply(frame)
      .multiply(q(rotations[name] ?? [0, 0, 0, 1])).multiply(frame.clone().invert());
    const position = parent
      ? v(bone.position).sub(v(metadata.get(bone.parent).position))
        .applyQuaternion(parentDeformation).add(v(parent.position))
      : v(bone.position).add(v(hipsTranslation).multiplyScalar(humanScale));
    result[name] = {position: position.toArray(),
      rotation: deformation.clone().multiply(q(bone.rotation)).normalize().toArray(),
      deformation: deformation.normalize().toArray()};
    visiting.delete(name);
    return result[name];
  }
  for (const bone of bones) visit(bone.name);
  return result;
}

/** Rotate a reference direction to a chosen direction, retaining reference twist. */
export function orientSegment(rotation, referenceDirection, desiredDirection) {
  if (Math.hypot(...referenceDirection) < 1e-8 || Math.hypot(...desiredDirection) < 1e-8)
    throw new Error('Segment orientation needs nonzero directions');
  return new Quaternion().setFromUnitVectors(v(referenceDirection).normalize(), v(desiredDirection).normalize())
    .multiply(q(rotation)).normalize().toArray();
}

export function blendRotations(entries) {
  const active = entries.filter(entry => entry.weight > 0);
  if (!active.length) throw new Error('Quaternion blend needs a positive weight');
  const result = q(active[0].rotation);
  let total = active[0].weight;
  for (const {rotation, weight} of active.slice(1)) {
    total += weight;
    result.slerp(q(rotation), weight / total);
  }
  return result.normalize().toArray();
}

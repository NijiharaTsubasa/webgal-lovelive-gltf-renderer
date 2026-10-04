import { Quaternion, Vector3 } from 'three';
import { orientSegment } from './body-joint-space.mjs';
import { ARM_BACK_TRANSITION } from './source-arm-order.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const vector = value => new Vector3().fromArray(value);
const rotation = value => new Quaternion().fromArray(value).normalize();
const smoothstep = (low, high, value) => {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
};

// A midpoint prior gives parallel projected segments a unique closest pair.
// One 2x2 solve and four edge candidates cover the bounded parameter square.
function projectedDistance(a, b, c, d) {
  const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
  const wx = a.x - c.x, wy = a.y - c.y;
  const uu = ux * ux + uy * uy, vv = vx * vx + vy * vy, uv = ux * vx + uy * vy;
  const regularizer = Math.max(uu, vv, 1e-20) * 1e-5;
  const aa = uu + regularizer, bb = vv + regularizer;
  const r0 = -(ux * wx + uy * wy) + regularizer * .5;
  const r1 = vx * wx + vy * wy + regularizer * .5;
  let bestCost = Infinity, distance = Infinity;
  const consider = (s, t) => {
    const dx = wx + s * ux - t * vx, dy = wy + s * uy - t * vy;
    const distanceSquared = dx * dx + dy * dy;
    const cost = distanceSquared + regularizer * ((s - .5) ** 2 + (t - .5) ** 2);
    if (cost < bestCost) {
      bestCost = cost; distance = Math.sqrt(distanceSquared);
    }
  };
  consider(0, clamp(r1 / bb, 0, 1));
  consider(1, clamp((r1 + uv) / bb, 0, 1));
  consider(clamp(r0 / aa, 0, 1), 0);
  consider(clamp((r0 + uv) / aa, 0, 1), 1);
  const determinant = aa * bb - uv * uv;
  const s = (r0 * bb + uv * r1) / determinant;
  const t = (aa * r1 + uv * r0) / determinant;
  if (s >= 0 && s <= 1 && t >= 0 && t <= 1) consider(s, t);
  return distance;
}

/** Shared front-view pose convention. Upper-arm depth blends between source
 * orders; forearm and palm world rotations remain authored. Geometry is never sampled.
 */
export function createArmDepthAdjustment(bones) {
  const metadata = Object.fromEntries(bones.map(bone => [bone.name, bone]));
  const records = new Map();
  function record(name) {
    if (records.has(name)) return records.get(name);
    const bone = metadata[name], parent = bone.parent ? record(bone.parent) : null;
    const entry = { name, parent,
      offset: parent ? vector(bone.position).sub(vector(metadata[bone.parent].position)) : vector(bone.position),
      parentInverse: parent ? rotation(metadata[bone.parent].rotation).invert() : null };
    records.set(name, entry);
    return entry;
  }
  const arms = ['Left', 'Right'].map(side => {
    const joints = ['UpperArm', 'LowerArm', 'Hand'].map(part => record(side + part));
    return { name: side + 'UpperArm', joints,
      upperLength: vector(metadata[side + 'UpperArm'].position).distanceTo(vector(metadata[side + 'LowerArm'].position)),
      lowerLength: vector(metadata[side + 'LowerArm'].position).distanceTo(vector(metadata[side + 'Hand'].position)) };
  });
  const radius = .4 * (arms[0].lowerLength + arms[1].lowerLength);
  return (world, leftChange = 0, rightChange = 0) => {
    const left = clamp(leftChange, 0, 1), right = clamp(rightChange, 0, 1);
    const frontGate = (1 - smoothstep(.70, ARM_BACK_TRANSITION, left))
      * (1 - smoothstep(.70, ARM_BACK_TRANSITION, right));
    if (!(frontGate > 0)) return;
    const positions = new Map();
    function position(entry) {
      if (positions.has(entry)) return positions.get(entry);
      const point = entry.offset.clone();
      if (entry.parent) point.applyQuaternion(rotation(world[entry.parent.name]).multiply(entry.parentInverse))
        .add(position(entry.parent));
      positions.set(entry, point);
      return point;
    }
    const points = arms.map(arm => arm.joints.map(position));
    const distance = projectedDistance(points[0][1], points[0][2], points[1][1], points[1][2]);
    const t = clamp((distance - radius * .5) / Math.max(1e-15, radius * .5), 0, 1);
    const gate = radius > 1e-12 ? 1 - t * t * (3 - 2 * t) : 0;
    // Near-parallel segments can move their closest point from wrist to elbow
    // over a tiny angle. Their center depths provide a stable ordering cue.
    const centerGap = (points[0][1].z + points[0][2].z - points[1][1].z - points[1][2].z) * .5;
    // Equal source orders favor the left hand. Geometric depth changes over
    // a small CHANGE interval: switching a whole finite offset at an integer
    // draw-order boundary would teleport both arms during motion blending.
    const rightWeight = smoothstep(.0001, .08, left - right);
    const weights = [1 - rightWeight, rightWeight];
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i], direction = points[i][1].clone().sub(points[i][0]);
      const depth = arm.upperLength > 1e-12 ? direction.z / arm.upperLength : 0;
      const capacity = Math.max(0, Math.min(.12, .85 - depth));
      const gap = i === 0 ? centerGap : -centerGap;
      const amount = arm.upperLength > 1e-12 ? frontGate * weights[i] * gate
        * Math.min(capacity, Math.max(0, radius * .35 - gap) / arm.upperLength) : 0;
      if (!(amount > 0)) continue;
      const z = clamp(depth + amount, -1, 1), planarLength = Math.hypot(direction.x, direction.y);
      const xy = arm.upperLength * Math.sqrt(Math.max(0, 1 - z * z));
      const desired = planarLength > 1e-12
        ? new Vector3(direction.x * xy / planarLength, direction.y * xy / planarLength, z * arm.upperLength)
        : new Vector3(0, -xy, z * arm.upperLength);
      world[arm.name] = orientSegment(world[arm.name], direction.toArray(), desired.toArray());
    }
  };
}

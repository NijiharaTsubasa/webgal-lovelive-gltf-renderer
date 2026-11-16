// Unity.Mathematics + MagicaCloth2 MathUtility, the subset the cloth solver uses.
// Vectors are [x, y, z] arrays, quaternions [x, y, z, w], float4x4 column-major Float64Array(16) / arrays.
// Everything follows the C# definitions (Unity.Mathematics 1.2 / MagicaCloth2 Utility/Math/MathUtility.cs);
// JavaScript computes in double precision where the source uses float.

export const EPSILON = 1e-8;                 // Define.System.Epsilon
export const FLT_MIN_NORMAL = 1.175494351e-38;

// ----------------------------------------------------------------- float3
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const divv = (a, b) => [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
export const neg = (a) => [-a[0], -a[1], -a[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const lengthsq = (a) => dot(a, a);
export const length = (a) => Math.sqrt(dot(a, a));
// Hot helpers below are written with scalars instead of temporary arrays; each keeps the exact operation order of the
// composed form it replaces (noted alongside), so results are bit-identical.
export function distance(a, b) {   // length(sub(a, b))
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
}
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const lerpf = (a, b, t) => a + (b - a) * t;
export const unlerp = (a, b, x) => (x - a) / (b - a);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const clamp1 = (x) => clamp(x, -1, 1);           // MathUtility.Clamp1
export const radians = (d) => d * Math.PI / 180;
export const degrees = (r) => r * 180 / Math.PI;
export const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const signv = (a) => [sign(a[0]), sign(a[1]), sign(a[2])];
export const isZero3 = (a) => a[0] === 0 && a[1] === 0 && a[2] === 0;
export function normalize(a) { const k = 1 / Math.sqrt(dot(a, a)); return [a[0] * k, a[1] * k, a[2] * k]; }  // no guard, like math.normalize
export function normalizesafe(a, d = [0, 0, 0]) {
  const l = dot(a, a);
  return l > FLT_MIN_NORMAL ? mul(a, 1 / Math.sqrt(l)) : d.slice();
}
export const UP = [0, 1, 0], FORWARD = [0, 0, 1], RIGHT = [1, 0, 0];

// ----------------------------------------------------------------- quaternion
export const IDENTITY = [0, 0, 0, 1];
export function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
export function qinverse(q) { const k = 1 / qdot(q, q); return [-q[0] * k, -q[1] * k, -q[2] * k, q[3] * k]; }
export function qnormalize(q) { const k = 1 / Math.sqrt(qdot(q, q)); return [q[0] * k, q[1] * k, q[2] * k, q[3] * k]; }
export const qscale = (q, f) => [q[0] * f[0], q[1] * f[1], q[2] * f[2], q[3] * f[3]];   // q.value * float4
export function rotate(q, v) {   // math.mul(quaternion, float3): t = cross(q.xyz, v) * 2; v + t * q.w + cross(q.xyz, t)
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3], vx = v[0], vy = v[1], vz = v[2];
  const tx = (qy * vz - qz * vy) * 2, ty = (qz * vx - qx * vz) * 2, tz = (qx * vy - qy * vx) * 2;
  return [vx + tx * qw + (qy * tz - qz * ty), vy + ty * qw + (qz * tx - qx * tz), vz + tz * qw + (qx * ty - qy * tx)];
}
export function axisAngle(axis, angle) {   // quaternion.AxisAngle (axis normalized)
  const s = Math.sin(angle * 0.5);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle * 0.5)];
}
export function nlerp(a, b, t) {
  const d = qdot(a, b);
  if (d < 0) b = [-b[0], -b[1], -b[2], -b[3]];
  return qnormalize([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
}
export function slerp(a, b, t) {   // math.slerp
  let d = qdot(a, b);
  if (d < 0) { d = -d; b = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d < 0.9995) {
    const angle = Math.acos(d), s = 1 / Math.sqrt(1 - d * d);
    const w1 = Math.sin(angle * (1 - t)) * s, w2 = Math.sin(angle * t) * s;
    return [a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2, a[3] * w1 + b[3] * w2];
  }
  return nlerp(a, b, t);
}
// new quaternion(float3x3 m) of Unity.Mathematics, sign handling included (columns c0, c1, c2)
export function fromMatrix3(c0, c1, c2) {
  const u = c0, v = c1, w = c2;
  const uNeg = u[0] < 0 || Object.is(u[0], -0);
  const t = v[1] + (uNeg ? -w[2] : w[2]);
  const tNeg = t < 0 || Object.is(t, -0);
  const tr = 1 + Math.abs(u[0]);
  // sign flips applied to (t, v.x, u.z, w.y): base (+,-,-,-), ^ u_mask&(0,1,0,1), ^ t_mask&(1,1,1,0)
  const f1 = uNeg === tNeg, f3 = !uNeg;   // flip[1] = true ^ uNeg ^ tNeg, flip[3] = true ^ uNeg
  const s0 = tNeg ? -t : t, s1 = f1 ? -v[0] : v[0], s2 = tNeg ? u[2] : -u[2], s3 = f3 ? -w[1] : w[1];
  let a = tr + s0, b = u[1] + s1, c = w[0] + s2, d = v[2] + s3;
  if (uNeg) { const ta = a, tb = b; a = c; b = d; c = ta; d = tb; }        // .zwxy
  if (!tNeg) { const ta = a, tb = b; a = d; b = c; c = tb; d = ta; }       // .wzyx
  return qnormalize([a, b, c, d]);
}
export function lookRotation(forward, up) {   // quaternion.LookRotation (unit inputs)
  const t = normalize(cross(up, forward));
  return fromMatrix3(t, cross(forward, t), forward);
}

// ----------------------------------------------------------------- float4x4 (column-major)
export function trs(p, q, s) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [(1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    p[0], p[1], p[2], 1];
}
export function m4mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
export const m4point = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];   // math.transform
export const m4vector = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
export function m4inverse(m) {   // general 4x4 inverse
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const k = 1 / det;
  return [(a11 * b11 - a12 * b10 + a13 * b09) * k, (a02 * b10 - a01 * b11 - a03 * b09) * k, (a31 * b05 - a32 * b04 + a33 * b03) * k, (a22 * b04 - a21 * b05 - a23 * b03) * k,
    (a12 * b08 - a10 * b11 - a13 * b07) * k, (a00 * b11 - a02 * b08 + a03 * b07) * k, (a32 * b02 - a30 * b05 - a33 * b01) * k, (a20 * b05 - a22 * b02 + a23 * b01) * k,
    (a10 * b10 - a11 * b08 + a13 * b06) * k, (a01 * b08 - a00 * b10 - a03 * b06) * k, (a30 * b04 - a31 * b02 + a33 * b00) * k, (a21 * b02 - a20 * b04 - a23 * b00) * k,
    (a11 * b07 - a10 * b09 - a12 * b06) * k, (a00 * b09 - a01 * b07 + a02 * b06) * k, (a31 * b01 - a30 * b03 - a32 * b00) * k, (a20 * b03 - a21 * b01 + a22 * b00) * k];
}

// ----------------------------------------------------------------- MathUtility
export function angleV(v1, v2) { return Math.acos(clamp1(dot(v1, v2) / (length(v1) * length(v2)))); }
export function clampVector(v, maxLength) {
  const len = length(v);
  return len > 1e-9 && len > maxLength ? mul(v, maxLength / len) : v;
}
export function clampDistance(from, to, maxLength) {
  const len = distance(from, to);
  return len <= maxLength ? to : lerp(from, to, maxLength / len);
}
function fromToCore(v1, v2, t) {
  const c = clamp1(dot(v1, v2));
  let angle = Math.acos(c), axis = cross(v1, v2);
  if (Math.abs(1 + c) < 1e-6) {
    angle = Math.PI;
    axis = v1[0] > v1[1] && v1[0] > v1[2] ? cross(v1, [0, 1, 0]) : cross(v1, [1, 0, 0]);
  } else if (Math.abs(1 - c) < 1e-6) return IDENTITY.slice();
  return axisAngle(normalize(axis), angle * t);
}
export const fromToRotation = (from, to, t = 1) => fromToCore(normalize(from), normalize(to), t);
export const fromToRotationWithoutNormalize = (v1, v2, t = 1) => fromToCore(v1, v2, t);
export const fromToRotationQ = (from, to) => qmul(to, qinverse(from));
export function angleQ(a, b) {
  const d = qdot(a, b);
  if (Math.abs(d) < 0.9999) {
    const ang = Math.acos(clamp1(d)) * 2;
    return ang > Math.PI ? Math.PI * 2 - ang : ang;
  }
  return 0;
}
export function clampAngleQ(from, to, maxAngle) {
  const ang = angleQ(from, to);
  return ang <= maxAngle ? to : slerp(from, to, maxAngle / ang);
}
export function clampAngleV(dir, basedir, maxAngle) {   // -> [clamped, changed]
  const v1 = normalize(dir), v2 = normalize(basedir);
  const c = clamp1(dot(v1, v2));
  let angle = Math.acos(c);
  if (angle <= maxAngle) return [dir, false];
  const t = (angle - maxAngle) / angle;
  let axis = cross(v1, v2);
  if (Math.abs(1 + c) < 1e-6) {
    angle = Math.PI;
    axis = v1[0] > v1[1] && v1[0] > v1[2] ? cross(v1, [0, 1, 0]) : cross(v1, [1, 0, 0]);
  } else if (Math.abs(1 - c) < 1e-6) return [dir, false];
  return [rotate(axisAngle(normalize(axis), angle * t), dir), true];
}
export const toRotation = (nor, tan) => lookRotation(tan, nor);
export const toNormal = (q) => rotate(q, UP);
export const toTangent = (q) => rotate(q, FORWARD);
export const toBinormal = (q) => rotate(q, RIGHT);
export function toAngleAxis(q) {   // -> [angle, axis]
  const a = Math.abs(q[3]) < 0.9999 ? Math.acos(q[3]) : 0;
  const s = Math.sin(a);
  return [2 * a, Math.abs(s) < 1e-6 ? [0, 0, 0] : [q[0] / s, q[1] / s, q[2] / s]];
}
export function closestPtPointSegmentRatio(c, a, b) {
  const ab = sub(b, a), d = dot(ab, ab);
  if (d === 0) return 0;
  return saturate(dot(sub(c, a), ab) / d);
}
export function closestPtPointSegment(c, a, b) {
  const ab = sub(b, a);
  const t = saturate(dot(sub(c, a), ab) / dot(ab, ab));
  return add(a, mul(ab, t));
}
// -> { distSq, s, t, c1, c2 }
export function closestPtSegmentSegment(p1, q1, p2, q2) {
  const d1x = q1[0] - p1[0], d1y = q1[1] - p1[1], d1z = q1[2] - p1[2];   // d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2
  const d2x = q2[0] - p2[0], d2y = q2[1] - p2[1], d2z = q2[2] - p2[2];
  const rx = p1[0] - p2[0], ry = p1[1] - p2[1], rz = p1[2] - p2[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-8 && e <= 1e-8) return { distSq: rx * rx + ry * ry + rz * rz, s: 0, t: 0, c1: p1, c2: p2 };
  if (a <= 1e-8) { s = 0; t = saturate(f / e); } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-8) { t = 0; s = saturate(-c / a); } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, denom = a * e - b * b;
      s = denom !== 0 ? saturate((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = saturate(-c / a); } else if (t > 1) { t = 1; s = saturate((b - c) / a); }
    }
  }
  const c1 = [p1[0] + d1x * s, p1[1] + d1y * s, p1[2] + d1z * s], c2 = [p2[0] + d2x * t, p2[1] + d2y * t, p2[2] + d2z * t];
  const ex = c1[0] - c2[0], ey = c1[1] - c2[1], ez = c1[2] - c2[2];
  return { distSq: ex * ex + ey * ey + ez * ez, s, t, c1, c2 };
}
export function triangleTangent(p0, p1, p2, uv0, uv1, uv2) {   // scalar form, same operation order
  const bax = p1[0] - p0[0], bay = p1[1] - p0[1], baz = p1[2] - p0[2], cax = p2[0] - p0[0], cay = p2[1] - p0[1], caz = p2[2] - p0[2];
  const tba0 = uv1[0] - uv0[0], tba1 = uv1[1] - uv0[1], tca0 = uv2[0] - uv0[0], tca1 = uv2[1] - uv0[1];
  let area = tba0 * tca1 - tba1 * tca0;
  if (area === 0) area = 1;
  const delta = 1 / area;
  // tan = -[(ba * tca.y + ca * -tba.y) * delta]; normalizesafe(tan, 0)
  const tx = -((bax * tca1 + cax * -tba1) * delta), ty = -((bay * tca1 + cay * -tba1) * delta), tz = -((baz * tca1 + caz * -tba1) * delta);
  const l = tx * tx + ty * ty + tz * tz;
  if (!(l > FLT_MIN_NORMAL)) return [0, 0, 0];
  const k = 1 / Math.sqrt(l);
  return [tx * k, ty * k, tz * k];
}
export function triangleAngle(v0, v1, v2, v3) {
  const ev = sub(v1, v0), va = sub(v2, v0), vb = sub(v3, v0);
  return angleV(cross(va, ev), cross(ev, vb));
}
export function shiftPosition(oldPos, oldPivot, shiftVector, shiftRotation) {
  return add(oldPivot, add(rotate(shiftRotation, sub(oldPos, oldPivot)), shiftVector));
}
export const worldToLocalMatrix = (p, q, s) => m4inverse(trs(p, q, s));
export const transformPointTRS = (pos, p, q, s) => m4point(trs(p, q, s), pos);
export const inverseTransformPointTRS = (pos, p, q, s) => m4point(m4inverse(trs(p, q, s)), pos);
export function transformDirection(dir, m) {
  const len = length(dir);
  return len > 0 ? mul(normalize(m4vector(m, dir)), len) : dir;
}
export const FRICTION_MASS = 3.0, DEPTH_MASS = 5.0;   // Define.System
export const calcInverseMassF = (friction) => 1 / (1 + friction * FRICTION_MASS);
export function calcInverseMass(friction, depth) {
  const a = 1 - depth;
  return 1 / (1 + friction * FRICTION_MASS + a * a * DEPTH_MASS);
}
export const calcInverseMassFix = (friction, depth, fix, fixMass) => (fix ? 1 / fixMass : calcInverseMass(friction, depth));
export function calcMass(depth) { const a = 1 - depth; return 1 + a * a * DEPTH_MASS; }

// ----------------------------------------------------------------- curves (ClothSerializeData CurveSerializeData)
// float4x4 of 16 samples (index i = curve at i / 15), DataUtility.EvaluateCurve
export function evaluateCurve(curve, time) {
  const interval = 1 / 15;
  const index = Math.trunc(saturate(time) * 15);
  const t = (time - index * interval) / interval;
  const a = curve[Math.min(15, Math.max(0, index))], b = curve[Math.min(15, Math.max(0, index + 1))];
  return a + (b - a) * t;   // lerpf
}

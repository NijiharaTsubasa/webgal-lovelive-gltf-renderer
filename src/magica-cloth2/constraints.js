// MagicaCloth2 triangle bending, collider collision and motion constraints (Cloth/Constraints/*.cs, v2.16.0).
// The source accumulates parallel results in fixed point (InterlockUtility, 1e-6 units, truncation toward zero);
// that quantization is reproduced so the results match the original bit for bit where float32 allows.
import * as M from "./math.js";
import { isMove, isDontMove, isInvalid, isMotion, isDisableCollision } from "./simulation.js";

const TO_FIXED = 1000000, TO_FLOAT = 0.000001;
const VOLUME_SIGN = 100, VOLUME_SCALE = 1000;

function addFloat3(index, v, cnt, sum) {
  if (cnt) cnt[index]++;
  const k = index * 3;
  sum[k] += Math.trunc(v[0] * TO_FIXED); sum[k + 1] += Math.trunc(v[1] * TO_FIXED); sum[k + 2] += Math.trunc(v[2] * TO_FIXED);
}
// InterlockUtility.Max: `(int)value * ToFixed` casts BEFORE scaling, so only values >= 1 survive (kept as in source)
function interlockMax(index, value, pt) {
  const ival = Math.trunc(value) * TO_FIXED;
  if (ival > pt[index]) pt[index] = ival;
}

// ------------------------------------------------------------------ TriangleBending (DirectionDihedralAngle)
function calcVolume(p, invMass, volumeRest, stiffness) {
  const [p0, p1, p2, p3] = p;
  let volume = (1 / 6) * M.dot(M.cross(M.sub(p1, p0), M.sub(p2, p0)), M.sub(p3, p0));
  volume *= VOLUME_SCALE;
  const g0 = M.cross(M.sub(p1, p2), M.sub(p3, p2));
  const g1 = M.cross(M.sub(p2, p0), M.sub(p3, p0));
  const g2 = M.cross(M.sub(p0, p1), M.sub(p3, p1));
  const g3 = M.cross(M.sub(p1, p0), M.sub(p2, p0));
  let lambda = invMass[0] * M.lengthsq(g0) + invMass[1] * M.lengthsq(g1) + invMass[2] * M.lengthsq(g2) + invMass[3] * M.lengthsq(g3);
  lambda *= VOLUME_SCALE;
  if (Math.abs(lambda) < 1e-6) return null;
  lambda = (stiffness * (volumeRest - volume)) / lambda;
  return [M.mul(g0, lambda * invMass[0]), M.mul(g1, lambda * invMass[1]), M.mul(g2, lambda * invMass[2]), M.mul(g3, lambda * invMass[3])];
}

// Scalar form of the float3 expressions (comments give the source form); same operation order, bit-identical.
function calcDihedralAngle(sign, p, invMass, restAngle, stiffness) {
  const p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
  const ex = p3[0] - p2[0], ey = p3[1] - p2[1], ez = p3[2] - p2[2];   // e = p3 - p2
  const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (elen < 1e-8) return null;
  const invElen = 1 / elen;
  // n1 = cross(p2 - p0, p3 - p0), n2 = cross(p3 - p1, p2 - p1)
  let ax = p2[0] - p0[0], ay = p2[1] - p0[1], az = p2[2] - p0[2], bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
  let n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
  ax = p3[0] - p1[0]; ay = p3[1] - p1[1]; az = p3[2] - p1[2]; bx = p2[0] - p1[0]; by = p2[1] - p1[1]; bz = p2[2] - p1[2];
  let n2x = ay * bz - az * by, n2y = az * bx - ax * bz, n2z = ax * by - ay * bx;
  const n1sq = n1x * n1x + n1y * n1y + n1z * n1z, n2sq = n2x * n2x + n2y * n2y + n2z * n2z;
  if (n1sq === 0 || n2sq === 0) return null;
  const k1 = 1 / n1sq, k2 = 1 / n2sq;
  n1x = n1x * k1; n1y = n1y * k1; n1z = n1z * k1; n2x = n2x * k2; n2y = n2y * k2; n2z = n2z * k2;
  const d0x = n1x * elen, d0y = n1y * elen, d0z = n1z * elen, d1x = n2x * elen, d1y = n2y * elen, d1z = n2z * elen;
  // d2 = n1 * (dot(p0 - p3, e) * invElen) + n2 * (dot(p1 - p3, e) * invElen); d3 likewise with p2 - p0, p2 - p1
  let s1 = ((p0[0] - p3[0]) * ex + (p0[1] - p3[1]) * ey + (p0[2] - p3[2]) * ez) * invElen;
  let s2 = ((p1[0] - p3[0]) * ex + (p1[1] - p3[1]) * ey + (p1[2] - p3[2]) * ez) * invElen;
  const d2x = n1x * s1 + n2x * s2, d2y = n1y * s1 + n2y * s2, d2z = n1z * s1 + n2z * s2;
  s1 = ((p2[0] - p0[0]) * ex + (p2[1] - p0[1]) * ey + (p2[2] - p0[2]) * ez) * invElen;
  s2 = ((p2[0] - p1[0]) * ex + (p2[1] - p1[1]) * ey + (p2[2] - p1[2]) * ez) * invElen;
  const d3x = n1x * s1 + n2x * s2, d3y = n1y * s1 + n2y * s2, d3z = n1z * s1 + n2z * s2;
  // n1 = normalize(n1), n2 = normalize(n2)
  const u1 = 1 / Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z), u2 = 1 / Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z);
  n1x = n1x * u1; n1y = n1y * u1; n1z = n1z * u1; n2x = n2x * u2; n2y = n2y * u2; n2z = n2z * u2;
  let phi = Math.acos(M.clamp1(n1x * n2x + n1y * n2y + n1z * n2z));
  let lambda = invMass[0] * (d0x * d0x + d0y * d0y + d0z * d0z) + invMass[1] * (d1x * d1x + d1y * d1y + d1z * d1z)
    + invMass[2] * (d2x * d2x + d2y * d2y + d2z * d2z) + invMass[3] * (d3x * d3x + d3y * d3y + d3z * d3z);
  if (lambda === 0) return null;
  // sign(dot(cross(n1, n2), e))
  const dirSign = Math.sign((n1y * n2z - n1z * n2y) * ex + (n1z * n2x - n1x * n2z) * ey + (n1x * n2y - n1y * n2x) * ez);
  if (sign !== 0) phi *= dirSign; else lambda *= dirSign;
  lambda = ((restAngle - phi) / lambda) * stiffness;
  const f0 = -invMass[0] * lambda, f1 = -invMass[1] * lambda, f2 = -invMass[2] * lambda, f3 = -invMass[3] * lambda;
  return [[d0x * f0, d0y * f0, d0z * f0], [d1x * f1, d1y * f1, d1z * f1], [d2x * f2, d2y * f2, d2z * f2], [d3x * f3, d3y * f3, d3z * f3]];
}

/** TriangleBendingConstraint.SolverConstraint + SumConstraint */
export function solveTriangleBending(s, team, simulationPower) {
  const bc = s.bending, bp = team.params.triangleBendingConstraint;
  if (!bc || !bc.pairs.length || bp.method === 0) return;
  let stiffness = bp.stiffness;
  if (stiffness < 1e-6) return;
  stiffness = M.saturate(stiffness * simulationPower[1]);
  const sum = s.tmpVecA, cnt = s.tmpCount;
  const pos = new Array(4), invMass = new Array(4);   // reused: the calc functions read them, never keep them
  for (let k = 0; k < bc.pairs.length; k++) {
    const vtx = bc.pairs[k];   // [v0, v1, v2, v3]
    for (let i = 0; i < 4; i++) {
      const v = vtx[i];
      pos[i] = s.nextPos[v];
      invMass[i] = isDontMove(s.attr[v]) ? 0.01 : M.calcInverseMass(s.friction[v], s.depth[v]);
    }
    let restAngle = bc.restAngleOrVolume[k];
    const signOrVolume = bc.signOrVolume[k];
    let add;
    if (signOrVolume === VOLUME_SIGN) {
      add = calcVolume(pos, invMass, restAngle * team.scaleRatio, stiffness);   // (negativeScaleSign = 1)
    } else if (bp.method === 1) {
      add = calcDihedralAngle(0, pos, invMass, restAngle, stiffness);
    } else {
      const sign = signOrVolume < 0 ? -1 : 1;
      restAngle *= sign;
      add = calcDihedralAngle(sign, pos, invMass, restAngle, stiffness);
    }
    if (add) for (let i = 0; i < 4; i++) addFloat3(vtx[i], add[i], cnt, sum);
  }
  // SumConstraint
  for (let v = 0; v < s.count; v++) {
    if (!isDontMove(s.attr[v])) {
      const c = cnt[v];
      if (c > 0) {
        const k = v * 3, np = s.nextPos[v];
        s.nextPos[v] = [np[0] + (sum[k] / c) * TO_FLOAT, np[1] + (sum[k + 1] / c) * TO_FLOAT, np[2] + (sum[k + 2] / c) * TO_FLOAT];
      }
    }
    cnt[v] = 0; sum[v * 3] = 0; sum[v * 3 + 1] = 0; sum[v * 3 + 2] = 0;
  }
}

// ------------------------------------------------------------------ AABB helpers
const aabb = (min, max) => ({ min, max });
function aabbExpand(a, r) { a.min = M.sub(a.min, [r, r, r]); a.max = M.add(a.max, [r, r, r]); return a; }
function aabbEncapsulate(a, b) {
  a.min = [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])];
  a.max = [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])];
  return a;
}
const aabbOverlaps = (a, b) => a.max[0] >= b.min[0] && a.min[0] <= b.max[0] && a.max[1] >= b.min[1]
  && a.min[1] <= b.max[1] && a.max[2] >= b.min[2] && a.min[2] <= b.max[2];
export { aabb, aabbExpand, aabbEncapsulate };

// MathUtility.IntersectPointPlaneDist -> [dist, outPos]
function intersectPointPlaneDist(planePos, planeDir, pos) {
  const v = M.sub(pos, planePos);
  const gv = M.mul(planeDir, M.dot(v, planeDir));
  const len = M.length(gv);
  if (M.dot(planeDir, v) < 0) return [-len, M.sub(pos, gv)];
  return [len, pos];
}

// ------------------------------------------------------------------ point collision
const CT_SPHERE = 1, CT_CAPSULE_MIN = 2, CT_CAPSULE_MAX = 7, CT_PLANE = 8;

function pointSphere(nextpos, radius, box, w) {   // (BoneSpring soft collider path omitted: no BoneSpring in the data)
  if (!aabbOverlaps(box, w.aabb)) return [Number.MAX_VALUE, nextpos, [0, 0, 0]];
  const coldpos = w.oldPos[0], cpos = w.nextPos[0], cradius = w.radius[0];
  const n = M.normalize(M.sub(nextpos, coldpos));
  const c = M.add(cpos, M.mul(n, cradius + radius));
  const [dist, out] = intersectPointPlaneDist(c, n, nextpos);
  return [dist, out, n];
}
function pointPlane(nextpos, radius, w) {
  const cpos = w.nextPos[0], n = w.oldPos[0];
  const [dist, out] = intersectPointPlaneDist(M.add(cpos, M.mul(n, radius)), n, nextpos);
  return [dist, out, n];
}
function pointCapsule(nextpos, radius, box, w) {
  if (!aabbOverlaps(box, w.aabb)) return [Number.MAX_VALUE, nextpos, [0, 0, 0]];
  const [soldpos, eoldpos] = w.oldPos, [spos, epos] = w.nextPos;
  const t = M.closestPtPointSegmentRatio(nextpos, soldpos, eoldpos);
  const r = M.lerpf(w.radius[0], w.radius[1], t);
  let d = M.lerp(soldpos, eoldpos, t);
  const lv = M.rotate(w.inverseOldRot, M.sub(nextpos, d));
  d = M.lerp(spos, epos, t);
  const n = M.normalize(M.rotate(w.rot, lv));
  const c = M.add(d, M.mul(n, r + radius));
  const [dist, out] = intersectPointPlaneDist(c, n, nextpos);
  return [dist, out, n];
}

/** ColliderCollisionConstraint.SolverPointConstraint (mode 1) */
export function solvePointCollision(s, team, colliders) {
  if (!colliders || !colliders.count) return;
  const p = team.params;
  for (let v = 0; v < s.count; v++) {
    const attr = s.attr[v];
    if (isInvalid(attr) || isDisableCollision(attr)) continue;
    if (!isMove(attr)) continue;
    let nextPos = s.nextPos[v];
    const depth = s.depth[v];
    const radius = Math.max(M.evaluateCurve(p.radiusCurveData, depth), 0.0001) * team.scaleRatio;
    let mindist = Number.MAX_VALUE, collisionColliderId = -1;
    let collisionNormal = [0, 0, 0], addPos = [0, 0, 0], addN = [0, 0, 0], addCnt = 0;
    const cfr = radius;
    // aabbExpand(aabbAround(nextPos, radius), cfr), as scalars; a sphere / capsule whose box misses is skipped
    const minX = nextPos[0] - radius - cfr, minY = nextPos[1] - radius - cfr, minZ = nextPos[2] - radius - cfr;
    const maxX = nextPos[0] + radius + cfr, maxY = nextPos[1] + radius + cfr, maxZ = nextPos[2] + radius + cfr;
    let box = null;
    for (let i = 0; i < colliders.count; i++) {
      if (!colliders.enable[i]) continue;
      const type = colliders.type[i], w = colliders.work[i];
      if (type !== CT_PLANE) {
        const b = w.aabb;
        if (!(maxX >= b.min[0] && minX <= b.max[0] && maxY >= b.min[1] && minY <= b.max[1] && maxZ >= b.min[2] && minZ <= b.max[2])) continue;
        box ??= aabb([minX, minY, minZ], [maxX, maxY, maxZ]);
      }
      let r;
      if (type === CT_SPHERE) r = pointSphere(nextPos, radius, box, w);
      else if (type >= CT_CAPSULE_MIN && type <= CT_CAPSULE_MAX) r = pointCapsule(nextPos, radius, box, w);
      else if (type === CT_PLANE) r = pointPlane(nextPos, radius, w);
      else continue;
      const [dist, out, n] = r;
      if (dist <= 0) { addPos = M.add(addPos, M.sub(out, nextPos)); addN = M.add(addN, n); addCnt++; }
      if (dist <= cfr) { collisionColliderId = i; collisionNormal = M.add(collisionNormal, n); mindist = Math.min(mindist, dist); }
    }
    if (addCnt > 0) {
      addN = M.mul(addN, 1 / addCnt);
      const len = M.length(addN);
      if (len >= M.EPSILON) {
        const t = Math.min(len, 1);
        addPos = M.mul(addPos, 1 / addCnt);
        nextPos = M.add(nextPos, M.mul(addPos, t));
      }
    }
    if (collisionColliderId >= 0 && cfr > 0 && M.lengthsq(collisionNormal) > 1e-6) {
      const friction = 1 - M.saturate(mindist / cfr);
      s.friction[v] = Math.max(friction, s.friction[v]);
      collisionNormal = M.normalize(collisionNormal);
    }
    s.collisionNormal[v] = collisionNormal;
    s.nextPos[v] = nextPos;
  }
}

// ------------------------------------------------------------------ edge collision
function edgeSphere(e, rE, box, cfr, w) {
  if (!aabbOverlaps(box, w.aabb)) return [Number.MAX_VALUE, e, [0, 0, 0]];
  const coldpos = w.oldPos[0], cpos = w.nextPos[0], cradius = w.radius[0];
  const s = M.closestPtPointSegmentRatio(coldpos, e[0], e[1]);
  const c = M.lerp(e[0], e[1], s);
  let v = M.sub(c, coldpos);
  const clen = M.length(v);
  if (clen < 1e-9) return [Number.MAX_VALUE, e, [0, 0, 0]];
  const n = M.mul(v, 1 / clen);
  const l1 = M.dot(n, M.sub(cpos, coldpos));
  let l = clen - l1;
  const thickness = M.lerpf(rE[0], rE[1], s) + cradius;
  if (l > thickness + cfr) return [Number.MAX_VALUE, e, n];
  v = M.sub(c, cpos);
  l = M.dot(n, v);
  if (l > thickness) return [l - thickness, e, n];
  const C = thickness - l;
  const b = [1 - s, s];
  let S = b[0] * b[0] + b[1] * b[1];
  if (S === 0) return [Number.MAX_VALUE, e, n];
  S = C / S;
  return [-C, [M.add(e[0], M.mul(n, b[0] * S)), M.add(e[1], M.mul(n, b[1] * S))], n];
}
// Scalar form of the source's float3 expressions (in the comments); same operation order, bit-identical.
function edgeCapsule(e, rE, box, cfr, w) {
  if (!aabbOverlaps(box, w.aabb)) return [Number.MAX_VALUE, e, [0, 0, 0]];
  const soldpos = w.oldPos[0], eoldpos = w.oldPos[1], spos = w.nextPos[0], epos = w.nextPos[1];
  const sr = w.radius[0], er = w.radius[1], e0 = e[0], e1 = e[1];
  let { distSq, s, t, c1: cA, c2: cB } = M.closestPtSegmentSegment(e0, e1, soldpos, eoldpos);
  let clen = Math.sqrt(distSq);
  if (clen < 1e-9) return [Number.MAX_VALUE, e, [0, 0, 0]];
  let cax = cA[0], cay = cA[1], caz = cA[2];
  let vx = cax - cB[0], vy = cay - cB[1], vz = caz - cB[2];   // v = cA - cB; n = v * (1 / clen)
  let k = 1 / clen, nx = vx * k, ny = vy * k, nz = vz * k;
  if (sr !== er) {   // edge collision extension (present since 2.9.0)
    const soldpos2 = [soldpos[0] + nx * sr, soldpos[1] + ny * sr, soldpos[2] + nz * sr];
    const eoldpos2 = [eoldpos[0] + nx * er, eoldpos[1] + ny * er, eoldpos[2] + nz * er];
    ({ s, t } = M.closestPtSegmentSegment(e0, e1, soldpos2, eoldpos2));
    cax = e0[0] + (e1[0] - e0[0]) * s; cay = e0[1] + (e1[1] - e0[1]) * s; caz = e0[2] + (e1[2] - e0[2]) * s;   // lerp(e0, e1, s)
    vx = cax - (soldpos[0] + (eoldpos[0] - soldpos[0]) * t);                                                   // cA - lerp(soldpos, eoldpos, t)
    vy = cay - (soldpos[1] + (eoldpos[1] - soldpos[1]) * t);
    vz = caz - (soldpos[2] + (eoldpos[2] - soldpos[2]) * t);
    clen = Math.sqrt(vx * vx + vy * vy + vz * vz);
    k = 1 / clen; nx = vx * k; ny = vy * k; nz = vz * k;
  }
  const n = [nx, ny, nz];
  // db = lerp(spos - soldpos, epos - eoldpos, t)
  const ax = spos[0] - soldpos[0], ay = spos[1] - soldpos[1], az = spos[2] - soldpos[2];
  const bx = epos[0] - eoldpos[0], by = epos[1] - eoldpos[1], bz = epos[2] - eoldpos[2];
  let l = clen - (nx * (ax + (bx - ax) * t) + ny * (ay + (by - ay) * t) + nz * (az + (bz - az) * t));
  const thickness = M.lerpf(rE[0], rE[1], s) + M.lerpf(sr, er, t);
  if (l > thickness + cfr) return [Number.MAX_VALUE, e, n];
  // d = lerp(spos, epos, t); l = dot(n, cA - d)
  const dx = spos[0] + (epos[0] - spos[0]) * t, dy = spos[1] + (epos[1] - spos[1]) * t, dz = spos[2] + (epos[2] - spos[2]) * t;
  l = nx * (cax - dx) + ny * (cay - dy) + nz * (caz - dz);
  if (l > thickness) return [l - thickness, e, n];
  const C = thickness - l;
  const b0 = 1 - s, b1 = s;
  let S = b0 * b0 + b1 * b1;
  if (S === 0) return [Number.MAX_VALUE, e, n];
  S = C / S;
  const f0 = b0 * S, f1 = b1 * S;
  return [-C, [[e0[0] + nx * f0, e0[1] + ny * f0, e0[2] + nz * f0], [e1[0] + nx * f1, e1[1] + ny * f1, e1[2] + nz * f1]], n];
}
function edgePlane(e, rE, w) {
  const cpos = w.nextPos[0], n = w.oldPos[0];
  const [d0, o0] = intersectPointPlaneDist(M.add(cpos, M.mul(n, rE[0])), n, e[0]);
  const [d1, o1] = intersectPointPlaneDist(M.add(cpos, M.mul(n, rE[1])), n, e[1]);
  return [Math.min(d0, d1), [o0, o1], n];
}

/** ColliderCollisionConstraint.SolverEdgeConstraint + SumEdgeConstraint (mode 2) */
export function solveEdgeCollision(s, team, colliders) {
  if (!colliders || !colliders.count) return;
  const p = team.params, edges = s.edges;
  const vecA = s.tmpVecA, vecB = s.tmpVecB, cnt = s.tmpCount, fpt = s.tmpFloatA;
  for (let k = 0; k < edges.length; k += 2) {
    const e0 = edges[k], e1 = edges[k + 1];
    if (!isMove(s.attr[e0]) && !isMove(s.attr[e1])) continue;
    const q0 = s.nextPos[e0], q1 = s.nextPos[e1];
    const r0 = M.evaluateCurve(p.radiusCurveData, s.depth[e0]) * team.scaleRatio, r1 = M.evaluateCurve(p.radiusCurveData, s.depth[e1]) * team.scaleRatio;
    const cfr = (r0 + r1) * 0.5;
    let mindist = Number.MAX_VALUE, collisionColliderId = -1;
    // aabbExpand(aabbEncapsulate(aabbAround(q0, r0), aabbAround(q1, r1)), cfr), as scalars
    const minX = Math.min(q0[0] - r0, q1[0] - r1) - cfr, minY = Math.min(q0[1] - r0, q1[1] - r1) - cfr, minZ = Math.min(q0[2] - r0, q1[2] - r1) - cfr;
    const maxX = Math.max(q0[0] + r0, q1[0] + r1) + cfr, maxY = Math.max(q0[1] + r0, q1[1] + r1) + cfr, maxZ = Math.max(q0[2] + r0, q1[2] + r1) + cfr;
    let nextPosE = null, rE = null, box = null;   // built on the first collider that needs them
    // accumulators add0, add1, addN, collisionNormal as scalars (same additions in the same order)
    let a0x = 0, a0y = 0, a0z = 0, a1x = 0, a1y = 0, a1z = 0, anx = 0, any = 0, anz = 0, cnx = 0, cny = 0, cnz = 0, addCnt = 0;
    for (let i = 0; i < colliders.count; i++) {
      if (!colliders.enable[i]) continue;
      const type = colliders.type[i], w = colliders.work[i];
      if (type !== CT_PLANE) {
        // a sphere / capsule whose box misses returns [MAX_VALUE, ...], which neither pushes nor counts: skip it
        const b = w.aabb;
        if (!(maxX >= b.min[0] && minX <= b.max[0] && maxY >= b.min[1] && minY <= b.max[1] && maxZ >= b.min[2] && minZ <= b.max[2])) continue;
      }
      if (!nextPosE) { nextPosE = [q0, q1]; rE = [r0, r1]; box = aabb([minX, minY, minZ], [maxX, maxY, maxZ]); }
      let r;
      if (type === CT_SPHERE) r = edgeSphere(nextPosE, rE, box, cfr, w);
      else if (type >= CT_CAPSULE_MIN && type <= CT_CAPSULE_MAX) r = edgeCapsule(nextPosE, rE, box, cfr, w);
      else if (type === CT_PLANE) r = edgePlane(nextPosE, rE, w);
      else continue;
      const [dist, out, n] = r;
      if (dist <= 0) {
        const o0 = out[0], o1 = out[1];
        a0x = a0x + (o0[0] - q0[0]); a0y = a0y + (o0[1] - q0[1]); a0z = a0z + (o0[2] - q0[2]);
        a1x = a1x + (o1[0] - q1[0]); a1y = a1y + (o1[1] - q1[1]); a1z = a1z + (o1[2] - q1[2]);
        anx = anx + n[0]; any = any + n[1]; anz = anz + n[2]; addCnt++;
      }
      if (dist <= cfr) { collisionColliderId = i; cnx = cnx + n[0]; cny = cny + n[1]; cnz = cnz + n[2]; mindist = Math.min(mindist, dist); }
    }
    if (addCnt > 0) {
      const ka = 1 / addCnt;
      anx = anx * ka; any = any * ka; anz = anz * ka;
      const len = Math.sqrt(anx * anx + any * any + anz * anz);
      if (len > M.EPSILON) {
        const t = Math.min(len, 1) / addCnt;
        addFloat3(e0, [a0x * t, a0y * t, a0z * t], cnt, vecA);
        addFloat3(e1, [a1x * t, a1y * t, a1z * t], cnt, vecA);
      }
    }
    if (collisionColliderId >= 0 && cfr > 0 && cnx * cnx + cny * cny + cnz * cnz > 1e-6) {
      const friction = 1 - M.saturate(mindist / cfr);
      interlockMax(e0, friction, fpt);
      interlockMax(e1, friction, fpt);
      const kc = 1 / Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);   // M.normalize
      const collisionNormal = [cnx * kc, cny * kc, cnz * kc];
      addFloat3(e0, collisionNormal, null, vecB);
      addFloat3(e1, collisionNormal, null, vecB);
    }
  }
  // SumEdgeConstraint
  for (let v = 0; v < s.count; v++) {
    const c = cnt[v];
    if (c > 0) {
      const k = v * 3, np = s.nextPos[v];
      s.nextPos[v] = [np[0] + (vecA[k] / c) * TO_FLOAT, np[1] + (vecA[k + 1] / c) * TO_FLOAT, np[2] + (vecA[k + 2] / c) * TO_FLOAT];
    }
    const f = fpt[v] * TO_FLOAT;
    if (f > 0 && f > s.friction[v]) s.friction[v] = f;
    const k3 = v * 3, nx = vecB[k3] * TO_FLOAT, ny = vecB[k3 + 1] * TO_FLOAT, nz = vecB[k3 + 2] * TO_FLOAT;   // readFloat3
    const nsq = nx * nx + ny * ny + nz * nz;
    if (nsq > 0) { const kn = 1 / Math.sqrt(nsq); s.collisionNormal[v] = [nx * kn, ny * kn, nz * kn]; }
    vecA[v * 3] = vecA[v * 3 + 1] = vecA[v * 3 + 2] = 0;
    vecB[v * 3] = vecB[v * 3 + 1] = vecB[v * 3 + 2] = 0;
    cnt[v] = 0; fpt[v] = 0;
  }
}

// ------------------------------------------------------------------ motion (max distance / backstop)
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];   // ClothNormalAxis order

/** MotionConstraint.SolverConstraint */
export function solveMotion(s, team) {
  const p = team.params, mp = p.motionConstraint;
  if (!mp.useMaxDistance && !mp.useBackstop) return;
  const stiffness = mp.stiffness, backstopRadius = mp.backstopRadius;
  for (let v = 0; v < s.count; v++) {
    const attr = s.attr[v];
    if (!isMove(attr) || !isMotion(attr)) continue;
    let nextPos = s.nextPos[v];
    const basePos = s.basePos[v];
    const opos = nextPos;
    const radius = Math.max(M.evaluateCurve(p.radiusCurveData, s.depth[v]), 0.0001);
    const cfr = radius;
    const depth = s.depth[v] * s.depth[v];
    const dir = M.rotate(s.baseRot[v], AXES[p.normalAxis] || AXES[1]);
    if (mp.useMaxDistance) {
      const maxDistance = M.evaluateCurve(mp.maxDistanceCurveData, depth);
      nextPos = M.add(basePos, M.clampVector(M.sub(nextPos, basePos), maxDistance));
    }
    if (mp.useBackstop) {
      const backstopDistance = M.evaluateCurve(mp.backstopDistanceCurveData, depth);
      if (backstopRadius > 0) {
        const cen = M.add(basePos, M.mul(dir, -(backstopDistance + backstopRadius)));
        const d = M.sub(nextPos, cen), len = M.length(d);
        if (len > M.EPSILON && len < backstopRadius + cfr && len < backstopRadius) nextPos = M.add(cen, M.mul(d, backstopRadius / len));
      }
    }
    nextPos = M.lerp(opos, nextPos, stiffness);
    s.nextPos[v] = nextPos;
    s.velocityPos[v] = M.add(s.velocityPos[v], M.mul(M.sub(nextPos, opos), 0.95));
  }
}

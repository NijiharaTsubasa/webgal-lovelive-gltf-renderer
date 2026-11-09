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
const readFloat3 = (index, pt) => [pt[index * 3] * TO_FLOAT, pt[index * 3 + 1] * TO_FLOAT, pt[index * 3 + 2] * TO_FLOAT];

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

function calcDihedralAngle(sign, p, invMass, restAngle, stiffness) {
  const [p0, p1, p2, p3] = p;
  const e = M.sub(p3, p2), elen = M.length(e);
  if (elen < 1e-8) return null;
  const invElen = 1 / elen;
  let n1 = M.cross(M.sub(p2, p0), M.sub(p3, p0));
  let n2 = M.cross(M.sub(p3, p1), M.sub(p2, p1));
  const n1sq = M.lengthsq(n1), n2sq = M.lengthsq(n2);
  if (n1sq === 0 || n2sq === 0) return null;
  n1 = M.mul(n1, 1 / n1sq); n2 = M.mul(n2, 1 / n2sq);
  const d0 = M.mul(n1, elen), d1 = M.mul(n2, elen);
  const d2 = M.add(M.mul(n1, M.dot(M.sub(p0, p3), e) * invElen), M.mul(n2, M.dot(M.sub(p1, p3), e) * invElen));
  const d3 = M.add(M.mul(n1, M.dot(M.sub(p2, p0), e) * invElen), M.mul(n2, M.dot(M.sub(p2, p1), e) * invElen));
  n1 = M.normalize(n1); n2 = M.normalize(n2);
  let phi = Math.acos(M.clamp1(M.dot(n1, n2)));
  let lambda = invMass[0] * M.lengthsq(d0) + invMass[1] * M.lengthsq(d1) + invMass[2] * M.lengthsq(d2) + invMass[3] * M.lengthsq(d3);
  if (lambda === 0) return null;
  const dirSign = Math.sign(M.dot(M.cross(n1, n2), e));
  if (sign !== 0) phi *= dirSign; else lambda *= dirSign;
  lambda = ((restAngle - phi) / lambda) * stiffness;
  return [M.mul(d0, -invMass[0] * lambda), M.mul(d1, -invMass[1] * lambda), M.mul(d2, -invMass[2] * lambda), M.mul(d3, -invMass[3] * lambda)];
}

/** TriangleBendingConstraint.SolverConstraint + SumConstraint */
export function solveTriangleBending(s, team, simulationPower) {
  const bc = s.bending, bp = team.params.triangleBendingConstraint;
  if (!bc || !bc.pairs.length || bp.method === 0) return;
  let stiffness = bp.stiffness;
  if (stiffness < 1e-6) return;
  stiffness = M.saturate(stiffness * simulationPower[1]);
  const sum = s.tmpVecA, cnt = s.tmpCount;
  for (let k = 0; k < bc.pairs.length; k++) {
    const vtx = bc.pairs[k];   // [v0, v1, v2, v3]
    const pos = new Array(4), invMass = new Array(4);
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
        const k = v * 3;
        const add = [(sum[k] / c) * TO_FLOAT, (sum[k + 1] / c) * TO_FLOAT, (sum[k + 2] / c) * TO_FLOAT];
        s.nextPos[v] = M.add(s.nextPos[v], add);
      }
    }
    cnt[v] = 0; sum[v * 3] = 0; sum[v * 3 + 1] = 0; sum[v * 3 + 2] = 0;
  }
}

// ------------------------------------------------------------------ AABB helpers
const aabb = (min, max) => ({ min, max });
const aabbAround = (p, r) => aabb(M.sub(p, [r, r, r]), M.add(p, [r, r, r]));
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
    const box = aabbExpand(aabbAround(nextPos, radius), cfr);
    for (let i = 0; i < colliders.count; i++) {
      if (!colliders.enable[i]) continue;
      const type = colliders.type[i], w = colliders.work[i];
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
function edgeCapsule(e, rE, box, cfr, w) {
  if (!aabbOverlaps(box, w.aabb)) return [Number.MAX_VALUE, e, [0, 0, 0]];
  const [soldpos, eoldpos] = w.oldPos, [spos, epos] = w.nextPos;
  const sr = w.radius[0], er = w.radius[1];
  let { distSq, s, t, c1: cA, c2: cB } = M.closestPtSegmentSegment(e[0], e[1], soldpos, eoldpos);
  let clen = Math.sqrt(distSq);
  if (clen < 1e-9) return [Number.MAX_VALUE, e, [0, 0, 0]];
  let v = M.sub(cA, cB);
  let n = M.mul(v, 1 / clen);
  if (sr !== er) {   // edge collision extension (present since 2.9.0)
    const soldpos2 = M.add(soldpos, M.mul(n, sr)), eoldpos2 = M.add(eoldpos, M.mul(n, er));
    ({ s, t } = M.closestPtSegmentSegment(e[0], e[1], soldpos2, eoldpos2));
    cA = M.lerp(e[0], e[1], s);
    cB = M.lerp(soldpos, eoldpos, t);
    v = M.sub(cA, cB);
    clen = M.length(v);
    n = M.mul(v, 1 / clen);
  }
  const db = M.lerp(M.sub(spos, soldpos), M.sub(epos, eoldpos), t);
  let l = clen - M.dot(n, db);
  const thickness = M.lerpf(rE[0], rE[1], s) + M.lerpf(sr, er, t);
  if (l > thickness + cfr) return [Number.MAX_VALUE, e, n];
  const d = M.lerp(spos, epos, t);
  l = M.dot(n, M.sub(cA, d));
  if (l > thickness) return [l - thickness, e, n];
  const C = thickness - l;
  const b = [1 - s, s];
  let S = b[0] * b[0] + b[1] * b[1];
  if (S === 0) return [Number.MAX_VALUE, e, n];
  S = C / S;
  return [-C, [M.add(e[0], M.mul(n, b[0] * S)), M.add(e[1], M.mul(n, b[1] * S))], n];
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
    const nextPosE = [s.nextPos[e0], s.nextPos[e1]];
    const rE = [M.evaluateCurve(p.radiusCurveData, s.depth[e0]) * team.scaleRatio, M.evaluateCurve(p.radiusCurveData, s.depth[e1]) * team.scaleRatio];
    const cfr = (rE[0] + rE[1]) * 0.5;
    let mindist = Number.MAX_VALUE, collisionColliderId = -1, collisionNormal = [0, 0, 0];
    const box = aabbExpand(aabbEncapsulate(aabbAround(nextPosE[0], rE[0]), aabbAround(nextPosE[1], rE[1])), cfr);
    let add0 = [0, 0, 0], add1 = [0, 0, 0], addN = [0, 0, 0], addCnt = 0;
    for (let i = 0; i < colliders.count; i++) {
      if (!colliders.enable[i]) continue;
      const type = colliders.type[i], w = colliders.work[i];
      let r;
      if (type === CT_SPHERE) r = edgeSphere(nextPosE, rE, box, cfr, w);
      else if (type >= CT_CAPSULE_MIN && type <= CT_CAPSULE_MAX) r = edgeCapsule(nextPosE, rE, box, cfr, w);
      else if (type === CT_PLANE) r = edgePlane(nextPosE, rE, w);
      else continue;
      const [dist, out, n] = r;
      if (dist <= 0) {
        add0 = M.add(add0, M.sub(out[0], nextPosE[0])); add1 = M.add(add1, M.sub(out[1], nextPosE[1]));
        addN = M.add(addN, n); addCnt++;
      }
      if (dist <= cfr) { collisionColliderId = i; collisionNormal = M.add(collisionNormal, n); mindist = Math.min(mindist, dist); }
    }
    if (addCnt > 0) {
      addN = M.mul(addN, 1 / addCnt);
      const len = M.length(addN);
      if (len > M.EPSILON) {
        const t = Math.min(len, 1) / addCnt;
        addFloat3(e0, M.mul(add0, t), cnt, vecA);
        addFloat3(e1, M.mul(add1, t), cnt, vecA);
      }
    }
    if (collisionColliderId >= 0 && cfr > 0 && M.lengthsq(collisionNormal) > 1e-6) {
      const friction = 1 - M.saturate(mindist / cfr);
      interlockMax(e0, friction, fpt);
      interlockMax(e1, friction, fpt);
      collisionNormal = M.normalize(collisionNormal);
      addFloat3(e0, collisionNormal, null, vecB);
      addFloat3(e1, collisionNormal, null, vecB);
    }
  }
  // SumEdgeConstraint
  for (let v = 0; v < s.count; v++) {
    const c = cnt[v];
    if (c > 0) {
      const k = v * 3;
      s.nextPos[v] = M.add(s.nextPos[v], [(vecA[k] / c) * TO_FLOAT, (vecA[k + 1] / c) * TO_FLOAT, (vecA[k + 2] / c) * TO_FLOAT]);
    }
    const f = fpt[v] * TO_FLOAT;
    if (f > 0 && f > s.friction[v]) s.friction[v] = f;
    const n = readFloat3(v, vecB);
    if (M.lengthsq(n) > 0) s.collisionNormal[v] = M.normalize(n);
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

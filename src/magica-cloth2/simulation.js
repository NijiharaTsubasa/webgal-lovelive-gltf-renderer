// MagicaCloth2 per-team simulation steps (Manager/Simulation/SimulationManagerNormal.cs, v2.16.0) and the
// tether / distance / angle constraints (Cloth/Constraints/*.cs).  `s` is one cloth state (see cloth.js):
//   s.attr[v]                 VertexAttribute (0x01 fixed, 0x02 move, 0x08 invalid motion, 0x10 no collision)
//   s.depth[v], s.root[v], s.parent[v], s.baseLine{start,count,data}, s.vertexLocalPositions/Rotations
//   s.positions[v] / s.rotations[v]   proxy pose in world space (skinned, then simulated)
//   particle arrays nextPos, oldPos, oldRot, basePos, baseRot, oldPosition, oldRotation, velocityPos, dispPos,
//   velocity, realVelocity, friction, staticFriction, collisionNormal, step buffers stepBasicPosition/Rotation
// Game version: ~2.10 (no MaxDistanceRatioFutuerPrediction clamp in the display prediction, see MC2_PORT_NOTES).
import * as M from "./math.js";

export const isMove = (a) => (a & 0x02) !== 0;
export const isFixed = (a) => (a & 0x01) !== 0;
export const isDontMove = (a) => (a & 0x02) === 0;
export const isInvalid = (a) => (a & 0x03) === 0;
export const isMotion = (a) => (a & 0x08) === 0;
export const isDisableCollision = (a) => (a & 0x10) !== 0;

// Define.System constants used here (identical in the game's 5.1.0 build)
const TETHER_COMPRESSION_STIFFNESS = 1.0, TETHER_STRETCH_STIFFNESS = 1.0, TETHER_STIFFNESS_WIDTH = 0.3;
const TETHER_COMPRESSION_ATTN = 0.7, TETHER_STRETCH_ATTN = 0.7;
const DISTANCE_HORIZONTAL_STIFFNESS = 0.5;
const ANGLE_LIMIT_ITERATION = 3, ANGLE_LIMIT_ATTENUATION = 0.9;
const FRICTION_DAMPING_RATE = 0.6;

/** SimulationPreTeamUpdate: reset, or carry the particles with the world inertia shift. */
export function preTeamUpdate(s, team) {
  const N = s.count, c = team.center;
  if (team.reset) {
    for (let v = 0; v < N; v++) {
      const pos = s.positions[v], rot = s.rotations[v];
      s.nextPos[v] = pos.slice(); s.oldPos[v] = pos.slice(); s.oldRot[v] = rot.slice();
      s.basePos[v] = pos.slice(); s.baseRot[v] = rot.slice();
      s.oldPosition[v] = pos.slice(); s.oldRotation[v] = rot.slice();
      s.velocityPos[v] = pos.slice(); s.dispPos[v] = pos.slice();
      s.velocity[v] = [0, 0, 0]; s.realVelocity[v] = [0, 0, 0];
      s.friction[v] = 0; s.staticFriction[v] = 0; s.collisionNormal[v] = [0, 0, 0];
    }
  } else if (team.inertiaShift) {
    const pivot = c.oldComponentWorldPosition, sv = c.frameComponentShiftVector, sr = c.frameComponentShiftRotation;
    for (let v = 0; v < N; v++) {
      s.oldPos[v] = M.shiftPosition(s.oldPos[v], pivot, sv, sr);
      s.oldRot[v] = M.qmul(sr, s.oldRot[v]);
      s.oldPosition[v] = M.shiftPosition(s.oldPosition[v], pivot, sv, sr);
      s.oldRotation[v] = M.qmul(sr, s.oldRotation[v]);
      s.dispPos[v] = M.shiftPosition(s.dispPos[v], pivot, sv, sr);
      s.velocity[v] = M.rotate(sr, s.velocity[v]);
      s.realVelocity[v] = M.rotate(sr, s.realVelocity[v]);
    }
  }
}

/** SimulationStepUpdateParticles: base pose interpolation, local inertia, damping, gravity, prediction. */
export function stepUpdateParticles(s, team, simulationPower, dt) {
  const c = team.center, p = team.params;
  for (let v = 0; v < s.count; v++) {
    const attr = s.attr[v], depth = s.depth[v];
    const oldPos = s.oldPos[v];
    let nextPos = oldPos.slice(), velocityPos = oldPos.slice();
    const basePos = M.lerp(s.oldPosition[v], s.positions[v], team.frameInterpolation);
    const baseRot = M.qnormalize(M.slerp(s.oldRotation[v], s.rotations[v], team.frameInterpolation));
    s.basePos[v] = basePos; s.baseRot[v] = baseRot;
    s.stepBasicPosition[v] = basePos.slice(); s.stepBasicRotation[v] = baseRot.slice();
    if (isMove(attr)) {
      let velocity = s.velocity[v];
      // local inertia shift
      const inertiaDepth = p.inertiaConstraint.depthInertia * (1 - depth * depth);
      const inertiaVector = M.lerp(c.inertiaVector, c.stepVector, inertiaDepth);
      const inertiaRotation = M.slerp(c.inertiaRotation, c.stepRotation, inertiaDepth);
      let lpos = M.sub(oldPos, c.oldWorldPosition);
      lpos = M.add(M.rotate(inertiaRotation, lpos), inertiaVector);
      const wpos = M.add(c.oldWorldPosition, lpos);
      const inertiaOffset = M.sub(wpos, nextPos);
      nextPos = wpos;
      velocityPos = M.add(velocityPos, inertiaOffset);
      velocity = M.rotate(inertiaRotation, velocity);
      velocity = M.mul(velocity, team.velocityWeight);
      // damping (before the forces so that gravity is not damped)
      const damping = M.saturate(M.evaluateCurve(p.dampingCurveData, depth));
      velocity = M.mul(velocity, M.saturate(1 - damping * simulationPower[2]));
      // forces: gravity (no external impact, no wind zones in the data)
      let force = M.mul(p.worldGravityDirection, p.gravity * team.gravityRatio);
      force = M.mul(force, team.scaleRatio);
      velocity = M.add(velocity, M.mul(force, dt));
      nextPos = M.add(nextPos, M.mul(velocity, dt));
    } else {
      nextPos = basePos.slice();
      velocityPos = basePos.slice();
    }
    s.velocityPos[v] = velocityPos;
    s.nextPos[v] = nextPos;
  }
}

/** SimulationStepUpdateBaseLinePose: per-step reference pose along each base line (animationPoseRatio blend). */
export function stepUpdateBaseLinePose(s, team) {
  const blendRatio = team.animationPoseRatio;
  if (blendRatio > 0.99) return;
  const scl = M.mul(team.initScale, team.scaleRatio);
  const { start, count, data } = s.baseLine;
  for (let b = 0; b < start.length; b++) {
    for (let i = 0; i < count[b]; i++) {
      const v = data[start[b] + i], pv = s.parent[v];
      if (isMove(s.attr[v]) && pv >= 0) {
        const prot = s.stepBasicRotation[pv];
        s.stepBasicPosition[v] = M.add(M.rotate(prot, M.mulv(s.vertexLocalPositions[v], scl)), s.stepBasicPosition[pv]);
        s.stepBasicRotation[v] = M.qmul(prot, s.vertexLocalRotations[v]);
      } else {
        // (negative scale: identity here) ToRotation(TRS(0, rot, 1).c1, .c2) == rot
        const prot = s.stepBasicRotation[v];
        s.stepBasicRotation[v] = M.toRotation(M.toNormal(prot), M.toTangent(prot));
      }
    }
    if (blendRatio > M.EPSILON) {
      for (let i = 0; i < count[b]; i++) {
        const v = data[start[b] + i];
        s.stepBasicPosition[v] = M.lerp(s.stepBasicPosition[v], s.basePos[v], blendRatio);
        s.stepBasicRotation[v] = M.slerp(s.stepBasicRotation[v], s.baseRot[v], blendRatio);
      }
    }
  }
}

/** TetherConstraint.SolverConstraint */
export function solveTether(s, team) {
  const p = team.params.tetherConstraint;
  for (let v = 0; v < s.count; v++) {
    if (!isMove(s.attr[v])) continue;
    const r = s.root[v];
    if (r < 0) continue;
    let nextPos = s.nextPos[v];
    const rootPos = s.nextPos[r];
    const d = M.sub(rootPos, nextPos);
    const distance = M.length(d);
    if (distance < M.EPSILON) continue;
    const calcDistance = M.distance(s.stepBasicPosition[v], s.stepBasicPosition[r]);
    if (calcDistance === 0) continue;
    const ratio = distance / calcDistance;
    const compressionLimit = 1 - p.compressionLimit, stretchLimit = 1 + p.stretchLimit;
    let dist, stiffness, attn;
    if (ratio < compressionLimit) {
      dist = distance - compressionLimit * calcDistance;
      stiffness = TETHER_COMPRESSION_STIFFNESS * M.saturate((compressionLimit - ratio) / TETHER_STIFFNESS_WIDTH);
      attn = TETHER_COMPRESSION_ATTN;
    } else if (ratio > stretchLimit) {
      dist = distance - stretchLimit * calcDistance;
      stiffness = TETHER_STRETCH_STIFFNESS * M.saturate((ratio - stretchLimit) / TETHER_STIFFNESS_WIDTH);
      attn = TETHER_STRETCH_ATTN;
    } else continue;
    const add = M.mul(d, (dist * stiffness) / distance);
    s.nextPos[v] = M.add(nextPos, add);
    s.velocityPos[v] = M.add(s.velocityPos[v], M.mul(add, attn));
  }
}

/** DistanceConstraint.SolverConstraint (in place, particle order) */
export function solveDistance(s, team, simulationPower) {
  const p = team.params.distanceConstraint, dc = s.distance;
  if (!dc) return;
  const blendRatio = team.animationPoseRatio;
  const scl = team.initScale[0] * team.scaleRatio;
  const fixMass = 50;
  for (let v = 0; v < s.count; v++) {
    const attr = s.attr[v];
    if (isInvalid(attr) || isDontMove(attr)) continue;
    const depth = s.depth[v];
    const invMass = M.calcInverseMassFix(s.friction[v], depth, isDontMove(attr), fixMass);
    const stiffness = M.saturate(M.evaluateCurve(p.restorationStiffness, depth)) * simulationPower[1];
    const pack = dc.index[v], dcnt = (pack >>> 20) & 0xfff, dstart = pack & 0xfffff;
    if (dcnt === 0) continue;
    const nextPos = s.nextPos[v], px = nextPos[0], py = nextPos[1], pz = nextPos[2];
    const basePos = s.basePos[v];
    // scalar form of: d = tNext - nextPos; n = normalize(d); corr = n * k; addPos += corr * invMass (same order)
    let ax = 0, ay = 0, az = 0, addCnt = 0;
    for (let i = 0; i < dcnt; i++) {
      const t = dc.data[dstart + i], restDist = dc.dist[dstart + i];
      const finalStiffness = M.saturate(restDist >= 0 ? stiffness : stiffness * DISTANCE_HORIZONTAL_STIFFNESS);
      const tNext = s.nextPos[t];
      const tInvMass = M.calcInverseMassFix(s.friction[t], s.depth[t], isDontMove(s.attr[t]), fixMass);
      const restLength = M.lerpf(Math.abs(restDist) * scl, M.distance(basePos, s.basePos[t]), blendRatio);
      const dx = tNext[0] - px, dy = tNext[1] - py, dz = tNext[2] - pz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < M.EPSILON) continue;
      const k = 1 / distance, f = (finalStiffness * (distance - restLength)) / (invMass + tInvMass);
      ax = ax + dx * k * f * invMass; ay = ay + dy * k * f * invMass; az = az + dz * k * f * invMass;
      addCnt++;
    }
    if (addCnt > 0) {
      const inv = 1 / addCnt, att = p.velocityAttenuation, vp = s.velocityPos[v];
      ax = ax * inv; ay = ay * inv; az = az * inv;
      s.nextPos[v] = [px + ax, py + ay, pz + az];
      s.velocityPos[v] = [vp[0] + ax * att, vp[1] + ay * att, vp[2] + az * att];
    }
  }
}

/** AngleConstraint.SolverConstraint (limit + restoration along base lines) */
export function solveAngle(s, team, simulationPower) {
  const ap = team.params.angleConstraint;
  if (!ap.useAngleLimit && !ap.useAngleRestoration) return;
  const { start, count, data } = s.baseLine;
  const gravityFalloff = M.lerpf(1 - ap.restorationGravityFalloff, 1, team.gravityDot);
  const lengthBuf = s.tmpLength, localPosBuf = s.tmpLocalPos, localRotBuf = s.tmpLocalRot, rotBuf = s.tmpRot, restVecBuf = s.tmpRestVec;
  for (let b = 0; b < start.length; b++) {
    const dcnt = count[b], st = start[b];
    for (let i = 0; i < dcnt; i++) {
      const v = data[st + i];
      const npos = s.nextPos[v], bpos = s.stepBasicPosition[v], brot = s.stepBasicRotation[v];
      rotBuf[v] = brot.slice();
      if (i > 0) {
        const pv = s.parent[v];
        const pnpos = s.nextPos[pv], pbpos = s.stepBasicPosition[pv], pbrot = s.stepBasicRotation[pv];
        if (ap.useAngleLimit) {
          const vlen = M.distance(npos, pnpos);
          const bv = M.sub(bpos, pbpos), bvlen = M.length(bv);
          if (vlen < M.EPSILON || bvlen < M.EPSILON) {
            lengthBuf[v] = 0; localPosBuf[v] = [0, 0, 0]; localRotBuf[v] = M.IDENTITY.slice();
          } else {
            const ipq = M.qinverse(pbrot);
            lengthBuf[v] = vlen;
            localPosBuf[v] = M.rotate(ipq, M.mul(bv, 1 / bvlen));
            localRotBuf[v] = M.qmul(ipq, brot);
          }
        }
        if (ap.useAngleRestoration) restVecBuf[v] = M.sub(bpos, pbpos);
      }
    }
    for (let k = 0; k < ANGLE_LIMIT_ITERATION; k++) {
      const iterationRatio = k / (ANGLE_LIMIT_ITERATION - 1);
      const limitRotRatio = 0.4, restorationRotRatio = M.lerpf(0.1, 0.5, iterationRatio);
      for (let i = 0; i < dcnt; i++) {
        const v = data[st + i];
        let cpos = s.nextPos[v];
        const cdepth = s.depth[v], cattr = s.attr[v];
        const cInvMass = M.calcInverseMassF(s.friction[v]);
        if (!isMove(cattr)) continue;
        const pv = s.parent[v];
        let ppos = s.nextPos[pv];
        const pattr = s.attr[pv];
        const pInvMass = M.calcInverseMassF(s.friction[pv]);
        angleLimit: if (ap.useAngleLimit) {
          // scalar form of the source's float3 chain (same operation order); arrays only where a helper takes one
          const prot = rotBuf[pv], localPos = localPosBuf[v], localRot = localRotBuf[v];
          let dx = cpos[0] - ppos[0], dy = cpos[1] - ppos[1], dz = cpos[2] - ppos[2];
          let vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (vlen < M.EPSILON) break angleLimit;
          let tv = M.rotate(prot, localPos);
          const tvlen = M.length(tv);
          if (tvlen < M.EPSILON) {
            const add = M.sub(ppos, cpos);
            s.nextPos[v] = ppos.slice();
            s.velocityPos[v] = M.add(s.velocityPos[v], add);
            rotBuf[v] = M.qmul(prot, localRot);
            break angleLimit;
          }
          const iv = 1 / vlen;
          dx = dx * iv; dy = dy * iv; dz = dz * iv;
          tv = M.mul(tv, 1 / tvlen);
          const blen = lengthBuf[v];
          vlen = M.lerpf(vlen, blen, 0.5);
          if (blen < M.EPSILON || vlen < M.EPSILON) break angleLimit;
          const d = [dx * vlen, dy * vlen, dz * vlen];
          const maxAngleRad = M.radians(M.evaluateCurve(ap.limitCurveData, cdepth));
          const angle = M.angleV(d, tv);
          let rv = d;
          if (angle > maxAngleRad) rv = M.clampAngleV(d, tv, M.lerpf(angle, maxAngleRad, ap.limitstiffness))[0];
          const crr = 1 - limitRotRatio;
          const rpx = ppos[0] + d[0] * limitRotRatio, rpy = ppos[1] + d[1] * limitRotRatio, rpz = ppos[2] + d[2] * limitRotRatio;   // rotPos
          const pax = (rpx - rv[0] * limitRotRatio - ppos[0]) * pInvMass, pay = (rpy - rv[1] * limitRotRatio - ppos[1]) * pInvMass,
            paz = (rpz - rv[2] * limitRotRatio - ppos[2]) * pInvMass;   // padd = (pfpos - ppos) * pInvMass
          const cax = (rpx + rv[0] * crr - cpos[0]) * cInvMass, cay = (rpy + rv[1] * crr - cpos[1]) * cInvMass,
            caz = (rpz + rv[2] * crr - cpos[2]) * cInvMass;   // cadd = (cfpos - cpos) * cInvMass
          if (isMove(cattr)) {
            const vp = s.velocityPos[v];
            cpos = [cpos[0] + cax, cpos[1] + cay, cpos[2] + caz];
            s.nextPos[v] = cpos;
            s.velocityPos[v] = [vp[0] + cax * ANGLE_LIMIT_ATTENUATION, vp[1] + cay * ANGLE_LIMIT_ATTENUATION, vp[2] + caz * ANGLE_LIMIT_ATTENUATION];
          }
          if (isMove(pattr)) {
            const vp = s.velocityPos[pv];
            ppos = [ppos[0] + pax, ppos[1] + pay, ppos[2] + paz];
            s.nextPos[pv] = ppos;
            s.velocityPos[pv] = [vp[0] + pax * ANGLE_LIMIT_ATTENUATION, vp[1] + pay * ANGLE_LIMIT_ATTENUATION, vp[2] + paz * ANGLE_LIMIT_ATTENUATION];
          }
          dx = cpos[0] - ppos[0]; dy = cpos[1] - ppos[1]; dz = cpos[2] - ppos[2];
          vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (vlen < M.EPSILON) break angleLimit;
          const iv2 = 1 / vlen;
          rotBuf[v] = M.qmul(M.fromToRotationWithoutNormalize(tv, [dx * iv2, dy * iv2, dz * iv2]), M.qmul(prot, localRot));
        }
        if (ap.useAngleRestoration) {
          const tv = restVecBuf[v], tvlen = M.length(tv);
          if (tvlen < M.EPSILON) {
            const add = M.sub(ppos, cpos);
            s.nextPos[v] = ppos.slice();
            s.velocityPos[v] = M.add(s.velocityPos[v], add);
            continue;
          }
          const d = M.sub(cpos, ppos), vlen = M.length(d);
          if (vlen < M.EPSILON) continue;
          let restorationStiffness = M.saturate(M.saturate(M.evaluateCurve(ap.restorationStiffness, cdepth)) * simulationPower[3]);
          restorationStiffness *= gravityFalloff;
          const q = M.fromToRotationWithoutNormalize(M.mul(d, 1 / vlen), M.mul(tv, 1 / tvlen), restorationStiffness);
          const rv = M.rotate(q, d);
          // rotPos / pfpos / cfpos / padd / cadd as scalars (same operation order)
          const rr = restorationRotRatio, crr = 1 - restorationRotRatio, att = ap.restorationVelocityAttenuation;
          const rpx = ppos[0] + d[0] * rr, rpy = ppos[1] + d[1] * rr, rpz = ppos[2] + d[2] * rr;
          // NOTE the source multiplies padd by the CHILD's and cadd by the PARENT's inverse mass (kept as is)
          const pax = (rpx - rv[0] * rr - ppos[0]) * cInvMass, pay = (rpy - rv[1] * rr - ppos[1]) * cInvMass, paz = (rpz - rv[2] * rr - ppos[2]) * cInvMass;
          const cax = (rpx + rv[0] * crr - cpos[0]) * pInvMass, cay = (rpy + rv[1] * crr - cpos[1]) * pInvMass, caz = (rpz + rv[2] * crr - cpos[2]) * pInvMass;
          if (isMove(cattr)) {
            const vp = s.velocityPos[v];
            cpos = [cpos[0] + cax, cpos[1] + cay, cpos[2] + caz];
            s.nextPos[v] = cpos;
            s.velocityPos[v] = [vp[0] + cax * att, vp[1] + cay * att, vp[2] + caz * att];
          }
          if (isMove(pattr)) {
            const vp = s.velocityPos[pv];
            ppos = [ppos[0] + pax, ppos[1] + pay, ppos[2] + paz];
            s.nextPos[pv] = ppos;
            s.velocityPos[pv] = [vp[0] + pax * att, vp[1] + pay * att, vp[2] + paz * att];
          }
        }
      }
    }
  }
  for (let b = 0; b < start.length; b++) {
    for (let i = 0; i < count[b]; i++) {
      const v = data[start[b] + i];
      lengthBuf[v] = 0; localPosBuf[v] = [0, 0, 0]; restVecBuf[v] = [0, 0, 0];
    }
  }
}

/** SimulationClearTempBuffer (fixed-point accumulation buffers: Int32Array 3N / N) */
export function clearTempBuffer(s) {
  s.tmpVecA.fill(0); s.tmpVecB.fill(0); s.tmpCount.fill(0); s.tmpFloatA.fill(0);
}

/** SimulationStepPostTeam: friction, velocity, speed limit, centrifugal acceleration, commit. */
export function stepPostTeam(s, team, dt) {
  const c = team.center, p = team.params;
  for (let v = 0; v < s.count; v++) {
    const attr = s.attr[v], depth = s.depth[v];
    let nextPos = s.nextPos[v];
    const oldPos = s.oldPos[v];
    if (isMove(attr)) {
      let velocityOldPos = s.velocityPos[v];
      let friction = s.friction[v];
      const cn = s.collisionNormal[v];
      const isCollision = M.lengthsq(cn) > M.EPSILON;
      const staticFrictionParam = p.colliderCollisionConstraint.staticFriction * team.scaleRatio;
      const dynamicFrictionParam = p.colliderCollisionConstraint.dynamicFriction;
      let staticFriction = s.staticFriction[v];
      if (isCollision && friction > 0 && staticFrictionParam > 0) {
        const mv = M.sub(nextPos, oldPos);
        let tanv = M.sub(mv, M.mul(cn, M.dot(mv, cn)));   // MathUtility.Project (cn is unit)
        const tangentVelocity = M.length(tanv) / dt;
        if (tangentVelocity < staticFrictionParam) staticFriction = M.saturate(staticFriction + 0.04);
        else staticFriction = M.saturate(staticFriction - Math.max((tangentVelocity - staticFrictionParam) / 0.2, 0.05));
        tanv = M.mul(tanv, staticFriction);
        nextPos = M.sub(nextPos, tanv);
        velocityOldPos = M.sub(velocityOldPos, tanv);
      } else staticFriction = M.saturate(staticFriction - 0.05);
      s.staticFriction[v] = staticFriction;

      let velocity = M.mul(M.sub(nextPos, velocityOldPos), 1 / dt);
      const sqVel = M.lengthsq(velocity);
      const normalVelocity = sqVel > M.EPSILON ? M.normalize(velocity) : [0, 0, 0];
      if (friction > M.EPSILON && isCollision && dynamicFrictionParam > 0 && sqVel >= M.EPSILON) {
        let d = 0.5 + 0.5 * M.dot(cn, normalVelocity);
        d *= d;
        d = 1 - d;
        velocity = M.sub(velocity, M.mul(velocity, d * M.saturate(friction * dynamicFrictionParam)));
      }
      friction *= FRICTION_DAMPING_RATE;
      s.friction[v] = friction;
      if (p.inertiaConstraint.particleSpeedLimit >= 0) {
        velocity = M.clampVector(velocity, p.inertiaConstraint.particleSpeedLimit * team.scaleRatio);
      }
      if (c.angularVelocity > M.EPSILON && p.inertiaConstraint.centrifualAcceleration > M.EPSILON && sqVel >= M.EPSILON) {
        const lpos = M.sub(nextPos, c.nowWorldPosition);
        const pv = M.sub(lpos, M.mul(c.rotationAxis, M.dot(lpos, c.rotationAxis)));   // ProjectOnPlane
        const r = M.length(pv);
        if (r > M.EPSILON) {
          const n = M.mul(pv, 1 / r);
          const w = c.angularVelocity, m = 1 + (1 - depth);
          let f = m * w * w * r;
          const u = M.normalize(M.cross(c.rotationAxis, n));
          f *= M.saturate(M.dot(normalVelocity, u));
          velocity = M.add(velocity, M.mul(n, f * p.inertiaConstraint.centrifualAcceleration * 0.02));
        }
      }
      velocity = M.mul(velocity, team.velocityWeight);
      s.velocity[v] = velocity;
    }
    s.realVelocity[v] = M.mul(M.sub(nextPos, oldPos), 1 / dt);
    s.oldPos[v] = nextPos.slice();
    s.nextPos[v] = nextPos;
  }
}

/** SimulationCalcDisplayPosition: future prediction to the frame time, blend weight, store old origin. */
export function calcDisplayPosition(s, team, dt) {
  for (let v = 0; v < s.count; v++) {
    const pos = s.positions[v], rot = s.rotations[v];
    if (isMove(s.attr[v])) {
      let dpos = s.oldPos[v];
      const fposPredicted = M.add(dpos, M.mul(s.realVelocity[v], dt));
      const interval = (team.nowUpdateTime + dt) - team.oldTime;
      const t = interval > 0 ? (team.time - team.oldTime) / interval : 0;
      // game version (< 2.11.1): no clamp of the prediction by the distance from the root
      dpos = M.lerp(s.dispPos[v], fposPredicted, t);
      s.dispPos[v] = dpos;
      s.positions[v] = M.lerp(s.positions[v], dpos, team.blendWeight);
    } else {
      s.dispPos[v] = pos.slice();
    }
    if (team.running) {
      s.oldPosition[v] = pos.slice();
      s.oldRotation[v] = rot.slice();
    }
  }
}

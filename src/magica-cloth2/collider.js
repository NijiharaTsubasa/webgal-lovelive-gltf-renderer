// MagicaCloth2 collider state for one team (Manager/Simulation/ColliderManager.cs, v2.16.0):
// SimulationPreUpdate / SimulationStartStep / SimulationEndStep / SimulationPostUpdate.
// Symmetry colliders (2.15) and negative scale are not part of the game version and are not ported.
import * as M from "./math.js";
import { aabb, aabbExpand, aabbEncapsulate } from "./constraints.js";

export const ColliderType = { None: 0, Sphere: 1, CapsuleX_Center: 2, CapsuleY_Center: 3, CapsuleZ_Center: 4,
  CapsuleX_Start: 5, CapsuleY_Start: 6, CapsuleZ_Start: 7, Plane: 8 };

/**
 * defs: [{ type, center:[3], size:[3] (already GetSize(): capsule without radiusSeparation -> (r, r, len)),
 *          reverse: bool, enable: bool, transformId }]
 */
export function createColliders(defs) {
  const n = defs.length;
  const z = () => defs.map(() => [0, 0, 0]), q = () => defs.map(() => M.IDENTITY.slice());
  return {
    count: n,
    type: defs.map((d) => d.type), center: defs.map((d) => d.center.slice()), size: defs.map((d) => d.size.slice()),
    reverse: defs.map((d) => !!d.reverse), enable: defs.map((d) => d.enable !== false), reset: defs.map(() => true),
    transformId: defs.map((d) => d.transformId),
    framePositions: z(), frameRotations: q(), frameScales: defs.map(() => [1, 1, 1]),
    oldFramePositions: z(), oldFrameRotations: q(),
    nowPositions: z(), nowRotations: q(), oldPositions: z(), oldRotations: q(),
    work: defs.map(() => null),
  };
}

/** SimulationPreUpdate: world pose of each collider this frame (+ reset / inertia shift of the history). */
export function collidersPreUpdate(cs, team, readWorld) {
  const c = team.center;
  for (let i = 0; i < cs.count; i++) {
    if (!cs.enable[i]) continue;
    const w = readWorld(cs.transformId[i]);   // { position, rotation, scale }
    const wrot = w.rotation, wscl = w.scale;
    if (wscl.some((x) => x < 0)) throw new Error("MagicaCloth2: negative collider scale is not supported");
    const wpos = M.add(w.position, M.mulv(M.rotate(wrot, cs.center[i]), wscl));
    cs.framePositions[i] = wpos; cs.frameRotations[i] = wrot.slice(); cs.frameScales[i] = wscl.slice();
    if (team.reset || cs.reset[i]) {
      cs.oldFramePositions[i] = wpos.slice(); cs.oldFrameRotations[i] = wrot.slice();
      cs.nowPositions[i] = wpos.slice(); cs.nowRotations[i] = wrot.slice();
      cs.oldPositions[i] = wpos.slice(); cs.oldRotations[i] = wrot.slice();
      cs.reset[i] = false;
    } else if (team.inertiaShift) {
      const pivot = c.oldComponentWorldPosition, sv = c.frameComponentShiftVector, sr = c.frameComponentShiftRotation;
      cs.oldFramePositions[i] = M.shiftPosition(cs.oldFramePositions[i], pivot, sv, sr);
      cs.oldFrameRotations[i] = M.qmul(sr, cs.oldFrameRotations[i]);
      cs.nowPositions[i] = M.shiftPosition(cs.nowPositions[i], pivot, sv, sr);
      cs.nowRotations[i] = M.qmul(sr, cs.nowRotations[i]);
      cs.oldPositions[i] = M.shiftPosition(cs.oldPositions[i], pivot, sv, sr);
      cs.oldRotations[i] = M.qmul(sr, cs.oldRotations[i]);
    }
  }
}

/** SimulationStartStep: interpolated pose at this step and the swept shape (WorkData). */
export function collidersStartStep(cs, team) {
  const c = team.center;
  for (let i = 0; i < cs.count; i++) {
    if (!cs.enable[i]) continue;
    const pos = M.lerp(cs.oldFramePositions[i], cs.framePositions[i], team.frameInterpolation);
    const rot = M.qnormalize(M.slerp(cs.oldFrameRotations[i], cs.frameRotations[i], team.frameInterpolation));
    cs.nowPositions[i] = pos; cs.nowRotations[i] = rot;
    const oldpos = M.lerp(cs.oldPositions[i], pos, c.stepMoveInertiaRatio);
    const oldrot = M.qnormalize(M.slerp(cs.oldRotations[i], rot, c.stepRotationInertiaRatio));
    cs.oldPositions[i] = oldpos; cs.oldRotations[i] = oldrot;
    // NOTE the source keeps the un-normalized slerp for inverseOldRot; slerp output is unit length anyway
    const type = cs.type[i], cscl = cs.frameScales[i];
    let csize = cs.size[i];
    const work = { inverseOldRot: M.qinverse(oldrot), rot, radius: [0, 0], oldPos: [[0, 0, 0], [0, 0, 0]], nextPos: [[0, 0, 0], [0, 0, 0]], aabb: null };
    if (type === ColliderType.Sphere) {
      const radius = csize[0] * Math.abs(cscl[0]);
      work.radius = [radius, radius];
      const box = aabb([Math.min(oldpos[0], pos[0]), Math.min(oldpos[1], pos[1]), Math.min(oldpos[2], pos[2])],
        [Math.max(oldpos[0], pos[0]), Math.max(oldpos[1], pos[1]), Math.max(oldpos[2], pos[2])]);
      work.aabb = aabbExpand(box, radius);
      work.oldPos[0] = oldpos; work.nextPos[0] = pos;
    } else if (type >= ColliderType.CapsuleX_Center && type <= ColliderType.CapsuleZ_Start) {
      const alignedCenter = type <= ColliderType.CapsuleZ_Center;
      let dir = type === ColliderType.CapsuleX_Center || type === ColliderType.CapsuleX_Start ? [1, 0, 0]
        : type === ColliderType.CapsuleY_Center || type === ColliderType.CapsuleY_Start ? [0, 1, 0] : [0, 0, 1];
      const scl0 = M.dot(cscl, dir);
      dir = M.mul(dir, Math.sign(scl0));
      const scl = Math.abs(scl0);
      if (cs.reverse[i]) dir = M.neg(dir);
      csize = M.mul(csize, scl);
      const sr = csize[0], er = csize[1], length = csize[2];
      let slen = alignedCenter ? length * 0.5 : 0;
      let elen = alignedCenter ? length * 0.5 : length - sr;
      slen = Math.max(slen - sr, 0);
      elen = Math.max(elen - er, 0);
      const soldpos = M.add(oldpos, M.rotate(oldrot, M.mul(dir, slen)));
      const eoldpos = M.sub(oldpos, M.rotate(oldrot, M.mul(dir, elen)));
      const spos = M.add(pos, M.rotate(rot, M.mul(dir, slen)));
      const epos = M.sub(pos, M.rotate(rot, M.mul(dir, elen)));
      const mn = (a, b, r) => [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r];
      const mx = (a, b, r) => [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r];
      work.aabb = aabbEncapsulate(aabb(mn(soldpos, spos, sr), mx(soldpos, spos, sr)), aabb(mn(eoldpos, epos, er), mx(eoldpos, epos, er)));
      work.radius = [sr, er];
      work.oldPos = [soldpos, eoldpos];
      work.nextPos = [spos, epos];
    } else if (type === ColliderType.Plane) {
      const dir = M.mul([0, 1, 0], Math.sign(cscl[1]));
      work.oldPos[0] = M.rotate(rot, dir);
      work.nextPos[0] = pos;
      work.aabb = aabb([-Infinity, -Infinity, -Infinity], [Infinity, Infinity, Infinity]);
    }
    cs.work[i] = work;
  }
}

/** SimulationEndStep */
export function collidersEndStep(cs) {
  for (let i = 0; i < cs.count; i++) {
    cs.oldPositions[i] = cs.nowPositions[i].slice();
    cs.oldRotations[i] = cs.nowRotations[i].slice();
  }
}

/** SimulationPostUpdate */
export function collidersPostUpdate(cs, team) {
  if (!cs.count || !team.running) return;
  for (let i = 0; i < cs.count; i++) {
    cs.oldFramePositions[i] = cs.framePositions[i].slice();
    cs.oldFrameRotations[i] = cs.frameRotations[i].slice();
  }
}

// MagicaCloth2 team (one cloth component): time accumulation, center / inertia, per-step team update.
// Ported from Manager/Team/TeamManager.cs (AlwaysTeamUpdatePostJob, SimulationCalcCenterAndInertiaAndWind,
// SimulationStepTeamUpdate, SimulationPostTeamUpdate), MagicaCloth2 v2.16.0, game version ~2.10.
// Not ported (absent from the Link!Like! data, asserted where it matters): negative scale, anchors, wind zones /
// moving wind, synchronization, distance / camera culling, AnimatorLinkage update mode, external impact forces.
import * as M from "./math.js";

export const TeleportMode = { None: 0, Reset: 1, Keep: 2 };

export function createTeam(proxy, params, inertiaInit) {
  return {
    // flags
    reset: true, timeReset: true, keepTeleport: false, inertiaShift: false, running: false,
    // time
    frameDeltaTime: 0, time: 0, oldTime: 0, nowUpdateTime: 0, oldUpdateTime: 0, frameUpdateTime: 0, frameOldTime: 0,
    timeScale: 1, nowTimeScale: 1, updateCount: 0, skipCount: 0, frameInterpolation: 1,
    gravityRatio: 1, gravityDot: 1, scaleRatio: 1,
    initScale: proxy.initScale.slice(),
    velocityWeight: 1, blendWeight: 1, distanceWeight: 1,
    params,
    center: {
      centerTransformIndex: proxy.centerTransformIndex,
      initLocalGravityDirection: inertiaInit.initLocalGravityDirection.slice(),
      componentWorldPosition: [0, 0, 0], componentWorldRotation: M.IDENTITY.slice(), componentWorldScale: [1, 1, 1],
      oldComponentWorldPosition: [0, 0, 0], oldComponentWorldRotation: M.IDENTITY.slice(), oldComponentWorldScale: [1, 1, 1],
      frameWorldPosition: [0, 0, 0], frameWorldRotation: M.IDENTITY.slice(), frameWorldScale: [1, 1, 1],
      oldFrameWorldPosition: [0, 0, 0], oldFrameWorldRotation: M.IDENTITY.slice(), oldFrameWorldScale: [1, 1, 1],
      nowWorldPosition: [0, 0, 0], nowWorldRotation: M.IDENTITY.slice(),
      oldWorldPosition: [0, 0, 0], oldWorldRotation: M.IDENTITY.slice(),
      frameComponentShiftVector: [0, 0, 0], frameComponentShiftRotation: M.IDENTITY.slice(),
      smoothingVelocity: [0, 0, 0], frameMovingSpeed: 0, frameMovingDirection: [0, 0, 0], frameLocalPosition: [0, 0, 0],
      stepVector: [0, 0, 0], stepRotation: M.IDENTITY.slice(), stepMoveInertiaRatio: 0, stepRotationInertiaRatio: 0,
      inertiaVector: [0, 0, 0], inertiaRotation: M.IDENTITY.slice(), angularVelocity: 0, rotationAxis: [0, 0, 0],
    },
  };
}

/** AlwaysTeamUpdatePostJob, time part: how many simulation steps this frame. */
export function teamFrameTime(team, frameDeltaTime, simulationDeltaTime, maxSimulationCountPerFrame, globalTimeScale = 1) {
  if (team.timeReset) {
    team.time = team.oldTime = team.nowUpdateTime = team.oldUpdateTime = team.frameUpdateTime = team.frameOldTime = 0;
  }
  team.frameDeltaTime = frameDeltaTime;
  const timeScale = team.timeScale * globalTimeScale;
  team.nowTimeScale = timeScale;
  const addTime = frameDeltaTime * timeScale;
  let time = team.time + addTime;
  const interval = time - team.nowUpdateTime;
  const updateCount = Math.trunc(interval / simulationDeltaTime);
  team.updateCount = Math.min(updateCount, maxSimulationCountPerFrame);
  team.skipCount = updateCount - team.updateCount;
  if (team.skipCount > 0) time -= simulationDeltaTime * team.skipCount;
  if (team.updateCount > 0 && addTime === 0) {
    team.updateCount = 0;
    team.skipCount = 0;
    team.nowUpdateTime = time - simulationDeltaTime + 0.0001;
  }
  if (team.updateCount > 0) {
    team.frameOldTime = team.frameUpdateTime;
    team.frameUpdateTime = time;
    team.oldUpdateTime = team.nowUpdateTime;
  }
  team.oldTime = team.time;
  team.time = time;
  team.running = team.updateCount > 0;
}

/**
 * SimulationCalcCenterAndInertiaAndWind.  `component` = world pose of the center transform
 * ({position, rotation, scale}), `fixed` = proxy vertex indices of TeamData.fixedDataChunk (centerFixedList),
 * `positions` / `rotations` = skinned proxy pose, `bindPoseRotations` = vertexBindPoseRotations.
 */
export function teamCenterAndInertia(team, simulationDeltaTime, component, fixed, positions, rotations, bindPoseRotations) {
  const c = team.center, p = team.params.inertiaConstraint;
  const componentWorldPos = component.position, componentWorldRot = component.rotation, componentWorldScl = component.scale;
  c.componentWorldPosition = componentWorldPos.slice();
  c.componentWorldRotation = componentWorldRot.slice();
  c.componentWorldScale = componentWorldScl.slice();
  const componentScaleRatio = M.length(componentWorldScl) / M.length(team.initScale);
  if (componentWorldScl.some((s) => s < 0)) throw new Error("MagicaCloth2: negative component scale is not supported");

  let oldComponentWorldPosition = c.oldComponentWorldPosition.slice();
  let oldComponentWorldRotation = c.oldComponentWorldRotation.slice();

  // cloth center: from the fixed points if any, else the component transform
  let centerWorldPos = componentWorldPos.slice(), centerWorldRot = componentWorldRot.slice();
  if (fixed && fixed.length) {
    let cen = [0, 0, 0], nor = [0, 0, 0], tan = [0, 0, 0];
    for (const v of fixed) {
      cen = M.add(cen, positions[v]);
      const rot = M.qmul(rotations[v], bindPoseRotations[v]);
      nor = M.add(nor, M.toNormal(rot));
      tan = M.add(tan, M.toTangent(rot));
    }
    centerWorldPos = M.mul(cen, 1 / fixed.length);
    centerWorldRot = M.toRotation(M.normalize(nor), M.normalize(tan));
  }
  const wtol = M.worldToLocalMatrix(centerWorldPos, centerWorldRot, componentWorldScl);

  // (anchor: not used by the data)
  const frameDeltaVector = M.sub(componentWorldPos, oldComponentWorldPosition);
  const frameDeltaAngle = M.angleQ(oldComponentWorldRotation, componentWorldRot);

  // teleport detection
  if (p.teleportMode !== TeleportMode.None && !team.reset) {
    const teleport = M.length(frameDeltaVector) >= p.teleportDistance * componentScaleRatio
      || M.degrees(frameDeltaAngle) >= p.teleportRotation;
    if (teleport) {
      if (p.teleportMode === TeleportMode.Reset) team.reset = true;
      else if (p.teleportMode === TeleportMode.Keep) team.keepTeleport = true;
    }
  }

  // smoothing of the world inertia
  let smoothDeltaVector = [0, 0, 0];
  if (p.movementInertiaSmoothing >= 1e-6) {
    if (team.running) {
      let frameDeltaVelocity = team.frameDeltaTime > 0 ? M.mul(frameDeltaVector, 1 / team.frameDeltaTime) : [0, 0, 0];
      const limit = p.movementSpeedLimit * componentScaleRatio;
      if (limit >= 0) frameDeltaVelocity = M.clampVector(frameDeltaVelocity, limit);
      const averageRatio = M.saturate(Math.pow(1 - p.movementInertiaSmoothing, 3) * 0.99 + 0.01);
      c.smoothingVelocity = M.lerp(c.smoothingVelocity, frameDeltaVelocity, averageRatio);
    }
    const smoothPos = M.sub(componentWorldPos, M.mul(c.smoothingVelocity, team.frameDeltaTime));
    smoothDeltaVector = M.sub(smoothPos, oldComponentWorldPosition);
    oldComponentWorldPosition = smoothPos;
    team.inertiaShift = true;
  }

  c.frameWorldPosition = centerWorldPos.slice();
  c.frameWorldRotation = centerWorldRot.slice();
  c.frameWorldScale = componentWorldScl.slice();
  if (team.reset) {
    c.oldComponentWorldPosition = componentWorldPos.slice();
    c.oldComponentWorldRotation = componentWorldRot.slice();
    c.oldComponentWorldScale = componentWorldScl.slice();
    oldComponentWorldPosition = componentWorldPos.slice();
    oldComponentWorldRotation = componentWorldRot.slice();
    c.oldFrameWorldPosition = centerWorldPos.slice();
    c.oldFrameWorldRotation = centerWorldRot.slice();
    c.oldFrameWorldScale = componentWorldScl.slice();
    c.nowWorldPosition = centerWorldPos.slice();
    c.nowWorldRotation = centerWorldRot.slice();
    c.oldWorldPosition = centerWorldPos.slice();
    c.oldWorldRotation = centerWorldRot.slice();
  }

  // world inertia shift
  let workOldComponentPosition = oldComponentWorldPosition.slice();
  let workOldComponentRotation = oldComponentWorldRotation.slice();
  if (team.reset) {
    c.frameComponentShiftVector = [0, 0, 0];
    c.frameComponentShiftRotation = M.IDENTITY.slice();
    c.smoothingVelocity = [0, 0, 0];
    smoothDeltaVector = [0, 0, 0];
  } else {
    c.frameComponentShiftVector = M.sub(componentWorldPos, oldComponentWorldPosition);
    c.frameComponentShiftRotation = M.fromToRotationQ(oldComponentWorldRotation, componentWorldRot);
    let moveShiftRatio = 0, rotationShiftRatio = 0;
    let movementShift = 1 - p.worldInertia, rotationShift = 1 - p.worldInertia;
    if (team.keepTeleport) { movementShift = 1; rotationShift = 1; }
    if (movementShift > M.EPSILON || rotationShift > M.EPSILON) {
      team.inertiaShift = true;
      moveShiftRatio = movementShift;
      rotationShiftRatio = rotationShift;
      workOldComponentPosition = M.lerp(workOldComponentPosition, componentWorldPos, movementShift);
      workOldComponentRotation = M.slerp(workOldComponentRotation, componentWorldRot, rotationShift);
    }
    // speed limits (on the shifted result)
    const movementSpeedLimit = p.movementSpeedLimit * componentScaleRatio, rotationSpeedLimit = p.rotationSpeedLimit;
    const deltaVector = M.sub(componentWorldPos, workOldComponentPosition);
    const deltaAngle = M.angleQ(workOldComponentRotation, componentWorldRot);
    const frameSpeed = team.frameDeltaTime > 0 ? M.length(deltaVector) / team.frameDeltaTime : 0;
    const frameRotationSpeed = team.frameDeltaTime > 0 ? M.degrees(deltaAngle) / team.frameDeltaTime : 0;
    if (frameSpeed > movementSpeedLimit && movementSpeedLimit >= 0) {
      team.inertiaShift = true;
      const r = M.saturate(Math.max(frameSpeed - movementSpeedLimit, 0) / frameSpeed);
      moveShiftRatio = M.lerpf(moveShiftRatio, 1, r);
      workOldComponentPosition = M.lerp(workOldComponentPosition, componentWorldPos, r);
    }
    if (frameRotationSpeed > rotationSpeedLimit && rotationSpeedLimit >= 0) {
      team.inertiaShift = true;
      const r = M.saturate(Math.max(frameRotationSpeed - rotationSpeedLimit, 0) / frameRotationSpeed);
      rotationShiftRatio = M.lerpf(rotationShiftRatio, 1, r);
      workOldComponentRotation = M.slerp(workOldComponentRotation, componentWorldRot, r);
    }
    let otherShiftRatio = 0;
    if (team.skipCount > 0) {
      otherShiftRatio = M.lerpf(otherShiftRatio, 1, M.saturate((team.skipCount * simulationDeltaTime) / (team.frameDeltaTime * team.nowTimeScale)));
    }
    if (team.velocityWeight < 1) otherShiftRatio = M.lerpf(otherShiftRatio, 1, 1 - team.velocityWeight);
    if (team.nowTimeScale < 1) otherShiftRatio = M.lerpf(otherShiftRatio, 1, 1 - team.nowTimeScale);
    if (otherShiftRatio > 0) {
      team.inertiaShift = true;
      moveShiftRatio = M.lerpf(moveShiftRatio, 1, otherShiftRatio);
      workOldComponentPosition = M.lerp(workOldComponentPosition, componentWorldPos, otherShiftRatio);
      rotationShiftRatio = M.lerpf(rotationShiftRatio, 1, otherShiftRatio);
      workOldComponentRotation = M.slerp(workOldComponentRotation, componentWorldRot, otherShiftRatio);
    }
    if (team.inertiaShift) {
      c.frameComponentShiftVector = M.mul(c.frameComponentShiftVector, moveShiftRatio);
      c.frameComponentShiftRotation = M.slerp(M.IDENTITY, c.frameComponentShiftRotation, rotationShiftRatio);
      c.frameComponentShiftVector = M.add(c.frameComponentShiftVector, smoothDeltaVector);   // (no anchor delta)
      c.oldFrameWorldPosition = M.shiftPosition(c.oldFrameWorldPosition, c.oldComponentWorldPosition, c.frameComponentShiftVector, c.frameComponentShiftRotation);
      c.oldFrameWorldRotation = M.qmul(c.frameComponentShiftRotation, c.oldFrameWorldRotation);
      c.nowWorldPosition = M.shiftPosition(c.nowWorldPosition, c.oldComponentWorldPosition, c.frameComponentShiftVector, c.frameComponentShiftRotation);
      c.nowWorldRotation = M.qmul(c.frameComponentShiftRotation, c.nowWorldRotation);
    }
  }

  const movingVector = M.sub(componentWorldPos, workOldComponentPosition);
  const movingLength = M.length(movingVector);
  c.frameMovingSpeed = team.frameDeltaTime > 0 ? movingLength / team.frameDeltaTime : 0;
  c.frameMovingSpeed *= team.nowTimeScale > 1e-6 ? 1 / team.nowTimeScale : 0;
  c.frameMovingDirection = movingLength > 1e-6 ? M.mul(movingVector, 1 / movingLength) : [0, 0, 0];
  c.frameLocalPosition = M.m4point(wtol, centerWorldPos);

  if (team.reset || team.timeReset) {
    team.velocityWeight = team.params.stablizationTimeAfterReset > 1e-6 ? 0 : 1;
    team.blendWeight = team.velocityWeight;
  }
}

/** SimulationStepTeamUpdate: center pose at this step, local inertia, gravity falloff, stabilization. */
export function teamStep(team, simulationDeltaTime) {
  const c = team.center, p = team.params;
  team.nowUpdateTime += simulationDeltaTime;
  const b = team.time - team.frameOldTime;
  team.frameInterpolation = b > 0 ? M.saturate((team.nowUpdateTime - team.frameOldTime) / b) : 1;

  c.oldWorldPosition = c.nowWorldPosition.slice();
  c.oldWorldRotation = c.nowWorldRotation.slice();
  c.nowWorldPosition = M.lerp(c.oldFrameWorldPosition, c.frameWorldPosition, team.frameInterpolation);
  c.nowWorldRotation = M.qnormalize(M.slerp(c.oldFrameWorldRotation, c.frameWorldRotation, team.frameInterpolation));
  const wscl = M.lerp(c.oldFrameWorldScale, c.frameWorldScale, team.frameInterpolation);

  c.stepVector = M.sub(c.nowWorldPosition, c.oldWorldPosition);
  c.stepRotation = M.fromToRotationQ(c.oldWorldRotation, c.nowWorldRotation);
  const stepAngle = M.angleQ(c.oldWorldRotation, c.nowWorldRotation);

  const ip = p.inertiaConstraint;
  let localMovementInertia = 1 - ip.localInertia, localRotationInertia = 1 - ip.localInertia;
  const localVector = M.mul(c.stepVector, 1 - localMovementInertia);
  const localMovementSpeed = M.length(localVector) / simulationDeltaTime;
  if (localMovementSpeed > ip.localMovementSpeedLimit && ip.localMovementSpeedLimit >= 0) {
    localMovementInertia = M.lerpf(1, localMovementInertia, ip.localMovementSpeedLimit / localMovementSpeed);
  }
  const localAngle = stepAngle * (1 - localRotationInertia);
  const localAngleSpeed = M.degrees(localAngle / simulationDeltaTime);
  if (localAngleSpeed > ip.localRotationSpeedLimit && ip.localRotationSpeedLimit >= 0) {
    localRotationInertia = M.lerpf(1, localRotationInertia, ip.localRotationSpeedLimit / localAngleSpeed);
  }
  c.stepMoveInertiaRatio = localMovementInertia;
  c.stepRotationInertiaRatio = localRotationInertia;
  c.inertiaVector = M.lerp([0, 0, 0], c.stepVector, localMovementInertia);
  c.inertiaRotation = M.slerp(M.IDENTITY, c.stepRotation, localRotationInertia);

  c.angularVelocity = stepAngle / simulationDeltaTime;
  c.rotationAxis = c.angularVelocity > M.EPSILON ? M.toAngleAxis(c.stepRotation)[1] : [0, 0, 0];

  team.scaleRatio = Math.max(M.length(wscl) / M.length(team.initScale), 1e-6);

  let gravityDot = 1;
  if (M.lengthsq(p.worldGravityDirection) > M.EPSILON) {
    const worldFalloffDir = M.rotate(c.nowWorldRotation, c.initLocalGravityDirection);
    gravityDot = M.saturate(M.dot(worldFalloffDir, p.worldGravityDirection) * 0.5 + 0.5);
  }
  team.gravityDot = gravityDot;
  let gravityRatio = 1;
  if (p.gravity > 1e-6 && p.gravityFalloff > 1e-6) {
    gravityRatio = M.lerpf(M.saturate(1 - p.gravityFalloff), 1, M.saturate(1 - gravityDot));
  }
  team.gravityRatio = gravityRatio;

  if (team.velocityWeight < 1) {
    const addw = p.stablizationTimeAfterReset > 1e-6 ? simulationDeltaTime / p.stablizationTimeAfterReset : 1;
    team.velocityWeight = M.saturate(team.velocityWeight + addw);
  }
  team.blendWeight = M.saturate(team.velocityWeight * p.blendWeight * team.distanceWeight);
}

/** SimulationPostTeamUpdate */
export function teamPost(team) {
  const c = team.center;
  c.oldComponentWorldPosition = c.componentWorldPosition.slice();
  c.oldComponentWorldRotation = c.componentWorldRotation.slice();
  c.oldComponentWorldScale = c.componentWorldScale.slice();
  if (team.running) {
    c.oldFrameWorldPosition = c.frameWorldPosition.slice();
    c.oldFrameWorldRotation = c.frameWorldRotation.slice();
    c.oldFrameWorldScale = c.frameWorldScale.slice();
    team.skipCount = 0;
  }
  team.reset = false;
  team.timeReset = false;
  team.running = false;
  team.keepTeleport = false;
  team.inertiaShift = false;
  const limitTime = 3600;
  if (team.time > limitTime * 2) {
    for (const k of ["time", "oldTime", "nowUpdateTime", "oldUpdateTime", "frameUpdateTime", "frameOldTime"]) team[k] -= limitTime;
  }
}

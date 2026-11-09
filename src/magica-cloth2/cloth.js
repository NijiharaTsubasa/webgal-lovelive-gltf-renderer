// One MagicaCloth2 component (team) per frame, in the order of SimulationManagerNormal.SimulationNormalJob.Execute
// (v2.16.0) with the game's global settings: 50 Hz, at most 5 steps per frame (Inspix MagicaClothCalculate).
import * as M from "./math.js";
import { createTeam, teamFrameTime, teamAnchor, teamCenterAndInertia, teamStep, teamPost } from "./team.js";
import {
  preTeamUpdate, stepUpdateParticles, stepUpdateBaseLinePose, solveTether, solveDistance, solveAngle,
  clearTempBuffer, stepPostTeam, calcDisplayPosition,
} from "./simulation.js";
import { solveTriangleBending, solvePointCollision, solveEdgeCollision, solveMotion } from "./constraints.js";
import { createColliders, collidersPreUpdate, collidersStartStep, collidersEndStep, collidersPostUpdate } from "./collider.js";
import { preProxyMeshUpdate, postProxyLine, postProxyTriangles, boneClothOutput, mappingWorld } from "./virtual-mesh.js";

export const GAME_SIMULATION_FREQUENCY = 50, GAME_MAX_SIMULATION_COUNT_PER_FRAME = 5;
const DEFAULT_SIMULATION_FREQUENCY = 90;

/** TimeManager.FrameUpdate: SimulationPower for a frequency. */
export function simulationPower(frequency) {
  const t = DEFAULT_SIMULATION_FREQUENCY / frequency;
  return [t, t > 1 ? Math.pow(t, 0.5) : t, t > 1 ? Math.pow(t, 0.3) : t, Math.pow(t, 1.8)];
}

function particleState(proxy, def) {
  const n = proxy.count, z3 = () => Array.from({ length: n }, () => [0, 0, 0]), q = () => Array.from({ length: n }, () => M.IDENTITY.slice());
  // BaseLine data: (start, count, data) as decoded
  return {
    count: n,
    attr: proxy.attr.slice(), depth: proxy.depth, root: proxy.root, parent: proxy.parent,
    baseLine: proxy.baseLine, vertexLocalPositions: proxy.vertexLocalPositions, vertexLocalRotations: proxy.vertexLocalRotations,
    edges: proxy.edges, distance: def.distance, bending: def.bending,
    positions: z3(), rotations: q(),
    nextPos: z3(), oldPos: z3(), oldRot: q(), basePos: z3(), baseRot: q(), oldPosition: z3(), oldRotation: q(),
    velocityPos: z3(), dispPos: z3(), velocity: z3(), realVelocity: z3(),
    friction: new Array(n).fill(0), staticFriction: new Array(n).fill(0), collisionNormal: z3(),
    stepBasicPosition: z3(), stepBasicRotation: q(),
    tmpVecA: new Int32Array(n * 3), tmpVecB: new Int32Array(n * 3), tmpCount: new Int32Array(n), tmpFloatA: new Int32Array(n),
    tmpLength: new Array(n).fill(0), tmpLocalPos: z3(), tmpLocalRot: q(), tmpRot: q(), tmpRestVec: z3(),
  };
}

export class MagicaClothTeam {
  /**
   * def: one entry of decodeMagicaCloth2(...).cloths with a proxy mesh (PreBuild data or a runtime BoneCloth build).
   * anchorTransformId: the inertia anchor.  The game anchors every cloth to the avatar root at runtime
   * (Inspix MagicaClothController.SetAnchor); the prefab root moves rigidly with it.
   */
  constructor(def, { frequency = GAME_SIMULATION_FREQUENCY, maxCount = GAME_MAX_SIMULATION_COUNT_PER_FRAME, anchorTransformId = null } = {}) {
    if (def.error) throw new Error(def.error);
    if (!def.prebuilt && !def.runtimeBuild) {
      throw new Error(`MagicaCloth2 ${def.buildId ?? def.transformId}: no PreBuild data and no runtime build (clothType ${def.clothType})`);
    }
    if (def.params.inertiaConstraint.hasAnchor) throw new Error("MagicaCloth2: serialized inertia anchors are not supported");
    if (def.params.selfCollisionMode) throw new Error("MagicaCloth2: self collision is not supported");
    // Normal (0); Unscaled (2) only swaps in Time.unscaledDeltaTime and AnimatorLinkage (10) follows the Animator's
    // update mode: without a Unity time scale or FixedUpdate both run like Normal here.  UnityPhysics (1) is unused.
    if (![0, 2, 10].includes(def.updateMode)) throw new Error(`MagicaCloth2: updateMode ${def.updateMode} is not supported`);
    this.def = def;
    this.anchorTransformId = anchorTransformId;
    this.proxy = def.proxy;
    this.params = { ...def.params, worldGravityDirection: M.normalizesafe(def.params.worldGravityDirection) };
    this.simulationDeltaTime = 1 / frequency;
    this.maxCount = maxCount;
    this.power = simulationPower(frequency);
    this.team = createTeam(this.proxy, this.params, { initLocalGravityDirection: def.initLocalGravityDirection });
    this.team.animationPoseRatio = this.params.animationPoseRatio;
    this.state = particleState(this.proxy, def);
    this.colliders = createColliders(def.colliders);
    const mode = this.params.colliderCollisionConstraint.mode;
    this.collisionMode = this.colliders.count ? mode : 0;
  }

  /** Transform ids the solver reads every frame (proxy transforms incl. the center, colliders, mapping centers). */
  get readTransformIds() {
    const ids = new Set(this.proxy.transformIds.filter((id) => id !== null));
    for (const c of this.def.colliders) ids.add(c.transformId);
    for (const m of this.def.mappings) if (m.centerTransformId) ids.add(m.centerTransformId);
    if (this.anchorTransformId !== null) ids.add(this.anchorTransformId);
    return [...ids];
  }

  /** Transform ids whose pose a BoneCloth writes (non-invalid proxy vertices). */
  get writtenTransformIds() {
    if (!this.proxy.isBoneCloth) return [];
    return this.proxy.transformIds.slice(0, this.proxy.count).filter((id, v) => id !== null && (this.state.attr[v] & 0x03) !== 0);
  }

  reset() { this.team.reset = true; this.team.timeReset = true; }

  /**
   * Advance one rendered frame.  world(id) -> { matrix (column-major localToWorld), position, rotation, scale } in
   * Unity space for any id of readTransformIds.  Returns { bones } (BoneCloth) or { meshes } (MeshCloth).
   */
  frame(deltaTime, world) {
    const { team, state: s, proxy, params, colliders } = this;
    const simDT = this.simulationDeltaTime;
    teamFrameTime(team, deltaTime, simDT, this.maxCount);
    teamAnchor(team, this.anchorTransformId !== null ? world(this.anchorTransformId) : null);

    const proxyWorld = proxy.transformIds.map((id) => world(id));
    preProxyMeshUpdate(s, proxy, proxyWorld.map((w) => w.matrix));
    const center = proxyWorld[proxy.centerTransformIndex];
    teamCenterAndInertia(team, simDT, center, proxy.centerFixedList, s.positions, s.rotations, proxy.vertexBindPoseRotations);
    preTeamUpdate(s, team);
    if (colliders.count) collidersPreUpdate(colliders, team, (id) => world(id));

    for (let i = 0; i < team.updateCount; i++) {
      teamStep(team, simDT);
      if (colliders.count) collidersStartStep(colliders, team);
      stepUpdateParticles(s, team, this.power, simDT);
      stepUpdateBaseLinePose(s, team);
      solveTether(s, team);
      solveDistance(s, team, this.power);
      solveAngle(s, team, this.power);
      clearTempBuffer(s);
      solveTriangleBending(s, team, this.power);
      if (this.collisionMode === 1) solvePointCollision(s, team, colliders);
      else if (this.collisionMode === 2) solveEdgeCollision(s, team, colliders);
      solveDistance(s, team, this.power);
      solveMotion(s, team);
      stepPostTeam(s, team, simDT);
      if (colliders.count) collidersEndStep(colliders);
    }
    calcDisplayPosition(s, team, simDT);
    postProxyLine(s, proxy, params);
    postProxyTriangles(s, proxy);

    let result;
    if (proxy.isBoneCloth) {
      result = { bones: boneClothOutput(s, proxy, proxyWorld.map((w) => w.scale)) };
    } else {
      result = { meshes: this.def.mappings.map((m) => ({ mapping: m,
        ...mappingWorld(s, proxy, m, world(m.centerTransformId), center, proxy.initScale) })) };
    }
    if (colliders.count) collidersPostUpdate(colliders, team);
    teamPost(team);
    return result;
  }
}

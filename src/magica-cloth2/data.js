// Decode physics.source.magicaCloth2 (converter: verbatim MagicaCloth2 components + PreBuild data) into solver
// inputs: ClothParameters (Cloth/ClothSerializeDataFunction.cs GetClothParameters) and the prebuilt proxy /
// mapping meshes (VirtualMesh/Function/VirtualMeshSerialization.cs).  Cloths without PreBuild data are built at
// runtime like the game does: BoneCloth from the transform hierarchy (build.js), MeshCloth from the original Unity
// mesh the converter exports as sourceRenderers[i].meshData (build-mesh.js), unless the conversion already ran that
// build (prebuild.js): its results come as component.runtimePreBuild in the PreBuild encoding.
import { buildBoneCloth, prefabHierarchy } from "./build.js";
import { buildMeshCloth } from "./build-mesh.js";
const b64 = (s) => {
  if (typeof Buffer !== "undefined") { const b = Buffer.from(s, "base64"); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
// ExSimpleNativeArray {count, length, arrayBytes}: only `count` elements are valid (capacity may be larger)
const exBytes = (ex) => b64(ex.arrayBytes.base64);
const rawBytes = (f) => b64(f.base64);

function f32(bytes, n, width) {
  const v = view(bytes), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = new Array(width);
    for (let k = 0; k < width; k++) e[k] = v.getFloat32((i * width + k) * 4, true);
    out[i] = e;
  }
  return out;
}
function scalars(bytes, n, kind) {
  const v = view(bytes), size = { u8: 1, i8: 1, u16: 2, i32: 4, u32: 4, f32: 4 }[kind], out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * size;
    out[i] = kind === "u8" ? v.getUint8(o) : kind === "i8" ? v.getInt8(o) : kind === "u16" ? v.getUint16(o, true)
      : kind === "i32" ? v.getInt32(o, true) : kind === "u32" ? v.getUint32(o, true) : v.getFloat32(o, true);
  }
  return out;
}
const count = (bytes, size) => Math.floor(bytes.byteLength / size);
const exF = (ex, width) => f32(exBytes(ex), ex.count, width);
const exS = (ex, kind) => scalars(exBytes(ex), ex.count, kind);
const rawF = (f, width) => { const b = rawBytes(f); return f32(b, count(b, width * 4), width); };
export const RUNTIME_PREBUILD_VERSION = 1;   // component.runtimePreBuild.version written by prebuild.js
const rawS = (f, kind) => { const b = rawBytes(f); return scalars(b, count(b, { u8: 1, i8: 1, u16: 2, i32: 4, u32: 4, f32: 4 }[kind]), kind); };
// VirtualMeshBoneWeight: float4 weights, int4 boneIndices (32 bytes)
function boneWeights(ex) {
  const v = view(exBytes(ex)), out = new Array(ex.count);
  for (let i = 0; i < ex.count; i++) {
    const o = i * 32;
    out[i] = { w: [0, 1, 2, 3].map((k) => v.getFloat32(o + k * 4, true)), i: [0, 1, 2, 3].map((k) => v.getInt32(o + 16 + k * 4, true)) };
  }
  return out;
}
// float4x4 is column-major (c0..c3); kept as a flat column-major 16-array
const matrices = (ex) => exF(ex, 16);
// FixedList32Bytes<uint>: ushort length, 2 padding bytes, up to 7 uints
function fixedList32(f) {
  const bytes = rawBytes(f), v = view(bytes), n = count(bytes, 32), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const len = v.getUint16(i * 32, true), e = new Array(len);
    for (let k = 0; k < len; k++) e[k] = v.getUint32(i * 32 + 4 + k * 4, true);
    out[i] = e;
  }
  return out;
}
const vec3 = (o) => [o.x, o.y, o.z];
const quat = (o) => [o.value.x, o.value.y, o.value.z, o.value.w];
const mat4 = (o) => [o.c0, o.c1, o.c2, o.c3].flatMap((c) => [c.x, c.y, c.z, c.w]);

// ------------------------------------------------------------------ AnimationCurve / parameters
// WeightedMode: None 0, In 1, Out 2, Both 3.  A weighted segment is a 2D cubic Bezier whose time handles are
// weight * dx long (an unweighted side counts as 1/3).  With 1/3 on both sides the time handles sit at dx / 3 and
// 2 dx / 3, the Bezier's time is linear in its parameter and the curve is exactly the Hermite below.  The game data
// only has weighted keys with the default 1/3 (11 skirts, backstopDistance); other weights would need the Bezier.
const DEFAULT_WEIGHT = Math.fround(1 / 3);
const defaultWeight = (w) => Math.abs(w - DEFAULT_WEIGHT) <= 1e-6;
function checkWeights(keys) {
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (((a.weightedMode ?? 0) & 2) && !defaultWeight(a.outWeight)) throw new Error(`MagicaCloth2: AnimationCurve out-weight ${a.outWeight} is not supported (only the default 1/3)`);
    if (((b.weightedMode ?? 0) & 1) && !defaultWeight(b.inWeight)) throw new Error(`MagicaCloth2: AnimationCurve in-weight ${b.inWeight} is not supported (only the default 1/3)`);
  }
}

/** UnityEngine.AnimationCurve.Evaluate for unweighted keys and weighted keys with the default 1/3 weights. */
export function evaluateAnimationCurve(curve, time) {
  const keys = curve.m_Curve;
  if (!keys.length) return 0;
  checkWeights(keys);
  if (time <= keys[0].time) return keys[0].value;                 // (game curves: clamp, keys span [0, 1])
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let i = 0;
  while (i < keys.length - 2 && time >= keys[i + 1].time) i++;
  const a = keys[i], b = keys[i + 1];
  const dx = b.time - a.time;
  if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)) return a.value;
  const t = (time - a.time) / dx, t2 = t * t, t3 = t2 * t;
  const m0 = a.outSlope * dx, m1 = b.inSlope * dx;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * m0 + (t3 - t2) * m1 + (-2 * t3 + 3 * t2) * b.value;
}
/** CurveSerializeData.ConvertFloatArray: 16 samples at i / 15 times value, or 16 x value. */
export function convertFloatArray(c) {
  const out = new Array(16);
  for (let i = 0; i < 16; i++) out[i] = c.useCurve ? Math.fround(Math.fround(evaluateAnimationCurve(c.curve, Math.fround(i / 15))) * c.value) : c.value;
  return out;
}
const slider = (s, unused) => (s.use ? s.value : unused);   // CheckSliderSerializeData.GetValue
const scaleCurve = (a, k) => a.map((x) => Math.fround(x * k));
const SYSTEM = { TetherStretchLimit: 0.03, DistanceVelocityAttenuation: 0.3 };

/** ClothSerializeData.GetClothParameters (MeshCloth / BoneCloth; BoneSpring is not in the game data). */
export function clothParameters(sd) {
  if (sd.clothType !== 0 && sd.clothType !== 1) throw new Error(`MagicaCloth2: clothType ${sd.clothType} is not supported`);
  const ic = sd.inertiaConstraint, ar = sd.angleRestorationConstraint, al = sd.angleLimitConstraint;
  const mc = sd.motionConstraint, cc = sd.colliderCollisionConstraint;
  const g = vec3(sd.gravityDirection);
  return {
    clothType: sd.clothType,
    gravity: sd.gravity,
    worldGravityDirection: g,
    gravityFalloff: sd.gravityFalloff,
    stablizationTimeAfterReset: sd.stablizationTimeAfterReset,
    blendWeight: sd.blendWeight,
    dampingCurveData: scaleCurve(convertFloatArray(sd.damping), 0.2),
    radiusCurveData: convertFloatArray(sd.radius),
    normalAxis: sd.normalAxis,
    rotationalInterpolation: sd.rotationalInterpolation,
    rootRotation: sd.rootRotation,
    animationPoseRatio: sd.animationPoseRatio,
    inertiaConstraint: {
      anchorInertia: ic.anchorInertia, worldInertia: ic.worldInertia, movementInertiaSmoothing: ic.movementInertiaSmoothing,
      movementSpeedLimit: slider(ic.movementSpeedLimit, -1), rotationSpeedLimit: slider(ic.rotationSpeedLimit, -1),
      localInertia: ic.localInertia, localMovementSpeedLimit: slider(ic.localMovementSpeedLimit, -1),
      localRotationSpeedLimit: slider(ic.localRotationSpeedLimit, -1), depthInertia: ic.depthInertia,
      centrifualAcceleration: ic.centrifualAcceleration, particleSpeedLimit: slider(ic.particleSpeedLimit, -1),
      teleportMode: ic.teleportMode, teleportDistance: ic.teleportDistance, teleportRotation: ic.teleportRotation,
      hasAnchor: !!ic.anchor,
    },
    tetherConstraint: { compressionLimit: sd.tetherConstraint.distanceCompression, stretchLimit: SYSTEM.TetherStretchLimit },
    distanceConstraint: { restorationStiffness: convertFloatArray(sd.distanceConstraint.stiffness), velocityAttenuation: SYSTEM.DistanceVelocityAttenuation },
    triangleBendingConstraint: { method: sd.triangleBendingConstraint.stiffness > 1e-8 ? 2 : 0, stiffness: sd.triangleBendingConstraint.stiffness },
    angleConstraint: {
      useAngleRestoration: !!ar.useAngleRestoration, restorationStiffness: scaleCurve(convertFloatArray(ar.stiffness), 0.2),
      restorationVelocityAttenuation: ar.velocityAttenuation, restorationGravityFalloff: ar.gravityFalloff,
      useAngleLimit: !!al.useAngleLimit, limitCurveData: convertFloatArray(al.limitAngle), limitstiffness: al.stiffness,
    },
    motionConstraint: {
      useMaxDistance: !!mc.useMaxDistance, maxDistanceCurveData: convertFloatArray(mc.maxDistance),
      useBackstop: !!mc.useBackstop, backstopRadius: mc.backstopRadius, backstopDistanceCurveData: convertFloatArray(mc.backstopDistance),
      stiffness: mc.stiffness,
    },
    colliderCollisionConstraint: { mode: cc.mode, dynamicFriction: cc.friction * 1.0, staticFriction: cc.friction * 1.0 },
    selfCollisionMode: sd.selfCollisionConstraint?.selfMode ?? 0,
  };
}

// ------------------------------------------------------------------ PreBuild meshes
function proxyMesh(share, unique) {
  const m = share.proxyMesh;
  const n = m.attributes.count;
  const ids = unique.proxyMesh.transformData.transformArray.map((t) => t?.transformId ?? null);
  const childIndex = rawS(m.vertexChildIndexArray, "u32"), childData = rawS(m.vertexChildDataArray, "u16");
  return {
    count: n,
    meshType: m.meshType, isBoneCloth: !!m.isBoneCloth,
    attr: exS(m.attributes, "u8"),
    localPositions: exF(m.localPositions, 3), localNormals: exF(m.localNormals, 3), localTangents: exF(m.localTangents, 3),
    uv: exF(m.uv, 2), boneWeights: boneWeights(m.boneWeights),
    triangles: scalars(exBytes(m.triangles), m.triangles.count * 3, "i32"), lines: scalars(exBytes(m.lines), m.lines.count * 2, "i32"), edges: rawS(m.edges, "i32"),
    vertexToTriangles: fixedList32(m.vertexToTriangles),
    depth: rawS(m.vertexDepths, "f32"), root: rawS(m.vertexRootIndices, "i32"), parent: rawS(m.vertexParentIndices, "i32"),
    childIndex, childData,
    vertexLocalPositions: rawF(m.vertexLocalPositions, 3), vertexLocalRotations: rawF(m.vertexLocalRotations, 4),
    vertexBindPosePositions: rawF(m.vertexBindPosePositions, 3), vertexBindPoseRotations: rawF(m.vertexBindPoseRotations, 4),
    vertexToTransformRotations: rawF(m.vertexToTransformRotations, 4), normalAdjustmentRotations: rawF(m.normalAdjustmentRotations, 4),
    baseLine: {
      flags: rawS(m.baseLineFlags, "u8"), start: rawS(m.baseLineStartDataIndices, "u16"),
      count: rawS(m.baseLineDataCounts, "u16"), data: rawS(m.baseLineData, "u16"),
    },
    centerFixedList: (m.centerFixedList ?? []).slice(),
    centerTransformIndex: m.centerTransformIndex,
    skinRootIndex: m.skinRootIndex,
    skinBoneTransformIndices: exS(m.skinBoneTransformIndices, "i32"),
    skinBoneBindPoses: matrices(m.skinBoneBindPoses),
    initScale: vec3(m.initScale),
    initLocalToWorld: mat4(m.initLocalToWorld),
    transformIds: ids,
  };
}

function mappingMesh(m, unique, setup) {
  return {
    name: m.name,
    renderer: setup.renderer,                     // {transformId, class, mesh:{name, node, primitives}}
    attr: exS(m.attributes, "u8"),
    localPositions: exF(m.localPositions, 3), localNormals: exF(m.localNormals, 3), localTangents: exF(m.localTangents, 3),
    boneWeights: boneWeights(m.boneWeights),
    referenceIndices: exS(m.referenceIndices, "i32"),
    centerTransformId: unique.transformData.transformArray[m.centerTransformIndex]?.transformId ?? null,
    toProxyMatrix: mat4(m.toProxyMatrix),
    initScale: vec3(m.initScale),
  };
}

// a number array in the game data (JSON numbers) or in runtimePreBuild (raw little-endian bytes)
const numbers = (x, kind) => (x?.base64 !== undefined ? rawS(x, kind) : x);
function constraints(share) {
  const d = share.distanceConstraintData, b = share.bendingConstraintData;
  const out = { distance: null, bending: null };
  const index = d && numbers(d.indexArray, "u32");
  if (index?.length) {
    out.distance = { index: Uint32Array.from(index), data: Uint16Array.from(numbers(d.dataArray, "u16")), dist: Float32Array.from(numbers(d.distanceArray, "f32")) };
  }
  if (b && b.trianglePairArray) {
    let pairs;
    if (b.trianglePairArray.base64 !== undefined) {   // little-endian uint64: v0 in the top 16 bits (DataUtility.Unpack64)
      const bytes = rawBytes(b.trianglePairArray), v = view(bytes);
      pairs = Array.from({ length: count(bytes, 8) }, (_, i) => [3, 2, 1, 0].map((k) => v.getUint16(i * 8 + k * 2, true)));
    } else {
      if (b.trianglePairArray.some((x) => x > Number.MAX_SAFE_INTEGER)) throw new Error("MagicaCloth2: trianglePairArray lost precision in JSON");
      pairs = b.trianglePairArray.map((x) => { const big = BigInt(x); return [48n, 32n, 16n, 0n].map((s) => Number((big >> s) & 0xffffn)); });
    }
    if (pairs.length) {
      out.bending = { pairs, restAngleOrVolume: Float32Array.from(numbers(b.restAngleOrVolumeArray, "f32")), signOrVolume: Int8Array.from(numbers(b.signOrVolumeArray, "i8")) };
    }
  }
  return out;
}

function preBuildMeshes(share, unique) {
  return {
    proxy: proxyMesh(share, unique),
    ...constraints(share),
    initLocalGravityDirection: vec3(share.inertiaConstraintData.initLocalGravityDirection),
    mappings: (share.renderMeshList ?? []).map((m, i) => mappingMesh(m, unique.renderMeshList[i], unique.renderSetupDataList[i])),
  };
}

// ------------------------------------------------------------------ colliders
const COLLIDER_CLASSES = new Set(["MagicaSphereCollider", "MagicaCapsuleCollider", "MagicaPlaneCollider"]);
function colliderDefinition(component) {
  const f = component.fields;
  const def = { transformId: component.transformId, center: vec3(f.center), enable: (f.m_Enabled ?? 1) !== 0, reverse: false };
  const size = vec3(f.size);
  if (component.class === "MagicaSphereCollider") { def.type = 1; def.size = size; }
  else if (component.class === "MagicaPlaneCollider") { def.type = 8; def.size = size; }
  else {
    // MagicaCapsuleCollider.GetColliderType / GetSize
    def.type = (f.alignedOnCenter ? 2 : 5) + f.direction;
    def.size = f.radiusSeparation ? size : [size[0], size[0], size[2]];
    def.reverse = !!f.reverseDirection;
  }
  return def;
}

/**
 * -> { transforms, cloths: [{ transformId, enabled, params, proxy, distance, bending, initLocalGravityDirection,
 *       colliders: [def], mappings: [mapping], prebuilt, runtimeBuild, runtimePreBuild }] }
 * prebuilt: the game's PreBuild data; runtimeBuild: built like the game does at Start, during this decode or, with
 * runtimePreBuild, at conversion time.
 */
export function decodeMagicaCloth2(source) {
  const colliders = new Map();
  for (const c of source.components) {
    if (COLLIDER_CLASSES.has(c.class)) colliders.set(`${c.transformId}/${c.class}`, colliderDefinition(c));
  }
  const cloths = [];
  let hierarchy = null;
  for (const c of source.components) {
    if (c.class !== "MagicaCloth") continue;
    const pb = c.fields.serializeData2?.preBuildData;
    const cloth = { transformId: c.transformId, enabled: (c.fields.m_Enabled ?? 1) !== 0, buildId: pb?.buildId ?? null, prebuilt: false };
    try {   // a cloth that cannot be decoded is reported (error) and left to the generic fallback physics
      const sd = c.fields.serializeData;
      Object.assign(cloth, {
        clothType: sd.clothType, updateMode: sd.updateMode, params: clothParameters(sd),
        colliders: (sd.colliderCollisionConstraint.colliderList ?? []).filter(Boolean)
          .map((r) => colliders.get(`${r.transformId}/${r.class}`)).filter(Boolean),
        prebuilt: !!(pb && pb.enabled && pb.sharePreBuildData && pb.uniquePreBuildData),
      });
      const rpb = c.runtimePreBuild;
      if (cloth.prebuilt) {
        Object.assign(cloth, preBuildMeshes(pb.sharePreBuildData, pb.uniquePreBuildData));
      } else if (rpb && rpb.version === RUNTIME_PREBUILD_VERSION) {
        Object.assign(cloth, preBuildMeshes(rpb.sharePreBuildData, rpb.uniquePreBuildData), { runtimeBuild: true, runtimePreBuild: true });
      } else if (sd.clothType === 1) {   // BoneCloth without PreBuild: build the proxy like the game does at Start
        hierarchy ??= prefabHierarchy(source.transforms);
        const { build, ...built } = buildBoneCloth(source.transforms, { transformId: c.transformId, ...c.fields }, cloth.params, hierarchy);
        Object.assign(cloth, built, { runtimeBuild: true, siblingOrder: build.siblingOrder });
      } else if (sd.clothType === 0) {   // MeshCloth without PreBuild: from the original mesh (converter meshData)
        hierarchy ??= prefabHierarchy(source.transforms);
        const { build, ...built } = buildMeshCloth(source.transforms, { transformId: c.transformId, ...c.fields }, cloth.params, hierarchy);
        Object.assign(cloth, built, { runtimeBuild: true });
      }
    } catch (error) {
      cloth.prebuilt = false;
      cloth.error = `MagicaCloth2 ${cloth.buildId ?? cloth.transformId}: ${error.message}`;
    }
    cloths.push(cloth);
  }
  return { transforms: source.transforms, cloths };
}

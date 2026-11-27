// Precompute the MagicaCloth2 runtime builds (build.js / build-mesh.js) at conversion time, like MagicaCloth2's own
// PreBuild does in the editor: physics.source.magicaCloth2 components without usable PreBuild data get
// "runtimePreBuild" = { version, sharePreBuildData, uniquePreBuildData }, holding the build results in the same
// encoding as the game's PreBuild data (only the fields data.js reads), so the renderer decodes them with the
// PreBuild decoder and skips the build.  A built MeshCloth no longer needs the original mesh, so its renderers'
// "meshData" is dropped.  Cloths that fail to build are left as they are (the renderer reports the same error).
import { clothParameters, RUNTIME_PREBUILD_VERSION } from "./data.js";
import { buildBoneCloth, prefabHierarchy } from "./build.js";
import { buildMeshCloth } from "./build-mesh.js";

export { RUNTIME_PREBUILD_VERSION };

const toBase64 = (bytes) => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const SIZE = { u8: 1, i8: 1, u16: 2, i32: 4, u32: 4, f32: 4 };
function scalarBytes(values, kind) {
  const n = values.length, bytes = new Uint8Array(n * SIZE[kind]), v = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const x = values[i], o = i * SIZE[kind];
    if (kind === "u8") v.setUint8(o, x); else if (kind === "i8") v.setInt8(o, x); else if (kind === "u16") v.setUint16(o, x, true);
    else if (kind === "i32") v.setInt32(o, x, true); else if (kind === "u32") v.setUint32(o, x, true); else v.setFloat32(o, x, true);
  }
  return bytes;
}
const vecBytes = (rows, width) => {
  const flat = new Array(rows.length * width);
  rows.forEach((r, i) => { for (let k = 0; k < width; k++) flat[i * width + k] = r[k]; });
  return scalarBytes(flat, "f32");
};
// ExSimpleNativeArray {count, length, arrayBytes} and raw byte arrays, as data.js decodes them
const ex = (bytes, count) => ({ count, length: count, arrayBytes: { base64: toBase64(bytes) } });
const raw = (bytes) => ({ base64: toBase64(bytes) });
const exVec = (rows, width) => ex(vecBytes(rows, width), rows.length);
const exScalars = (values, kind, count = values.length) => ex(scalarBytes(values, kind), count);
const rawScalars = (values, kind) => raw(scalarBytes(values, kind));
function boneWeightBytes(weights) {   // VirtualMeshBoneWeight: float4 weights, int4 boneIndices
  const bytes = new Uint8Array(weights.length * 32), v = new DataView(bytes.buffer);
  weights.forEach((b, i) => { for (let k = 0; k < 4; k++) { v.setFloat32(i * 32 + k * 4, b.w[k], true); v.setInt32(i * 32 + 16 + k * 4, b.i[k], true); } });
  return bytes;
}
function fixedList32Bytes(lists) {   // FixedList32Bytes<uint>: ushort length, 2 padding bytes, up to 7 uints
  const bytes = new Uint8Array(lists.length * 32), v = new DataView(bytes.buffer);
  lists.forEach((list, i) => {
    if (list.length > 7) throw new Error("MagicaCloth2 prebuild: vertexToTriangles entry longer than FixedList32Bytes<uint>");
    v.setUint16(i * 32, list.length, true);
    list.forEach((x, k) => v.setUint32(i * 32 + 4 + k * 4, x, true));
  });
  return bytes;
}
function trianglePairBytes(pairs) {   // little-endian uint64 with v0 in the top 16 bits (DataUtility.Pack64)
  const bytes = new Uint8Array(pairs.length * 8), v = new DataView(bytes.buffer);
  pairs.forEach((p, i) => { for (let k = 0; k < 4; k++) v.setUint16(i * 8 + (3 - k) * 2, p[k], true); });
  return bytes;
}
const vec3 = (a) => ({ x: a[0], y: a[1], z: a[2] });
const mat4 = (m) => Object.fromEntries([0, 1, 2, 3].map((c) => [`c${c}`, { x: m[c * 4], y: m[c * 4 + 1], z: m[c * 4 + 2], w: m[c * 4 + 3] }]));
const transformArray = (ids) => ({ transformArray: ids.map((id) => (id == null ? null : { transformId: id })) });

function encodeProxy(p) {
  return {
    meshType: p.meshType, isBoneCloth: p.isBoneCloth ? 1 : 0,
    attributes: exScalars(p.attr, "u8"),
    localPositions: exVec(p.localPositions, 3), localNormals: exVec(p.localNormals, 3), localTangents: exVec(p.localTangents, 3),
    uv: exVec(p.uv ?? [], 2), boneWeights: ex(boneWeightBytes(p.boneWeights), p.boneWeights.length),
    triangles: exScalars(p.triangles, "i32", p.triangles.length / 3), lines: exScalars(p.lines, "i32", p.lines.length / 2),
    edges: rawScalars(p.edges, "i32"),
    vertexToTriangles: raw(fixedList32Bytes(p.vertexToTriangles)),
    vertexDepths: rawScalars(p.depth, "f32"), vertexRootIndices: rawScalars(p.root, "i32"), vertexParentIndices: rawScalars(p.parent, "i32"),
    vertexChildIndexArray: rawScalars(p.childIndex, "u32"), vertexChildDataArray: rawScalars(p.childData, "u16"),
    vertexLocalPositions: raw(vecBytes(p.vertexLocalPositions, 3)), vertexLocalRotations: raw(vecBytes(p.vertexLocalRotations, 4)),
    vertexBindPosePositions: raw(vecBytes(p.vertexBindPosePositions, 3)), vertexBindPoseRotations: raw(vecBytes(p.vertexBindPoseRotations, 4)),
    vertexToTransformRotations: raw(vecBytes(p.vertexToTransformRotations, 4)), normalAdjustmentRotations: raw(vecBytes(p.normalAdjustmentRotations, 4)),
    baseLineFlags: rawScalars(p.baseLine.flags, "u8"), baseLineStartDataIndices: rawScalars(p.baseLine.start, "u16"),
    baseLineDataCounts: rawScalars(p.baseLine.count, "u16"), baseLineData: rawScalars(p.baseLine.data, "u16"),
    centerFixedList: Array.from(p.centerFixedList),
    centerTransformIndex: p.centerTransformIndex,
    skinRootIndex: p.skinRootIndex,
    skinBoneTransformIndices: exScalars(p.skinBoneTransformIndices, "i32"),
    skinBoneBindPoses: exVec(p.skinBoneBindPoses, 16),
    initScale: vec3(p.initScale),
    initLocalToWorld: mat4(p.initLocalToWorld),
  };
}
function encodeMapping(m) {
  return {
    share: {
      name: m.name,
      attributes: exScalars(m.attr, "u8"),
      localPositions: exVec(m.localPositions, 3), localNormals: exVec(m.localNormals, 3), localTangents: exVec(m.localTangents, 3),
      boneWeights: ex(boneWeightBytes(m.boneWeights), m.boneWeights.length),
      referenceIndices: exScalars(m.referenceIndices, "i32"),
      centerTransformIndex: 0,
      toProxyMatrix: mat4(m.toProxyMatrix),
      initScale: vec3(m.initScale),
    },
    unique: { transformData: transformArray([m.centerTransformId]) },
    setup: { renderer: m.renderer },
  };
}

/** Build result (buildBoneCloth / buildMeshCloth) -> { sharePreBuildData, uniquePreBuildData } subset. */
export function encodeRuntimeBuild(built) {
  const mappings = (built.mappings ?? []).map(encodeMapping);
  const d = built.distance, b = built.bending;
  return {
    sharePreBuildData: {
      proxyMesh: encodeProxy(built.proxy),
      renderMeshList: mappings.map((m) => m.share),
      distanceConstraintData: d ? {
        indexArray: rawScalars(d.index, "u32"), dataArray: rawScalars(d.data, "u16"), distanceArray: rawScalars(d.dist, "f32"),
      } : null,
      bendingConstraintData: b ? {
        trianglePairArray: raw(trianglePairBytes(b.pairs)),
        restAngleOrVolumeArray: rawScalars(b.restAngleOrVolume, "f32"), signOrVolumeArray: rawScalars(b.signOrVolume, "i8"),
      } : null,
      inertiaConstraintData: { initLocalGravityDirection: vec3(built.initLocalGravityDirection) },
    },
    uniquePreBuildData: {
      proxyMesh: { transformData: transformArray(built.proxy.transformIds) },
      renderMeshList: mappings.map((m) => m.unique),
      renderSetupDataList: mappings.map((m) => m.setup),
    },
  };
}

/** The game PreBuild data of a MagicaCloth component, when the renderer uses it instead of a build. */
export const usablePreBuild = (component) => {
  const pb = component.fields?.serializeData2?.preBuildData;
  return pb && pb.enabled && pb.sharePreBuildData && pb.uniquePreBuildData ? pb : null;
};

/**
 * Run the runtime build of every MagicaCloth without usable PreBuild data and store the result in the component
 * (runtimePreBuild).  Mutates `source` (physics.source.magicaCloth2).
 * Re-running refreshes the results; a MeshCloth whose meshData was already dropped keeps its previous result.
 * -> [{ transformId, clothType, status: "built" | "prebuilt" | "kept" | "error", error? }]
 */
export function prebuildMagicaCloth2(source, { keepMeshData = false } = {}) {
  const report = [];
  let hierarchy = null;
  for (const c of source.components ?? []) {
    if (c.class !== "MagicaCloth") continue;
    const sd = c.fields?.serializeData;
    const entry = { transformId: c.transformId, clothType: sd?.clothType ?? null };
    report.push(entry);
    if (usablePreBuild(c)) { delete c.runtimePreBuild; entry.status = "prebuilt"; continue; }
    try {
      const params = clothParameters(sd);
      hierarchy ??= prefabHierarchy(source.transforms);
      const cloth = { transformId: c.transformId, ...c.fields };
      const built = sd.clothType === 1 ? buildBoneCloth(source.transforms, cloth, params, hierarchy)
        : buildMeshCloth(source.transforms, cloth, params, hierarchy);
      c.runtimePreBuild = { version: RUNTIME_PREBUILD_VERSION, ...encodeRuntimeBuild(built) };
      if (!keepMeshData) for (const r of sd.sourceRenderers ?? []) if (r) delete r.meshData;
      entry.status = "built";
    } catch (error) {
      entry.status = c.runtimePreBuild?.version === RUNTIME_PREBUILD_VERSION ? "kept" : "error";
      entry.error = error.message;
    }
  }
  return report;
}

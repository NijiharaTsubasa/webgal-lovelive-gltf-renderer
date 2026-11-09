// Runtime build of a MagicaCloth2 MeshCloth (no PreBuild data): ClothProcess.RuntimeBuildAsync for
// ClothType.MeshCloth, v2.16.0 source (the game's ~2.10 build; see build.js for the shared ConvertProxyMesh,
// constraint data and the game-version differences).  Steps, in source order:
//   RenderSetupData (renderer) + VirtualMesh.ImportFrom   render mesh in its transform's space, skinned once at
//                                                         the prefab pose (ImportMeshType / ImportMeshSkinning)
//   VirtualMesh.SelectionMesh                             keep triangles near a used selection point
//   VirtualMesh.AddMesh                                   merge into the proxy (cloth transform space)
//   VirtualMesh.Reduction                                 SameDistance, SimpleDistance, ShapeDistance reductions,
//                                                         then Organization (new vertices / lines / triangles)
//   Optimization, ApplySelectionAttribute, ConvertProxyMesh (CreateMeshBaseLine)   build.js
//   VirtualMesh.Mapping                                   direct mapping of the render vertices to the proxy
//   Distance / TriangleBending / Inertia                  build.js
// Input: the original Unity mesh of each renderer (converter "meshData"), not the GLB mesh.
import * as M from "./math.js";
import {
  NativeParallelHashMap, hashInt, hashInt2Key, hashInt3Key, int2Key, int2X, int2Y, int3Of, unitySort,
} from "./native-hash.js";
import {
  FIXED, isDontMove, isInvalid, MINIMUM_GRID_SIZE, FLOAT_MAX,
  fr, f3, f4, sub32, dot32, distance32, packInt2, packInt3, prefabHierarchy,
  aabbOf, sphereMappingUV, averageAndMaxVertexDistance, removeDuplicateTriangles, applySelection, convertProxyMesh,
  distanceData, bendingData, initLocalGravityDirection,
} from "./build.js";

const MESH_TYPE_PROXY = 2;   // VirtualMesh.MeshType.ProxyMesh
const REDUCTION_SAME_DISTANCE = 0.001, REDUCTION_MAX_STEP = 100, REDUCTION_JOIN_POSITION_ADJUSTMENT = 1.0;

// ----------------------------------------------------------------------------------- meshData
const b64 = (s) => {
  if (typeof Buffer !== "undefined") { const b = Buffer.from(s, "base64"); return new DataView(b.buffer, b.byteOffset, b.byteLength); }
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new DataView(out.buffer);
};
function rows(field, width, kind = "f32") {
  if (!field) return null;
  const v = b64(field.base64), n = v.byteLength / 4 / width, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = new Array(width);
    for (let k = 0; k < width; k++) r[k] = kind === "f32" ? v.getFloat32((i * width + k) * 4, true) : v.getInt32((i * width + k) * 4, true);
    out[i] = r;
  }
  return out;
}

/** converter meshData -> Unity Mesh API values */
export function decodeMeshData(md) {
  const vertices = rows(md.vertices, 3);
  return {
    name: md.name, vertexCount: md.vertexCount,
    vertices, normals: rows(md.normals, 3), tangents: md.tangents ? rows(md.tangents, 4).map((t) => t.slice(0, 3)) : null,
    uv: rows(md.uv, 2),
    weights: md.boneWeights ? rows(md.boneWeights, 4) : null, indices: md.boneIndices ? rows(md.boneIndices, 4, "i32") : null,
    bindposes: rows(md.bindposes, 16) ?? [],
    triangles: rows(md.triangles, 3, "i32") ?? [],
    bones: md.bones ?? [], rootBone: md.rootBone ?? null,
  };
}

// ----------------------------------------------------------------------------------- import (render mesh)
// world pose of a transform as RenderSetupData.ReadTransformJob / TransformRecord read it
const readPose = (hierarchy, id) => {
  const w = hierarchy.world(id);
  return { id, position: f3(w.position), rotation: f4(w.rotation), scale: f3(w.scale), matrix: w.matrix };
};

function importRenderMesh(hierarchy, rendererRef, mesh) {
  // RenderSetupData(renderer): transforms = skin bones, root bone, renderer transform
  const renderId = rendererRef.transformId;
  const hasBones = mesh.bones.length > 0;
  let ids, skinBoneCount, skinRootIndex, renderIndex;
  if (hasBones) {
    ids = [...mesh.bones, mesh.rootBone ?? renderId, renderId];
    skinBoneCount = mesh.bones.length; skinRootIndex = skinBoneCount; renderIndex = skinBoneCount + 1;
  } else {
    ids = [renderId]; skinBoneCount = 1; skinRootIndex = 0; renderIndex = 0;
  }
  const poses = ids.map((id) => readPose(hierarchy, id ?? renderId));   // a missing bone reads the renderer transform
  const r = poses[renderIndex];
  const LtoW = M.trs(r.position, r.rotation, r.scale), WtoL = M.m4inverse(LtoW);
  const n = mesh.vertexCount;
  const vm = {
    name: mesh.name, ids, poses, renderId,
    centerTransformIndex: renderIndex, skinRootIndex,
    initLocalToWorld: LtoW, initWorldToLocal: WtoL, initRotation: r.rotation, initScale: r.scale,
    skinBoneTransformIndices: Array.from({ length: skinBoneCount }, (_, i) => i),
    skinBoneBindPoses: hasBones ? mesh.bindposes.map((m) => m.map(fr)) : [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    localPositions: mesh.vertices.map(f3), localNormals: mesh.normals.map(f3),
    uv: mesh.uv ? mesh.uv.map((u) => [fr(u[0]), fr(u[1])]) : Array.from({ length: n }, () => [0, 0]),
    attributes: new Uint8Array(n), referenceIndices: Array.from({ length: n }, (_, i) => i),
    triangles: mesh.triangles.map((t) => t.slice()), lines: [],
  };
  // tangents: the mesh's, or Import_GenerateTangentJob
  vm.localTangents = mesh.tangents ? mesh.tangents.map(f3) : vm.localNormals.map((nor) => (M.dot(nor, M.UP) < 0.9
    ? f3(M.normalize(M.cross(nor, M.UP))) : f3(M.normalize(M.cross(nor, M.RIGHT)))));
  // bone weights: up to four non-zero weights in stored order (Import_BoneWeightJob2)
  vm.boneWeights = Array.from({ length: n }, (_, v) => {
    if (!hasBones || !mesh.weights) return { w: [1, 0, 0, 0], i: [0, 0, 0, 0] };
    const w = [0, 0, 0, 0], idx = [0, 0, 0, 0];
    let k = 0;
    for (let j = 0; j < 4; j++) if (mesh.weights[v][j] > 0) { w[k] = fr(mesh.weights[v][j]); idx[k] = mesh.indices[v][j]; k++; }
    return { w, i: idx };
  });
  // ImportMeshSkinning: skin once with the current (prefab) pose, back into the renderer's space
  if (hasBones && mesh.weights) {
    const tdir = (d, m) => { const len = M.length(d); return len > 0 ? M.mul(M.normalize(M.m4vector(m, d)), len) : d; };
    for (let v = 0; v < n; v++) {
      const bw = vm.boneWeights[v], cnt = bw.w[3] > 0 ? 4 : bw.w[2] > 0 ? 3 : bw.w[1] > 0 ? 2 : bw.w[0] > 0 ? 1 : 0;
      let wpos = [0, 0, 0], wnor = [0, 0, 0], wtan = [0, 0, 0];
      for (let i = 0; i < cnt; i++) {
        const bp = vm.skinBoneBindPoses[bw.i[i]], t = poses[vm.skinBoneTransformIndices[bw.i[i]]];
        let p = M.m4point(bp, vm.localPositions[v]), nor = M.m4vector(bp, vm.localNormals[v]), tan = M.m4vector(bp, vm.localTangents[v]);
        p = M.add(M.rotate(t.rotation, M.mulv(p, t.scale)), t.position);
        nor = M.rotate(t.rotation, nor);
        tan = M.rotate(t.rotation, tan);
        wpos = M.add(wpos, M.mul(p, bw.w[i])); wnor = M.add(wnor, M.mul(nor, bw.w[i])); wtan = M.add(wtan, M.mul(tan, bw.w[i]));
      }
      vm.localPositions[v] = f3(M.m4point(WtoL, wpos));
      vm.localNormals[v] = f3(tdir(wnor, WtoL));
      vm.localTangents[v] = f3(tdir(wtan, WtoL));
    }
  }
  vm.boundingBox = aabbOf(vm.localPositions);
  vm.vcnt = n;
  averageAndMaxVertexDistance(vm);
  return vm;
}

// ----------------------------------------------------------------------------------- SelectionMesh
const gridOf = (p, gridSize) => p.map((x) => Math.floor(fr(x / gridSize)));
function* gridArea(p, radius, gridSize) {   // GridMap.GetArea: x fastest, then y, then z
  const lo = gridOf(p.map((x) => fr(x - radius)), gridSize), hi = gridOf(p.map((x) => fr(x + radius)), gridSize);
  for (let z = Math.min(lo[2], hi[2]); z <= Math.max(lo[2], hi[2]); z++) {
    for (let y = Math.min(lo[1], hi[1]); y <= Math.max(lo[1], hi[1]); y++) {
      for (let x = Math.min(lo[0], hi[0]); x <= Math.max(lo[0], hi[0]); x++) yield `${x},${y},${z}`;
    }
  }
}
// GridMap<int> that never grows and never removes: per cell, newest entry first
class Grid {
  constructor(gridSize) { this.gridSize = gridSize; this.cells = new Map(); }
  add(p, i) { const k = gridOf(p, this.gridSize).join(","); let c = this.cells.get(k); if (!c) this.cells.set(k, c = []); c.unshift(i); }
  get(k) { return this.cells.get(k); }
}

function selectionMesh(vm, selection, selectionLocalToWorld, mergin) {
  let positions = selection.positions;
  const same = selectionLocalToWorld.every((x, i) => x === vm.initLocalToWorld[i]);   // CompareMatrix
  if (!same) {
    const toM = M.m4mul(vm.initWorldToLocal, selectionLocalToWorld);
    positions = positions.map((p) => f3(M.m4point(toM, p)));
  }
  const grid = new Grid(mergin);
  positions.forEach((p, i) => { if (!isInvalid(selection.attributes[i])) grid.add(p, i); });
  const n = vm.vcnt, remap = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const p = vm.localPositions[v];
    search: for (const k of gridArea(p, mergin, mergin)) {
      for (const s of grid.get(k) ?? []) if (distance32(p, positions[s]) <= mergin) { remap[v] = 1; break search; }
    }
  }
  const tris = vm.triangles.filter((t) => remap[t[0]] >= 0 || remap[t[1]] >= 0 || remap[t[2]] >= 0);
  for (const t of tris) { remap[t[0]] = 1; remap[t[1]] = 1; remap[t[2]] = 1; }
  let count = 0;
  for (let i = 0; i < n; i++) if (remap[i] >= 0) remap[i] = count++;
  if (count < n) {
    const pick = (arr) => { const out = new Array(count); for (let i = 0; i < n; i++) if (remap[i] >= 0) out[remap[i]] = arr[i]; return out; };
    vm.referenceIndices = pick(vm.referenceIndices.map((_, i) => i));
    vm.attributes = Uint8Array.from(pick(Array.from(vm.attributes)));
    vm.localPositions = pick(vm.localPositions); vm.localNormals = pick(vm.localNormals); vm.localTangents = pick(vm.localTangents);
    vm.uv = pick(vm.uv); vm.boneWeights = pick(vm.boneWeights);
    vm.triangles = tris.map((t) => [remap[t[0]], remap[t[1]], remap[t[2]]]);
    vm.vcnt = count;
  }
}

// ----------------------------------------------------------------------------------- proxy: SetTransform + AddMesh
function createProxy(cloth) {
  const L = cloth.matrix;
  return {
    isBoneCloth: false,
    ids: [cloth.id], poses: [cloth], centerTransformIndex: 0, skinRootIndex: 0,
    initLocalToWorld: L, initWorldToLocal: M.m4inverse(L), initRotation: cloth.rotation, initInverseRotation: M.qinverse(cloth.rotation),
    initScale: cloth.scale,
    skinBoneTransformIndices: [], skinBoneBindPoses: [],
    localPositions: [], localNormals: [], localTangents: [], uv: [], boneWeights: [], attributes: [], triangles: [], lines: [],
    boundingBox: null, averageVertexDistance: 0, maxVertexDistance: 0, vcnt: 0,
  };
}

function addMesh(proxy, vm) {
  const same = vm.initLocalToWorld.every((x, i) => x === proxy.initLocalToWorld[i]);   // CenterTransformTo
  const toM = same ? null : M.m4mul(proxy.initWorldToLocal, vm.initLocalToWorld);
  const tp = (p) => (toM ? M.m4point(toM, p) : p);
  const td = (d) => { if (!toM) return d; const len = M.length(d); return len > 0 ? M.mul(M.normalize(M.m4vector(toM, d)), len) : d; };
  const skinBoneStart = proxy.skinBoneTransformIndices.length, vertexStart = proxy.vcnt;
  for (const st of vm.skinBoneTransformIndices) {   // TransformData.AddTransform(checkDuplicate)
    const id = vm.ids[st];
    let t = proxy.ids.indexOf(id);
    if (t < 0) { t = proxy.ids.length; proxy.ids.push(id); proxy.poses.push(vm.poses[st]); }
    proxy.skinBoneTransformIndices.push(t);
  }
  vm.mergeStart = vertexStart;
  for (let v = 0; v < vm.vcnt; v++) {
    proxy.localPositions.push(f3(tp(vm.localPositions[v])));
    proxy.localNormals.push(f3(td(vm.localNormals[v])));
    proxy.localTangents.push(f3(td(vm.localTangents[v])));
    proxy.uv.push(vm.uv[v]);
    const bw = { w: vm.boneWeights[v].w.slice(), i: vm.boneWeights[v].i.map((x) => x + skinBoneStart) };
    for (let i = 0; i < 4; i++) {   // the youngest skin bone index of the same transform
      if (bw.w[i] < 1e-6) continue;
      const t = proxy.skinBoneTransformIndices[bw.i[i]];
      for (let j = 0; j < bw.i[i]; j++) if (proxy.skinBoneTransformIndices[j] === t) { bw.i[i] = j; break; }
    }
    proxy.boneWeights.push(bw);
    proxy.attributes.push(vm.attributes[v]);
  }
  for (const st of vm.skinBoneTransformIndices) {   // Add_CalcBindPoseJob
    const p = vm.poses[st];
    proxy.skinBoneBindPoses.push(M.m4mul(M.m4inverse(M.trs(p.position, p.rotation, p.scale)), proxy.initLocalToWorld).map(fr));
  }
  for (const t of vm.triangles) proxy.triangles.push([t[0] + vertexStart, t[1] + vertexStart, t[2] + vertexStart]);
  const bmin = f3(tp(vm.boundingBox.min)), bmax = f3(tp(vm.boundingBox.max));
  if (!proxy.boundingBox) proxy.boundingBox = { min: bmin, max: bmax };
  else proxy.boundingBox = { min: proxy.boundingBox.min.map((x, k) => Math.min(x, bmin[k])), max: proxy.boundingBox.max.map((x, k) => Math.max(x, bmax[k])) };
  proxy.boundingBox.center = f3(M.mul(M.add(proxy.boundingBox.min, proxy.boundingBox.max), 0.5));
  const scaleRatio = fr(M.length(vm.initScale) / M.length(proxy.initScale));
  proxy.averageVertexDistance = Math.max(proxy.averageVertexDistance, fr(vm.averageVertexDistance * scaleRatio));
  proxy.maxVertexDistance = Math.max(proxy.maxVertexDistance, fr(vm.maxVertexDistance * scaleRatio));
  proxy.vcnt += vm.vcnt;
}

// ----------------------------------------------------------------------------------- reduction
function addWeight(bw, bone, weight) {   // VirtualMeshBoneWeight.AddWeight(int, float)
  if (weight < 1e-6) return;
  const w = bw.w, b = bw.i;
  for (let i = 0; i < 4; i++) {
    if (w[i] === 0) break;
    if (b[i] === bone) {
      w[i] = fr(w[i] + weight);
      for (let j = i; j >= 1; j--) {
        if (w[j] > w[j - 1]) { let t = w[j - 1]; w[j - 1] = w[j]; w[j] = t; t = b[j - 1]; b[j - 1] = b[j]; b[j] = t; }
      }
      return;
    }
  }
  for (let i = 0; i < 4; i++) {
    if (w[i] === 0) { w[i] = weight; b[i] = bone; return; }
    if (weight > w[i]) {
      for (let j = 2; j >= i; j--) { w[j + 1] = w[j]; b[j + 1] = b[j]; }
      w[i] = weight; b[i] = bone; return;
    }
  }
}
const addWeights = (bw, other) => { if (other.w[0] >= 1e-6) for (let i = 0; i < 4; i++) addWeight(bw, other.i[i], other.w[i]); };
function adjustWeight(bw) {   // AdjustWeight
  if (!(bw.w[0] >= 1e-6)) return;
  const scl = fr(1 / fr(fr(fr(bw.w[0] + bw.w[1]) + bw.w[2]) + bw.w[3]));
  bw.w = bw.w.map((x) => fr(x * scl));
}
const joinAttribute = (a, b) => (a < b ? a : b);
// FixedList512Bytes<ushort>.MC2Set
const setAdd = (list, x) => { if (!list.includes(x)) list.push(x); };

class Reduction {
  constructor(mesh, trace = null) {
    this.mesh = mesh;
    this.trace = trace;
    const V = mesh.vcnt;
    this.join = new Int32Array(V).fill(-1);
    this.vv = new NativeParallelHashMap(V, hashInt, true);
    for (const [x, y, z] of mesh.triangles) {
      this.vv.add(x, y); this.vv.add(x, z); this.vv.add(y, x); this.vv.add(y, z); this.vv.add(z, x); this.vv.add(z, y);
    }
    this.removed = 0;
  }

  updateJoinAndLink() {
    const { join, vv } = this, V = this.mesh.vcnt;
    for (let v = 0; v < V; v++) {   // UpdateJoinIndexJob
      let j = join[v];
      if (j >= 0) { while (join[j] >= 0) j = join[j]; join[v] = j; }
    }
    for (let v = 0; v < V; v++) {   // UpdateLinkIndexJob
      if (join[v] >= 0) continue;
      const set = [];
      for (const i of vv.valuesForKey(v)) {
        let t = i;
        if (join[t] >= 0) t = join[t];
        if (t === v) continue;
        setAdd(set, t);
      }
      vv.remove(v);
      for (const t of set) vv.add(v, t);
    }
  }

  finalMerge() {   // FinalMergeVertexJob
    const m = this.mesh;
    for (let v = 0; v < m.vcnt; v++) {
      if (this.join[v] >= 0) continue;
      m.localNormals[v] = f3(M.normalize(m.localNormals[v]));
      adjustWeight(m.boneWeights[v]);
    }
  }

  sameDistance(mergeLength) {
    const m = this.mesh, V = m.vcnt, { join, vv } = this;
    mergeLength = Math.max(mergeLength, 1e-9);
    const grid = new Grid(fr(mergeLength * 2));
    for (let v = 0; v < V; v++) if (join[v] < 0) grid.add(m.localPositions[v], v);
    const pairs = new NativeParallelHashMap(V, hashInt, true);
    for (let v = 0; v < V; v++) {
      if (join[v] >= 0) continue;
      const p = m.localPositions[v];
      for (const k of gridArea(p, mergeLength, grid.gridSize)) {
        for (const t of grid.get(k) ?? []) if (t !== v && distance32(p, m.localPositions[t]) <= mergeLength) pairs.add(v, t);
      }
    }
    let cnt = 0;
    for (let live = 0; live < V; live++) {   // JoinJob2
      if (join[live] >= 0) continue;
      for (const dead of pairs.valuesArray(live)) {
        if (join[dead] >= 0) continue;
        join[dead] = live;
        cnt++;
        this.trace?.push({ kind: "same", x: dead, y: live });
        vv.removeValue(live, dead);
        for (const i of vv.valuesArray(dead)) {
          if (join[i] >= 0 || i === live || i === dead) continue;
          vv.removeValue(i, dead);
          vv.uniqueAdd(live, i);
          vv.uniqueAdd(i, live);
          addWeights(m.boneWeights[live], m.boneWeights[dead]);
          m.attributes[live] = joinAttribute(m.attributes[dead], m.attributes[live]);
          m.attributes[dead] = 0;
        }
      }
    }
    this.updateJoinAndLink();
    this.finalMerge();
    this.removed += cnt;
  }

  /** StepReductionBase.Reduction with the Simple / Shape edge search */
  stepReduction(kind, startLength, endLength) {
    const m = this.mesh, V = m.vcnt, { join, vv } = this;
    startLength = Math.max(startLength, 1e-9); endLength = Math.max(endLength, 1e-9);
    const maxStep = Math.min(REDUCTION_MAX_STEP, 100);
    let step = 0, now = startLength, scale = 2.0, total = 0;
    const linkCount = (v) => Math.max(vv.countValuesForKey(v) - 1, 1);
    const reductionStep = () => {
      const edges = [];
      if (kind === "simple") {
        const grid = new Grid(fr(now * 2));
        for (let v = 0; v < V; v++) if (join[v] < 0) grid.add(m.localPositions[v], v);
        for (let v = 0; v < V; v++) {
          if (join[v] >= 0) continue;
          const p = m.localPositions[v], lc = linkCount(v);
          for (const k of gridArea(p, now, grid.gridSize)) {
            for (const t of grid.get(k) ?? []) {
              if (t === v) continue;
              const d = distance32(p, m.localPositions[t]);
              if (d > now) continue;
              edges.push({ x: v, y: t, cost: fr(d * fr(1 + fr(fr(lc + linkCount(t)) / 2))) });
            }
          }
        }
      } else {
        for (let v = 0; v < V; v++) {
          if (join[v] >= 0) continue;
          const vc = vv.countValuesForKey(v);
          if (vc === 0) continue;
          const p = m.localPositions[v], lc = Math.max(vc - 1, 1);
          let minCost = FLOAT_MAX, minV = -1;
          for (const t of vv.valuesArray(v)) {
            const d = distance32(p, m.localPositions[t]);
            if (d > now) continue;
            const tlc = linkCount(t);
            if (!checkJoin2(vv, v, t)) continue;
            const cost = fr(d * fr(1 + fr(fr(lc + tlc) / 2)));
            if (cost < minCost) { minCost = cost; minV = t; }
          }
          if (minV >= 0) edges.push({ x: v, y: minV, cost: minCost });
        }
      }
      unitySort(edges, (a, b) => (a.cost !== b.cost ? (a.cost < b.cost ? -1 : 1) : 0));
      const complete = new Set(), removePairs = [];
      for (const e of edges) {   // DeterminJoinEdgeJob
        if (complete.has(e.x) || complete.has(e.y)) continue;
        removePairs.push([e.x, e.y]);
        complete.add(e.x); complete.add(e.y);
        this.trace?.push({ kind, step, now, x: e.x, y: e.y, cost: e.cost });
      }
      total += removePairs.length;
      for (const [v1, v2] of removePairs) {   // JoinPairJob
        const pos1 = m.localPositions[v1], pos2 = m.localPositions[v2];
        join[v1] = v2;
        const lc1 = Math.max(vv.countValuesForKey(v1) - 1, 1), lc2 = Math.max(vv.countValuesForKey(v2) - 1, 1);
        let ratio = fr(lc2 / (lc1 + lc2));
        ratio = fr(ratio + fr(fr(0.5 - ratio) * REDUCTION_JOIN_POSITION_ADJUSTMENT));
        m.localPositions[v2] = [0, 1, 2].map((k) => fr(pos2[k] + fr(fr(pos1[k] - pos2[k]) * ratio)));
        m.localNormals[v2] = [0, 1, 2].map((k) => fr(m.localNormals[v1][k] + m.localNormals[v2][k]));
        const link = [];
        for (const n of vv.valuesForKey(v1)) if (n !== v1 && n !== v2) setAdd(link, n);
        for (const n of vv.valuesForKey(v2)) if (n !== v1 && n !== v2) setAdd(link, n);
        vv.remove(v2);
        for (const n of link) vv.add(v2, n);
        addWeights(m.boneWeights[v2], m.boneWeights[v1]);
        m.attributes[v2] = joinAttribute(m.attributes[v1], m.attributes[v2]);
        m.attributes[v1] = 0;
      }
      this.updateJoinAndLink();
    };
    while (step < maxStep) {
      reductionStep();
      step++;
      if (now === endLength) break;
      scale = Math.max(fr(scale * fr(0.93)), fr(1.1));
      now = Math.min(fr(now * scale), endLength);
    }
    if (step < maxStep) { reductionStep(); step++; }
    this.finalMerge();
    this.removed += total;
  }
}

// StepReductionBase.CheckJoin2: joining must keep the joined neighbourhood connected (dontMakeLine)
function checkJoin2(vv, v, t) {
  const link = [];
  for (const i of vv.valuesForKey(v)) if (i !== v && i !== t) setAdd(link, i);
  for (const i of vv.valuesForKey(t)) if (i !== v && i !== t) setAdd(link, i);
  if (link.length === 0) return false;
  const stack = [link[0]];
  while (stack.length) {
    const i = stack.pop();
    const at = link.indexOf(i);
    if (at < 0) continue;
    link[at] = link[link.length - 1];   // RemoveAtSwapBack
    link.pop();
    for (const n of vv.valuesForKey(i)) if (link.includes(n)) stack.push(n);
  }
  return link.length === 0;
}

function reduce(proxy, settings, trace) {
  const box = proxy.boundingBox, ext = M.sub(box.max, box.min), maxSide = Math.max(ext[0], ext[1], ext[2]);
  if (maxSide < 1e-8) throw new Error("MagicaCloth2: reduction of a flat proxy mesh (Reduction_MaxSideLengthZero)");
  const sameDistance = fr(maxSide * REDUCTION_SAME_DISTANCE);
  const simpleDistance = fr(maxSide * M.saturate(settings.simpleDistance ?? 0));
  const shapeDistance = fr(maxSide * M.saturate(settings.shapeDistance ?? 0));
  const r = new Reduction(proxy, trace);
  r.sameDistance(sameDistance);
  if (simpleDistance > sameDistance) r.stepReduction("simple", Math.min(fr(sameDistance * 2), simpleDistance), simpleDistance);
  if (shapeDistance > 0 && shapeDistance > simpleDistance) {
    r.stepReduction("shape", Math.min(Math.max(fr(sameDistance * 2), simpleDistance), shapeDistance), shapeDistance);
  }
  organize(proxy, r);
  averageAndMaxVertexDistance(proxy);
}

// VirtualMesh.Organization + OrganizeStoreVirtualMesh + TransformData.OrganizeReductionTransform
function organize(mesh, r) {
  const oldV = mesh.vcnt, newV = oldV - r.removed, { join, vv } = r;
  const remap = new Int32Array(oldV);
  let k = 0;
  for (let i = 0; i < oldV; i++) if (join[i] < 0) remap[i] = k++;
  for (let i = 0; i < oldV; i++) if (join[i] >= 0) remap[i] = remap[join[i]];
  if (k !== newV) throw new Error(`MagicaCloth2: reduction bookkeeping (${k} live vertices, expected ${newV})`);
  // used skin bones, in NativeParallelHashMap<int,int> order
  const useSkin = new NativeParallelHashMap(mesh.skinBoneTransformIndices.length, hashInt);
  for (let v = 0; v < oldV; v++) {
    if (join[v] >= 0) continue;
    const bw = mesh.boneWeights[v];
    for (let i = 0; i < 4; i++) if (bw.w[i] > 0) useSkin.add(bw.i[i], 0);
  }
  const usedBones = useSkin.keyArray();
  usedBones.forEach((b, i) => useSkin.set(b, i));
  const pick = (arr) => { const out = new Array(newV); for (let v = 0; v < oldV; v++) if (join[v] < 0) out[remap[v]] = arr[v]; return out; };
  const attributes = Uint8Array.from(pick(Array.from(mesh.attributes)));
  const positions = pick(mesh.localPositions), normals = pick(mesh.localNormals), tangents = pick(mesh.localTangents);
  const boneWeights = pick(mesh.boneWeights).map((bw) => ({ w: bw.w.slice(), i: bw.i.map((b, j) => (bw.w[j] > 0 ? useSkin.get(b) : 0)) }));
  const newVV = new NativeParallelHashMap(newV, hashInt, true);
  for (let v = 0; v < oldV; v++) {
    if (join[v] >= 0) continue;
    for (const o of vv.valuesForKey(v)) newVV.uniqueAdd(remap[v], remap[o]);
  }
  const edgeSet = new NativeParallelHashMap(newV * 2, hashInt2Key);
  for (let v = 0; v < newV; v++) for (const v2 of newVV.valuesForKey(v)) edgeSet.add(packInt2(v, v2));
  const triangleSet = new NativeParallelHashMap(newV, hashInt3Key), lines = [];
  for (const [edge] of edgeSet.entries()) {
    const x = int2X(edge), y = int2Y(edge);
    let tcnt = 0;
    for (const vi of newVV.valuesForKey(x)) {
      if (vi === x || vi === y) continue;
      if (newVV.containsPair(y, vi)) {
        const [a, b, c] = packInt3(x, y, vi);
        triangleSet.add((a * 32768 + b) * 32768 + c);
        tcnt++;
      }
    }
    if (tcnt === 0) lines.push([x, y]);
  }
  mesh.triangles = triangleSet.keyArray().map(int3Of);
  mesh.lines = lines;
  mesh.localPositions = positions; mesh.localNormals = normals; mesh.localTangents = tangents;
  mesh.attributes = attributes; mesh.boneWeights = boneWeights;
  mesh.vcnt = newV;
  sphereMappingUV(mesh, mesh.boundingBox);
  // transforms: used skin bones, skin root, center
  const oldIds = mesh.ids, oldPoses = mesh.poses;
  const order = [...usedBones.map((b) => mesh.skinBoneTransformIndices[b]), mesh.skinRootIndex, mesh.centerTransformIndex];
  mesh.ids = order.map((t) => oldIds[t]);
  mesh.poses = order.map((t) => oldPoses[t]);
  mesh.skinRootIndex = usedBones.length;
  mesh.centerTransformIndex = usedBones.length + 1;
  mesh.skinBoneBindPoses = usedBones.map((b) => mesh.skinBoneBindPoses[b]);
  mesh.skinBoneTransformIndices = usedBones.map((_, i) => i);
  mesh.joinIndices = Array.from(remap);
}

// ----------------------------------------------------------------------------------- Mapping (direct)
function mapping(vm, proxy, rendererRef) {
  const same = vm.initLocalToWorld.every((x, i) => x === proxy.initLocalToWorld[i]);
  const toP = same ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : M.m4mul(proxy.initWorldToLocal, vm.initLocalToWorld);
  const weightLength = fr(proxy.averageVertexDistance * 1.5);
  const pos = proxy.localPositions, vv = proxy.vertexToVertex;
  const attr = new Uint8Array(vm.vcnt), boneWeights = new Array(vm.vcnt);
  for (let v = 0; v < vm.vcnt; v++) {
    let pindex = proxy.joinIndices[vm.mergeStart + v];
    if (isInvalid(proxy.attributes[pindex])) { attr[v] = 0; boneWeights[v] = vm.boneWeights[v]; continue; }
    attr[v] = proxy.attributes[pindex];
    const wpos = f3(M.m4point(toP, vm.localPositions[v]));
    // Mapping_CalcDirectWeightJob: proxy vertices within 1.5 x the average edge, reached through the mesh
    const costs = [-1, -1, -1, -1], data = [0, 0, 0, 0];
    const add = (cost, item) => {   // ExCostSortedList4.Add
      if (costs[3] >= 0 && cost > costs[3]) return;
      for (let i = 0; i < 4; i++) {
        if (costs[i] < 0) { costs[i] = cost; data[i] = item; return; }
        if (cost < costs[i]) { for (let j = 2; j >= i; j--) { costs[j + 1] = costs[j]; data[j + 1] = data[j]; } costs[i] = cost; data[i] = item; return; }
      }
    };
    const used = new Set(), stack = [pindex];
    while (stack.length) {
      pindex = stack.pop();
      if (used.has(pindex)) continue;
      used.add(pindex);
      const d = distance32(wpos, pos[pindex]);
      if (d > weightLength) continue;
      const w = fr(Math.pow(M.saturate(fr(1 - fr(d / weightLength))), 3));
      add(fr(1 - w), pindex);
      const pack = vv.index[pindex], cnt = pack >>> 20, s = pack & 0xfffff;
      for (let i = 0; i < cnt && stack.length < 2047; i++) {
        const t = vv.data[s + i];
        if (used.has(t) || distance32(wpos, pos[t]) > weightLength) continue;
        stack.push(t);
      }
    }
    const count = costs[3] >= 0 ? 4 : costs[2] >= 0 ? 3 : costs[1] >= 0 ? 2 : costs[0] >= 0 ? 1 : 0;
    if (count === 0) {
      boneWeights[v] = { w: [1, 0, 0, 0], i: [pindex, 0, 0, 0] };
      continue;
    }
    for (let i = 0; i < 4; i++) { if (i < count) costs[i] = fr(1 - costs[i]); else { costs[i] = 0; data[i] = 0; } }
    const total = fr(fr(fr(costs[0] + costs[1]) + costs[2]) + costs[3]);
    const w = total === 0 ? costs.map((_, i) => (i < count ? fr(1 / count) : 0)) : costs.map((c) => M.saturate(fr(c / total)));
    boneWeights[v] = { w, i: data };
  }
  return {
    name: vm.name,
    renderer: rendererRef,
    attr: Array.from(attr),
    localPositions: vm.localPositions, localNormals: vm.localNormals, localTangents: vm.localTangents,
    boneWeights,
    referenceIndices: vm.referenceIndices,
    centerTransformId: vm.renderId,
    toProxyMatrix: toP.map(fr),
    initScale: vm.initScale,
  };
}

// ----------------------------------------------------------------------------------- entry point
/**
 * Build a MeshCloth like the game does without PreBuild data.  cloth: { transformId, serializeData,
 * serializeData2 } of the MagicaCloth component, whose sourceRenderers carry "meshData".
 * -> { proxy, mappings, distance, bending, initLocalGravityDirection, build }
 */
export function buildMeshCloth(transforms, cloth, params, hierarchy = prefabHierarchy(transforms), { trace = null } = {}) {
  const sd = cloth.serializeData, sd2 = cloth.serializeData2 ?? {};
  if (sd.clothType !== 0) throw new Error("MagicaCloth2: not a MeshCloth");
  if ((sd.paintMode ?? 0) !== 0) throw new Error("MagicaCloth2: paint-map selection is not supported");
  const renderers = (sd.sourceRenderers ?? []).filter(Boolean);
  if (!renderers.length) throw new Error("MagicaCloth2: MeshCloth without renderers");
  const noMesh = renderers.find((r) => !r.meshData);
  if (noMesh) throw new Error(`MagicaCloth2: renderer ${noMesh.mesh?.name ?? noMesh.transformId} has no meshData (re-export with the current converter)`);
  const sel = sd2.selectionData;
  if (!(sel?.positions?.length && sel?.attributes?.length && sel.positions.length === sel.attributes.length)) {
    throw new Error("MagicaCloth2: MeshCloth without selection data");
  }
  const selection = {
    positions: sel.positions.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]).map(fr)),
    attributes: sel.attributes.map((a) => (typeof a === "number" ? a : a?.Value ?? 0)),
    maxConnectionDistance: sel.maxConnectionDistance ?? 0,
  };
  for (const id of [cloth.transformId, ...renderers.map((r) => r.transformId)]) {
    if (!hierarchy.has(id)) throw new Error(`MagicaCloth2: MeshCloth transform ${id} is missing from the transform table`);
  }
  const clothPose = readPose(hierarchy, cloth.transformId);
  const settings = sd.reductionSetting ?? {};
  const maxConnection = Math.max(REDUCTION_SAME_DISTANCE, settings.simpleDistance ?? 0, settings.shapeDistance ?? 0);
  const proxy = createProxy(clothPose);
  const renderMeshes = [];
  for (const ref of renderers) {
    const mesh = decodeMeshData(ref.meshData);
    for (const id of [...mesh.bones, mesh.rootBone]) {
      if (id !== null && !hierarchy.has(id)) throw new Error(`MagicaCloth2: skin bone ${id} is missing from the transform table`);
    }
    const vm = importRenderMesh(hierarchy, ref, mesh);
    // CalcSelectionMergin
    const ext = M.sub(vm.boundingBox.max, vm.boundingBox.min);
    let mergin = fr(Math.max(vm.averageVertexDistance, fr(Math.max(ext[0], ext[1], ext[2]) * maxConnection)) * 1.5);
    mergin = Math.max(mergin, MINIMUM_GRID_SIZE);
    selectionMesh(vm, selection, clothPose.matrix, mergin);
    addMesh(proxy, vm);
    renderMeshes.push({ vm, ref });
  }
  reduce(proxy, settings, trace);
  removeDuplicateTriangles(proxy);
  applySelection(proxy, selection);
  const setup = { ids: proxy.ids, customSkinningBones: [], normalAdjustmentPosition: null };
  const adjust = sd.normalAlignmentSetting?.adjustmentTransform?.transformId;
  setup.normalAdjustmentPosition = hierarchy.world(adjust && hierarchy.has(adjust) ? adjust : cloth.transformId).position.map(fr);
  if (sd.customSkinningSetting?.enable) {
    setup.customSkinningBones = (sd.customSkinningSetting.skinningBones ?? []).map((r) => {
      const id = r?.transformId;
      if (id == null) return null;
      if (!hierarchy.has(id)) throw new Error(`MagicaCloth2: custom skinning bone ${id} is missing from the transform table`);
      const w = hierarchy.world(id);
      return { id, position: f3(w.position), matrix: w.matrix };
    });
  }
  convertProxyMesh(proxy, setup, sd);
  if (proxy.vcnt > 32767 || proxy.edges.length > 32767 || proxy.triangles.length > 32767) throw new Error("MagicaCloth2: proxy mesh too large");
  const mappings = renderMeshes.map(({ vm, ref }) => mapping(vm, proxy, (({ meshData, ...rest }) => rest)(ref)));

  const V = proxy.vcnt;
  const out = {
    count: V,
    meshType: MESH_TYPE_PROXY, isBoneCloth: false,
    attr: Array.from(proxy.attributes),
    localPositions: proxy.localPositions, localNormals: proxy.localNormals, localTangents: proxy.localTangents,
    uv: proxy.uv, boneWeights: proxy.boneWeights,
    triangles: proxy.triangles.flat(), lines: proxy.lines.flat(),
    edges: proxy.edges.flatMap((k) => [int2X(k), int2Y(k)]),
    vertexToTriangles: proxy.vertexToTriangles,
    depth: proxy.depth, root: proxy.root, parent: proxy.parent,
    childIndex: proxy.childIndex, childData: proxy.childData,
    vertexLocalPositions: proxy.vertexLocalPositions, vertexLocalRotations: proxy.vertexLocalRotations,
    vertexBindPosePositions: proxy.vertexBindPosePositions, vertexBindPoseRotations: proxy.vertexBindPoseRotations,
    vertexToTransformRotations: proxy.vertexToTransformRotations, normalAdjustmentRotations: proxy.normalAdjustmentRotations,
    baseLine: proxy.baseLine,
    centerFixedList: proxy.centerFixedList,
    centerTransformIndex: proxy.centerTransformIndex,
    skinRootIndex: proxy.skinRootIndex,
    skinBoneTransformIndices: proxy.skinBoneTransformIndices,
    skinBoneBindPoses: proxy.skinBoneBindPoses,
    initScale: proxy.initScale,
    initLocalToWorld: proxy.initLocalToWorld.map(fr),
    transformIds: proxy.ids,
  };
  return {
    proxy: out, mappings,
    distance: distanceData(proxy),
    bending: bendingData(proxy),
    initLocalGravityDirection: initLocalGravityDirection(proxy, M.normalizesafe(params.worldGravityDirection)),
    build: {
      averageVertexDistance: proxy.averageVertexDistance, maxVertexDistance: proxy.maxVertexDistance,
      boundingBox: proxy.boundingBox, vertexToVertex: proxy.vertexToVertex, joinIndices: proxy.joinIndices,
      renderMeshes: renderMeshes.map(({ vm }) => ({ vertexCount: vm.vcnt, averageVertexDistance: vm.averageVertexDistance })),
      edgeToTriangles: Array.from(proxy.edgeToTriangles.entries(), ([key, v]) => [int2X(key), int2Y(key), v]),
    },
  };
}

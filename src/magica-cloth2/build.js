// Runtime build of a MagicaCloth2 BoneCloth (no PreBuild data): ClothProcess.Init + RuntimeBuildAsync for
// ClothType.BoneCloth (v2.16.0 source; the game's ~2.10 has the same build), producing the same structures as a
// decoded PreBuild (data.js) so MagicaClothTeam runs either.  Steps, in source order:
//   RenderSetupData (bone constructor)      transforms below the root bones, depth first from a stack
//   VirtualMesh.ImportFrom / ImportBoneType vertices, Line / AutomaticMesh / Sequential(Loop|NonLoop)Mesh topology
//   VirtualMesh.Optimization                RemoveDuplicateTriangles
//   VirtualMesh.ApplySelectionAttribute     nearest selection point (grid map)
//   VirtualMesh.ConvertProxyMesh            edges, normals, fixed list, base lines, bind poses, root / depth
//   Distance / TriangleBending / Inertia    ConstraintData CreateData
// Order matters: several steps iterate Unity.Collections hash containers (native-hash.js) or C# HashSets
// (insertion order), and the game's topology (e.g. which quad diagonal survives) follows from those orders.
// The pose is the prefab's serialized pose (what MagicaCloth.Awake reads), not the exported rest pose.
import * as M from "./math.js";
import { NativeParallelHashMap, hashInt, hashInt2Key, int2Key, int2X, int2Y, multiDataToArrays, arraysToMultiMap, unitySort } from "./native-hash.js";

const FIXED = 0x01, MOVE = 0x02, TRIANGLE = 0x80;
const isMove = (a) => (a & MOVE) !== 0;
const isDontMove = (a) => (a & MOVE) === 0;
const isInvalid = (a) => (a & (FIXED | MOVE)) === 0;
const MESH_TYPE_PROXY_BONE = 3;   // VirtualMesh.MeshType.ProxyBoneMesh
const PROXY_MESH_BONE_CLOTH_TRIANGLE_ANGLE = 120, PROXY_MESH_TRIANGLE_PAIR_ANGLE = 20, SAME_SURFACE_ANGLE = 80;
const MINIMUM_GRID_SIZE = 0.00001, TRIANGLE_BENDING_MAX_ANGLE = 120, VOLUME_MIN_ANGLE = 90, VOLUME_SIGN = 100, VOLUME_SCALE = 1000;
export const ConnectionMode = { Line: 0, AutomaticMesh: 1, SequentialLoopMesh: 2, SequentialNonLoopMesh: 3 };

// float32 storage (NativeArray<float3>) and float32 arithmetic where comparisons decide the topology
const fr = Math.fround;
const f3 = (v) => [fr(v[0]), fr(v[1]), fr(v[2])];
const f4 = (q) => [fr(q[0]), fr(q[1]), fr(q[2]), fr(q[3])];
const sub32 = (a, b) => [fr(a[0] - b[0]), fr(a[1] - b[1]), fr(a[2] - b[2])];
const dot32 = (a, b) => fr(fr(fr(a[0] * b[0]) + fr(a[1] * b[1])) + fr(a[2] * b[2]));
const length32 = (a) => fr(Math.sqrt(dot32(a, a)));
const distance32 = (a, b) => length32(sub32(a, b));
const distancesq32 = (a, b) => { const d = sub32(a, b); return dot32(d, d); };
const FLOAT_MAX = 3.4028234663852886e38;

// DataUtility
const packInt2 = (a, b) => (a < b ? int2Key(a, b) : int2Key(b, a));
const pack32Sort = (a, b) => (a > b ? ((b << 16) | (a & 0xffff)) >>> 0 : ((a << 16) | (b & 0xffff)) >>> 0);
const pack12_20 = (hi, low) => (((hi & 0xfff) << 20) | (low & 0xfffff)) >>> 0;
function packInt3(d0, d1, d2) {
  if (d0 < d1 && d0 < d2) return d1 < d2 ? [d0, d1, d2] : [d0, d2, d1];
  if (d1 < d2) return d0 < d2 ? [d1, d0, d2] : [d1, d2, d0];
  return d0 < d1 ? [d2, d0, d1] : [d2, d1, d0];
}
function packInt4(d0, d1, d2, d3) {
  let w;
  if (d0 > d3) { w = d0; d0 = d3; d3 = w; }
  if (d1 > d2) { w = d1; d1 = d2; d2 = w; }
  if (d0 > d1) { w = d0; d0 = d1; d1 = w; }
  if (d2 > d3) { w = d2; d2 = d3; d3 = w; }
  if (d1 > d2) { w = d1; d1 = d2; d2 = w; }
  return [d0, d1, d2, d3];
}
const triKey = (t) => (t[0] * 32768 + t[1]) * 32768 + t[2];
const quadKey = (q) => ((q[0] * 32768 + q[1]) * 32768 + q[2]) * 32768 + q[3];
const remainingData = (tri, ex, ey) => (tri[0] !== ex && tri[0] !== ey ? tri[0] : tri[1] !== ex && tri[1] !== ey ? tri[1] : tri[2]);
const flipTriangle = (t) => [t[0], t[2], t[1]];

// ----------------------------------------------------------------------------------- prefab hierarchy
/**
 * The prefab hierarchy as MagicaCloth.Awake sees it, from the converter's transform table: children in Unity order
 * (siblingIndex) and world poses from the serialized local transforms (prefabLocal*, else the exported local).
 */
export function prefabHierarchy(transforms) {
  const byId = new Map(transforms.map((t, order) => [t.id, { t, order }]));
  const children = new Map();
  let ordered = true;
  for (const t of transforms) {
    if (t.parentId == null || !byId.has(t.parentId)) continue;
    if (!children.has(t.parentId)) children.set(t.parentId, []);
    children.get(t.parentId).push(t);
    if (t.siblingIndex == null) ordered = false;
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.siblingIndex ?? 0) - (b.siblingIndex ?? 0) || byId.get(a.id).order - byId.get(b.id).order);
  }
  const worlds = new Map();
  function world(id) {
    let w = worlds.get(id);
    if (w) return w;
    const { t } = byId.get(id);
    const lp = t.prefabLocalPosition ?? t.localPosition, lr = t.prefabLocalRotation ?? t.localRotation;
    const ls = t.prefabLocalScale ?? t.localScale;
    const parent = t.parentId != null && byId.has(t.parentId) ? world(t.parentId) : null;
    const local = M.trs(lp, lr, ls);
    const matrix = parent ? M.m4mul(parent.matrix, local) : local;
    const rotation = parent ? M.qmul(parent.rotation, lr) : lr.slice();
    // RenderSetupData.ReadTransformJob: scale = diag(float4x4(inverse(rot)) * localToWorld) (== lossyScale)
    const irot = M.qinverse(rotation);
    const scale = [0, 1, 2].map((k) => M.rotate(irot, [matrix[k * 4], matrix[k * 4 + 1], matrix[k * 4 + 2]])[k]);
    w = { matrix, position: [matrix[12], matrix[13], matrix[14]], rotation, scale };
    worlds.set(id, w);
    return w;
  }
  return {
    ordered,
    has: (id) => byId.has(id),
    name: (id) => byId.get(id)?.t.name,
    parentId: (id) => byId.get(id)?.t.parentId ?? null,
    children: (id) => (children.get(id) ?? []).map((c) => c.id),
    world,
  };
}

// ----------------------------------------------------------------------------------- RenderSetupData
function renderSetup(hierarchy, clothTransformId, rootIds) {
  const list = [], index = new Map(), stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    if (index.has(id)) continue;
    index.set(id, list.length);
    list.push(id);
    for (const c of hierarchy.children(id)) stack.push(c);
  }
  const vcnt = list.length;
  list.push(clothTransformId);   // render transform last
  const read = list.map((id) => {
    const w = hierarchy.world(id);
    return { position: f3(w.position), rotation: f4(w.rotation), scale: f3(w.scale) };
  });
  return {
    ids: list, vcnt, renderIndex: vcnt, rootIds: [...rootIds],
    parentIds: list.map((id) => hierarchy.parentId(id)),
    childIds: list.map((id) => hierarchy.children(id)),
    read,
  };
}

// ----------------------------------------------------------------------------------- import (ImportBoneType)
function importBones(setup, connectionMode) {
  const { vcnt, read, renderIndex } = setup;
  const r = read[renderIndex];
  const LtoW = M.trs(r.position, r.rotation, r.scale);   // GetRendeerLocalToWorldMatrix
  const WtoL = M.m4inverse(LtoW);
  const invDir = (d) => { const len = M.length(d); return len > 0 ? M.mul(M.normalize(M.m4vector(WtoL, d)), len) : d; };
  const mesh = {
    vcnt, isBoneCloth: true,
    initLocalToWorld: LtoW, initWorldToLocal: WtoL, initRotation: r.rotation, initInverseRotation: M.qinverse(r.rotation),
    initScale: r.scale,
    localPositions: [], localNormals: [], localTangents: [], uv: [], boneWeights: [], skinBoneBindPoses: [],
    skinBoneTransformIndices: Array.from({ length: vcnt }, (_, i) => i),
    attributes: new Uint8Array(vcnt), triangles: [], lines: [],
  };
  for (let v = 0; v < vcnt; v++) {   // Import_BoneVertexJob
    const { position, rotation, scale } = read[v];
    mesh.localPositions.push(f3(M.m4point(WtoL, position)));
    mesh.localNormals.push(f3(invDir(M.rotate(rotation, M.UP))));
    mesh.localTangents.push(f3(invDir(M.rotate(rotation, M.FORWARD))));
    mesh.uv.push([0, 0]);
    mesh.boneWeights.push({ w: [1, 0, 0, 0], i: [v, 0, 0, 0] });
    mesh.skinBoneBindPoses.push(M.m4mul(M.m4inverse(M.trs(position, rotation, scale)), LtoW).map(fr));
  }
  const indexOf = (id) => setup.ids.indexOf(id);
  if (connectionMode === ConnectionMode.Line) {
    for (let i = 0; i < vcnt; i++) {
      let p = setup.parentIds[i] == null ? -1 : indexOf(setup.parentIds[i]);
      if (p === renderIndex) p = -1;   // GetParentTransformIndex(i, centerExcluded: true)
      if (p >= 0) mesh.lines.push(p < i ? [p, i] : [i, p]);
    }
  } else {
    meshConnection(setup, mesh, connectionMode);
  }
  return mesh;
}

function meshConnection(setup, mesh, connectionMode) {
  const { vcnt } = setup, pos = mesh.localPositions;
  const idToIndex = new Map();
  for (let i = 0; i < vcnt; i++) if (!idToIndex.has(setup.ids[i])) idToIndex.set(setup.ids[i], i);
  let loop = connectionMode === ConnectionMode.SequentialLoopMesh;
  const sequential = loop || connectionMode === ConnectionMode.SequentialNonLoopMesh;
  let roots = [...setup.rootIds];
  const rootCnt = roots.length, lastRootIndex = rootCnt - 1;

  if (connectionMode === ConnectionMode.AutomaticMesh) {   // order the roots so that neighbours are nearest
    const temp = [...roots];
    roots = [temp[0]];
    let lastDist = 0;
    while (temp.length > 0) {
      const rootId = roots[roots.length - 1];
      const at = temp.indexOf(rootId);
      if (at >= 0) temp.splice(at, 1);
      const p = pos[idToIndex.get(rootId)];
      let minDist = FLOAT_MAX, minId = null;
      for (const id2 of temp) {
        const d = distance32(p, pos[idToIndex.get(id2)]);
        if (d < minDist) { minDist = d; minId = id2; }
      }
      if (minId !== null) {
        if (lastDist === 0 || minDist < fr(lastDist * 1.5)) {
          roots.push(minId);
          lastDist = lastDist === 0 ? minDist : fr(fr(lastDist + minDist) * 0.5);
        } else {
          roots.reverse();
          lastDist = 0;
        }
      }
    }
    if (roots.length >= 3) {   // close the loop when the ends are as near as neighbours
      const d = distance32(pos[idToIndex.get(roots[0])], pos[idToIndex.get(roots[roots.length - 1])]);
      if (d < fr(lastDist * 1.5)) loop = true;
    }
  }

  // parent / child links per vertex, level lists, main (hierarchy) edges
  const linkList = Array.from({ length: vcnt }, () => []);
  const vertexLv = new Int32Array(vcnt), vertexRoot = new Int32Array(vcnt), lvIndexList = [];
  const mainEdges = new Set();
  for (let i = 0; i < rootCnt; i++) {
    const stack = [roots[i]], lvstack = [0];
    while (stack.length) {
      const id = stack.pop(), lv = lvstack.pop(), vindex = idToIndex.get(id);
      if (lvIndexList.length <= lv) lvIndexList.push([]);
      lvIndexList[lv].push(vindex);
      const link = [];
      const pid = setup.parentIds[vindex];
      if (idToIndex.has(pid)) {
        const v2 = idToIndex.get(pid);
        link.push(v2);
        mainEdges.add(pack32Sort(vindex, v2));
      }
      for (const cid of setup.childIds[vindex]) {
        stack.push(cid);
        lvstack.push(lv + 1);
        const v2 = idToIndex.get(cid);
        link.push(v2);
        mainEdges.add(pack32Sort(vindex, v2));
      }
      linkList[vindex] = link;
      vertexLv[vindex] = lv;
      vertexRoot[vindex] = i;
    }
  }

  // same-level neighbours: the nearest, then everything within 1.5x of it (any distance when sequential)
  const startEnd = pack32Sort(0, lastRootIndex);
  const skip = (rootIndex, rootIndex2) => {
    const firstLast = startEnd === pack32Sort(rootIndex, rootIndex2) && startEnd > 0;
    if (!loop && firstLast) return true;
    return sequential && !(loop && firstLast) && Math.abs(rootIndex - rootIndex2) > 1;
  };
  for (let i = 0; i < vcnt; i++) {
    const lvList = lvIndexList[vertexLv[i]], p = pos[i], link = linkList[i], rootIndex = vertexRoot[i];
    let firstDist = FLOAT_MAX, firstIndex = -1;
    for (const v of lvList) {
      if (v === i || skip(rootIndex, vertexRoot[v])) continue;
      const d = distance32(p, pos[v]);
      if (d < firstDist) { firstDist = d; firstIndex = v; }
    }
    if (firstIndex >= 0) {
      link.push(firstIndex);
      firstDist = sequential ? FLOAT_MAX : fr(firstDist * 1.5);
      for (const v of lvList) {
        if (v === i || v === firstIndex || skip(rootIndex, vertexRoot[v])) continue;
        if (distance32(p, pos[v]) <= firstDist) link.push(v);
      }
    }
  }

  // triangles from link pairs (C# HashSet: insertion order)
  const edgeSet = new Set(), triangleEdgeSet = new Set(), triangleSet = new Map();
  for (let i = 0; i < vcnt; i++) {
    const link = linkList[i];
    if (link.length === 0) continue;   // "Connection 0!"
    if (link.length === 1) { edgeSet.add(packInt2(i, link[0])); continue; }
    for (const v1 of link) edgeSet.add(packInt2(i, v1));
    const rootIndex = vertexRoot[i], p = pos[i];
    for (let j = 0; j < link.length - 1; j++) {
      const v1 = link[j], a = sub32(pos[v1], p);
      for (let k = j + 1; k < link.length; k++) {
        const v2 = link[k], b = sub32(pos[v2], p);
        if (dot32(a, a) < fr(1e-6) || dot32(b, b) < fr(1e-6)) continue;
        if (M.degrees(M.angleV(a, b)) >= PROXY_MESH_BONE_CLOTH_TRIANGLE_ANGLE) continue;
        const r1 = vertexRoot[v1], r2 = vertexRoot[v2];
        if (r1 !== rootIndex && r2 !== rootIndex && r1 !== r2) continue;   // never across three root lines
        const main = (mainEdges.has(pack32Sort(i, v1)) ? 1 : 0) + (mainEdges.has(pack32Sort(i, v2)) ? 1 : 0)
          + (mainEdges.has(pack32Sort(v1, v2)) ? 1 : 0);
        if (main === 0) continue;
        const tri = packInt3(i, v1, v2), key = triKey(tri);
        if (!triangleSet.has(key)) {
          triangleSet.set(key, tri);
          triangleEdgeSet.add(packInt2(i, v1));
          triangleEdgeSet.add(packInt2(i, v2));
        }
      }
    }
  }
  mesh.triangles = [...triangleSet.values()];
  for (const e of triangleEdgeSet) edgeSet.delete(e);
  mesh.lines = [...edgeSet].map((k) => [int2X(k), int2Y(k)]);
}

// ----------------------------------------------------------------------------------- import tail
function aabbOf(points) {
  const min = [FLOAT_MAX, FLOAT_MAX, FLOAT_MAX], max = [-FLOAT_MAX, -FLOAT_MAX, -FLOAT_MAX];
  for (const p of points) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  return { min, max, center: f3(M.mul(M.add(min, max), 0.5)) };
}

function sphereMappingUV(mesh, aabb) {   // JobUtility.CalcUVWithSphereMappingRun
  mesh.uv = mesh.localPositions.map((p, index) => {
    const lv = M.normalize(M.sub(p, aabb.center));
    const u = M.clamp(M.unlerp(-Math.PI, Math.PI, Math.atan2(lv[0], lv[2])), 0, 1);
    const v = M.clamp(M.unlerp(1, -1, lv[1]), 0, 1);
    const add = fr(index * 0.0001234);
    return [fr(fr(v * 10) + add), fr(fr(u * 10) + add)];
  });
}

function averageAndMaxVertexDistance(mesh) {   // VirtualMesh.CalcAverageAndMaxVertexDistanceRun
  const pos = mesh.localPositions;
  let sum = 0, cnt = 0, maxsq = 0;
  const tcnt = mesh.triangles.length, lcnt = mesh.lines.length;
  if (tcnt > 0) {
    const step = Math.max(Math.trunc(tcnt / 100), 1);
    let s = 0, m = 0;
    for (let t = 0; t < tcnt; t += step) {
      const [a, b, c] = mesh.triangles[t];
      for (const d of [distancesq32(pos[a], pos[b]), distancesq32(pos[b], pos[c]), distancesq32(pos[c], pos[a])]) {
        s = fr(s + d);
        m = Math.max(m, d);
      }
      cnt += 3;
    }
    sum = fr(sum + s);
    maxsq = Math.max(maxsq, m);
  }
  if (lcnt > 0) {
    const step = Math.max(Math.trunc(lcnt / 100), 1);
    let s = 0, m = 0;
    for (let l = 0; l < lcnt; l += step) {
      const d = distancesq32(pos[mesh.lines[l][0]], pos[mesh.lines[l][1]]);
      s = fr(s + d);
      m = Math.max(m, d);
      cnt++;
    }
    sum = fr(sum + s);
    maxsq = Math.max(maxsq, m);
  }
  mesh.averageVertexDistance = cnt > 0 ? fr(Math.sqrt(fr(sum / cnt))) : 0;
  mesh.maxVertexDistance = cnt > 0 ? fr(Math.sqrt(maxsq)) : 0;
}

// ----------------------------------------------------------------------------------- Optimization
function removeDuplicateTriangles(mesh) {
  const tris = mesh.triangles, tcnt = tris.length, pos = mesh.localPositions;
  if (tcnt < 2) return;
  const edgeToTriangleList = new NativeParallelHashMap(tcnt * 2, hashInt2Key);
  for (let i = 0; i < tcnt; i++) {
    const t = tris[i];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const edge = packInt2(a, b);
      if (edgeToTriangleList.containsKey(edge)) {
        const list = edgeToTriangleList.get(edge);
        if (!list.includes(i)) list.push(i);
      } else {
        edgeToTriangleList.add(edge, [i]);
      }
    }
  }
  const useQuadSet = new Set(), removeTriangleSet = new Set();
  for (const [edge, tlist] of edgeToTriangleList.entries()) {
    const ex = int2X(edge), ey = int2Y(edge), px = pos[ex], py = pos[ey];
    for (let i = 0; i < tlist.length - 1; i++) {
      const tri1 = tris[tlist[i]], z = remainingData(tri1, ex, ey), pz = pos[z];
      for (let j = i + 1; j < tlist.length; j++) {
        const tri2 = tris[tlist[j]], w = remainingData(tri2, ex, ey), pw = pos[w];
        if (Math.abs(M.degrees(M.triangleAngle(px, py, pz, pw))) > PROXY_MESH_TRIANGLE_PAIR_ANGLE) continue;
        const { s, t } = M.closestPtSegmentSegment(px, py, pz, pw);
        if (s === 0 || s === 1 || t === 0 || t === 1) continue;
        const quad = quadKey(packInt4(ex, ey, z, w));
        if (useQuadSet.has(quad)) {
          removeTriangleSet.add(triKey(tri1));
          removeTriangleSet.add(triKey(tri2));
        } else {
          useQuadSet.add(quad);
        }
      }
    }
  }
  mesh.triangles = tris.filter((t) => !removeTriangleSet.has(triKey(t)));
}

// ----------------------------------------------------------------------------------- selection
function applySelection(mesh, selection) {
  let radius = Math.max(mesh.averageVertexDistance, selection.maxConnectionDistance);
  radius = Math.max(radius, MINIMUM_GRID_SIZE);
  const gridSize = fr(radius * 1.5);
  const grid = (p) => p.map((x) => Math.floor(fr(x / gridSize)));
  const cells = new Map();   // GridMap (NativeParallelMultiHashMap<int3,int>, never grows): newest first per cell
  selection.positions.forEach((p, i) => {
    const key = grid(p).join(",");
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).unshift(i);
  });
  mesh.localPositions.forEach((p, v) => {
    const lo = grid(p.map((x) => fr(x - radius))), hi = grid(p.map((x) => fr(x + radius)));
    let minDist = FLOAT_MAX, minAttr = 0;
    for (let z = Math.min(lo[2], hi[2]); z <= Math.max(lo[2], hi[2]); z++) {
      for (let y = Math.min(lo[1], hi[1]); y <= Math.max(lo[1], hi[1]); y++) {
        for (let x = Math.min(lo[0], hi[0]); x <= Math.max(lo[0], hi[0]); x++) {
          for (const t of cells.get(`${x},${y},${z}`) ?? []) {
            const d = distance32(p, selection.positions[t]);
            if (d > radius || d > minDist) continue;
            minDist = d;
            minAttr = selection.attributes[t];
          }
        }
      }
    }
    mesh.attributes[v] |= minAttr;
  });
}

// ----------------------------------------------------------------------------------- ConvertProxyMesh
function optimizeTriangleDirection(mesh, triNormals, edgeToTriangles) {
  const tris = mesh.triangles, tcnt = tris.length, pos = mesh.localPositions;
  const twoTriangleAngle = (tri1, tri2, ex, ey) => {
    const sv1 = remainingData(tri1, ex, ey), sv2 = remainingData(tri2, ex, ey);
    const va = M.sub(pos[ey], pos[ex]), vb = M.sub(pos[sv1], pos[ex]), vc = M.sub(pos[sv2], pos[ex]);
    return M.degrees(M.angleV(M.cross(va, vb), M.cross(vc, va)));
  };
  const twoTriangleOpen = (tri2, ex, ey, n) => M.dot(n, M.normalize(M.sub(pos[remainingData(tri2, ex, ey)], pos[ex]))) <= 0;
  const used = new Set();
  for (let start = 0; start < tcnt; start++) {
    if (used.has(start)) continue;
    used.add(start);
    const queue = [start], layer = [];
    let open = 0, close = 0;
    while (queue.length) {
      const tindex = queue.shift(), n = triNormals[tindex], tri = tris[tindex];
      layer.push(tindex);
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const edge = packInt2(a, b), ex = int2X(edge), ey = int2Y(edge);
        if (!edgeToTriangles.containsKey(edge)) continue;
        for (const tindex2 of edgeToTriangles.valuesForKey(edge)) {
          if (used.has(tindex2)) continue;
          let tri2 = tris[tindex2];
          if (twoTriangleAngle(tri, tri2, ex, ey) > SAME_SURFACE_ANGLE) continue;
          if (M.dot(n, triNormals[tindex2]) < 0) {
            tri2 = flipTriangle(tri2);
            tris[tindex2] = tri2;
            triNormals[tindex2] = M.neg(triNormals[tindex2]);
          }
          if (twoTriangleOpen(tri2, ex, ey, n)) open++; else close++;
          used.add(tindex2);
          queue.push(tindex2);
        }
      }
    }
    if (close > open) {
      for (const t of layer) { tris[t] = flipTriangle(tris[t]); triNormals[t] = M.neg(triNormals[t]); }
    }
  }
}

function bestDirection(tset, dirs) {   // Proxy_OrganizeVertexToTrianglsJob fallback for a short sum
  let maxDist = -1, best = [0, 0, 0];
  for (const t1 of tset) {
    let n = [0, 0, 0];
    for (const t2 of tset) if (t2 !== t1) n = M.add(n, M.dot(dirs[t1], dirs[t2]) >= 0 ? dirs[t2] : M.neg(dirs[t2]));
    const d = M.lengthsq(n);
    if (d > maxDist) { maxDist = d; best = dirs[t1]; }
  }
  return best;
}

// VirtualMesh.SetCustomSkinningBones: the bones join the transform list (after the center) and the skin bones
function setCustomSkinningBones(mesh, setup) {
  mesh.customSkinningBones = [];
  for (const bone of setup.customSkinningBones) {
    if (!bone) { mesh.customSkinningBones.push(null); continue; }
    const index = mesh.skinBoneTransformIndices.length;
    const tindex = setup.ids.length;
    setup.ids.push(bone.id);
    mesh.skinBoneTransformIndices.push(tindex);
    mesh.skinBoneBindPoses.push(M.m4mul(M.m4inverse(bone.matrix), mesh.initLocalToWorld).map(fr));
    mesh.customSkinningBones.push({ index, localPosition: f3(M.m4point(mesh.initWorldToLocal, bone.position)) });
  }
}

// VirtualMesh.CreateCustomSkinning + Proxy_CalcCustomSkinningWeightsJobV2 (the variant in the game binary):
// moving vertices take the 4 nearest bones, weights 1 / (d - 0.6 dmin)^2, dropping weights under 0.1%
function createCustomSkinning(mesh) {
  const bones = mesh.customSkinningBones.filter(Boolean);
  if (!bones.length) return;
  for (let v = 0; v < mesh.vcnt; v++) {
    if (isDontMove(mesh.attributes[v])) continue;
    const costs = [-1, -1, -1, -1], data = [0, 0, 0, 0];   // ExCostSortedList4
    const count = () => { for (let i = 3; i >= 0; i--) if (costs[i] >= 0) return i + 1; return 0; };
    const indexOf = (item) => { for (let i = 0; i < 4; i++) if (costs[i] >= 0 && data[i] === item) return i; return -1; };
    const add = (cost, item) => {
      if (costs[3] >= 0 && cost > costs[3]) return;
      for (let i = 0; i < 4; i++) {
        if (costs[i] < 0) { costs[i] = cost; data[i] = item; return; }
        if (cost < costs[i]) {
          for (let j = 2; j >= i; j--) { costs[j + 1] = costs[j]; data[j + 1] = data[j]; }
          costs[i] = cost; data[i] = item; return;
        }
      }
    };
    const remove = (item) => {
      const at = indexOf(item);
      if (at < 0) return;
      for (let j = at; j < 3; j++) { costs[j] = costs[j + 1]; data[j] = data[j + 1]; }
      costs[3] = -1;
    };
    for (const b of bones) {
      const d = distance32(mesh.localPositions[v], b.localPosition), now = indexOf(b.index);
      if (now >= 0) { if (d < costs[now]) { remove(b.index); add(d, b.index); } } else add(d, b.index);
    }
    let cnt = count();
    const mindist = fr(costs[0] * fr(0.6));
    for (let i = 0; i < cnt; i++) costs[i] = fr(costs[i] - mindist);
    for (let i = 0; i < cnt; i++) costs[i] = fr(Math.pow(costs[i], 2));
    if (costs[0] < M.EPSILON) {
      mesh.boneWeights[v] = { w: [1, 0, 0, 0], i: [data[0], 0, 0, 0] };
      continue;
    }
    cnt = count();
    let sum = 0;
    for (let i = 0; i < cnt; i++) sum = fr(sum + fr(1 / costs[i]));
    for (let i = 0; i < cnt; i++) costs[i] = fr(fr(1 / costs[i]) / sum);
    sum = 0;
    for (let i = 0; i < 4; i++) {
      if (costs[i] < 0.001 || i >= cnt) { costs[i] = 0; data[i] = 0; } else sum = fr(sum + costs[i]);
    }
    mesh.boneWeights[v] = { w: costs.map((c) => fr(c / sum)), i: data.slice() };
  }
}

function convertProxyMesh(mesh, setup, sd) {
  const V = mesh.vcnt, pos = mesh.localPositions, attr = mesh.attributes;
  setCustomSkinningBones(mesh, setup);
  const tcnt = mesh.triangles.length;

  // vertex-to-vertex and edges
  const vvBuilder = new NativeParallelHashMap(V * 4, hashInt, true), edgeSet = new NativeParallelHashMap(V * 2, hashInt2Key);
  for (const [x, y, z] of mesh.triangles) {
    vvBuilder.uniqueAdd(x, y); vvBuilder.uniqueAdd(x, z); vvBuilder.uniqueAdd(y, x);
    vvBuilder.uniqueAdd(y, z); vvBuilder.uniqueAdd(z, x); vvBuilder.uniqueAdd(z, y);
    edgeSet.add(packInt2(x, y)); edgeSet.add(packInt2(y, z)); edgeSet.add(packInt2(z, x));
  }
  for (const [x, y] of mesh.lines) {
    vvBuilder.uniqueAdd(x, y); vvBuilder.uniqueAdd(y, x);
    edgeSet.add(packInt2(x, y));
  }
  mesh.edges = edgeSet.keyArray();
  mesh.vertexToVertex = multiDataToArrays(vvBuilder, V);

  // triangles: edge map, normals, winding, tangents, per-vertex triangle sets and normals
  mesh.vertexToTriangles = Array.from({ length: V }, () => []);
  mesh.edgeToTriangles = new NativeParallelHashMap(tcnt > 0 ? tcnt * 2 : 1, hashInt2Key, true);
  if (tcnt > 0) {
    mesh.triangles.forEach((t, i) => {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) mesh.edgeToTriangles.uniqueAdd(packInt2(a, b), i);
    });
    const triNormals = mesh.triangles.map(([a, b, c]) => f3(M.normalize(M.cross(M.sub(pos[b], pos[a]), M.sub(pos[c], pos[a])))));
    optimizeTriangleDirection(mesh, triNormals, mesh.edgeToTriangles);
    const triTangents = mesh.triangles.map(([a, b, c]) => f3(M.triangleTangent(pos[a], pos[b], pos[c], mesh.uv[a], mesh.uv[b], mesh.uv[c])));
    mesh.triangles.forEach((t, i) => {
      for (const v of t) { const s = mesh.vertexToTriangles[v]; if (s.length < 7 && !s.includes(i)) s.push(i); }
    });
    for (let v = 0; v < V; v++) {
      const tset = mesh.vertexToTriangles[v];
      if (tset.length === 0) continue;
      attr[v] |= TRIANGLE;
      let fn = [0, 0, 0], ft = [0, 0, 0];
      for (const t of tset) { fn = M.add(fn, triNormals[t]); ft = M.add(ft, triTangents[t]); }
      fn = M.length(fn) < 0.5 ? bestDirection(tset, triNormals) : M.normalize(fn);
      ft = M.length(ft) < 0.5 ? bestDirection(tset, triTangents) : M.normalize(ft);
      mesh.vertexToTriangles[v] = tset.map((t) => pack12_20((M.dot(fn, triNormals[t]) < 0 ? 1 : 0) | (M.dot(ft, triTangents[t]) < 0 ? 2 : 0), t));
      let nor = [0, 0, 0], tan = [0, 0, 0];
      for (const d of mesh.vertexToTriangles[v]) {
        const flip = d >>> 20, t = d & 0xfffff;
        nor = M.add(nor, M.mul(triNormals[t], flip & 1 ? -1 : 1));
        tan = M.add(tan, M.mul(triTangents[t], flip & 2 ? -1 : 1));
      }
      nor = M.normalize(nor);
      mesh.localNormals[v] = f3(nor);
      mesh.localTangents[v] = f3(M.normalize(M.cross(nor, tan)));   // binormal (v2.1.7)
    }
  }

  // ProxyCreateFixedListAndAABB: fixed vertices next to a moving one (or isolated).  A fixed vertex surrounded by
  // fixed ones is skipped entirely, so it is also left out of the bounding box.
  const fixedList = [], boxPoints = [];
  let lcen = [0, 0, 0];
  for (let i = 0; i < V; i++) {
    if (!isMove(attr[i])) {
      const pack = mesh.vertexToVertex.index[i], dcnt = pack >>> 20, dstart = pack & 0xfffff;
      let j = 0;
      for (; j < dcnt; j++) if (isMove(attr[mesh.vertexToVertex.data[dstart + j]])) break;
      if (j === dcnt && dcnt > 0) continue;
      fixedList.push(i);
      lcen = M.add(lcen, pos[i]);
    }
    boxPoints.push(pos[i]);
  }
  mesh.boundingBox = aabbOf(boxPoints);
  mesh.centerFixedList = fixedList;
  mesh.localCenterPosition = fixedList.length ? M.mul(lcen, 1 / fixedList.length) : [0, 0, 0];

  if (mesh.isBoneCloth) createTransformBaseLine(mesh, setup); else createMeshBaseLine(mesh);

  // ProxyNormalAdjustment.  The game predates 2.13.0 ("Fixed the custom normal calculation algorithm"), so this is
  // its ProxyNormalRadiationAdjustmentJob as disassembled from libil2cpp.so (Execute, RVA 0x7E22DF0), not the 2.16
  // source: the tangent becomes the direction to the base-line children (their summed offsets) or, at a tip, from
  // the parent; the normal becomes the radial direction from the center made perpendicular to that tangent.
  mesh.normalAdjustmentRotations = Array.from({ length: V }, () => [0, 0, 0, 1]);
  const align = sd.normalAlignmentSetting?.alignmentMode ?? 0;
  if (align === 1 || align === 2) {
    const center = align === 1 ? mesh.boundingBox.center : f3(M.m4point(mesh.initWorldToLocal, setup.normalAdjustmentPosition));
    for (let v = 0; v < V; v++) {
      const d = sub32(pos[v], center), len = length32(d);
      if (len < M.EPSILON) continue;
      const n = M.mul(d, 1 / len);
      const lrot = M.toRotation(mesh.localNormals[v], mesh.localTangents[v]);
      let nrot = lrot;
      const pack = mesh.childIndex[v], cnt = pack >>> 20, start = pack & 0xfffff;
      let z = null;
      if (cnt > 0) {
        let c = [0, 0, 0];
        for (let j = 0; j < cnt; j++) c = M.add(c, M.sub(pos[mesh.childData[start + j]], pos[v]));
        if (M.lengthsq(c) > M.EPSILON) z = M.normalize(c);
      } else if (mesh.parent[v] >= 0) {
        z = M.normalize(M.sub(pos[v], pos[mesh.parent[v]]));
      }
      if (z) {
        const y = M.cross(M.cross(z, n), z);   // n without its component along z
        if (M.lengthsq(y) > M.EPSILON) {
          const yn = M.normalize(y);
          mesh.localNormals[v] = f3(yn);
          mesh.localTangents[v] = f3(z);
          nrot = M.toRotation(yn, z);
        }
      }
      mesh.normalAdjustmentRotations[v] = f4(M.qmul(M.qinverse(lrot), nrot));
    }
  }

  // BoneCloth write-back rotation, vertex bind poses
  mesh.vertexToTransformRotations = [];
  mesh.vertexBindPosePositions = [];
  mesh.vertexBindPoseRotations = [];
  for (let v = 0; v < V; v++) {
    const vrot = M.toRotation(mesh.localNormals[v], mesh.localTangents[v]);
    if (mesh.isBoneCloth) mesh.vertexToTransformRotations.push(f4(M.qmul(M.qinverse(vrot), M.qmul(mesh.initInverseRotation, setup.read[v].rotation))));
    else mesh.vertexToTransformRotations.push([0, 0, 0, 1]);
    mesh.vertexBindPosePositions.push(f3(M.neg(pos[v])));
    mesh.vertexBindPoseRotations.push(f4(M.qinverse(vrot)));
  }

  createBaseLinePose(mesh);
  createVertexRootAndDepth(mesh);
  createCustomSkinning(mesh);
}

function createTransformBaseLine(mesh, setup) {
  const V = mesh.vcnt, attr = mesh.attributes;
  const idToIndex = new Map();
  for (let i = 0; i < V; i++) {
    if (idToIndex.has(setup.ids[i])) throw new Error("MagicaCloth2: duplicate transform in a BoneCloth");
    idToIndex.set(setup.ids[i], i);
  }
  mesh.parent = Array.from({ length: V }, (_, i) => (idToIndex.has(setup.parentIds[i]) ? idToIndex.get(setup.parentIds[i]) : -1));
  const childMap = new NativeParallelHashMap(V * 2, hashInt, true);
  for (let i = 0; i < V; i++) if (mesh.parent[i] >= 0) childMap.add(mesh.parent[i], i);

  const flags = [], starts = [], counts = [], data = [];
  for (const id of setup.rootIds) {
    const rootStack = [idToIndex.get(id)];
    while (rootStack.length) {
      const index0 = rootStack.pop();
      if (!isDontMove(attr[index0])) continue;
      let hasMove = false;
      for (const c of childMap.valuesForKey(index0)) if (isMove(attr[c])) hasMove = true;
      if (!hasMove) {   // go deeper until a fixed vertex has moving children
        for (const c of childMap.valuesForKey(index0)) if (isDontMove(attr[c])) rootStack.push(c);
        continue;
      }
      const stack = [index0], start = data.length;
      let count = 0, flag = 0;
      while (stack.length) {
        const index = stack.pop();
        data.push(index);
        count++;
        if ((attr[index] & TRIANGLE) === 0) flag |= 1;   // BaseLineFlag_IncludeLine
        for (const c of childMap.valuesForKey(index)) if (!isDontMove(attr[c])) stack.push(c);
      }
      flags.push(flag);
      starts.push(start);
      counts.push(count);
    }
  }
  mesh.baseLine = { flags, start: starts, count: counts, data };
  const child = multiDataToArrays(childMap, V);
  mesh.childIndex = Array.from(child.index);
  mesh.childData = child.data;
}

// CreateMeshBaseLine: parents grow out of the fixed vertices level by level; a moving vertex takes the fixed
// neighbour nearest to it, or the moving neighbour that continues its parent line straightest
function createMeshBaseLine(mesh) {
  const V = mesh.vcnt, attr = mesh.attributes, pos = mesh.localPositions, vv = mesh.vertexToVertex;
  mesh.parent = new Array(V).fill(-1);
  const childMap = new NativeParallelHashMap(V, hashInt, true);
  const fixedList = [];
  for (let i = 0; i < V; i++) if (attr[i] & FIXED) fixedList.push(i);
  const flags = [], starts = [], counts = [], data = [];
  mesh.baseLine = { flags, start: starts, count: counts, data };
  if (!fixedList.length) {
    mesh.childIndex = new Array(V).fill(0);
    mesh.childData = [];
    return;
  }
  const mark = new Uint8Array(V);
  const vertexMap = new NativeParallelHashMap(V, hashInt);
  let nextList = fixedList.map((v) => ({ vindex: v, dist: 0 }));
  const neighbours = (v) => { const p = vv.index[v], cnt = p >>> 20, s = p & 0xfffff; return vv.data.slice(s, s + cnt); };
  while (nextList.length > 0) {
    for (const { vindex } of nextList) {
      if (isDontMove(attr[vindex])) continue;
      let cost = -1, best = -1;   // ExCostSortedList1(-1, -1): the first of equal costs stays
      for (const t of neighbours(vindex)) {
        if (mark[t] === 0) continue;
        let c;
        if (isDontMove(attr[t])) c = distance32(pos[vindex], pos[t]);
        else c = fr(M.angleV(sub32(pos[t], pos[vindex]), sub32(pos[mesh.parent[t]], pos[t])));
        if (cost < 0 || c < cost) { cost = c; best = t; }
      }
      if (cost >= 0) { mesh.parent[vindex] = best; mark[vindex] = 1; }
    }
    for (const { vindex } of nextList) {
      mark[vindex] = 2;
      const p = mesh.parent[vindex];
      if (p >= 0) childMap.uniqueAdd(p, vindex);
    }
    vertexMap.clear();
    let mapcnt = 0;
    for (const { vindex } of nextList) {
      for (const t of neighbours(vindex)) {
        if (isInvalid(attr[t]) || mark[t] !== 0) continue;
        const d = distance32(pos[vindex], pos[t]);
        const known = vertexMap.get(t);
        if (known) { if (d < known.dist) known.dist = d; } else { vertexMap.add(t, { vindex: t, dist: d }); mapcnt++; }
      }
    }
    nextList = [];
    if (mapcnt > 0) {
      for (const [, w] of vertexMap.entries()) nextList.push({ vindex: w.vindex, dist: w.dist });
      unitySort(nextList, (a, b) => Math.sign(a.dist - b.dist));
    }
  }
  for (const fv of fixedList) {
    if (childMap.countValuesForKey(fv) === 0) continue;
    const stack = [fv], start = data.length;
    let count = 0, flag = 0;
    while (stack.length) {
      const v = stack.pop();
      data.push(v);
      count++;
      if ((attr[v] & TRIANGLE) === 0) flag |= 1;
      for (const c of childMap.valuesForKey(v)) stack.push(c);
    }
    flags.push(flag);
    starts.push(start);
    counts.push(count);
  }
  const child = multiDataToArrays(childMap, V);
  mesh.childIndex = Array.from(child.index);
  mesh.childData = child.data;
}

function createBaseLinePose(mesh) {
  const V = mesh.vcnt;
  mesh.vertexLocalPositions = Array.from({ length: V }, () => [0, 0, 0]);
  mesh.vertexLocalRotations = Array.from({ length: V }, () => [0, 0, 0, 0]);   // default(quaternion) off the base lines
  for (const v of mesh.baseLine.data) {
    const p = mesh.parent[v];
    if (p >= 0) {
      const iprot = M.qinverse(M.toRotation(mesh.localNormals[p], mesh.localTangents[p]));
      const rot = M.toRotation(mesh.localNormals[v], mesh.localTangents[v]);
      mesh.vertexLocalPositions[v] = f3(M.rotate(iprot, M.sub(mesh.localPositions[v], mesh.localPositions[p])));
      mesh.vertexLocalRotations[v] = f4(M.qmul(iprot, rot));
    } else {
      mesh.vertexLocalPositions[v] = [0, 0, 0];
      mesh.vertexLocalRotations[v] = [0, 0, 0, 1];
    }
  }
}

function createVertexRootAndDepth(mesh) {
  const V = mesh.vcnt, attr = mesh.attributes, pos = mesh.localPositions;
  mesh.root = new Array(V).fill(-1);
  mesh.depth = new Array(V).fill(0);
  const rootLength = new Array(V).fill(0);
  let maxLen = 0;
  for (let i = 0; i < V; i++) {
    let rootIndex = -1, len = 0;
    if (isMove(attr[i])) {
      let c = i, p = mesh.parent[c];
      while (p >= 0) {
        len = fr(len + distance32(pos[c], pos[p]));
        rootIndex = p;
        if (!isMove(attr[p])) break;
        c = p;
        p = mesh.parent[c];
      }
    }
    mesh.root[i] = rootIndex;
    rootLength[i] = len;
    maxLen = Math.max(maxLen, len);
  }
  if (maxLen > M.EPSILON) for (let i = 0; i < V; i++) mesh.depth[i] = fr(M.saturate(rootLength[i] / maxLen));
}

// ----------------------------------------------------------------------------------- constraint data
function distanceData(mesh) {
  const V = mesh.vcnt, attr = mesh.attributes, pos = mesh.localPositions;
  const vvMap = arraysToMultiMap(mesh.vertexToVertex.index, mesh.vertexToVertex.data);
  const connect = new Set();
  const vertical = new NativeParallelHashMap(V * 2, hashInt, true), horizontal = new NativeParallelHashMap(V * 2, hashInt, true);
  for (let i = 0; i < V; i++) {
    if (!vvMap.containsKey(i)) continue;
    const p = mesh.parent[i];
    for (const t of vvMap.valuesForKey(i)) {
      if (!isMove(attr[i]) && !isMove(attr[t])) continue;
      if (isInvalid(attr[i]) || isInvalid(attr[t])) continue;
      if (t === p || i === mesh.parent[t]) vertical.add(i, t); else horizontal.add(i, t);
      connect.add(pack32Sort(i, t));
    }
  }
  // shear: the other diagonal of a flat, square-ish triangle pair
  for (const edge of mesh.edges) {
    const tset = [...mesh.edgeToTriangles.valuesForKey(edge)];
    if (tset.length < 2) continue;
    const ex = int2X(edge), ey = int2Y(edge), p1 = pos[ex], p2 = pos[ey];
    const edgeLength1 = M.length(M.sub(p1, p2));
    if (edgeLength1 < M.EPSILON) continue;
    for (let i = 0; i < tset.length - 1; i++) {
      const e3 = remainingData(mesh.triangles[tset[i]], ex, ey), p3 = pos[e3];
      const n1 = M.normalize(M.cross(M.sub(p2, p1), M.sub(p3, p1)));
      for (let j = i + 1; j < tset.length; j++) {
        const e4 = remainingData(mesh.triangles[tset[j]], ex, ey), p4 = pos[e4];
        const n2 = M.normalize(M.cross(M.sub(p2, p1), M.sub(p4, p1)));
        if (!isMove(attr[e3]) && !isMove(attr[e4])) continue;
        if (Math.abs(M.dot(n1, n2)) < 0.9396926) continue;
        if (Math.abs(M.length(M.sub(p3, p4)) / edgeLength1 - 1) > 0.3) continue;
        const pack = pack32Sort(e3, e4);
        if (!connect.has(pack)) {
          connect.add(pack);
          horizontal.add(e3, e4);
          horizontal.add(e4, e3);
        }
      }
    }
  }
  const v = multiDataToArrays(vertical, V), h = multiDataToArrays(horizontal, V);
  if (v.data.length + h.data.length === 0) return null;
  const index = new Uint32Array(V), data = [], dist = [];
  for (let i = 0; i < V; i++) {
    const start = data.length;
    for (const [arr, sign] of [[v, 1], [h, -1]]) {   // negative distance = horizontal
      const pack = arr.index[i], cnt = pack >>> 20, s = pack & 0xfffff;
      for (let j = 0; j < cnt; j++) {
        const t = arr.data[s + j], d = distance32(pos[i], pos[t]);
        if (d < fr(1e-6)) continue;
        data.push(t);
        dist.push(sign * d);
      }
    }
    index[i] = pack12_20(data.length - start, start);
  }
  return { index, data: Uint16Array.from(data), dist: Float32Array.from(dist) };
}

function bendingData(mesh) {
  if (mesh.triangles.length === 0 || mesh.edges.length === 0) return null;
  const attr = mesh.attributes, pos = mesh.localPositions;
  const pairs = [], rest = [], sign = [], volumeSet = new Set();
  const world = (v) => M.m4point(mesh.initLocalToWorld, pos[v]);
  for (const edge of mesh.edges) {
    if (!mesh.edgeToTriangles.containsKey(edge)) continue;
    const ex = int2X(edge), ey = int2Y(edge), tlist = [...mesh.edgeToTriangles.valuesForKey(edge)];
    for (let i = 0; i < tlist.length - 1; i++) {
      const tri0 = mesh.triangles[tlist[i]];
      for (let j = i + 1; j < tlist.length; j++) {
        const tri1 = mesh.triangles[tlist[j]];
        const vtx = [tri0.find((v) => v !== ex && v !== ey) ?? -1, tri1.find((v) => v !== ex && v !== ey) ?? -1, ex, ey];
        const a = vtx.map((v) => attr[v]);
        if (a.every(isDontMove) || a.some(isInvalid)) continue;
        // InitDihedralAngle (0/1 opposite vertices, 2/3 the shared edge)
        const [p0, p1, p2, p3] = vtx.map((v) => pos[v]);
        const n1 = M.normalize(M.cross(M.sub(p2, p0), M.sub(p3, p0))), n2 = M.normalize(M.cross(M.sub(p3, p1), M.sub(p2, p1)));
        const restAngle = Math.acos(M.clamp1(M.dot(n1, n2)));
        const signFlag = M.sign(M.dot(M.cross(n1, n2), M.sub(p3, p2))) < 0 ? -1 : 1;
        const deg = Math.abs(M.degrees(restAngle));
        if (deg < TRIANGLE_BENDING_MAX_ANGLE) {
          pairs.push(vtx);
          rest.push(restAngle);
          sign.push(signFlag);
        }
        if (deg >= VOLUME_MIN_ANGLE && deg <= 179) {
          const key = quadKey(packInt4(...vtx));
          if (!volumeSet.has(key)) {   // InitVolume, in world space like the runtime
            const [w0, w1, w2, w3] = vtx.map(world);
            pairs.push(vtx);
            rest.push((1 / 6) * M.dot(M.cross(M.sub(w1, w0), M.sub(w2, w0)), M.sub(w3, w0)) * VOLUME_SCALE);
            sign.push(VOLUME_SIGN);
            volumeSet.add(key);
          }
        }
      }
    }
  }
  if (!pairs.length) return null;
  return { pairs, restAngleOrVolume: Float32Array.from(rest), signOrVolume: Int8Array.from(sign) };
}

function initLocalGravityDirection(mesh, worldGravityDirection) {   // InertiaConstraint.CreateData
  if (!mesh.centerFixedList.length) return [0, -1, 0];
  let nor = [0, 0, 0], tan = [0, 0, 0];
  for (const v of mesh.centerFixedList) {
    const q = M.qmul(M.toRotation(mesh.localNormals[v], mesh.localTangents[v]), mesh.vertexBindPoseRotations[v]);
    nor = M.add(nor, M.toNormal(q));
    tan = M.add(tan, M.toTangent(q));
  }
  const rot = M.toRotation(M.normalize(nor), M.normalize(tan));
  return f3(M.rotate(M.qinverse(rot), worldGravityDirection));
}

// ----------------------------------------------------------------------------------- entry point
/**
 * Build a BoneCloth like the game does without PreBuild data.
 * transforms: the converter's transform table; cloth: { transformId, serializeData, serializeData2 } fields of the
 * MagicaCloth component; params: clothParameters(serializeData).  -> { proxy, distance, bending,
 * initLocalGravityDirection, mappings: [], build } where proxy has the shape of data.js' decoded PreBuild proxy.
 */
export function buildBoneCloth(transforms, cloth, params, hierarchy = prefabHierarchy(transforms)) {
  const sd = cloth.serializeData, sd2 = cloth.serializeData2 ?? {};
  if (sd.clothType !== 1) throw new Error(`MagicaCloth2: clothType ${sd.clothType} has no runtime build (only BoneCloth)`);
  const rootIds = (sd.rootBones ?? []).map((r) => r?.transformId ?? null);
  // ClothSerializeData.IsValid rejects a BoneCloth whose roots are all missing (the game never builds it); a missing
  // root next to valid ones passes validation but makes RenderSetupData throw (Dictionary key null), same result
  if (!rootIds.some((id) => id !== null)) throw new Error("MagicaCloth2: BoneCloth without root bones (the game does not build it)");
  if (rootIds.includes(null)) throw new Error("MagicaCloth2: BoneCloth with a missing root bone (the game's build throws)");
  if (new Set(rootIds).size !== rootIds.length) throw new Error("MagicaCloth2: duplicate root bones (SerializeData_DuplicateRootBone)");
  for (const id of [cloth.transformId, ...rootIds]) {
    if (id == null || !hierarchy.has(id)) throw new Error(`MagicaCloth2: BoneCloth transform ${id} is missing from the transform table`);
  }
  const setup = renderSetup(hierarchy, cloth.transformId, rootIds);
  const adjust = sd.normalAlignmentSetting?.adjustmentTransform?.transformId;
  setup.normalAdjustmentPosition = hierarchy.world(adjust && hierarchy.has(adjust) ? adjust : cloth.transformId).position.map(fr);
  setup.customSkinningBones = !sd.customSkinningSetting?.enable ? [] : (sd.customSkinningSetting.skinningBones ?? []).map((r) => {
    const id = r?.transformId;
    if (id == null) return null;
    if (!hierarchy.has(id)) throw new Error(`MagicaCloth2: custom skinning bone ${id} is missing from the transform table`);
    const w = hierarchy.world(id);
    return { id, position: f3(w.position), matrix: w.matrix };
  });

  const mesh = importBones(setup, sd.connectionMode ?? 0);
  const importAabb = aabbOf(mesh.localPositions);
  if (mesh.triangles.length > 0) sphereMappingUV(mesh, importAabb);
  averageAndMaxVertexDistance(mesh);

  // selection: the serialized one, or every bone moving with fixed roots
  const sel = sd2.selectionData;
  const selAttr = (a) => (typeof a === "number" ? a : a?.Value ?? 0);
  let selection;
  if (sel?.positions?.length && sel?.attributes?.length && sel.positions.length === sel.attributes.length) {
    selection = { positions: sel.positions.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z])), attributes: sel.attributes.map(selAttr),
      maxConnectionDistance: sel.maxConnectionDistance ?? 0, generated: false };
  } else {
    const attributes = new Array(setup.vcnt).fill(MOVE);
    for (const id of rootIds) attributes[setup.ids.indexOf(id)] = FIXED;
    selection = { positions: mesh.localPositions.map((p) => p.slice()), attributes, maxConnectionDistance: mesh.maxVertexDistance, generated: true };
  }

  removeDuplicateTriangles(mesh);
  applySelection(mesh, selection);
  convertProxyMesh(mesh, setup, sd);
  if (mesh.vcnt > 32767 || mesh.edges.length > 32767 || mesh.triangles.length > 32767) throw new Error("MagicaCloth2: proxy mesh too large");

  const V = mesh.vcnt;
  const proxy = {
    count: V,
    meshType: MESH_TYPE_PROXY_BONE, isBoneCloth: true,
    attr: Array.from(mesh.attributes),
    localPositions: mesh.localPositions, localNormals: mesh.localNormals, localTangents: mesh.localTangents,
    uv: mesh.uv, boneWeights: mesh.boneWeights,
    triangles: mesh.triangles.flat(), lines: mesh.lines.flat(),
    edges: mesh.edges.flatMap((k) => [int2X(k), int2Y(k)]),
    vertexToTriangles: mesh.vertexToTriangles,
    depth: mesh.depth, root: mesh.root, parent: mesh.parent,
    childIndex: mesh.childIndex, childData: mesh.childData,
    vertexLocalPositions: mesh.vertexLocalPositions, vertexLocalRotations: mesh.vertexLocalRotations,
    vertexBindPosePositions: mesh.vertexBindPosePositions, vertexBindPoseRotations: mesh.vertexBindPoseRotations,
    vertexToTransformRotations: mesh.vertexToTransformRotations, normalAdjustmentRotations: mesh.normalAdjustmentRotations,
    baseLine: mesh.baseLine,
    centerFixedList: mesh.centerFixedList,
    centerTransformIndex: setup.renderIndex,
    skinRootIndex: 0,
    skinBoneTransformIndices: mesh.skinBoneTransformIndices,
    skinBoneBindPoses: mesh.skinBoneBindPoses,
    initScale: mesh.initScale,
    initLocalToWorld: mesh.initLocalToWorld.map(fr),
    transformIds: setup.ids,
  };
  return {
    proxy,
    distance: distanceData(mesh),
    bending: bendingData(mesh),
    initLocalGravityDirection: initLocalGravityDirection(mesh, M.normalizesafe(params.worldGravityDirection)),
    mappings: [],
    build: {   // intermediate results kept for checks against PreBuild data
      siblingOrder: hierarchy.ordered, selectionGenerated: selection.generated,
      averageVertexDistance: mesh.averageVertexDistance, maxVertexDistance: mesh.maxVertexDistance,
      boundingBox: mesh.boundingBox, localCenterPosition: mesh.localCenterPosition,
      vertexToVertex: mesh.vertexToVertex,
      edgeToTriangles: Array.from(mesh.edgeToTriangles.entries(), ([k, v]) => [int2X(k), int2Y(k), v]),
    },
  };
}

// shared with build-mesh.js (MeshCloth runtime build)
export {
  FIXED, MOVE, TRIANGLE, isMove, isDontMove, isInvalid, MINIMUM_GRID_SIZE, FLOAT_MAX,
  fr, f3, f4, sub32, dot32, length32, distance32, distancesq32, packInt2, packInt3,
  aabbOf, sphereMappingUV, averageAndMaxVertexDistance, removeDuplicateTriangles, applySelection, convertProxyMesh,
  distanceData, bendingData, initLocalGravityDirection,
};

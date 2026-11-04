import { clothTopology } from "./cloth-geometry.js";

// Automatic proxy spacing, in median render edge lengths. 2.7 reproduces the
// density of the source proxies (e.g. 154 particles for a 1191 vertex skirt);
// finer reductions cost time without visibly changing the motion.
const SPACING = 2.7;

/**
 * Reduced proxy surface for one cloth primitive.
 *
 * The render mesh is clustered into sparse proxy particles: simulation runs on
 * the proxies and every render vertex is skinned to up to four of them. This
 * follows the structure of Magica Cloth's reduced proxy mesh: spatial merging
 * joins UV seams, separately modelled frills and layered pieces that lie on the
 * same surface, so they move together instead of tearing apart.
 *
 * `proxy.vertices` (optional) is a source-provided cluster index per POSITION
 * vertex. Without it the clustering is derived here from the rest mesh.
 */
export function buildClothProxy(geometry, fixed, proxy, { spacing } = {}) {
  const topology = clothTopology(geometry, fixed);
  const position = geometry.getAttribute("position");
  const nodes = topology.vertices.length;
  const nodePosition = new Float64Array(nodes * 3);
  topology.vertices.forEach((vertex, node) => {
    nodePosition[node * 3] = position.getX(vertex);
    nodePosition[node * 3 + 1] = position.getY(vertex);
    nodePosition[node * 3 + 2] = position.getZ(vertex);
  });
  const nodeFixed = new Uint8Array(nodes);
  for (const node of topology.fixed) nodeFixed[node] = 1;

  let cluster;
  if (proxy?.vertices !== undefined) cluster = sourceClusters(proxy.vertices, topology, position.count);
  else cluster = spatialClusters(nodePosition, nodeFixed, topology.indices, spacing);
  const count = cluster.count;
  const nodeCluster = cluster.nodeCluster;

  // Proxy rest pose: centroid of members. Fixed if any member is fixed.
  const rest = new Float64Array(count * 3), size = new Uint32Array(count), proxyFixed = new Uint8Array(count);
  for (let node = 0; node < nodes; node++) {
    const c = nodeCluster[node];
    size[c]++;
    for (let k = 0; k < 3; k++) rest[c * 3 + k] += nodePosition[node * 3 + k];
    if (nodeFixed[node]) proxyFixed[c] = 1;
  }
  for (let c = 0; c < count; c++) for (let k = 0; k < 3; k++) rest[c * 3 + k] /= size[c];
  if (!proxyFixed.some(Boolean)) throw new Error("cloth proxy 没有固定点");

  const triangles = collapseTriangles(topology.indices, nodeCluster, nodePosition);
  const { edges, bends, adjacency } = proxyLinks(count, triangles);
  const bridges = bridgeIslands(count, rest, proxyFixed, edges, adjacency);
  const normals = restNormals(count, rest, triangles);

  const used = [];
  for (let i = 0; i < position.count; i++) if (topology.mapping[i] >= 0) used.push(i);
  const renderCluster = new Int32Array(position.count).fill(-1);
  for (const i of used) renderCluster[i] = nodeCluster[topology.mapping[i]];

  const fixedVertex = new Uint8Array(position.count);
  for (const i of fixed) fixedVertex[i] = 1;
  const weights = renderWeights(position, used, renderCluster, rest, triangles, adjacency, fixedVertex);
  // Authored render normals say which side is outside. Proxy triangles merge
  // both faces of thin or double-sided cloth, so their winding cannot; orient
  // every proxy normal to agree with its members' normals.
  const memberNormal = new Float64Array(count * 3), memberCount = new Uint32Array(count), normal = geometry.getAttribute("normal");
  for (const v of used) {
    const c = renderCluster[v];
    memberNormal[c * 3] += normal.getX(v); memberNormal[c * 3 + 1] += normal.getY(v); memberNormal[c * 3 + 2] += normal.getZ(v);
    memberCount[c]++;
  }
  // Zero orientation: members disagree (back-to-back faces of double-sided
  // cloth), so the proxy has no defined outside and gets no backstop.
  const orientation = new Float64Array(count);
  for (let c = 0; c < count; c++) {
    const o = c * 3, l = Math.hypot(memberNormal[o], memberNormal[o + 1], memberNormal[o + 2]);
    if (l > 1e-12) for (let k = 0; k < 3; k++) memberNormal[o + k] /= l;
    const dot = normals[o] * memberNormal[o] + normals[o + 1] * memberNormal[o + 1] + normals[o + 2] * memberNormal[o + 2];
    orientation[c] = l <= .5 * memberCount[c] ? 0 : dot < 0 ? -1 : 1;
  }
  const thickness = memberThickness(position, used, renderCluster, rest, memberNormal);
  // Farthest member from its proxy: render vertices can touch colliders
  // that the proxy particle itself does not yet reach.
  let extent = 0;
  for (const v of used) {
    const c = renderCluster[v];
    extent = Math.max(extent, Math.hypot(position.getX(v) - rest[c * 3], position.getY(v) - rest[c * 3 + 1], position.getZ(v) - rest[c * 3 + 2]));
  }
  const allEdges = concat(edges, bridges);
  return compact({
    depth: fixedDistance(count, rest, proxyFixed, allEdges), extent,
    topology, count, rest, fixed: proxyFixed, renderCluster, used,
    triangles, edges: allEdges, bends, weights, thickness, orientation,
  });
}

/**
 * Keep moving proxies and the fixed proxies they touch. Fixed regions far from
 * any moving cloth (a waistband, a whole jacket body around a short hem) just
 * follow animation: they need no targets, links or writeback.
 */
function compact(proxy) {
  const { count, fixed, edges, bends, triangles, weights, renderCluster, used } = proxy;
  const keep = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (!fixed[i]) keep[i] = 1;
  for (const links of [edges, bends]) for (let e = 0; e < links.length; e += 2) {
    const a = links[e], b = links[e + 1];
    if (!fixed[a] || !fixed[b]) keep[a] = keep[b] = 1;
  }
  const { indices } = weights;
  for (const v of used) {
    let moving = false;
    for (let k = 0; k < 4 && indices[v * 4 + k] >= 0; k++) if (!fixed[indices[v * 4 + k]]) moving = true;
    if (moving) for (let k = 0; k < 4 && indices[v * 4 + k] >= 0; k++) keep[indices[v * 4 + k]] = 1;
  }
  const map = new Int32Array(count).fill(-1);
  let kept = 0;
  for (let i = 0; i < count; i++) if (keep[i]) map[i] = kept++;
  const pick = (array, size = 1) => {
    if (!array) return array;
    const out = new array.constructor(kept * size);
    for (let i = 0; i < count; i++) if (map[i] >= 0) for (let k = 0; k < size; k++) out[map[i] * size + k] = array[i * size + k];
    return out;
  };
  const remapLinks = (links, size) => {
    const out = [];
    for (let e = 0; e < links.length; e += size) {
      const item = Array.from(links.subarray(e, e + size), (i) => map[i]);
      if (item.every((i) => i >= 0)) out.push(...item);
    }
    return Uint32Array.from(out);
  };
  const cluster = Int32Array.from(renderCluster, (c) => c >= 0 ? map[c] : -1);
  const memberStart = new Uint32Array(kept + 1);
  for (const v of used) if (cluster[v] >= 0) memberStart[cluster[v] + 1]++;
  for (let c = 0; c < kept; c++) memberStart[c + 1] += memberStart[c];
  const members = new Uint32Array(memberStart[kept]), fill = memberStart.slice(0, kept);
  for (const v of used) if (cluster[v] >= 0) members[fill[cluster[v]]++] = v;
  const weightIndices = new Int32Array(indices.length).fill(-1), weightValues = new Float32Array(indices.length);
  for (const v of used) {
    let slot = 0;
    for (let k = 0; k < 4 && indices[v * 4 + k] >= 0; k++) {
      const c = map[indices[v * 4 + k]];
      if (c < 0) continue;
      weightIndices[v * 4 + slot] = c; weightValues[v * 4 + slot] = weights.weights[v * 4 + k]; slot++;
    }
  }
  return {
    ...proxy, count: kept, renderCluster: cluster, members, memberStart,
    rest: pick(proxy.rest, 3), fixed: pick(fixed), depth: pick(proxy.depth), thickness: pick(proxy.thickness),
    orientation: pick(proxy.orientation),
    edges: remapLinks(edges, 2), bends: remapLinks(bends, 2), triangles: remapLinks(triangles, 3),
    weights: { indices: weightIndices, weights: weightValues },
  };
}

/** Rest distance along the proxy links to the nearest fixed particle. */
function fixedDistance(count, rest, fixed, edges) {
  const neighbours = Array.from({ length: count }, () => []);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1];
    const d = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
    neighbours[a].push(b, d); neighbours[b].push(a, d);
  }
  const distance = new Float64Array(count).fill(Infinity), done = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (fixed[i]) distance[i] = 0;
  // Dense Dijkstra: proxy counts are small and this runs once at load.
  for (;;) {
    let best = -1;
    for (let i = 0; i < count; i++) if (!done[i] && distance[i] < Infinity && (best < 0 || distance[i] < distance[best])) best = i;
    if (best < 0) break;
    done[best] = 1;
    const list = neighbours[best];
    for (let k = 0; k < list.length; k += 2) {
      const next = list[k], d = distance[best] + list[k + 1];
      if (d < distance[next]) distance[next] = d;
    }
  }
  let finite = 0;
  for (const d of distance) if (d < Infinity && d > finite) finite = d;
  for (let i = 0; i < count; i++) if (distance[i] === Infinity) distance[i] = finite;
  return distance;
}

function concat(a, b) {
  const out = new Uint32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
}

function sourceClusters(vertices, topology, vertexCount) {
  if (!Array.isArray(vertices) || vertices.length !== vertexCount) throw new Error("cloth proxy vertices 需要覆盖全部 POSITION 顶点");
  const remap = new Map(), nodeCluster = new Int32Array(topology.vertices.length).fill(-1);
  for (let i = 0; i < vertexCount; i++) {
    const node = topology.mapping[i];
    if (node < 0) continue;
    const source = vertices[i];
    if (!Number.isSafeInteger(source) || source < 0) throw new Error(`cloth proxy vertex ${i} 无效`);
    let c = remap.get(source);
    if (c === undefined) { c = remap.size; remap.set(source, c); }
    if (nodeCluster[node] >= 0 && nodeCluster[node] !== c) throw new Error(`cloth proxy 拆开了同一焊接顶点 ${i}`);
    nodeCluster[node] = c;
  }
  return { count: remap.size, nodeCluster };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

/** Greedy spatial merge on a hash grid; fixed and moving surfaces stay apart. */
function spatialClusters(position, fixed, indices, spacing) {
  const nodes = fixed.length;
  if (spacing === undefined) {
    const lengths = [];
    for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = indices[t + k] * 3, b = indices[t + (k + 1) % 3] * 3;
      lengths.push(Math.hypot(position[a] - position[b], position[a + 1] - position[b + 1], position[a + 2] - position[b + 2]));
    }
    spacing = SPACING * median(lengths);
  }
  if (!(spacing > 0)) {
    return { count: nodes, nodeCluster: Int32Array.from({ length: nodes }, (_, i) => i) };
  }
  const cell = spacing, grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const centers = [];
  const nodeCluster = new Int32Array(nodes).fill(-1);
  const nearest = (node, limit) => {
    const x = position[node * 3], y = position[node * 3 + 1], z = position[node * 3 + 2];
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let best = -1, bestDistance = limit * limit;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const c of grid.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
        if (centers[c].fixed !== fixed[node]) continue;
        const d = (centers[c].x - x) ** 2 + (centers[c].y - y) ** 2 + (centers[c].z - z) ** 2;
        if (d < bestDistance) { bestDistance = d; best = c; }
      }
    }
    return best;
  };
  const addCenter = (x, y, z, f) => {
    const c = centers.length;
    centers.push({ x, y, z, fixed: f });
    const k = key(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
    return c;
  };
  // Seed centers in index order: a point within half the spacing of an
  // existing center joins it, otherwise it starts a new proxy particle.
  for (let node = 0; node < nodes; node++) {
    if (nearest(node, spacing * .5) < 0) addCenter(position[node * 3], position[node * 3 + 1], position[node * 3 + 2], fixed[node]);
  }
  // Assign every point to its nearest center, then move centers to member
  // means and reassign once (one Lloyd relaxation keeps clusters compact).
  for (let pass = 0; pass < 2; pass++) {
    for (let node = 0; node < nodes; node++) nodeCluster[node] = nearest(node, spacing * 1.01);
    if (pass) break;
    const sum = new Float64Array(centers.length * 4);
    for (let node = 0; node < nodes; node++) {
      const c = nodeCluster[node];
      for (let k = 0; k < 3; k++) sum[c * 4 + k] += position[node * 3 + k];
      sum[c * 4 + 3]++;
    }
    const old = centers.splice(0);
    grid.clear();
    old.forEach((center, c) => {
      if (sum[c * 4 + 3]) addCenter(sum[c * 4] / sum[c * 4 + 3], sum[c * 4 + 1] / sum[c * 4 + 3], sum[c * 4 + 2] / sum[c * 4 + 3], center.fixed);
    });
  }
  // Drop centers that lost all members and compact the indices.
  const remap = new Int32Array(centers.length).fill(-1);
  let count = 0;
  for (let node = 0; node < nodes; node++) {
    const c = nodeCluster[node];
    if (remap[c] < 0) remap[c] = count++;
    nodeCluster[node] = remap[c];
  }
  return { count, nodeCluster };
}

/** Collapse render triangles; duplicate (double-sided) faces vote on winding. */
function collapseTriangles(indices, nodeCluster, position) {
  const faces = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const a = nodeCluster[indices[t]], b = nodeCluster[indices[t + 1]], c = nodeCluster[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const pa = indices[t] * 3, pb = indices[t + 1] * 3, pc = indices[t + 2] * 3;
    const ux = position[pb] - position[pa], uy = position[pb + 1] - position[pa + 1], uz = position[pb + 2] - position[pa + 2];
    const vx = position[pc] - position[pa], vy = position[pc + 1] - position[pa + 1], vz = position[pc + 2] - position[pa + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const sorted = [a, b, c].sort((x, y) => x - y);
    // Even permutations of the sorted order keep its winding.
    const even = (a === sorted[0] && b === sorted[1]) || (b === sorted[0] && c === sorted[1]) || (c === sorted[0] && a === sorted[1]);
    const k = sorted.join(",");
    faces.set(k, (faces.get(k) ?? 0) + (even ? area : -area) + (even ? 1e-12 : -1e-12));
  }
  const out = [];
  for (const [k, vote] of faces) {
    const [a, b, c] = k.split(",").map(Number);
    if (vote >= 0) out.push(a, b, c); else out.push(a, c, b);
  }
  return Uint32Array.from(out);
}

function proxyLinks(count, triangles) {
  const edgeFaces = new Map(), adjacency = Array.from({ length: count }, () => new Set());
  for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = triangles[t + k], b = triangles[t + (k + 1) % 3], opposite = triangles[t + (k + 2) % 3];
    const key = a < b ? a * count + b : b * count + a;
    if (!edgeFaces.has(key)) edgeFaces.set(key, []);
    edgeFaces.get(key).push(opposite);
    adjacency[a].add(b); adjacency[b].add(a);
  }
  const edges = [], bends = [], bendSeen = new Set();
  for (const [key, opposite] of edgeFaces) {
    edges.push(Math.floor(key / count), key % count);
    for (let i = 0; i < opposite.length; i++) for (let j = i + 1; j < opposite.length; j++) {
      const a = Math.min(opposite[i], opposite[j]), b = Math.max(opposite[i], opposite[j]);
      if (a === b || adjacency[a].has(b) || bendSeen.has(a * count + b)) continue;
      bendSeen.add(a * count + b); bends.push(a, b);
    }
  }
  return { edges: Uint32Array.from(edges), bends: Uint32Array.from(bends), adjacency };
}

/**
 * A proxy island without any fixed particle (a detached frill, bow or a
 * piece the clustering could not merge) is linked to its nearest neighbours
 * on other islands. Without this it would only follow its weak restoring
 * spring and visibly drift away from the garment it belongs to.
 */
function bridgeIslands(count, rest, fixed, edges, adjacency) {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < edges.length; e += 2) parent[find(edges[e])] = find(edges[e + 1]);
  const bridges = [];
  const anchored = () => {
    const roots = new Set();
    for (let i = 0; i < count; i++) if (fixed[i]) roots.add(find(i));
    return roots;
  };
  for (let guard = 0; guard < count; guard++) {
    const roots = anchored();
    const islands = new Map();
    for (let i = 0; i < count; i++) {
      const r = find(i);
      if (!roots.has(r)) { if (!islands.has(r)) islands.set(r, []); islands.get(r).push(i); }
    }
    if (!islands.size) break;
    // Attach the largest floating island first, at its closest points.
    const [root, island] = [...islands].sort((a, b) => b[1].length - a[1].length)[0];
    const pairs = [];
    for (const i of island) {
      let best = -1, bestDistance = Infinity;
      for (let j = 0; j < count; j++) {
        if (find(j) === root) continue;
        const d = (rest[i * 3] - rest[j * 3]) ** 2 + (rest[i * 3 + 1] - rest[j * 3 + 1]) ** 2 + (rest[i * 3 + 2] - rest[j * 3 + 2]) ** 2;
        if (d < bestDistance) { bestDistance = d; best = j; }
      }
      if (best >= 0) pairs.push([bestDistance, i, best]);
    }
    if (!pairs.length) break;
    pairs.sort((a, b) => a[0] - b[0]);
    // Three well separated links resist both translation and rotation.
    const chosen = [];
    for (const pair of pairs) {
      if (chosen.length >= 3) break;
      if (chosen.some(([, i]) => i === pair[1] || adjacency[i].has(pair[1]))) continue;
      chosen.push(pair);
    }
    if (!chosen.length) chosen.push(pairs[0]);
    for (const [, i, j] of chosen) {
      bridges.push(i, j); adjacency[i].add(j); adjacency[j].add(i);
      parent[find(i)] = find(j);
    }
  }
  return Uint32Array.from(bridges);
}

function restNormals(count, rest, triangles) {
  const normals = new Float64Array(count * 3);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
    const ux = rest[b] - rest[a], uy = rest[b + 1] - rest[a + 1], uz = rest[b + 2] - rest[a + 2];
    const vx = rest[c] - rest[a], vy = rest[c + 1] - rest[a + 1], vz = rest[c + 2] - rest[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const p of [a, b, c]) { normals[p] += nx; normals[p + 1] += ny; normals[p + 2] += nz; }
  }
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    if (l > 1e-20) for (let k = 0; k < 3; k++) normals[i * 3 + k] /= l;
  }
  return normals;
}

/** Closest point on triangle (Ericson), returning barycentric weights. */
function closestBarycentric(p, a, b, c, out) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(out, 1, 0, 0);
  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(out, 0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return set(out, 1 - v, v, 0); }
  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(out, 0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return set(out, 1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return set(out, 0, 1 - w, w); }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return set(out, 1 - v - w, v, w);
}
function set(out, u, v, w) { out[0] = u; out[1] = v; out[2] = w; return out; }

/**
 * Up to four proxy weights per render vertex: barycentric coordinates on the
 * nearest proxy triangle around its own cluster. Points on the proxy surface
 * interpolate exactly; neighbouring render vertices share triangles, so the
 * deformation stays continuous across cluster boundaries.
 */
function renderWeights(position, used, renderCluster, rest, triangles, adjacency, fixedVertex) {
  const count = adjacency.length;
  const incident = Array.from({ length: count }, () => []);
  for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) incident[triangles[t + k]].push(t);
  const indices = new Int32Array(position.count * 4).fill(-1), weights = new Float32Array(position.count * 4);
  const p = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], bary = [0, 0, 0], best = [0, 0, 0];
  const load = (target, i) => { target[0] = rest[i * 3]; target[1] = rest[i * 3 + 1]; target[2] = rest[i * 3 + 2]; };
  for (const v of used) {
    const own = renderCluster[v];
    // Declared fixed vertices always keep their animated pose exactly.
    if (fixedVertex[v]) { indices[v * 4] = own; weights[v * 4] = 1; continue; }
    p[0] = position.getX(v); p[1] = position.getY(v); p[2] = position.getZ(v);
    const candidates = new Set(incident[own]);
    for (const n of adjacency[own]) for (const t of incident[n]) candidates.add(t);
    let bestDistance = Infinity, bestTriangle = -1;
    for (const t of candidates) {
      load(a, triangles[t]); load(b, triangles[t + 1]); load(c, triangles[t + 2]);
      closestBarycentric(p, a, b, c, bary);
      const x = a[0] * bary[0] + b[0] * bary[1] + c[0] * bary[2] - p[0];
      const y = a[1] * bary[0] + b[1] * bary[1] + c[1] * bary[2] - p[1];
      const z = a[2] * bary[0] + b[2] * bary[1] + c[2] * bary[2] - p[2];
      const d = x * x + y * y + z * z;
      if (d < bestDistance - 1e-14) { bestDistance = d; bestTriangle = t; best[0] = bary[0]; best[1] = bary[1]; best[2] = bary[2]; }
    }
    if (bestTriangle < 0) { indices[v * 4] = own; weights[v * 4] = 1; continue; }
    let slot = 0, total = 0;
    for (let k = 0; k < 3; k++) if (best[k] > 1e-4) total += best[k];
    for (let k = 0; k < 3; k++) {
      if (best[k] <= 1e-4) continue;
      indices[v * 4 + slot] = triangles[bestTriangle + k]; weights[v * 4 + slot] = best[k] / total; slot++;
    }
  }
  return { indices, weights };
}

/** Depth of member render vertices behind their proxy, along its normal. */
function memberThickness(position, used, renderCluster, rest, normals) {
  const thickness = new Float64Array(rest.length / 3);
  for (const v of used) {
    const c = renderCluster[v];
    const dx = position.getX(v) - rest[c * 3], dy = position.getY(v) - rest[c * 3 + 1], dz = position.getZ(v) - rest[c * 3 + 2];
    const nx = normals[c * 3], ny = normals[c * 3 + 1], nz = normals[c * 3 + 2];
    const depth = nx || ny || nz ? -(dx * nx + dy * ny + dz * nz) : Math.hypot(dx, dy, dz);
    if (depth > thickness[c]) thickness[c] = depth;
  }
  return thickness;
}

import * as THREE from "three";
import { HUMANOID_BONE_NAMES } from "./skeleton-composer.js";

// Collision points are thinned to about one per POINT_SPACING (rest pose).
const POINT_SPACING = .018;
// Grid cell size; contacts are searched within one cell of the query point.
// A point a capsule left on its own surface can still be BODY_REACH inside
// the body, so the search must reach that deep (plus half a point spacing).
const CELL = .035;
// How close to a cloth's capsule colliders a surface point must be at load
// time to take part: the designer chose which limbs touch the cloth, the
// meshes around those limbs (skin, socks, shoes) give their exact shape.
export const BODY_REACH = .03;
// Slack on the per-frame bone-group bounds (blended skinning drifts from the
// dominant bone).
const GROUP_PAD = .06;
// Authored layering: a surface point with cloth within COVER_RADIUS that sits
// less than COVER_GAP in front of it (or inside it) at load is covered by that
// cloth by design (waistbands, linings under the skin line, garments worn over
// the cloth) and does not collide.
const COVER_RADIUS = .02;
const COVER_GAP = .004;

/**
 * The skinned surfaces around the limbs a cloth collides with, as oriented
 * points (position + normal) skinned every frame and hashed for contact
 * queries. Capsules keep handling fast limbs within substeps; this surface
 * resolves what capsules cannot express: shoes, socks, buttocks and thighs
 * sticking out of their capsules.
 */
export class BodySurface {
  /**
   * @param root character root
   * @param exclude meshes that never collide (simulated cloth)
   * @param distance (worldPoint) => distance to the nearest cloth collider at load
   * @param cloth world positions (xyz...) of every simulated cloth vertex at load
   * @param limbs names of the humanoid bones carrying the cloth's colliders:
   *   only vertices that follow those limbs (or helper bones under them) take
   *   part, not hair or fingers that happen to hang near a capsule.
   */
  static create(root, exclude, distance, cloth, limbs) {
    const meshes = [];
    root.updateMatrixWorld(true);
    root.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || exclude.has(mesh) || !mesh.visible) return;
      const g = mesh.geometry;
      if (!g.getAttribute("normal") || !g.getAttribute("skinIndex") || !g.getAttribute("skinWeight")) return;
      meshes.push(mesh);
    });
    const limb = new Map();
    const follows = (bone) => {
      if (!limb.has(bone)) {
        let node = bone;
        while (node && !HUMANOID_BONE_NAMES.has(node.name)) node = node.parent;
        limb.set(bone, Boolean(node) && limbs.has(node.name));
      }
      return limb.get(bone);
    };
    const kept = new Map(), point = new THREE.Vector3(), picks = [];
    for (const mesh of meshes) {
      const position = mesh.geometry.getAttribute("position");
      const skinIndex = mesh.geometry.getAttribute("skinIndex"), skinWeight = mesh.geometry.getAttribute("skinWeight");
      for (let i = 0; i < position.count; i++) {
        let top = 0;
        for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, top)) top = k;
        if (!follows(mesh.skeleton.bones[skinIndex.getComponent(i, top)])) continue;
        mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
        const key = `${Math.floor(point.x / POINT_SPACING)},${Math.floor(point.y / POINT_SPACING)},${Math.floor(point.z / POINT_SPACING)}`;
        if (kept.has(key) || !(distance(point) < BODY_REACH)) continue;
        kept.set(key, true);
        picks.push([mesh, i]);
      }
    }
    if (!picks.length) return null;
    // Skin once at the load pose for world normals, then flag covered points:
    // a query whose nearest point is covered leaves the cloth alone.
    const surface = new BodySurface(meshes, picks);
    surface.update([-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity]);
    const grid = new Map(), cell = (v) => Math.floor(v / COVER_RADIUS);
    for (let i = 0; i < cloth.length; i += 3) {
      const key = `${cell(cloth[i])},${cell(cloth[i + 1])},${cell(cloth[i + 2])}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    const P = surface.position, N = surface.normal, covered = surface.covered, coverDepth = surface.coverDepth;
    let open = 0;
    for (let p = 0; p < surface.count; p++) {
      const px = P[p * 3], py = P[p * 3 + 1], pz = P[p * 3 + 2], cx = cell(px), cy = cell(py), cz = cell(pz);
      // Covered: cloth sits within COVER_GAP of it; coverDepth: how far in
      // front of it (negative: behind it) the deepest such cloth sits.
      let deepest = COVER_GAP;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const ex = cloth[i] - px, ey = cloth[i + 1] - py, ez = cloth[i + 2] - pz;
          if (ex * ex + ey * ey + ez * ez > COVER_RADIUS * COVER_RADIUS) continue;
          const side = ex * N[p * 3] + ey * N[p * 3 + 1] + ez * N[p * 3 + 2];
          if (side < deepest) deepest = side;
        }
      }
      if (deepest < COVER_GAP) { covered[p] = 1; coverDepth[p] = Math.min(0, deepest); } else open++;
    }
    surface.openCount = open;
    return open ? surface : null;
  }

  constructor(meshes, picks) {
    // Palette: one matrix per (mesh, bone) actually referenced.
    const entries = new Map(), palette = [];
    const entry = (mesh, bone) => {
      const key = `${meshes.indexOf(mesh)}:${bone}`;
      if (!entries.has(key)) { entries.set(key, palette.length); palette.push({ mesh, bone }); }
      return entries.get(key);
    };
    const n = picks.length, joint = new Int32Array(n * 4), weight = new Float64Array(n * 4);
    const local = new Float64Array(n * 3), normal = new Float64Array(n * 3), dominant = new Int32Array(n);
    picks.forEach(([mesh, v], p) => {
      const g = mesh.geometry, position = g.getAttribute("position"), normals = g.getAttribute("normal");
      const skinIndex = g.getAttribute("skinIndex"), skinWeight = g.getAttribute("skinWeight");
      local[p * 3] = position.getX(v); local[p * 3 + 1] = position.getY(v); local[p * 3 + 2] = position.getZ(v);
      normal[p * 3] = normals.getX(v); normal[p * 3 + 1] = normals.getY(v); normal[p * 3 + 2] = normals.getZ(v);
      let best = -1, top = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(v, k);
        joint[p * 4 + k] = w > 0 ? entry(mesh, skinIndex.getComponent(v, k)) : -1;
        weight[p * 4 + k] = w;
        if (w > top) { top = w; best = joint[p * 4 + k]; }
      }
      dominant[p] = best;
    });
    // Group points by dominant palette entry for per-frame culling.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => dominant[a] - dominant[b]);
    const remap = (array, size) => {
      const out = new array.constructor(array.length);
      order.forEach((from, to) => { for (let k = 0; k < size; k++) out[to * size + k] = array[from * size + k]; });
      return out;
    };
    this.source = order.map((i) => picks[i]);
    this.joint = remap(joint, 4); this.weight = remap(weight, 4);
    this.local = remap(local, 3); this.localNormal = remap(normal, 3);
    const sortedDominant = remap(dominant, 1);
    const groups = [];
    for (let p = 0; p < n; p++) {
      if (!groups.length || groups.at(-1).entry !== sortedDominant[p]) groups.push({ entry: sortedDominant[p], start: p, end: p, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] });
      const g = groups.at(-1); g.end = p + 1;
      for (let k = 0; k < 3; k++) {
        g.box[k] = Math.min(g.box[k], this.local[p * 3 + k]); g.box[k + 3] = Math.max(g.box[k + 3], this.local[p * 3 + k]);
      }
    }
    this.groups = groups;
    this.palette = palette;
    this.matrices = new Float64Array(palette.length * 16);
    this.count = n;
    this.covered = new Uint8Array(n);
    this.coverDepth = new Float64Array(n);
    this.openCount = n;
    this.position = new Float64Array(n * 3);
    this.normal = new Float64Array(n * 3);
    this.active = new Uint32Array(n);
    this.activeCount = 0;
    // Dense grid of CELL cells over the skinned points (rebuilt per frame).
    this.table = new Int32Array(1);
    this.grid = new Float64Array(3);
    this.dims = new Int32Array(3);
    this.cellPoints = new Uint32Array(n);
    this.cellOf = new Int32Array(n);
    this.matrix = new THREE.Matrix4();
    this.corner = new THREE.Vector3();
  }

  /** Skin and hash the groups that can reach [x0, y0, z0, x1, y1, z1]. */
  update(bounds) {
    const m = this.matrix, M = this.matrices;
    this.palette.forEach(({ mesh, bone }, j) => {
      m.multiplyMatrices(mesh.skeleton.bones[bone].matrixWorld, mesh.skeleton.boneInverses[bone])
        .premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix).premultiply(mesh.matrixWorld);
      M.set(m.elements, j * 16);
    });
    const L = this.local, LN = this.localNormal, J = this.joint, W = this.weight, P = this.position, N = this.normal;
    const corner = this.corner, active = this.active;
    let count = 0;
    for (const g of this.groups) {
      // World bounds of the group under its dominant bone.
      const o = g.entry * 16;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let c = 0; c < 8; c++) {
        corner.set(g.box[c & 1 ? 3 : 0], g.box[c & 2 ? 4 : 1], g.box[c & 4 ? 5 : 2]);
        const x = M[o] * corner.x + M[o + 4] * corner.y + M[o + 8] * corner.z + M[o + 12];
        const y = M[o + 1] * corner.x + M[o + 5] * corner.y + M[o + 9] * corner.z + M[o + 13];
        const z = M[o + 2] * corner.x + M[o + 6] * corner.y + M[o + 10] * corner.z + M[o + 14];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      if (x1 + GROUP_PAD < bounds[0] || x0 - GROUP_PAD > bounds[3] || y1 + GROUP_PAD < bounds[1] || y0 - GROUP_PAD > bounds[4]
        || z1 + GROUP_PAD < bounds[2] || z0 - GROUP_PAD > bounds[5]) continue;
      for (let p = g.start; p < g.end; p++) {
        const lx = L[p * 3], ly = L[p * 3 + 1], lz = L[p * 3 + 2], nx = LN[p * 3], ny = LN[p * 3 + 1], nz = LN[p * 3 + 2];
        let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
        for (let k = 0; k < 4; k++) {
          const j = J[p * 4 + k];
          if (j < 0) continue;
          const w = W[p * 4 + k], b = j * 16;
          px += w * (M[b] * lx + M[b + 4] * ly + M[b + 8] * lz + M[b + 12]);
          py += w * (M[b + 1] * lx + M[b + 5] * ly + M[b + 9] * lz + M[b + 13]);
          pz += w * (M[b + 2] * lx + M[b + 6] * ly + M[b + 10] * lz + M[b + 14]);
          qx += w * (M[b] * nx + M[b + 4] * ny + M[b + 8] * nz);
          qy += w * (M[b + 1] * nx + M[b + 5] * ny + M[b + 9] * nz);
          qz += w * (M[b + 2] * nx + M[b + 6] * ny + M[b + 10] * nz);
        }
        const l = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
        P[p * 3] = px; P[p * 3 + 1] = py; P[p * 3 + 2] = pz;
        N[p * 3] = qx / l; N[p * 3 + 1] = qy / l; N[p * 3 + 2] = qz / l;
        active[count++] = p;
      }
    }
    this.activeCount = count;
    // Counting sort of active points into a dense grid over their bounds.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let a = 0; a < count; a++) {
      const o = active[a] * 3, x = P[o], y = P[o + 1], z = P[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (!count) return;
    const nx = Math.floor((x1 - x0) / CELL) + 1, ny = Math.floor((y1 - y0) / CELL) + 1, nz = Math.floor((z1 - z0) / CELL) + 1;
    this.grid[0] = x0; this.grid[1] = y0; this.grid[2] = z0;
    this.dims[0] = nx; this.dims[1] = ny; this.dims[2] = nz;
    if (this.table.length < nx * ny * nz + 1) this.table = new Int32Array(nx * ny * nz + 1);
    const table = this.table, cellOf = this.cellOf, cells = this.cellPoints, size = nx * ny * nz;
    table.fill(0, 0, size + 1);
    for (let a = 0; a < count; a++) {
      const o = active[a] * 3;
      const h = (Math.floor((P[o] - x0) / CELL) * ny + Math.floor((P[o + 1] - y0) / CELL)) * nz + Math.floor((P[o + 2] - z0) / CELL);
      cellOf[a] = h; table[h + 1]++;
    }
    for (let h = 0; h < size; h++) table[h + 1] += table[h];
    const fill = this.fill?.length >= size ? this.fill : (this.fill = new Int32Array(Math.max(size, 1)));
    fill.set(table.subarray(0, size));
    for (let a = 0; a < count; a++) cells[fill[cellOf[a]]++] = active[a];
  }

  /**
   * Keep x[o..o+2] at least r in front of the nearest surface point's
   * tangent plane. Where the animated reference (ref[ro..]) is already closer
   * than r, `clearance` decides how far to keep (authored overlap stays).
   * Returns true when it moved the point.
   */
  collide(x, o, r, ref, ro, clearance) {
    if (!this.activeCount) return false;
    const P = this.position, N = this.normal, table = this.table, cells = this.cellPoints, grid = this.grid, dims = this.dims;
    const px = x[o], py = x[o + 1], pz = x[o + 2], gx = dims[0], gy = dims[1], gz = dims[2];
    const cx = Math.floor((px - grid[0]) / CELL), cy = Math.floor((py - grid[1]) / CELL), cz = Math.floor((pz - grid[2]) / CELL);
    if (cx < -1 || cy < -1 || cz < -1 || cx > gx || cy > gy || cz > gz) return false;
    const ax = cx > 0 ? cx - 1 : 0, bx = cx < gx - 1 ? cx + 1 : gx - 1;
    const ay = cy > 0 ? cy - 1 : 0, by = cy < gy - 1 ? cy + 1 : gy - 1;
    const az = cz > 0 ? cz - 1 : 0, bz = cz < gz - 1 ? cz + 1 : gz - 1;
    let best = -1, bestDistance = CELL * CELL;
    for (let ix = ax; ix <= bx; ix++) for (let iy = ay; iy <= by; iy++) {
      const row = (ix * gy + iy) * gz;
      for (let c = table[row + az], end = table[row + bz + 1]; c < end; c++) {
        const p = cells[c] * 3, ex = px - P[p], ey = py - P[p + 1], ez = pz - P[p + 2];
        const d = ex * ex + ey * ey + ez * ez;
        if (d < bestDistance) { bestDistance = d; best = p; }
      }
    }
    if (best < 0 || this.covered[best / 3]) return false;
    const nx = N[best], ny = N[best + 1], nz = N[best + 2];
    const s = (px - P[best]) * nx + (py - P[best + 1]) * ny + (pz - P[best + 2]) * nz;
    if (s >= r) return false;
    const sr = (ref[ro] - P[best]) * nx + (ref[ro + 1] - P[best + 1]) * ny + (ref[ro + 2] - P[best + 2]) * nz;
    const limit = sr < r ? clearance(sr, r) : r;
    if (s >= limit) return false;
    const push = limit - s;
    x[o] = px + nx * push; x[o + 1] = py + ny * push; x[o + 2] = pz + nz * push;
    return true;
  }

  /**
   * Last word on a drawn vertex x[o..] (the simulated surface, not a
   * particle): keep it on the outside of the nearest surface point, `gap` in
   * front of it, or as far as its animated position ref[ro..] is if that is
   * closer (authored contact). Covered points (authored overlap at load) only
   * keep it no deeper than the covering cloth was then. Probes resolve the
   * particles against the body once per step; the blended surface between
   * and behind them can still sink into it, most where a thigh root rises
   * into the waist of a skirt.
   */
  hug(x, o, ref, ro, gap) {
    if (!this.activeCount) return;
    const P = this.position, N = this.normal, table = this.table, cells = this.cellPoints, grid = this.grid, dims = this.dims;
    const px = x[o], py = x[o + 1], pz = x[o + 2], gx = dims[0], gy = dims[1], gz = dims[2];
    const cx = Math.floor((px - grid[0]) / CELL), cy = Math.floor((py - grid[1]) / CELL), cz = Math.floor((pz - grid[2]) / CELL);
    if (cx < -1 || cy < -1 || cz < -1 || cx > gx || cy > gy || cz > gz) return;
    const ax = cx > 0 ? cx - 1 : 0, bx = cx < gx - 1 ? cx + 1 : gx - 1;
    const ay = cy > 0 ? cy - 1 : 0, by = cy < gy - 1 ? cy + 1 : gy - 1;
    const az = cz > 0 ? cz - 1 : 0, bz = cz < gz - 1 ? cz + 1 : gz - 1;
    let best = -1, bestDistance = CELL * CELL;
    for (let ix = ax; ix <= bx; ix++) for (let iy = ay; iy <= by; iy++) {
      const row = (ix * gy + iy) * gz;
      for (let c = table[row + az], end = table[row + bz + 1]; c < end; c++) {
        const p = cells[c] * 3, ex = px - P[p], ey = py - P[p + 1], ez = pz - P[p + 2];
        const d = ex * ex + ey * ey + ez * ez;
        if (d < bestDistance) { bestDistance = d; best = p; }
      }
    }
    if (best < 0) return;
    const nx = N[best], ny = N[best + 1], nz = N[best + 2];
    const s = (px - P[best]) * nx + (py - P[best + 1]) * ny + (pz - P[best + 2]) * nz;
    let limit;
    if (this.covered[best / 3]) limit = this.coverDepth[best / 3];
    else {
      const sr = (ref[ro] - P[best]) * nx + (ref[ro + 1] - P[best + 1]) * ny + (ref[ro + 2] - P[best + 2]) * nz;
      limit = sr >= 0 && sr < gap ? sr : gap;
    }
    if (s >= limit) return;
    const push = limit - s;
    x[o] = px + nx * push; x[o + 1] = py + ny * push; x[o + 2] = pz + nz * push;
  }
}

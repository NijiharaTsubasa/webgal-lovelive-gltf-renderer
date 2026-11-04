/**
 * Position-based solver for sparse proxy cloth particles, in world metres.
 *
 * Each fixed step is split into substeps; colliders and animated targets are
 * interpolated between the previous and current animation sample, so fast
 * limbs cannot jump over a particle within one 1/60 s step. Particles are
 * transported with their animated reference (the animation is the cloth's
 * reference, not an impulse), keep the residual velocity, are pulled back by
 * `stiffness`, then edge/bend lengths follow the animated reference shape.
 * As in Magica Cloth's motion constraint, a particle never folds behind its
 * animated surface (backstop) and never strays further from its animated
 * position than its allowed distance, so a skirt flipped over a raised thigh
 * cannot stay caught there.
 */
export const COLLIDER_STRIDE = 13;
export const COLLIDER = { sphere: 0, capsule: 1, plane: 2, panel: 3 };
const MAX_SUBSTEPS = 8;
const MIN_SUBSTEPS = 2;
const ITERATIONS = 2;
// Cloth resists stretching, gives a little under compression, bends softly.
const STRETCH = 1, COMPRESS = .5, BEND = .25;
const CONTACT_SLACK = .02;
const RESTORE = .25;

export class ProxyClothSolver {
  constructor({ count, edges, bends, fixed, colliderTypes, minimumGap = 0, contactMargin = 0 }) {
    // Extra broadphase reach for points that follow a particle from a distance.
    this.contactMargin = contactMargin;
    this.count = count;
    this.edges = edges; this.bends = bends;
    this.edgeRest = new Float64Array(edges.length / 2);
    this.bendRest = new Float64Array(bends.length / 2);
    this.fixed = fixed;
    this.types = Uint8Array.from(colliderTypes);
    this.minimumGap = minimumGap;
    this.positions = new Float64Array(count * 3);
    this.previous = new Float64Array(count * 3);
    this.velocity = new Float64Array(count * 3);
    this.targets = new Float64Array(count * 3);
    this.lastTargets = new Float64Array(count * 3);
    this.lastColliders = new Float64Array(this.types.length * COLLIDER_STRIDE);
    this.colliders = new Float64Array(this.types.length * COLLIDER_STRIDE);
    // Per collider world AABB of its contact region, for a cheap reject.
    this.bounds = new Float64Array(this.types.length * 6);
    this.pairs = new Uint32Array(Math.max(2, count * this.types.length * 2));
    // Particles with a contact candidate in the last substep.
    this.near = new Uint32Array(count);
    this.lastSubsteps = 0;
  }

  reset(targets, colliders) {
    this.positions.set(targets); this.previous.set(targets);
    this.lastTargets.set(targets); this.targets.set(targets);
    this.velocity.fill(0);
    this.lastColliders.set(colliders);
    this.colliders.set(colliders);
  }

  /**
   * Enough substeps that no collider near the cloth moves by more than ~40%
   * of its own contact thickness per substep. Distant colliders (a waving
   * hand far above a skirt) do not force substeps on this cloth.
   */
  substeps(colliders, radius, targets) {
    const last = this.lastColliders, x = this.positions, fixed = this.fixed;
    let smallest = Infinity, x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0, o = 0; i < this.count; i++, o += 3) {
      if (fixed[i]) continue;
      if (radius[i] < smallest) smallest = radius[i];
      for (let k = 0; k < 2; k++) {
        const p = k ? targets : x;
        if (p[o] < x0) x0 = p[o]; if (p[o] > x1) x1 = p[o];
        if (p[o + 1] < y0) y0 = p[o + 1]; if (p[o + 1] > y1) y1 = p[o + 1];
        if (p[o + 2] < z0) z0 = p[o + 2]; if (p[o + 2] > z1) z1 = p[o + 2];
      }
    }
    if (!Number.isFinite(smallest)) return MIN_SUBSTEPS;
    const particle = Math.max(this.minimumGap, smallest), reach = particle + this.contactMargin;
    let n = MIN_SUBSTEPS;
    for (let c = 0; c < this.types.length; c++) {
      const o = c * COLLIDER_STRIDE, type = this.types[c];
      if (type !== COLLIDER.sphere && type !== COLLIDER.capsule) continue;
      const da = Math.sqrt((colliders[o] - last[o]) ** 2 + (colliders[o + 1] - last[o + 1]) ** 2 + (colliders[o + 2] - last[o + 2]) ** 2);
      const db = Math.sqrt((colliders[o + 3] - last[o + 3]) ** 2 + (colliders[o + 4] - last[o + 4]) ** 2 + (colliders[o + 5] - last[o + 5]) ** 2);
      const move = Math.max(da, db), R = Math.max(colliders[o + 6], colliders[o + 7]);
      // Swept bounds of this collider against the cloth's bounds.
      const pad = R + reach;
      const cx0 = Math.min(colliders[o], colliders[o + 3], last[o], last[o + 3]) - pad;
      const cx1 = Math.max(colliders[o], colliders[o + 3], last[o], last[o + 3]) + pad;
      const cy0 = Math.min(colliders[o + 1], colliders[o + 4], last[o + 1], last[o + 4]) - pad;
      const cy1 = Math.max(colliders[o + 1], colliders[o + 4], last[o + 1], last[o + 4]) + pad;
      const cz0 = Math.min(colliders[o + 2], colliders[o + 5], last[o + 2], last[o + 5]) - pad;
      const cz1 = Math.max(colliders[o + 2], colliders[o + 5], last[o + 2], last[o + 5]) + pad;
      if (cx1 < x0 || cx0 > x1 || cy1 < y0 || cy0 > y1 || cz1 < z0 || cz0 > z1) continue;
      const contact = Math.min(colliders[o + 6], colliders[o + 7]) + particle;
      n = Math.max(n, Math.ceil(move / (.4 * contact)));
    }
    return Math.min(MAX_SUBSTEPS, n);
  }

  /**
   * targets: animated proxy positions; normals: their animated surface normals.
   * radius: per-particle world contact radius.
   */
  step({ targets, normals, colliders, radius, stiffness, damping, gravity, delta, backstop = -1, maxDistance = null }) {
    if (!(delta > 0)) throw new Error("cloth 步长必须为正有限数");
    const n = this.substeps(colliders, radius, targets), h = delta / n;
    this.lastSubsteps = n;
    const retention = Math.pow(1 - damping, 1 / n);
    const x = this.positions, prev = this.previous, v = this.velocity, t = this.targets;
    const t0 = this.lastTargets, fixed = this.fixed, count = this.count;
    const c0 = this.lastColliders, c = this.colliders, cl = colliders.length;
    const gx = gravity[0] * h, gy = gravity[1] * h, gz = gravity[2] * h;
    // Restoration is positional, so heavy damping cannot stall it: a cloth
    // pushed far from its animated shape relaxes back at `stiffness * RESTORE`
    // per second instead of drifting for seconds.
    const pull = 1 - Math.exp(-stiffness * RESTORE * h);
    let maxRadius = 0;
    for (let i = 0; i < count; i++) if (radius[i] > maxRadius) maxRadius = radius[i];
    for (let s = 1; s <= n; s++) {
      const a = s / n, step = 1 / n;
      for (let i = 0, o = 0; i < count; i++, o += 3) {
        const ex = targets[o] - t0[o], ey = targets[o + 1] - t0[o + 1], ez = targets[o + 2] - t0[o + 2];
        const tx = t0[o] + ex * a, ty = t0[o + 1] + ey * a, tz = t0[o + 2] + ez * a;
        t[o] = tx; t[o + 1] = ty; t[o + 2] = tz;
        if (fixed[i]) {
          x[o] = prev[o] = tx; x[o + 1] = prev[o + 1] = ty; x[o + 2] = prev[o + 2] = tz;
          v[o] = v[o + 1] = v[o + 2] = 0;
          continue;
        }
        // Transport with the animated reference; this displacement is not
        // velocity. Then integrate the residual motion.
        const px = x[o] + ex * step, py = x[o + 1] + ey * step, pz = x[o + 2] + ez * step;
        const vx = (v[o] + gx) * retention, vy = (v[o + 1] + gy) * retention, vz = (v[o + 2] + gz) * retention;
        prev[o] = px; prev[o + 1] = py; prev[o + 2] = pz;
        const qx = px + vx * h, qy = py + vy * h, qz = pz + vz * h;
        x[o] = qx + (tx - qx) * pull; x[o + 1] = qy + (ty - qy) * pull; x[o + 2] = qz + (tz - qz) * pull;
      }
      for (let k = 0; k < cl; k++) c[k] = c0[k] + (colliders[k] - c0[k]) * a;
      // Constraints move particles only a little within one substep; a
      // candidate list with some slack replaces per-iteration broadphase.
      this.updateBounds(maxRadius + CONTACT_SLACK + this.contactMargin);
      const pairs = this.contactCandidates();
      restLengths(this.edges, t, this.edgeRest);
      restLengths(this.bends, t, this.bendRest);
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        solveLinks(this.edges, this.edgeRest, x, fixed, STRETCH, COMPRESS);
        // Bending is soft; once per substep is enough and halves link work.
        if (!iteration) solveLinks(this.bends, this.bendRest, x, fixed, BEND, BEND);
        if (maxDistance) limitDistance(x, t, fixed, maxDistance);
        for (let p = 0; p < pairs; p += 2) {
          const i = this.pairs[p];
          this.collideWith(this.pairs[p + 1], x, i * 3, radius[i], t, prev, i * 3);
        }
      }
      if (backstop >= 0 && normals) this.backstop(normals, backstop);
      for (let i = 0, o = 0; i < count; i++, o += 3) {
        if (fixed[i]) continue;
        v[o] = (x[o] - prev[o]) / h; v[o + 1] = (x[o + 1] - prev[o + 1]) / h; v[o + 2] = (x[o + 2] - prev[o + 2]) / h;
      }
    }
    this.lastTargets.set(targets);
    this.lastColliders.set(colliders);
    for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) throw new Error("cloth 求解产生非有限坐标");
  }

  updateBounds(margin) {
    const c = this.colliders, b = this.bounds, types = this.types;
    for (let k = 0; k < types.length; k++) {
      const q = k * COLLIDER_STRIDE, o = k * 6, type = types[k];
      if (type === COLLIDER.plane) {
        b[o] = b[o + 1] = b[o + 2] = -Infinity; b[o + 3] = b[o + 4] = b[o + 5] = Infinity;
      } else if (type === COLLIDER.panel) {
        for (let j = 0; j < 3; j++) {
          const extent = Math.abs(c[q + 7 + j]) + Math.abs(c[q + 10 + j]) + margin;
          b[o + j] = c[q + j] - extent; b[o + 3 + j] = c[q + j] + extent;
        }
      } else {
        const r = Math.max(c[q + 6], c[q + 7]) + margin;
        for (let j = 0; j < 3; j++) {
          b[o + j] = Math.min(c[q + j], c[q + 3 + j]) - r; b[o + 3 + j] = Math.max(c[q + j], c[q + 3 + j]) + r;
        }
      }
    }
  }

  /**
   * Keep a point `r` away from every collider, but never push it farther out
   * than its animated reference `ref` already is (down to the minimum gap).
   * Artist poses resting inside a thick particle radius stay as authored; the
   * cloth just cannot sink deeper than its own animation.
   */
  collidePoint(x, o, r, ref, prev, ro = o, mask = 0xffffffff) {
    const b = this.bounds;
    for (let k = 0; k < this.types.length; k++) {
      if (k < 32 && !(mask & (1 << k))) continue;
      const bo = k * 6;
      if (x[o] < b[bo] || x[o + 1] < b[bo + 1] || x[o + 2] < b[bo + 2]
        || x[o] > b[bo + 3] || x[o + 1] > b[bo + 4] || x[o + 2] > b[bo + 5]) continue;
      this.collideWith(k, x, o, r, ref, prev, ro);
    }
  }

  contactCandidates() {
    const x = this.positions, b = this.bounds, fixed = this.fixed, pairs = this.pairs, near = this.near;
    near.fill(0);
    let n = 0;
    for (let k = 0; k < this.types.length; k++) {
      const bo = k * 6, x0 = b[bo], y0 = b[bo + 1], z0 = b[bo + 2], x1 = b[bo + 3], y1 = b[bo + 4], z1 = b[bo + 5];
      for (let i = 0, o = 0; i < this.count; i++, o += 3) {
        if (fixed[i] || x[o] < x0 || x[o + 1] < y0 || x[o + 2] < z0 || x[o] > x1 || x[o + 1] > y1 || x[o + 2] > z1) continue;
        pairs[n++] = i; pairs[n++] = k; near[i] |= k < 32 ? 1 << k : 0xffffffff;
      }
    }
    return n;
  }

  collideWith(k, x, o, r, ref, prev, ro) {
    const c = this.colliders, types = this.types, gap = this.minimumGap;
    {
      const q = k * COLLIDER_STRIDE, type = types[k];
      if (type === COLLIDER.sphere || type === COLLIDER.capsule) {
        const ax = c[q], ay = c[q + 1], az = c[q + 2], r0 = c[q + 6], dr = c[q + 7] - r0;
        const sx = c[q + 3] - ax, sy = c[q + 4] - ay, sz = c[q + 5] - az;
        const ss = sx * sx + sy * sy + sz * sz;
        // Tapered capsule = envelope of spheres whose radius varies linearly
        // along the axis (a round cone). The touching sphere sits further
        // towards the thick end than the plain projection; with slope s it is
        // shifted by s * radial / sqrt(1 - s^2) along the axis.
        const slope2 = ss > 0 ? dr * dr / ss : 0;
        const shift = slope2 < .99 ? dr / Math.sqrt(1 - slope2) : 0;
        const u = touchParameter(x[o], x[o + 1], x[o + 2], ax, ay, az, sx, sy, sz, ss, shift);
        const R = r0 + dr * u;
        const qx = ax + sx * u, qy = ay + sy * u, qz = az + sz * u;
        let dx = x[o] - qx, dy = x[o + 1] - qy, dz = x[o + 2] - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        let limit = R + r;
        if (d2 >= limit * limit) return;
        const ut = touchParameter(ref[ro], ref[ro + 1], ref[ro + 2], ax, ay, az, sx, sy, sz, ss, shift);
        const rx = ref[ro] - ax - sx * ut, ry = ref[ro + 1] - ay - sy * ut, rz = ref[ro + 2] - az - sz * ut;
        // Reference clearance from its own touching sphere.
        const reference = Math.sqrt(rx * rx + ry * ry + rz * rz) - dr * ut + dr * u;
        if (reference < limit) limit = reference > R + gap ? reference : R + gap;
        if (d2 >= limit * limit) return;
        let d = Math.sqrt(d2);
        if (d < 1e-9) {
          // Exactly on the axis: leave towards the side it came from.
          if (prev) { dx = prev[ro] - qx; dy = prev[ro + 1] - qy; dz = prev[ro + 2] - qz; d = Math.sqrt(dx * dx + dy * dy + dz * dz); }
          if (d < 1e-9) { dx = rx; dy = ry; dz = rz; d = Math.sqrt(rx * rx + ry * ry + rz * rz); }
          if (d < 1e-9) { dx = 0; dy = 1; dz = 0; d = 1; }
        }
        const scale = limit / d;
        x[o] = qx + dx * scale; x[o + 1] = qy + dy * scale; x[o + 2] = qz + dz * scale;
      } else if (type === COLLIDER.plane) {
        const nx = c[q + 7], ny = c[q + 8], nz = c[q + 9];
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        const w = ((x[o] - c[q]) * nx + (x[o + 1] - c[q + 1]) * ny + (x[o + 2] - c[q + 2]) * nz) / l;
        if (w >= r) return;
        const wt = ((ref[ro] - c[q]) * nx + (ref[ro + 1] - c[q + 1]) * ny + (ref[ro + 2] - c[q + 2]) * nz) / l;
        const limit = wt < r ? (wt > gap ? wt : gap) : r;
        if (w >= limit) return;
        const push = (limit - w) / l;
        x[o] += nx * push; x[o + 1] += ny * push; x[o + 2] += nz * push;
      } else this.collidePanel(x, o, q, r, prev, ro);
    }
  }

  collidePanel(x, o, q, r, prev, ro) {
    const c = this.colliders;
    const ux = c[q + 7], uy = c[q + 8], uz = c[q + 9], vx = c[q + 10], vy = c[q + 11], vz = c[q + 12];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-20) return;
    nx /= nl; ny /= nl; nz /= nl;
    const px = x[o] - c[q], py = x[o + 1] - c[q + 1], pz = x[o + 2] - c[q + 2];
    const uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz;
    const pu = px * ux + py * uy + pz * uz, pv = px * vx + py * vy + pz * vz;
    const det = uu * vv - uv * uv;
    let s = (pu * vv - pv * uv) / det, tt = (pv * uu - pu * uv) / det;
    const w = px * nx + py * ny + pz * nz;
    if (s >= -1 && s <= 1 && tt >= -1 && tt <= 1) {
      if (w >= r) return;
      // One-sided: contact from the front or a thin backside band; points
      // that were already deep behind the panel are not dragged through it.
      if (w < -r) {
        if (!prev) return;
        const side = (prev[ro] - c[q]) * nx + (prev[ro + 1] - c[q + 1]) * ny + (prev[ro + 2] - c[q + 2]) * nz;
        if (side < 0) return;
      }
      const push = r - w;
      x[o] += nx * push; x[o + 1] += ny * push; x[o + 2] += nz * push;
      return;
    }
    s = s < -1 ? -1 : s > 1 ? 1 : s; tt = tt < -1 ? -1 : tt > 1 ? 1 : tt;
    const qx = c[q] + ux * s + vx * tt, qy = c[q + 1] + uy * s + vy * tt, qz = c[q + 2] + uz * s + vz * tt;
    const dx = x[o] - qx, dy = x[o + 1] - qy, dz = x[o + 2] - qz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= r || d < 1e-12) return;
    const scale = r / d;
    x[o] = qx + dx * scale; x[o + 1] = qy + dy * scale; x[o + 2] = qz + dz * scale;
  }

  /** Keep particles from folding behind their animated surface. */
  backstop(normals, distance) {
    const x = this.positions, t = this.targets, fixed = this.fixed;
    for (let i = 0, o = 0; i < this.count; i++, o += 3) {
      if (fixed[i]) continue;
      const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
      const d = (x[o] - t[o]) * nx + (x[o + 1] - t[o + 1]) * ny + (x[o + 2] - t[o + 2]) * nz;
      if (d >= -distance) continue;
      const push = -distance - d;
      x[o] += nx * push; x[o + 1] += ny * push; x[o + 2] += nz * push;
    }
  }
}

/** Axis parameter of the sphere of a (tapered) capsule that a point touches. */
function touchParameter(px, py, pz, ax, ay, az, sx, sy, sz, ss, shift) {
  if (!(ss > 0)) return 0;
  const t = ((px - ax) * sx + (py - ay) * sy + (pz - az) * sz) / ss;
  let u = t;
  if (shift) {
    const ex = px - ax - sx * t, ey = py - ay - sy * t, ez = pz - az - sz * t;
    u += shift * Math.sqrt(ex * ex + ey * ey + ez * ez) / ss;
  }
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

/** Motion constraint: a particle stays within its distance of the animation. */
function limitDistance(x, t, fixed, limit) {
  for (let i = 0, o = 0; i < limit.length; i++, o += 3) {
    if (fixed[i]) continue;
    const dx = x[o] - t[o], dy = x[o + 1] - t[o + 1], dz = x[o + 2] - t[o + 2];
    const d2 = dx * dx + dy * dy + dz * dz, l = limit[i];
    if (d2 <= l * l) continue;
    const k = l / Math.sqrt(d2);
    x[o] = t[o] + dx * k; x[o + 1] = t[o + 1] + dy * k; x[o + 2] = t[o + 2] + dz * k;
  }
}

function restLengths(links, t, out) {
  for (let e = 0, l = 0; e < links.length; e += 2, l++) {
    const a = links[e] * 3, b = links[e + 1] * 3;
    const dx = t[b] - t[a], dy = t[b + 1] - t[a + 1], dz = t[b + 2] - t[a + 2];
    out[l] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

function solveLinks(links, rest, x, fixed, stretch, compress) {
  for (let e = 0, l = 0; e < links.length; e += 2, l++) {
    const i = links[e], j = links[e + 1];
    const wi = fixed[i] ? 0 : 1, wj = fixed[j] ? 0 : 1, w = wi + wj;
    if (!w) continue;
    const a = i * 3, b = j * 3;
    const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-12) continue;
    const error = length - rest[l];
    const k = (error > 0 ? stretch : compress) * error / (length * w);
    x[a] += wi * k * dx; x[a + 1] += wi * k * dy; x[a + 2] += wi * k * dz;
    x[b] -= wj * k * dx; x[b + 1] -= wj * k * dy; x[b + 2] -= wj * k * dz;
  }
}

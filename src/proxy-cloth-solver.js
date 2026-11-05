import { rotateVector } from "./proxy-rotation.js";
import { BODY_REACH } from "./body-surface.js";

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
// Limbs thinner than this (shins, feet, arms) can slip between two particles;
// their contacts also test the edges in between.
const EDGE_RADIUS = .065;
// limbSegment bits of the two legs.
const LEG_SEGMENTS = 1 << 1 | 1 << 2;

/** Body segment of a humanoid bone: 0 trunk and head, 1/2 left/right leg, 3/4 left/right arm. */
export function limbSegment(name) {
  const leg = /UpperLeg|LowerLeg|Foot|Toes/.test(name);
  const arm = !leg && /Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little/.test(name);
  if (!leg && !arm) return 0;
  return (leg ? 1 : 3) + (name.startsWith("Right") ? 1 : 0);
}

// Colliders whose limb is known: edge contact only for the distal limbs that
// swing into cloth from outside (shins, feet, forearms, hands). Thighs, hips
// and upper arms meet the cloth at its waist or sleeve, where a deep bend
// pinches it in the crease and edge contact would only tear it.
export function edgeContactLimb(name) {
  return /LowerLeg|Foot|Toes|LowerArm|Hand/.test(name);
}

export class ProxyClothSolver {
  constructor({ count, edges, bends, fixed, colliderTypes, minimumGap = 0, contactMargin = 0, probes = null, rotations = null, edgeColliders = null, colliderLimbs = null }) {
    // Probes: surface points embedded in up to four particles (CSR by the
    // particle that owns them). Their animated positions (`probeAnchor`) are
    // set per step by the owner; probes collide with the minimum gap.
    this.probeStart = probes?.start ?? new Uint32Array(count + 1);
    this.probeIndex = probes?.index ?? new Int32Array(0);
    this.probeWeight = probes?.weight ?? new Float64Array(0);
    this.probeAnchor = new Float64Array(this.probeStart[count] * 3);
    this.probePoint = new Float64Array(3);
    this.probeReference = new Float64Array(3);
    // Optional ProxyRotations: probes then turn their offset with the cloth,
    // exactly as the owner places the drawn vertices.
    this.rotations = rotations;
    // Set when the last step resolved its probes with `rotations`; the owner
    // then draws with exactly those rotations instead of re-estimating them.
    this.rotationsCurrent = false;
    this.clearanceGap = (reference, r) => clearance(reference, r, this.minimumGap);
    this.probeRotation = new Float64Array(4);
    this.probeOffset = new Float64Array(3);
    // Extra broadphase reach for points that follow a particle from a distance.
    this.contactMargin = contactMargin;
    this.count = count;
    this.edges = edges; this.bends = bends;
    // Edges by particle, so contacts can test the edges around a particle:
    // a thin limb must not slip between two particles.
    const degree = new Uint32Array(count + 1);
    for (let e = 0; e < edges.length; e++) degree[edges[e] + 1]++;
    for (let i = 0; i < count; i++) degree[i + 1] += degree[i];
    const incident = new Uint32Array(edges.length), fill = degree.slice(0, count);
    for (let e = 0; e < edges.length; e += 2) { incident[fill[edges[e]]++] = e; incident[fill[edges[e + 1]]++] = e; }
    this.edgeStart = degree; this.incidentEdges = incident;
    this.edgeStamp = new Float64Array(edges.length / 2);
    this.edgeDistance = new Float64Array(count);
    this.edgeHalf = 0;
    // Longest incident edge per particle (with stretch), per step.
    this.edgeReach = new Float64Array(count);
    this.maxRadius = 0;
    this.edgeDistanceMark = new Float64Array(count).fill(-1);
    this.edgeMark = 0;
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
    this.edgePairs = new Uint32Array(Math.max(2, count * this.types.length * 2));
    this.edgePairCount = 0;
    // Per collider: 1 edge contact, 0 none, -1 unknown limb (decide by radius).
    this.edgeColliders = edgeColliders ?? new Int8Array(this.types.length).fill(-1);
    const K = this.types.length;
    // Per collider: body segment (limbSegment), -1 unknown; per particle: the
    // segments whose colliders hold its reference (bit mask, this substep).
    this.colliderLimbs = colliderLimbs ?? new Int8Array(K).fill(-1);
    this.pinchMask = new Uint8Array(count);
    // Per particle and round cone: the side its reference entered from
    // (unit vector), valid while `entryStamp` holds the current substep.
    this.entrySide = new Float32Array(count * K * 3);
    this.entryStamp = new Uint32Array(count * K);
    this.substepCount = 1;
    // Per cone: last substep's unit axis, and the turn from it to this one's.
    this.axisLast = new Float64Array(K * 3);
    this.axisTurn = new Float64Array(K * 4);

    this.lastSubsteps = 0;
    this.closedSegments = 0;
  }

  reset(targets, colliders) {
    this.positions.set(targets); this.previous.set(targets);
    this.lastTargets.set(targets); this.targets.set(targets);
    this.velocity.fill(0);
    this.lastColliders.set(colliders);
    this.colliders.set(colliders);
    this.markAuthoredEdges(targets, colliders);
    this.entryStamp.fill(0);
    this.axisLast.fill(0);
  }

  /** Whether edges collide with round cone k (pose data c). */
  edgeContact(k, c) {
    const flag = this.edgeColliders[k];
    if (flag >= 0) return flag === 1;
    const q = k * COLLIDER_STRIDE;
    return Math.max(c[q + 6], c[q + 7]) < EDGE_RADIUS;
  }

  /**
   * Edges that already touch or cross a thin limb in the starting pose (a belt
   * pendant draped over the hips, a chord of the proxy mesh running through
   * a thigh) are authored that way: edge contact leaves those pairs alone.
   * Every other edge keeps the limb on one side of it.
   */
  markAuthoredEdges(targets, colliders) {
    const types = this.types, K = types.length, edges = this.edges, gap = this.minimumGap;
    const flags = this.edgeAuthored = new Uint8Array((edges.length / 2) * K);
    for (let k = 0; k < K; k++) {
      if (types[k] !== COLLIDER.sphere && types[k] !== COLLIDER.capsule) continue;
      const q = k * COLLIDER_STRIDE;
      if (!this.edgeContact(k, colliders)) continue;
      const ax = colliders[q], ay = colliders[q + 1], az = colliders[q + 2];
      const sx = colliders[q + 3] - ax, sy = colliders[q + 4] - ay, sz = colliders[q + 5] - az;
      const ss = sx * sx + sy * sy + sz * sz, r0 = colliders[q + 6], dr = colliders[q + 7] - r0;
      const slope2 = ss > 0 ? dr * dr / ss : 0, shift = slope2 < .99 ? dr / Math.sqrt(1 - slope2) : 0;
      for (let e = 0; e < edges.length; e += 2) {
        const a = edges[e] * 3, b = edges[e + 1] * 3;
        for (let s = 0; s <= 8; s++) {
          const f = s / 8, px = targets[a] + (targets[b] - targets[a]) * f;
          const py = targets[a + 1] + (targets[b + 1] - targets[a + 1]) * f, pz = targets[a + 2] + (targets[b + 2] - targets[a + 2]) * f;
          const u = touchParameter(px, py, pz, ax, ay, az, sx, sy, sz, ss, shift);
          const d = Math.hypot(px - ax - sx * u, py - ay - sy * u, pz - az - sz * u) - (r0 + dr * u);
          if (d < 2 * gap) { flags[(e / 2) * K + k] = 1; break; }
        }
      }
    }
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
  /**
   * closedSegments: limbSegment bits of the legs folded up against the trunk
   * this step (see updateEntrySides).
   */
  step({ targets, normals, colliders, radius, stiffness, damping, gravity, delta, backstop = -1, maxDistance = null, body = null, closedSegments = 0 }) {
    this.closedSegments = closedSegments;
    if (!(delta > 0)) throw new Error("cloth 步长必须为正有限数");
    const n = this.substeps(colliders, radius, targets), h = delta / n;
    this.rotationsCurrent = false;
    this.frameTargets = targets;
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
    this.maxRadius = maxRadius;
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
      // A body surface reaches a little past its colliders (BODY_REACH).
      this.updateBounds(maxRadius + CONTACT_SLACK + this.contactMargin + (body ? BODY_REACH : 0));
      const pairs = this.contactCandidates();
      this.updateEntrySides(pairs);
      restLengths(this.edges, t, this.edgeRest);
      if (s === 1) {
        let longest = 0;
        for (let e = 0; e < this.edgeRest.length; e++) if (this.edgeRest[e] > longest) longest = this.edgeRest[e];
        // Half the longest edge, with some stretch.
        this.edgeHalf = longest * .6;
        const reach = this.edgeReach;
        reach.fill(0);
        for (let e = 0; e < this.edges.length; e += 2) {
          const l = this.edgeRest[e / 2] * 1.2, a = this.edges[e], b = this.edges[e + 1];
          if (l > reach[a]) reach[a] = l;
          if (l > reach[b]) reach[b] = l;
        }
      }
      restLengths(this.bends, t, this.bendRest);
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        solveLinks(this.edges, this.edgeRest, x, fixed, STRETCH, COMPRESS);
        // Bending is soft; once per substep is enough and halves link work.
        if (!iteration) solveLinks(this.bends, this.bendRest, x, fixed, BEND, BEND);
        if (maxDistance) limitDistance(x, t, fixed, maxDistance);
        // Collisions come last so they have the final word: where a limb
        // meets the body (a raised thigh against the hips) the backstop must
        // not drag cloth back into either.
        if (backstop >= 0 && normals) this.backstop(normals, backstop);
        // Probes only shape the drawn surface: resolving them once, at the end
        // of the step, keeps it clear without paying for them every substep.
        const probes = s === n && iteration === ITERATIONS - 1;
        if (probes && pairs && this.rotations && normals) {
          this.rotations.update(x, targets, 2);
          this.rotationsCurrent = true;
        }
        // The exact body surface (end-of-step pose) once per step, before the
        // capsules, which keep the final word where a limb meets the body.
        if (probes && pairs) this.indexPairs(pairs, radius, t, body);
        for (let p = 0; p < pairs; p += 2) {
          const i = this.pairs[p], k = this.pairs[p + 1];
          this.collideWith(k, x, i * 3, radius[i], t, prev, i * 3, this.entry(i, k), this.pinched(i));
        }
        if (this.edgePairCount && iteration === ITERATIONS - 1) this.collideEdges(this.edgePairCount, radius, t);
        if (probes && pairs) this.probePass(radius, t, body);
      }
      for (let i = 0, o = 0; i < count; i++, o += 3) {
        if (fixed[i]) continue;
        v[o] = (x[o] - prev[o]) / h; v[o + 1] = (x[o + 1] - prev[o + 1]) / h; v[o + 2] = (x[o + 2] - prev[o + 2]) / h;
      }
    }
    this.lastTargets.set(targets);
    this.lastColliders.set(colliders);
    for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) throw new Error("cloth 求解产生非有限坐标");
  }

  /**
   * Collider candidates by particle (CSR) for the probe pass; particles with
   * a candidate also meet the body surface here. It is only skinned around
   * the colliders, so particles without a candidate are not near it.
   */
  indexPairs(pairs, radius, t, body) {
    const count = this.count, list = this.pairs, x = this.positions;
    const start = this.pairStart ??= new Uint32Array(count + 1), byParticle = this.pairColliders ??= new Uint32Array(list.length);
    start.fill(0);
    for (let p = 0; p < pairs; p += 2) start[list[p] + 1]++;
    for (let i = 0; i < count; i++) start[i + 1] += start[i];
    const fill = this.pairFill ??= new Uint32Array(count);
    fill.set(start.subarray(0, count));
    for (let p = 0; p < pairs; p += 2) byParticle[fill[list[p]]++] = list[p + 1];
    if (!body) return;
    for (let i = 0; i < count; i++) if (start[i + 1] > start[i]) body.collide(x, i * 3, radius[i], t, i * 3, this.clearanceGap);
  }

  /**
   * Last word on the drawn surface, once per step, for particles near a
   * collider. A probe sits where its render vertex will be drawn:
   * sum_j w_j x_j + R (anchor - sum_j w_j T_j), R the blended rotation of those
   * particles (identity without rotations); the targets equal T here (last
   * substep). Each probe is placed once, resolved against the body surface
   * and then its particle's colliders, and the resulting push is shared by
   * the moving particles it is embedded in (minimum-norm split), so the
   * blended surface itself clears them.
   */
  probePass(radius, t, body) {
    const count = this.count, fixed = this.fixed, x = this.positions;
    const start = this.pairStart, byParticle = this.pairColliders;
    const T = this.frameTargets, rotations = this.rotations, gap = this.minimumGap;
    const anchor = this.probeAnchor, index = this.probeIndex, weight = this.probeWeight, probeStart = this.probeStart;
    const point = this.probePoint, ref = this.probeReference, q = this.probeRotation, d = this.probeOffset;
    for (let i = 0; i < count; i++) {
      const c0 = start[i], c1 = start[i + 1];
      if (c0 === c1 || fixed[i]) continue;
      for (let p = probeStart[i]; p < probeStart[i + 1]; p++) {
        let px = 0, py = 0, pz = 0, tx = 0, ty = 0, tz = 0, norm = 0;
        for (let j = p * 4; j < p * 4 + 4; j++) {
          const c = index[j];
          if (c < 0) break;
          const w = weight[j], o = c * 3;
          px += w * x[o]; py += w * x[o + 1]; pz += w * x[o + 2];
          tx += w * T[o]; ty += w * T[o + 1]; tz += w * T[o + 2];
          if (!fixed[c]) norm += w * w;
        }
        if (!norm) continue;
        const rx = anchor[p * 3], ry = anchor[p * 3 + 1], rz = anchor[p * 3 + 2];
        d[0] = rx - tx; d[1] = ry - ty; d[2] = rz - tz;
        if (rotations) rotateVector(rotations.blend(index, weight, p * 4, q), d[0], d[1], d[2], d);
        px += d[0]; py += d[1]; pz += d[2];
        point[0] = px; point[1] = py; point[2] = pz; ref[0] = rx; ref[1] = ry; ref[2] = rz;
        if (body) body.collide(point, 0, gap, ref, 0, this.clearanceGap);
        const pinch = this.pinched(i);
        for (let c = c0; c < c1; c++) this.collideWith(byParticle[c], point, 0, gap, ref, null, 0, this.entry(i, byParticle[c]), pinch);
        const dx = point[0] - px, dy = point[1] - py, dz = point[2] - pz;
        if (!dx && !dy && !dz) continue;
        for (let j = p * 4; j < p * 4 + 4; j++) {
          const c = index[j];
          if (c < 0) break;
          if (fixed[c]) continue;
          const s = weight[j] / norm, o = c * 3;
          x[o] += dx * s; x[o + 1] += dy * s; x[o + 2] += dz * s;
        }
      }
    }
  }

  /**
   * Edges around each candidate particle against its thin round-cone
   * colliders, once per edge and collider. Distance to a cone changes by at
   * most 1 per unit along an edge, so an edge of length L whose ends are d_a
   * and d_b from the surface stays at least (d_a + d_b - L) / 2 away: only
   * edges with d_a + d_b < L + 2r get the exact test.
   */
  collideEdges(pairs, radius, t) {
    const list = this.edgePairs, start = this.edgeStart, incident = this.incidentEdges, stamp = this.edgeStamp, types = this.types;
    const c = this.colliders, x = this.positions, edges = this.edges, cache = this.edgeDistance, cached = this.edgeDistanceMark, reach = this.edgeReach;
    let mark = this.edgeMark, last = -1;
    for (let p = 0; p < pairs; p += 2) {
      const i = list[p], k = list[p + 1], q = k * COLLIDER_STRIDE;
      if (k !== last) { mark++; last = k; }
      const di = coneDistance(x, i * 3, c, q, cache, cached, i, mark);
      // No edge of i reaches the cone (d_j >= 0, L <= i's longest edge).
      if (di >= reach[i] + 2 * this.maxRadius) continue;
      for (let r = start[i]; r < start[i + 1]; r++) {
        const e = incident[r];
        if (stamp[e / 2] === mark) continue;
        stamp[e / 2] = mark;
        const j = edges[e] === i ? edges[e + 1] : edges[e];
        const dj = coneDistance(x, j * 3, c, q, cache, cached, j, mark);
        const ex = x[i * 3] - x[j * 3], ey = x[i * 3 + 1] - x[j * 3 + 1], ez = x[i * 3 + 2] - x[j * 3 + 2];
        const reach = Math.sqrt(ex * ex + ey * ey + ez * ez) + 2 * Math.max(radius[i], radius[j]);
        if (di + dj >= reach) continue;
        this.collideEdge(k, e, radius, t);
      }
    }
    this.edgeMark = mark;
  }

  /**
   * Keep the interior of edge e (particles a, b) out of round cone k: the
   * closest point of the edge to the cone axis is pushed out like a particle,
   * the push split between a and b so that point moves by exactly it.
   */
  collideEdge(k, e, radius, t) {
    const x = this.positions, c = this.colliders, fixed = this.fixed, q = k * COLLIDER_STRIDE;
    const a = this.edges[e], b = this.edges[e + 1];
    if (fixed[a] && fixed[b]) return;
    if (this.edgeAuthored?.[(e / 2) * this.types.length + k]) return;
    const oa = a * 3, ob = b * 3;
    const ax = c[q], ay = c[q + 1], az = c[q + 2], sx = c[q + 3] - ax, sy = c[q + 4] - ay, sz = c[q + 5] - az;
    const r0 = c[q + 6], dr = c[q + 7] - r0, ss = sx * sx + sy * sy + sz * sz;
    const dx = x[ob] - x[oa], dy = x[ob + 1] - x[oa + 1], dz = x[ob + 2] - x[oa + 2];
    const wx = x[oa] - ax, wy = x[oa + 1] - ay, wz = x[oa + 2] - az;
    const dd = dx * dx + dy * dy + dz * dz;
    if (!(dd > 1e-14)) return;
    // Closest points between the edge and the axis segment (Ericson 5.1.9).
    const ds = dx * sx + dy * sy + dz * sz, dw = dx * wx + dy * wy + dz * wz, sw = sx * wx + sy * wy + sz * wz;
    let f;
    if (ss > 1e-14) {
      const denom = dd * ss - ds * ds;
      f = denom > 1e-14 ? Math.min(1, Math.max(0, (ds * sw - dw * ss) / denom)) : 0;
      const u = (ds * f + sw) / ss;
      if (u < 0) f = Math.min(1, Math.max(0, -dw / dd));
      else if (u > 1) f = Math.min(1, Math.max(0, (ds - dw) / dd));
    } else f = Math.min(1, Math.max(0, -dw / dd));
    // Near an end the particle contact already covers it.
    if (f < .05 || f > .95) return;
    const g = 1 - f;
    const px = x[oa] * g + x[ob] * f, py = x[oa + 1] * g + x[ob + 1] * f, pz = x[oa + 2] * g + x[ob + 2] * f;
    const slope2 = ss > 0 ? dr * dr / ss : 0;
    const shift = slope2 < .99 ? dr / Math.sqrt(1 - slope2) : 0;
    const u = touchParameter(px, py, pz, ax, ay, az, sx, sy, sz, ss, shift);
    const R = r0 + dr * u, qx = ax + sx * u, qy = ay + sy * u, qz = az + sz * u;
    let nx = px - qx, ny = py - qy, nz = pz - qz;
    // An edge only has to keep the limb from passing between its particles:
    // it keeps the cloth's own gap, not the particles' contact radius (which
    // includes the thickness of everything merged into them).
    const d2 = nx * nx + ny * ny + nz * nz, limit = R + this.minimumGap;
    if (d2 >= limit * limit) return;
    let d = Math.sqrt(d2);
    // A limb threading between particles arrives gradually (substeps keep its
    // step small), so the edge meets it shallow. An edge already deep in a
    // limb got there with its animation (a skirt bent through the thighs);
    // dragging it out would tear the cloth against the particle contacts.
    if (limit - d > .5 * R) return;
    if (d < 1e-9) {
      // On the axis: leave towards the animated edge point.
      nx = t[oa] * g + t[ob] * f - qx; ny = t[oa + 1] * g + t[ob + 1] * f - qy; nz = t[oa + 2] * g + t[ob + 2] * f - qz;
      d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    }
    if (d < 1e-9) return;
    // Move the edge point to the cone surface (plus clearance) on that side.
    const scale = limit / d;
    const mx = qx + nx * scale - px, my = qy + ny * scale - py, mz = qz + nz * scale - pz;
    const wa = fixed[a] ? 0 : g, wb = fixed[b] ? 0 : f, norm = wa * wa + wb * wb;
    const ka = wa / norm, kb = wb / norm;
    x[oa] += mx * ka; x[oa + 1] += my * ka; x[oa + 2] += mz * ka;
    x[ob] += mx * kb; x[ob + 1] += my * kb; x[ob + 2] += mz * kb;
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
   * Particle/collider pairs inside each collider's bounds (`pairs`, returns
   * their length) and, for thin limbs, the particles within half an edge
   * more whose edges may thread them (`edgePairs`, length in edgePairCount).
   */
  contactCandidates() {
    const x = this.positions, b = this.bounds, fixed = this.fixed, pairs = this.pairs, edgePairs = this.edgePairs, c = this.colliders;
    let n = 0, m = 0;
    for (let k = 0; k < this.types.length; k++) {
      const bo = k * 6, x0 = b[bo], y0 = b[bo + 1], z0 = b[bo + 2], x1 = b[bo + 3], y1 = b[bo + 4], z1 = b[bo + 5];
      const type = this.types[k], q = k * COLLIDER_STRIDE;
      const pad = (type === COLLIDER.sphere || type === COLLIDER.capsule) && this.edgeContact(k, c) ? this.edgeHalf : -1;
      for (let i = 0, o = 0; i < this.count; i++, o += 3) {
        if (fixed[i]) continue;
        const px = x[o], py = x[o + 1], pz = x[o + 2];
        if (px >= x0 && py >= y0 && pz >= z0 && px <= x1 && py <= y1 && pz <= z1) { pairs[n++] = i; pairs[n++] = k; }
        if (pad >= 0 && px >= x0 - pad && py >= y0 - pad && pz >= z0 - pad && px <= x1 + pad && py <= y1 + pad && pz <= z1 + pad) {
          edgePairs[m++] = i; edgePairs[m++] = k;
        }
      }
    }
    this.edgePairCount = m;
    return n;
  }

  /**
   * In a closed crease (a thigh folded up against the belly, see
   * `closedSegments`) the front of a skirt is squeezed back and forth between
   * the two; pushed out wherever it has drifted to, it slides round the
   * thigh and comes out behind it, where nothing pushes it back. So per
   * particle and round cone this keeps the side the particle's reference
   * entered from, while the reference stays inside, turned with the cone's
   * axis. While a crease is closed, a particle may leave anywhere on that half
   * and is sent straight out of that side if it got round; one whose
   * reference lies in the colliders of two body segments, one of them a
   * folded leg, leaves on its reference's own side, back into the crease
   * (`pinchMask`). With the creases open (a kick, however high) contact is
   * left as it is: a fast limb meets cloth that lags on its far side, and
   * sending that cloth to the reference's side would pull it through.
   */
  updateEntrySides(pairs) {
    const K = this.types.length, types = this.types, c = this.colliders, t = this.targets, list = this.pairs, fixed = this.fixed;
    const side = this.entrySide, stamp = this.entryStamp, axis = this.axisLast, turn = this.axisTurn;
    const limbs = this.colliderLimbs, mask = this.pinchMask;
    const now = ++this.substepCount;
    mask.fill(0);
    for (let k = 0; k < K; k++) {
      const q = k * COLLIDER_STRIDE, a = k * 3, w = k * 4;
      turn[w] = turn[w + 1] = turn[w + 2] = 0; turn[w + 3] = 1;
      if (types[k] !== COLLIDER.capsule) continue;
      let sx = c[q + 3] - c[q], sy = c[q + 4] - c[q + 1], sz = c[q + 5] - c[q + 2];
      const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (l < 1e-9) continue;
      sx /= l; sy /= l; sz /= l;
      const px = axis[a], py = axis[a + 1], pz = axis[a + 2], dot = px * sx + py * sy + pz * sz;
      axis[a] = sx; axis[a + 1] = sy; axis[a + 2] = sz;
      if (!(px || py || pz) || dot < -.999) continue;
      // Shortest arc from the last axis to this one.
      const qx = py * sz - pz * sy, qy = pz * sx - px * sz, qz = px * sy - py * sx, qw = 1 + dot;
      const n = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      turn[w] = qx / n; turn[w + 1] = qy / n; turn[w + 2] = qz / n; turn[w + 3] = qw / n;
    }
    for (let p = 0; p < pairs; p += 2) {
      const i = list[p], k = list[p + 1];
      if (fixed[i] || (types[k] !== COLLIDER.sphere && types[k] !== COLLIDER.capsule)) continue;
      const q = k * COLLIDER_STRIDE, o = i * 3, e = i * K + k, f = e * 3;
      const ax = c[q], ay = c[q + 1], az = c[q + 2], r0 = c[q + 6], dr = c[q + 7] - r0;
      const sx = c[q + 3] - ax, sy = c[q + 4] - ay, sz = c[q + 5] - az, ss = sx * sx + sy * sy + sz * sz;
      const slope2 = ss > 0 ? dr * dr / ss : 0, shift = slope2 < .99 ? dr / Math.sqrt(1 - slope2) : 0;
      const u = touchParameter(t[o], t[o + 1], t[o + 2], ax, ay, az, sx, sy, sz, ss, shift), R = r0 + dr * u;
      const dx = t[o] - ax - sx * u, dy = t[o + 1] - ay - sy * u, dz = t[o + 2] - az - sz * u;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= R * R) { stamp[e] = 0; continue; }
      if (limbs[k] >= 0) mask[i] |= 1 << limbs[k];
      if (stamp[e] === now - 1) {
        const w = k * 4, qx = turn[w], qy = turn[w + 1], qz = turn[w + 2], qw = turn[w + 3];
        const vx = side[f], vy = side[f + 1], vz = side[f + 2];
        const cx = qy * vz - qz * vy, cy = qz * vx - qx * vz, cz = qx * vy - qy * vx;
        side[f] = vx + 2 * (qw * cx + qy * cz - qz * cy);
        side[f + 1] = vy + 2 * (qw * cy + qz * cx - qx * cz);
        side[f + 2] = vz + 2 * (qw * cz + qx * cy - qy * cx);
      } else {
        const d = Math.sqrt(d2);
        if (d < 1e-9) { stamp[e] = 0; continue; }
        side[f] = dx / d; side[f + 1] = dy / d; side[f + 2] = dz / d;
      }
      stamp[e] = now;
    }
  }

  /** Whether particle i's reference lies in the colliders of two body segments, one a folded leg. */
  pinched(i) {
    const m = this.pinchMask[i];
    return (m & (m - 1)) !== 0 && (m & this.closedSegments & LEG_SEGMENTS) !== 0;
  }

  /** Entry record of particle i in cone k for this substep, or -1. */
  entry(i, k) {
    const e = i * this.types.length + k;
    return this.entryStamp[e] === this.substepCount ? e : -1;
  }

  /**
   * Keep point `o` of `x` a distance `r` away from collider k. Where its
   * animated reference (`ro` in `ref`) is closer than `r` but clear of the
   * body, it stays as authored; see `clearance` for references that sink in.
   */
  collideWith(k, x, o, r, ref, prev, ro, entry = -1, pinch = false) {
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
        if (reference < limit) limit = R + clearance(reference - R, r, gap);
        if (d2 >= limit * limit) return;
        let d = Math.sqrt(d2);
        if (entry >= 0 && reference < R) {
          // The animated cloth sank in (see updateEntrySides).
          const side = this.entrySide, f = entry * 3, ex = side[f], ey = side[f + 1], ez = side[f + 2];
          const rd = Math.sqrt(rx * rx + ry * ry + rz * rz);
          if (pinch && rd > 1e-9) { dx = rx; dy = ry; dz = rz; d = rd; }
          else if (this.closedSegments && !(dx * ex + dy * ey + dz * ez > 0)) { dx = ex; dy = ey; dz = ez; d = Math.sqrt(ex * ex + ey * ey + ez * ez); }
        }
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
        const limit = wt < r ? clearance(wt, r, gap) : r;
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

/**
 * Required clearance from a collider surface, given the animated reference's
 * own clearance `reference`. A reference between the gap and the full radius
 * `r` is kept as authored (no puffing at rest). A reference that already sinks
 * into the collider means the animation itself clips: push out towards the full
 * radius, so the layers behind the particle clear the body too. The ramp keeps
 * the limit continuous as the animation moves through the surface.
 */
function clearance(reference, r, gap) {
  if (reference >= gap) return reference < r ? reference : r;
  const depth = (gap - reference) / Math.max(r, 1e-9);
  return depth >= 1 ? r : gap + (r - gap) * depth;
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

/** Distance from particle point x[o..] to the surface of cone q (axis projection), cached per mark. */
function coneDistance(x, o, c, q, cache, cached, i, mark) {
  if (cached[i] === mark) return cache[i];
  const ax = c[q], ay = c[q + 1], az = c[q + 2], sx = c[q + 3] - ax, sy = c[q + 4] - ay, sz = c[q + 5] - az;
  const ss = sx * sx + sy * sy + sz * sz;
  let u = ss > 0 ? ((x[o] - ax) * sx + (x[o + 1] - ay) * sy + (x[o + 2] - az) * sz) / ss : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ex = x[o] - ax - sx * u, ey = x[o + 1] - ay - sy * u, ez = x[o + 2] - az - sz * u;
  // The axis-projection radius over-estimates the round cone's distance by
  // little for these gentle tapers; the margin below absorbs it.
  const d = Math.sqrt(ex * ex + ey * ey + ez * ez) - Math.max(c[q + 6], c[q + 7]);
  cached[i] = mark; cache[i] = d;
  return d;
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

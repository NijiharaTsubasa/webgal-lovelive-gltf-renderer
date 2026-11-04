/**
 * Per-proxy rotation from the animated to the simulated cloth surface.
 * Render vertices and solver probes sit at the blended proxy position plus
 * their animated offset from the blended proxy targets, turned by the blended
 * rotation of those proxies. Pleat depth and lining gaps therefore keep their
 * orientation relative to the cloth when it swings away from the animation.
 */
// Below SPREAD_MIN the animated neighbourhood is a line: no rotation. Above
// SPREAD_FULL it is a usable frame: full rotation. Linear in between.
const SPREAD_MIN = .02, SPREAD_FULL = .08;
// Larger turns come from crumpled or pinched cloth (a bend pressing the skirt
// into the hip crease); turning offsets by them throws vertices out.
const MAX_TURN = Math.PI / 3;

export class ProxyRotations {
  constructor({ count, edges, fixed, triangles, orientation }) {
    const degree = new Uint32Array(count + 1);
    for (let e = 0; e < edges.length; e++) degree[edges[e] + 1]++;
    for (let k = 0; k < count; k++) degree[k + 1] += degree[k];
    const ring = new Uint32Array(edges.length), fill = degree.slice(0, count);
    for (let e = 0; e < edges.length; e += 2) {
      ring[fill[edges[e]]++] = edges[e + 1]; ring[fill[edges[e + 1]]++] = edges[e];
    }
    this.count = count; this.fixed = fixed; this.triangles = triangles; this.orientation = orientation;
    this.ringStart = degree; this.ring = ring;
    this.quaternions = new Float64Array(count * 4);
    for (let k = 0; k < count; k++) this.quaternions[k * 4 + 3] = 1;
    this.normals = new Float64Array(count * 3);
    this.targetNormals = new Float64Array(count * 3);
    this.unsigned = new Float64Array(count).fill(1);
    this.covariance = new Float64Array(9);
  }

  /**
   * Shape matching over each proxy's 1-ring plus its normal (so a flat ring
   * still has a full frame), refined from the previous rotation. Normals here
   * are unsigned (triangle winding only): a rotation needs no outside, and
   * double-sided cloth often has none. Where the animated neighbourhood does
   * not pin a frame down (a chain of proxies without a normal), the rotation
   * fades to none instead of drifting. Fixed proxies do not turn.
   */
  update(P, T, iterations = 4) {
    const { count, fixed, ring, ringStart: start, covariance: A, quaternions: Q, normals: NP, targetNormals: NT, unsigned } = this;
    proxyNormals(this.triangles, P, NP, unsigned);
    proxyNormals(this.triangles, T, NT, unsigned);
    for (let k = 0; k < count; k++) {
      const o = k * 4;
      if (fixed[k]) { Q[o] = Q[o + 1] = Q[o + 2] = 0; Q[o + 3] = 1; continue; }
      A.fill(0);
      const k3 = k * 3;
      let scale = 0, c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
      for (let r = start[k]; r < start[k + 1]; r++) {
        const j3 = ring[r] * 3;
        const px = P[j3] - P[k3], py = P[j3 + 1] - P[k3 + 1], pz = P[j3 + 2] - P[k3 + 2];
        const tx = T[j3] - T[k3], ty = T[j3 + 1] - T[k3 + 1], tz = T[j3 + 2] - T[k3 + 2];
        A[0] += px * tx; A[1] += py * tx; A[2] += pz * tx;
        A[3] += px * ty; A[4] += py * ty; A[5] += pz * ty;
        A[6] += px * tz; A[7] += py * tz; A[8] += pz * tz;
        c00 += tx * tx; c01 += tx * ty; c02 += tx * tz; c11 += ty * ty; c12 += ty * tz; c22 += tz * tz;
        scale += tx * tx + ty * ty + tz * tz;
      }
      const nx = NP[k3], ny = NP[k3 + 1], nz = NP[k3 + 2], mx = NT[k3], my = NT[k3 + 1], mz = NT[k3 + 2];
      A[0] += scale * nx * mx; A[1] += scale * ny * mx; A[2] += scale * nz * mx;
      A[3] += scale * nx * my; A[4] += scale * ny * my; A[5] += scale * nz * my;
      A[6] += scale * nx * mz; A[7] += scale * ny * mz; A[8] += scale * nz * mz;
      c00 += scale * mx * mx; c01 += scale * mx * my; c02 += scale * mx * mz;
      c11 += scale * my * my; c12 += scale * my * mz; c22 += scale * mz * mz;
      extractRotation(A, Q, o, iterations);
      // Spread of the animated frame: I2 / I1^2 is 1/3 for a full 3D frame,
      // about 1/4 for a flat ring and 0 for a line.
      const i1 = c00 + c11 + c22, i2 = c00 * c11 + c00 * c22 + c11 * c22 - c01 * c01 - c02 * c02 - c12 * c12;
      const spread = i1 > 1e-20 ? i2 / (i1 * i1) : 0;
      const confidence = Math.min(1, Math.max(0, (spread - SPREAD_MIN) / (SPREAD_FULL - SPREAD_MIN)));
      // Cap the turn: |w| = cos(angle / 2).
      const cap = Math.cos(MAX_TURN / 2), aw = Math.abs(Q[o + 3]);
      const limited = aw < cap ? Math.min(confidence, angleScale(aw, MAX_TURN)) : confidence;
      if (limited < 1) {
        const sign = Q[o + 3] < 0 ? -1 : 1;
        const x = Q[o] * limited, y = Q[o + 1] * limited, z = Q[o + 2] * limited;
        const w = Q[o + 3] * limited + sign * (1 - limited), l = Math.sqrt(x * x + y * y + z * z + w * w);
        Q[o] = x / l; Q[o + 1] = y / l; Q[o + 2] = z / l; Q[o + 3] = w / l;
      }
    }
  }

  /**
   * out[0..3] = normalized blend of the rotations of the given proxies
   * (indices[base..base+3], -1 terminated) with weights.
   */
  blend(indices, weights, base, out) {
    const Q = this.quaternions;
    let x = 0, y = 0, z = 0, w = 0, sx = 0, sy = 0, sz = 0, sw = 0;
    for (let k = 0; k < 4; k++) {
      const proxy = indices[base + k];
      if (proxy < 0) break;
      const r = proxy * 4;
      if (k === 0) { sx = Q[r]; sy = Q[r + 1]; sz = Q[r + 2]; sw = Q[r + 3]; }
      const s = Q[r] * sx + Q[r + 1] * sy + Q[r + 2] * sz + Q[r + 3] * sw < 0 ? -weights[base + k] : weights[base + k];
      x += s * Q[r]; y += s * Q[r + 1]; z += s * Q[r + 2]; w += s * Q[r + 3];
    }
    const l = Math.sqrt(x * x + y * y + z * z + w * w);
    if (l > 1e-12) { out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l; }
    else { out[0] = out[1] = out[2] = 0; out[3] = 1; }
    return out;
  }
}

/** Fraction of a turn (quaternion |w|) that reaches angle `max`, for nlerp towards identity. */
function angleScale(aw, max) {
  // Find t with angle(nlerp(identity, q, t)) = max by bisection (monotonic).
  const angle = 2 * Math.acos(Math.min(1, aw)), s = Math.sqrt(Math.max(0, 1 - aw * aw));
  if (!(angle > max)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2, w = t * aw + (1 - t), v = t * s;
    if (2 * Math.atan2(v, w) > max) hi = t; else lo = t;
  }
  return lo;
}

/** Rotate (x, y, z) by unit quaternion q into out. */
export function rotateVector(q, x, y, z, out) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // v' = v + 2w (u x v) + 2 u x (u x v)
  const cx = 2 * (qy * z - qz * y), cy = 2 * (qz * x - qx * z), cz = 2 * (qx * y - qy * x);
  out[0] = x + qw * cx + (qy * cz - qz * cy);
  out[1] = y + qw * cy + (qz * cx - qx * cz);
  out[2] = z + qw * cz + (qx * cy - qy * cx);
  return out;
}

/** Area-weighted proxy normals, signed by each proxy's surface orientation. */
export function proxyNormals(triangles, positions, out, orientation) {
  out.fill(0);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.sqrt(out[i] * out[i] + out[i + 1] * out[i + 1] + out[i + 2] * out[i + 2]);
    if (l > 1e-20) { const k = orientation[i / 3] / l; out[i] *= k; out[i + 1] *= k; out[i + 2] *= k; }
  }
}

/**
 * Rotation of A (column-major 3x3) into quaternion Q[o..o+3] (x, y, z, w),
 * refined from its current value (Mueller et al. 2016, "A Robust Method to
 * Extract the Rotational Part of Deformations").
 */
function extractRotation(A, Q, o, iterations) {
  let x = Q[o], y = Q[o + 1], z = Q[o + 2], w = Q[o + 3];
  for (let i = 0; i < iterations; i++) {
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    const r00 = 1 - 2 * (yy + zz), r10 = 2 * (xy + wz), r20 = 2 * (xz - wy);
    const r01 = 2 * (xy - wz), r11 = 1 - 2 * (xx + zz), r21 = 2 * (yz + wx);
    const r02 = 2 * (xz + wy), r12 = 2 * (yz - wx), r22 = 1 - 2 * (xx + yy);
    let ox = (r10 * A[2] - r20 * A[1]) + (r11 * A[5] - r21 * A[4]) + (r12 * A[8] - r22 * A[7]);
    let oy = (r20 * A[0] - r00 * A[2]) + (r21 * A[3] - r01 * A[5]) + (r22 * A[6] - r02 * A[8]);
    let oz = (r00 * A[1] - r10 * A[0]) + (r01 * A[4] - r11 * A[3]) + (r02 * A[7] - r12 * A[6]);
    const den = Math.abs(r00 * A[0] + r10 * A[1] + r20 * A[2] + r01 * A[3] + r11 * A[4] + r21 * A[5]
      + r02 * A[6] + r12 * A[7] + r22 * A[8]) + 1e-12;
    ox /= den; oy /= den; oz /= den;
    const angle = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (!(angle > 1e-9)) break;
    const s = Math.sin(angle / 2) / angle, c = Math.cos(angle / 2);
    const ax = ox * s, ay = oy * s, az = oz * s;
    const nx = c * x + ax * w + (ay * z - az * y), ny = c * y + ay * w + (az * x - ax * z);
    const nz = c * z + az * w + (ax * y - ay * x), nw = c * w - (ax * x + ay * y + az * z);
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    x = nx / l; y = ny / l; z = nz / l; w = nw / l;
  }
  Q[o] = x; Q[o + 1] = y; Q[o + 2] = z; Q[o + 3] = w;
}

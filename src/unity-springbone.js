// UnityChan SpringBone as used by Link!Like! (Inspix) 3D costumes: a faithful JavaScript port.
//
// Ported function by function from the game's compiled code (libil2cpp.so 5.1.0) and UnityChan SpringBone
// (MIT, yugofujioka fork burst/1.1; license in vendor/unitychan-springbone/LICENSE).  Differences from upstream
// UnityChan SpringBone that the game added are marked "game addition".  No dependencies; everything works in
// UNITY space (left-handed, Y up).  unity-springbone-three.js drives it from a three.js skeleton.
//
//   const rig = SpringRig.fromJSON(physics.source.unitySpringBone);
//   every rendered frame (the game renders at 60 fps and steps once per frame, dt = 1 / simulationFrameRate):
//     rig.setLocal(id, { pos, rot });   // animated pose of non-spring transforms, Unity local space
//     rig.step();                       // SpringManager.LateUpdate of every manager
//     rig.h.localRot.get(id)            // physics result for spring bones, [x, y, z, w]
//
// Quaternions are [x, y, z, w], vectors [x, y, z].  Transform ids are the strings from the JSON.

const EPS_FLOAT = 1.401298e-45; // Mathf.Epsilon
const IDENTITY = [0, 0, 0, 1];
export const NO_COLLISION = 0, HEAD_IS_EMBEDDED = 1, TAIL_COLLISION = 2;

// ------------------------------------------------------------------ Unity math
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mag = (a) => Math.sqrt(dot(a, a));
const neg = (a) => [-a[0], -a[1], -a[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const radians = (d) => d * Math.PI / 180;
const degrees = (r) => r * 180 / Math.PI;

export function normalized(v) { // Vector3.normalized: zero below 1e-5
  const m = mag(v);
  return m > 1e-5 ? mul(v, 1 / m) : [0, 0, 0];
}
function project(v, n) { // Vector3.Project
  const s = dot(n, n);
  return s < EPS_FLOAT ? [0, 0, 0] : mul(n, dot(v, n) / s);
}
const reflect = (v, n) => sub(v, mul(n, 2 * dot(n, v)));

export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by + ay * bw + az * bx - ax * bz,
    aw * bz + az * bw + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]]; // Unity's Quaternion.Inverse is the conjugate
export function qrot(q, v) { // Quaternion * Vector3
  const [x, y, z, w] = q;
  const x2 = x * 2, y2 = y * 2, z2 = z * 2;
  const xx = x * x2, yy = y * y2, zz = z * z2, xy = x * y2, xz = x * z2, yz = y * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [(1 - (yy + zz)) * v[0] + (xy - wz) * v[1] + (xz + wy) * v[2],
    (xy + wz) * v[0] + (1 - (xx + zz)) * v[1] + (yz - wx) * v[2],
    (xz - wy) * v[0] + (yz + wx) * v[1] + (1 - (xx + yy)) * v[2]];
}
function qnormalize(q) {
  const m = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return m >= EPS_FLOAT ? q.map((c) => c / m) : IDENTITY.slice();
}
function qlerp(a, b, t) { // Quaternion.Lerp: shortest path, normalized
  if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) b = b.map((c) => -c);
  return qnormalize(a.map((x, i) => x + (b[i] - x) * t));
}
function fromToRotation(f, t) { // Quaternion.FromToRotation (shortest arc)
  f = normalized(f); t = normalized(t);
  const d = dot(f, t);
  if (d < -0.999999) {
    let axis = cross([1, 0, 0], f);
    if (mag(axis) < 1e-6) axis = cross([0, 1, 0], f);
    axis = normalized(axis);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(f, t);
  return qnormalize([c[0], c[1], c[2], 1 + d]);
}

// 3x4 affine matrices, row-major: [r00 r01 r02 tx  r10 r11 r12 ty  r20 r21 r22 tz]
function trs(p, q, s) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y - w * z) * s[1], 2 * (x * z + w * y) * s[2], p[0],
    2 * (x * y + w * z) * s[0], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z - w * x) * s[2], p[1],
    2 * (x * z - w * y) * s[0], 2 * (y * z + w * x) * s[1], (1 - 2 * (x * x + y * y)) * s[2], p[2]];
}
function mmul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      if (c === 3) v += a[r * 4 + 3];
      o[r * 4 + c] = v;
    }
  }
  return o;
}
function minv(m) {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = 1 / det;
  const r = [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
  return [r[0], r[1], r[2], -(r[0] * tx + r[1] * ty + r[2] * tz),
    r[3], r[4], r[5], -(r[3] * tx + r[4] * ty + r[5] * tz),
    r[6], r[7], r[8], -(r[6] * tx + r[7] * ty + r[8] * tz)];
}
const mpoint = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const mvector = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];

// ------------------------------------------------------------------ transform hierarchy
export class Hierarchy {
  // Keyed by Transform path id (string): names are not unique inside a prefab.
  constructor(transforms) {
    this.parent = new Map(); this.children = new Map(); this.name = new Map(); this.byName = new Map();
    this.localPos = new Map(); this.localRot = new Map(); this.localScale = new Map();
    for (const t of transforms) {
      this.name.set(t.id, t.name);
      this.parent.set(t.id, t.parentId);
      this.localPos.set(t.id, t.localPosition.slice());
      // stored float32 quaternions are unit only to ~1e-7; normalize so Inverse() (= conjugate) stays exact
      this.localRot.set(t.id, qnormalize(t.localRotation));
      this.localScale.set(t.id, t.localScale.slice());
      if (!this.children.has(t.id)) this.children.set(t.id, []);
      if (!this.byName.has(t.name)) this.byName.set(t.name, []);
      this.byName.get(t.name).push(t.id);
    }
    for (const t of transforms) {
      if (t.parentId !== null) {
        if (!this.children.has(t.parentId)) this.children.set(t.parentId, []);
        this.children.get(t.parentId).push(t.id);
      }
    }
    this._m = new Map(); this._mi = new Map(); this._r = new Map();
  }

  id(name) { // resolve a unique transform name
    const ids = this.byName.get(name) || [];
    if (ids.length !== 1) throw new Error(`${name} matches ${ids.length} transforms`);
    return ids[0];
  }

  _invalidate(n) {
    const stack = [n];
    while (stack.length) {
      const k = stack.pop();
      if (this._m.has(k) || this._r.has(k)) {
        this._m.delete(k); this._mi.delete(k); this._r.delete(k);
      }
      for (const c of this.children.get(k) || []) stack.push(c);
    }
  }

  setLocal(n, { pos, rot, scale } = {}) {
    if (pos) this.localPos.set(n, pos.slice());
    if (rot) this.localRot.set(n, qnormalize(rot));
    if (scale) this.localScale.set(n, scale.slice());
    this._invalidate(n);
  }

  matrix(n) { // localToWorldMatrix (prefab root = world)
    let m = this._m.get(n);
    if (!m) {
      const local = trs(this.localPos.get(n), this.localRot.get(n), this.localScale.get(n));
      const p = this.parent.get(n);
      m = p === null ? local : mmul(this.matrix(p), local);
      this._m.set(n, m);
    }
    return m;
  }

  inverseMatrix(n) { // worldToLocalMatrix
    let m = this._mi.get(n);
    if (!m) { m = minv(this.matrix(n)); this._mi.set(n, m); }
    return m;
  }

  rotation(n) {
    let r = this._r.get(n);
    if (!r) {
      const p = this.parent.get(n);
      r = p === null ? this.localRot.get(n).slice() : qmul(this.rotation(p), this.localRot.get(n));
      this._r.set(n, r);
    }
    return r;
  }

  position(n) { const m = this.matrix(n); return [m[3], m[7], m[11]]; }
  transformPoint(n, p) { return mpoint(this.matrix(n), p); }
  inverseTransformPoint(n, p) { return mpoint(this.inverseMatrix(n), p); }
  transformDirection(n, v) { return qrot(this.rotation(n), v); } // rotation only, like Unity
  inverseTransformDirection(n, v) { return qrot(qinv(this.rotation(n)), v); }
  right(n) { return qrot(this.rotation(n), [1, 0, 0]); }
  up(n) { return qrot(this.rotation(n), [0, 1, 0]); }
  forward(n) { return qrot(this.rotation(n), [0, 0, 1]); }

  depth(n) { // SpringManager.GetObjectDepth
    let d = 0;
    while (n !== null && n !== undefined) { n = this.parent.get(n); d++; }
    return d;
  }

  dfs(root) { // GetComponentsInChildren order
    const out = [], stack = [root];
    while (stack.length) {
      const k = stack.pop();
      out.push(k);
      const ch = this.children.get(k) || [];
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
    return out;
  }
}

// ------------------------------------------------------------------ colliders
function computeIntersection(oa, ra, ob, rb) {
  const ab = sub(ob, oa);
  const d2 = dot(ab, ab);
  const d = Math.sqrt(d2);
  if (d <= 0) return null;
  const den = 0.5 / d;
  const st = d2 - rb * rb + ra * ra;
  const disc = 4 * d2 * ra * ra - st * st;
  const r = disc >= 0 ? Math.sqrt(disc) * den : NaN;
  const up = mul(ab, 1 / d);
  return { origin: add(oa, mul(up, st * den)), up, radius: r };
}
function newTailPosition(c, tail) {
  const nt = sub(tail, mul(c.up, dot(c.up, sub(tail, c.origin))));
  return add(c.origin, mul(normalized(sub(nt, c.origin)), c.radius));
}
function sphereCheck(lh, lt, ltr, origin, sphereRadius) { // SpringSphereCollider.CheckForCollisionAndReact (static)
  const comb = sphereRadius + ltr;
  const ot = sub(lt, origin);
  if (dot(ot, ot) >= comb * comb) return [NO_COLLISION, lt];
  const oh = sub(lh, origin);
  if (dot(oh, oh) <= sphereRadius * sphereRadius) return [HEAD_IS_EMBEDDED, add(origin, mul(normalized(ot), comb))];
  const c = computeIntersection(lh, mag(sub(lt, lh)), origin, comb);
  if (c) lt = newTailPosition(c, lt);
  return [TAIL_COLLISION, lt];
}

class SphereCollider {
  constructor(h, node, f) { this.h = h; this.node = node; this.radius = f.radius; this.enabled = (f.m_Enabled ?? 1) !== 0; }
  check(head, tail, tailRadius) { // -> [status, new tail, hit normal | null]
    const { h, node: n } = this;
    const lh = h.inverseTransformPoint(n, head);
    let lt = h.inverseTransformPoint(n, tail);
    const ltr = mag(h.inverseTransformDirection(n, [tailRadius, 0, 0]));
    let status;
    [status, lt] = sphereCheck(lh, lt, ltr, [0, 0, 0], this.radius);
    if (status === NO_COLLISION) return [status, tail, null];
    return [status, h.transformPoint(n, lt), normalized(h.transformDirection(n, normalized(lt)))];
  }
}

class CapsuleCollider {
  constructor(h, node, f) {
    this.h = h; this.node = node; this.radius = f.radius; this.height = f.height; this.enabled = (f.m_Enabled ?? 1) !== 0;
  }
  check(head, mover, moverRadius) {
    if (this.radius <= 0.0001) return [NO_COLLISION, mover, null]; // linkedRenderer is null in all game data
    const { h, node: n } = this;
    const w2l = h.inverseMatrix(n);
    const radiusScale = mag(mvector(w2l, [1, 0, 0]));
    const lh = mpoint(w2l, head);
    let lm = mpoint(w2l, mover);
    const lmr = moverRadius * radiusScale;
    const above = lm[1] >= this.height;
    if (lm[1] <= 0 || above) {
      const so = [0, above ? this.height : 0, 0];
      const comb = lmr + this.radius;
      const sm = sub(lm, so);
      if (dot(sm, sm) >= comb * comb) return [NO_COLLISION, mover, null];
      const oh = sub(lh, so);
      if (dot(oh, oh) <= this.radius * this.radius) {
        const ln = normalized(sm);
        lm = add(so, mul(ln, comb));
        return [HEAD_IS_EMBEDDED, h.transformPoint(n, lm), normalized(h.transformDirection(n, ln))];
      }
      const c = computeIntersection(lh, mag(sub(lm, lh)), so, comb);
      if (c) {
        lm = newTailPosition(c, lm);
        const ln = normalized(sub(lm, so));
        return [TAIL_COLLISION, h.transformPoint(n, lm), normalized(h.transformDirection(n, ln))];
      }
      return [TAIL_COLLISION, mover, null];
    }
    // cylinder part
    const comb = this.radius + lmr;
    if (lm[0] * lm[0] + lm[2] * lm[2] > comb * comb) return [NO_COLLISION, mover, null];
    const m2 = Math.hypot(lm[0], lm[2]);
    const nrm = m2 > 1e-5 ? [lm[0] / m2, lm[2] / m2] : [0, 0];
    const newLocal = [comb * nrm[0], lm[1], comb * nrm[1]];
    const hit = normalized(h.transformDirection(n, [nrm[0], 0, nrm[1]]));
    const st = lh[0] * lh[0] + lh[2] * lh[2] <= this.radius * this.radius ? HEAD_IS_EMBEDDED : TAIL_COLLISION;
    return [st, h.transformPoint(n, newLocal), hit];
  }
}

function alignedPlaneCheck(lh, ll, lt, ltr, z) { // SpringPanelCollider.CheckForCollisionWithAlignedPlaneAndReact
  if (lt[z] >= ltr) return [NO_COLLISION, lt.slice()];
  let status = TAIL_COLLISION;
  const nw = lh.slice();
  if (lh[z] + ll <= ltr) {
    nw[z] += ll;
    status = HEAD_IS_EMBEDDED;
  } else {
    const x = (z + 1) % 3, y = (z + 2) % 3;
    const har = lh[z] - ltr;
    const pl = Math.sqrt(Math.max(0, ll * ll - har * har));
    const bv = sub(lt, lh);
    const pv = [bv[x], bv[y]];
    const pvl = Math.hypot(pv[0], pv[1]);
    if (pvl > 0.001) {
      nw[x] += pl / pvl * pv[0];
      nw[y] += pl / pvl * pv[1];
      nw[z] = ltr;
    }
  }
  return [status, nw];
}

class PanelCollider {
  constructor(h, node, f) {
    this.h = h; this.node = node; this.width = f.width; this.height = f.height; this.enabled = (f.m_Enabled ?? 1) !== 0;
  }
  check(head, length, tail, tailRadius) {
    const { h, node: n } = this;
    let lt = h.inverseTransformPoint(n, tail);
    const ltr = mag(h.inverseTransformDirection(n, [tailRadius, 0, 0]));
    if (lt[2] >= ltr) return [NO_COLLISION, tail, null];
    const lh = h.inverseTransformPoint(n, head);
    const ll = mag(h.inverseTransformDirection(n, [length, 0, 0]));
    let hw = 0.5 * this.width, hh = 0.5 * this.height;
    if (Math.abs(lt[1]) >= hh + ltr || Math.abs(lt[0]) >= hw + ltr) return [NO_COLLISION, tail, null];
    let status = TAIL_COLLISION;
    if (lh[2] <= 0 && lt[2] <= 0) {
      if (Math.abs(lh[1]) > hh) lt[1] = lt[1] < 0 ? -hh : hh;
      else if (Math.abs(lh[0]) > hw) lt[0] = lt[0] < 0 ? -hw : hw;
      else { status = HEAD_IS_EMBEDDED; lt = [lh[0], lh[1], ltr]; }
    } else if (Math.abs(lt[1]) > hh) {
      hh = lt[1] < 0 ? -hh : hh;
      const nl = normalized([0, lt[1] - hh, lt[2]]);
      lt = add([lt[0], hh, 0], mul(nl, ltr));
    } else if (Math.abs(lt[0]) > hw) {
      hw = lt[0] < 0 ? -hw : hw;
      const nl = normalized([lt[0] - hw, 0, lt[2]]);
      lt = add([hw, lt[1], 0], mul(nl, ltr));
    } else {
      [status, lt] = alignedPlaneCheck(lh, ll, lt, ltr, 2);
    }
    if (status === NO_COLLISION) return [status, tail, null];
    return [status, h.transformPoint(n, lt), normalized(h.forward(n))];
  }
}

// ------------------------------------------------------------------ angle limits
class AngleLimits {
  constructor(f) { this.active = !!f.active; this.min = f.min; this.max = f.max; }
  static falloff(value, range) {
    if (Math.abs(range) <= 0.0001) return 0;
    const v = clamp(value / range, 0, 1);
    return Math.min(v, Math.sqrt(v));
  }
  constrain(side, up, fwd, strength, dt, vector) {
    const upp = project(vector, up);
    const proj = sub(vector, upp);
    const pm = mag(proj);
    const sine = clamp(dot(pm ? mul(proj, 1 / pm) : [NaN, NaN, NaN], side), -1, 1);
    let ang = Number.isNaN(sine) ? NaN : degrees(Math.asin(sine));
    ang += -ang * strength * dt * dt;
    ang = clamp(ang, this.min, this.max);
    const limit = ang < 0 ? this.min : this.max;
    ang = AngleLimits.falloff(ang, limit) * limit;
    const r = radians(ang);
    return add(mul(add(mul(side, Math.sin(r)), mul(fwd, Math.cos(r))), pm), upp);
  }
}

// ------------------------------------------------------------------ SpringBone
export class SpringBone {
  constructor(h, node, f, colliders, pivotNodes) {
    this.h = h; this.node = node; this.f = f;
    this.enabled = !!f.m_Enabled;
    this.stiffness = f.stiffnessForce; this.drag = f.dragForce;
    this.springForce = [f.springForce.x, f.springForce.y, f.springForce.z];
    this.windInfluence = f.windInfluence;
    this.pivot = f.pivotNode ? f.pivotNode.transformId : null;
    this.angularStiffness = f.angularStiffness;
    this.ylim = new AngleLimits(f.yAngleLimits); this.zlim = new AngleLimits(f.zAngleLimits);
    this.radius = f.radius;
    this.prioritizePhysics = !!f.PrioritizePhysics;                              // game addition
    this.explicitChild = f.explicitlyChild ? f.explicitlyChild.transformId : null; // game addition
    this.springType = f.springType;                                              // game addition, no runtime effect
    const pick = (cls, refs) => (refs || []).filter(Boolean).map((r) => colliders.get(`${cls}|${r.transformId}`));
    this.capsules = pick('SpringCapsuleCollider', f.capsuleColliders);
    this.spheres = pick('SpringSphereCollider', f.sphereColliders);
    this.panels = pick('SpringPanelCollider', f.panelColliders);
    this.lengthTargets = (f.lengthLimitTargets || []).filter(Boolean).map((r) => r.transformId);
    this.pivotNodes = pivotNodes;
    this.manager = null;
  }

  childPosition() { // SpringBone.ComputeChildPosition (RVA 0x4E1A818)
    const { h, node: n } = this;
    const children = (h.children.get(n) || []).filter((c) => !this.pivotNodes.has(c)); // GetValidChildren
    if (!children.length) return add(h.position(n), mul(h.right(n), -0.1));
    if (children.length === 1) return h.position(children[0]);
    if (this.explicitChild) return h.position(this.explicitChild); // game addition
    const selfp = h.position(n);
    let tail = [0, 0, 0], dist = 0;
    for (const c of children) {
      const cp = h.position(c);
      tail = add(tail, cp);
      dist += mag(sub(cp, selfp));
    }
    dist /= children.length;
    tail = mul(tail, 1 / children.length);
    return add(selfp, mul(normalized(sub(tail, selfp)), dist));
  }

  initialize(manager) {
    const { h, node: n } = this;
    this.manager = manager;
    let cp = this.childPosition();
    this.boneAxis = normalized(h.inverseTransformPoint(n, cp));
    this.initialLocalRot = h.localRot.get(n).slice();
    this.actualLocalRot = this.initialLocalRot;
    this.skinLocalRot = this.initialLocalRot;
    cp = this.childPosition();
    this.springLength = mag(sub(h.position(n), cp));
    this.curr = cp; this.prev = cp;
    this.lengthsToTargets = this.lengthTargets.map((t) => mag(sub(h.position(t), cp)));
  }

  baseWorldRotation() { return qmul(this.h.rotation(this.h.parent.get(this.node)), this.initialLocalRot); }

  updateSpring(dt, external) { // SpringBone.UpdateSpring (RVA 0x4E21D08)
    const { h, node: n } = this;
    this.skinLocalRot = h.localRot.get(n).slice();
    const oriented = add(h.position(n), mul(qrot(this.baseWorldRotation(), this.boneAxis), this.springLength));
    let force = mul(sub(oriented, this.curr), this.stiffness);
    force = add(add(force, this.springForce), external);
    force = mul(force, 0.5 * dt * dt);
    const temp = this.curr;
    force = add(force, mul(sub(this.curr, this.prev), 1 - this.drag));
    this.curr = add(this.curr, force);
    this.prev = temp;
    const head = h.position(n);
    let ht = sub(this.curr, head);
    const m = mag(ht);
    ht = m <= 0.001 ? h.transformDirection(n, this.boneAxis) : mul(ht, 1 / m);
    this.curr = add(head, mul(ht, this.springLength));
  }

  satisfyConstraints(dt, ratio) { // SpringBone.SatisfyConstraintsAndComputeRotation (RVA 0x4E2202C)
    const m = this.manager;
    if (m.enableLengthLimits) this.curr = this.applyLengthLimits(dt);
    let had = false;
    if (m.collideWithGround) had = this.groundCollision();
    if (m.enableCollision && !had) this.collision();
    if (m.enableAngleLimits && !this.prioritizePhysics) this.applyAngleLimits(dt); // game addition
    this.computeRotationAndApply(ratio);
  }

  computeRotationAndApply(ratio) {
    const { h, node: n } = this;
    if (this.curr.some(Number.isNaN)) {
      this.curr = add(h.position(n), mul(qrot(this.baseWorldRotation(), this.boneAxis), this.springLength));
      this.prev = this.curr;
    }
    const local = normalized(qrot(qinv(this.baseWorldRotation()), sub(this.curr, h.position(n))));
    this.actualLocalRot = qmul(this.initialLocalRot, fromToRotation(this.boneAxis, local));
    h.setLocal(n, { rot: qlerp(this.skinLocalRot, this.actualLocalRot, ratio) });
  }

  applyLengthLimits(dt) {
    if (!this.lengthTargets.length) return this.curr;
    const k = 0.5 * dt * dt;
    let move = [0, 0, 0];
    this.lengthTargets.forEach((t, i) => {
      const ct = sub(this.curr, this.h.position(t));
      move = sub(move, mul(normalized(ct), k * (mag(ct) - this.lengthsToTargets[i])));
    });
    return add(this.curr, move);
  }

  fixBoneLength(head, tail, lo, hi) {
    const ht = sub(tail, head);
    const m = mag(ht);
    if (m <= 0.001) return add(head, mul(this.h.transformDirection(this.node, this.boneAxis), lo));
    return add(head, mul(ht, clamp(m, lo, hi) / m));
  }

  groundCollision() {
    const { h, node: n } = this;
    const head = h.position(n);
    let tail = this.curr.slice();
    const wr = mag(h.transformDirection(n, [this.radius, 0, 0]));
    const wl = mag(sub(this.curr, head));
    const g = this.manager.groundHeight;
    head[1] -= g; tail[1] -= g;
    let st;
    [st, tail] = alignedPlaneCheck(head, wl, tail, wr, 1);
    if (st !== NO_COLLISION) {
      tail[1] += g;
      this.curr = this.fixBoneLength(h.position(n), tail, 0.5 * this.springLength, this.springLength);
      this.prev = this.curr;
    }
    return st !== NO_COLLISION;
  }

  collision(capsules = this.capsules, spheres = this.spheres, panels = this.panels) {
    const { h, node: n, manager: m } = this;
    const desired = this.curr;
    const head = h.position(n);
    const r = mag(h.transformDirection(n, [this.radius, 0, 0]));
    let hit = [0, 0, 1], had = false, st, nrm;
    for (const c of capsules) {
      if (!c.enabled) continue;
      [st, this.curr, nrm] = c.check(head, this.curr, r);
      if (nrm) hit = nrm;
      had = had || st !== NO_COLLISION;
    }
    for (const c of spheres) {
      if (!c.enabled) continue;
      [st, this.curr, nrm] = c.check(head, this.curr, r);
      if (nrm) hit = nrm;
      had = had || st !== NO_COLLISION;
    }
    for (const c of panels) {
      if (!c.enabled) continue;
      [st, this.curr, nrm] = c.check(head, this.springLength, this.curr, r);
      if (nrm) hit = nrm;
      had = had || st !== NO_COLLISION;
    }
    if (had) {
      const refl = reflect(sub(desired, this.prev), hit);
      const upc = mul(hit, dot(refl, hit));
      const lat = sub(refl, upc);
      const bounce = add(mul(upc, m.bounce), mul(lat, 1 - m.friction));
      if (dot(bounce, bounce) > 0.0001) {
        const traveled = mag(sub(this.curr, this.prev));
        this.prev = sub(this.curr, bounce);
        this.curr = add(this.curr, mul(normalized(bounce), Math.max(0, mag(bounce) - traveled)));
      } else {
        this.prev = this.curr;
      }
    }
    return had;
  }

  applyAngleLimits(dt) {
    if ((!this.ylim.active && !this.zlim.active) || this.pivot === null) return;
    const h = this.h, p = this.pivot;
    const origin = h.position(this.node);
    let vec = sub(this.curr, origin);
    const fwd = neg(h.right(p));
    if (this.ylim.active) vec = this.ylim.constrain(neg(h.up(p)), neg(h.forward(p)), fwd, this.angularStiffness, dt, vec);
    if (this.zlim.active) vec = this.zlim.constrain(neg(h.forward(p)), neg(h.up(p)), fwd, this.angularStiffness, dt, vec);
    this.curr = add(origin, vec);
  }
}

// ------------------------------------------------------------------ SpringManager
export class SpringManager {
  constructor(h, node, f, bonesByNode) {
    this.h = h; this.node = node;
    this.automaticUpdates = !!f.automaticUpdates; this.isPaused = !!f.isPaused;
    this.fps = f.simulationFrameRate; this.dynamicRatio = f.dynamicRatio;
    this.gravity = [f.gravity.x, f.gravity.y, f.gravity.z];
    this.bounce = f.bounce; this.friction = f.friction;
    this.enableAngleLimits = !!f.enableAngleLimits; this.enableCollision = !!f.enableCollision;
    this.enableLengthLimits = !!f.enableLengthLimits;
    this.collideWithGround = !!f.collideWithGround; this.groundHeight = f.groundHeight;
    // Awake -> FindSpringBones(true): every SpringBone below this GameObject, the serialized list is ignored,
    // sorted by depth (C# List.Sort is unstable; bones of equal depth never depend on each other).
    const found = h.dfs(node).filter((k) => bonesByNode.has(k)).map((k) => bonesByNode.get(k));
    this.bones = found.map((b, i) => [b, h.depth(b.node), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
    this.boneIsAnimated = this.bones.map(() => false); // UpdateBoneIsAnimatedStates is never called in the game
    for (const b of this.bones) b.initialize(this);
  }

  updateDynamics(deltaTime = 1 / 60) {
    if (this.isPaused) {
      this.bones.forEach((b, i) => { if (b.enabled) b.computeRotationAndApply(this.boneIsAnimated[i] ? this.dynamicRatio : 1); });
      return;
    }
    const dt = this.fps > 0 ? 1 / this.fps : deltaTime; // fixed step, NOT the frame time
    this.bones.forEach((b, i) => {
      if (!b.enabled) return;
      b.updateSpring(dt, this.gravity); // GetSumOfForcesOnBone: gravity (+ ForceProviders: none in the data)
      b.satisfyConstraints(dt, this.boneIsAnimated[i] ? this.dynamicRatio : 1);
    });
  }
}

export class SpringRig {
  // One costume prefab: hierarchy + all SpringManagers, stepped like LateUpdate.
  constructor(doc, options = {}) {
    this.doc = doc;
    this.h = new Hierarchy(doc.transforms);
    const comps = doc.components;
    const pivots = new Set(comps.filter((c) => c.class === 'SpringBonePivot').map((c) => c.transformId));
    const kinds = { SpringSphereCollider: SphereCollider, SpringCapsuleCollider: CapsuleCollider, SpringPanelCollider: PanelCollider };
    const colliders = new Map();
    for (const c of comps) {
      const K = kinds[c.class];
      if (K) colliders.set(`${c.class}|${c.transformId}`, new K(this.h, c.transformId, c.fields));
    }
    this.bones = new Map();
    for (const c of comps) {
      if (c.class === 'SpringBone') this.bones.set(c.transformId, new SpringBone(this.h, c.transformId, c.fields, colliders, pivots));
    }
    this.managers = comps.filter((c) => c.class === 'SpringManager' && c.fields.m_Enabled)
      .map((c) => new SpringManager(this.h, c.transformId, c.fields, this.bones));
  }

  static fromJSON(doc, options) { return new SpringRig(doc, options); }

  setLocal(node, { pos, rot } = {}) { // node: transform id or a unique transform name
    this.h.setLocal(this.h.name.has(node) ? node : this.h.id(node), { pos, rot });
  }

  step(deltaTime = 1 / 60) { // one rendered frame: SpringManager.LateUpdate (execution order 0) per manager
    for (const m of this.managers) if (m.automaticUpdates) m.updateDynamics(deltaTime);
  }

  /**
   * Restart the simulation at the current pose (what instantiating the prefab does): every spring bone back to
   * its initial local rotation, tails at rest with zero velocity.  Not a game function: the game only does this
   * at Awake; the renderer needs it after loading, motion changes, teleports and pauses.
   */
  reset() {
    for (const m of this.managers) {
      for (const b of m.bones) {
        if (!b.enabled) continue;
        b.h.setLocal(b.node, { rot: b.initialLocalRot });
        b.actualLocalRot = b.skinLocalRot = b.initialLocalRot;
      }
      for (const b of m.bones) {
        if (!b.enabled) continue;
        const tail = add(b.h.position(b.node), mul(qrot(b.baseWorldRotation(), b.boneAxis), b.springLength));
        b.curr = tail; b.prev = tail;
      }
    }
  }

  /** Transform ids whose rotation the simulation writes: enabled spring bones of enabled managers.  Disabled
   * SpringBone components are skipped by SpringManager, so their transforms keep following the animation. */
  // (a bone below two nested managers is simulated by both, as in the game, but listed once)
  get drivenIds() { return [...new Set(this.managers.flatMap((m) => m.bones.filter((b) => b.enabled).map((b) => b.node)))]; }
}

// Deterministic root motion shared with springbone_ref.py's --trace (parity test).
export function testMotion(frame) {
  const t = frame / 60;
  const yaw = radians(25 * Math.sin(2 * Math.PI * 0.8 * t)) / 2;
  return [[0, Math.sin(yaw), 0, Math.cos(yaw)], 0.08 * Math.sin(2 * Math.PI * 0.8 * t)];
}

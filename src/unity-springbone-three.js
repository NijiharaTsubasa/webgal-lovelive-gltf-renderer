// three.js binding for unity-springbone.js: drive the Unity-space SpringBone simulation from a three.js skeleton
// and write the spring-bone rotations back.
//
// The Unity -> three relation is not assumed: at bind time it is fitted from the rest pose (Horn's method, with
// or without an X mirror; rotation, uniform scale, translation), and every node gets a constant rest-orientation
// offset, so re-oriented ("normalized") skeletons work.  The source transforms must describe the SAME pose as the
// three.js rest pose (the converter writes the Unity transforms of the pose the GLB was exported in).
//
//   const rig = SpringRig.fromJSON(data);
//   const binding = new SpringBoneBinding(rig, root, { find: (name, root, id) => objectFor(id) });
//   each fixed step, AFTER the animation posed the skeleton:  binding.update();
//
// The game steps once per rendered frame at 60 fps with a fixed dt of 1/simulationFrameRate (usually 1/30).

import { Matrix4, Quaternion, Vector3 } from "three";
import { qmul, qinv } from "./unity-springbone.js";

const mirrorQ = (q) => [q[0], -q[1], -q[2], q[3]];  // reflect a rotation through the YZ plane (X mirror)
const sanitize = (n) => n.replace(/\s/g, "_").replace(/[\[\]\.:\/]/g, ""); // three's PropertyBinding.sanitizeNodeName

// Largest eigenvector of a symmetric 4x4 (cyclic Jacobi), used by Horn's absolute orientation.
function maxEigenvector(N) {
  const a = N.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 4; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]]; // [w, x, y, z]
}

// Similarity fit dst ~ s * R * src + t (Horn 1987).  Returns {q:[x,y,z,w], s, t, rms}.
function fitSimilarity(src, dst) {
  const n = src.length;
  const cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { cs[k] += src[i][k] / n; cd[k] += dst[i][k] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let ss = 0, sd = 0;
  for (let i = 0; i < n; i++) {
    const a = [0, 1, 2].map((k) => src[i][k] - cs[k]), b = [0, 1, 2].map((k) => dst[i][k] - cd[k]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c];
    ss += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    sd += b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
  }
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
  const [w, x, y, z] = maxEigenvector(N);
  const q = new Quaternion(x, y, z, w).normalize();
  const s = Math.sqrt(sd / ss);
  const t = new Vector3(...cd).sub(new Vector3(...cs).applyQuaternion(q).multiplyScalar(s));
  let err = 0;
  for (let i = 0; i < n; i++) err += new Vector3(...src[i]).applyQuaternion(q).multiplyScalar(s).add(t).distanceToSquared(new Vector3(...dst[i]));
  return { q: [q.x, q.y, q.z, q.w], s, t: t.toArray(), rms: Math.sqrt(err / n) };
}

export class SpringBoneBinding {
  /**
   * @param {SpringRig} rig        simulation built from the source data (still at its rest pose)
   * @param {Object3D} root        three.js object containing the skeleton, at the rest pose the data describes
   * @param {object} [opt]
   * @param {(name:string, root:Object3D, id:string)=>Object3D|null} [opt.find]  Unity transform -> three node
   * @param {'auto'|true|false} [opt.mirror='auto']                             X mirror between Unity and three
   */
  constructor(rig, root, opt = {}) {
    this.rig = rig;
    this.root = root;
    const h = rig.h;
    const index = new Map();
    root.traverse((o) => { if (o.name) { const l = index.get(o.name) || []; l.push(o); index.set(o.name, l); } });
    const find = opt.find || ((name) => {
      const l = index.get(name) || index.get(sanitize(name));
      return l && l.length === 1 ? l[0] : null;
    });

    // Unity nodes that matter: spring bones, colliders, pivots, length targets and all their ancestors.
    const needed = new Set();
    const addChain = (id) => { for (let k = id; k !== null && k !== undefined && !needed.has(k); k = h.parent.get(k)) needed.add(k); };
    for (const b of rig.bones.values()) {
      addChain(b.node);
      if (b.pivot) addChain(b.pivot);
      if (b.explicitChild) addChain(b.explicitChild);
      for (const t of b.lengthTargets) addChain(t);
      for (const c of [...b.capsules, ...b.spheres, ...b.panels]) if (c) addChain(c.node);
      for (const c of h.children.get(b.node) || []) addChain(c);   // children define the bone axis
    }
    this.nodes = new Map();          // unity id -> three Object3D
    const unmatched = [];
    for (const id of needed) {
      const o = find(h.name.get(id), root, id);
      if (o) this.nodes.set(id, o); else unmatched.push(h.name.get(id));
    }

    root.updateMatrixWorld(true);
    this._rootInv = new Matrix4().copy(root.matrixWorld).invert();
    const pairs = [...this.nodes].map(([id, o]) => [h.position(id), this._rootLocalPos(o)]);
    if (pairs.length < 3) throw new Error(`unitySpringBone: only ${pairs.length} transforms resolved to three.js nodes`);
    const tryFit = (mirror) => ({ mirror, ...fitSimilarity(pairs.map(([u]) => (mirror ? [-u[0], u[1], u[2]] : u)), pairs.map(([, t]) => t)) });
    const fits = opt.mirror === undefined || opt.mirror === "auto" ? [tryFit(true), tryFit(false)] : [tryFit(!!opt.mirror)];
    const fit = fits.sort((a, b) => a.rms - b.rms)[0];
    Object.assign(this, { mirror: fit.mirror, R: fit.q, scale: fit.s, T: fit.t });

    // Per-node constant rest offset: threeRot = R * M(unityRot) * offset
    this.offset = new Map();
    for (const [id, o] of this.nodes) this.offset.set(id, qmul(qinv(this._toThree(h.rotation(id))), this._rootLocalQuat(o)));

    const driven = new Set(rig.drivenIds);
    const ordered = (ids) => ids.sort((a, b) => h.depth(a) - h.depth(b));
    this.drivers = ordered([...this.nodes.keys()].filter((id) => !driven.has(id)));
    this.springs = ordered([...driven].filter((id) => this.nodes.has(id)));
    this.report = {
      matched: this.nodes.size, unmatched, mirror: this.mirror, scale: this.scale,
      rmsFitError: fit.rms, springBonesDriven: this.springs.length, springBonesTotal: rig.bones.size,
    };
  }

  /** three.js objects whose rotation the simulation writes. */
  get drivenObjects() { return this.springs.map((id) => this.nodes.get(id)); }

  _rootLocalPos(o) { return new Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(this._rootInv).toArray(); }
  _rootLocalQuat(o) {
    const m = new Matrix4().multiplyMatrices(this._rootInv, o.matrixWorld);
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(m));
    return [q.x, q.y, q.z, q.w];
  }
  _toThree(u) { return qmul(this.R, this.mirror ? mirrorQ(u) : u); }
  _toUnity(t) { const q = qmul(qinv(this.R), t); return this.mirror ? mirrorQ(q) : q; }
  _posToUnity(p) {
    const v = new Vector3(p[0] - this.T[0], p[1] - this.T[1], p[2] - this.T[2])
      .applyQuaternion(new Quaternion(...this.R).invert()).multiplyScalar(1 / this.scale);
    return this.mirror ? [-v.x, v.y, v.z] : v.toArray();
  }

  /** Animated pose of the driver nodes -> Unity local transforms (parents first). */
  syncDrivers() {
    const h = this.rig.h;
    this.root.updateMatrixWorld(true);
    this._rootInv.copy(this.root.matrixWorld).invert();
    for (const id of this.drivers) {
      const o = this.nodes.get(id);
      o.updateWorldMatrix(true, false);
      const worldRot = this._toUnity(qmul(this._rootLocalQuat(o), qinv(this.offset.get(id))));
      const worldPos = this._posToUnity(this._rootLocalPos(o));
      const p = h.parent.get(id);
      if (p === null) h.setLocal(id, { rot: worldRot, pos: worldPos });
      else h.setLocal(id, { rot: qmul(qinv(h.rotation(p)), worldRot), pos: h.inverseTransformPoint(p, worldPos) });
    }
  }

  /** Spring-bone results -> three local quaternions (parents first; each world matrix refreshed for its children). */
  writeSprings() {
    const h = this.rig.h;
    const rootQ = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(this.root.matrixWorld));
    const parentQ = new Quaternion(), world = new Quaternion();
    for (const id of this.springs) {
      const o = this.nodes.get(id);
      const t = qmul(this._toThree(h.rotation(id)), this.offset.get(id));
      world.copy(rootQ).multiply(new Quaternion(...t));
      if (o.parent) o.parent.getWorldQuaternion(parentQ); else parentQ.identity();
      o.quaternion.copy(parentQ.invert().multiply(world));
      o.updateMatrixWorld(true);
    }
  }

  /** Read the animated pose, step the physics `steps` times (1 per rendered 60 fps frame), write back. */
  update(steps = 1) {
    this.syncDrivers();
    for (let i = 0; i < steps; i++) this.rig.step();
    this.writeSprings();
  }

  /** Restart at the current animated pose, then settle for `warmupSteps` frames. */
  reset(warmupSteps = 0) {
    this.syncDrivers();
    this.rig.reset();
    for (let i = 0; i < warmupSteps; i++) this.rig.step();
    this.writeSprings();
  }
}

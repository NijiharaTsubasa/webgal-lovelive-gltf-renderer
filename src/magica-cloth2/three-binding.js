// three.js binding of the MagicaCloth2 port: mirror the animated skeleton into the Unity-space transform table of
// physics.source.magicaCloth2, run every MagicaCloth component once per rendered frame, write BoneCloth bones and
// MeshCloth vertices back.  The Unity -> three relation is fitted from the rest pose exactly like SpringBoneBinding
// (Horn's method with or without an X mirror, plus a constant per-node rotation offset).
import * as THREE from "three";
import { Hierarchy, qmul, qinv } from "../unity-springbone.js";
import { fitSimilarity, mirrorQ } from "../unity-springbone-three.js";
import { decodeMagicaCloth2 } from "./data.js";
import { MagicaClothTeam } from "./cloth.js";

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3();

export class MagicaClothBinding {
  /**
   * @param {object} source        physics.source.magicaCloth2
   * @param {THREE.Object3D} root  model root, at the rest pose the source transforms describe
   * @param {object} opt
   * @param {(node:number)=>THREE.Object3D} opt.resolve                       GLB node index -> object
   * @param {(node:number, primitive:number)=>THREE.SkinnedMesh} opt.resolvePrimitive
   */
  constructor(source, root, { resolve, resolvePrimitive }) {
    this.root = root;
    this.decoded = decodeMagicaCloth2(source);
    const h = this.h = new Hierarchy(source.transforms);
    this.teams = [];
    this.unsupported = [];
    // inertia anchor: the game anchors every cloth to the avatar root; the prefab root moves rigidly with it
    const anchorTransformId = source.transforms.find((t) => t.parentId === null || t.parentId === undefined)?.id ?? null;
    for (const def of this.decoded.cloths) {
      if (!def.enabled) continue;
      try { this.teams.push(new MagicaClothTeam(def, { anchorTransformId })); } catch (error) {
        this.unsupported.push({ buildId: def.buildId, transformId: def.transformId, reason: error.message });
      }
    }
    const needed = new Set();
    const addChain = (id) => { for (let k = id; k !== null && k !== undefined && !needed.has(k); k = h.parent.get(k)) needed.add(k); };
    for (const t of this.teams) for (const id of [...t.readTransformIds, ...t.writtenTransformIds]) addChain(id);
    this.nodes = new Map();
    for (const t of source.transforms) if (needed.has(t.id) && t.node !== null && t.node !== undefined) this.nodes.set(t.id, resolve(t.node));

    root.updateMatrixWorld(true);
    this._rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const pairs = [...this.nodes].map(([id, o]) => [h.position(id), this._rootLocalPos(o)]);
    if (this.teams.length && pairs.length < 3) throw new Error(`magicaCloth2: only ${pairs.length} transforms resolved to three.js nodes`);
    if (pairs.length >= 3) {
      const tryFit = (mirror) => ({ mirror, ...fitSimilarity(pairs.map(([u]) => (mirror ? [-u[0], u[1], u[2]] : u)), pairs.map(([, p]) => p)) });
      const fit = [tryFit(true), tryFit(false)].sort((a, b) => a.rms - b.rms)[0];
      Object.assign(this, { mirror: fit.mirror, R: fit.q, scale: fit.s, T: fit.t, rmsFitError: fit.rms });
    } else Object.assign(this, { mirror: true, R: [0, 0, 0, 1], scale: 1, T: [0, 0, 0], rmsFitError: 0 });
    this.offset = new Map();
    for (const [id, o] of this.nodes) this.offset.set(id, qmul(qinv(this._toThree(h.rotation(id))), this._rootLocalQuat(o)));

    const depthSort = (ids) => ids.sort((a, b) => h.depth(a) - h.depth(b));
    this.drivers = depthSort([...this.nodes.keys()]);
    // BoneCloth: written transforms, their initial local pose (MagicaCloth RestoreTransform target)
    this.bones = [];
    const written = new Set();
    for (const team of this.teams) {
      if (!team.proxy.isBoneCloth) continue;
      team.proxy.transformIds.slice(0, team.proxy.count).forEach((id, v) => {
        if ((team.state.attr[v] & 0x03) === 0) return;
        const node = this.nodes.get(id);
        if (!node) throw new Error(`magicaCloth2: BoneCloth transform ${h.name.get(id)} has no three.js node`);
        const p = team.proxy.parent[v];
        if (p >= 0 && h.parent.get(id) !== team.proxy.transformIds[p]) throw new Error(`magicaCloth2: ${h.name.get(id)} proxy parent is not its transform parent`);
        if (written.has(id)) throw new Error(`magicaCloth2: ${h.name.get(id)} is written by two cloths`);
        written.add(id);
        this.bones.push({ id, node, team, v, position: node.position.clone(), quaternion: node.quaternion.clone() });
      });
    }
    this.bones.sort((a, b) => h.depth(a.id) - h.depth(b.id));
    // MeshCloth: render meshes
    this.meshes = [];
    for (const team of this.teams) {
      if (team.proxy.isBoneCloth) continue;
      for (const mapping of team.def.mappings) {
        const ref = mapping.renderer?.mesh;
        if (!ref || ref.node === null || ref.node === undefined) throw new Error(`magicaCloth2: ${mapping.name} renderer mesh is not in the GLB`);
        if (ref.primitives !== 1) throw new Error(`magicaCloth2: ${mapping.name} has ${ref.primitives} primitives (vertex order unknown)`);
        const mesh = resolvePrimitive(ref.node, 0);
        if (!mesh?.isSkinnedMesh) throw new Error(`magicaCloth2: ${mapping.name} is not a SkinnedMesh`);
        this.meshes.push(new MappedMesh(mesh, mapping, team));
      }
    }
    this.report = {
      teams: this.teams.length, unsupported: this.unsupported, mirror: this.mirror, scale: this.scale, rmsFitError: this.rmsFitError,
      bones: this.bones.length, meshes: this.meshes.map((m) => `${m.mapping.name}:${m.written}`),
    };
  }

  /** three.js objects whose transform the solver writes. */
  get drivenObjects() { return this.bones.map((b) => b.node); }

  _rootLocalPos(o) { return tmpV.setFromMatrixPosition(o.matrixWorld).applyMatrix4(this._rootInv).toArray(); }
  _rootLocalQuat(o) {
    tmpM.multiplyMatrices(this._rootInv, o.matrixWorld);
    tmpQ.setFromRotationMatrix(tmpM.extractRotation(tmpM));
    return [tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w];
  }
  _toThree(u) { return qmul(this.R, this.mirror ? mirrorQ(u) : u); }
  _toUnity(t) { const q = qmul(qinv(this.R), t); return this.mirror ? mirrorQ(q) : q; }
  _posToUnity(p) {
    const v = new THREE.Vector3(p[0] - this.T[0], p[1] - this.T[1], p[2] - this.T[2])
      .applyQuaternion(new THREE.Quaternion(...this.R).invert()).multiplyScalar(1 / this.scale);
    return this.mirror ? [-v.x, v.y, v.z] : v.toArray();
  }
  /** Unity world point / direction -> three world */
  _posToWorld(u, out) {
    out.set(this.mirror ? -u[0] : u[0], u[1], u[2]).applyQuaternion(tmpQ.set(...this.R)).multiplyScalar(this.scale)
      .add(tmpV.set(...this.T)).applyMatrix4(this.root.matrixWorld);
    return out;
  }
  _dirToWorld(u, out) {
    out.set(this.mirror ? -u[0] : u[0], u[1], u[2]).applyQuaternion(tmpQ.set(...this.R)).transformDirection(this.root.matrixWorld);
    return out;
  }

  /** MagicaCloth RestoreTransform: BoneCloth bones back to their initial local pose (before the animation). */
  restore() {
    for (const b of this.bones) { b.node.position.copy(b.position); b.node.quaternion.copy(b.quaternion); b.node.updateMatrix(); }
  }

  /** Animated pose of the driver nodes -> Unity local transforms (parents first). */
  syncDrivers() {
    const h = this.h;
    this.root.updateMatrixWorld(true);
    this._rootInv.copy(this.root.matrixWorld).invert();
    for (const id of this.drivers) {
      const o = this.nodes.get(id);
      const worldRot = this._toUnity(qmul(this._rootLocalQuat(o), qinv(this.offset.get(id))));
      const worldPos = this._posToUnity(this._rootLocalPos(o));
      const p = h.parent.get(id);
      if (p === null) h.setLocal(id, { rot: worldRot, pos: worldPos });
      else h.setLocal(id, { rot: qmul(qinv(h.rotation(p)), worldRot), pos: h.inverseTransformPoint(p, worldPos) });
    }
  }

  world(id) {
    const m = this.h.matrix(id);   // row-major 3x4
    return {
      matrix: [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1],
      position: [m[3], m[7], m[11]], rotation: this.h.rotation(id),
      scale: [Math.hypot(m[0], m[4], m[8]), Math.hypot(m[1], m[5], m[9]), Math.hypot(m[2], m[6], m[10])],
    };
  }

  /** One rendered frame (after the animation and all LateUpdate behaviours): read, simulate, write. */
  update(deltaTime) {
    if (!this.teams.length) return;
    this.syncDrivers();
    const world = (id) => this.world(id);
    const outputs = new Map();
    for (const team of this.teams) outputs.set(team, team.frame(deltaTime, world));
    this.writeBones(outputs);
    for (const m of this.meshes) m.write(outputs.get(m.team).meshes.find((r) => r.mapping === m.mapping), this);
  }

  writeBones(outputs) {
    const h = this.h;
    if (!this.bones.length) return;
    for (const b of this.bones) {   // Unity side: TransformManager.WriteTransformJob (parents first)
      const o = outputs.get(b.team).bones[b.v];
      if (!o) continue;
      if (o.worldRotation) {
        const p = h.parent.get(b.id);
        h.setLocal(b.id, { rot: p === null ? o.worldRotation : qmul(qinv(h.rotation(p)), o.worldRotation) });
      } else h.setLocal(b.id, { pos: o.localPosition, rot: o.localRotation });
    }
    const rootQ = new THREE.Quaternion().setFromRotationMatrix(tmpM.extractRotation(this.root.matrixWorld));
    const parentQ = new THREE.Quaternion(), world = new THREE.Quaternion(), pos = new THREE.Vector3();
    for (const b of this.bones) {   // three side, parents first
      const o = b.node;
      const t = qmul(this._toThree(h.rotation(b.id)), this.offset.get(b.id));
      world.copy(rootQ).multiply(new THREE.Quaternion(...t));
      if (o.parent) { o.parent.updateWorldMatrix(true, false); o.parent.getWorldQuaternion(parentQ); } else parentQ.identity();
      o.quaternion.copy(parentQ.clone().invert().multiply(world));
      const out = outputs.get(b.team).bones[b.v];
      if (out?.localPosition) {
        this._posToWorld(h.position(b.id), pos);
        o.position.copy(o.parent ? o.parent.worldToLocal(pos) : pos);
      }
      o.updateMatrixWorld(true);
    }
  }

  reset() { for (const t of this.teams) t.reset(); }

  /** Undo every write (disabled physics). */
  release() {
    this.restore();
    for (const m of this.meshes) m.restore();
  }

  destroy() {
    this.restore();
    for (const m of this.meshes) m.destroy();
    this.meshes.length = 0;
    this.teams.length = 0;
  }
}

/** MeshCloth render mesh: world-space vertices written so that the SkinnedMesh displays them unchanged. */
class MappedMesh {
  constructor(mesh, mapping, team) {
    this.mesh = mesh; this.mapping = mapping; this.team = team;
    const geometry = mesh.geometry;
    this.sourcePosition = geometry.getAttribute("position");
    this.sourceNormal = geometry.getAttribute("normal");
    const n = mapping.referenceIndices.length;
    const maxRef = Math.max(...mapping.referenceIndices);
    if (maxRef >= this.sourcePosition.count) throw new Error(`magicaCloth2: ${mapping.name} references vertex ${maxRef} of ${this.sourcePosition.count}`);
    this.position = this.sourcePosition.clone().setUsage(THREE.DynamicDrawUsage);
    this.normal = this.sourceNormal ? this.sourceNormal.clone().setUsage(THREE.DynamicDrawUsage) : null;
    geometry.setAttribute("position", this.position);
    if (this.normal) geometry.setAttribute("normal", this.normal);
    this.written = mapping.attr.filter((a) => (a & 0x03) && !(a & 0x01)).length;
    this.wasCulled = mesh.frustumCulled;
    mesh.frustumCulled = false;
    // per render vertex: its skin binding (bone influences never change; vertices with equal influences share one)
    const joints = geometry.getAttribute("skinIndex"), weights = geometry.getAttribute("skinWeight");
    const shared = new Map();
    this.skinOf = new Array(n);
    for (let k = 0; k < n; k++) {
      const vi = mapping.referenceIndices[k], list = [];
      for (let c = 0; c < 4; c++) { const w = weights.getComponent(vi, c); if (w) list.push([joints.getComponent(vi, c), w]); }
      const key = list.map(([j, w]) => `${j}:${w}`).join(",");
      if (!shared.has(key)) shared.set(key, { influences: list, inverse: new THREE.Matrix4(), normal: new THREE.Matrix3() });
      this.skinOf[k] = shared.get(key);
    }
    this.skins = [...shared.values()];
    this.palette = mesh.skeleton.bones.map(() => new THREE.Matrix4());
    this.skin = new THREE.Matrix4();
    this.p = new THREE.Vector3(); this.nrm = new THREE.Vector3();
  }

  write(result, binding) {
    if (!result) return;
    const mesh = this.mesh, skeleton = mesh.skeleton;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < skeleton.bones.length; i++) this.palette[i].multiplyMatrices(skeleton.bones[i].matrixWorld, skeleton.boneInverses[i]);
    const meshInv = tmpM.copy(mesh.matrixWorld).invert();
    const morph = mesh.geometry.morphAttributes?.position, influences = mesh.morphTargetInfluences;
    const relative = mesh.geometry.morphTargetsRelative;
    for (const s of this.skins) {   // displayed = matrixWorld * bindMatrixInverse * sum(w * bone * boneInverse) * bindMatrix * p
      const e = this.skin.elements;
      e.fill(0);
      for (const [j, w] of s.influences) { const pe = this.palette[j].elements; for (let i = 0; i < 16; i++) e[i] += pe[i] * w; }
      this.skin.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
      s.inverse.copy(this.skin).invert();
      s.normal.setFromMatrix4(s.inverse);
    }
    for (let k = 0; k < result.positions.length; k++) {
      const p = result.positions[k];
      if (!p) continue;
      const vi = this.mapping.referenceIndices[k], skin = this.skinOf[k];
      binding._posToWorld(p, this.p).applyMatrix4(meshInv).applyMatrix4(skin.inverse);
      if (morph && influences) {   // the morph displacement is added before skinning: remove it again
        let base = 1;
        for (let t = 0; t < morph.length; t++) {
          const f = influences[t]; if (!f) continue;
          if (relative) this.p.x -= f * morph[t].getX(vi), this.p.y -= f * morph[t].getY(vi), this.p.z -= f * morph[t].getZ(vi);
          else base -= f;
        }
        if (!relative && base !== 1) throw new Error("magicaCloth2: absolute morph targets on a cloth mesh are not supported");
      }
      this.position.setXYZ(vi, this.p.x, this.p.y, this.p.z);
      if (this.normal && result.normals[k]) {
        binding._dirToWorld(result.normals[k], this.nrm).transformDirection(meshInv);
        this.nrm.applyMatrix3(skin.normal).normalize();
        this.normal.setXYZ(vi, this.nrm.x, this.nrm.y, this.nrm.z);
      }
    }
    this.position.needsUpdate = true;
    if (this.normal) this.normal.needsUpdate = true;
  }

  restore() {
    this.position.copy(this.sourcePosition); this.position.needsUpdate = true;
    if (this.normal) { this.normal.copy(this.sourceNormal); this.normal.needsUpdate = true; }
  }

  destroy() {
    this.mesh.geometry.setAttribute("position", this.sourcePosition);
    if (this.sourceNormal) this.mesh.geometry.setAttribute("normal", this.sourceNormal);
    this.mesh.frustumCulled = this.wasCulled;
  }
}

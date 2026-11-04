import * as THREE from "three";
import { primitiveMesh, morphTerms } from "./cloth-geometry.js";
import { maximumStretch } from "./physics-math.js";
import { buildClothProxy } from "./cloth-proxy.js";
import { ProxyClothSolver, COLLIDER, COLLIDER_STRIDE } from "./proxy-cloth-solver.js";
export { clothTopology, vertexSkinMatrix } from "./cloth-geometry.js";
const STEP = 1 / 60;
// A particle may leave its animated position by at most this fraction of its
// rest distance (along the cloth) from the nearest fixed particle.
const MAX_DISTANCE = .5;

/**
 * Mesh cloth driven by a reduced proxy surface.
 *
 * Only the sparse proxy particles are simulated. Every render vertex keeps its
 * own animated skinning S and adds the interpolated displacement of up to four
 * proxies: S + sum_i w_i (P_i - T_i), with P_i simulated and T_i animated. At
 * rest (P = T) this is exactly the original skinned mesh, so the cloth never
 * drifts from the authored shape. Normals and tangents turn with the change of
 * the render surface itself, keeping their authored smoothing.
 */
class Cloth {
  constructor(root, definition, physics, resolve, resolvePrimitive) {
    this.root = root; this.definition = definition;
    this.physics = physics; this.resolve = resolve;
    this.mesh = resolvePrimitive ? resolvePrimitive(definition.node, definition.primitive)
      : primitiveMesh(resolve(definition.node), definition.primitive);
    if (!this.mesh?.isSkinnedMesh) throw new Error("cloth primitive 不是 SkinnedMesh");
    this.geometry = this.mesh.geometry;
    this.sourcePosition = this.geometry.getAttribute("position");
    this.sourceNormal = this.geometry.getAttribute("normal");
    this.sourceTangent = this.geometry.getAttribute("tangent") ?? null;
    if (!this.sourceNormal) throw new Error("cloth 需要 NORMAL 数据");
    this.proxy = buildClothProxy(this.geometry, definition.fixed, definition.proxy);
    this.topology = this.proxy.topology;
    this.changedAttributes = false;
    try {
      this.colliders = mergeCapsuleChains(definition.colliders.map((i) => {
        const source = physics.colliders[i];
        return { definition: source, node: resolve(source.node), tail: source.tail ? resolve(source.tail.node) : null };
      }));
      this.prepareVertices();
      this.prepareSkin();
      const count = this.proxy.count;
      this.targets = new Float64Array(count * 3);
      this.targetNormals = new Float64Array(count * 3);
      this.particleRadius = new Float64Array(count);
      this.maxDistance = new Float64Array(count);
      this.colliderData = new Float64Array(this.colliders.length * COLLIDER_STRIDE);
      this.renderPoint = new Float64Array(3);
      this.solver = new ProxyClothSolver({
        count, edges: this.proxy.edges, bends: this.proxy.bends, fixed: this.proxy.fixed,
        colliderTypes: this.colliders.map((r) => COLLIDER[r.shape]),
        minimumGap: 0,
      });
      this.position = new THREE.BufferAttribute(this.restPosition.slice(), 3).setUsage(THREE.DynamicDrawUsage);
      this.normal = new THREE.BufferAttribute(this.restNormal.slice(), 3).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute("position", this.position);
      this.geometry.setAttribute("normal", this.normal);
      if (this.sourceTangent) {
        this.tangent = new THREE.BufferAttribute(this.restTangent.slice(), 4).setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute("tangent", this.tangent);
      }
      this.changedAttributes = true;
      this.dirty = false;
      this.accumulator = 0; this.needsReset = true; this.warmupSteps = 30;
      this.wasCulled = this.mesh.frustumCulled;
      this.mesh.frustumCulled = false;
      this.scratch = { linear: new THREE.Matrix3(), point: new THREE.Vector3(), axis: new THREE.Vector3() };
    } catch (error) { this.destroy(); throw error; }
  }

  prepareVertices() {
    // Accessors denormalize quantized glTF attributes; getComponent does not.
    const getters = ["getX", "getY", "getZ", "getW"];
    const read = (attribute, size) => {
      const out = new Float32Array(attribute.count * size);
      for (let i = 0; i < attribute.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = attribute[getters[k]](i);
      return out;
    };
    this.restPosition = read(this.sourcePosition, 3);
    this.restNormal = read(this.sourceNormal, 3);
    this.restTangent = this.sourceTangent ? read(this.sourceTangent, 4) : null;
    const { indices, weights } = this.proxy.weights, fixed = this.proxy.fixed;
    const all = [...this.topology.mapping].flatMap((m, i) => m >= 0 ? [i] : []);
    // Vertices skinned only to fixed proxies never deviate from animation.
    this.active = Uint32Array.from(all.filter((v) => {
      for (let k = 0; k < 4; k++) if (indices[v * 4 + k] >= 0 && weights[v * 4 + k] > 0 && !fixed[indices[v * 4 + k]]) return true;
      return false;
    }));
    const nodes = this.topology.vertices.length;
    this.activeNode = new Uint8Array(nodes);
    for (const v of this.active) this.activeNode[this.topology.mapping[v]] = 1;
    this.activeNodes = Uint32Array.from({ length: nodes }, (_, i) => i).filter((i) => this.activeNode[i]);
    // Normals of active vertices need every welded triangle around them.
    const welded = this.topology.indices, normalTriangles = [], needed = new Uint8Array(nodes);
    for (let t = 0; t < welded.length; t += 3) {
      if (!this.activeNode[welded[t]] && !this.activeNode[welded[t + 1]] && !this.activeNode[welded[t + 2]]) continue;
      normalTriangles.push(welded[t], welded[t + 1], welded[t + 2]);
      needed[welded[t]] = needed[welded[t + 1]] = needed[welded[t + 2]] = 1;
    }
    this.normalTriangles = Uint32Array.from(normalTriangles);
    this.neededNodes = Uint32Array.from({ length: nodes }, (_, i) => i).filter((i) => needed[i]);
    this.referenceNodes = new Float64Array(nodes * 3);
    // Only skin what the simulation reads: proxy members, active vertices and
    // the welded representatives used for their surface normals.
    const used = new Set([...this.proxy.members, ...this.active]);
    needed.forEach((flag, node) => { if (flag) used.add(this.topology.vertices[node]); });
    this.used = Uint32Array.from([...used].sort((a, b) => a - b));
    this.final = new Float64Array(nodes * 3);
    // Outward side per welded vertex: the mean of its authored normals. Hard
    // edges keep a sensible average; back-to-back faces of double-sided cloth
    // cancel, so no backstop is applied where "outside" is undefined.
    this.nodeNormal = new Float64Array(nodes * 3);
    all.forEach((v) => {
      const f = this.topology.mapping[v] * 3;
      for (let k = 0; k < 3; k++) this.nodeNormal[f + k] += this.restNormal[v * 3 + k];
    });
    const members = new Uint32Array(nodes);
    all.forEach((v) => members[this.topology.mapping[v]]++);
    for (let node = 0; node < nodes; node++) {
      const f = node * 3, length = Math.hypot(this.nodeNormal[f], this.nodeNormal[f + 1], this.nodeNormal[f + 2]);
      // Less than half of the members agreeing: treat as undefined.
      const scale = length > .5 * members[node] ? 1 / length : 0;
      for (let k = 0; k < 3; k++) this.nodeNormal[f + k] *= scale;
    }
    this.referenceGeometryNormal = new Float64Array(nodes * 3);
    this.finalGeometryNormal = new Float64Array(nodes * 3);
    // Bounds of everything the cloth never moves, extended per frame.
    const isActive = new Uint8Array(this.sourcePosition.count);
    for (const v of this.active) isActive[v] = 1;
    this.staticBounds = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    for (let v = 0; v < this.sourcePosition.count; v++) {
      if (isActive[v]) continue;
      for (let k = 0; k < 3; k++) {
        const value = this.restPosition[v * 3 + k];
        if (value < this.staticBounds[k]) this.staticBounds[k] = value;
        if (value > this.staticBounds[k + 3]) this.staticBounds[k + 3] = value;
      }
    }
    this.morphs = (this.geometry.morphAttributes.position?.length ?? 0) > 0;
    this.skinned = new Float64Array(this.sourcePosition.count * 3);
  }

  prepareSkin() {
    const joints = this.geometry.getAttribute("skinIndex"), weights = this.geometry.getAttribute("skinWeight");
    const bindings = new Map(), usedBones = new Map(), joint = [], weight = [];
    this.vertexBinding = new Int32Array(this.sourcePosition.count).fill(-1);
    for (const index of this.used) {
      const key = [0, 1, 2, 3].map((k) => `${joints.getComponent(index, k)}:${weights.getComponent(index, k)}`).join(",");
      let binding = bindings.get(key);
      if (binding === undefined) {
        binding = bindings.size;
        bindings.set(key, binding);
        for (let k = 0; k < 4; k++) {
          const w = weights.getComponent(index, k);
          const bone = joints.getComponent(index, k);
          if (w && !usedBones.has(bone)) usedBones.set(bone, usedBones.size);
          joint.push(w ? usedBones.get(bone) : -1); weight.push(w);
        }
      }
      this.vertexBinding[index] = binding;
    }
    // Skin palette over referenced bones only, each already including the
    // mesh world and bind matrices: A = sum_j w_j (M Bind^-1 B_j Bind).
    this.skinBones = [...usedBones.keys()];
    this.palette = new Float64Array(this.skinBones.length * 16);
    this.bindingJoint = Int32Array.from(joint);
    this.bindingWeight = Float64Array.from(weight);
    this.bindingCount = bindings.size;
    // Per binding: affine render-local -> world matrix (column-major 16)
    // and the row-major inverse of its linear part (9).
    this.bindingMatrix = new Float64Array(this.bindingCount * 16);
    this.bindingInverse = new Float64Array(this.bindingCount * 9);
    this.boneMatrix = new THREE.Matrix4();
  }

  /** Animated (unsimulated) skinning of every cloth vertex, plus proxy targets. */
  sampleTargets() {
    const mesh = this.mesh, skeleton = mesh.skeleton, bone = this.boneMatrix, palette = this.palette;
    mesh.updateWorldMatrix(true, false);
    this.skinBones.forEach((index, j) => {
      bone.multiplyMatrices(skeleton.bones[index].matrixWorld, skeleton.boneInverses[index])
        .premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix).premultiply(mesh.matrixWorld);
      palette.set(bone.elements, j * 16);
    });
    const joints = this.bindingJoint, weights = this.bindingWeight, matrix = this.bindingMatrix, inverse = this.bindingInverse;
    for (let b = 0; b < this.bindingCount; b++) {
      const o = b * 16;
      for (let j = 0; j < 16; j++) matrix[o + j] = 0;
      for (let k = 0; k < 4; k++) {
        const bone = joints[b * 4 + k];
        if (bone < 0) continue;
        const w = weights[b * 4 + k], p = bone * 16;
        for (let j = 0; j < 16; j++) matrix[o + j] += palette[p + j] * w;
      }
      // Column-major linear part: L = [e0 e4 e8; e1 e5 e9; e2 e6 e10].
      const a00 = matrix[o], a01 = matrix[o + 4], a02 = matrix[o + 8];
      const a10 = matrix[o + 1], a11 = matrix[o + 5], a12 = matrix[o + 9];
      const a20 = matrix[o + 2], a21 = matrix[o + 6], a22 = matrix[o + 10];
      const c00 = a11 * a22 - a12 * a21, c01 = a02 * a21 - a01 * a22, c02 = a01 * a12 - a02 * a11;
      const det = a00 * c00 + a10 * c01 + a20 * c02;
      if (!(Math.abs(det) > 1e-18)) throw new Error("cloth 蒙皮矩阵不可逆");
      const p = b * 9, id = 1 / det;
      inverse[p] = c00 * id; inverse[p + 1] = c01 * id; inverse[p + 2] = c02 * id;
      inverse[p + 3] = (a12 * a20 - a10 * a22) * id; inverse[p + 4] = (a00 * a22 - a02 * a20) * id; inverse[p + 5] = (a02 * a10 - a00 * a12) * id;
      inverse[p + 6] = (a10 * a21 - a11 * a20) * id; inverse[p + 7] = (a01 * a20 - a00 * a21) * id; inverse[p + 8] = (a00 * a11 - a01 * a10) * id;
    }
    const rest = this.restPosition, S = this.skinned, m = this.bindingMatrix, morph = this.scratch.point;
    for (const v of this.used) {
      let x = rest[v * 3], y = rest[v * 3 + 1], z = rest[v * 3 + 2];
      if (this.morphs) {
        const base = morphTerms(mesh, v, "position", morph);
        x = x * base + morph.x; y = y * base + morph.y; z = z * base + morph.z;
      }
      const o = this.vertexBinding[v] * 16;
      S[v * 3] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
      S[v * 3 + 1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
      S[v * 3 + 2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
    }
    const { members, memberStart, count } = this.proxy, T = this.targets;
    for (let c = 0; c < count; c++) {
      let x = 0, y = 0, z = 0;
      const start = memberStart[c], end = memberStart[c + 1];
      for (let k = start; k < end; k++) { const v = members[k] * 3; x += S[v]; y += S[v + 1]; z += S[v + 2]; }
      const n = end - start;
      T[c * 3] = x / n; T[c * 3 + 1] = y / n; T[c * 3 + 2] = z / n;
    }
    proxyNormals(this.proxy.triangles, T, this.targetNormals, this.proxy.orientation);
    const scale = maximumStretch(mesh.matrixWorld);
    // Contact radius: the cloth gap plus how far member vertices sit behind
    // their proxy, so the merged surface keeps all of them off the body.
    const thickness = this.proxy.thickness;
    for (let c = 0; c < count; c++) this.particleRadius[c] = scale * (this.definition.radius + thickness[c]);
    this.solver.minimumGap = this.definition.radius * scale;
    this.solver.contactMargin = this.proxy.extent * scale;
    const depth = this.proxy.depth;
    for (let c = 0; c < count; c++) this.maxDistance[c] = scale * MAX_DISTANCE * depth[c];
  }

  colliderPoses() {
    const out = this.colliderData, point = this.scratch.point, axis = this.scratch.axis, linear = this.scratch.linear;
    this.colliders.forEach((r, k) => {
      const d = r.definition, o = k * COLLIDER_STRIDE;
      r.node.updateWorldMatrix(true, false);
      point.fromArray(d.offset).applyMatrix4(r.node.matrixWorld);
      out[o] = point.x; out[o + 1] = point.y; out[o + 2] = point.z;
      if (r.shape === "sphere" || r.shape === "capsule") {
        const scale = maximumStretch(r.node.matrixWorld);
        out[o + 6] = Math.max(1e-7, r.radius[0] * scale);
        out[o + 7] = Math.max(1e-7, r.radius[1] * scale);
        if (r.tail) {
          r.tail.updateWorldMatrix(true, false);
          point.fromArray(r.tailOffset).applyMatrix4(r.tail.matrixWorld);
        }
        out[o + 3] = point.x; out[o + 4] = point.y; out[o + 5] = point.z;
      } else if (r.shape === "plane") {
        axis.fromArray(d.normal).applyNormalMatrix(linear.getNormalMatrix(r.node.matrixWorld));
        out[o + 7] = axis.x; out[o + 8] = axis.y; out[o + 9] = axis.z;
      } else {
        linear.setFromMatrix4(r.node.matrixWorld);
        d.halfAxes.forEach((half, j) => {
          axis.fromArray(half).applyMatrix3(linear);
          out[o + 7 + j * 3] = axis.x; out[o + 8 + j * 3] = axis.y; out[o + 9 + j * 3] = axis.z;
        });
      }
    });
    return out;
  }

  restore() {
    if (!this.changedAttributes || !this.dirty) return;
    this.position.array.set(this.restPosition); this.normal.array.set(this.restNormal);
    this.position.needsUpdate = true; this.normal.needsUpdate = true;
    if (this.tangent) { this.tangent.array.set(this.restTangent); this.tangent.needsUpdate = true; }
    this.dirty = false;
  }

  initialize() {
    const colliders = this.colliderPoses();
    this.solver.reset(this.targets, colliders);
    // Settle initial overlap at the frozen pose before the first display.
    for (let i = 0; i < this.warmupSteps; i++) this.step(colliders);
    this.needsReset = false;
  }

  step(colliders = this.colliderPoses()) {
    const d = this.definition;
    this.solver.step({ targets: this.targets, normals: this.targetNormals, colliders, radius: this.particleRadius,
      stiffness: d.stiffness, damping: d.damping, gravity: d.gravity, delta: STEP, backstop: 0,
      maxDistance: this.maxDistance });
  }

  writeGeometry() {
    const P = this.solver.positions, T = this.targets, S = this.skinned, F = this.final;
    const { indices, weights } = this.proxy.weights, { mapping, vertices } = this.topology;
    const restNormal = this.restNormal, inverse = this.bindingInverse, binding = this.vertexBinding;
    const solver = this.solver, gap = solver.minimumGap, near = solver.near, point = this.renderPoint;
    const activeNodes = this.activeNodes, nodeNormal = this.nodeNormal;
    // 1. Simulated world position per welded vertex. Positions follow the
    // proxies by translation only: sum_i w_i (P_i - T_i) is a smooth field,
    // whereas per-proxy rotations of a sparse surface are too noisy for
    // pleats and layered fabric.
    for (let a = 0; a < activeNodes.length; a++) {
      const node = activeNodes[a], v = vertices[node], o = v * 3, w4 = v * 4, f = node * 3;
      const sx = S[o], sy = S[o + 1], sz = S[o + 2];
      let fx = sx, fy = sy, fz = sz, contact = 0;
      for (let k = 0; k < 4; k++) {
        const proxy = indices[w4 + k];
        if (proxy < 0) break;
        const w = weights[w4 + k], p = proxy * 3;
        contact |= near[proxy];
        fx += w * (P[p] - T[p]); fy += w * (P[p + 1] - T[p + 1]); fz += w * (P[p + 2] - T[p + 2]);
      }
      // Like the proxies, a render vertex never folds behind its own animated
      // surface: the artist's skinned pose already clears the body there.
      const ib = binding[v] * 9, rx = nodeNormal[f], ry = nodeNormal[f + 1], rz = nodeNormal[f + 2];
      const nx = inverse[ib] * rx + inverse[ib + 3] * ry + inverse[ib + 6] * rz;
      const ny = inverse[ib + 1] * rx + inverse[ib + 4] * ry + inverse[ib + 7] * rz;
      const nz = inverse[ib + 2] * rx + inverse[ib + 5] * ry + inverse[ib + 8] * rz;
      const nn = nx * nx + ny * ny + nz * nz;
      if (nn > 1e-30) {
        const behind = (fx - sx) * nx + (fy - sy) * ny + (fz - sz) * nz;
        if (behind < 0) { const k = behind / nn; fx -= nx * k; fy -= ny * k; fz -= nz * k; }
      }
      // The proxy surface keeps clear of colliders; render vertices hanging
      // between or behind those proxies get the same minimum clearance.
      if (contact) {
        point[0] = fx; point[1] = fy; point[2] = fz;
        solver.collidePoint(point, 0, gap, S, null, o, contact);
        fx = point[0]; fy = point[1]; fz = point[2];
      }
      if (!Number.isFinite(fx + fy + fz)) throw new Error("cloth 求解产生非有限坐标");
      F[f] = fx; F[f + 1] = fy; F[f + 2] = fz;
    }
    // 2. Geometric normals of the animated and simulated surfaces; the
    // authored normal turns by the same amount, keeping its smoothing.
    const GS = this.referenceGeometryNormal, GF = this.finalGeometryNormal, R = this.referenceNodes;
    const needed = this.neededNodes, activeNode = this.activeNode;
    for (let i = 0; i < needed.length; i++) {
      const node = needed[i], f = node * 3, o = vertices[node] * 3;
      R[f] = S[o]; R[f + 1] = S[o + 1]; R[f + 2] = S[o + 2];
      if (!activeNode[node]) { F[f] = S[o]; F[f + 1] = S[o + 1]; F[f + 2] = S[o + 2]; }
    }
    surfaceNormals(this.normalTriangles, R, GS);
    surfaceNormals(this.normalTriangles, F, GF);
    // 3. Write render-local attributes through each vertex's inverse skinning.
    const rest = this.restPosition, restTangent = this.restTangent, m = this.bindingMatrix;
    const out = this.position.array, outNormal = this.normal.array, outTangent = this.tangent?.array;
    const morph = this.scratch.point, morphs = this.morphs, mesh = this.mesh, active = this.active;
    for (let a = 0; a < active.length; a++) {
      const v = active[a], o = v * 3, node = mapping[v], f = node * 3, b = binding[v], ib = b * 9, mb = b * 16;
      const ex = F[f] - S[vertices[node] * 3], ey = F[f + 1] - S[vertices[node] * 3 + 1], ez = F[f + 2] - S[vertices[node] * 3 + 2];
      const base = morphs ? morphTerms(mesh, v, "position", morph) : 1;
      out[o] = rest[o] + (inverse[ib] * ex + inverse[ib + 1] * ey + inverse[ib + 2] * ez) / base;
      out[o + 1] = rest[o + 1] + (inverse[ib + 3] * ex + inverse[ib + 4] * ey + inverse[ib + 5] * ez) / base;
      out[o + 2] = rest[o + 2] + (inverse[ib + 6] * ex + inverse[ib + 7] * ey + inverse[ib + 8] * ez) / base;
      // Shortest-arc turn from the animated to the simulated surface normal.
      const ax = GS[f], ay = GS[f + 1], az = GS[f + 2], bx = GF[f], by = GF[f + 1], bz = GF[f + 2];
      const cos = ax * bx + ay * by + az * bz;
      if (!(cos > -.999) || cos > 1 - 1e-12) {
        if (outNormal[o] !== restNormal[o] || outNormal[o + 1] !== restNormal[o + 1] || outNormal[o + 2] !== restNormal[o + 2]) {
          outNormal[o] = restNormal[o]; outNormal[o + 1] = restNormal[o + 1]; outNormal[o + 2] = restNormal[o + 2];
          if (restTangent) for (let k = 0; k < 3; k++) outTangent[v * 4 + k] = restTangent[v * 4 + k];
        }
        continue;
      }
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx, h = 1 / (1 + cos);
      // Skinned world normal L^-T n (L^-1 row-major), turned, then back: L^T n'.
      const rx = restNormal[o], ry = restNormal[o + 1], rz = restNormal[o + 2];
      const nx = inverse[ib] * rx + inverse[ib + 3] * ry + inverse[ib + 6] * rz;
      const ny = inverse[ib + 1] * rx + inverse[ib + 4] * ry + inverse[ib + 7] * rz;
      const nz = inverse[ib + 2] * rx + inverse[ib + 5] * ry + inverse[ib + 8] * rz;
      let d = (cx * nx + cy * ny + cz * nz) * h;
      const tx = nx * cos + (cy * nz - cz * ny) + cx * d;
      const ty = ny * cos + (cz * nx - cx * nz) + cy * d;
      const tz = nz * cos + (cx * ny - cy * nx) + cz * d;
      let lnx = m[mb] * tx + m[mb + 1] * ty + m[mb + 2] * tz;
      let lny = m[mb + 4] * tx + m[mb + 5] * ty + m[mb + 6] * tz;
      let lnz = m[mb + 8] * tx + m[mb + 9] * ty + m[mb + 10] * tz;
      const nl = Math.sqrt(lnx * lnx + lny * lny + lnz * lnz);
      if (nl > 1e-20) {
        lnx /= nl; lny /= nl; lnz /= nl;
        if (morphs) {
          const normalBase = morphTerms(mesh, v, "normal", morph);
          lnx = (lnx - morph.x) / normalBase; lny = (lny - morph.y) / normalBase; lnz = (lnz - morph.z) / normalBase;
        }
        outNormal[o] = lnx; outNormal[o + 1] = lny; outNormal[o + 2] = lnz;
      }
      if (restTangent) {
        // Tangents transform with L; turn them by the same rotation.
        const w4 = v * 4, qx = restTangent[w4], qy = restTangent[w4 + 1], qz = restTangent[w4 + 2];
        const wx = m[mb] * qx + m[mb + 4] * qy + m[mb + 8] * qz;
        const wy = m[mb + 1] * qx + m[mb + 5] * qy + m[mb + 9] * qz;
        const wz = m[mb + 2] * qx + m[mb + 6] * qy + m[mb + 10] * qz;
        d = (cx * wx + cy * wy + cz * wz) * h;
        const ux = wx * cos + (cy * wz - cz * wy) + cx * d;
        const uy = wy * cos + (cz * wx - cx * wz) + cy * d;
        const uz = wz * cos + (cx * wy - cy * wx) + cz * d;
        const bx2 = inverse[ib] * ux + inverse[ib + 1] * uy + inverse[ib + 2] * uz;
        const by2 = inverse[ib + 3] * ux + inverse[ib + 4] * uy + inverse[ib + 5] * uz;
        const bz2 = inverse[ib + 6] * ux + inverse[ib + 7] * uy + inverse[ib + 8] * uz;
        const tl = Math.sqrt(bx2 * bx2 + by2 * by2 + bz2 * bz2);
        if (tl > 1e-20) { outTangent[w4] = bx2 / tl; outTangent[w4 + 1] = by2 / tl; outTangent[w4 + 2] = bz2 / tl; }
      }
    }
    this.position.needsUpdate = true; this.normal.needsUpdate = true;
    if (this.tangent) this.tangent.needsUpdate = true;
    this.dirty = true;
    this.updateBounds();
  }

  /** All shader passes share this geometry; keep its bounds valid, cheaply. */
  updateBounds() {
    const array = this.position.array, active = this.active, box = this.staticBounds;
    let x0 = box[0], y0 = box[1], z0 = box[2], x1 = box[3], y1 = box[4], z1 = box[5];
    for (let i = 0; i < active.length; i++) {
      const o = active[i] * 3, x = array[o], y = array[o + 1], z = array[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const geometry = this.geometry;
    geometry.boundingBox ??= new THREE.Box3();
    geometry.boundingSphere ??= new THREE.Sphere();
    geometry.boundingBox.min.set(x0, y0, z0); geometry.boundingBox.max.set(x1, y1, z1);
    geometry.boundingBox.getCenter(geometry.boundingSphere.center);
    geometry.boundingSphere.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
  }

  update(delta) {
    this.sampleTargets();
    if (this.needsReset) this.initialize();
    this.accumulator += Math.min(delta, 0.1);
    const steps = Math.floor((this.accumulator + 1e-10) / STEP);
    if (steps) {
      const colliders = this.colliderPoses();
      // Several steps per call only happen when the caller skipped frames;
      // the solver interpolates within each step from its last sample.
      for (let i = 0; i < steps; i++) { this.step(colliders); this.accumulator -= STEP; }
    }
    this.writeGeometry();
  }

  destroy() {
    if (this.changedAttributes) {
      this.geometry.setAttribute("position", this.sourcePosition);
      this.geometry.setAttribute("normal", this.sourceNormal);
      if (this.sourceTangent) this.geometry.setAttribute("tangent", this.sourceTangent);
      this.geometry.computeBoundingBox(); this.geometry.computeBoundingSphere();
      this.mesh.frustumCulled = this.wasCulled;
      this.changedAttributes = false;
    }
    this.solver = null;
  }
}

/**
 * Converters may approximate one tapered capsule by a chain of collinear
 * constant-radius pieces on the same node. Collision against the original
 * tapered capsule is both cheaper and smoother: rebuild it, keeping the
 * pieces' conservative envelope (radius linear from first to last piece).
 */
function mergeCapsuleChains(records) {
  const out = [];
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1e-7 * Math.max(1, Math.abs(v)));
  for (const r of records) {
    const d = r.definition, previous = out[out.length - 1];
    const radius = d.shape === "sphere" || d.shape === "capsule" ? [d.radius, d.radius] : null;
    const tailOffset = d.shape === "capsule" ? d.tail.offset : d.offset;
    if (d.shape === "capsule" && previous?.shape === "capsule" && previous.node === r.node
      && previous.tail === r.node && r.tail === r.node && same(previous.tailOffset, d.offset)) {
      const u = previous.tailOffset.map((v, i) => v - previous.definition.offset[i]);
      const w = d.tail.offset.map((v, i) => v - d.offset[i]);
      const lu = Math.hypot(...u), lw = Math.hypot(...w);
      const radii = [...previous.pieces, d.radius];
      const step = radii[1] - radii[0];
      const linear = radii.every((value, i) => !i || Math.abs(value - radii[i - 1] - step) <= 1e-6 * Math.max(1e-3, Math.abs(value)));
      if (lu > 0 && lw > 0 && u.reduce((s, v, i) => s + v * w[i], 0) / (lu * lw) > 1 - 1e-6 && linear) {
        previous.tailOffset = d.tail.offset;
        previous.pieces.push(d.radius);
        previous.radius = [previous.pieces[0], d.radius];
        continue;
      }
    }
    out.push({ ...r, shape: d.shape, radius, tailOffset, pieces: radius ? [d.radius] : [] });
  }
  return out;
}

/** Area-weighted proxy surface normals for the given positions. */
function proxyNormals(triangles, positions, out, orientation) {
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

/** Area-weighted vertex normals of a triangle list over node positions. */
function surfaceNormals(indices, positions, out) {
  out.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const ux = positions[b] - ax, uy = positions[b + 1] - ay, uz = positions[b + 2] - az;
    const vx = positions[c] - ax, vy = positions[c + 1] - ay, vz = positions[c + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.sqrt(out[i] * out[i] + out[i + 1] * out[i + 1] + out[i + 2] * out[i + 2]);
    if (l > 1e-30) { out[i] /= l; out[i + 1] /= l; out[i + 2] /= l; }
  }
}

export async function createMeshCloth(root, definitions) {
  const entries = definitions.flatMap(({ physics, resolve, resolvePrimitive }) => (physics.cloths ?? []).map((definition) => ({ definition, physics, resolve, resolvePrimitive })));
  const records = [];
  let enabled = true;
  const system = {
    records,
    beforeAnimation() { for (const cloth of records) cloth.restore(); },
    update(delta) {
      if (!Number.isFinite(delta) || delta < 0) throw new Error("cloth delta 必须为非负有限数");
      if (!enabled) return;
      for (const cloth of records) cloth.update(delta);
    },
    reset(warmupSteps = 30) { for (const cloth of records) { cloth.needsReset = true; cloth.accumulator = 0; cloth.warmupSteps = warmupSteps; } },
    setEnabled(value) { system.beforeAnimation(); enabled = Boolean(value); system.reset(); },
    destroy() { for (const cloth of records) cloth.destroy(); records.length = 0; },
  };
  if (!entries.length) return system;

  const geometries = new Set();
  try {
    for (const { definition, physics, resolve, resolvePrimitive } of entries) {
      const mesh = resolvePrimitive ? resolvePrimitive(definition.node, definition.primitive)
        : primitiveMesh(resolve(definition.node), definition.primitive);
      const geometry = mesh.geometry;
      if (geometries.has(geometry)) throw new Error("cloth 不得重复控制同一 geometry");
      geometries.add(geometry);
      records.push(new Cloth(root, definition, physics, resolve, resolvePrimitive));
    }
  } catch (error) { system.destroy(); throw error; }
  return system;
}

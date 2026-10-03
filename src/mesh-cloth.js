import * as THREE from "three";
import { clothTopology, primitiveMesh, morphTerms } from "./cloth-geometry.js";
import { maximumStretch } from "./physics-math.js";
import { createJoltClothSolver } from "./jolt-cloth-solver.js";
export { clothTopology, vertexSkinMatrix } from "./cloth-geometry.js";
const STEP = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);
const isIdentity = (matrix) => matrix.elements.every((value, i) => Object.is(value, i % 5 === 0 ? 1 : 0));
const identityPreserves = (elements) => {
  for (let i = 0; i < 16; i += 1) {
    const value = elements[i];
    if (!Number.isFinite(value) || Object.is(value, -0)) return false;
  }
  return true;
};

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
    if (!this.sourceNormal) throw new Error("cloth 需要 NORMAL 数据");
    this.topology = clothTopology(this.geometry, definition.fixed);
    this.solver = null;
    this.changedAttributes = false;
    try {
      this.colliders = definition.colliders.map((i) => {
        const source = physics.colliders[i];
        return { definition: source, node: resolve(source.node), tail: source.tail ? resolve(source.tail.node) : null };
      });
      this.position = this.sourcePosition.clone().setUsage(THREE.DynamicDrawUsage);
      this.normal = this.sourceNormal.clone().setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute("position", this.position);
      this.geometry.setAttribute("normal", this.normal);
      this.changedAttributes = true;
      this.targets = this.topology.vertices.map(() => new THREE.Vector3());
      this.previousTargets = this.targets.map(() => new THREE.Vector3());
      this.positions = this.targets.map(() => new THREE.Vector3());
      this.normals = this.targets.map(() => new THREE.Vector3());
      this.skinPalette = this.mesh.skeleton.bones.map(() => new THREE.Matrix4());
      this.skinBindings = [];
      const usedBones = new Set();
      const bindings = new Map(), joints = this.geometry.getAttribute("skinIndex"), weights = this.geometry.getAttribute("skinWeight");
      this.vertexBindings = Array.from({ length: this.position.count }, (_, index) => {
        if (this.topology.mapping[index] < 0) return null;
        const key = [0, 1, 2, 3].map((k) => `${joints.getComponent(index, k)}:${weights.getComponent(index, k)}`).join(",");
        let binding = bindings.get(key);
        if (!binding) {
          const influences = [];
          for (let k = 0; k < 4; k += 1) {
            const weight = weights.getComponent(index, k);
            if (weight) {
              const joint = joints.getComponent(index, k);
              usedBones.add(joint);
              influences.push({ weight, elements: this.skinPalette[joint].elements });
            }
          }
          binding = { index, influences, matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4() };
          bindings.set(key, binding); this.skinBindings.push(binding);
        }
        return binding;
      });
      this.skinBoneIndices = [...usedBones].sort((a, b) => a - b);
      this.inverseSkin = this.vertexBindings.map((binding) => binding?.inverse);
      this.inverseWorld = new THREE.Matrix4();
      this.normalToLocal = new THREE.Matrix3();
      this.sampleMorph = new THREE.Vector3();
      this.writeScratch = {
        edgeA: new THREE.Vector3(), edgeB: new THREE.Vector3(),
        p: new THREE.Vector3(), n: new THREE.Vector3(), morph: new THREE.Vector3(),
        normalInverse: new THREE.Matrix3(),
      };
      this.accumulator = 0; this.needsReset = true; this.warmupSteps = 30;
      this.wasCulled = this.mesh.frustumCulled;
      this.mesh.frustumCulled = false;
    } catch (error) { this.destroy(); throw error; }
  }

  async connect() {
    this.sampleTargets();
    this.solver = await createJoltClothSolver({
      positions: this.targets, indices: this.topology.indices, fixed: this.topology.fixed,
      radius: this.radius(), damping: this.definition.damping, colliders: this.colliderPoses(),
    });
    this.stepTargets = this.targets.map((p) => p.clone());
    this.stepPreviousTargets = this.targets.map((p) => p.clone());
  }

  radius() { return this.definition.radius * maximumStretch(this.mesh.matrixWorld); }
  colliderPoses() {
    return this.colliders.map((r) => ({ shape: r.definition.shape, ...this.colliderPose(r) }));
  }

  restore() {
    if (!this.changedAttributes) return;
    for (let i = 0; i < this.position.count; i += 1) {
      this.position.setXYZ(i, this.sourcePosition.getX(i), this.sourcePosition.getY(i), this.sourcePosition.getZ(i));
      this.normal.setXYZ(i, this.sourceNormal.getX(i), this.sourceNormal.getY(i), this.sourceNormal.getZ(i));
    }
    this.position.needsUpdate = true; this.normal.needsUpdate = true;
  }

  sampleTargets() {
    this.mesh.updateWorldMatrix(true, false);
    // CPU cloth reads world matrices directly; the renderer maintains the
    // separate GPU bone palette when it draws the SkinnedMesh.
    this.inverseWorld.copy(this.mesh.matrixWorld).invert();
    this.normalToLocal.setFromMatrix4(this.mesh.matrixWorld).transpose();
    for (const i of this.skinBoneIndices) {
      this.skinPalette[i].multiplyMatrices(this.mesh.skeleton.bones[i].matrixWorld, this.mesh.skeleton.boneInverses[i]);
    }
    const identityBind = isIdentity(this.mesh.bindMatrixInverse) && isIdentity(this.mesh.bindMatrix);
    for (const binding of this.skinBindings) {
      // Skin indices/weights are immutable. Reuse their palette references,
      // avoiding per-vertex BufferAttribute dispatch and temporary matrices.
      const e = binding.matrix.elements, first = binding.influences[0];
      for (let j = 0; j < 16; j += 1) e[j] = first ? first.elements[j] * first.weight : 0;
      for (let k = 1; k < binding.influences.length; k += 1) {
        const influence = binding.influences[k];
        for (let j = 0; j < 16; j += 1) e[j] += influence.elements[j] * influence.weight;
      }
      // Identity multiplication can normalize -0 or propagate nonfinite
      // components through zero products; retain those arithmetic effects.
      if (!identityBind || !identityPreserves(e)) {
        binding.matrix.premultiply(this.mesh.bindMatrixInverse).multiply(this.mesh.bindMatrix);
      }
      if (Math.abs(binding.matrix.determinant()) < 1e-12) throw new Error("cloth 蒙皮矩阵不可逆");
      binding.inverse.copy(binding.matrix).invert();
    }
    const morph = this.sampleMorph;
    for (let i = 0; i < this.topology.vertices.length; i += 1) {
      const index = this.topology.vertices[i];
      const base = morphTerms(this.mesh, index, "position", morph);
      this.targets[i].fromBufferAttribute(this.sourcePosition, index).multiplyScalar(base).add(morph)
        .applyMatrix4(this.vertexBindings[index].matrix).applyMatrix4(this.mesh.matrixWorld);
    }
  }

  colliderPose(r) {
    const p = new THREE.Vector3(), end = new THREE.Vector3(), q = new THREE.Quaternion();
    r.node.updateWorldMatrix(true, false);
    p.fromArray(r.definition.offset).applyMatrix4(r.node.matrixWorld);
    if (r.definition.shape === "panel") {
      const linear = new THREE.Matrix3().setFromMatrix4(r.node.matrixWorld);
      return { p, q, halfAxes: r.definition.halfAxes.map((axis) => new THREE.Vector3(...axis).applyMatrix3(linear)) };
    }
    let radius = 0, height = 0;
    if (r.definition.shape === "plane") {
      end.fromArray(r.definition.normal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(r.node.matrixWorld));
      q.setFromUnitVectors(UP, end);
    } else {
      radius = Math.max(1e-7, r.definition.radius * maximumStretch(r.node.matrixWorld));
      if (r.tail) {
        r.tail.updateWorldMatrix(true, false);
        end.fromArray(r.definition.tail.offset).applyMatrix4(r.tail.matrixWorld).sub(p);
        height = end.length();
        if (height > 1e-8) q.setFromUnitVectors(UP, end.clone().divideScalar(height));
        p.addScaledVector(end, 0.5);
      }
    }
    return { p, q, radius, height };
  }

  initialize() {
    this.solver.reset(this.targets, this.colliderPoses(), this.radius());
    this.targets.forEach((v, i) => this.previousTargets[i].copy(v));
    for (let i = 0; i < this.warmupSteps; i += 1) this.step(1);
    this.needsReset = false;
  }

  step(alpha, previousAlpha = alpha) {
    for (let i = 0; i < this.targets.length; i += 1) {
      this.stepTargets[i].lerpVectors(this.previousTargets[i], this.targets[i], alpha);
      this.stepPreviousTargets[i].lerpVectors(this.previousTargets[i], this.targets[i], previousAlpha);
    }
    this.solver.step({
      targets: this.stepTargets, previousTargets: this.stepPreviousTargets,
      stiffness: this.definition.stiffness, gravity: this.definition.gravity, delta: STEP,
      colliders: this.colliderPoses(), radius: this.radius(),
    });
  }

  writeGeometry() {
    const { edgeA, edgeB, p, n, morph, normalInverse } = this.writeScratch;
    for (let i = 0; i < this.positions.length; i += 1) {
      this.positions[i].copy(this.solver.positions[i])
        .add(this.targets[i]).sub(this.previousTargets[i]);
      if (this.topology.fixed.has(i)) this.positions[i].copy(this.targets[i]);
      this.normals[i].set(0, 0, 0);
      const position = this.positions[i];
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        throw new Error("cloth 求解产生非有限坐标");
      }
    }
    for (let i = 0; i < this.topology.indices.length; i += 3) {
      const a = this.topology.indices[i], b = this.topology.indices[i + 1], c = this.topology.indices[i + 2];
      edgeA.subVectors(this.positions[b], this.positions[a]); edgeB.subVectors(this.positions[c], this.positions[a]);
      edgeA.cross(edgeB);
      this.normals[a].add(edgeA); this.normals[b].add(edgeA); this.normals[c].add(edgeA);
    }
    for (let i = 0; i < this.position.count; i += 1) {
      const index = this.topology.mapping[i];
      if (index < 0) continue;
      const base = morphTerms(this.mesh, i, "position", morph);
      p.copy(this.positions[index]).applyMatrix4(this.inverseWorld).applyMatrix4(this.inverseSkin[i]).sub(morph).divideScalar(base);
      this.position.setXYZ(i, p.x, p.y, p.z);
      normalInverse.setFromMatrix4(this.inverseSkin[i]);
      n.copy(this.normals[index]);
      if (n.lengthSq() > 1e-20) {
        n.normalize().applyMatrix3(this.normalToLocal).applyMatrix3(normalInverse).normalize();
        const normalBase = morphTerms(this.mesh, i, "normal", morph);
        n.sub(morph).divideScalar(normalBase);
      } else n.fromBufferAttribute(this.sourceNormal, i);
      this.normal.setXYZ(i, n.x, n.y, n.z);
    }
    this.position.needsUpdate = true; this.normal.needsUpdate = true;
    // All shader passes share this geometry; keep their broadphase valid too.
    this.geometry.computeBoundingBox(); this.geometry.computeBoundingSphere();
  }

  update(delta) {
    this.sampleTargets();
    if (this.needsReset) this.initialize();
    this.accumulator += Math.min(delta, 0.1);
    const steps = Math.floor((this.accumulator + 1e-10) / STEP);
    for (let i = 0; i < steps; i += 1) { this.step((i + 1) / steps, i / steps); this.accumulator -= STEP; }
    if (steps) this.targets.forEach((v, i) => this.previousTargets[i].copy(v));
    this.writeGeometry();
  }

  destroy() {
    if (this.changedAttributes) {
      this.geometry.setAttribute("position", this.sourcePosition);
      this.geometry.setAttribute("normal", this.sourceNormal);
      this.geometry.computeBoundingBox(); this.geometry.computeBoundingSphere();
      this.mesh.frustumCulled = this.wasCulled;
      this.changedAttributes = false;
    }
    this.solver?.destroy(); this.solver = null;
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
      const cloth = new Cloth(root, definition, physics, resolve, resolvePrimitive);
      records.push(cloth);
      await cloth.connect();
    }
  } catch (error) { system.destroy(); throw error; }
  return system;
}

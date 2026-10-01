import * as THREE from "three";
import {
  VRMSpringBoneJoint,
  VRMSpringBoneCollider,
  VRMSpringBoneColliderShapeSphere,
  VRMSpringBoneColliderShapeCapsule,
  VRMSpringBoneColliderShapePlane,
} from "@pixiv/three-vrm-springbone";
import { HUMANOID_BONE_NAMES } from "./skeleton-composer.js";
import { maximumStretch } from "./physics-math.js";
import { PhysicsPanelShape } from "./physics-panel.js";
export { maximumStretch } from "./physics-math.js";

const STEP = 1 / 60;
const vector = (value) => new THREE.Vector3(...value);
const depth = (node) => node.parent ? 1 + depth(node.parent) : 0;
const scaleOf = (node) => maximumStretch(node.matrixWorld);

export function validatePhysics(value, source = "physics") {
  const fail = (message) => { throw new Error(`${source}: ${message}`); };
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  const scalar = (v, min = 0, max = Infinity) => Number.isFinite(v) && v >= min && v <= max;
  const index = (v) => Number.isSafeInteger(v) && v >= 0;
  const xyz = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!object(value) || !Array.isArray(value.colliders) || !Array.isArray(value.springs)) fail("需要 colliders 和 springs 数组");
  for (const c of value.colliders) {
    if (!object(c) || !["sphere", "capsule", "plane", "panel"].includes(c.shape) || !index(c.node)
      || !xyz(c.offset)) fail("碰撞体形状、节点或偏移无效");
    if (c.shape === "plane") {
      if (!xyz(c.normal) || Math.abs(Math.hypot(...c.normal) - 1) > 1e-5) fail("平面需要单位 normal");
    } else if (c.shape === "panel") {
      if (!Array.isArray(c.halfAxes) || c.halfAxes.length !== 2 || !c.halfAxes.every(xyz)
        || vector(c.halfAxes[0]).cross(vector(c.halfAxes[1])).lengthSq() === 0) fail("碰撞板需要两个非零且不平行的 halfAxes");
    } else if (!scalar(c.radius)) fail("碰撞半径无效");
    if (c.shape === "capsule" && (!object(c.tail) || !index(c.tail.node) || !xyz(c.tail.offset))) fail("胶囊需要有效 tail 端点");
  }
  const nodes = new Set();
  for (const s of value.springs) {
    if (!object(s) || !index(s.node) || !xyz(s.tail) || Math.hypot(...s.tail) < 1e-8
      || !scalar(s.radius) || !scalar(s.stiffness) || !scalar(s.damping, 0, 1)
      || !xyz(s.gravity) || !Array.isArray(s.colliders)
      || !s.colliders.every((i) => index(i) && i < value.colliders.length)) fail("摆动骨或碰撞引用无效");
    if (nodes.has(s.node)) fail(`重复摆动骨 ${s.node}`);
    nodes.add(s.node);
  }
  if (value.cloths !== undefined) {
    if (!Array.isArray(value.cloths)) fail("cloths 必须是数组");
    const meshes = new Set();
    for (const c of value.cloths) {
      if (!object(c) || !index(c.node) || !index(c.primitive)
        || !Array.isArray(c.fixed) || !c.fixed.length || !c.fixed.every(index)
        || new Set(c.fixed).size !== c.fixed.length
        || !scalar(c.radius) || !scalar(c.stiffness) || !scalar(c.damping, 0, 1)
        || !xyz(c.gravity) || !Array.isArray(c.colliders)
        || !c.colliders.every((i) => index(i) && i < value.colliders.length)) fail("布面、固定点或碰撞引用无效");
      const key = `${c.node}/${c.primitive}`;
      if (meshes.has(key)) fail(`重复布面 ${key}`);
      meshes.add(key);
    }
  }
}

/** Resolve original component indices, including core nodes replaced by composition. */
export async function createModelPhysics(root, parts) {
  const definitions = [];
  const core = new Map();
  root.traverse((node) => { if (HUMANOID_BONE_NAMES.has(node.name)) core.set(node.name, node); });
  for (const part of parts) {
    if (!part.component.physics) continue;
    validatePhysics(part.component.physics, part.component.name);
    const nodes = await part.gltf.parser.getDependencies("node");
    const physics = structuredClone(part.component.physics);
    const binding = (index) => part.nodeBindings?.get(nodes[index]);
    const convertPoint = (index, point) => binding(index)
      ? vector(point).applyMatrix4(binding(index).localMatrix).toArray() : point;
    for (const c of physics.colliders) {
      c.offset = convertPoint(c.node, c.offset);
      if (c.tail) c.tail.offset = convertPoint(c.tail.node, c.tail.offset);
      const matrix = binding(c.node)?.localMatrix;
      if (matrix && c.shape === "plane") c.normal = vector(c.normal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(matrix)).toArray();
      if (matrix && c.shape === "panel") c.halfAxes = c.halfAxes.map((axis) => vector(axis).applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix)).toArray());
      if (matrix && ["sphere", "capsule"].includes(c.shape)) c.radius *= maximumStretch(matrix);
    }
    definitions.push({
      physics,
      resolvePrimitive: (index, primitive) => {
        const node = nodes[index];
        const meshIndex = part.gltf.parser.json.nodes[index]?.mesh;
        const matches = [];
        node?.traverse((child) => {
          const association = part.gltf.parser.associations.get(child);
          if (child.isMesh && association?.meshes === meshIndex && association?.primitives === primitive) matches.push(child);
        });
        if (meshIndex === undefined || matches.length !== 1) {
          throw new Error(`${part.component.name}: physics 布面 ${index}/${primitive} 无法唯一解析`);
        }
        return matches[0];
      },
      resolve: (index) => {
        const node = nodes[index];
        if (!node) throw new Error(`${part.component.name}: physics node ${index} 不存在`);
        if (binding(index)) return binding(index).node;
        if (HUMANOID_BONE_NAMES.has(node.name)) {
          const target = core.get(node.name);
          if (!target) throw new Error(`${part.component.name}: physics 核心骨 ${node.name} 缺少合成绑定`);
          return target;
        }
        return node;
      },
    });
  }
  const result = new ModelPhysics(root, definitions);
  try {
    if (definitions.some(({ physics }) => physics.cloths?.length)) {
      const { createMeshCloth } = await import("./mesh-cloth.js");
      result.meshCloth = await createMeshCloth(root, definitions);
    }
    return result;
  } catch (error) {
    result.destroy();
    throw error;
  }
}

/** Generic secondary motion. Source-game solvers and names are intentionally absent. */
export class ModelPhysics {
  constructor(root, definitions) {
    this.root = root;
    this.enabled = true;
    this.records = [];
    this.colliders = [];
    this.accumulator = 0;
    this.frameAccumulator = 0;
    this.needsReset = true;
    this.warmupSteps = 30;
    this.activeOrigin = new THREE.Vector3();
    const owned = new Set();
    root.updateMatrixWorld(true);
    this.motionReference = root.getObjectByName("Hips");
    this.previousReferencePosition = new THREE.Vector3();
    this.referencePosition = new THREE.Vector3();
    this.referenceRadius = 0;
    if (this.motionReference) {
      const center = root.worldToLocal(this.motionReference.getWorldPosition(new THREE.Vector3()));
      const point = new THREE.Vector3();
      root.traverse((node) => {
        if (HUMANOID_BONE_NAMES.has(node.name)) {
          root.worldToLocal(node.getWorldPosition(point));
          this.referenceRadius = Math.max(this.referenceRadius, point.distanceTo(center));
        }
      });
    }
    for (const { physics, resolve } of definitions) {
      validatePhysics(physics);
      const colliders = physics.colliders.map((definition) => {
        const shape = definition.shape === "panel" ? new PhysicsPanelShape()
          : definition.shape === "plane" ? new VRMSpringBoneColliderShapePlane()
          : definition.shape === "capsule"
          ? new VRMSpringBoneColliderShapeCapsule()
          : new VRMSpringBoneColliderShapeSphere();
        // The upstream sphere/capsule normal is undefined exactly at its
        // center/axis. Retry the library's geometry query with a deterministic
        // infinitesimal probe; never propagate NaNs to the skin matrices.
        const collision = shape.calculateCollision.bind(shape);
        const probe = new THREE.Vector3();
        const pushed = new THREE.Vector3();
        shape.calculateCollision = (matrix, position, radius, normal) => {
          const distance = collision(matrix, position, radius, normal);
          if (!normal.toArray().every(Number.isFinite)) {
            for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)]) {
              probe.copy(position).addScaledVector(axis, 1e-7);
              collision(matrix, probe, radius, normal);
              if (normal.toArray().every(Number.isFinite)) break;
            }
          }
          if (!normal.toArray().every(Number.isFinite)) throw new Error("physics 碰撞法向无法解析");
          // Upstream then projects onto the bone-length sphere. A correction
          // exactly onto its center has no direction; break that tie before
          // its division by zero, without changing the contact distance.
          if (distance < 0 && pushed.copy(position).addScaledVector(normal, -distance).distanceToSquared(this.activeOrigin) < 1e-16) {
            probe.set(Math.abs(normal.x) < .8 ? 1 : 0, Math.abs(normal.x) < .8 ? 0 : 1, 0);
            probe.addScaledVector(normal, -probe.dot(normal)).normalize();
            normal.addScaledVector(probe, 1e-5).normalize();
          }
          return distance;
        };
        const record = {
          definition, shape, collider: new VRMSpringBoneCollider(shape),
          node: resolve(definition.node),
          tailNode: definition.tail ? resolve(definition.tail.node) : null,
        };
        this.colliders.push(record);
        return record.collider;
      });
      for (const definition of physics.springs) {
        const node = resolve(definition.node);
        if (owned.has(node)) throw new Error(`physics 重复控制节点 ${node.name}`);
        if (HUMANOID_BONE_NAMES.has(node.name)) throw new Error(`physics 不得覆盖 Humanoid 核心骨 ${node.name}`);
        owned.add(node);
        // An identity joint beneath the animated world frame lets the library
        // preserve its particles while the animation's reference pose changes.
        // No private library state or source-game simulation code is modified.
        const anchor = new THREE.Object3D();
        anchor.matrixAutoUpdate = false;
        anchor.matrix.copy(node.matrixWorld);
        const bone = new THREE.Object3D();
        const tail = new THREE.Object3D();
        tail.position.copy(vector(definition.tail));
        anchor.add(bone); bone.add(tail); anchor.updateMatrixWorld(true);
        const gravity = vector(definition.gravity);
        const joint = new VRMSpringBoneJoint(bone, tail, {
          stiffness: definition.stiffness,
          dragForce: definition.damping,
          hitRadius: definition.radius * scaleOf(node),
          gravityDir: gravity.clone().normalize(), gravityPower: gravity.length(),
        }, [{ colliders: definition.colliders.map((i) => colliders[i]) }]);
        joint.setInitState();
        this.records.push({ node, definition, anchor, bone, tail, joint, base: node.quaternion.clone() });
      }
    }
    this.records.sort((a, b) => depth(a.node) - depth(b.node));
    this.updateColliders();
  }

  beforeAnimation() {
    this.meshCloth?.beforeAnimation();
    for (const r of this.records) { r.node.quaternion.copy(r.base); r.node.updateMatrix(); }
  }

  setEnabled(enabled) {
    this.beforeAnimation();
    this.enabled = Boolean(enabled);
    this.meshCloth?.setEnabled(this.enabled);
    this.reset();
    this.root.updateMatrixWorld(true);
  }

  reset(warmupSteps = 30) {
    this.meshCloth?.reset(warmupSteps);
    this.warmupSteps = warmupSteps;
    this.needsReset = true;
    this.accumulator = 0;
    this.frameAccumulator = 0;
  }

  /** Advance the entire animated model at the same time as its collisions. */
  advance(delta, animate) {
    if (!Number.isFinite(delta) || delta < 0) throw new Error("physics delta 必须为非负有限数");
    const tick = (dt) => {
      this.beforeAnimation();
      animate(dt);
      this.update(dt);
    };
    if (!this.enabled || (!this.records.length && !this.meshCloth?.records.length)) {
      tick(delta + this.frameAccumulator);
      this.frameAccumulator = 0;
      return;
    }
    // A suspended/background frame is a discontinuity, not hundreds of stale
    // collision steps. Preserve animation time and settle at its new pose.
    if (delta > .1) {
      this.beforeAnimation();
      animate(delta + this.frameAccumulator);
      // A long frame must not trigger the expensive initial thirty-step
      // settling loop again, otherwise overload perpetuates itself forever.
      // Jolt refreshes transported cloth bounds after the first native step;
      // the second resolves contacts at the new pose after a large jump.
      this.reset(2);
      this.update(0);
      return;
    }
    this.frameAccumulator += delta;
    const count = Math.floor((this.frameAccumulator + 1e-10) / STEP);
    this.frameAccumulator = Math.max(0, this.frameAccumulator - count * STEP);
    if (!count && this.needsReset) tick(0);
    for (let i = 0; i < count; i += 1) tick(STEP);
  }

  updateColliders() {
    for (const r of this.colliders) {
      r.node.updateWorldMatrix(true, false);
      r.shape.offset.copy(vector(r.definition.offset)).applyMatrix4(r.node.matrixWorld);
      if (r.definition.shape === "plane") {
        r.shape.normal.copy(vector(r.definition.normal)).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(r.node.matrixWorld));
      } else if (r.definition.shape === "panel") {
        const linear = new THREE.Matrix3().setFromMatrix4(r.node.matrixWorld);
        r.shape.halfAxes.forEach((axis, i) => axis.fromArray(r.definition.halfAxes[i]).applyMatrix3(linear));
      } else r.shape.radius = r.definition.radius * scaleOf(r.node);
      if (r.tailNode) {
        r.tailNode.updateWorldMatrix(true, false);
        r.shape.tail.copy(vector(r.definition.tail.offset)).applyMatrix4(r.tailNode.matrixWorld);
      }
      r.collider.updateWorldMatrix(false, false);
    }
  }

  step() {
    this.updateColliders();
    for (const r of this.records) {
      r.node.quaternion.copy(r.base);
      r.node.updateWorldMatrix(true, false);
      r.anchor.matrix.copy(r.node.matrixWorld);
      r.anchor.updateMatrixWorld(true);
      this.activeOrigin.setFromMatrixPosition(r.anchor.matrixWorld);
      r.joint.settings.hitRadius = r.definition.radius * scaleOf(r.node);
      r.joint.update(STEP);
      r.node.quaternion.copy(r.base).multiply(r.bone.quaternion);
      r.node.updateWorldMatrix(false, true);
    }
  }

  update(delta) {
    if (!Number.isFinite(delta) || delta < 0) throw new Error("physics delta 必须为非负有限数");
    for (const r of this.records) r.base.copy(r.node.quaternion);
    if (!this.enabled) return;
    this.root.updateMatrixWorld(true);
    if (this.motionReference && this.referenceRadius > 0) {
      this.motionReference.getWorldPosition(this.referencePosition);
      // A whole-rig displacement exceeding its diameter in one simulation
      // step is a teleport (e.g. a translating clip wrapping to its start).
      // Keeping the old world-space particles would inject a huge impulse.
      // Scale with the character, and leave ordinary travel/inertia intact.
      const diameter = 2 * this.referenceRadius * scaleOf(this.root);
      if (!this.needsReset && this.referencePosition.distanceTo(this.previousReferencePosition) > diameter) {
        this.needsReset = true;
        this.warmupSteps = 2;
        this.accumulator = 0;
        this.meshCloth?.reset(2);
      }
      this.previousReferencePosition.copy(this.referencePosition);
    }
    if (this.needsReset) {
      for (const r of this.records) {
        r.anchor.matrix.copy(r.node.matrixWorld); r.anchor.updateMatrixWorld(true);
        r.joint.reset();
      }
      // Settle initial overlap before the first displayed frame; this does not
      // change the animation/rest pose and is not a replacement default pose.
      for (let i = 0; i < this.warmupSteps; i += 1) this.step();
      this.needsReset = false;
    }
    this.accumulator += Math.min(delta, 0.1);
    while (this.accumulator + 1e-10 >= STEP) {
      this.step();
      this.accumulator -= STEP;
    }
    // Also retain the last simulated result on frames below one fixed step.
    for (const r of this.records) r.node.quaternion.copy(r.base).multiply(r.bone.quaternion);
    this.root.updateMatrixWorld(true);
    this.meshCloth?.update(delta);
  }

  destroy() {
    this.beforeAnimation();
    this.meshCloth?.destroy();
    this.meshCloth = null;
    this.records.length = 0;
    this.colliders.length = 0;
  }
}

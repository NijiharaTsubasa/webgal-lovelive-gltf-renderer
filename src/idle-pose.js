import * as THREE from "three";
import { HUMANOID_BONE_NAMES } from "./skeleton-composer.js";

const finiteArray = (value, length) => Array.isArray(value)
  && value.length === length && value.every(Number.isFinite);

export function validateIdlePose(pose, source = "idlePose") {
  if (!pose || typeof pose !== "object" || Array.isArray(pose)
      || !Array.isArray(pose.tracks) || !pose.tracks.length) {
    throw new Error(`${source}: tracks 必须是非空数组`);
  }
  const seen = new Set();
  for (const track of pose.tracks) {
    if (!track || !HUMANOID_BONE_NAMES.has(track.bone) || seen.has(track.bone)) {
      throw new Error(`${source}: 骨骼名称无效或重复`);
    }
    seen.add(track.bone);
    if (!finiteArray(track.rotation, 4)) {
      throw new Error(`${source}: ${track.bone} rotation 必须是有限四元数`);
    }
    const norm = Math.hypot(...track.rotation);
    if (Math.abs(norm - 1) > 1e-3) {
      throw new Error(`${source}: ${track.bone} rotation 必须是单位四元数`);
    }
    if (track.translation !== undefined
        && (track.bone !== "Hips" || !finiteArray(track.translation, 3))) {
      throw new Error(`${source}: 只有 Hips 可声明三维 translation`);
    }
  }
  return pose;
}

export class IdlePose {
  constructor(root, humanoidScale, pose) {
    validateIdlePose(pose);
    if (!Number.isFinite(humanoidScale) || humanoidScale <= 0) {
      throw new Error("idlePose: humanoidScale 必须是正有限数");
    }
    this.root = root;
    this.scale = humanoidScale;
    root.updateMatrixWorld(true);
    const worldInverse = root.matrixWorld.clone().invert();
    this.targets = pose.tracks.flatMap((track) => {
      const matches = [];
      root.traverse((node) => {
        if (node.name === track.bone) matches.push(node);
      });
      if (matches.length > 1) throw new Error(`idlePose: ${track.bone} 重复命中`);
      if (!matches.length) return []; // Optional Humanoid bones may be absent.
      const node = matches[0];
      const target = {
        node,
        rotation: node.quaternion.clone(),
        position: node.position.clone(),
        delta: new THREE.Quaternion().fromArray(track.rotation),
      };
      if (track.translation) {
        target.translation = new THREE.Vector3().fromArray(track.translation);
        target.referenceModelPosition = node.getWorldPosition(new THREE.Vector3())
          .applyMatrix4(worldInverse);
        target.parentModelMatrixInverse = worldInverse.clone()
          .multiply(node.parent.matrixWorld).invert();
      }
      return [target];
    });
  }

  apply() {
    for (const target of this.targets) {
      target.node.quaternion.copy(target.rotation).multiply(target.delta).normalize();
      if (target.translation) {
        target.node.position.copy(target.translation).multiplyScalar(this.scale)
          .add(target.referenceModelPosition)
          .applyMatrix4(target.parentModelMatrixInverse);
      }
    }
    this.root.updateMatrixWorld(true);
  }

  restore() {
    for (const target of this.targets) {
      target.node.position.copy(target.position);
      target.node.quaternion.copy(target.rotation);
    }
    this.root.updateMatrixWorld(true);
  }
}

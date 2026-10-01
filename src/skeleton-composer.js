import * as THREE from "three";

// UnityEngine.HumanBodyBones without LastBone. Optional bones may be absent,
// but any core bone referenced by a component skin must exist on the body rig.
export const HUMANOID_BONE_NAMES = new Set([
  "Hips",
  "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg",
  "LeftFoot", "RightFoot", "LeftToes", "RightToes",
  "Spine", "Chest", "UpperChest", "Neck", "Head",
  "LeftShoulder", "RightShoulder", "LeftUpperArm", "RightUpperArm",
  "LeftLowerArm", "RightLowerArm", "LeftHand", "RightHand",
  "LeftEye", "RightEye", "Jaw",
  "LeftThumbProximal", "LeftThumbIntermediate", "LeftThumbDistal",
  "LeftIndexProximal", "LeftIndexIntermediate", "LeftIndexDistal",
  "LeftMiddleProximal", "LeftMiddleIntermediate", "LeftMiddleDistal",
  "LeftRingProximal", "LeftRingIntermediate", "LeftRingDistal",
  "LeftLittleProximal", "LeftLittleIntermediate", "LeftLittleDistal",
  "RightThumbProximal", "RightThumbIntermediate", "RightThumbDistal",
  "RightIndexProximal", "RightIndexIntermediate", "RightIndexDistal",
  "RightMiddleProximal", "RightMiddleIntermediate", "RightMiddleDistal",
  "RightRingProximal", "RightRingIntermediate", "RightRingDistal",
  "RightLittleProximal", "RightLittleIntermediate", "RightLittleDistal",
]);

function collectCoreBones(root, label) {
  const result = new Map();
  root.traverse((object) => {
    // GLTFLoader marks only skin-referenced joints as Bone. An unused
    // standardized joint arrives as Object3D but remains part of the rig.
    if (!HUMANOID_BONE_NAMES.has(object.name)) return;
    if (result.has(object.name)) {
      throw new Error(`${label} 含有重复的标准骨 ${object.name}`);
    }
    result.set(object.name, object);
  });
  if (!result.has("Hips")) throw new Error(`${label} 缺少标准骨 Hips`);
  return result;
}

function buildBoneTargets(headBones, bodyBones) {
  const targets = new Map();
  const fallbacks = [];
  for (const [name, sourceBone] of headBones) {
    let target = bodyBones.get(name);
    let ancestor = sourceBone.parent;
    while (!target && ancestor) {
      if (HUMANOID_BONE_NAMES.has(ancestor.name)) {
        target = bodyBones.get(ancestor.name);
      }
      ancestor = ancestor.parent;
    }
    if (!target) {
      throw new Error(`body 缺少 head 标准骨 ${name}，且没有可用的祖先骨`);
    }
    targets.set(sourceBone, target);
    if (target.name !== name) fallbacks.push({ source: name, target: target.name });
  }
  return { targets, fallbacks };
}

function rebindHeadSkins(headRoot, boneTargets) {
  let skins = 0;
  let reboundJoints = 0;
  headRoot.traverse((object) => {
    if (!object.isSkinnedMesh || !object.skeleton) return;
    const bones = object.skeleton.bones.map((bone) => {
      if (!HUMANOID_BONE_NAMES.has(bone.name)) return bone;
      const target = boneTargets.get(bone);
      if (!target) {
        throw new Error(`head skin ${object.name} 的标准骨 ${bone.name} 没有兼容映射`);
      }
      reboundJoints += 1;
      return target;
    });
    // Recompute inverse bind matrices against the selected body. Reusing the
    // head component's inverses would deform it whenever the body bind pose
    // differs (which is expected for arbitrary compatible combinations).
    object.bind(new THREE.Skeleton(bones), object.bindMatrix.clone());
    skins += 1;
  });
  return { skins, reboundJoints };
}

function transplantHeadAttachments(headBones, boneTargets) {
  let attachments = 0;
  for (const [name, sourceBone] of headBones) {
    const targetBone = boneTargets.get(sourceBone);
    if (!targetBone) continue;
    for (const child of [...sourceBone.children]) {
      if (HUMANOID_BONE_NAMES.has(child.name)) continue;
      // Preserve the attachment's neutral world pose while replacing its
      // duplicate head-core parent with the authoritative body joint.
      targetBone.attach(child);
      attachments += 1;
    }
  }
  return attachments;
}

function removeDuplicateHeadRig(headBones) {
  let roots = 0;
  const sourceBones = new Set(headBones.values());
  for (const bone of sourceBones) {
    if (!bone.parent || sourceBones.has(bone.parent)) continue;
    bone.removeFromParent();
    roots += 1;
  }
  return roots;
}

/**
 * Compose a standardized head and body around the body's single authoritative
 * Humanoid rig. The head's duplicate core bones are binding scaffolds only:
 * skins are rebound to body bones, head-owned auxiliary branches are moved to
 * the corresponding body anchors, and the duplicate core rig is discarded.
 */
export function composeHumanoidHeadBody(bodyRoot, headRoot) {
  if (!bodyRoot || !headRoot) throw new Error("组合需要有效的 head 和 body scene");
  bodyRoot.updateMatrixWorld(true);
  headRoot.updateMatrixWorld(true);

  const bodyBones = collectCoreBones(bodyRoot, "body");
  const headBones = collectCoreBones(headRoot, "head");
  const boneMapping = buildBoneTargets(headBones, bodyBones);
  const nodeBindings = new Map([...boneMapping.targets].map(([source, node]) => [source, {
    node,
    localMatrix: node.matrixWorld.clone().invert().multiply(source.matrixWorld),
  }]));
  const attachments = transplantHeadAttachments(headBones, boneMapping.targets);
  const removedRigRoots = removeDuplicateHeadRig(headBones);

  bodyRoot.updateMatrixWorld(true);
  headRoot.updateMatrixWorld(true);
  const rebound = rebindHeadSkins(headRoot, boneMapping.targets);
  for (const child of [...headRoot.children]) bodyRoot.attach(child);
  bodyRoot.updateMatrixWorld(true);

  return {
    nodeBindings,
    bodyCoreBones: bodyBones.size,
    headCoreBones: headBones.size,
    skins: rebound.skins,
    reboundJoints: rebound.reboundJoints,
    attachments,
    removedRigRoots,
    fallbackBones: boneMapping.fallbacks,
  };
}

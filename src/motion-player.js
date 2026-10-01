import * as THREE from "three";
import { readonlySnapshot } from "./runtime-snapshot.js";

const quaternionA = new THREE.Quaternion();
const quaternionC = new THREE.Quaternion();
const quaternionD = new THREE.Quaternion();
const quaternionE = new THREE.Quaternion();
const quaternionF = new THREE.Quaternion();
const positionA = new THREE.Vector3();
const positionB = new THREE.Vector3();
const positionC = new THREE.Vector3();
const positionD = new THREE.Vector3();

const FINGER_BONES = new Set(
  ["Left", "Right"].flatMap((side) =>
    ["Thumb", "Index", "Middle", "Ring", "Little"].flatMap((finger) =>
      ["Proximal", "Intermediate", "Distal"].map((segment) => `${side}${finger}${segment}`),
    ),
  ),
);

function tracksByBone(clip) {
  return new Map(clip.tracks.map((track) => [track.bone, track]));
}

function parameterValueIsValid(definition, value) {
  if (definition.type === "float") return Number.isFinite(value);
  if (definition.type === "int") return Number.isInteger(value);
  if (definition.type === "bool" || definition.type === "trigger") return typeof value === "boolean";
  return false;
}

function conditionMatches(condition, parameters, definitions) {
  const definition = definitions.get(condition.parameter);
  if (!definition) throw new Error(`动作参数不存在: ${condition.parameter}`);
  const value = parameters.get(condition.parameter);
  if (definition.type === "bool" || definition.type === "trigger") {
    if (condition.operator === "isTrue") return value === true;
    if (condition.operator === "isFalse") return value === false;
  } else if (definition.type === "float") {
    if (!Number.isFinite(condition.value)) throw new Error(`动作条件值无效: ${condition.parameter}`);
    if (condition.operator === "greater") return value > condition.value;
    if (condition.operator === "less") return value < condition.value;
  } else if (definition.type === "int") {
    if (!Number.isInteger(condition.value)) throw new Error(`动作条件值无效: ${condition.parameter}`);
    if (condition.operator === "greater") return value > condition.value;
    if (condition.operator === "less") return value < condition.value;
    if (condition.operator === "equals") return value === condition.value;
    if (condition.operator === "notEquals") return value !== condition.value;
  }
  throw new Error(`不支持的动作条件 ${condition.operator}`);
}

export function validatePoseSlots(poseSlots, clips) {
  const bonesOwnedBySlot = new Map();
  for (const slot of poseSlots || []) {
    const slotBones = new Set();
    for (const option of slot.options || []) {
      const clip = clips.get(option.clip);
      if (!clip) throw new Error(`姿势 Clip 不存在: ${option.clip}`);
      for (const track of clip.tracks) {
        if (!FINGER_BONES.has(track.bone) || track.translation?.length) {
          throw new Error(`姿势槽 ${slot.id} 只能覆盖手指旋转: ${track.bone}`);
        }
        slotBones.add(track.bone);
      }
    }
    for (const bone of slotBones) {
      const owner = bonesOwnedBySlot.get(bone);
      if (owner && owner !== slot.id) {
        throw new Error(`姿势槽骨骼重叠: ${owner} / ${slot.id} / ${bone}`);
      }
      bonesOwnedBySlot.set(bone, slot.id);
    }
  }
}

export class MotionPlayer {
  constructor(modelRoot, humanoidScale, motion, modelMotionGroup = null, motionGroup = null) {
    if (!motion?.program || !Array.isArray(motion.program.layers)) {
      throw new Error("文件不是有效的标准动作");
    }
    if (!(Number.isFinite(humanoidScale) && humanoidScale > 0)) {
      throw new Error("模型缺少有效的 humanoidScale");
    }
    this.modelRoot = modelRoot;
    this.humanoidScale = humanoidScale;
    this.motion = motion;
    this.stateSnapshot = null;
    if (!Array.isArray(motion.program.parameters)) {
      throw new Error("动作参数列表无效");
    }
    this.parameterDefinitions = new Map();
    this.parameters = new Map();
    for (const parameter of motion.program.parameters) {
      if (typeof parameter.id !== "string" || !parameter.id || this.parameters.has(parameter.id)) {
        throw new Error(`动作参数 ID 无效: ${parameter.id}`);
      }
      if (!new Set(["float", "int", "bool", "trigger"]).has(parameter.type)
          || !parameterValueIsValid(parameter, parameter.default)
          || (parameter.type === "trigger" && parameter.default !== false)) {
        throw new Error(`动作参数定义无效: ${parameter.id}`);
      }
      this.parameterDefinitions.set(parameter.id, parameter);
      this.parameters.set(parameter.id, parameter.default);
    }
    this.clips = new Map();
    for (const clip of [
      ...motion.clips,
      ...(motion.auxiliaryClips || []),
      ...(motion.leftHandPoses || []),
      ...(motion.rightHandPoses || []),
    ]) {
      if (!clip.id || this.clips.has(clip.id)) throw new Error(`动作 Clip ID 无效: ${clip.id}`);
      this.clips.set(clip.id, { ...clip, tracksByBone: tracksByBone(clip) });
    }
    validatePoseSlots(motion.program.poseSlots, this.clips);

    this.layers = motion.program.layers.map((definition) => {
      if (!(Number.isFinite(definition.weight) && definition.weight >= 0 && definition.weight <= 1)) {
        throw new Error(`动作 Layer 权重无效: ${definition.id}`);
      }
      if (!new Set(["override", "additive"]).has(definition.blend)) {
        throw new Error(`不支持的动作 Layer 混合模式: ${definition.blend}`);
      }
      const states = new Map(definition.states.map((state) => [state.id, state]));
      const state = states.get(definition.initialState);
      if (!state) throw new Error(`动作初始状态不存在: ${definition.initialState}`);
      return { definition, states, state, time: 0, transition: null };
    });
    this.bodyLayer = this.layers.find((layer) => layer.definition.id === motion.program.baseLayer);
    if (!this.bodyLayer || this.bodyLayer.definition.blend !== "override" || this.bodyLayer.definition.weight !== 1) {
      throw new Error(`动作基础 Layer 无效: ${motion.program.baseLayer}`);
    }

    this.poseSlots = new Map();
    for (const slot of motion.program.poseSlots || []) {
      const options = new Map(slot.options.map((option) => [option.id, option.clip]));
      this.poseSlots.set(slot.id, { options, selected: slot.default, time: 0 });
    }

    const objectsByName = new Map();
    const gltfNodesByName = new Map();
    modelRoot.traverse((object) => {
      for (const name of new Set([object.name, object.userData?.name])) {
        if (!name) continue;
        const list = objectsByName.get(name);
        if (list) list.push(object);
        else objectsByName.set(name, [object]);
      }
      const gltfName = object.userData?.name || object.name;
      if (gltfName) {
        const list = gltfNodesByName.get(gltfName);
        if (list) list.push(object);
        else gltfNodesByName.set(gltfName, [object]);
      }
    });
    this.groupTrackStates = new Map();
    this.groupTrackDeclaredCount = [...this.clips.values()]
      .reduce((count, clip) => count + (clip.groupTracks?.length || 0), 0);
    this.groupTrackResolvedCount = 0;
    this.groupTracksMatching = Boolean(motionGroup && motionGroup === modelMotionGroup);
    if (this.groupTracksMatching) {
      for (const clip of this.clips.values()) {
        const states = [];
        for (const track of clip.groupTracks || []) {
          let resolved = false;
          const matches = gltfNodesByName.get(track.node) || [];
          const objects = matches.length === 1 ? matches : [];
          if (track.kind === "morph") {
            for (const object of objects) {
              const index = object.morphTargetDictionary?.[track.property];
              if (index === undefined || !object.morphTargetInfluences) continue;
              states.push({
                kind: "morph",
                object,
                index,
                track,
                original: object.morphTargetInfluences[index],
              });
              resolved = true;
            }
          } else if (track.kind === "transform") {
            for (const object of objects) {
              states.push({
                kind: "transform",
                object,
                track,
                position: object.position.toArray(),
                rotation: object.quaternion.toArray(),
                scale: object.scale.toArray(),
              });
              resolved = true;
            }
          } else if (track.kind === "visibility") {
            for (const object of objects) {
              states.push({ kind: "visibility", object, track, original: object.visible });
              resolved = true;
            }
          }
          if (resolved) this.groupTrackResolvedCount++;
        }
        this.groupTrackStates.set(clip.id, states);
      }
    }
    modelRoot.updateMatrixWorld(true);
    const modelWorldInverse = modelRoot.matrixWorld.clone().invert();
    const bones = new Set();
    for (const clip of this.clips.values()) {
      for (const track of clip.tracks) bones.add(track.bone);
    }
    this.tracks = [];
    for (const bone of bones) {
      const matches = objectsByName.get(bone);
      if (!matches) continue;
      if (matches.length !== 1) {
        throw new Error(`动作骨骼 ${bone} 必须恰好命中一个节点，实际 ${matches.length}`);
      }
      const hasTranslation = [...this.clips.values()]
        .some((clip) => clip.tracksByBone.get(bone)?.translation?.length);
      for (const object of matches) {
        const state = {
          object,
          bone,
          position: object.position.toArray(),
          rotation: object.quaternion.toArray(),
          referenceLocalRotation: object.quaternion.clone(),
        };
        if (hasTranslation) {
          state.referenceModelPosition = object.getWorldPosition(new THREE.Vector3())
            .applyMatrix4(modelWorldInverse);
          const parentModelMatrix = modelWorldInverse.clone().multiply(object.parent.matrixWorld);
          state.parentModelMatrixInverse = parentModelMatrix.invert();
        }
        this.tracks.push(state);
      }
    }
  }

  hasActiveGroupMorphTargets(targetKeys) {
    if (!targetKeys?.size) return false;
    const clip = this.currentClip(this.bodyLayer);
    return (this.groupTrackStates.get(clip.id) || []).some((state) =>
      state.kind === "morph" && targetKeys.has(`${state.object.uuid}:${state.index}`));
  }

  getDefinition(resource) {
    const metadata = {};
    for (const field of ["type", "name", "description", "motionGroup"]) {
      if (Object.hasOwn(resource, field)) metadata[field] = resource[field];
    }
    return readonlySnapshot({
      resource: metadata,
      program: this.motion.program,
      clips: [...this.clips.values()].map((clip) => ({
        id: clip.id,
        duration: clip.duration,
        sampleRate: clip.sampleRate,
        frames: clip.frames,
        tracks: clip.tracks.map((track) => ({
          bone: track.bone,
          rotation: Boolean(track.rotation?.length),
          translation: Boolean(track.translation?.length),
        })),
        groupTracks: (clip.groupTracks || []).map(({ kind, node, property }) => ({ kind, node, property })),
      })),
    });
  }

  getState() {
    return this.stateSnapshot;
  }

  clipSample(clip, clock, loop) {
    const time = this.sampleTime(clip, clock, loop);
    return { clip: clip.id, time, frame: this.sourceFrame({ clip, time }) };
  }

  captureState(groupClip, groupTime, groupFrame) {
    return readonlySnapshot({
      parameters: Object.fromEntries(this.parameters),
      layers: this.layers.map((layer) => {
        const transition = layer.transition;
        const sample = (state, time, weight) => ({
          state: state.id,
          ...this.clipSample(this.clips.get(state.clip), time, state.loop),
          weight,
        });
        const mix = transition ? Math.min(1, transition.elapsed / transition.duration) : 0;
        return {
          id: layer.definition.id,
          state: layer.state.id,
          time: layer.time,
          transition: transition ? {
            to: transition.targetState.id,
            elapsed: transition.elapsed,
            duration: transition.duration,
          } : null,
          samples: transition ? [
            sample(transition.sourceState, transition.sourceTime, 1 - mix),
            sample(transition.targetState, transition.targetTime, mix),
          ] : [sample(layer.state, layer.time, 1)],
        };
      }),
      poseSlots: [...this.poseSlots].map(([id, slot]) => {
        const selected = slot.selected ?? null;
        const clip = selected === null ? null : this.clips.get(slot.options.get(selected));
        return { id, selected, sample: clip ? this.clipSample(clip, slot.time, true) : null };
      }),
      groupTracks: {
        matching: this.groupTracksMatching,
        clip: groupClip.id,
        time: groupTime,
        frame: groupFrame,
        tracks: (this.groupTrackStates.get(groupClip.id) || [])
          .map(({ track: { kind, node, property } }) => ({ kind, node, property })),
      },
    });
  }

  command(name) {
    const assignments = this.motion.program.commands?.[name];
    if (!assignments) return false;
    for (const assignment of assignments) {
      const definition = this.parameterDefinitions.get(assignment.parameter);
      if (!definition) {
        throw new Error(`动作参数不存在: ${assignment.parameter}`);
      }
      if (!parameterValueIsValid(definition, assignment.value)) {
        throw new Error(`动作参数赋值无效: ${assignment.parameter}`);
      }
      this.parameters.set(assignment.parameter, assignment.value);
    }
    return assignments.length > 0;
  }

  setPose(slotId, optionId) {
    const slot = this.poseSlots.get(slotId);
    if (!slot || (optionId !== null && !slot.options.has(optionId))) return false;
    slot.selected = optionId;
    slot.time = 0;
    return true;
  }

  currentClip(layer) {
    const clip = this.clips.get(layer.state.clip);
    if (!clip) throw new Error(`动作 Clip 不存在: ${layer.state.clip}`);
    return clip;
  }

  stateSource(state, time, bone) {
    const clip = this.clips.get(state.clip);
    if (!clip) throw new Error(`动作 Clip 不存在: ${state.clip}`);
    const track = clip.tracksByBone.get(bone);
    if (!track) return null;
    return {
      clip,
      track,
      time: this.sampleTime(clip, time, state.loop),
    };
  }

  layerSources(layer, bone) {
    if (!layer.transition) {
      return {
        source: this.stateSource(layer.state, layer.time, bone),
        target: null,
        mix: 0,
        transitioning: false,
      };
    }
    const transition = layer.transition;
    return {
      source: this.stateSource(transition.sourceState, transition.sourceTime, bone),
      target: this.stateSource(transition.targetState, transition.targetTime, bone),
      mix: Math.min(1, transition.elapsed / transition.duration),
      transitioning: true,
    };
  }

  sampleLayerRotation(layer, bone, result) {
    const { source, target, mix, transitioning } = this.layerSources(layer, bone);
    const sourceHasRotation = Boolean(source?.track.rotation?.length);
    const targetHasRotation = Boolean(target?.track.rotation?.length);
    if (!sourceHasRotation && !targetHasRotation) return false;
    if (!transitioning) {
      result.fromArray(source.track.rotation, this.sourceFrame(source) * 4);
      return true;
    }
    if (sourceHasRotation) quaternionE.fromArray(source.track.rotation, this.sourceFrame(source) * 4);
    else quaternionE.identity();
    if (targetHasRotation) quaternionF.fromArray(target.track.rotation, this.sourceFrame(target) * 4);
    else quaternionF.identity();
    result.copy(quaternionE).slerp(quaternionF, mix).normalize();
    return true;
  }

  sampleLayerTranslation(layer, bone, result) {
    const { source, target, mix, transitioning } = this.layerSources(layer, bone);
    const sourceHasTranslation = Boolean(source?.track.translation?.length);
    const targetHasTranslation = Boolean(target?.track.translation?.length);
    if (!sourceHasTranslation && !targetHasTranslation) return false;
    if (!transitioning) {
      result.fromArray(source.track.translation, this.sourceFrame(source) * 3);
      return true;
    }
    if (sourceHasTranslation) {
      positionC.fromArray(source.track.translation, this.sourceFrame(source) * 3);
    } else {
      positionC.set(0, 0, 0);
    }
    if (targetHasTranslation) {
      positionD.fromArray(target.track.translation, this.sourceFrame(target) * 3);
    } else {
      positionD.set(0, 0, 0);
    }
    result.copy(positionC).lerp(positionD, mix);
    return true;
  }

  update(deltaTime) {
    const delta = Math.max(0, deltaTime);
    for (const layer of this.layers) this.advanceLayer(layer, delta);
    const overlays = new Map();
    for (const slot of this.poseSlots.values()) {
      if (slot.selected === null || slot.selected === undefined) continue;
      const overlay = this.clips.get(slot.options.get(slot.selected));
      if (!overlay) continue;
      slot.time += delta;
      const time = this.sampleTime(overlay, slot.time, true);
      for (const [bone, track] of overlay.tracksByBone) overlays.set(bone, { clip: overlay, track, time });
    }

    for (const target of this.tracks) {
      const overlay = overlays.get(target.bone);

      if (overlay) {
        quaternionA.fromArray(overlay.track.rotation, this.sourceFrame(overlay) * 4);
      } else {
        let hasRotation = this.sampleLayerRotation(this.bodyLayer, target.bone, quaternionA);
        if (!hasRotation) quaternionA.identity();
        for (const layer of this.layers) {
          if (layer === this.bodyLayer || layer.definition.blend !== "additive") continue;
          if (!this.sampleLayerRotation(layer, target.bone, quaternionC)) continue;
          quaternionD.identity().slerp(quaternionC, layer.definition.weight);
          quaternionA.multiply(quaternionD).normalize();
          hasRotation = true;
        }
        if (!hasRotation && !target.referenceModelPosition) continue;
      }

      target.object.quaternion.copy(target.referenceLocalRotation)
        .multiply(quaternionA)
        .normalize();

      if (target.referenceModelPosition && !overlay) {
        positionA.set(0, 0, 0);
        this.sampleLayerTranslation(this.bodyLayer, target.bone, positionA);
        for (const layer of this.layers) {
          if (layer === this.bodyLayer || layer.definition.blend !== "additive") continue;
          if (!this.sampleLayerTranslation(layer, target.bone, positionB)) continue;
          positionB.multiplyScalar(layer.definition.weight);
          positionA.add(positionB);
        }
        positionA.multiplyScalar(this.humanoidScale)
          .add(target.referenceModelPosition)
          .applyMatrix4(target.parentModelMatrixInverse);
        target.object.position.copy(positionA);
      }
    }
    const groupClip = this.currentClip(this.bodyLayer);
    const groupTime = this.sampleTime(groupClip, this.bodyLayer.time, this.bodyLayer.state.loop);
    const groupFrame = this.sourceFrame({ clip: groupClip, time: groupTime });
    for (const state of this.groupTrackStates.get(groupClip.id) || []) {
      if (state.kind === "morph") {
        state.object.morphTargetInfluences[state.index] = state.track.values[groupFrame];
      } else if (state.kind === "transform") {
        if (state.track.translation?.length) {
          state.object.position.fromArray(state.track.translation, groupFrame * 3);
        }
        if (state.track.rotation?.length) {
          state.object.quaternion.fromArray(state.track.rotation, groupFrame * 4).normalize();
        }
        if (state.track.scale?.length) {
          state.object.scale.fromArray(state.track.scale, groupFrame * 3);
        }
      } else if (state.kind === "visibility") {
        state.object.visible = state.track.values[groupFrame] >= 0.5;
      }
    }
    this.modelRoot.updateMatrixWorld(true);
    this.stateSnapshot = this.captureState(groupClip, groupTime, groupFrame);
  }

  sourceFrame(source) {
    return Math.min(
      source.clip.frames - 1,
      Math.floor(source.time * source.clip.sampleRate),
    );
  }

  advanceLayer(layer, deltaTime) {
    let remaining = deltaTime;
    for (let guard = 0; guard < 16; guard++) {
      if (layer.transition) {
        const active = layer.transition;
        const step = Math.min(remaining, active.duration - active.elapsed);
        active.sourceTime += step * active.sourceState.speed;
        active.targetTime += step * active.targetState.speed;
        active.elapsed += step;
        layer.time = active.sourceTime;
        remaining -= step;
        if (active.elapsed < active.duration) return;
        layer.state = active.targetState;
        layer.time = active.targetTime;
        layer.transition = null;
        if (remaining <= 1e-12) return;
        continue;
      }

      const clip = this.currentClip(layer);
      const nextTime = layer.time + remaining * layer.state.speed;
      const transition = layer.state.transitions.find((candidate) => {
        const conditions = candidate.conditions.every((condition) =>
          conditionMatches(condition, this.parameters, this.parameterDefinitions));
        const exitReached = candidate.exitTime === null
          || nextTime >= clip.duration * candidate.exitTime;
        return conditions && exitReached;
      });
      if (!transition) {
        layer.time = nextTime;
        if (layer.state.loop && clip.duration > 0) layer.time %= clip.duration;
        else layer.time = Math.min(layer.time, clip.duration);
        return;
      }
      for (const condition of transition.conditions) {
        const definition = this.parameterDefinitions.get(condition.parameter);
        if (definition?.type === "trigger" && this.parameters.get(condition.parameter) === true) {
          this.parameters.set(condition.parameter, false);
        }
      }
      const next = layer.states.get(transition.to);
      if (!next) throw new Error(`动作过渡目标不存在: ${transition.to}`);
      const threshold = transition.exitTime === null
        ? layer.time
        : clip.duration * transition.exitTime;
      const timeToThreshold = transition.exitTime === null || layer.time >= threshold
        ? 0
        : Math.max(0, (threshold - layer.time) / layer.state.speed);
      const consumed = Math.min(remaining, Number.isFinite(timeToThreshold) ? timeToThreshold : remaining);
      layer.time += consumed * layer.state.speed;
      remaining -= consumed;

      if (transition.duration > 0) {
        const targetClip = this.clips.get(next.clip);
        if (!targetClip) throw new Error(`动作 Clip 不存在: ${next.clip}`);
        layer.transition = {
          sourceState: layer.state,
          sourceTime: layer.time,
          targetState: next,
          targetTime: targetClip.duration * transition.offset,
          elapsed: 0,
          duration: transition.duration,
        };
        continue;
      }

      const overflowSpeed = transition.exitTime === null ? next.speed : layer.state.speed;
      const overflow = remaining * overflowSpeed;
      layer.state = next;
      const nextClip = this.currentClip(layer);
      layer.time = nextClip.duration * transition.offset + overflow;
      remaining = 0;
    }
    throw new Error("动作状态机在单帧内发生过多过渡");
  }

  sampleTime(clip, time, loop) {
    if (loop && clip.duration > 0) return time % clip.duration;
    return Math.min(time, clip.duration);
  }

  dispose() {
    this.stateSnapshot = null;
    for (const track of this.tracks) {
      track.object.position.fromArray(track.position);
      track.object.quaternion.fromArray(track.rotation);
    }
    for (const states of this.groupTrackStates.values()) {
      for (const state of states) {
        if (state.kind === "morph") {
          state.object.morphTargetInfluences[state.index] = state.original;
        } else if (state.kind === "transform") {
          state.object.position.fromArray(state.position);
          state.object.quaternion.fromArray(state.rotation);
          state.object.scale.fromArray(state.scale);
        } else if (state.kind === "visibility") {
          state.object.visible = state.original;
        }
      }
    }
    this.modelRoot.updateMatrixWorld(true);
  }
}

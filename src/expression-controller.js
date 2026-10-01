import { validateExpressionDefinitions } from "./model-manifest.js";
import { readonlySnapshot } from "./runtime-snapshot.js";

const gltfBindings = new WeakMap();
const DEFAULT_TRANSITION_SECONDS = 0.2;

// Capture GLTFLoader's authoritative associations before scene composition.
// Display names and extras are not original-node or primitive identity.
// Source identity also survives head/body composition moving nodes between roots.
export function registerExpressionNodes(gltf) {
  const { associations, json } = gltf.parser;
  gltf.scene.traverse((object) => {
    gltfBindings.delete(object);
    const association = associations.get(object);
    if (!association) return;
    gltfBindings.set(object, {
      source: gltf,
      isNode: association.nodes !== undefined,
      name: association.nodes !== undefined ? json.nodes[association.nodes].name : undefined,
      isPrimitive: association.primitives !== undefined,
    });
  });
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label}: 必须是有限数`);
  return value;
}
function unit(value, label) {
  finite(value, label);
  if (value < 0 || value > 1) throw new Error(`${label}: 必须在 [0,1] 内`);
  return value;
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: 必须是对象`);
}
function isPassObject(candidate) {
  for (let current = candidate; current; current = current.parent) {
    if (current.userData?.__parameterizedPassObject) return true;
  }
  return false;
}

// One original GLTF node can contain several primitives; bind all of them.
function resolveMorphMap(root, map, source) {
  const result = new Map();
  for (const nodeName of Object.keys(map).sort()) {
    const matches = [];
    root.traverse((candidate) => {
      const binding = gltfBindings.get(candidate);
      if (!isPassObject(candidate) && binding?.isNode && binding.name === nodeName
          && (source === undefined || binding.source === source)) matches.push(candidate);
    });
    if (matches.length !== 1) throw new Error(`Morph 节点 ${nodeName} 必须唯一命中，实际 ${matches.length}`);
    const node = matches[0];
    const primitives = [];
    const collect = (candidate) => {
      if (isPassObject(candidate)) return;
      const binding = gltfBindings.get(candidate);
      if (candidate !== node && binding?.isNode) return;
      if (binding?.isPrimitive) primitives.push(candidate);
      for (const child of candidate.children) collect(child);
    };
    collect(node);
    if (!primitives.length) throw new Error(`Morph 节点 ${nodeName} 没有自己的 primitive`);
    for (const morphName of Object.keys(map[nodeName]).sort()) {
      for (const candidate of primitives) {
        const index = candidate.morphTargetDictionary?.[morphName];
        if (index === undefined || !candidate.morphTargetInfluences) throw new Error(`Morph 不存在于全部 primitive: ${nodeName}/${morphName}`);
        if (!Number.isInteger(index) || index < 0 || index >= candidate.morphTargetInfluences.length) throw new Error(`Morph 索引无效 ${nodeName}/${morphName}`);
        const key = `${candidate.uuid}:${index}`;
        if (result.has(key)) throw new Error(`Morph 配方重复引用实际目标 ${nodeName}/${morphName}`);
        result.set(key, { object: candidate, index, weight: finite(map[nodeName][morphName], morphName) });
      }
    }
  }
  return result;
}
function add(map, key, value) {
  map.set(key, finite((map.get(key) || 0) + value, `Morph 求和 ${key}`));
}

export class ExpressionController {
  constructor(root, definition, source) {
    validateExpressionDefinitions(definition);
    this.root = root;
    this.definition = definition;
    this.poseBindings = new Map();
    this.writableBindings = new Map();
    this.initialValues = new Map();
    for (const pose of definition.morphPoses) {
      const bindings = resolveMorphMap(root, pose.targets, source);
      this.poseBindings.set(pose.name, bindings);
      for (const [key, binding] of bindings) this.writableBindings.set(key, binding);
    }
    this.groups = new Map(definition.expressionGroups.map((group) => [group.name,
      new Map(group.states.map((state) => [state.name, state]))]));
    this.presets = new Map(definition.expressions.map((preset) => [preset.name, preset.selections]));
    this.validVisemes = new Set();
    for (const [groupName, states] of this.groups) {
      for (const state of states.values()) {
        const controls = state.controls || {};
        for (const name of Object.keys(controls.visemes || {})) this.validVisemes.add(name);
        const blink = this.expandWeights(this.endpointDelta(state.poses, controls.blink));
        for (const endpoint of [controls.speech, ...Object.values(controls.visemes || {})]) {
          const mouth = this.expandWeights(this.endpointDelta(state.poses, endpoint));
          for (const [key, value] of blink) {
            if (value !== 0 && (mouth.get(key) || 0) !== 0) throw new Error(`blink 与嘴部控制改变同一实际 Morph: ${groupName}/${state.name}`);
          }
        }
      }
    }
    // Preserve independent generic parameters, without a hidden third owner
    // for face Morphs. Model parameter animations retain their own subsystem.
    this.parameterBindings = new Map();
    for (const [name, map] of Object.entries(definition.parameters || {})) {
      const bindings = resolveMorphMap(root, map, source);
      for (const [key, binding] of bindings) {
        if (this.writableBindings.has(key)) throw new Error(`parameters 与表情重复拥有 Morph: ${name}`);
        this.writableBindings.set(key, binding);
      }
      this.parameterBindings.set(name, { value: 0, bindings });
    }
    for (const [key, binding] of this.writableBindings) this.initialValues.set(key, finite(binding.object.morphTargetInfluences[binding.index], "初始 Morph"));
    this.active = true;
    this.pendingRestore = false;
    this.stateSnapshot = null;
    this.transition = null;
    this.renderedWeights = null;
    this.reset();
  }

  endpointDelta(base, endpoint) {
    const result = new Map();
    for (const name of Object.keys(endpoint || {}).sort()) result.set(name, finite(endpoint[name] - (Object.hasOwn(base, name) ? base[name] : 0), name));
    return result;
  }
  expandWeights(weights) {
    const result = new Map();
    for (const name of [...weights.keys()].sort()) {
      for (const [key, binding] of this.poseBindings.get(name)) add(result, key, weights.get(name) * binding.weight);
    }
    return result;
  }
  startTransition(duration) {
    finite(duration, "表情过渡时间");
    if (duration < 0) throw new Error("表情过渡时间必须非负");
    const from = this.renderedWeights === null ? this.evaluateWeights() : this.renderedWeights;
    this.transition = duration === 0 || !this.active ? null : { from: new Map(from), elapsed: 0, duration };
  }
  setExpression(name, duration = DEFAULT_TRANSITION_SECONDS) {
    if (!this.presets.has(name)) throw new Error(`未知表情 ${name}`);
    this.startTransition(duration);
    this.selections = new Map(Object.entries(this.presets.get(name)));
    this.expression = name;
    this.rawWeights = null;
    return true;
  }
  setGroup(group, state, duration = DEFAULT_TRANSITION_SECONDS) {
    if (!this.groups.get(group)?.has(state)) throw new Error(`未知分组或状态 ${group}/${state}`);
    this.startTransition(duration);
    this.selections.set(group, state);
    this.expression = null;
    this.rawWeights = null;
    return true;
  }
  setBlink(value) { this.blink = unit(value, "blink"); return true; }
  setSpeech(value) { this.speech = unit(value, "speech"); this.visemes = null; return true; }
  setVisemes(values) {
    if (values === null) { this.visemes = null; return true; }
    object(values, "visemes");
    let sum = 0;
    for (const name of Object.keys(values).sort()) {
      if (!this.validVisemes.has(name)) throw new Error(`未知口型 ${name}`);
      sum += unit(values[name], `visemes.${name}`);
    }
    if (sum > 1) throw new Error("visemes 权重和不得大于 1");
    this.visemes = { ...values };
    return true;
  }
  setMorphPoseWeights(values) {
    object(values, "Morph 配方权重");
    for (const [name, value] of Object.entries(values)) {
      if (!this.poseBindings.has(name)) throw new Error(`未知 Morph 配方 ${name}`);
      finite(value, name);
    }
    this.rawWeights = new Map(Object.entries(values));
    this.transition = null;
    return true;
  }
  setParameter(name, value) {
    const entry = this.parameterBindings.get(name);
    if (!entry) return false;
    entry.value = unit(value, `parameter.${name}`);
    return true;
  }
  reset() {
    this.transition = null;
    this.renderedWeights = null;
    this.selections = new Map([...this.groups].map(([name, states]) => [name, states.keys().next().value]));
    this.expression = null;
    this.rawWeights = null;
    this.blink = 0;
    this.speech = 0;
    this.visemes = null;
    if (this.definition.defaultExpression !== undefined) this.setExpression(this.definition.defaultExpression, 0);
    return true;
  }
  getCapabilities() {
    let blink = false;
    let speech = false;
    const visemes = new Set();
    for (const [group, state] of this.selections) {
      const controls = this.groups.get(group).get(state).controls || {};
      blink ||= controls.blink !== undefined;
      speech ||= controls.speech !== undefined;
      for (const name of Object.keys(controls.visemes || {})) visemes.add(name);
    }
    return {
      blink, speech, visemes: [...visemes].sort(), validVisemes: [...this.validVisemes].sort(),
      groups: [...this.groups].map(([name, states]) => ({ name, states: [...states.keys()] })),
      selections: Object.fromEntries(this.selections), expressions: [...this.presets.keys()],
    };
  }
  setActive(active) {
    if (typeof active !== "boolean") throw new Error("active 必须是 boolean");
    if (this.active && !active) this.pendingRestore = true;
    this.active = active;
  }
  // Host order: beginFrame -> animation/parameter animation -> update.
  // Restore once upon deactivation; subsequent inactive frames relinquish writes.
  beginFrame() {
    if (!this.active && !this.pendingRestore) return;
    for (const [key, binding] of this.writableBindings) binding.object.morphTargetInfluences[binding.index] = this.initialValues.get(key);
    this.pendingRestore = false;
  }
  evaluateWeights() {
    if (this.rawWeights !== null) return new Map(this.rawWeights);
    const weights = new Map();
    for (const [group, selected] of [...this.selections].sort(([a], [b]) => a.localeCompare(b))) {
      const state = this.groups.get(group).get(selected);
      for (const name of Object.keys(state.poses).sort()) add(weights, name, state.poses[name]);
      const controls = state.controls || {};
      const contribute = (endpoint, amount) => {
        for (const [name, delta] of this.endpointDelta(state.poses, endpoint)) add(weights, name, amount * delta);
      };
      contribute(controls.blink, this.blink);
      if (this.visemes === null) contribute(controls.speech, this.speech);
      else for (const name of Object.keys(this.visemes).sort()) contribute(controls.visemes?.[name], this.visemes[name]);
    }
    return weights;
  }
  update(deltaTime = 0) {
    finite(deltaTime, "表情帧时长");
    if (deltaTime < 0) throw new Error("表情帧时长必须非负");
    if (!this.active) {
      this.publishState(new Map());
      return;
    }
    let weights = this.evaluateWeights();
    let completedTransition = false;
    let transitionElapsed = 0;
    if (this.transition) {
      const { from, duration } = this.transition;
      const elapsed = Math.min(duration, this.transition.elapsed + deltaTime);
      const fraction = elapsed / duration;
      if (fraction < 1) {
        const blended = new Map();
        for (const name of new Set([...from.keys(), ...weights.keys()])) {
          add(blended, name, (from.get(name) || 0) * (1 - fraction) + (weights.get(name) || 0) * fraction);
        }
        weights = blended;
        transitionElapsed = elapsed;
      } else completedTransition = true;
    }
    const values = this.expandWeights(weights);
    for (const { value, bindings } of this.parameterBindings.values()) {
      for (const [key, binding] of bindings) values.set(key, finite(value * binding.weight, "parameter result"));
    }
    // Validate the entire result before touching scene objects.
    for (const [key, binding] of this.writableBindings) binding.object.morphTargetInfluences[binding.index] = values.get(key) || 0;
    if (this.transition) {
      if (completedTransition) this.transition = null;
      else this.transition.elapsed = transitionElapsed;
    }
    this.renderedWeights = new Map(weights);
    this.publishState(weights);
  }
  publishState(weights) {
    this.stateSnapshot = readonlySnapshot({
      active: this.active,
      expression: this.rawWeights === null ? this.expression : null,
      selections: Object.fromEntries(this.selections),
      blink: this.blink,
      speech: this.speech,
      visemes: this.visemes,
      rawWeights: this.rawWeights === null ? null : Object.fromEntries(this.rawWeights),
      poseWeights: Object.fromEntries(weights),
      parameters: Object.fromEntries([...this.parameterBindings].map(([name, entry]) => [name, entry.value])),
    });
  }
  getState() {
    return this.stateSnapshot;
  }
}

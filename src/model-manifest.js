import { componentsOfType } from "./resource-manifest.js";
import { validateIdlePose } from "./idle-pose.js";
import { validatePhysics } from "./model-physics.js";

const SUPPORTED_ROLES = new Set(["head", "body", "integrated"]);

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function requirePositiveScale(component, source) {
  if (!Number.isFinite(component.humanoidScale) || component.humanoidScale <= 0) {
    fail(source, "humanoidScale 必须是大于 0 的有限数");
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateMorphMap(map, source) {
  if (!isObject(map)) fail(source, "必须是 Morph 映射对象");
  for (const [node, morphs] of Object.entries(map)) {
    if (!node || !isObject(morphs)) fail(source, "节点必须映射到 Morph 权重对象");
    for (const [morph, weight] of Object.entries(morphs)) {
      if (!morph.trim() || !Number.isFinite(weight)) {
        fail(source, "Morph 权重必须是有限数");
      }
    }
  }
}

export function validateExpressionDefinitions(definition, source = "expressions") {
  const namedEntries = (entries, label, nonempty = false) => {
    if (!Array.isArray(entries) || (nonempty && !entries.length)) fail(label, "必须是数组且 states 不得为空");
    const result = new Map();
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.name !== "string" || !entry.name.trim()) fail(label, "name 必须是非空字符串");
      if (result.has(entry.name)) fail(label, `重复名称 ${entry.name}`);
      result.set(entry.name, entry);
    }
    return result;
  };
  const poses = namedEntries(definition.morphPoses, `${source}.morphPoses`);
  for (const pose of poses.values()) validateMorphMap(pose.targets, `${source}.morphPoses.${pose.name}`);
  const weights = (map, label) => {
    if (!isObject(map)) fail(label, "必须是配方权重对象");
    for (const [name, value] of Object.entries(map)) {
      if (!poses.has(name)) fail(label, `未知 Morph 配方 ${name}`);
      if (!Number.isFinite(value)) fail(label, "配方权重必须是有限数");
    }
  };
  const changedMorphs = (base, endpoint, label) => {
    const changes = new Map();
    for (const name of Object.keys(endpoint || {}).sort()) {
      const delta = endpoint[name] - (Object.hasOwn(base, name) ? base[name] : 0);
      if (!Number.isFinite(delta)) fail(label, "配方差值必须是有限数");
      for (const [node, morphs] of Object.entries(poses.get(name).targets)) {
        for (const [morph, weight] of Object.entries(morphs)) {
          const key = JSON.stringify([node, morph]);
          const result = (changes.get(key) || 0) + delta * weight;
          if (!Number.isFinite(result)) fail(label, "Morph 差值必须是有限数");
          changes.set(key, result);
        }
      }
    }
    return changes;
  };
  const groups = namedEntries(definition.expressionGroups, `${source}.expressionGroups`);
  const stateNames = new Map();
  for (const group of groups.values()) {
    const states = namedEntries(group.states, `${source}.${group.name}.states`, true);
    stateNames.set(group.name, states);
    for (const state of states.values()) {
      const label = `${source}.${group.name}.${state.name}`;
      weights(state.poses, `${label}.poses`);
      if (state.controls === undefined) continue;
      if (!isObject(state.controls)) fail(label, "controls 必须是对象");
      for (const key of ["blink", "speech"]) {
        if (state.controls[key] !== undefined) weights(state.controls[key], `${label}.${key}`);
      }
      if (state.controls.visemes !== undefined) {
        if (!isObject(state.controls.visemes)) fail(label, "visemes 必须是对象");
        for (const [name, endpoint] of Object.entries(state.controls.visemes)) {
          if (!name.trim()) fail(label, "口型名称不能为空");
          weights(endpoint, `${label}.visemes.${name}`);
        }
      }
      const blink = changedMorphs(state.poses, state.controls.blink, label);
      for (const endpoint of [state.controls.speech, ...Object.values(state.controls.visemes || {})]) {
        const mouth = changedMorphs(state.poses, endpoint, label);
        for (const [key, value] of blink) {
          if (value !== 0 && (mouth.get(key) || 0) !== 0) fail(label, "blink 与嘴部控制不能改变同一实际 Morph");
        }
      }
    }
  }
  const presets = namedEntries(definition.expressions, `${source}.expressions`);
  for (const preset of presets.values()) {
    if (!isObject(preset.selections)) fail(source, "selections 必须是对象");
    if (Object.keys(preset.selections).length !== groups.size) fail(source, "selections 必须完整选择全部分组");
    for (const [group, state] of Object.entries(preset.selections)) {
      if (!stateNames.get(group)?.has(state)) fail(source, `未知分组或状态 ${group}/${state}`);
    }
  }
  if (definition.defaultExpression !== undefined && !presets.has(definition.defaultExpression)) {
    fail(source, "defaultExpression 必须引用 expressions 中已有的名称");
  }
}

function validateBehaviors(component, source) {
  if (component.behaviors === undefined) return;
  if (!Array.isArray(component.behaviors)) {
    fail(source, "behaviors 必须是数组");
  }
  const names = new Set();
  for (const [index, declaration] of component.behaviors.entries()) {
    const declarationSource = `${source} behaviors[${index}]`;
    if (!isObject(declaration)) fail(declarationSource, "必须是对象");
    if (typeof declaration.name !== "string" || !declaration.name.trim()) {
      fail(declarationSource, "name 必须是非空字符串");
    }
    if (names.has(declaration.name)) {
      fail(source, `重复 Behavior ${declaration.name}`);
    }
    names.add(declaration.name);
    if (typeof declaration.required !== "boolean") {
      fail(declarationSource, "required 必须为 boolean");
    }
    if (!("parameters" in declaration)) {
      fail(declarationSource, "parameters 必须存在");
    }
  }
}

export function validateModelManifest(config, source = "config.json") {
  componentsOfType(config, "model", source);

  const rolesByName = new Map();
  for (const [index, component] of config.components.entries()) {
    if (component.type !== "model") continue;
    const componentSource = `${source} components[${index}]`;
    if (typeof component.name !== "string" || !component.name.trim()) {
      fail(componentSource, "name 必须是非空字符串");
    }
    if (!SUPPORTED_ROLES.has(component.role)) {
      fail(componentSource, "role 必须为 head、body 或 integrated");
    }
    const roles = rolesByName.get(component.name) || new Set();
    if (roles.has(component.role)) {
      fail(source, `模型 ${component.name} 的 role ${component.role} 不能重复`);
    }
    roles.add(component.role);
    rolesByName.set(component.name, roles);
    if (typeof component.model !== "string" || !component.model.trim()) {
      fail(componentSource, "model 必须是非空相对路径");
    }
    requirePositiveScale(component, componentSource);
    if (component.defaultMotion !== undefined
        && (typeof component.defaultMotion !== "string" || !component.defaultMotion.trim())) {
      fail(componentSource, "defaultMotion 必须是非空动作名称");
    }
    if (component.idlePose !== undefined) validateIdlePose(component.idlePose, `${componentSource} idlePose`);
    validateBehaviors(component, componentSource);
    if (component.physics !== undefined) validatePhysics(component.physics, componentSource);

    if (component.role === "head" || component.role === "integrated") {
      validateExpressionDefinitions(component, componentSource);
      if (component.defaultExpression !== undefined) {
        if (typeof component.defaultExpression !== "string" || !component.defaultExpression.trim()) {
          fail(componentSource, "defaultExpression 必须是非空字符串");
        }
        if (!component.expressions.some((item) => item?.name === component.defaultExpression)) {
          fail(componentSource, "defaultExpression 必须引用 expressions 中已有的名称");
        }
      }
    }
    if (component.role === "body"
        && ["morphPoses", "expressionGroups", "expressions", "defaultExpression"].some((key) => key in component)) {
      fail(componentSource, "body 不应声明表情字段");
    }
    if (component.role !== "integrated"
        && (typeof component.group !== "string" || !component.group.trim())) {
      fail(componentSource, "head/body 的 group 必须是非空字符串");
    }
    if (component.motionGroup !== undefined
        && (typeof component.motionGroup !== "string" || !component.motionGroup.trim())) {
      fail(componentSource, "motionGroup 存在时必须是非空字符串");
    }
  }
  for (const [name, roles] of rolesByName) {
    if (roles.has("integrated") && roles.size !== 1) {
      fail(source, `模型 ${name} 的 integrated 不能与 head 或 body 共存`);
    }
  }
  return config;
}

export function expandModelManifest(config, configPath) {
  validateModelManifest(config, configPath);
  const slash = configPath.lastIndexOf("/");
  const basePath = slash < 0 ? "" : configPath.slice(0, slash);
  return config.components.filter((component) => component.type === "model").map((component) => ({
    key: `${configPath}#model:${component.name}:${component.role}`,
    name: component.name,
    group: component.group,
    motionGroup: component.motionGroup,
    basePath,
    component,
  }));
}

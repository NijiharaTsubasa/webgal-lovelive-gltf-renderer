import { componentsOfType } from "./resource-manifest.js";
import { expressionDefinition } from "./runtime-snapshot.js";

const ROLE_ORDER = new Map([["head", 0], ["body", 1], ["integrated", 2]]);

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPackageRelativeScript(script) {
  if (typeof script !== "string" || !script.trim()) return false;
  const normalized = script.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
    && !normalized.split("/").includes("..")
    && normalized.endsWith(".js");
}

export function validateBehaviorPackage(config, source = "config.json") {
  componentsOfType(config, "behavior", source);
  const fullNames = new Set();
  for (const [index, component] of config.components.entries()) {
    if (component.type !== "behavior") continue;
    const componentSource = `${source} components[${index}]`;
    if (typeof component.namespace !== "string" || !component.namespace.trim()) {
      fail(componentSource, "namespace 必须是非空字符串");
    }
    if (typeof component.name !== "string" || !component.name.trim()) {
      fail(componentSource, "name 必须是非空字符串");
    }
    const fullName = `${component.namespace}.${component.name}`;
    if (fullNames.has(fullName)) {
      fail(source, `重复 Behavior ${fullName}`);
    }
    fullNames.add(fullName);
    if (!isPackageRelativeScript(component.script)) {
      fail(componentSource, "script 必须是包目录内的相对 .js 路径");
    }
    if (component.executionOrder !== undefined
        && !Number.isInteger(component.executionOrder)) {
      fail(componentSource, "executionOrder 必须是整数");
    }
  }
  return config;
}

export class BehaviorRegistry {
  constructor() {
    this.definitions = new Map();
  }

  registerPackage(config, options = {}) {
    const source = options.source || "config.json";
    validateBehaviorPackage(config, source);
    if (typeof options.loadModule !== "function") {
      fail(source, "loadModule 必须是函数");
    }
    for (const component of config.components.filter((entry) => entry.type === "behavior")) {
      const fullName = `${component.namespace}.${component.name}`;
      const definition = {
        fullName,
        executionOrder: component.executionOrder ?? 0,
        script: component.script.replaceAll("\\", "/"),
        source,
        loadModule: options.loadModule,
      };
      const existing = this.definitions.get(fullName);
      if (existing) {
        existing.push(definition);
      } else {
        this.definitions.set(fullName, [definition]);
      }
    }
    return this;
  }

  status(fullName) {
    const definitions = this.definitions.get(fullName) || [];
    if (definitions.length === 0) {
      return { available: false, reason: `未发现 Behavior ${fullName}` };
    }
    if (definitions.length > 1) {
      return {
        available: false,
        reason: `Behavior ${fullName} 注册冲突：${definitions.map((item) => item.source).join("，")}`,
      };
    }
    return { available: true, definition: definitions[0] };
  }

  async load(fullName) {
    const status = this.status(fullName);
    if (!status.available) throw new Error(status.reason);
    let module;
    try {
      module = await status.definition.loadModule(status.definition.script);
    } catch (error) {
      throw new Error(`Behavior ${fullName} 脚本加载失败: ${error.message}`, { cause: error });
    }
    if (!isConstructable(module?.default)) {
      throw new Error(`Behavior ${fullName} 的脚本没有可构造的默认导出`);
    }
    return { ...status.definition, Constructor: module.default };
  }
}

function isConstructable(value) {
  if (typeof value !== "function") return false;
  try {
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}

function invokeSync(record, method, time) {
  const callback = record.instance?.[method];
  if (callback === undefined) return;
  if (typeof callback !== "function") {
    throw new Error(`Behavior ${record.fullName}.${method} 必须可调用`);
  }
  const result = callback.call(record.instance, time);
  if (result && typeof result.then === "function") {
    throw new Error(`Behavior ${record.fullName}.${method} 必须同步执行`);
  }
}

function aggregateDeclarations(parts) {
  const groups = new Map();
  for (const part of parts) {
    for (const declaration of part.component.behaviors || []) {
      const group = groups.get(declaration.name) || {
        fullName: declaration.name,
        required: false,
        declarations: [],
      };
      group.required ||= declaration.required;
      group.declarations.push({ role: part.role, parameters: declaration.parameters });
      groups.set(declaration.name, group);
    }
  }
  for (const group of groups.values()) {
    group.declarations.sort((a, b) => ROLE_ORDER.get(a.role) - ROLE_ORDER.get(b.role));
  }
  return [...groups.values()];
}

export class BehaviorManager {
  constructor({
    registry,
    parts,
    context,
    humanoidScale,
    fixedDeltaTime = 1 / 60,
  }) {
    if (!(registry instanceof BehaviorRegistry)) {
      throw new TypeError("registry 必须是 BehaviorRegistry");
    }
    if (!Number.isFinite(humanoidScale) || humanoidScale <= 0) {
      throw new Error("humanoidScale 必须是大于 0 的有限数");
    }
    if (!Number.isFinite(fixedDeltaTime) || fixedDeltaTime <= 0) {
      throw new Error("fixedDeltaTime 必须是大于 0 的有限数");
    }
    this.registry = registry;
    this.parts = parts;
    this.hostContext = context;
    this.humanoidScale = humanoidScale;
    this.fixedDeltaTime = fixedDeltaTime;
    this.fixedAccumulator = 0;
    this.scaleWriter = undefined;
    this.records = [];
    this.diagnostics = [];
    this.time = { deltaTime: 0, fixedDeltaTime, elapsedTime: 0 };
    this.destroyed = false;
    this.expressionDefinitions = new Map(parts.map((part) => [part.role, expressionDefinition(part.component)]));
    this.expressionControllers = new Map();
    this.expressionStates = new Map();
    this.motionPlayer = null;
    this.motionDefinition = null;
    this.motionSnapshot = null;
  }

  async initialize() {
    const groups = aggregateDeclarations(this.parts);
    const resolutions = await Promise.all(groups.map(async (group) => {
      try {
        return { group, definition: await this.registry.load(group.fullName) };
      } catch (error) {
        return { group, error };
      }
    }));
    const requiredFailure = resolutions.find((item) => item.error && item.group.required);
    if (requiredFailure) throw requiredFailure.error;
    for (const item of resolutions) {
      if (item.error) {
        this.diagnostics.push({
          name: item.group.fullName,
          message: item.error.message,
        });
      }
    }
    const resolved = resolutions.filter((item) => !item.error).sort((a, b) => {
      const order = a.definition.executionOrder - b.definition.executionOrder;
      if (order) return order;
      return a.group.fullName < b.group.fullName ? -1 : a.group.fullName > b.group.fullName ? 1 : 0;
    });

    for (const { group, definition } of resolved) {
      const record = { ...definition, declarations: group.declarations };
      const behaviorContext = this.createContext(record.fullName);
      record.instance = new definition.Constructor(behaviorContext, group.declarations);
      if (record.instance && typeof record.instance.then === "function") {
        throw new Error(`Behavior ${record.fullName} 构造函数必须同步执行`);
      }
      this.records.push(record);
    }
    for (const method of ["Awake", "OnEnable", "Start"]) {
      for (const record of this.records) invokeSync(record, method, this.time);
    }
    return this;
  }

  createContext(fullName) {
    return Object.freeze({
      ...this.hostContext,
      parts: this.parts,
      time: this.time,
      resolveNode: (role, name) => this.resolveNode(role, name),
      getHumanoidScale: () => this.humanoidScale,
      setHumanoidScale: (value) => this.setHumanoidScale(fullName, value),
      getExpressionDefinition: (role) => this.getExpressionDefinition(role),
      getExpressionState: (role) => this.getExpressionState(role),
      getMotionDefinition: () => this.motionDefinition,
      getMotionState: () => this.motionSnapshot,
    });
  }

  validateRole(role) {
    if (!ROLE_ORDER.has(role) || !this.parts.some((part) => part.role === role)) {
      throw new Error(`表情查询不存在组件角色 ${role}`);
    }
  }

  getExpressionDefinition(role) {
    this.validateRole(role);
    return this.expressionDefinitions.get(role) ?? null;
  }

  getExpressionState(role) {
    this.validateRole(role);
    return this.expressionStates.get(role) ?? null;
  }

  // Host wiring only. Behavior receives queries, not controller/setter access.
  setExpressionController(role, controller) {
    this.validateRole(role);
    this.expressionControllers.set(role, controller);
    this.expressionStates.delete(role);
  }

  setMotion(player, resource) {
    const definition = player ? player.getDefinition(resource) : null;
    this.motionPlayer = player;
    this.motionDefinition = definition;
    this.motionSnapshot = null;
  }

  resolveNode(role, name) {
    const part = this.parts.find((item) => item.role === role);
    if (!part) throw new Error(`resolveNode 未找到角色 ${role}`);
    const matches = part.nodesByName?.get(name) || [];
    if (matches.length !== 1) {
      throw new Error(`resolveNode(${role}, ${name}) 必须恰好命中一个节点，实际 ${matches.length}`);
    }
    return matches[0];
  }

  setHumanoidScale(fullName, value) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Behavior ${fullName} 写入的 humanoidScale 必须是大于 0 的有限数`);
    }
    if (this.scaleWriter && this.scaleWriter !== fullName) {
      throw new Error(`humanoidScale 写入冲突：${this.scaleWriter} 与 ${fullName}`);
    }
    this.scaleWriter = fullName;
    this.humanoidScale = value;
  }

  beforeMotion(deltaTime, elapsedTime) {
    if (!Number.isFinite(deltaTime) || deltaTime < 0) {
      throw new Error("deltaTime 必须是非负有限数");
    }
    this.time.deltaTime = deltaTime;
    this.time.elapsedTime = elapsedTime;
    this.fixedAccumulator += deltaTime;
    while (this.fixedAccumulator + Number.EPSILON >= this.fixedDeltaTime) {
      for (const record of this.records) invokeSync(record, "FixedUpdate", this.time);
      this.fixedAccumulator -= this.fixedDeltaTime;
    }
    for (const record of this.records) invokeSync(record, "Update", this.time);
  }

  afterMotion() {
    // Publish both domains together, before the first consumer can read them.
    this.expressionStates = new Map([...this.expressionControllers]
      .map(([role, controller]) => [role, controller?.getState() ?? null]));
    this.motionSnapshot = this.motionPlayer?.getState() ?? null;
    for (const record of this.records) invokeSync(record, "LateUpdate", this.time);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    let firstError;
    for (const method of ["OnDisable", "OnDestroy"]) {
      for (const record of this.records) {
        try {
          invokeSync(record, method, this.time);
        } catch (error) {
          firstError ||= error;
        }
      }
    }
    this.records.length = 0;
    this.expressionDefinitions.clear();
    this.expressionControllers.clear();
    this.expressionStates.clear();
    this.motionPlayer = null;
    this.motionDefinition = null;
    this.motionSnapshot = null;
    if (firstError) throw firstError;
  }
}

export function indexNodesByName(root) {
  const nodesByName = new Map();
  root.traverse((node) => {
    const name = node.userData?.name || node.name;
    const matches = nodesByName.get(name) || [];
    matches.push(node);
    nodesByName.set(name, matches);
  });
  return nodesByName;
}

export function createBehaviorRegistryFromModules(configModules, scriptModules) {
  const registry = new BehaviorRegistry();
  for (const [configPath, importedConfig] of Object.entries(configModules).sort()) {
    const config = importedConfig?.default ?? importedConfig;
    const packageDirectory = configPath.slice(0, configPath.lastIndexOf("/"));
    registry.registerPackage(config, {
      source: configPath,
      loadModule(script) {
        const modulePath = `${packageDirectory}/${script}`;
        const loader = scriptModules[modulePath];
        if (!loader) {
          return Promise.reject(new Error(`未发现包内脚本 ${modulePath}`));
        }
        return loader();
      },
    });
  }
  return registry;
}

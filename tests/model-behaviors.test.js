import test from "node:test";
import assert from "node:assert/strict";
import { readonlySnapshot } from "../src/runtime-snapshot.js";

import {
  BehaviorManager,
  BehaviorRegistry,
  createBehaviorRegistryFromModules,
  indexNodesByName,
  validateBehaviorPackage,
} from "../src/model-behaviors.js";

function behaviorPackage(namespace, components) {
  return {
    components: components.map((component) => ({
      type: "behavior",
      namespace,
      ...component,
    })),
  };
}

function part(role, component = {}) {
  return {
    role,
    component: { role, model: `${role}.glb`, humanoidScale: 1, ...component },
    root: { role },
    gltf: { scene: { role } },
    nodesByName: new Map(),
  };
}

test("PostPhysics is optional and runs after animation/physics with the same snapshot and time", async () => {
  const calls = [];
  const registry = new BehaviorRegistry();
  registry.registerPackage(behaviorPackage("Physics", [{name: "Adjust", script: "adjust.js"}]), {
    loadModule: async () => ({default: class {
      constructor(context) { this.context = context; }
      Update(time) { calls.push(["update", time.deltaTime]); }
      LateUpdate(time) { calls.push(["late", time.deltaTime]); }
      PostPhysics(time) { calls.push(["post", time.deltaTime, this.context.getMotionState()]); }
    }}),
  });
  const manager = new BehaviorManager({registry, parts: [part("integrated", {
    behaviors: [{name: "Physics.Adjust", required: true, parameters: {}}],
  })], humanoidScale: 1, context: {}});
  await manager.initialize();
  manager.beforeMotion(1 / 60, 1);
  manager.afterMotion();
  calls.push(["physics"]);
  manager.afterPhysics();
  assert.deepEqual(calls, [["update", 1 / 60], ["late", 1 / 60], ["physics"], ["post", 1 / 60, null]]);
  manager.destroy();
});

test("Behavior queries expose role-scoped definitions and atomically publish completed evaluation", async () => {
  let context;
  const observations=[];
  const registry=new BehaviorRegistry();
  registry.registerPackage(behaviorPackage("Query",[{name:"Reader",script:"reader.js"}]),{
    loadModule:async()=>({default:class {
      constructor(c){context=c;}
      Start(){observations.push(["start",context.getExpressionState("head"),context.getMotionState()]);}
      Update(){observations.push(["update",context.getExpressionState("head"),context.getMotionState()]);}
      LateUpdate(){observations.push(["late",context.getExpressionState("head"),context.getMotionState()]);}
      OnDestroy(){observations.push(["destroy",context.getExpressionDefinition("head")]);}
    }}),
  });
  const definition={morphPoses:[{name:"eye",targets:{face:{eye:1}}}],expressionGroups:[],expressions:[],defaultExpression:"preset"};
  const head=part("head",{...definition,behaviors:[{name:"Query.Reader",required:true,parameters:{}}]});
  const manager=new BehaviorManager({registry,parts:[head,part("body")],humanoidScale:1,context:{}});
  await manager.initialize();
  assert.deepEqual(observations[0],["start",null,null]);
  assert.deepEqual(context.getExpressionDefinition("head"),definition);
  assert.equal(context.getExpressionDefinition("body"),null);
  assert.equal(context.getExpressionState("body"),null);
  assert.throws(()=>context.getExpressionState("integrated"),/不存在组件角色/);
  assert.throws(()=>context.getExpressionDefinition("HEAD"),/不存在组件角色/);
  assert.equal(context.getExpressionDefinition("head").behaviors,undefined);
  assert.throws(()=>{context.getExpressionDefinition("head").morphPoses[0].name="changed";},TypeError);
  definition.morphPoses[0].name="caller-owned";
  assert.equal(context.getExpressionDefinition("head").morphPoses[0].name,"eye");

  let face=null,motion=null;
  manager.setExpressionController("head",{getState:()=>face});
  manager.setMotion({getDefinition:resource=>readonlySnapshot({resource}),getState:()=>motion},{type:"motion",name:"run"});
  assert.equal(context.getMotionDefinition().resource.name,"run");
  manager.beforeMotion(0,0);
  face=readonlySnapshot({active:true,poseWeights:{eye:.3}});
  motion=readonlySnapshot({layers:[{id:"base",time:.25}]});
  assert.equal(context.getExpressionState("head"),null);
  assert.equal(context.getMotionState(),null);
  manager.afterMotion();
  assert.deepEqual(observations.at(-1),["late",face,motion]);
  const oldFace=context.getExpressionState("head"),oldMotion=context.getMotionState();
  face=readonlySnapshot({active:true,poseWeights:{eye:.8}});
  manager.beforeMotion(0,.1);
  assert.deepEqual(observations.at(-1),["update",oldFace,oldMotion]);
  motion=readonlySnapshot({layers:[{id:"base",time:.5}]});
  manager.afterMotion();
  assert.deepEqual(observations.at(-1),["late",face,motion]);
  assert.equal(oldFace.poseWeights.eye,.3);
  manager.setMotion(null);
  assert.equal(context.getMotionState(),null);assert.equal(context.getMotionDefinition(),null);
  manager.destroy();
  assert.notEqual(observations.at(-1)[1],null);
  assert.equal(context.getExpressionDefinition("head"),null);
  assert.equal(context.getExpressionState("head"),null);
});

test("Behavior node index uses the original glTF name retained by GLTFLoader", () => {
  const renderer = {
    name: "body_Base_obj_Renderer",
    userData: { name: "body_Base_obj Renderer" },
  };
  const root = { traverse: (visit) => visit(renderer) };
  const index = indexNodesByName(root);
  assert.deepEqual(index.get("body_Base_obj Renderer"), [renderer]);
  assert.equal(index.has("body_Base_obj_Renderer"), false);
});

test("Behavior package validation is atomic and rejects unsafe scripts", () => {
  const registry = new BehaviorRegistry();
  assert.throws(() => registry.registerPackage(behaviorPackage("Pkg", [
    { name: "Good", script: "good.js" },
    { name: "Bad", script: "../bad.js" },
  ]), { source: "broken/config.json", loadModule: async () => ({ default: class {} }) }),
  /包目录/);
  assert.equal(registry.status("Pkg.Good").available, false);

  assert.throws(() => validateBehaviorPackage(behaviorPackage("Pkg", [
    { name: "Same", script: "a.js" },
    { name: "Same", script: "b.js" },
  ])), /重复 Behavior Pkg\.Same/);
});

test("same namespace can span packages while duplicate full names only conflict locally", () => {
  const registry = new BehaviorRegistry();
  const loadModule = async () => ({ default: class {} });
  registry.registerPackage(behaviorPackage("Pkg", [
    { name: "First", script: "first.js" },
    { name: "Clash", script: "clash-a.js" },
  ]), { source: "a/config.json", loadModule });
  registry.registerPackage(behaviorPackage("Pkg", [
    { name: "Second", script: "second.js" },
    { name: "Clash", script: "clash-b.js" },
  ]), { source: "b/config.json", loadModule });

  assert.equal(registry.status("Pkg.First").available, true);
  assert.equal(registry.status("Pkg.Second").available, true);
  assert.match(registry.status("Pkg.Clash").reason, /冲突/);
});

test("manager aggregates declarations, resolves all modules, and runs staged lifecycle", async () => {
  const events = [];
  const registry = new BehaviorRegistry();
  const makeClass = (name) => class {
    constructor(_context, declarations) {
      events.push(`construct:${name}:${declarations.map((item) => item.role).join(",")}`);
    }
    Awake() { events.push(`Awake:${name}`); }
    OnEnable() { events.push(`OnEnable:${name}`); }
    Start() { events.push(`Start:${name}`); }
    FixedUpdate() { events.push(`FixedUpdate:${name}`); }
    Update() { events.push(`Update:${name}`); }
    LateUpdate() { events.push(`LateUpdate:${name}`); }
    OnDisable() { events.push(`OnDisable:${name}`); }
    OnDestroy() { events.push(`OnDestroy:${name}`); }
  };
  registry.registerPackage(behaviorPackage("Pkg", [
    { name: "Later", script: "later.js", executionOrder: 10 },
    { name: "Earlier", script: "earlier.js", executionOrder: -10 },
  ]), {
    source: "pkg/config.json",
    loadModule: async (script) => ({
      default: makeClass(script === "later.js" ? "Later" : "Earlier"),
    }),
  });
  const head = part("head", { behaviors: [
    { name: "Pkg.Later", required: false, parameters: { from: "head" } },
    { name: "Pkg.Earlier", required: true, parameters: {} },
  ] });
  const body = part("body", { behaviors: [
    { name: "Pkg.Later", required: true, parameters: { from: "body" } },
  ] });
  const manager = new BehaviorManager({
    registry,
    parts: [body, head],
    context: {},
    humanoidScale: 1,
    fixedDeltaTime: 0.02,
  });

  await manager.initialize();
  manager.beforeMotion(0.05, 1);
  events.push("motion");
  manager.afterMotion();
  manager.destroy();

  assert.deepEqual(events, [
    "construct:Earlier:head",
    "construct:Later:head,body",
    "Awake:Earlier", "Awake:Later",
    "OnEnable:Earlier", "OnEnable:Later",
    "Start:Earlier", "Start:Later",
    "FixedUpdate:Earlier", "FixedUpdate:Later",
    "FixedUpdate:Earlier", "FixedUpdate:Later",
    "Update:Earlier", "Update:Later",
    "motion",
    "LateUpdate:Earlier", "LateUpdate:Later",
    "OnDisable:Earlier", "OnDisable:Later",
    "OnDestroy:Earlier", "OnDestroy:Later",
  ]);
});

test("optional unavailable Behavior degrades but required unavailable rejects before construction", async () => {
  let constructed = 0;
  const registry = new BehaviorRegistry();
  registry.registerPackage(behaviorPackage("Pkg", [
    { name: "Present", script: "present.js" },
  ]), {
    source: "pkg/config.json",
    loadModule: async () => ({ default: class { constructor() { constructed += 1; } } }),
  });

  const optional = new BehaviorManager({
    registry,
    parts: [part("integrated", { behaviors: [
      { name: "Pkg.Missing", required: false, parameters: {} },
    ] })],
    context: {},
    humanoidScale: 1,
  });
  await optional.initialize();
  assert.equal(optional.diagnostics.length, 1);

  const required = new BehaviorManager({
    registry,
    parts: [part("integrated", { behaviors: [
      { name: "Pkg.Present", required: false, parameters: {} },
      { name: "Pkg.Missing", required: true, parameters: {} },
    ] })],
    context: {},
    humanoidScale: 1,
  });
  await assert.rejects(() => required.initialize(), /Pkg\.Missing/);
  assert.equal(constructed, 0);
});

test("context resolves exact role-scoped names and permits only one scale writer", async () => {
  const registry = new BehaviorRegistry();
  const writes = [];
  class First {
    constructor(context) {
      assert.equal(context.resolveNode("head", "Bone"), 42);
      context.setHumanoidScale(1.2);
      writes.push(context.getHumanoidScale());
    }
  }
  class Second {
    constructor(context) { context.setHumanoidScale(1.3); }
  }
  registry.registerPackage(behaviorPackage("Pkg", [
    { name: "First", script: "first.js" },
    { name: "Second", script: "second.js" },
  ]), {
    source: "pkg/config.json",
    loadModule: async (script) => ({ default: script === "first.js" ? First : Second }),
  });
  const head = part("head", { behaviors: [
    { name: "Pkg.First", required: true, parameters: {} },
    { name: "Pkg.Second", required: true, parameters: {} },
  ] });
  head.nodesByName.set("Bone", [42]);
  const manager = new BehaviorManager({ registry, parts: [head], context: {}, humanoidScale: 1 });

  await assert.rejects(() => manager.initialize(), /humanoidScale.*冲突/);
  assert.deepEqual(writes, [1.2]);
});

test("thenable lifecycle callbacks fail because lifecycle is synchronous", async () => {
  const registry = new BehaviorRegistry();
  registry.registerPackage(behaviorPackage("Pkg", [
    { name: "Async", script: "async.js" },
  ]), {
    source: "pkg/config.json",
    loadModule: async () => ({ default: class { Awake() { return Promise.resolve(); } } }),
  });
  const manager = new BehaviorManager({
    registry,
    parts: [part("integrated", { behaviors: [
      { name: "Pkg.Async", required: true, parameters: {} },
    ] })],
    context: {},
    humanoidScale: 1,
  });

  await assert.rejects(() => manager.initialize(), /同步执行/);
});

test("installed registry resolves scripts relative to each package config", async () => {
  class First {}
  class Second {}
  const registry = createBehaviorRegistryFromModules({
    "./behaviors/one/config.json": { default: behaviorPackage("Shared", [
      { name: "First", script: "first.js" },
    ]) },
    "./behaviors/two/config.json": behaviorPackage("Shared", [
      { name: "Second", script: "nested/second.js" },
    ]),
  }, {
    "./behaviors/one/first.js": async () => ({ default: First }),
    "./behaviors/two/nested/second.js": async () => ({ default: Second }),
  });

  assert.equal((await registry.load("Shared.First")).Constructor, First);
  assert.equal((await registry.load("Shared.Second")).Constructor, Second);
});

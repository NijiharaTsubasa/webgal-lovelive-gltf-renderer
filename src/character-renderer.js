import * as THREE from "three";
import { ResourceGLTFLoader } from "./resource-gltf-loader.js";
import * as shaders from "./parameterized-renderer.js";
import { MotionPlayer } from "./motion-player.js";
import { ExpressionController, registerExpressionNodes } from "./expression-controller.js";
import { composeHumanoidHeadBody } from "./skeleton-composer.js";
import { fetchMotionPayload } from "./motion-binary.js";
import { validateMotionPayload } from "./motion-manifest.js";
import { BehaviorManager, indexNodesByName } from "./model-behaviors.js";
import { ResourcePackages } from "./resource-packages.js";
import { createModelPhysics } from "./model-physics.js";
import { IdlePose } from "./idle-pose.js";
import { ParameterPlayer } from "./garupa/player.js";
import { ParameterBodyPose } from "./garupa/body-pose.js";
import bodyCalibration from "./garupa/body-calibration.js";

// Owns one character's runtime state. The host owns the scene, camera, renderer,
// resource catalog, clock and UI; none of those are assumed to be a preview page.
export class CharacterRenderer {
  constructor({ renderer, scene, camera, fetchResource = fetch, loader = new ResourceGLTFLoader(fetchResource), resourcePackages = new ResourcePackages({ fetchResource }), meshClothEnabled = true }) {
    if (typeof meshClothEnabled !== "boolean") throw new Error("meshClothEnabled must be boolean");
    this.meshClothEnabled = meshClothEnabled;
    this.resourcePackages = resourcePackages;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.loader = loader;
    this.fetchResource = (...args) => fetchResource(...args);
    this.generation = 0;
    this.motionGeneration = 0;
    this.commitQueue = Promise.resolve();
    this.physicsEnabled = true;
    this.shadersEnabled = true;
    this.elapsedTime = 0;
    this.root = null;
    this.config = null;
    this.motionGroup = null;
    this.faceDefinition = null;
    this.face = null;
    this.faceActiveRequested = true;
    this.faceMorphKeys = new Set();
    this.externalExpressionDriver = null;
    this.expressionControllers = [];
    this.rememberedFace = null;
    this.expressionName = "";
    this.motion = null;
    this.motionInfo = null;
    this.pendingMotion = null;
    this.idlePose = null;
    this.behaviors = null;
    this.physics = null;
    this.parts = [];
    this.parameterRuntime = null;
    this.parameterAdapters = null;
    this.parameterPlayer = null;
    this.parameterBody = null;
    this.parameterFaceGeneration = 0;
    this.parameterExpressionGeneration = 0;
    this.parameterFaceActive = false;
    this.shaderScope = null;
  }

  get faceCapabilities() { return this.face?.getCapabilities(); }
  get canStopMotion() { return Boolean(this.parameterBody || this.motion?.motion?.program?.commands?.stop?.length); }

  configureParameterPlayback({ runtime, adapters }) {
    this.parameterRuntime = runtime;
    this.parameterAdapters = adapters;
  }

  ensureParameterPlayer() {
    return this.parameterPlayer ??= new ParameterPlayer(this.parameterRuntime, bodyCalibration);
  }

  expressionAdapterContext() {
    return { THREE, root: this.root, parts: this.parts,
      resolveNode: (role, name) => this.behaviors.resolveNode(role, name),
      getShaderRuntimes: shaders.getShaderRuntimes };
  }

  async setParameterFace(active) {
    const generation = ++this.parameterFaceGeneration;
    const root = this.root;
    if (!active) {
      this.parameterFaceActive = false;
      this.setExternalExpressionDriver(null);
      return false;
    }
    this.ensureParameterPlayer();
    const factory = await this.parameterAdapters?.factory(this.motionGroup);
    if (generation !== this.parameterFaceGeneration || root !== this.root) return false;
    if (!factory || !root) {
      this.setExternalExpressionDriver(null); this.parameterFaceActive = false;
      return false;
    }
    if (this.parameterFaceActive) return true;
    const adapter = factory(this.expressionAdapterContext());
    if (!adapter) return false;
    const player = this.parameterPlayer;
    this.setExternalExpressionDriver({ beginFrame: () => adapter.restore(),
      update: delta => adapter.apply(player.parameters, { time: player.time, delta }),
      dispose: () => adapter.dispose() });
    this.parameterFaceActive = true;
    return true;
  }

  async selectParameterExpression(entry, url) {
    const generation = ++this.parameterExpressionGeneration;
    const root = this.root;
    const player = this.ensureParameterPlayer();
    let json = null;
    if (entry) {
      try {
        const response = await this.fetchResource(url);
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        json = await response.json();
        for (const key of ['fade_in', 'fade_out']) {
          if (entry.component?.[key] !== undefined) json[key] = entry.component[key];
        }
      } catch (error) {
        if (generation !== this.parameterExpressionGeneration || root !== this.root) return;
        throw error;
      }
    }
    if (generation !== this.parameterExpressionGeneration || root !== this.root) return;
    player.setExpression(json);
  }

  async selectParameterMotion(entry, url) {
    const generation = ++this.motionGeneration;
    const root = this.root;
    if (!root) return;
    this.pendingMotion = null;
    let parameterText;
    try {
      const response = await this.fetchResource(url);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      parameterText = await response.text();
    } catch (error) {
      if (generation !== this.motionGeneration || root !== this.root) return;
      throw error;
    }
    if (generation !== this.motionGeneration || root !== this.root) return;
    this.ensureParameterPlayer();
    this.pendingMotion = { generation, root, parameterText, entry };
  }

  setParameterBlink(value) { this.ensureParameterPlayer().blink = value; }
  setParameterSpeech(value) { this.ensureParameterPlayer().speech = value; }

  setPhysicsEnabled(enabled) {
    this.physicsEnabled = Boolean(enabled);
    this.physics?.setEnabled(this.physicsEnabled);
  }

  setShadersEnabled(enabled) {
    this.shadersEnabled = Boolean(enabled);
    if (this.root) shaders.setParameterizedRenderingEnabled(this.root, this.shadersEnabled);
  }

  setExpression(name) {
    if (!name || !this.face?.setExpression(name)) return false;
    this.expressionName = name;
    return true;
  }

  setExpressionGroup(group, state) {
    if (!this.face) return;
    this.face.setGroup(group, state);
    this.expressionName = "";
  }

  setBlink(value) { this.face?.setBlink(value); }
  setSpeech(value) { this.face?.setSpeech(value); }
  setFaceActive(active) {
    if (typeof active !== "boolean") throw new Error("active 必须是 boolean");
    this.faceActiveRequested = active;
    this.syncFaceActivity();
  }

  syncFaceActivity() {
    const motionOwnsFace = this.motion?.hasActiveGroupMorphTargets?.(this.faceMorphKeys) ?? false;
    this.face?.setActive(this.faceActiveRequested && !this.externalExpressionDriver && !motionOwnsFace);
  }

  // An external driver owns only its bound properties, not the character's
  // animation loop. beginFrame restores the previous underlay; update captures
  // the new animated underlay before writing. Release precedes resource disposal.
  setExternalExpressionDriver(driver) {
    if (driver !== null && (typeof driver?.beginFrame !== "function"
        || typeof driver?.update !== "function")) {
      throw new Error("外部表情驱动必须提供 beginFrame 和 update");
    }
    if (driver === this.externalExpressionDriver) return;
    const previous = this.externalExpressionDriver;
    this.externalExpressionDriver = null;
    if (previous) {
      try {
        previous.beginFrame();
      } finally {
        try { previous.dispose?.(); }
        finally { this.syncFaceActivity(); }
      }
    }
    if (!driver) return;
    this.externalExpressionDriver = driver;
    this.syncFaceActivity();
  }

  rememberFace() {
    if (!this.face) return;
    this.rememberedFace = {
      selections: this.face.getCapabilities().selections,
      expression: this.expressionName,
      blink: this.face.blink,
      speech: this.face.speech,
    };
  }

  clear({ rememberFace = true } = {}) {
    this.generation += 1;
    this.motionGeneration += 1;
    this.parameterFaceGeneration += 1;
    this.parameterExpressionGeneration += 1;
    if (rememberFace) this.rememberFace();
    this.setExternalExpressionDriver(null);
    this.parameterFaceActive = false;
    this.parameterBody?.restore(); this.parameterBody = null;
    this.parameterPlayer?.dispose(); this.parameterPlayer = null;
    this.parts = [];
    this.physics?.destroy();
    this.physics = null;
    this.behaviors?.setMotion(null);
    this.motion?.dispose();
    this.motion = null;
    this.motionInfo = null;
    this.pendingMotion = null;
    this.behaviors?.destroy();
    this.behaviors = null;
    this.idlePose = null;
    this.face = null;
    this.faceActiveRequested = true;
    this.faceMorphKeys = new Set();
    this.faceDefinition = null;
    this.expressionControllers = [];
    this.expressionName = "";
    this.shaderScope?.dispose();
    this.shaderScope = null;
    if (this.root) this.scene.remove(this.root);
    this.root = null;
    this.config = null;
    this.motionGroup = null;
    this.elapsedTime = 0;
  }

  async load(entries, packagesRoot) {
    const integrated = entries.length === 1 && entries[0]?.component.role === "integrated";
    const composed = entries.length === 2 && entries[0]?.component.role === "head"
      && entries[1]?.component.role === "body";
    if (!integrated && !composed) throw new Error("角色必须是一体化模型或同组 head + body");
    if (composed && (!entries[0].group || entries[0].group !== entries[1].group)) {
      throw new Error(`组合资源 group 不兼容：${entries[0].group || "<empty>"} / ${entries[1].group || "<empty>"}`);
    }
    this.clear();
    const generation = this.generation;
    const loadPromise = Promise.all(entries.map(async (entry) => {
      const basePath = `${packagesRoot}${entry.basePath.replace(/\/?$/, "/")}`;
      const modelUrl = URL.canParse(basePath)
        ? new URL(entry.component.model, basePath).href : `${basePath}${entry.component.model}`;
      const gltf = await this.loader.loadAsync(modelUrl);
      registerExpressionNodes(gltf);
      return { role: entry.component.role, component: entry.component, gltf,
        root: gltf.scene, nodesByName: indexNodesByName(gltf.scene) };
    }));
    let parts;
    try {
      parts = await loadPromise;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
    if (generation !== this.generation) return null;
    const result = this.commitQueue.then(async () => {
      if (generation !== this.generation) return null;
      const body = integrated ? parts[0] : parts[1];
      const root = body.root;
      let composition;
      let manager;
      let physics;
      let shaderScope;
      let committed = false;
      try {
        if (composed) {
          composition = composeHumanoidHeadBody(root, parts[0].root);
          parts[0].nodeBindings = composition.nodeBindings;
        }
        manager = new BehaviorManager({
          registry: this.resourcePackages.behaviors, parts,
          humanoidScale: body.component.humanoidScale,
          context: { THREE, renderer: this.renderer, scene: this.scene, camera: this.camera, root },
        });
        await manager.initialize();
        physics = await createModelPhysics(root, parts, { meshClothEnabled: this.meshClothEnabled });
        physics.setEnabled(this.physicsEnabled);
        if (generation !== this.generation) return null;
        shaderScope = shaders.createShaderRuntimeScope(this.renderer, this.resourcePackages.shaders);
        this.shaderScope = shaderScope;
        for (const part of parts) {
          await shaderScope.applyCustomShaders(part.gltf, part.root);
          if (generation !== this.generation) return null;
        }
        // Three caches a SkinnedMesh's bounds from one pose; skeletal motion
        // does not update them. Small parts can otherwise vanish while their
        // deformed vertices are still on screen. Include shader-created passes
        // and avoid a full CPU skinning scan every frame just for culling.
        root.traverse((node) => {
          if (node.isSkinnedMesh) node.frustumCulled = false;
        });
        shaders.setParameterizedRenderingEnabled(root, this.shadersEnabled);
        const config = { ...body.component, humanoidScale: manager.humanoidScale };
        const faceDefinition = integrated ? body.component : parts[0].component;
        const controllers = parts.filter((part) => part.component.morphPoses).map((part) => {
          const controller = new ExpressionController(root, part.component, part.gltf);
          manager.setExpressionController(part.role, controller);
          return { role: part.role, controller };
        });
        const face = controllers.find((item) => item.role === "head" || item.role === "integrated")?.controller;
        this.root = root;
        this.parts = parts;
        this.config = config;
        this.faceDefinition = faceDefinition;
        this.face = face;
        this.faceMorphKeys = new Set(face
          ? [...face.poseBindings.values()].flatMap((bindings) => [...bindings.keys()])
          : []);
        this.expressionControllers = controllers;
        this.behaviors = manager;
        this.physics = physics;
        this.motionGroup = integrated || entries[0].motionGroup === entries[1].motionGroup
          ? body.component.motionGroup ?? entries[entries.length - 1].motionGroup
          : undefined;
        this.idlePose = config.idlePose ? new IdlePose(root, config.humanoidScale, config.idlePose) : null;
        this.scene.add(root);
        this.initializeFace();
        committed = true;
        let meshes = 0, bones = 0;
        root.traverse((node) => { if (node.isMesh) meshes++; if (node.isBone) bones++; });
        return { root, config, faceDefinition, meshes, bones,
          behaviorDiagnostics: manager.diagnostics.length, composition };
      } finally {
        if (!committed) {
          if (this.root === root) {
            this.scene.remove(root);
            this.root = null;
            this.config = null;
            this.motionGroup = null;
            this.faceDefinition = null;
            this.face = null;
            this.faceMorphKeys = new Set();
            this.expressionControllers = [];
            this.idlePose = null;
            this.behaviors = null;
            this.physics = null;
          }
          physics?.destroy();
          manager?.destroy();
          shaderScope?.dispose();
          if (this.shaderScope === shaderScope) this.shaderScope = null;
        }
      }
    });
    this.commitQueue = result.catch(() => undefined);
    try {
      return await result;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }

  initializeFace() {
    if (!this.face) return;
    const definition = this.faceDefinition;
    const preset = definition.expressions.find((item) => item.name === definition.defaultExpression);
    if (preset) this.setExpression(preset.name);
    if (!this.rememberedFace) return;
    const groups = this.face.getCapabilities().groups;
    for (const group of groups) {
      const previous = this.rememberedFace.selections[group.name];
      if (group.states.includes(previous)) this.face.setGroup(group.name, previous, 0);
    }
    this.face.setBlink(this.rememberedFace.blink);
    this.face.setSpeech(this.rememberedFace.speech);
    const previous = definition.expressions.find((item) => item.name === this.rememberedFace.expression);
    const selections = this.face.getCapabilities().selections;
    this.expressionName = previous && Object.entries(previous.selections).every(
      ([group, state]) => selections[group] === state,
    ) ? previous.name : "";
  }

  async selectMotion(entry, url) {
    const generation = ++this.motionGeneration;
    if (!entry) {
      this.pendingMotion = { generation };
      return;
    }
    const root = this.root;
    if (!root) return;
    // Keep the old pose until the payload arrives, including uncached motions.
    this.pendingMotion = null;
    let payload;
    try {
      payload = await fetchMotionPayload(url, this.fetchResource);
    } catch (error) {
      if (generation !== this.motionGeneration || root !== this.root) return;
      throw error;
    }
    if (generation !== this.motionGeneration || root !== this.root) return;
    validateMotionPayload(payload, url);
    this.pendingMotion = { generation, root, payload, entry };
  }

  applyPendingMotion() {
    const change = this.pendingMotion;
    if (!change) return null;
    this.pendingMotion = null;
    if (change.generation !== this.motionGeneration || (change.root && change.root !== this.root)) return null;
    this.behaviors?.setMotion(null);
    this.motion?.dispose();
    this.motion = null;
    this.parameterBody?.restore(); this.parameterBody = null;
    this.parameterPlayer?.setMotion(null);
    this.idlePose?.restore();
    // Initialized cloth already owns its solver; align to the new pose and
    // recover contacts while retaining the bone settling budget.
    this.physics?.reset(30, this.physics.needsReset ? 30 : 2);
    if (change.parameterText !== undefined) {
      this.parameterPlayer.setMotion(change.parameterText, change.entry.component);
      this.parameterBody = new ParameterBodyPose(this.root, this.config.humanoidScale);
      this.motionInfo = { name: change.entry.name, parameterMotion: true };
      return { playing: true, ...this.motionInfo, canStop: true };
    }
    if (!change.payload) {
      this.motionInfo = null;
      return { playing: false };
    }
    this.motion = new MotionPlayer(this.root, this.config.humanoidScale, change.payload,
      this.motionGroup, change.entry.motionGroup);
    this.behaviors.setMotion(this.motion, change.entry.component);
    this.motionInfo = { name: change.entry.name,
      groupTracks: this.motion.groupTrackDeclaredCount,
      resolvedGroupTracks: this.motion.groupTrackResolvedCount };
    return { playing: true, ...this.motionInfo, canStop: this.canStopMotion };
  }

  stopMotion() {
    if (this.parameterBody) { this.pendingMotion = { generation: ++this.motionGeneration }; return true; }
    return this.motion?.command("stop") ?? false;
  }

  evaluatePose(step) {
    this.elapsedTime += step;
    this.externalExpressionDriver?.beginFrame();
    for (const { controller } of this.expressionControllers) controller.beginFrame();
    this.behaviors?.beforeMotion(step, this.elapsedTime);
    const motionChange = this.applyPendingMotion();
    this.parameterPlayer?.update(step);
    this.motion?.update(step);
    this.syncFaceActivity();
    if (this.parameterBody) this.parameterBody.applyParameters(this.parameterPlayer.parameters);
    else if (!this.motion) this.idlePose?.apply();
    for (const { controller } of this.expressionControllers) controller.update(step);
    this.behaviors?.afterMotion();
    this.externalExpressionDriver?.update(step);
    return motionChange;
  }

  update(delta) {
    let motionChange = null;
    const animate = step => { motionChange = this.evaluatePose(step) ?? motionChange; };
    if (this.physics) this.physics.advance(delta, animate, () => this.behaviors?.afterPhysics());
    else {
      animate(delta);
      this.behaviors?.afterPhysics();
    }
    return motionChange;
  }

  prepareFrame() {
    // Evaluate exactly one zero-time tick without consuming the fixed-step
    // accumulator. update(0) retains the solver's normal initial settling.
    this.physics?.beforeAnimation();
    const change = this.evaluatePose(0);
    this.physics?.update(0);
    this.behaviors?.afterPhysics();
    this.physics?.syncPose();
    return change;
  }

  render() {
    this.shaderScope?.tick(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() { this.clear({ rememberFace: false }); }
}

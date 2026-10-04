import * as THREE from 'three';
import { CharacterRenderer } from './character-renderer.js';
import { HostResourceCatalog } from './host-resource-catalog.js';
import { expandParameterManifest, ExpressionAdapterRegistry } from './garupa/manifest.js';
import { HostBlink } from './host-blink.js';
import { frameCharacterCamera } from './camera-framing.js';
import { CharacterWarmPool } from './character-warm-pool.js';
import { prepareSceneTextures, yieldPreparationTask } from './texture-preparation.js';

const catalogs = new Map();
const warmed = new CharacterWarmPool({
  create: options => OffscreenCharacter.create(options),
  key: options => OffscreenCharacter.warmKey(options),
});
async function catalogFor(url) {
  if (!catalogs.has(url)) {
    const pending = new HostResourceCatalog(url).load().catch(error => {
      if (catalogs.get(url) === pending) catalogs.delete(url);
      throw error;
    });
    catalogs.set(url, pending);
    while (catalogs.size > 4) catalogs.delete(catalogs.keys().next().value);
  }
  const pending = catalogs.get(url);
  catalogs.delete(url); catalogs.set(url, pending);
  return pending;
}

// No DOM mounting, ticker, Pixi objects or script syntax is owned here.
// A host calls update before uploading canvas and disposes at final removal.
export class OffscreenCharacter {
  static async preloadNamed(indexUrl, requests) {
    const catalog = await catalogFor(indexUrl);
    await Promise.all(requests.map(async ({ kind, name }) => {
      const entry = kind === 'motion'
        ? catalog.find('motion', name) ?? catalog.find('garupa-motion', name)
        : catalog.find('garupa-expression', name);
      // A model's own preset expression has no external resource to preload.
      if (entry) await catalog.preload(entry.type, entry.name);
    }));
  }

  static warmKey({ modelUrl, indexUrl, width = 768, height = 1024, framing, motion = '', expression = '', meshClothEnabled = true }) {
    if (typeof meshClothEnabled !== 'boolean') throw new Error('meshClothEnabled must be boolean');
    return JSON.stringify([new URL(modelUrl, globalThis.location?.href).href,
      new URL(indexUrl, globalThis.location?.href).href, width, height, framing, motion, expression, meshClothEnabled]);
  }

  static preload(options) { return warmed.preload(options); }

  static setPreloadRequests(options) { return warmed.setRequests(options); }

  static takePreloaded(options) { return warmed.take(options); }

  static async create(options) {
    const character = new OffscreenCharacter(options);
    try { await character.load(options); return character; }
    catch (error) { character.dispose(); throw error; }
  }

  constructor({ width = 768, height = 1024 } = {}) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, stencil: true });
    this.renderer.debug.checkShaderErrors = import.meta.env?.DEV === true;
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 100);
    this.scene.add(new THREE.AmbientLight(new THREE.Color(0.02, 0.025, 0.03), 1));
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(3, 5, 4);
    this.scene.add(light);
    this.character = new CharacterRenderer({ renderer: this.renderer, scene: this.scene, camera: this.camera,
      fetchResource: url => this.catalog.response(url) });
    this.blink = new HostBlink();
    this.mouth = null;
    this.disposed = false;
    this.expressionGeneration = 0;
    this.motionGeneration = 0;
  }

  async load({ modelUrl, indexUrl, runtime, framing, motion = '', expression = '', meshClothEnabled = true }) {
    if (typeof meshClothEnabled !== 'boolean') throw new Error('meshClothEnabled must be boolean');
    this.character.meshClothEnabled = meshClothEnabled;
    this.catalog = await catalogFor(indexUrl);
    const dependencyConfigs = new Set(this.catalog.entries.filter(item => ['shader', 'behavior'].includes(item.type)).map(item => item.config));
    for (const config of dependencyConfigs) {
      this.character.resourcePackages.register(await this.catalog.fetch(config), config);
    }
    const entry = await this.catalog.model(modelUrl);
    this.modelUrl = entry.config;
    await this.catalog.preloadModelDependencies(entry);
    await this.character.load([entry], '');
    const parameterEntries = [];
    const configs = new Set(this.catalog.entries.filter(item => item.type.startsWith('garupa-')).map(item => item.config));
    for (const config of configs) {
      parameterEntries.push(...expandParameterManifest(await this.catalog.fetch(config), config));
    }
    this.character.configureParameterPlayback({ runtime,
      adapters: new ExpressionAdapterRegistry(parameterEntries, '') });
    // Stable framing: never recalculate bounds as the actor moves.
    frameCharacterCamera(this.camera, this.character.root, framing, this.character.config.group);
    await this.setMotion(motion);
    await this.setExpression(expression);
    await this.prepare();
  }

  // The host freezes this actor's ticker while preparing or attaching it.
  // Actual drawing realizes render targets, texture uploads and runtime passes.
  async prepare() {
    if (this.disposed) return;
    if (this.renderer.getContext?.().isContextLost()) throw new Error('Character WebGL context is lost');
    this.applyHostInputs();
    // Initial adapter construction, pose settling and compile submission are
    // separate work units so they do not block foreground playback together.
    if (!this.prepared) await yieldPreparationTask();
    if (this.disposed) return;
    this.character.prepareFrame();
    if (this.disposed) return;
    if (!this.prepared) await yieldPreparationTask();
    if (this.disposed) return;
    await this.renderer.compileAsync(this.scene, this.camera);
    if (this.disposed) return;
    await prepareSceneTextures(this.renderer, this.scene, { cancelled: () => this.disposed });
    if (this.disposed) return;
    if (this.renderer.getContext?.().isContextLost()) throw new Error('Character WebGL context is lost');
    this.character.render();
    if (this.renderer.getContext?.().isContextLost()) throw new Error('Character WebGL context is lost');
    this.prepared = true;
  }

  async setMotion(name) {
    const generation = ++this.motionGeneration;
    if (this.disposed) return;
    const useDefault = !name;
    if (!name) name = this.character.config?.defaultMotion ?? '';
    if (!name) { await this.character.selectMotion(null); return; }
    const indexed = this.catalog.find('motion', name) ?? this.catalog.find('garupa-motion', name);
    if (!indexed && useDefault) { await this.character.selectMotion(null); return; }
    const entry = await this.catalog.resolve(indexed);
    if (this.disposed || generation !== this.motionGeneration) return;
    const url = new URL(entry.component.src, entry.config).href;
    if (entry.type === 'motion') await this.character.selectMotion(entry, url);
    else await this.character.selectParameterMotion(entry, url);
  }

  async setExpression(name) {
    const generation = ++this.expressionGeneration;
    if (this.disposed) return;
    if (!name) name = this.character.faceDefinition?.defaultExpression ?? '';
    if (!name) {
      if (this.character.parameterPlayer) await this.character.selectParameterExpression(null);
      await this.character.setParameterFace(false); return;
    }
    if (this.character.faceDefinition?.expressions.some(entry => entry.name === name)) {
      if (this.character.parameterPlayer) await this.character.selectParameterExpression(null);
      await this.character.setParameterFace(false);
      if (this.disposed || generation !== this.expressionGeneration) return;
      this.character.setExpression(name);
      return;
    }
    const entry = await this.catalog.resolve(this.catalog.find('garupa-expression', name));
    if (this.disposed || generation !== this.expressionGeneration) return;
    await this.character.selectParameterExpression(entry, new URL(entry.component.src, entry.config).href);
    if (this.disposed || generation !== this.expressionGeneration) return;
    await this.character.setParameterFace(true);
  }

  setBlinkParameters(config) {
    this.blink.setParameters(config);
  }

  setMouth(value) { this.mouth = value === null ? null : Math.max(0, Math.min(1, value)); }

  applyHostInputs() {
    const closed = 1 - this.blink.eyeParamValue;
    this.character.setBlink(closed);
    this.character.setSpeech(this.mouth ?? 0);
    if (this.character.parameterPlayer) {
      this.character.setParameterBlink(closed);
      this.character.setParameterSpeech(this.mouth);
    }
  }

  update(delta) {
    if (this.disposed) return;
    if (!Number.isFinite(delta)) throw new Error('Character delta must be finite');
    const elapsed = Math.max(0, delta);
    this.blink.update(Math.min(elapsed, 0.1) * 1000);
    this.applyHostInputs();
    this.character.update(elapsed);
    this.character.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.character.dispose(); }
    finally {
      try { this.renderer.dispose(); }
      finally { this.renderer.forceContextLoss(); }
    }
  }
}

import * as THREE from 'three';
import { CharacterRenderSurface } from './character-render-surface.js';
export { CharacterRenderSurface } from './character-render-surface.js';
import { CharacterRenderer } from './character-renderer.js';
import { HostResourceCatalog } from './host-resource-catalog.js';
import { expandParameterManifest, ExpressionAdapterRegistry } from './garupa/manifest.js';
import { HostBlink } from './host-blink.js';
import { frameCharacterCamera } from './camera-framing.js';
import { CharacterWarmPool } from './character-warm-pool.js';
import { prepareSceneTextures, yieldPreparationTask } from './texture-preparation.js';
import { isNativeExpression, parseNativeExpression } from './native-expression.js';

const catalogs = new Map();
const surfaceIdentities = new WeakMap();
let nextSurfaceIdentity = 0;
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
  static async preloadNamed(indexUrl, requests, resourceCatalog) {
    const catalog = resourceCatalog ?? await catalogFor(indexUrl);
    await Promise.all(requests.map(async ({ kind, name }) => {
      if (kind === 'expression' && isNativeExpression(name)) {
        parseNativeExpression(name);
        return;
      }
      const resolver = kind === 'motion' ? catalog.resolveMotion : catalog.resolveExpression;
      if (resolver) {
        const entry = await resolver.call(catalog, name, { optional: true });
        if (entry) await catalog.fetch(new URL(entry.component.src, entry.config).href, 'bytes');
        return;
      }
      const entry = kind === 'motion'
        ? catalog.find('motion', name) ?? catalog.find('garupa-motion', name)
        : catalog.find('garupa-expression', name);
      if (entry) await catalog.preload(entry.type, entry.name);
    }));
  }

  static warmKey({ modelUrl, indexUrl, width = 768, height = 1024, framing, motion = '', expression = '', meshClothEnabled = true, surface }) {
    if (typeof meshClothEnabled !== 'boolean') throw new Error('meshClothEnabled must be boolean');
    if (surface && !surfaceIdentities.has(surface)) surfaceIdentities.set(surface, ++nextSurfaceIdentity);
    return JSON.stringify([new URL(modelUrl, globalThis.location?.href).href,
      new URL(indexUrl, globalThis.location?.href).href, width, height, framing, motion, expression, meshClothEnabled, surface ? surfaceIdentities.get(surface) : null]);
  }

  static preload(options) { return warmed.preload(options); }

  static setPreloadRequests(options) { return warmed.setRequests(options); }

  static takePreloaded(options) { return warmed.take(options); }

  static async create(options) {
    const character = new OffscreenCharacter(options);
    try { await character.load(options); if (character.disposed) throw new Error("Character loading was cancelled"); return character; }
    catch (error) { character.dispose(); throw error; }
  }

  constructor({ width = 768, height = 1024, surface } = {}) {
    this.ownsSurface = !surface;
    this.surface = surface ?? new CharacterRenderSurface({ width, height });
    this.surface.attach(this);
    this.renderer = this.surface.renderer;
    this.canvas = this.surface.canvas;
    width = this.surface.width; height = this.surface.height;
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

  async load({ modelUrl, indexUrl, resourceCatalog, runtime, framing, motion = '', expression = '', meshClothEnabled = true }) {
    if (typeof meshClothEnabled !== 'boolean') throw new Error('meshClothEnabled must be boolean');
    this.character.meshClothEnabled = meshClothEnabled;
    this.catalog = resourceCatalog ?? await catalogFor(indexUrl);
    if (this.disposed) return;
    const dependencyConfigs = new Set(this.catalog.entries.filter(item => ['shader', 'behavior'].includes(item.type)).map(item => item.config));
    for (const config of dependencyConfigs) {
      const packageConfig = await this.catalog.fetch(config);
      if (this.disposed) return;
      this.character.resourcePackages.register(packageConfig, config);
    }
    const entry = await this.catalog.model(modelUrl);
    if (this.disposed) return;
    this.modelUrl = entry.config;
    await this.catalog.preloadModelDependencies(entry);
    if (this.disposed) return;
    await this.character.load([entry], '');
    if (this.disposed) return;
    const parameterEntries = [];
    const configs = new Set(this.catalog.entries.filter(item => item.type.startsWith('garupa-')).map(item => item.config));
    for (const config of configs) {
      const manifest = await this.catalog.fetch(config);
      if (this.disposed) return;
      parameterEntries.push(...expandParameterManifest(manifest, config));
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
    if (this.surface) return this.surface.prepare(this, () => this.prepareFrameResources());
    return this.prepareFrameResources();
  }

  async prepareFrameResources() {
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
    let entry;
    if (this.catalog.resolveMotion) {
      entry = await this.catalog.resolveMotion(name, { optional: useDefault });
    } else {
      const indexed = this.catalog.find('motion', name) ?? this.catalog.find('garupa-motion', name);
      if (indexed) entry = await this.catalog.resolve(indexed);
      else if (!useDefault) entry = await this.catalog.resolve(indexed);
    }
    if (this.disposed || generation !== this.motionGeneration) return;
    if (!entry) { await this.character.selectMotion(null); return; }
    const url = new URL(entry.component.src, entry.config).href;
    if (entry.type === 'motion') await this.character.selectMotion(entry, url);
    else await this.character.selectParameterMotion(entry, url);
  }

  async setExpression(name) {
    const generation = ++this.expressionGeneration;
    if (this.disposed) return;
    if (!name || isNativeExpression(name)) {
      const selection = name ? parseNativeExpression(name) : this.character.faceDefinition?.defaultExpression;
      if (this.character.parameterPlayer) await this.character.selectParameterExpression(null);
      await this.character.setParameterFace(false);
      if (this.disposed || generation !== this.expressionGeneration) return;
      this.character.setExpression(selection);
      return;
    }
    const entry = this.catalog.resolveExpression
      ? await this.catalog.resolveExpression(name)
      : await this.catalog.resolve(this.catalog.find('garupa-expression', name));
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
    this.surface?.assertDrawable(this);
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
      try { this.character.resourcePackages?.shaders?.dispose(); }
      finally {
        if (this.surface) {
          this.surface.detach(this);
          if (this.ownsSurface) this.surface.dispose();
        } else {
          try { this.renderer.dispose(); }
          finally { this.renderer.forceContextLoss(); }
        }
      }
    }
  }
}

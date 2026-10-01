import * as THREE from 'three';
import { CharacterRenderer } from './character-renderer.js';
import { HostResourceCatalog } from './host-resource-catalog.js';
import { expandParameterManifest, ExpressionAdapterRegistry } from './garupa/manifest.js';
import { HostBlink } from './host-blink.js';
import { frameCharacterCamera } from './camera-framing.js';

const catalogs = new Map();
const warmed = new Map();
async function catalogFor(url) {
  if (!catalogs.has(url)) {
    const pending = new HostResourceCatalog(url).load().catch(error => { catalogs.delete(url); throw error; });
    catalogs.set(url, pending);
  }
  return catalogs.get(url);
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

  static warmKey({ modelUrl, indexUrl, width = 768, height = 1024, framing }) {
    return JSON.stringify([new URL(modelUrl, globalThis.location?.href).href, indexUrl, width, height, framing]);
  }

  static async preload(options) {
    const key = this.warmKey(options);
    if (!warmed.has(key)) {
      const pending = this.create(options).catch(error => { warmed.delete(key); throw error; });
      const slot = { pending, timer: null };
      warmed.set(key, slot);
      slot.timer = setTimeout(() => {
        if (warmed.get(key) === slot) { warmed.delete(key); pending.then(actor => actor.dispose(), () => {}); }
      }, 60000);
      // Bound only speculative GPU residency, never the number of stage actors.
      if (warmed.size > 4) {
        const oldestKey = warmed.keys().next().value;
        const oldest = warmed.get(oldestKey);
        clearTimeout(oldest.timer); warmed.delete(oldestKey);
        oldest.pending.then(actor => actor.dispose(), () => {});
      }
    }
    await warmed.get(key)?.pending;
  }

  static async takePreloaded(options) {
    const key = this.warmKey(options);
    const slot = warmed.get(key);
    if (!slot) return null;
    warmed.delete(key); clearTimeout(slot.timer);
    return slot.pending;
  }

  static async create(options) {
    const character = new OffscreenCharacter(options);
    try { await character.load(options); return character; }
    catch (error) { character.dispose(); throw error; }
  }

  constructor({ width = 768, height = 1024 } = {}) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, stencil: true });
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

  async load({ modelUrl, indexUrl, runtime, framing }) {
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
    frameCharacterCamera(this.camera, this.character.root, framing);
    await this.setMotion('');
    this.character.update(0);
    await this.renderer.compileAsync(this.scene, this.camera);
    this.character.render();
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

  update(delta) {
    if (this.disposed) return;
    const elapsed = Math.max(0, Math.min(delta, 0.1));
    const closed = this.blink.update(elapsed * 1000);
    this.character.setBlink(closed);
    this.character.setSpeech(this.mouth ?? 0);
    if (this.character.parameterPlayer) {
      this.character.setParameterBlink(closed);
      this.character.setParameterSpeech(this.mouth);
    }
    this.character.update(elapsed);
    this.character.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.character.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

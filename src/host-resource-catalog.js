import { validateResourceManifest } from './resource-manifest.js';

const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_ENTRIES = 256;

// Host-owned discovery data, not a new resource package format. Entries point
// to authoritative package manifests; dependency hints only accelerate preload.
export class HostResourceCatalog {
  constructor(indexUrl, { fetchResource = fetch } = {}) {
    this.indexUrl = new URL(indexUrl, globalThis.location?.href).href;
    this.fetchResource = (...args) => fetchResource(...args);
    this.requests = new Map();
    this.cachedResources = new Map();
    this.cachedBytes = 0;
    this.entries = [];
  }

  async fetch(url, kind = 'json') {
    const key = `${kind}:${url}`;
    const cached = this.cachedResources.get(key);
    if (cached) {
      this.cachedResources.delete(key);
      this.cachedResources.set(key, cached);
      return cached.value;
    }
    if (!this.requests.has(key)) {
      const pending = this.fetchResource(url).then(response => {
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return kind === 'json' ? response.json() : response.arrayBuffer();
      }).then(value => {
        if (this.requests.get(key) === pending) this.requests.delete(key);
        // JSON uses a serialized UTF-16 estimate; the entry limit also bounds
        // small-object overhead. In-flight readers retain their own values.
        const size = kind === 'json' ? JSON.stringify(value).length * 2 : value.byteLength;
        if (size <= MAX_CACHED_BYTES) {
          while (this.cachedResources.size >= MAX_CACHED_ENTRIES || this.cachedBytes + size > MAX_CACHED_BYTES) {
            const oldest = this.cachedResources.keys().next().value;
            this.cachedBytes -= this.cachedResources.get(oldest).size;
            this.cachedResources.delete(oldest);
          }
          this.cachedResources.set(key, { value, size });
          this.cachedBytes += size;
        }
        return value;
      }, error => {
        if (this.requests.get(key) === pending) this.requests.delete(key);
        throw error;
      });
      this.requests.set(key, pending);
    }
    return this.requests.get(key);
  }

  async load() {
    const index = await this.fetch(this.indexUrl);
    if (!Array.isArray(index.resources)) throw new Error(`${this.indexUrl}: resources must be an array`);
    const identities = new Set();
    this.entries = index.resources.map(entry => {
      if (!entry.type || !entry.name || !entry.config) throw new Error(`${this.indexUrl}: incomplete resource entry`);
      const identity = `${entry.type}:${entry.name}`;
      if (identities.has(identity)) throw new Error(`${this.indexUrl}: duplicate ${identity}`);
      identities.add(identity);
      return { ...entry, config: new URL(entry.config, this.indexUrl).href };
    });
    return this;
  }

  find(type, name) { return this.entries.find(entry => entry.type === type && entry.name === name); }

  async response(url) {
    // Each reader gets its own consumable Response, sharing already fetched
    // bytes rather than issuing another request at the moment of switching.
    return new Response(await this.fetch(url, 'bytes'));
  }

  async resolve(entry) {
    if (!entry) throw new Error('Resource not found in game catalog');
    const manifest = validateResourceManifest(await this.fetch(entry.config), entry.config);
    const matches = manifest.components.filter(component => component.type === entry.type
      && (component.type === 'behavior' ? `${component.namespace}.${component.name}` : component.name) === entry.name);
    if (matches.length !== 1) throw new Error(`${entry.config}: expected one ${entry.type}:${entry.name}`);
    return { ...entry, component: matches[0], motionGroup: matches[0].motionGroup, basePath: new URL('.', entry.config).href };
  }

  async model(configUrl) {
    const url = new URL(configUrl, this.indexUrl).href;
    const manifest = validateResourceManifest(await this.fetch(url), url);
    const models = manifest.components.filter(component => component.type === 'model');
    if (models.length !== 1 || models[0].role !== 'integrated') {
      throw new Error(`${url}: integration requires one integrated model`);
    }
    return { type: 'model', name: models[0].name, config: url,
      component: models[0], basePath: new URL('.', url).href };
  }

  async preload(type, name) {
    const entry = await this.resolve(this.find(type, name));
    const source = entry.component.model ?? entry.component.src ?? entry.component.script;
    if (source) {
      const url = new URL(source, entry.config).href;
      await this.fetch(url, 'bytes');
    }
    return entry;
  }

  async preloadModelDependencies(model) {
    const bytes = await this.fetch(new URL(model.component.model, model.config).href, 'bytes');
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${model.name}: expected GLB`);
    const length = view.getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
    const names = new Set((gltf.materials ?? []).map(material => material.extras?.shader).filter(Boolean));
    const dependencies = [...names].map(name => ['shader', name]);
    const defaultMotion = this.find('motion', model.component.defaultMotion)
      ?? this.find('garupa-motion', model.component.defaultMotion);
    if (defaultMotion) dependencies.push([defaultMotion.type, defaultMotion.name]);
    for (const [type, name] of dependencies) await this.preload(type, name);
    for (const behavior of model.component.behaviors ?? []) {
      try {
        await this.preload('behavior', behavior.name);
      } catch (error) {
        if (behavior.required !== false) throw error;
        // BehaviorManager owns availability diagnostics and the required flag.
        // Speculative source loading must allow its optional-behavior path.
      }
    }
    for (const entry of this.entries.filter(entry => entry.type === 'garupa-expression-adapter')) {
      const resolved = await this.resolve(entry);
      if (resolved.component.motionGroup === model.component.motionGroup) await this.preload(entry.type, entry.name);
    }
  }
}

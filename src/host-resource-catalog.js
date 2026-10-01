import { validateResourceManifest } from './resource-manifest.js';

// Host-owned discovery data, not a new resource package format. Entries point
// to authoritative package manifests; dependency hints only accelerate preload.
export class HostResourceCatalog {
  constructor(indexUrl, { fetchResource = fetch } = {}) {
    this.indexUrl = new URL(indexUrl, globalThis.location?.href).href;
    this.fetchResource = (...args) => fetchResource(...args);
    this.requests = new Map();
    this.entries = [];
  }

  async fetch(url, kind = 'json') {
    const key = `${kind}:${url}`;
    if (!this.requests.has(key)) {
      const pending = this.fetchResource(url).then(response => {
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return kind === 'json' ? response.json() : response.arrayBuffer();
      }).catch(error => { this.requests.delete(key); throw error; });
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
    for (const behavior of model.component.behaviors ?? []) dependencies.push(['behavior', behavior.name]);
    const defaultMotion = this.find('motion', model.component.defaultMotion)
      ?? this.find('garupa-motion', model.component.defaultMotion);
    if (defaultMotion) dependencies.push([defaultMotion.type, defaultMotion.name]);
    for (const [type, name] of dependencies) await this.preload(type, name);
    for (const entry of this.entries.filter(entry => entry.type === 'garupa-expression-adapter')) {
      const resolved = await this.resolve(entry);
      if (resolved.component.motionGroup === model.component.motionGroup) await this.preload(entry.type, entry.name);
    }
  }
}

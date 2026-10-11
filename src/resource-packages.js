import { ShaderRegistry } from './parameterized-renderer.js';
import { BehaviorRegistry } from './model-behaviors.js';
import { RenderProfileRegistry } from './render-profiles.js';

export class ResourcePackages {
  constructor({ fetchResource = fetch, loadModule = url => import(/* @vite-ignore */ url) } = {}) {
    this.shaders = new ShaderRegistry();
    this.behaviors = new BehaviorRegistry();
    this.renderProfiles = new RenderProfileRegistry();
    this.fetchResource = (...args) => fetchResource(...args);
    this.loadModule = loadModule;
  }

  register(config, configUrl) {
    const source = new URL(configUrl, globalThis.location?.href).href;
    const loadModule = script => this.loadModule(new URL(script, source).href);
    this.shaders.registerPackage(config, { source,
      loadText: async url => {
        const response = await this.fetchResource(url);
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        return response.text();
      }, loadModule });
    this.behaviors.registerPackage(config, { source, loadModule });
    this.renderProfiles.registerPackage(config, { source, loadModule });
  }
}

import * as THREE from 'three';
import { componentsOfType } from './resource-manifest.js';

export class RenderProfileRegistry {
  constructor() { this.definitions = new Map(); this.modules = new Map(); }

  registerPackage(config, { source, loadModule }) {
    const entries = componentsOfType(config, 'render-profile', source);
    const names = new Set();
    for (const component of entries) {
      const label = `${source}: render-profile`;
      if (typeof component.name !== 'string' || !component.name.trim()) throw new Error(`${label} name must be non-empty`);
      if (typeof component.script !== 'string' || !component.script.trim()) throw new Error(`${label} script must be non-empty`);
      if (!Array.isArray(component.requiredShaders) || component.requiredShaders.some(name => typeof name !== 'string' || !name.trim())
          || new Set(component.requiredShaders).size !== component.requiredShaders.length) {
        throw new Error(`${label} requiredShaders must be unique Shader names`);
      }
      const existing = this.definitions.get(component.name);
      if (names.has(component.name) || (existing && (existing.source !== source || JSON.stringify(existing.component) !== JSON.stringify(component)))) {
        throw new Error(`Duplicate render-profile name: ${component.name}`);
      }
      names.add(component.name);
    }
    for (const component of entries) {
      if (!this.definitions.has(component.name)) this.definitions.set(component.name, { component, source, loadModule });
    }
  }

  async load(name, shaderRegistry) {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Render Profile not found: ${name}`);
    await Promise.all(definition.component.requiredShaders.map(shader => shaderRegistry.loadShader(shader)));
    if (!this.modules.has(name)) {
      const pending = Promise.resolve().then(() => definition.loadModule(new URL(definition.component.script, definition.source).href));
      this.modules.set(name, pending);
      pending.catch(() => { if (this.modules.get(name) === pending) this.modules.delete(name); });
    }
    const module = await this.modules.get(name);
    if (typeof module.createRenderProfile !== 'function') throw new Error(`Render Profile ${name}: createRenderProfile export is required`);
    return module.createRenderProfile;
  }
}

// Independent scopes may use the same renderer successively, but nested profile
// execution would make ownership of the current render target ambiguous.
const drawingProfiles = new WeakSet();

function stateBuffer() {
  return { viewport: new THREE.Vector4(), scissor: new THREE.Vector4(), clearColor: new THREE.Color(),
    actualViewport: new THREE.Vector4(), actualScissor: new THREE.Vector4(),
    frameViewport: new THREE.Vector4(), frameScissor: new THREE.Vector4() };
}

function capture(renderer, state) {
  state.target = renderer.getRenderTarget?.() ?? null;
  state.cubeFace = renderer.getActiveCubeFace?.() ?? 0;
  state.mipLevel = renderer.getActiveMipmapLevel?.() ?? 0;
  renderer.getViewport?.(state.viewport);
  renderer.getScissor?.(state.scissor);
  state.scissorTest = renderer.getScissorTest?.() ?? false;
  state.pixelRatio = renderer.getPixelRatio?.() ?? 1;
  if (renderer.getCurrentViewport) renderer.getCurrentViewport(state.actualViewport);
  else state.actualViewport.copy(state.viewport).multiplyScalar(state.pixelRatio).round();
  state.actualScissor.copy(state.target?.scissor ?? state.scissor);
  if (!state.target?.scissor) state.actualScissor.multiplyScalar(state.pixelRatio).round();
  state.actualScissorTest = state.target?.scissorTest ?? state.scissorTest;
  renderer.getClearColor?.(state.clearColor);
  state.clearAlpha = renderer.getClearAlpha?.();
  for (const key of ['autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil']) state[key] = renderer[key];
  return state;
}

function restore(renderer, state) {
  // Global logical rectangles and the active target's physical rectangles are
  // distinct Three state. Restore globals before rebinding the original target.
  renderer.setViewport?.(state.viewport);
  renderer.setScissor?.(state.scissor);
  renderer.setScissorTest?.(state.scissorTest);
  renderer.setRenderTarget?.(state.target, state.cubeFace, state.mipLevel);
  // A host may explicitly override the active target's viewport after binding.
  // Reapply the logical rectangle when that was its physical viewport, keeping
  // Three's getCurrentViewport cache consistent without changing target fields.
  state.frameViewport.copy(state.viewport).multiplyScalar(state.pixelRatio).round();
  if (state.frameViewport.equals(state.actualViewport)) renderer.setViewport?.(state.viewport);
  renderer.state?.viewport?.(state.actualViewport);
  renderer.state?.scissor?.(state.actualScissor);
  renderer.state?.setScissorTest?.(state.actualScissorTest);
  if (state.clearAlpha !== undefined) renderer.setClearColor?.(state.clearColor, state.clearAlpha);
  for (const key of ['autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil']) renderer[key] = state[key];
}

export function createRenderProfileScope(profile, renderer) {
  for (const method of ['attach', 'detach', 'prepare', 'render', 'destroy']) {
    if (typeof profile?.[method] !== 'function') throw new Error(`Render Profile requires ${method}()`);
  }
  const roots = new Set();
  const drawState = stateBuffer(), prepareState = stateBuffer();
  let disposed = false;
  let preparing = null;
  const pendingLifecycle = new Set();
  const track = pending => {
    pendingLifecycle.add(pending);
    pending.then(() => pendingLifecycle.delete(pending), () => pendingLifecycle.delete(pending));
    return pending;
  };
  const frame = (scene, camera, time, delta, state) => ({ scene, camera, time, delta,
    target: state.target, viewport: state.frameViewport.copy(state.actualViewport),
    scissor: state.frameScissor.copy(state.actualScissor), scissorTest: state.actualScissorTest });
  return {
    attach(root) {
      if (disposed) throw new Error('Render Profile scope has been disposed');
      if (roots.has(root)) return;
      // Register first so partial attach failures are also detached on cleanup.
      roots.add(root);
      const state = capture(renderer, stateBuffer());
      let result;
      try { result = profile.attach(root); }
      catch (error) { restore(renderer, state); throw error; }
      if (result?.then) return track(Promise.resolve(result).finally(() => restore(renderer, state)));
      restore(renderer, state);
    },
    async prepare(scene, camera, time, delta) {
      if (disposed) throw new Error('Render Profile scope has been disposed');
      if (preparing) return preparing;
      capture(renderer, prepareState);
      preparing = track(Promise.resolve().then(() => profile.prepare(frame(scene, camera, time, delta, prepareState)))
        .finally(() => { restore(renderer, prepareState); preparing = null; }));
      return preparing;
    },
    render(scene, camera, time, delta) {
      if (disposed) throw new Error('Render Profile scope has been disposed');
      if (pendingLifecycle.size) throw new Error('Render Profile preparation is still pending');
      if (drawingProfiles.has(renderer)) throw new Error('Only one Render Profile can execute per renderer draw');
      capture(renderer, drawState);
      drawingProfiles.add(renderer);
      try {
        const result = profile.render(frame(scene, camera, time, delta, drawState));
        if (result !== undefined) throw new Error('Render Profile render() must be synchronous and return no value');
      } finally {
        restore(renderer, drawState);
        drawingProfiles.delete(renderer);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const cleanup = () => {
        let failure;
        const state = capture(renderer, stateBuffer());
        try {
          for (const root of roots) {
            try {
              const result = profile.detach(root);
              if (result !== undefined) throw new Error('Render Profile detach() must be synchronous and return no value');
            } catch (error) { failure ??= error; }
          }
          roots.clear();
          try {
            const result = profile.destroy();
            if (result !== undefined) throw new Error('Render Profile destroy() must be synchronous and return no value');
          } catch (error) { failure ??= error; }
        } finally { restore(renderer, state); }
        if (failure) throw failure;
      };
      // Async attach/prepare may create resources after cancellation. Finish
      // their cleanup after settling; no resources are shared between scopes.
      if (pendingLifecycle.size) Promise.allSettled([...pendingLifecycle]).then(cleanup).catch(() => {});
      else cleanup();
    },
  };
}

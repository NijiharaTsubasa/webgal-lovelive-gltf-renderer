import * as THREE from 'three';

// Owns one reusable WebGL context. Actors retain independent scenes and state.
export class CharacterRenderSurface {
  constructor({ width = 768, height = 1024, renderer } = {}) {
    this.renderer = renderer ?? new THREE.WebGLRenderer({ alpha: true, antialias: true, stencil: true });
    this.renderer.debug.checkShaderErrors = import.meta.env?.DEV === true;
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.width = width; this.height = height;
    this.actors = new Set(); this.active = null; this.disposed = false;
    this.preparation = Promise.resolve(); this.preparing = false;
  }
  attach(actor) {
    if (this.disposed) throw new Error('Character surface is disposed');
    this.actors.add(actor);
  }
  detach(actor) {
    this.actors.delete(actor);
    if (this.active === actor) this.active = null;
  }
  activate(actor) {
    if (this.disposed || !this.actors.has(actor) || actor.disposed) throw new Error('Character is not resident on this surface');
    if (this.preparing) throw new Error('Character surface is preparing');
    if (!actor.prepared) throw new Error('Character is not prepared');
    this.active = actor;
  }
  deactivate(actor = this.active) { if (this.active === actor) this.active = null; }
  assertDrawable(actor) {
    if (this.disposed) throw new Error('Character surface is disposed');
    if (this.preparing || (this.active && this.active !== actor)) throw new Error('Character surface is in use by another actor');
  }
  prepare(actor, operation) {
    const result = this.preparation.then(async () => {
      if (this.disposed || actor.disposed) return;
      if (this.active && this.active !== actor) throw new Error('Cannot prepare over an active character surface');
      this.preparing = true;
      try { await operation(); } finally { this.preparing = false; }
    });
    this.preparation = result.catch(() => {});
    return result;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.active = null;
    let failure;
    for (const actor of [...this.actors]) {
      try { actor.dispose(); } catch (error) { failure ??= error; }
    }
    this.actors.clear();
    try { this.renderer.dispose(); } finally { this.renderer.forceContextLoss(); }
    if (failure) throw failure;
  }
}

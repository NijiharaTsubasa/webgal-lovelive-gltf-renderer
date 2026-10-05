// Track only resources created for one actor; shared package textures stay external.
export class CharacterResourceOwner {
  constructor() { this.resources = new Map(); this.released = new WeakSet(); this.disposed = false; }
  add(resource) {
    if (!resource?.dispose || this.resources.has(resource)) return resource;
    if (this.disposed) {
      if (!this.released.has(resource)) { this.released.add(resource); resource.dispose(); }
      return resource;
    }
    const record = { disposed: false, listener: null };
    record.listener = () => { record.disposed = true; };
    resource.addEventListener?.('dispose', record.listener);
    this.resources.set(resource, record);
    return resource;
  }
  capture(root) {
    root?.traverse(object => {
      this.add(object.geometry); this.add(object.skeleton);
      for (const material of [object.material].flat()) {
        if (!material) continue;
        this.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) this.add(value);
      }
    });
    return this;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    let failure;
    for (const [resource, record] of this.resources) {
      this.released.add(resource);
      try { if (!record.disposed) resource.dispose(); } catch (error) { failure ??= error; }
      resource.removeEventListener?.('dispose', record.listener);
    }
    this.resources.clear();
    if (failure) throw failure;
  }
}

import { LoaderUtils } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Share host-owned resource bytes; parsing creates independent scene state.
export class ResourceGLTFLoader extends GLTFLoader {
  constructor(fetchResource) {
    super();
    // Host fetch callbacks (including Window.fetch) must keep their call
    // receiver; invoking them as a loader method changes that receiver.
    this.fetchResource = (...args) => fetchResource(...args);
  }

  async loadAsync(url) {
    const response = await this.fetchResource(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return this.parseAsync(await response.arrayBuffer(), LoaderUtils.extractUrlBase(url));
  }
}

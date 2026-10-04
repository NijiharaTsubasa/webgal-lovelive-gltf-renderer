import { LoaderUtils } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Share host-owned resource bytes; parsing creates independent scene state.
export class ResourceGLTFLoader extends GLTFLoader {
  constructor(fetchResource) {
    super();
    this.fetchResource = fetchResource;
  }

  async loadAsync(url) {
    const response = await this.fetchResource(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return this.parseAsync(await response.arrayBuffer(), LoaderUtils.extractUrlBase(url));
  }
}

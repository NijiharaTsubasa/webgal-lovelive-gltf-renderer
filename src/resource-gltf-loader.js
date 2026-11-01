import { LoaderUtils } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CompressedTextureLoader } from './compressed-texture-loader.js';

// Share host-owned resource bytes; parsing creates independent scene state.
export class ResourceGLTFLoader extends GLTFLoader {
  constructor(fetchResource, { renderer } = {}) {
    super();
    if (renderer) {
      this.compressedTextures = new CompressedTextureLoader(renderer);
      this.setKTX2Loader(this.compressedTextures);
      this.register(parser => ({
        name: 'RequiredCompressedTextures',
        beforeRoot() {
          const load = parser.loadTextureImage.bind(parser);
          parser.loadTextureImage = async (index, source, textureLoader) => {
            const texture = await load(index, source, textureLoader);
            // Three permits missing ordinary image textures. A failed required
            // compressed texture must not silently become an untextured model.
            if (!texture && parser.json.textures[index].extensions?.KHR_texture_basisu) {
              throw new Error(`Unable to load KTX2 texture: ${parser.json.images[source].name ?? source}`);
            }
            return texture;
          };
        },
      }));
    }
    // Host fetch callbacks (including Window.fetch) must keep their call
    // receiver; invoking them as a loader method changes that receiver.
    this.fetchResource = (...args) => fetchResource(...args);
  }

  async loadAsync(url) {
    const response = await this.fetchResource(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return this.parseAsync(await response.arrayBuffer(), LoaderUtils.extractUrlBase(url));
  }

  dispose() { this.compressedTextures?.dispose(); }
}

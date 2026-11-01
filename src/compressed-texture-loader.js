import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { LoadingManager } from 'three';

const transcoderJS = new URL('./assets/basis/basis_transcoder.js', import.meta.url).href;
const transcoderWasm = new URL('./assets/basis/basis_transcoder.wasm', import.meta.url).href;

function createLoader() {
  const manager = new LoadingManager();
  manager.setURLModifier(url => url === './basis/basis_transcoder.js' ? transcoderJS
    : url === './basis/basis_transcoder.wasm' ? transcoderWasm : url);
  // An explicit prefix selects KTX2Loader's configurable asset route rather
  // than URLs relative to a dependency-prebundled module.
  return new KTX2Loader(manager).setWorkerLimit(2).setTranscoderPath('./basis/');
}

// Workers are shared only between contexts with identical transcode capabilities.
const pools = new Map();

function acquire(renderer) {
  const candidate = createLoader().detectSupport(renderer);
  const key = JSON.stringify(candidate.workerConfig);
  let pool = pools.get(key);
  if (!pool) {
    pool = { key, config: candidate.workerConfig, loader: candidate, refs: 0, pending: 0, ready: null };
    pools.set(key, pool);
  }
  pool.refs++;
  return pool;
}

function collect(pool) {
  if (pool.refs || pool.pending) return;
  pools.delete(pool.key);
  if (pool.ready) pool.loader.dispose();
}

function initialize(pool) {
  if (!pool.ready) {
    pool.ready = pool.loader.init().catch(error => {
      pool.loader.dispose();
      pool.loader = createLoader();
      pool.loader.workerConfig = pool.config;
      pool.ready = null;
      throw error;
    });
  }
  return pool.ready;
}

// GLTFLoader only needs load(). Acquire lazily so PNG models allocate no workers.
export class CompressedTextureLoader {
  constructor(renderer) {
    this.renderer = renderer;
    this.pool = null;
    this.disposed = false;
  }

  load(url, onLoad, onProgress, onError) {
    if (this.disposed) {
      onError?.(new Error('Compressed texture loader has been disposed'));
      return;
    }
    let pool;
    try { pool = this.pool ??= acquire(this.renderer); }
    catch (error) { onError?.(error); return; }
    pool.pending++;
    initialize(pool)
      .then(() => new Promise((resolve, reject) => pool.loader.load(url, resolve, onProgress, reject)))
      // KTX2Loader may reuse a transcode task across simultaneous requests.
      // Each character still owns its texture object and GPU disposal lifetime.
      .then(texture => onLoad(texture.clone()), onError)
      .finally(() => { pool.pending--; collect(pool); });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pool) { this.pool.refs--; collect(this.pool); }
  }
}

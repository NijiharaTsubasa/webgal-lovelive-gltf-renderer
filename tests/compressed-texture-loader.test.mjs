import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from './browser-host.js';
import { build, preview } from 'vite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// checker-uastc.ktx2 is an original 8x8 RGBA checkerboard encoded with toktx
// UASTC quality 4, Zstd 6, sRGB and generated mipmaps; it contains no game data.
test('KTX2 loads through GLTFLoader, shares workers and survives an owner closing during load', { timeout: 60_000 }, async t => {
  const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); t.after(() => vite.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { ResourceGLTFLoader } = await import('/renderer/resource-gltf-loader.js');
    const renderer = new THREE.WebGLRenderer();
    const a = new ResourceGLTFLoader(fetch, { renderer });
    const b = new ResourceGLTFLoader(fetch, { renderer });
    const document = JSON.stringify({ asset: { version: '2.0' },
      extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'],
      images: [{ uri: '/tests/fixtures/checker-uastc.ktx2' }],
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      scenes: [{ nodes: [] }], scene: 0 });
    const ga = await a.parseAsync(document, location.origin + '/');
    const gb = await b.parseAsync(document, location.origin + '/');
    const pa = ga.parser.getDependency('texture', 0);
    const pb = gb.parser.getDependency('texture', 0);
    // Parsing queues the texture loads asynchronously.
    await new Promise(resolve => setTimeout(resolve, 0));
    const shared = a.compressedTextures.pool === b.compressedTextures.pool;
    a.dispose();
    const [ta, tb] = await Promise.all([pa, pb]);
    renderer.initTexture(tb);
    const pool = b.compressedTextures.pool;
    const output = { shared, distinct: ta !== tb, refs: pool.refs, compressed: tb.isCompressedTexture,
      levels: tb.mipmaps.length, width: tb.image.width, error: renderer.getContext().getError() };
    ta.dispose(); tb.dispose(); b.dispose();
    output.refsAfter = pool.refs;
    renderer.dispose(); return output;
  });
  assert.equal(result.shared, true);
  assert.equal(result.distinct, true);
  assert.equal(result.refs, 1);
  assert.equal(result.refsAfter, 0);
  assert.equal(result.compressed, true);
  assert.equal(result.width, 8);
  assert.equal(result.levels, 4);
  assert.equal(result.error, 0);
});

test('production build publishes and loads the transcoder assets', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'renderer-uastc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = fileURLToPath(new URL('../src/resource-gltf-loader.js', import.meta.url)).replaceAll('\\', '/');
  const threePath = fileURLToPath(new URL('../node_modules/three/build/three.module.js', import.meta.url)).replaceAll('\\', '/');
  const image = (await readFile(new URL('./fixtures/checker-uastc.ktx2', import.meta.url))).toString('base64');
  await writeFile(join(root, 'index.html'), `<script type="module">
    import { ResourceGLTFLoader } from '${modulePath}';
    import { WebGLRenderer } from '${threePath}';
    const renderer = new WebGLRenderer();
    const loader = new ResourceGLTFLoader(fetch, { renderer });
    const document = { asset:{version:'2.0'}, extensionsUsed:['KHR_texture_basisu'],
      extensionsRequired:['KHR_texture_basisu'], scenes:[{nodes:[]}], scene:0,
      images:[{uri:'data:image/ktx2;base64,${image}'}],
      textures:[{extensions:{KHR_texture_basisu:{source:0}}}] };
    try {
      const gltf = await loader.parseAsync(JSON.stringify(document), location.href);
      const texture = await gltf.parser.getDependency('texture',0);
      renderer.initTexture(texture);
      window.result={width:texture.image.width, levels:texture.mipmaps.length, error:renderer.getContext().getError()};
      texture.dispose(); loader.dispose(); renderer.dispose();
    } catch(error) { window.result={failure:String(error)}; }
  </script>`);
  const config = { root, configFile: false, logLevel: 'silent', build: { assetsInlineLimit: 0 } };
  await build(config);
  const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
  t.after(() => new Promise(resolve => { server.httpServer.closeAllConnections(); server.httpServer.close(resolve); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const assets = [];
  page.on('response', response => { if (/basis_transcoder.*\.(js|wasm)$/.test(response.url())) assets.push({url:response.url(), status:response.status()}); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(() => window.result);
  assert.deepEqual(await page.evaluate(() => window.result), { width:8, levels:4, error:0 });
  assert.equal(assets.length, 2);
  assert.ok(assets.every(asset => asset.status === 200 && asset.url.includes('/assets/')));
});

test('a failed transcoder request rejects a required texture and the same loader can retry', { timeout: 60_000 }, async t => {
  const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); t.after(() => vite.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  let failed = false;
  await page.route('**/basis_transcoder.wasm', route => {
    if (!failed) { failed = true; return route.fulfill({ status:503, body:'Temporary failure' }); }
    return route.continue();
  });
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { WebGLRenderer } = await import('/node_modules/three/build/three.module.js');
    const { ResourceGLTFLoader } = await import('/renderer/resource-gltf-loader.js');
    const renderer = new WebGLRenderer(), loader = new ResourceGLTFLoader(fetch, {renderer});
    const document = JSON.stringify({asset:{version:'2.0'}, extensionsUsed:['KHR_texture_basisu'],
      extensionsRequired:['KHR_texture_basisu'], scenes:[{nodes:[]}], scene:0,
      images:[{uri:'/tests/fixtures/checker-uastc.ktx2', name:'checker'}],
      textures:[{extensions:{KHR_texture_basisu:{source:0}}}]});
    async function load() {
      const gltf = await loader.parseAsync(document, location.origin+'/');
      return gltf.parser.getDependency('texture',0);
    }
    let error;
    try { await load(); } catch(e) { error=String(e); }
    const texture = await load();
    const width=texture.image.width;
    texture.dispose(); loader.dispose(); renderer.dispose();
    return {error,width};
  });
  assert.match(result.error, /Unable to load KTX2 texture: checker/);
  assert.equal(result.width, 8);
});

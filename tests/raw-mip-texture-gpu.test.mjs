import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// This file deliberately launches a real browser/GPU. Exclude it from CPU-only
// regression runs; the browser watchdog owns only this test's browser.
test('raw and deflate mip uploads preserve rgba8 sRGB and rgba16f linear levels, rows and samples', { timeout: 45_000 }, async t => {
  const files = new Map([
    ['/three.module.js', new URL('../node_modules/three/build/three.module.js', import.meta.url)],
    ['/three.core.js', new URL('../node_modules/three/build/three.core.js', import.meta.url)],
    ['/src/raw-mip-texture.js', new URL('../src/raw-mip-texture.js', import.meta.url)],
    ['/src/sampler-bindings.js', new URL('../src/sampler-bindings.js', import.meta.url)],
    ['/test-source.mjs', new URL('./raw-mip-texture-gpu.test.mjs', import.meta.url)],
  ]);
  const sources = new Map();
  for (const [route, file] of files) sources.set(route, await readFile(file));
  const expectedSha = Object.fromEntries([...sources].map(([route, bytes]) => [route, sha256(bytes)]));
  const errors = []; let browser, expired = false;
  const watchdog = setTimeout(() => { expired = true; browser?.close().catch(() => {}); }, 40_000);
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15_000 });
    const page = await browser.newPage({ viewport: { width: 64, height: 32 } });
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => errors.push(String(error.stack ?? error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Localhost is a secure context for WebCrypto. All requests are fulfilled
    // from this checkout; no HTTP server, external resource or build is used.
    const base = 'http://127.0.0.1:38247';
    await page.route(`${base}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (sources.has(pathname)) return route.fulfill({ contentType: 'text/javascript', body: sources.get(pathname) });
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/three.module.js"}}</script>' });
      return route.fulfill({ status: 404, body: 'Unexpected test resource' });
    });
    await page.goto(base, { waitUntil: 'load', timeout: 10_000 });
    const result = await page.evaluate(async sourcePaths => {
      const THREE = await import('/three.module.js');
      const { createGltfTextureBinding } = await import('/src/sampler-bindings.js');
      const sourceSha = {};
      for (const path of sourcePaths) {
        const bytes = await (await fetch(path)).arrayBuffer();
        sourceSha[path] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      }
      const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      renderer.setSize(10, 1, false); renderer.setPixelRatio(1);
      renderer.toneMapping = THREE.NoToneMapping;
      const gl = renderer.getContext();
      if (!(gl instanceof WebGL2RenderingContext)) throw new Error('GPU probe requires WebGL2');
      let generatedMipmaps = 0;
      const generateMipmap = gl.generateMipmap;
      gl.generateMipmap = function(...args) { generatedMipmaps++; return generateMipmap.apply(this, args); };
      const target = new THREE.WebGLRenderTarget(10, 1, { type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false });
      target.texture.colorSpace = THREE.NoColorSpace; target.texture.generateMipmaps = false;
      const geometry = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene();
      const camera = new THREE.Camera();
      const material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        uniforms: { rawTexture: { value: null } },
        vertexShader: 'precision highp float; in vec3 position; void main(){ gl_Position=vec4(position.xy,0.0,1.0); }',
        fragmentShader: `precision highp float; precision highp int;
          uniform highp sampler2D rawTexture; out vec4 outputColor;
          void main() {
            int probe=int(gl_FragCoord.x); int method=probe/5; int item=probe%5;
            int lod=item==4 ? 1 : 0;
            ivec2 coord=item==4 ? ivec2(0) : ivec2(item%2,item/2);
            vec2 uv=(vec2(coord)+0.5)/vec2(textureSize(rawTexture,lod));
            outputColor=method==0 ? texelFetch(rawTexture,coord,lod) : textureLod(rawTexture,uv,float(lod));
          }`,
      });
      scene.add(new THREE.Mesh(geometry, material));
      const cases = [], liveTextures = [];
      const srgbToLinear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      // Source rows are top-to-bottom: texelFetch y=0 must read the first row,
      // matching the glTF PNG path's flipY=false convention. The explicit 1x1
      // level intentionally differs from every base texel and its average.
      const rgba8 = [[32, 96, 160, 255], [64, 128, 192, 128], [200, 80, 16, 64], [240, 208, 48, 192], [120, 180, 240, 224]];
      const half = [[.125, .25, .5, .75], [.2, .4, .6, .8], [.0625, .3125, .5625, .8125], [.9, .7, .3, .1], [.35, .55, .15, .95]];
      try {
        for (const format of ['rgba8', 'rgba16f']) for (const compressed of [false, true]) {
          const values = format === 'rgba8' ? rgba8 : half;
          const expected = values.map(pixel => pixel.map((v, channel) => format === 'rgba8'
            ? (channel < 3 ? srgbToLinear(v / 255) : v / 255)
            : THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(v))));
          const original = [values.slice(0, 4).flat(), values[4]].map(components => {
            if (format === 'rgba8') return new Uint8Array(components).buffer;
            const bytes = new ArrayBuffer(components.length * 2), view = new DataView(bytes);
            components.forEach((v, i) => view.setUint16(i * 2, THREE.DataUtils.toHalfFloat(v), true));
            return bytes;
          });
          const stored = [];
          for (const bytes of original) stored.push(compressed
            ? await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()
            : bytes);
          let offset = 0;
          const bufferViews = stored.map(bytes => { const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength }; offset += bytes.byteLength; return view; });
          const chain = { format, levels: [{ bufferView: 0, width: 2, height: 2 }, { bufferView: 1, width: 1, height: 1 }] };
          if (compressed) chain.compression = 'deflate';
          const definition = { sampler: 0, extras: { colorSpace: format === 'rgba8' ? 'srgb' : 'linear', rawMipChain: chain } };
          const dependencies = [];
          const parser = { json: { buffers: [{ byteLength: offset }], bufferViews,
            samplers: [{ minFilter: 9984, magFilter: 9728, wrapS: 33071, wrapT: 33071 }] },
            async getDependency(kind, index) { dependencies.push({ kind, index }); if (kind !== 'bufferView') throw new Error('Unexpected PNG fallback'); return stored[index]; } };
          const texture = await createGltfTextureBinding(null, definition, parser); liveTextures.push(texture);
          renderer.initTexture(texture);
          material.uniforms.rawTexture.value = texture;
          renderer.setRenderTarget(target); renderer.render(scene, camera);
          const pixels = new Uint8Array(40); renderer.readRenderTargetPixels(target, 0, 0, 10, 1, pixels);
          const glErrors = []; for (let i = 0; i < 32; i++) { const error = gl.getError(); if (!error) break; glErrors.push(error); }
          cases.push({ format, compression: compressed ? 'deflate' : null, expected,
            fetched: Array.from({ length: 5 }, (_, i) => [...pixels.slice(i * 4, i * 4 + 4)]),
            sampled: Array.from({ length: 5 }, (_, i) => [...pixels.slice((i + 5) * 4, (i + 6) * 4)]),
            levelSizes: texture.mipmaps.map(m => [m.width, m.height]), generateMipmaps: texture.generateMipmaps,
            flipY: texture.flipY, colorSpace: texture.colorSpace, glErrors, dependencies });
        }
        return { sourceSha, cases, generatedMipmaps, contextLost: gl.isContextLost() };
      } finally {
        for (const texture of liveTextures) texture.dispose();
        geometry.dispose(); material.dispose(); target.dispose();
        gl.generateMipmap = generateMipmap; renderer.dispose();
      }
    }, [...sources.keys()]);
    assert.equal(expired, false, 'Own-browser 40 second watchdog expired');
    assert.deepEqual(errors, [], 'Browser shader/runtime errors');
    assert.deepEqual(result.sourceSha, expectedSha, 'Browser must execute the source files read from this checkout');
    for (const [route, file] of files) assert.equal(sha256(await readFile(file)), expectedSha[route], `${route} changed during this test`);
    assert.equal(result.generatedMipmaps, 0, 'No mip level may be generated by GL');
    assert.equal(result.contextLost, false); assert.equal(result.cases.length, 4);
    for (const sample of result.cases) {
      const label = `${sample.format}/${sample.compression ?? 'raw'}`;
      assert.equal(sample.generateMipmaps, false, label); assert.equal(sample.flipY, false, label);
      assert.deepEqual(sample.levelSizes, [[2, 2], [1, 1]], label);
      assert.deepEqual(sample.glErrors, [], label);
      assert.deepEqual(sample.dependencies, [{ kind: 'bufferView', index: 0 }, { kind: 'bufferView', index: 1 }]);
      for (const method of ['fetched', 'sampled']) for (let pixel = 0; pixel < 5; pixel++) for (let channel = 0; channel < 4; channel++) {
        // RGBA8 readback quantizes the linear shader result; allow one byte
        // plus a small implementation rounding allowance, not bit identity.
        const expected = sample.expected[pixel][channel] * 255, actual = sample[method][pixel][channel];
        assert.ok(Math.abs(actual - expected) <= 1.5, `${label} ${method} pixel${pixel} channel${channel}: ${actual} vs ${expected}`);
      }
    }
    for (const format of ['rgba8', 'rgba16f']) {
      const [raw, deflate] = result.cases.filter(sample => sample.format === format);
      assert.deepEqual(raw.fetched, deflate.fetched, `${format} compression must preserve samples`);
      assert.deepEqual(raw.sampled, deflate.sampled, `${format} compression must preserve samples`);
    }
    t.diagnostic(JSON.stringify({ sourceSha: result.sourceSha, generatedMipmaps: result.generatedMipmaps,
      cases: result.cases.map(({ format, compression, fetched, sampled, glErrors }) => ({ format, compression, fetched, sampled, glErrors })) }));
  } finally { clearTimeout(watchdog); await browser?.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// The later, nearer surface must leave the earlier stencil writer visible.
test("stencil writer remains visible through a later nearer surface on screen and offscreen", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const modules = new Map([
      ["/three.module.js", new URL("../node_modules/three/build/three.module.js", import.meta.url)],
      ["/three.core.js", new URL("../node_modules/three/build/three.core.js", import.meta.url)],
      ["/state.js", new URL("../src/unity-render-state.js", import.meta.url)],
    ]);
    await page.route("http://stencil.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill(modules.has(path)
        ? { contentType: "text/javascript", body: await readFile(modules.get(path), "utf8") }
        : { contentType: "text/html", body: '<script type="importmap">{"imports":{"three":"/three.module.js"}}</script>' });
    });
    await page.goto("http://stencil.test/");
    const result = await page.evaluate(async () => {
      const THREE = await import("/three.module.js");
      const { applyRenderState } = await import("/state.js");
      const renderer = new THREE.WebGLRenderer({ stencil: true, antialias: false });
      renderer.setSize(32, 32);
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
      camera.position.z = 2;
      const writer = new THREE.Mesh(new THREE.PlaneGeometry(.5, .5), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
      const reader = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x0000ff }));
      applyRenderState(writer.material, { renderQueue: 2453, zTest: 4, zWrite: 1, stencil: { ref: 201, comp: 8, pass: 2 } });
      applyRenderState(reader.material, { renderQueue: 2454, zTest: 4, zWrite: 1, stencil: { ref: 201, comp: 6, pass: 0 } });
      writer.renderOrder = 2453; reader.renderOrder = 2454; reader.position.z = .5;
      scene.add(writer, reader);
      const gl = renderer.getContext();
      const sample = () => {
        renderer.render(scene, camera);
        const center = new Uint8Array(4), outside = new Uint8Array(4);
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center);
        gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, outside);
        return { center: [...center], outside: [...outside] };
      };
      const screen = sample();
      const target = new THREE.WebGLRenderTarget(32, 32, { stencilBuffer: true });
      renderer.setRenderTarget(target);
      const offscreen = sample();
      writer.material.stencilWrite = false;
      const control = sample();
      target.dispose(); renderer.dispose();
      return { screen, offscreen, control };
    });
    for (const target of [result.screen, result.offscreen]) {
      assert.deepEqual(target.center, [255, 0, 0, 255], "nearer surface covered stencil writer");
      assert.deepEqual(target.outside, [0, 0, 255, 255]);
    }
    assert.deepEqual(result.control.center, [0, 0, 255, 255], "control must reproduce the occlusion");
  } finally { await browser.close(); }
});

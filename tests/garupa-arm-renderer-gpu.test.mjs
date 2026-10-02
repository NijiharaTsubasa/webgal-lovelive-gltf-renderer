import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

function closeBrowserOnAbort(signal, browser) {
  const close = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  return () => signal.removeEventListener('abort', close);
}

async function fixturePage(browser) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const modules = new Map([
    ['/three.module.js', new URL('../node_modules/three/build/three.module.js', import.meta.url)],
    ['/three.core.js', new URL('../node_modules/three/build/three.core.js', import.meta.url)],
    ['/arm-renderer.js', new URL('../src/garupa/arm-renderer.js', import.meta.url)],
    ['/shader-passes.js', new URL('../src/shader-passes.js', import.meta.url)],
    ['/state.js', new URL('../src/unity-render-state.js', import.meta.url)],
  ]);
  await page.route('http://arm-renderer.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill(modules.has(path)
      ? { contentType: 'text/javascript', body: await readFile(modules.get(path), 'utf8') }
      : { contentType: 'text/html', body: '<script type="importmap">{"imports":{"three":"/three.module.js"}}</script>' });
  });
  await page.goto('http://arm-renderer.test/');
  return { page, errors };
}

test('skinned forearm layers fix chest occlusion while retaining stencil outline pixels and alpha', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const removeAbortListener = closeBrowserOnAbort(t.signal, browser);
  try {
    const { page, errors } = await fixturePage(browser);
    const result = await page.evaluate(async () => {
      const THREE = await import('/three.module.js');
      const { ParameterArmRenderer } = await import('/arm-renderer.js');
      const { createDefaultPassObject } = await import('/shader-passes.js');
      const { applyRenderState, installUnityColorMaskSupport } = await import('/state.js');
      const size = 128;
      const renderer = new THREE.WebGLRenderer({ alpha: true, stencil: true, antialias: false });
      renderer.setSize(size, size); renderer.setClearColor(0, 0);
      installUnityColorMaskSupport(renderer);
      const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 3;
      const bone = (name, parent, position) => {
        const node = new THREE.Bone(); node.name = name; node.position.fromArray(position); parent.add(node); return node;
      };
      const chest = bone('Chest', root, [0, 0, 0]);
      const upper = bone('LeftUpperArm', chest, [-.5, .5, 0]);
      const lower = bone('LeftLowerArm', upper, [.3, -.35, -.4]);
      const hand = bone('LeftHand', lower, [.25, -.45, 0]);

      // Two disconnected pieces of one skinned primitive: the body and an arm
      // crossing its centre. No elbow attachment boundary is modelled here.
      const positions = [], normals = [], colors = [], indices = [], weights = [], outlineDirections = [];
      function quad(halfWidth, halfHeight, z, color, joint) {
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (const index of [0, 1, 2, 0, 2, 3]) {
          const [x, y] = corners[index];
          positions.push(x * halfWidth, y * halfHeight, z); normals.push(0, 0, 1);
          colors.push(...color); indices.push(joint, 0, 0, 0); weights.push(1, 0, 0, 0);
          outlineDirections.push(x, y);
        }
      }
      quad(.55, .55, 0, [0, 0, 1], 0);
      quad(.15, .75, -.4, [1, 0, 0], 2);
      const geometry = new THREE.BufferGeometry();
      for (const [name, values, width] of [['position', positions, 3], ['normal', normals, 3], ['color', colors, 3],
        ['skinWeight', weights, 4], ['fixtureOutlineDirection', outlineDirections, 2]]) {
        geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, width));
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      const source = new THREE.MeshBasicMaterial({ vertexColors: true });
      applyRenderState(source, { renderQueue: 2453, zWrite: 1, zTest: 4,
        stencil: { ref: 201, comp: 8, pass: 2 } });
      const mesh = new THREE.SkinnedMesh(geometry, source); mesh.frustumCulled = false; mesh.renderOrder = 2453;
      root.add(mesh); root.updateMatrixWorld(true);
      mesh.bind(new THREE.Skeleton([chest, upper, lower, hand]));
      const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0, opacity: .5,
        transparent: true, blending: THREE.NoBlending, depthWrite: false });
      applyRenderState(outlineMaterial, { zTest: 4, stencil: { ref: 201, comp: 3, pass: 0 } });
      outlineMaterial.onBeforeCompile = shader => {
        shader.vertexShader = 'attribute vec2 fixtureOutlineDirection;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xy += fixtureOutlineDirection * 0.05;\ntransformed.z -= 0.01;');
      };
      const outline = createDefaultPassObject(mesh, outlineMaterial, 'Outline');
      outline.userData.__parameterizedPassObject = true; outline.renderOrder = 2454; outline.frustumCulled = false;
      const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
      backdrop.position.z = -.8; backdrop.visible = false; scene.add(backdrop);
      const foreground = new THREE.Mesh(new THREE.PlaneGeometry(.1, 1.5), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
      foreground.position.z = .8; foreground.visible = false; scene.add(foreground);
      const arms = new ParameterArmRenderer(root);
      const target = new THREE.WebGLRenderTarget(size, size, { stencilBuffer: true });
      const gl = renderer.getContext();
      const read = () => {
        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const at = (pixels, x, y) => {
        const offset = (Math.floor((y + 1) * size / 2) * size + Math.floor((x + 1) * size / 2)) * 4;
        return Array.from(pixels.slice(offset, offset + 4));
      };
      const samples = pixels => ({ chest: at(pixels, .35, 0), crossing: at(pixels, 0, 0),
        outline: at(pixels, .18, 0), armOutsideChest: at(pixels, 0, .67), background: at(pixels, .9, .9) });
      const state = () => ({ autoClear: renderer.autoClear, shadowAutoUpdate: renderer.shadowMap.autoUpdate,
        layer: arms.layer.value, meshLayers: mesh.layers.mask, outlineLayers: outline.layers.mask,
        sourceColorWrite: source.colorWrite, sourceStencil: source.stencilWrite,
        outlineColorWrite: outlineMaterial.colorWrite, outlineStencil: outlineMaterial.stencilWrite,
        sourceHasMask: Object.hasOwn(source.userData, '__unityColorWriteMask'),
        sameGeometry: mesh.geometry === geometry && outline.geometry === geometry,
        sameMaterials: mesh.material === source && outline.material === outlineMaterial,
        outside: [backdrop, foreground].map(object => ({ layers: object.layers.mask,
          visible: object.visible, colorWrite: object.material.colorWrite, depthWrite: object.material.depthWrite,
          stencilWriteMask: object.material.stencilWriteMask,
          hasMask: Object.hasOwn(object.material.userData, '__unityColorWriteMask') })),
        backgroundNull: scene.background === null });
      const frames = [];
      try {
        for (const [name, destination] of [['screen', null], ['offscreen', target]]) {
          renderer.setRenderTarget(destination);
          backdrop.visible = false; foreground.visible = false;
          lower.position.z = -.4; root.updateMatrixWorld(true);
          renderer.render(scene, camera); const rawBehind = samples(read());
          arms.setParameters({ PARAM_ARM_L_CHANGE: 0, PARAM_ARM_R_CHANGE: 0 });
          const before = state();
          arms.drawScene(renderer, scene, camera); const frontPixels = read(), front = samples(frontPixels);
          arms.drawScene(renderer, scene, camera); const repeated = read();
          let repeatDifferences = 0;
          for (let i = 0; i < repeated.length; i++) if (repeated[i] !== frontPixels[i]) repeatDifferences++;
          const after = state();
          // The ring lies outside the arm but inside the body. Its Equal test
          // therefore requires stencil retained from the earlier body layer.
          source.stencilWrite = false;
          arms.drawScene(renderer, scene, camera); const withoutWriter = samples(read());
          source.stencilWrite = true;
          // Bone motion puts the same forearm physically in front of the chest.
          // Back-layer assignment must still put its crossing behind the body.
          lower.position.z += .8; root.updateMatrixWorld(true);
          renderer.render(scene, camera); const rawAhead = samples(read());
          arms.setParameters({ PARAM_ARM_L_CHANGE: 1, PARAM_ARM_R_CHANGE: 1 });
          arms.drawScene(renderer, scene, camera); const back = samples(read());
          // These objects belong to the scene, outside the adapted character.
          // A rear arm still lies in front of farther opaque scenery, while
          // nearer scenery must occlude the body and either arm assignment.
          backdrop.visible = true;
          renderer.render(scene, camera); const rawBackdrop = samples(read());
          arms.drawScene(renderer, scene, camera); const backWithBackdrop = samples(read());
          foreground.visible = true;
          const outsideBefore = state();
          arms.drawScene(renderer, scene, camera); const backWithForeground = samples(read());
          arms.setParameters({ PARAM_ARM_L_CHANGE: 0, PARAM_ARM_R_CHANGE: 0 });
          arms.drawScene(renderer, scene, camera); const frontWithForeground = samples(read());
          const outsideAfter = state();
          frames.push({ name, rawBehind, front, withoutWriter, rawAhead, back, repeatDifferences,
            rawBackdrop, backWithBackdrop, backWithForeground, frontWithForeground,
            before, after, outsideBefore, outsideAfter, targetRestored: renderer.getRenderTarget() === destination });
        }
        return { frames, glError: gl.getError() };
      } finally {
        arms.dispose(); target.dispose(); geometry.dispose(); source.dispose(); outlineMaterial.dispose();
        for (const object of [backdrop, foreground]) { object.geometry.dispose(); object.material.dispose(); }
        renderer.dispose();
      }
    });
    assert.deepEqual(errors, [], 'GPU compilation and page execution must be clean');
    assert.equal(result.glError, 0);
    for (const frame of result.frames) {
      const label = frame.name;
      assert.deepEqual(frame.rawBehind.crossing, [0, 0, 255, 255], `${label}: control must reproduce chest occlusion`);
      assert.deepEqual(frame.front.crossing, [255, 0, 0, 255], `${label}: front forearm must remain visible through the chest`);
      assert.deepEqual(frame.front.chest, [0, 0, 255, 255]);
      assert.deepEqual(frame.front.outline.slice(0, 3), [0, 0, 0], `${label}: stencil outline must survive layering`);
      assert.ok(Math.abs(frame.front.outline[3] - 127.5) <= .5,
        `${label}: outline must retain 0.5 alpha to one RGBA8 quantization step`);
      assert.deepEqual(frame.withoutWriter.outline, [0, 0, 255, 255], `${label}: outline pixel must depend on the real stencil writer`);
      assert.deepEqual(frame.rawAhead.crossing, [255, 0, 0, 255], `${label}: skinning must move the arm physically in front`);
      assert.deepEqual(frame.back.crossing, [0, 0, 255, 255], `${label}: back forearm must be covered by the chest`);
      assert.deepEqual(frame.back.armOutsideChest, [255, 0, 0, 255], `${label}: back assignment must not hide the whole arm`);
      assert.deepEqual(frame.rawBackdrop.armOutsideChest, [255, 0, 0, 255], `${label}: arm is physically ahead of outside backdrop`);
      assert.deepEqual(frame.backWithBackdrop.armOutsideChest, [255, 0, 0, 255], `${label}: outside backdrop must not overpaint the rear arm`);
      for (const image of [frame.backWithForeground, frame.frontWithForeground]) {
        assert.deepEqual(image.crossing, [255, 0, 255, 255], `${label}: outside foreground must occlude the body and crossing arm`);
        assert.deepEqual(image.armOutsideChest, [255, 0, 255, 255], `${label}: outside foreground must occlude either arm assignment`);
      }
      for (const image of [frame.front, frame.back]) assert.deepEqual(image.background, [0, 0, 0, 0], `${label}: background alpha`);
      assert.equal(frame.repeatDifferences, 0, `${label}: repeated draws must produce the same pixels`);
      assert.deepEqual(frame.after, frame.before, `${label}: draw must restore transient state`);
      assert.deepEqual(frame.outsideAfter, frame.outsideBefore, `${label}: outside draw state must be restored`);
      assert.equal(frame.targetRestored, true);
    }
  } finally { removeAbortListener(); await browser.close(); }
});

test('rear elbow surface keeps its depth against adjacent upper-arm outline without exposing it through the chest', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const removeAbortListener = closeBrowserOnAbort(t.signal, browser);
  try {
    const { page, errors } = await fixturePage(browser);
    const result = await page.evaluate(async () => {
      const THREE = await import('/three.module.js');
      const { ParameterArmRenderer } = await import('/arm-renderer.js');
      const { createDefaultPassObject } = await import('/shader-passes.js');
      const { applyRenderState, installUnityColorMaskSupport } = await import('/state.js');
      const size = 128, renderer = new THREE.WebGLRenderer({ alpha: true, stencil: true, antialias: false });
      renderer.setSize(size, size); renderer.setClearColor(0, 0); installUnityColorMaskSupport(renderer);
      const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 3;
      const chest = new THREE.Bone(), upper = new THREE.Bone(), lower = new THREE.Bone();
      chest.name = 'Chest'; upper.name = 'LeftUpperArm'; lower.name = 'LeftLowerArm';
      root.add(chest); chest.add(upper); upper.add(lower);
      const positions = [], normals = [], colors = [], indices = [], weights = [], directions = [];
      function patch(x0, x1, y0, y1, z, color, joints, blend) {
        const corners = [[x0, y0, -1, -1], [x1, y0, 1, -1], [x1, y1, 1, 1], [x0, y1, -1, 1]];
        for (const index of [0, 1, 2, 0, 2, 3]) {
          const [x, y, dx, dy] = corners[index];
          positions.push(x, y, z); normals.push(0, 0, 1); colors.push(...color);
          indices.push(...joints); weights.push(...blend); directions.push(dx, dy);
        }
      }
      patch(.05, .65, -.4, 0, .4, [0, 0, 1], [0, 0, 0, 0], [1, 0, 0, 0]);
      patch(-.6, -.15, .1, .4, 0, [0, 1, 0], [1, 0, 0, 0], [1, 0, 0, 0]);
      // The elbow belongs to the rear forearm, but shares upper-arm skinning.
      // Its surface is nearer than the upper arm and its expanded outline.
      patch(-.2, .35, -.25, .15, .1, [1, 0, 0], [2, 1, 0, 0], [.75, .25, 0, 0]);
      const geometry = new THREE.BufferGeometry();
      for (const [name, values, width] of [['position', positions, 3], ['normal', normals, 3], ['color', colors, 3],
        ['skinWeight', weights, 4], ['fixtureOutlineDirection', directions, 2]]) {
        geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, width));
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      const source = new THREE.MeshBasicMaterial({ vertexColors: true });
      applyRenderState(source, { renderQueue: 2453, zWrite: 1, zTest: 4, stencil: { ref: 201, comp: 8, pass: 2 } });
      const mesh = new THREE.SkinnedMesh(geometry, source); mesh.renderOrder = 2453; mesh.frustumCulled = false;
      root.add(mesh); root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([chest, upper, lower]));
      const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0, depthWrite: false });
      applyRenderState(outlineMaterial, { renderQueue: 2454, zTest: 4, stencil: { ref: 201, comp: 3, pass: 0 } });
      outlineMaterial.onBeforeCompile = shader => {
        shader.vertexShader = 'attribute vec2 fixtureOutlineDirection;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xy += fixtureOutlineDirection * 0.05;\ntransformed.z -= 0.01;');
      };
      const outline = createDefaultPassObject(mesh, outlineMaterial, 'Outline');
      outline.userData.__parameterizedPassObject = true; outline.renderOrder = 2454; outline.frustumCulled = false;
      const target = new THREE.WebGLRenderTarget(size, size, { stencilBuffer: true }); renderer.setRenderTarget(target);
      let arms;
      const read = () => {
        const sample = (x, y) => {
          const pixel = new Uint8Array(4);
          renderer.readRenderTargetPixels(target, Math.floor((x + 1) * size / 2), Math.floor((y + 1) * size / 2), 1, 1, pixel);
          return Array.from(pixel);
        };
        // Away from triangle edges: inside lower surface, outside upper Main,
        // but inside its 0.05-wide outline expansion.
        return { elbow: sample(-.125, .075), chest: sample(.25, -.125), upper: sample(-.35, .25) };
      };
      try {
        renderer.render(scene, camera); const raw = read();
        arms = new ParameterArmRenderer(root);
        arms.setParameters({ PARAM_ARM_L_CHANGE: 1, PARAM_ARM_R_CHANGE: 1 });
        arms.drawScene(renderer, scene, camera); const layered = read();
        outline.visible = false;
        arms.drawScene(renderer, scene, camera); const withoutOutline = read();
        return { raw, layered, withoutOutline, glError: renderer.getContext().getError() };
      } finally {
        arms?.dispose(); target.dispose(); geometry.dispose(); source.dispose(); outlineMaterial.dispose(); renderer.dispose();
      }
    });
    assert.deepEqual(errors, []); assert.equal(result.glError, 0);
    assert.deepEqual(result.raw.elbow, [255, 0, 0, 255], 'ordinary depth must keep the nearer elbow surface visible');
    assert.deepEqual(result.withoutOutline.elbow, [255, 0, 0, 255], 'control isolates the upper outline as the covering draw');
    for (const frame of Object.values(result).filter(value => value?.chest)) {
      assert.deepEqual(frame.chest, [0, 0, 255, 255], 'the chest must still cover the rear forearm');
      assert.deepEqual(frame.upper, [0, 255, 0, 255], 'upper-arm Main must remain present');
    }
    assert.deepEqual(result.layered.elbow, [255, 0, 0, 255],
      'body-layer outline must not paint over the nearer rear elbow: ' + JSON.stringify(result));
  } finally { removeAbortListener(); await browser.close(); }
});

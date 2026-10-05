import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "./browser-host.js";

test("characters isolate shader ticks, renderer references and unload cleanup", { timeout: 30_000 }, async (t) => {
  const vite = await createServer({ logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  t.after(() => vite.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.route(`${base}/`, route => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const { CharacterRenderer } = await import("/renderer/character-renderer.js");
    const { getShaderRuntimes, createShaderRuntimeScope } = await import("/renderer/parameterized-renderer.js");
    const { ResourcePackages } = await import("/renderer/resource-packages.js");
    const { createDefaultPassObject } = await import("/renderer/shader-passes.js");
    const resourcePackages = new ResourcePackages();
    resourcePackages.shaders.registerPackage({ components: [{ type: "shader", name: "fixture-shader",
      src: "shader.glsl", script: "shader.js", samplers: [],
      passes: [{ id: "Forward", sections: {} }, { id: "Outline", sections: {} }],
    }] }, {
      source: new URL("/fixture/config.json", location.href).href,
      loadText: async () => "",
      loadModule: async () => ({ default: class {
        createPass(passId, material, mesh) {
          if (passId !== "Outline") return material;
          this.outline = createDefaultPassObject(mesh, material);
          return this.outline;
        }
        destroy() { this.outline?.removeFromParent(); this.outline?.material.dispose(); }
      } }),
    });
    const component = { type: "model", name: "Fixture", role: "integrated", model: "model.glb", humanoidScale: 1 };
    function fixture() {
      const root = new THREE.Group();
      const material = new THREE.MeshStandardMaterial();
      material.userData = { shader: "fixture-shader", textures: {}, shaderParams: {},
        passes: [{ id: "Forward" }, { id: "Outline" }] };
      root.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
      return { scene: root, parser: { json: { nodes: [], textures: [] }, associations: new Map() } };
    }
    function host() {
      const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas") });
      renderer.setSize(8, 8);
      // Tick verification does not require compiling the synthetic material.
      renderer.render = () => {};
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera();
      const character = new CharacterRenderer({ renderer, scene, camera, resourcePackages,
        loader: { loadAsync: async () => fixture() } });
      return { renderer, scene, camera, character };
    }
    const a = host(), b = host();
    await a.character.load([{ basePath: "fixture", component }], "/");
    await b.character.load([{ basePath: "fixture", component }], "/");
    const meshA = a.character.root.children[0], meshB = b.character.root.children[0];
    const runtimeA = getShaderRuntimes(meshA.material)[0];
    const runtimeB = getShaderRuntimes(meshB.material)[0];
    const events = [];
    const destroyed = [];
    for (const [name, runtime, target] of [["a", runtimeA, a], ["b", runtimeB, b]]) {
      runtime.onBeforeRender = (renderer, scene, camera) => events.push([
        name, renderer === target.renderer, scene === target.scene, camera === target.camera,
      ]);
      const destroy = runtime.destroy.bind(runtime);
      runtime.destroy = () => { destroyed.push(name); destroy(); };
    }
    const outlineA = a.character.root.children.find(node => node.userData.__parameterizedPassObject);
    const outlineB = b.character.root.children.find(node => node.userData.__parameterizedPassObject);
    let outlineBDisposed = 0;
    outlineB.material.addEventListener("dispose", () => outlineBDisposed++);
    a.character.render();
    b.character.render();
    a.character.dispose();
    a.character.dispose();
    b.character.render();
    const afterA = { destroyed: destroyed.slice(), outlineADetached: outlineA.parent === null,
      outlineBAttached: outlineB.parent === b.character.root, outlineBDisposed };
    // A partially bound failing load must release its own successful jobs.
    const failing = host();
    failing.character.loader.loadAsync = async () => {
      const gltf = fixture();
      const invalid = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
      invalid.material.userData = { shader: "missing-fixture-shader" };
      gltf.scene.add(invalid);
      return gltf;
    };
    let failed = false;
    try { await failing.character.load([{ basePath: "fixture", component }], "/"); }
    catch { failed = true; }
    b.character.render();
    const failureIsolated = failed && failing.character.shaderScope === null
      && destroyed.length === 1 && outlineB.parent === b.character.root;
    const scope = createShaderRuntimeScope(a.renderer, resourcePackages.shaders);
    scope.dispose();
    let rejectedDisposedScope = false;
    const disposedFixture = fixture();
    try { await scope.applyCustomShaders(disposedFixture, disposedFixture.scene); }
    catch { rejectedDisposedScope = true; }
    b.character.dispose();
    a.renderer.dispose(); b.renderer.dispose(); failing.renderer.dispose();
    return { events, afterA, destroyed, outlineBDisposed, failureIsolated, rejectedDisposedScope };
  });
  assert.deepEqual(result, {
    events: [["a", true, true, true], ["b", true, true, true], ["b", true, true, true], ["b", true, true, true]],
    afterA: { destroyed: ["a"], outlineADetached: true, outlineBAttached: true, outlineBDisposed: 0 },
    destroyed: ["a", "b"], outlineBDisposed: 1, failureIsolated: true, rejectedDisposedScope: true,
  });
});

test("character runtime loads, advances, draws and releases independently of preview controls", { timeout: 30_000 }, async (t) => {
  const vite = await createServer({
    logLevel: "silent", server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  t.after(() => vite.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const port = vite.httpServer.address().port;
  // Import the component in an isolated host, without the preview's render loop,
  // resource catalog or hot-reloaded main.js URL.
  await page.route(`http://127.0.0.1:${port}/`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<script type="module">
      import * as THREE from "/node_modules/three/build/three.module.js";
      import { CharacterRenderer } from "/renderer/character-renderer.js";
      window.__runtimeTest = { THREE, CharacterRenderer };
    </script>`,
  }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => Boolean(window.__runtimeTest));

  const result = await page.evaluate(async () => {
    const { THREE, CharacterRenderer } = window.__runtimeTest;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20);
    camera.position.z = 2;
    let draws = 0;
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas") });
    renderer.setSize(16, 16);
    const draw = renderer.render.bind(renderer);
    renderer.render = (actualScene, actualCamera) => {
      if (actualScene !== scene || actualCamera !== camera) throw new Error("wrong render target");
      draws++;
      draw(actualScene, actualCamera);
    };
    const runtime = new CharacterRenderer({ renderer, scene, camera,
      loader: { async loadAsync(url) {
        if (url !== "/packages/fixture/model.glb") throw new Error(`wrong model URL: ${url}`);
        const root = new THREE.Group();
        root.name = "Character";
        const hips = new THREE.Bone();
        hips.name = "Hips";
        root.add(hips);
        // Cache bounds in the bind pose, then animate into view below. A small
        // independently skinned part (such as an eye) must not use these stale
        // bounds when the camera moves through the bind-pose location.
        const geometry = new THREE.PlaneGeometry(0.4, 0.4).translate(5, 0, 0);
        const count = geometry.attributes.position.count;
        geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
        geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(
          Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4,
        ));
        const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ color: 0xff0000 }));
        mesh.name = "AnimatedEye";
        root.add(mesh);
        mesh.bind(new THREE.Skeleton([hips]));
        mesh.computeBoundingSphere();
        const staticMesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
        staticMesh.name = "StaticPart";
        staticMesh.visible = false;
        root.add(staticMesh);
        const face = new THREE.Object3D();
        face.name = "Face";
        face.morphTargetDictionary = { smile: 0 };
        face.morphTargetInfluences = [0.1];
        root.add(face);
        return { scene: root, parser: {
          associations: new Map([[face, { nodes: 0, meshes: 0, primitives: 0 }]]),
          json: { nodes: [{ name: "Face" }] },
        } };
      } },
    });
    const component = { type: "model", name: "Character", role: "integrated", model: "model.glb",
      humanoidScale: 1,
      morphPoses: [{ name: "Smile", targets: { Face: { smile: 1 } } }],
      expressionGroups: [{ name: "face", type: "eye", states: [{ name: "Smile", poses: { Smile: 0.4 } }] }],
      defaultExpression: { eye: "Smile" } };
    const loaded = await runtime.load([{ name: "Character", basePath: "fixture", component }], "/packages/");
    const attached = loaded.root === runtime.root && scene.children.includes(runtime.root);
    runtime.setPhysicsEnabled(false);
    runtime.update(1 / 60);
    runtime.render();

    const eye = runtime.root.getObjectByName("AnimatedEye");
    runtime.root.getObjectByName("Hips").position.x = -5;
    const target = new THREE.WebGLRenderTarget(16, 16);
    renderer.setRenderTarget(target);
    const cameraSamples = [];
    for (const distance of [2, 0.2, 2]) {
      camera.position.z = distance;
      runtime.render();
      const pixel = new Uint8Array(4);
      renderer.readRenderTargetPixels(target, 8, 8, 1, 1, pixel);
      cameraSamples.push(pixel[0] > 200 && pixel[1] < 20);
    }
    const culling = { cameraSamples, staticPart: runtime.root.getObjectByName("StaticPart").frustumCulled };
    renderer.setRenderTarget(null);
    target.dispose();
    eye.geometry.dispose();
    eye.material.dispose();

    const motion = {
      clips: [{ id: "idle", duration: 1, sampleRate: 1, frames: 2, tracks: [] }],
      auxiliaryClips: [], leftHandPoses: [], rightHandPoses: [],
      program: { parameters: [], commands: {}, baseLayer: "Base Layer", layers: [{
        id: "Base Layer", blend: "override", weight: 1, initialState: "idle",
        states: [{ id: "idle", clip: "idle", speed: 1, loop: true, transitions: [] }],
      }], poseSlots: [] },
    };
    const url = `data:application/json,${encodeURIComponent(JSON.stringify(motion))}`;
    await runtime.selectMotion({ name: "Idle", component: { type: "motion" } }, url);
    const started = runtime.update(1 / 60)?.playing === true
      && runtime.motion?.motion?.program.baseLayer === "Base Layer";
    await runtime.selectMotion(null);
    const stopped = runtime.update(1 / 60)?.playing === false;

    const face = runtime.root.getObjectByName("Face");
    runtime.motionGroup = "fixture";
    const groupMotion = structuredClone(motion);
    groupMotion.clips[0].sampleRate = 2;
    groupMotion.clips[0].frames = 3;
    groupMotion.clips[0].groupTracks = [{ kind: "morph", node: "Face", property: "smile", values: [0.25, 0.5, 0.75] }];
    const groupUrl = `data:application/json,${encodeURIComponent(JSON.stringify(groupMotion))}`;
    let groupUnderlay;
    runtime.setExternalExpressionDriver({
      beginFrame() { if (groupUnderlay !== undefined) face.morphTargetInfluences[0] = groupUnderlay; },
      update() { groupUnderlay = face.morphTargetInfluences[0]; face.morphTargetInfluences[0] = 0.8; },
    });
    await runtime.selectMotion({ name: "Group motion", motionGroup: "fixture", component: { type: "motion" } }, groupUrl);
    runtime.update(0);
    const mixedInitial = face.morphTargetInfluences[0] === 0.8 && groupUnderlay === 0.25
      && !runtime.face.active;
    runtime.update(0.5);
    const mixedProgress = face.morphTargetInfluences[0] === 0.8 && Math.abs(groupUnderlay - 0.5) < 1e-6;
    runtime.setExternalExpressionDriver(null);
    runtime.face.setExpression({ eye: "Smile" }, 0);
    runtime.update(0);
    const actionFaceOwns = face.morphTargetInfluences[0] === 0.5
      && !runtime.face.active && runtime.motion !== null;
    await runtime.selectMotion(null);
    runtime.update(0);
    const nativeRestoredAfterMotion = runtime.face.active && face.morphTargetInfluences[0] === 0.4;
    const propMotion = structuredClone(motion);
    propMotion.clips[0].groupTracks = [{ kind: "visibility", node: "StaticPart", property: "visible", values: [1, 1] }];
    const propUrl = `data:application/json,${encodeURIComponent(JSON.stringify(propMotion))}`;
    await runtime.selectMotion({ name: "Prop motion", motionGroup: "fixture", component: { type: "motion" } }, propUrl);
    runtime.update(0);
    const propKeepsNative = runtime.face.active && face.morphTargetInfluences[0] === 0.4;
    await runtime.selectMotion(null);
    runtime.update(0);
    runtime.face.setExpression({ eye: "Smile" }, 0);
    const observations = [];
    runtime.behaviors.records.push({ fullName: "Fixture.Face", instance: {
      LateUpdate() {
        const state = runtime.behaviors.getExpressionState("integrated");
        observations.push(state.active);
        if (state.active) face.position.x = 4;
      },
    } });
    runtime.update(0);
    const native = [face.morphTargetInfluences[0], face.position.x];
    let disposed = 0;
    let underlay = null;
    const captured = [];
    const driver = {
      beginFrame() {
        if (!underlay) return;
        [face.morphTargetInfluences[0], face.position.x, face.visible] = underlay;
        underlay = null;
      },
      update() {
        underlay = [face.morphTargetInfluences[0], face.position.x, face.visible];
        captured.push(underlay.slice());
        face.morphTargetInfluences[0] = 0.9;
        face.position.x = 9;
        face.visible = false;
      },
      dispose() { disposed++; },
    };
    runtime.setExternalExpressionDriver(driver);
    // A running motion writes before the external face, and does not encounter
    // the previous external frame's TRS/visibility while sampling the next one.
    const motionUnderlays = [];
    runtime.motion = { update() {
      motionUnderlays.push([face.position.x, face.visible]);
      face.morphTargetInfluences[0] = 0.25;
      face.position.x = 2;
    }, dispose() {} };
    runtime.update(0.02);
    runtime.update(0.02);
    const external = [face.morphTargetInfluences[0], face.position.x, face.visible];
    runtime.setExternalExpressionDriver(driver); // idempotent, no disposal
    runtime.setExternalExpressionDriver(null);
    const released = [face.morphTargetInfluences[0], face.position.x, face.visible, runtime.face.active];
    runtime.update(0);
    const resumed = [face.morphTargetInfluences[0], face.position.x];

    runtime.setFaceActive(false);
    runtime.setExternalExpressionDriver(driver);
    runtime.update(0);
    runtime.setExternalExpressionDriver(null);
    const restoredInactive = !runtime.face.active;
    runtime.setExternalExpressionDriver(driver);
    runtime.setFaceActive(true); // records desired native state without stealing writes
    const suspended = !runtime.face.active;
    runtime.update(0);
    runtime.setExternalExpressionDriver(null);
    const restoredRequested = runtime.face.active;
    runtime.setExternalExpressionDriver(driver);
    runtime.update(0);
    let replacementDisposed = 0;
    runtime.setExternalExpressionDriver({ beginFrame() {}, update() {}, dispose() { replacementDisposed++; } });
    const replacementRestored = disposed === 4 && face.visible && face.position.x === 2;
    await runtime.load([{ name: "Character", basePath: "fixture", component }], "/packages/");
    const modelChanged = runtime.externalExpressionDriver === null && replacementDisposed === 1
      && runtime.face.active && runtime.root.getObjectByName("Face") !== face;
    const options = structuredClone(component);
    options.expressionGroups[0].states.push({name:"Other",poses:{Smile:.2}});
    await runtime.load([{name:"Character",basePath:"fixture",component:options}],"/packages/");
    runtime.setExpression({eye:"Other"});runtime.setBlink(.3);runtime.setSpeech(.6);runtime.update(.3);
    runtime.setExpression();runtime.update(.3);
    const declaredDefault = runtime.face.getCapabilities().selections.eye === "Smile"
      && runtime.face.blink === .3 && runtime.face.speech === .6;
    delete options.defaultExpression;
    await runtime.load([{name:"Character",basePath:"fixture",component:options}],"/packages/");
    runtime.setExpression({eye:"Other"});runtime.update(.3);
    const selectedOther = runtime.face.getCapabilities().selections.eye === "Other";
    runtime.setExpression();runtime.update(.3);
    const implicitDefault = selectedOther && runtime.face.getCapabilities().selections.eye === "Smile"
      && runtime.face.blink === .3 && runtime.face.speech === .6
      && Math.abs(runtime.root.getObjectByName("Face").morphTargetInfluences[0] - .4) < 1e-12;
    runtime.dispose();
    const cleared = runtime.externalExpressionDriver === null && disposed === 4
      && face.visible && face.position.x === 2;
    renderer.dispose();
    return { attached, draws, culling, started, stopped,defaults:{declaredDefault,implicitDefault},
      ownership: { mixedInitial, mixedProgress, actionFaceOwns, nativeRestoredAfterMotion, propKeepsNative,
        native, external, captured: captured.slice(0, 2), motionUnderlays: motionUnderlays.slice(0, 2),
        released, resumed, observations, restoredInactive, suspended, restoredRequested,
        replacementRestored, modelChanged, cleared },
      removed: runtime.root === null && scene.children.length === 0 };
  });
  assert.deepEqual(result, { attached: true, draws: 4,
    culling: { cameraSamples: [true, true, true], staticPart: true },
    started: true, stopped: true,
    defaults:{declaredDefault:true,implicitDefault:true},
    ownership: {
      mixedInitial: true, mixedProgress: true, actionFaceOwns: true,
      nativeRestoredAfterMotion: true, propKeepsNative: true,
      native: [0.4, 4], external: [0.9, 9, false],
      captured: [[0.25, 2, true], [0.25, 2, true]], motionUnderlays: [[4, true], [2, true]],
      released: [0.25, 2, true, true], resumed: [0.4, 4],
      observations: [true, false, false, true, false, false, false],
      restoredInactive: true, suspended: true, restoredRequested: true,
      replacementRestored: true, modelChanged: true, cleared: true,
    }, removed: true });
});

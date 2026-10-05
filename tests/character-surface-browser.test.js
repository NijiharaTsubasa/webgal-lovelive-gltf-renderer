import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from './browser-host.js';

test('two prepared actors retain one WebGL context and releasing one preserves the other', { timeout: 30_000 }, async t => {
  const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); t.after(() => vite.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { OffscreenCharacter, CharacterRenderSurface } = await import('/renderer/offscreen-character.js');
    const surface = new CharacterRenderSurface({ width: 32, height: 32 });
    const context = surface.renderer.getContext();
    let contextLossCalls = 0;
    const lose = surface.renderer.forceContextLoss.bind(surface.renderer);
    surface.renderer.forceContextLoss = () => { contextLossCalls++; lose(); };
    async function make(name, color) {
      const actor = new OffscreenCharacter({ surface });
      actor.character.loader = { async loadAsync() {
        const scene = new THREE.Group();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color })));
        return { scene, parser: { json: { nodes: [] }, associations: new Map() } };
      } };
      const entry = { config: `${location.origin}/${name}/config.json`, basePath: `${location.origin}/${name}/`,
        component: { role: 'integrated', model: 'model.glb', humanoidScale: 1, motionGroup: 'fixture' } };
      const catalog = { entries: [], model: async () => entry, preloadModelDependencies: async () => {}, response() { throw new Error('unexpected fetch'); } };
      await actor.load({ modelUrl: entry.config, indexUrl: `${location.origin}/index.json`, resourceCatalog: catalog, runtime: {} });
      return actor;
    }
    const a = await make('a', 0xff0000), b = await make('b', 0x00ff00);
    const memoryBefore = surface.renderer.info.memory.geometries;
    surface.activate(a); a.update(0);
    const rootA = a.character.root, rootB = b.character.root;
    const stable = a.canvas === b.canvas && a.renderer === b.renderer && a.scene !== b.scene && rootA !== rootB && surface.renderer.getContext() === context;
    surface.activate(b); b.update(0); a.dispose();
    const memoryAfter = surface.renderer.info.memory.geometries;
    b.update(0);
    const retained = surface.active === b && b.character.root === rootB && surface.renderer.getContext() === context && !context.isContextLost() && contextLossCalls === 0;
    surface.dispose(); surface.dispose();
    return { stable, retained, memoryBefore, memoryAfter, contextLossCalls, bDisposed: b.disposed };
  });
  assert.deepEqual(result, { stable: true, retained: true, memoryBefore: 2, memoryAfter: 1, contextLossCalls: 1, bDisposed: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { validateModelManifest } from '../src/model-manifest.js';
import { expandMotionManifest } from '../src/motion-manifest.js';

test('format modules load without the converter or preview project', () => {
  assert.equal(typeof validateModelManifest, 'function');
  assert.equal(typeof expandMotionManifest, 'function');
});

test('game dependency packages are not shipped in the renderer source', async () => {
  const entries = await readdir(new URL('../src/', import.meta.url));
  assert.ok(!entries.includes('deps'));
  const shader = await readFile(new URL('../src/parameterized-renderer.js', import.meta.url), 'utf8');
  const offscreen = await readFile(new URL('../src/offscreen-character.js', import.meta.url), 'utf8');
  assert.doesNotMatch(shader + offscreen, /import\.meta\.glob/);
});

test('runtime source does not import the converter, preview or WebGAL implementation', async () => {
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = new URL(entry.name, directory);
      if (entry.isDirectory()) await inspect(new URL(`${entry.name}/`, directory));
      else if (/\.(?:js|mjs)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"][^'"]*(?:model_convert|webgal-mygo|\/tools\/|\/tests\/|main\.js|preview-parameter-runtime)/, file.pathname);
      }
    }
  }
  await inspect(new URL('../src/', import.meta.url));
});

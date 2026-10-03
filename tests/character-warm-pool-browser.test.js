import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from './browser-host.js';

test('browser default timers support ready claims, idle reuse and TTL disposal', { timeout: 30_000 }, async t => {
  const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  t.after(() => vite.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { CharacterWarmPool } = await import('/renderer/character-warm-pool.js');
    const disposed = [], created = [];
    let finishExpiry;
    const expired = new Promise(resolve => { finishExpiry = resolve; });
    const pool = new CharacterWarmPool({
      key: options => options.model,
      ttl: 25,
      create: async options => {
        const actor = { model: options.model, dispose() {
          disposed.push(this.model);
          if (this.model === 'idle') finishExpiry();
        } };
        created.push(actor);
        return actor;
      },
    });
    const first = { preloadId: 'first', model: 'claimed' };
    const second = { preloadId: 'second', model: 'idle' };
    await pool.setRequests([first, second]);
    const claimed = await pool.take(first);
    // Reconciliation clears the retained lease timer through the default API.
    await pool.setRequests([second]);
    await pool.setRequests([]);
    const idleScheduled = pool.idle.length === 1 && pool.idle[0].timer !== null;
    await pool.setRequests([{ ...second, preloadId: 'reused' }]);
    const reused = pool.requests[0].actor === created[1] && pool.idle.length === 0;
    await pool.setRequests([]);
    let timeout;
    try {
      await Promise.race([expired, new Promise((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('Idle actor did not expire')), 2000);
      })]);
    } finally {
      window.clearTimeout(timeout);
    }
    return {
      claimedOriginal: claimed === created[0], idleScheduled, reused,
      created: created.length, disposed, idleRemaining: pool.idle.length,
      takeExpired: await pool.take(second),
    };
  });
  assert.deepEqual(result, {
    claimedOriginal: true, idleScheduled: true, reused: true,
    created: 2, disposed: ['idle'], idleRemaining: 0, takeExpired: null,
  });
  assert.deepEqual(errors, []);
});

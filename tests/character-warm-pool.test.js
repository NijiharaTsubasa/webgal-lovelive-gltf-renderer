import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterWarmPool } from '../src/character-warm-pool.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const request = (id, model = id) => ({ preloadId: id, model });
function fixture(options = {}) {
  const jobs = [], timers = new Map(), disposed = [];
  let clock = 0, timerId = 0, active = 0, maximum = 0;
  const pool = new CharacterWarmPool({
    key: value => value.model,
    create: options => new Promise((resolve, reject) => {
      maximum = Math.max(maximum, ++active);
      const actor = { model: options.model, id: jobs.length,
        dispose() { disposed.push(this.id); } };
      jobs.push({ options, actor, finish: () => { active--; resolve(actor); },
        fail: () => { active--; reject(new Error('fixture failure')); } });
    }),
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: id => timers.delete(id),
    ...options,
  });
  return { pool, jobs, disposed, get maximum() { return maximum; },
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } },
    async finishAll() { for (let i = 0; i < jobs.length; i++) { jobs[i].finish(); await turn(); } },
  };
}

test('ordered demand sizes residency to the finite plan and prepares one at a time', async () => {
  const f = fixture();
  const ready = f.pool.setRequests(['a', 'b', 'c', 'd', 'e'].map(id => request(id)));
  await turn(); assert.equal(f.jobs.length, 1);
  await f.finishAll(); await ready;
  assert.deepEqual(f.jobs.map(job => job.options.model), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(f.maximum, 1);
  assert.equal((await f.pool.take(request('e'))).model, 'e');
});

test('an explicit capacity limits demand without changing preparation order', async () => {
  const f = fixture({ capacity: 2 });
  const ready = f.pool.setRequests(['a', 'b', 'c'].map(id => request(id)));
  await turn(); await f.finishAll(); await ready;
  assert.deepEqual(f.jobs.map(job => job.options.model), ['a', 'b']);
  assert.equal(await f.pool.take(request('c')), null);
});

test('shrinking demand trims idle immediately and empty plans retain only the recent finite budget', async () => {
  const f = fixture();
  let ready = f.pool.setRequests(['a', 'b', 'c', 'd', 'e', 'f'].map(id => request(id)));
  await turn(); await f.finishAll(); await ready;
  await f.pool.setRequests([request('f')]);
  assert.equal(f.pool.capacity, 1);
  assert.equal(f.pool.idle.length, 0);
  assert.equal(f.disposed.length, 5);
  await f.pool.setRequests([]);
  assert.equal(f.pool.idle.length, 1);
  ready = f.pool.setRequests([request('g')]); await turn();
  assert.equal(f.pool.idle.length, 0);
  f.jobs[6].finish(); await ready; await f.pool.setRequests([]);
  assert.equal(f.pool.idle.length, 1);
  f.advance(60000); assert.equal(f.pool.idle.length, 0);
});

test('legacy standalone preload replaces its unused candidate instead of growing an unbounded history', async () => {
  const f = fixture();
  let ready = f.pool.preload(request('a')); await turn(); f.jobs[0].finish(); await ready;
  ready = f.pool.preload(request('b')); await turn();
  assert.deepEqual(f.disposed, [0]); f.jobs[1].finish(); await ready;
  assert.equal(await f.pool.take(request('a')), null);
  assert.equal((await f.pool.take(request('b'))).model, 'b');
});

test('lost ready contexts are discarded and return a miss for on-demand recreation', async () => {
  const f = fixture(); const ready = f.pool.setRequests([request('a')]);
  await turn(); f.jobs[0].finish(); await ready;
  f.jobs[0].actor.renderer = { getContext: () => ({ isContextLost: () => true }) };
  assert.equal(await f.pool.take(request('a')), null);
  assert.deepEqual(f.disposed, [0]);
  const retry = f.pool.setRequests([request('a')]); await turn();
  f.jobs[1].finish(); await retry;
  assert.equal((await f.pool.take(request('a'))).id, 1);
});

test('a context lost during creation rejects preparation and releases the actor', async () => {
  const f = fixture(); const ready = f.pool.setRequests([request('a')]);
  const rejected = assert.rejects(ready, /WebGL context is lost/);
  await turn(); f.jobs[0].actor.renderer = { getContext: () => ({ isContextLost: () => true }) };
  f.jobs[0].finish(); await rejected;
  assert.deepEqual(f.disposed, [0]);
});

test('duplicate state requests own distinct actors and consumed identities are not replenished', async () => {
  const f = fixture(), options = [request('one', 'same'), request('two', 'same')];
  const ready = f.pool.setRequests(options); await turn(); await f.finishAll(); await ready;
  const first = await f.pool.take(options[0]);
  await f.pool.setRequests(options);
  assert.equal(f.jobs.length, 2);
  const second = await f.pool.take(options[1]);
  assert.notEqual(first, second);
  await f.pool.setRequests(options);
  assert.equal(await f.pool.take(options[0]), null);
  await f.pool.setRequests([]);
  const retry = f.pool.setRequests([options[0]]); await turn();
  f.jobs[2].finish(); await retry;
  assert.notEqual(await f.pool.take(options[0]), first);
});

test('live plan survives long background wait; released idle actors expire and can retry', async () => {
  const f = fixture(), options = [request('a')];
  const ready = f.pool.setRequests(options); await turn(); f.jobs[0].finish(); await ready;
  f.advance(65000); assert.deepEqual(f.disposed, []);
  await f.pool.setRequests([]); f.advance(59999); assert.deepEqual(f.disposed, []);
  f.advance(1); assert.deepEqual(f.disposed, [0]);
  const retry = f.pool.setRequests(options); await turn(); f.jobs[1].finish(); await retry;
  assert.equal((await f.pool.take(options[0])).id, 1);
});

test('legacy TTL starts after preparation and expiry does not poison later preload', async () => {
  const f = fixture(); const options = request('a');
  const ready = f.pool.preload(options); await turn(); f.advance(120000);
  assert.deepEqual(f.disposed, []); f.jobs[0].finish(); await ready;
  f.advance(60000); assert.deepEqual(f.disposed, [0]);
  const retry = f.pool.preload(options); await turn(); f.jobs[1].finish(); await retry;
  assert.equal((await f.pool.take(options)).id, 1);
});

test('cancelled creation retains the serial lane and cannot delete its replacement', async () => {
  const f = fixture();
  const old = f.pool.setRequests([request('a')]); await turn();
  await f.pool.setRequests([]);
  const next = f.pool.setRequests([request('a')]); await turn();
  assert.equal(f.jobs.length, 1);
  f.jobs[0].fail(); await old; await turn();
  assert.equal(f.jobs.length, 2); f.jobs[1].finish(); await next;
  assert.equal((await f.pool.take(request('a'))).id, 1);
  assert.equal(f.maximum, 1);
});

test('cancelled successful creation is disposed before another create starts', async () => {
  const f = fixture(); const old = f.pool.setRequests([request('a')]); await turn();
  const next = f.pool.setRequests([request('b')]); f.jobs[0].finish(); await old; await turn();
  assert.deepEqual(f.disposed, [0]); assert.equal(f.jobs.length, 2);
  f.jobs[1].finish(); await next;
});

test('take synchronously claims queued or creating actors against reconciliation', async () => {
  const f = fixture(); const ready = f.pool.setRequests([request('a'), request('b')]); await turn();
  const taken = f.pool.take(request('b'));
  await f.pool.setRequests([]);
  f.jobs[0].finish(); await turn(); assert.equal(f.jobs.length, 2);
  f.jobs[1].finish(); const actor = await taken; await ready;
  assert.equal(actor.model, 'b'); assert.deepEqual(f.disposed, [0]);
});

test('failed preparation can be retried by the next explicit demand snapshot', async () => {
  const f = fixture(); const options = [request('a')];
  const failed = f.pool.setRequests(options); const rejected = assert.rejects(failed, /fixture failure/);
  await turn(); f.jobs[0].fail(); await rejected; await turn();
  const retry = f.pool.setRequests(options); await turn(); f.jobs[1].finish(); await retry;
  assert.equal((await f.pool.take(options[0])).id, 1);
});

test('idle reuse preserves prepared actors but yields capacity to ordered future demand', async () => {
  const f = fixture(); let ready = f.pool.setRequests([request('a')]);
  await turn(); f.jobs[0].finish(); await ready; await f.pool.setRequests([]);
  await f.pool.setRequests([request('new-id', 'a')]); assert.equal(f.jobs.length, 1);
  ready = f.pool.setRequests(['b', 'c', 'd', 'e'].map(id => request(id)));
  await turn();
  for (let i = 1; i < 5; i++) { f.jobs[i].finish(); await turn(); }
  await ready; assert.deepEqual(f.disposed, [0]);
  assert.equal(f.pool.idle.length, 0);
});

// A bounded pool owns only speculative instances. Claimed instances belong to
// their caller, even while their preparation is still in flight.
export class CharacterWarmPool {
  constructor({ create, key, capacity, ttl = 60000,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = timer => globalThis.clearTimeout(timer) }) {
    this.create = create;
    this.key = key;
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) {
      throw new Error('Preload capacity must be a positive integer');
    }
    this.capacityLimit = capacity;
    this.capacity = capacity ?? 1;
    this.ttl = ttl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.requests = [];
    this.idle = [];
    this.creating = null;
    this.legacyId = 0;
  }

  slot(options, id, leased = false) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Reconciliation may retire an unobserved slot. Its original waiter still
    // receives failures, without an unrelated unhandled rejection.
    promise.catch(() => {});
    return { options, id, leased, key: this.key(options), state: 'queued', promise,
      resolve, reject, actor: null, timer: null };
  }

  setRequests(options) {
    const occurrences = new Map();
    const next = options.slice(0, this.capacityLimit ?? options.length).map(value => {
      const key = this.key(value);
      const ordinal = occurrences.get(key) ?? 0;
      occurrences.set(key, ordinal + 1);
      return { value, id: value.preloadId ?? `${key}#${ordinal}`, key };
    });
    if (new Set(next.map(item => item.id)).size !== next.length) {
      throw new Error('Preload request identities must be unique');
    }
    // Empty plans retain only the most recent finite budget until idle TTL.
    if (next.length) this.capacity = next.length;
    const old = new Map(this.requests.map(slot => [slot.id, slot]));
    const selected = next.map(({ value, id, key }) => {
      const previous = old.get(id);
      if (previous?.key === key && !['failed', 'expired', 'cancelled'].includes(previous.state)) {
        old.delete(id);
        return previous;
      }
      return { value, id };
    });
    for (const slot of old.values()) {
      if (slot.state === 'ready') this.release(slot);
      else this.retire(slot);
    }
    this.requests = selected.map(item => {
      if (!item.value) { item.leased = true; this.clearTimer(item.timer); return item; }
      const index = this.idle.findIndex(slot => slot.key === this.key(item.value) && slot.state === 'ready');
      if (index < 0) return this.slot(item.value, item.id, true);
      const slot = this.idle.splice(index, 1)[0];
      this.clearTimer(slot.timer);
      Object.assign(slot, { options: item.value, id: item.id, leased: true });
      return slot;
    });
    this.trimIdle();
    this.pump();
    return Promise.all(this.requests.map(slot => slot.promise)).then(() => undefined);
  }

  preload(options) {
    const key = this.key(options);
    const existing = [...this.requests, ...this.idle].find(slot => slot.key === key
      && ['queued', 'creating', 'ready'].includes(slot.state));
    if (existing) return existing.promise.then(() => undefined);
    this.capacity = this.capacityLimit ?? 1;
    const candidates = this.requests.filter(slot => ['queued', 'creating', 'ready'].includes(slot.state));
    while (candidates.length >= this.capacity) this.retire(candidates.shift());
    const slot = this.slot(options, `legacy:${++this.legacyId}`);
    this.requests = [...candidates, slot];
    this.trimIdle();
    this.pump();
    return slot.promise.then(() => undefined);
  }

  take(options) {
    const key = this.key(options);
    const available = slot => slot.key === key && ['queued', 'creating', 'ready'].includes(slot.state);
    const slot = (options.preloadId && this.requests.find(item => item.id === options.preloadId && available(item)))
      || this.requests.find(available) || this.idle.find(available);
    if (!slot) return Promise.resolve(null);
    if (slot.actor?.renderer?.getContext().isContextLost()) {
      this.retire(slot, 'failed');
      return Promise.resolve(null);
    }
    this.clearTimer(slot.timer);
    const queued = slot.state === 'queued';
    const pending = slot.promise;
    slot.state = 'claimed';
    slot.actor = null;
    slot.promise = Promise.resolve(null);
    this.idle = this.idle.filter(item => item !== slot);
    // A queued claim still goes through the one preparation lane. Reconcile
    // cannot cancel it, and it is no longer speculative GPU residency.
    if (queued) {
      slot.claimQueued = true;
      this.claims ??= [];
      this.claims.push(slot);
    }
    this.pump();
    return pending;
  }

  release(slot) {
    slot.leased = false;
    this.clearTimer(slot.timer);
    this.idle.push(slot);
    slot.timer = this.setTimer(() => this.retire(slot, 'expired'), this.ttl);
  }

  trimIdle() {
    const reserved = this.requests.filter(slot => ['queued', 'creating', 'ready'].includes(slot.state)).length;
    while (this.idle.length > Math.max(0, this.capacity - reserved)) this.retire(this.idle[0]);
  }

  retire(slot, state = 'cancelled') {
    if (slot.state === 'claimed') return;
    this.clearTimer(slot.timer);
    slot.actor?.dispose();
    slot.actor = null;
    slot.state = state;
    this.idle = this.idle.filter(item => item !== slot);
    slot.resolve(null);
  }

  pump() {
    if (this.creating) return;
    const slot = this.claims?.shift() ?? this.requests.find(item => item.state === 'queued');
    if (!slot) return;
    const claimed = slot.state === 'claimed';
    // Idle entries are useful only while they do not displace nearer demand.
    while (!claimed && this.requests.filter(item => item.state === 'ready').length + this.idle.length >= this.capacity) {
      if (!this.idle.length) return;
      this.retire(this.idle[0]);
    }
    if (!claimed) slot.state = 'creating';
    slot.claimQueued = false;
    this.creating = slot;
    Promise.resolve().then(() => this.create(slot.options)).then(actor => {
      if (slot.state === 'cancelled' || slot.state === 'expired') {
        actor.dispose();
        return;
      }
      if (actor.renderer?.getContext().isContextLost()) {
        actor.dispose();
        slot.state = 'failed';
        slot.reject(new Error('Prepared character WebGL context is lost'));
        return;
      }
      if (slot.state !== 'claimed') {
        slot.actor = actor;
        slot.state = 'ready';
        if (!slot.leased) slot.timer = this.setTimer(() => this.retire(slot, 'expired'), this.ttl);
      }
      slot.resolve(actor);
    }, error => {
      if (slot.state !== 'cancelled' && slot.state !== 'expired') {
        slot.state = 'failed';
        slot.reject(error);
      }
    }).finally(() => {
      this.creating = null;
      this.pump();
    });
  }
}

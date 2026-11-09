// Iteration-order replica of Unity.Collections' UnsafeParallelHashMap, the storage behind NativeParallelHashMap,
// NativeParallelHashSet and NativeParallelMultiHashMap (single-threaded use, no removals):
// - entries are allocated sequentially; each bucket is a singly linked chain with the newest entry at its head;
// - the bucket array has ceilpow2(capacity * 2) slots; when the key capacity is exhausted it doubles and the
//   entries are rehashed by walking the old buckets in index order, moving each chain head to the head of its
//   new bucket (which reverses the order of entries that stay together, e.g. the values of one multi-map key);
// - enumeration (foreach, GetKeyArray, ToNativeArray) walks the buckets in index order and each chain from its
//   head; GetValuesForKey walks one chain from its head.
// MagicaCloth2's proxy-mesh build (edges, duplicate-triangle removal, neighbour and child lists) depends on these
// orders, so a runtime build reproduces the game's topology only with the same containers.

const ceilpow2 = (x) => { x -= 1; x |= x >> 1; x |= x >> 2; x |= x >> 4; x |= x >> 8; x |= x >> 16; return x + 1; };

/** int.GetHashCode */
export const hashInt = (x) => x | 0;
/** int2.GetHashCode = (int)math.hash(int2): csum(asuint(v) * uint2(0x83B58237, 0x833E3E29)) + 0xA4F1C1BF
 *  (the additive constant is fitted to the PreBuild edge orders of 878 game cloths; low 11 bits verified) */
export const hashInt2 = (x, y) => (Math.imul(x, 0x83B58237) + Math.imul(y, 0x833E3E29) + 0xA4F1C1BF) | 0;

// int2 keys of vertex indices (< 65536) are packed into one number so that keys compare with ===
export const int2Key = (x, y) => x * 65536 + y;
export const int2X = (k) => Math.floor(k / 65536);
export const int2Y = (k) => k % 65536;
export const hashInt2Key = (k) => hashInt2(int2X(k), int2Y(k));

export class NativeParallelHashMap {
  /** capacity: the constructor argument; hash(key) -> int32; multi: NativeParallelMultiHashMap semantics */
  constructor(capacity, hash, multi = false) {
    this.hash = hash;
    this.multi = multi;
    this.keyCapacity = capacity;
    this.buckets = new Int32Array(ceilpow2(capacity * 2)).fill(-1);
    this.mask = this.buckets.length - 1;
    this.next = [];
    this.keys = [];
    this.values = [];
  }

  get count() { return this.keys.length; }

  first(key) {
    for (let i = this.buckets[this.hash(key) & this.mask]; i >= 0; i = this.next[i]) if (this.keys[i] === key) return i;
    return -1;
  }

  containsKey(key) { return this.first(key) >= 0; }

  get(key) { const i = this.first(key); return i >= 0 ? this.values[i] : undefined; }

  /** NativeParallelHashMap indexer set: in place when present, otherwise TryAdd */
  set(key, value) { const i = this.first(key); if (i >= 0) this.values[i] = value; else this.add(key, value); }

  /** TryAdd (Add for multi maps); a plain map refuses an existing key */
  add(key, value = true) {
    if (!this.multi && this.first(key) >= 0) return false;
    if (this.keys.length >= this.keyCapacity) this.grow();
    const idx = this.keys.length, b = this.hash(key) & this.mask;
    this.keys.push(key);
    this.values.push(value);
    this.next.push(this.buckets[b]);
    this.buckets[b] = idx;
    return true;
  }

  grow() {
    const capacity = this.keyCapacity === 0 ? 1 : this.keyCapacity * 2;   // GrowCapacity
    const buckets = new Int32Array(ceilpow2(capacity * 2)).fill(-1), mask = buckets.length - 1;   // GetBucketSize
    for (let b = 0; b <= this.mask; b++) {
      while (this.buckets[b] >= 0) {
        const cur = this.buckets[b];
        this.buckets[b] = this.next[cur];
        const nb = this.hash(this.keys[cur]) & mask;
        this.next[cur] = buckets[nb];
        buckets[nb] = cur;
      }
    }
    this.keyCapacity = capacity;
    this.buckets = buckets;
    this.mask = mask;
  }

  /** GetValuesForKey */
  *valuesForKey(key) {
    for (let i = this.buckets[this.hash(key) & this.mask]; i >= 0; i = this.next[i]) if (this.keys[i] === key) yield this.values[i];
  }

  countValuesForKey(key) { let n = 0; for (const _ of this.valuesForKey(key)) n++; return n; }

  /** MC2Contains(key, value) */
  containsPair(key, value) { for (const v of this.valuesForKey(key)) if (v === value) return true; return false; }

  /** MC2UniqueAdd */
  uniqueAdd(key, value) { if (!this.containsPair(key, value)) this.add(key, value); }

  /** foreach / GetKeyArray / GetKeyValueArrays order */
  *entries() {
    for (let b = 0; b <= this.mask; b++) for (let i = this.buckets[b]; i >= 0; i = this.next[i]) yield [this.keys[i], this.values[i]];
  }

  keyArray() { return Array.from(this.entries(), (e) => e[0]); }
}

/** MultiDataBuilder<T>.ToNativeArray: per index, GetValuesForKey order; index = Pack12_20(count, start) */
export function multiDataToArrays(map, indexCount) {
  const index = new Uint32Array(indexCount), data = [];
  for (let i = 0; i < indexCount; i++) {
    const start = data.length;
    for (const v of map.valuesForKey(i)) data.push(v);
    index[i] = (((data.length - start) & 0xfff) << 20 | (start & 0xfffff)) >>> 0;
  }
  return { index, data };
}

/** JobUtility.ToNativeMultiHashMap(indexArray, dataArray) */
export function arraysToMultiMap(index, data) {
  const map = new NativeParallelHashMap(data.length, hashInt, true);
  for (let i = 0; i < index.length; i++) {
    const cnt = index[i] >>> 20, start = index[i] & 0xfffff;
    for (let j = 0; j < cnt; j++) map.add(i, data[start + j]);
  }
  return map;
}

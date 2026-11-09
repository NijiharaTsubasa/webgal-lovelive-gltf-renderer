// Iteration-order replicas of the Unity.Collections containers MagicaCloth2's proxy-mesh build relies on.
//
// UnsafeParallelHashMap (behind NativeParallelHashMap / HashSet / MultiHashMap), single-threaded use:
// - entries take a slot from the free list (removed entries, last freed first) or the next never-used slot;
//   each bucket is a singly linked chain with the newest entry at its head;
// - the bucket array has ceilpow2(capacity * 2) slots; when every slot is used and the free list is empty the key
//   capacity doubles and the entries are rehashed by walking the old buckets in index order, moving each chain
//   head to the head of its new bucket (which reverses the order of entries that stay together, e.g. the values
//   of one multi-map key);
// - enumeration (foreach, GetKeyArray, ToNativeArray) walks the buckets in index order and each chain from its
//   head; GetValuesForKey walks one chain from its head; Remove unlinks entries and pushes their slots on the free
//   list; Clear empties everything but keeps the capacity.
// NativeSortExtension.Sort: the introsort of NativeSortExtension.cs (not stable: equal elements end up in an
// order that depends on the algorithm).
// The game's topology (which quad diagonal survives, which vertices a reduction joins, vertex and edge orders)
// follows from these orders, so a runtime build reproduces it only with the same containers.

const ceilpow2 = (x) => { x -= 1; x |= x >> 1; x |= x >> 2; x |= x >> 4; x |= x >> 8; x |= x >> 16; return x + 1; };

/** int.GetHashCode (also ushort) */
export const hashInt = (x) => x | 0;
/** int2.GetHashCode = (int)math.hash(int2): csum(asuint(v) * uint2(0x83B58237, 0x833E3E29)) + 0xA4F1C1BF
 *  (the additive constant is fitted to the PreBuild edge orders of 878 game cloths; low 11 bits verified) */
export const hashInt2 = (x, y) => (Math.imul(x, 0x83B58237) + Math.imul(y, 0x833E3E29) + 0xA4F1C1BF) | 0;
/** int3.GetHashCode = (int)math.hash(int3): csum(asuint(v) * uint3(0x4C7F6DD1, 0x4822A3E9, 0xAAC3C25D)) + 0xD21D0945 */
export const hashInt3 = (x, y, z) => (Math.imul(x, 0x4C7F6DD1) + Math.imul(y, 0x4822A3E9) + Math.imul(z, 0xAAC3C25D) + 0xD21D0945) | 0;

// int2 / int3 keys of vertex indices (< 32768) are packed into one number so that keys compare with ===
export const int2Key = (x, y) => x * 65536 + y;
export const int2X = (k) => Math.floor(k / 65536);
export const int2Y = (k) => k % 65536;
export const hashInt2Key = (k) => hashInt2(int2X(k), int2Y(k));
export const int3Key = (x, y, z) => (x * 32768 + y) * 32768 + z;
export const int3Of = (k) => [Math.floor(k / 1073741824), Math.floor(k / 32768) % 32768, k % 32768];
export const hashInt3Key = (k) => { const [x, y, z] = int3Of(k); return hashInt3(x, y, z); };

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
    this.allocated = 0;   // allocatedIndexLength
    this.free = -1;       // firstFreeTLS[0]
    this.count = 0;
  }

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
    if (this.allocated >= this.keyCapacity && this.free < 0) this.grow();
    let idx;
    if (this.free >= 0) { idx = this.free; this.free = this.next[idx]; } else idx = this.allocated++;
    const b = this.hash(key) & this.mask;
    this.keys[idx] = key;
    this.values[idx] = value;
    this.next[idx] = this.buckets[b];
    this.buckets[b] = idx;
    this.count++;
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

  release(idx) { this.next[idx] = this.free; this.free = idx; this.count--; }

  /** Remove(key): every entry of the key (one for a plain map) */
  remove(key) {
    const b = this.hash(key) & this.mask;
    let prev = -1, i = this.buckets[b], removed = 0;
    while (i >= 0) {
      const nx = this.next[i];
      if (this.keys[i] === key) {
        if (prev < 0) this.buckets[b] = nx; else this.next[prev] = nx;
        this.release(i);
        removed++;
        if (!this.multi) break;
      } else prev = i;
      i = nx;
    }
    return removed;
  }

  /** MC2RemoveValue(key, value): the first matching entry along the chain */
  removeValue(key, value) {
    const b = this.hash(key) & this.mask;
    let prev = -1;
    for (let i = this.buckets[b]; i >= 0; prev = i, i = this.next[i]) {
      if (this.keys[i] === key && this.values[i] === value) {
        if (prev < 0) this.buckets[b] = this.next[i]; else this.next[prev] = this.next[i];
        this.release(i);
        return true;
      }
    }
    return false;
  }

  clear() {
    this.buckets.fill(-1);
    this.next = []; this.keys = []; this.values = [];
    this.allocated = 0; this.free = -1; this.count = 0;
  }

  /** GetValuesForKey */
  *valuesForKey(key) {
    for (let i = this.buckets[this.hash(key) & this.mask]; i >= 0; i = this.next[i]) if (this.keys[i] === key) yield this.values[i];
  }

  valuesArray(key) { const out = []; for (let i = this.buckets[this.hash(key) & this.mask]; i >= 0; i = this.next[i]) if (this.keys[i] === key) out.push(this.values[i]); return out; }

  countValuesForKey(key) { let n = 0; for (let i = this.buckets[this.hash(key) & this.mask]; i >= 0; i = this.next[i]) if (this.keys[i] === key) n++; return n; }

  /** MC2Contains(key, value) */
  containsPair(key, value) { for (let i = this.buckets[this.hash(key) & this.mask]; i >= 0; i = this.next[i]) if (this.keys[i] === key && this.values[i] === value) return true; return false; }

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

// ---------------------------------------------------------------------------------- NativeSortExtension.Sort
/** In-place introsort of Unity.Collections (compare(a, b) < 0 when a sorts first, like IComparer.Compare). */
export function unitySort(a, compare) {
  const n = a.length;
  if (n < 2) return a;
  const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  const swapIfGreater = (i, j) => { if (i !== j && compare(a[i], a[j]) > 0) swap(i, j); };
  const insertionSort = (lo, hi) => {
    for (let i = lo; i < hi; i++) {
      let j = i;
      const t = a[i + 1];
      while (j >= lo && compare(t, a[j]) < 0) { a[j + 1] = a[j]; j--; }
      a[j + 1] = t;
    }
  };
  const heapify = (i, len, lo) => {
    const val = a[lo + i - 1];
    while (i <= len >> 1) {
      let child = 2 * i;
      if (child < len && compare(a[lo + child - 1], a[lo + child]) < 0) child++;
      if (!(compare(a[lo + child - 1], val) < 0)) break;
      a[lo + i - 1] = a[lo + child - 1];
      i = child;
    }
    a[lo + i - 1] = val;
  };
  const heapSort = (lo, hi) => {
    const len = hi - lo + 1;
    for (let i = len >> 1; i >= 1; i--) heapify(i, len, lo);
    for (let i = len; i > 1; i--) { swap(lo, lo + i - 1); heapify(1, i - 1, lo); }
  };
  const partition = (lo, hi) => {
    const mid = lo + ((hi - lo) >> 1);
    swapIfGreater(lo, mid);
    swapIfGreater(lo, hi);
    swapIfGreater(mid, hi);
    const pivot = a[mid];
    swap(mid, hi - 1);
    let left = lo, right = hi - 1;
    while (left < right) {
      while (compare(pivot, a[++left]) > 0);
      while (compare(pivot, a[--right]) < 0);
      if (left >= right) break;
      swap(left, right);
    }
    swap(left, hi - 1);
    return left;
  };
  const introSort = (lo, hi, depth) => {
    while (hi > lo) {
      const size = hi - lo + 1;
      if (size <= 16) {
        if (size === 1) return;
        if (size === 2) { swapIfGreater(lo, hi); return; }
        if (size === 3) { swapIfGreater(lo, hi - 1); swapIfGreater(lo, hi); swapIfGreater(hi - 1, hi); return; }
        insertionSort(lo, hi);
        return;
      }
      if (depth === 0) { heapSort(lo, hi); return; }
      depth--;
      const p = partition(lo, hi);
      introSort(p + 1, hi, depth);
      hi = p - 1;
    }
  };
  introSort(0, n - 1, 2 * (31 - Math.clz32(n)));   // 2 * Log2Floor(length)
  return a;
}

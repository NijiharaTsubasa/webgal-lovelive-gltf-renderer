import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import initializeJolt from "../src/vendor/jolt/jolt-physics.wasm.js";

const jolt = initializeJolt({ wasmBinary: await readFile(new URL("../src/vendor/jolt/jolt-physics.wasm.wasm", import.meta.url)) });

function vertexIndices(J, vertex) {
  const base = J.getPointer(vertex), traits = J.SoftBodyVertexTraits.prototype;
  return {
    x: (base + traits.mPositionOffset) / Float32Array.BYTES_PER_ELEMENT,
    q: (base + traits.mPreviousPositionOffset) / Float32Array.BYTES_PER_ELEMENT,
    velocity: (base + traits.mVelocityOffset) / Float32Array.BYTES_PER_ELEMENT,
  };
}

function setVec3(heap, index, x, y, z) {
  heap[index] = x; heap[index + 1] = y;
  heap[index + 2] = z; heap[index + 3] = z;
}

// Reference is the original public-accessor transfer, including its float32
// store/reload before computing the velocity correction.
function accessorTransport(vertex, target, previous, fixed, stiffness, gravity, delta) {
  const x = vertex.mPosition, q = vertex.mPreviousPosition, velocity = vertex.mVelocity;
  if (fixed) {
    x.Set(...target); q.Set(...target); velocity.Set(0, 0, 0);
  } else {
    const dx = target[0] - previous[0], dy = target[1] - previous[1], dz = target[2] - previous[2];
    x.Set(x.GetX() + dx, x.GetY() + dy, x.GetZ() + dz);
    q.Set(q.GetX() + dx, q.GetY() + dy, q.GetZ() + dz);
    velocity.Set(velocity.GetX() + ((target[0] - x.GetX()) * stiffness + gravity[0]) * delta,
      velocity.GetY() + ((target[1] - x.GetY()) * stiffness + gravity[1]) * delta,
      velocity.GetZ() + ((target[2] - x.GetZ()) * stiffness + gravity[2]) * delta);
  }
}

function heapTransport(J, indices, target, previous, fixed, stiffness, gravity, delta) {
  const heap = J.HEAPF32, { x, q, velocity } = indices;
  if (fixed) {
    setVec3(heap, x, ...target); setVec3(heap, q, ...target); setVec3(heap, velocity, 0, 0, 0);
  } else {
    const dx = target[0] - previous[0], dy = target[1] - previous[1], dz = target[2] - previous[2];
    setVec3(heap, x, heap[x] + dx, heap[x + 1] + dy, heap[x + 2] + dz);
    setVec3(heap, q, heap[q] + dx, heap[q + 1] + dy, heap[q + 2] + dz);
    setVec3(heap, velocity, heap[velocity] + ((target[0] - heap[x]) * stiffness + gravity[0]) * delta,
      heap[velocity + 1] + ((target[1] - heap[x + 1]) * stiffness + gravity[1]) * delta,
      heap[velocity + 2] + ((target[2] - heap[x + 2]) * stiffness + gravity[2]) * delta);
  }
}

test("official soft-body traits address every vertex's Vec3 fields without a hard-coded stride", async () => {
  const J = await jolt, vertices = new J.ArraySoftBodyVertex();
  vertices.resize(4);
  try {
    for (let i = 0; i < vertices.size(); i++) {
      const vertex = vertices.at(i), indices = vertexIndices(J, vertex);
      for (const [key, field] of [["x", "mPosition"], ["q", "mPreviousPosition"], ["velocity", "mVelocity"]]) {
        assert.equal(indices[key] * Float32Array.BYTES_PER_ELEMENT, J.getPointer(vertex[field]));
        assert.equal(Number.isInteger(indices[key]), true);
        vertex[field].Set(.13 + i, -.27 - i, .39 + i);
        assert.deepEqual(Array.from(J.HEAPF32.slice(indices[key], indices[key] + 4)),
          [.13 + i, -.27 - i, .39 + i, .39 + i].map(Math.fround));
      }
    }
  } finally { J.destroy(vertices); }
});

test("Float3 reference writes touch only xyz and preserve the neighboring native fields", async () => {
  const J = await jolt, vertex = new J.SoftBodySharedSettingsVertex();
  try {
    vertex.mVelocity.x = 7.125; vertex.mVelocity.y = -8.25; vertex.mVelocity.z = 9.5;
    vertex.mInvMass = .375;
    const reference = vertex.mPosition, index = J.getPointer(reference) / Float32Array.BYTES_PER_ELEMENT;
    const heap = J.HEAPF32;
    heap[index] = .123456789; heap[index + 1] = -.234567891; heap[index + 2] = .345678912;
    assert.deepEqual([reference.x, reference.y, reference.z], [.123456789, -.234567891, .345678912].map(Math.fround));
    assert.deepEqual([vertex.mVelocity.x, vertex.mVelocity.y, vertex.mVelocity.z], [7.125, -8.25, 9.5]);
    assert.equal(vertex.mInvMass, .375);
  } finally { J.destroy(vertex); }
});

test("heap transport is bit-identical to native accessors across fixed, moving and large-coordinate inputs", async () => {
  const J = await jolt, vertices = new J.ArraySoftBodyVertex();
  vertices.resize(2);
  const oldVertex = vertices.at(0), newVertex = vertices.at(1);
  const oldIndices = vertexIndices(J, oldVertex), newIndices = vertexIndices(J, newVertex);
  try {
    for (const origin of [0, 17.3, 100000.1]) {
      for (const vertex of [oldVertex, newVertex]) {
        vertex.mPosition.Set(origin + .1, -.234567891, .345678912);
        vertex.mPreviousPosition.Set(origin - .031, .071, -.043);
        vertex.mVelocity.Set(.0021, -.013, .031);
        vertex.mInvMass = .375;
      }
      let previous = [origin + .13, -.23, .37];
      for (let step = 0; step < 120; step++) {
        const target = [origin + .13 + .0031 * Math.sin(step), -.23 + .0017 * Math.cos(step), .37 - step * .00013];
        const fixed = step % 17 === 0, delta = [1 / 60, 1 / 120, 1 / 30][step % 3];
        accessorTransport(oldVertex, target, previous, fixed, 12.3, [.0013, -9.81, .0041], delta);
        heapTransport(J, newIndices, target, previous, fixed, 12.3, [.0013, -9.81, .0041], delta);
        const bits = new Uint32Array(J.HEAPF32.buffer);
        for (const key of ["x", "q", "velocity"]) {
          assert.deepEqual(Array.from(bits.slice(oldIndices[key], oldIndices[key] + 4)),
            Array.from(bits.slice(newIndices[key], newIndices[key] + 4)), `${origin}: step ${step}, ${key}`);
        }
        assert.equal(newVertex.mInvMass, .375);
        previous = target;
      }
    }
  } finally { J.destroy(vertices); }
});

test("transport velocity uses the rounded position store, not an unrounded JS temporary", async () => {
  const J = await jolt, vertices = new J.ArraySoftBodyVertex();
  vertices.resize(1);
  try {
    const vertex = vertices.at(0), indices = vertexIndices(J, vertex);
    vertex.mPosition.Set(.1, 0, 0); vertex.mPreviousPosition.Set(.1, 0, 0); vertex.mVelocity.Set(0, 0, 0);
    const oldX = vertex.mPosition.GetX(), previous = [.1, 0, 0], target = [.10000001, 0, 0];
    heapTransport(J, indices, target, previous, false, 12, [0, 0, 0], 1 / 60);
    const expected = Math.fround((target[0] - Math.fround(oldX + target[0] - previous[0])) * 12 / 60);
    const unrounded = Math.fround((target[0] - (oldX + target[0] - previous[0])) * 12 / 60);
    assert.equal(vertex.mVelocity.GetX(), expected);
    assert.notEqual(expected, unrounded, "fixture must detect losing the native float32 write/read boundary");
  } finally { J.destroy(vertices); }
});

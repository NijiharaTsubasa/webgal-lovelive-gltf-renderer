import assert from "node:assert/strict";
import test from "node:test";

import { decodeMotionBinary, fetchMotionPayload } from "../src/motion-binary.js";

function fixture() {
  const motion = {
    clips: [{
      id: "clip", tracks: [{
        bone: "Hips",
        rotation: { offset: 0, length: 4, type: "f32" },
        translation: { offset: 16, length: 3, type: "f64" },
      }], groupTracks: [],
    }],
    auxiliaryClips: [], leftHandPoses: [], rightHandPoses: [], program: { layers: [] },
  };
  const header = new TextEncoder().encode(JSON.stringify(motion));
  const dataStart = Math.ceil((12 + header.length) / 8) * 8;
  const buffer = new ArrayBuffer(dataStart + 40);
  const bytes = new Uint8Array(buffer);
  bytes.set([77, 79, 84, 73, 79, 78, 0, 0]);
  new DataView(buffer).setUint32(8, header.length, true);
  bytes.set(header, 12);
  const data = new DataView(buffer);
  [0, -0, 0.5, 1].forEach((value, index) => data.setFloat32(dataStart + index * 4, value, true));
  [0.1, 2, 3].forEach((value, index) => data.setFloat64(dataStart + 16 + index * 8, value, true));
  return buffer;
}

test("binary motion restores sampled arrays without copying on little-endian hosts", () => {
  const buffer = fixture();
  const track = decodeMotionBinary(buffer).clips[0].tracks[0];
  assert.ok(track.rotation instanceof Float32Array);
  assert.ok(track.translation instanceof Float64Array);
  assert.deepEqual([...track.rotation], [0, -0, 0.5, 1]);
  assert.deepEqual([...track.translation], [0.1, 2, 3]);
  assert.equal(track.rotation.buffer, buffer);
});

test("binary motion rejects broken signatures and array ranges", () => {
  const broken = fixture();
  new Uint8Array(broken)[0] = 0;
  assert.throws(() => decodeMotionBinary(broken), /signature mismatch/);
  const truncated = fixture().slice(0, -1);
  assert.throws(() => decodeMotionBinary(truncated), /invalid translation range/);
});

test("motion loader keeps JSON and binary as current encodings", async () => {
  const originalFetch = globalThis.fetch;
  const buffer = fixture();
  try {
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => buffer });
    assert.equal((await fetchMotionPayload("/motions/clip.motionbin")).clips[0].id, "clip");
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ clips: [] }) });
    assert.deepEqual(await fetchMotionPayload("/motions/clip.json"), { clips: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

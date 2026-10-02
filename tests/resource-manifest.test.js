import assert from "node:assert/strict";
import test from "node:test";

import { validateResourceManifest } from "../src/resource-manifest.js";
import {
  expandMotionManifest,
  validateMotionManifest,
  validateMotionPayload,
} from "../src/motion-manifest.js";

test("unified manifests contain only a components array, including empty directories", () => {
  const manifest = { components: [{ type: "future-resource" }] };
  assert.equal(validateResourceManifest(manifest), manifest);
  assert.throws(
    () => validateResourceManifest({ type: "model", components: [{ type: "model" }] }),
    /顶层只能包含 components/,
  );
  assert.deepEqual(validateResourceManifest({ components: [] }), { components: [] });
});

test("motion descriptors expand independently from payload data", () => {
  const manifest = {
    components: [
      { type: "model", name: "character", role: "integrated" },
      {
        type: "motion",
        name: "idle/001",
        description: "Idle",
        motionGroup: "game",
        src: "motions/idle.json",
      },
    ],
  };
  assert.equal(validateMotionManifest(manifest), manifest);
  const [entry] = expandMotionManifest(manifest, "game/config.json");
  assert.equal(entry.key, "game/config.json#motion:game:idle/001");
  assert.equal(entry.basePath, "game");
  assert.equal(entry.src, "motions/idle.json");
  assert.equal(validateMotionManifest({ components: [{ type: "motion", name: "idle", src: "idle.motionbin" }] }).components[0].src, "idle.motionbin");
});

test("motion payload rejects manifest metadata", () => {
  const payload = {
    clips: [],
    auxiliaryClips: [],
    leftHandPoses: [],
    rightHandPoses: [],
    program: { layers: [] },
  };
  assert.equal(validateMotionPayload(payload), payload);
  assert.throws(() => validateMotionPayload({ ...payload, type: "motion" }), /不得包含 type/);
});

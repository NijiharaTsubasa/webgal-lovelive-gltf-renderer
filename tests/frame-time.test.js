import test from "node:test";
import assert from "node:assert/strict";
import { Timer } from "three";

import { normalizeFrameDelta } from "../src/frame-time.js";

test("background-resume clock samples are safe before entering model lifecycles", () => {
  let visibilityHandler;
  const document = {
    hidden: false,
    addEventListener(name, handler) {
      if (name === "visibilitychange") visibilityHandler = handler;
    },
    removeEventListener() {},
  };
  const timer = new Timer();
  timer.connect(document);
  const queuedAnimationFrameTimestamp = performance.now() - 100;
  visibilityHandler();
  timer.update(queuedAnimationFrameTimestamp);

  assert.ok(timer.getDelta() < 0);
  assert.equal(normalizeFrameDelta(timer.getDelta()), 0);
  assert.equal(normalizeFrameDelta(Number.NaN), 0);
  assert.equal(normalizeFrameDelta(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeFrameDelta(5), 5);
  assert.equal(normalizeFrameDelta(1 / 120), 1 / 120);
});

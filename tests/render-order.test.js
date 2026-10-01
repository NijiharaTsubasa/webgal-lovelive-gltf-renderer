import assert from "node:assert/strict";
import test from "node:test";

import { applyRenderQueue } from "../src/render-order.js";

test("renderQueue maps to Object3D.renderOrder", () => {
  const object = { name: "Face", renderOrder: 0 };
  applyRenderQueue(object, [{ renderQueue: 2452 }]);
  assert.equal(object.renderOrder, 2452);
});

test("missing renderQueue preserves the object's current order", () => {
  const object = { name: "Face", renderOrder: 17 };
  applyRenderQueue(object, [{ zWrite: 1 }, undefined]);
  assert.equal(object.renderOrder, 17);
});

test("one object cannot represent conflicting material queues", () => {
  const object = { name: "Eye", renderOrder: 0 };
  assert.throws(
    () => applyRenderQueue(object, [{ renderQueue: 2456 }, { renderQueue: 2457 }]),
    /Eye: conflicting renderQueue values 2456, 2457/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultPassObject,
  mergeRenderStates,
  resolveMaterialPasses,
} from "../src/shader-passes.js";

const shader = {
  name: "test",
  passes: [
    { id: "Forward", sections: { vertexPrelude: "COMMON" } },
    {
      id: "Outline",
      sections: { fragmentPrelude: ["COMMON_FRAGMENT", "OUTLINE_FRAGMENT"] },
      renderState: { cull: 1, blend: { srcRgb: 1, dstRgb: 0 } },
    },
  ],
};

test("material passes preserve declaration order and merge leaf render state", () => {
  const passes = resolveMaterialPasses(shader, {
    shaderParams: { Shared: 1 },
    textures: { MainTex: 0 },
    renderState: { zWrite: 1, blend: { srcAlpha: 5 } },
    passes: [
      { id: "Outline", shaderParams: { Width: 0.1 }, renderState: { cull: 2 } },
      { id: "Forward" },
    ],
  });

  assert.deepEqual(passes.map((pass) => pass.id), ["Outline", "Forward"]);
  assert.deepEqual(passes[0].shaderParams, { Shared: 1, Width: 0.1 });
  assert.deepEqual(passes[0].textures, { MainTex: 0 });
  assert.deepEqual(passes[0].renderState, {
    cull: 2,
    blend: { srcRgb: 1, dstRgb: 0, srcAlpha: 5 },
    zWrite: 1,
  });
});

test("unknown IDs, duplicate IDs, and null overrides fail closed", () => {
  assert.throws(
    () => resolveMaterialPasses(shader, { passes: [{ id: "Missing" }] }),
    /unknown Shader pass/,
  );
  assert.throws(
    () => resolveMaterialPasses(shader, { passes: [{ id: "Forward" }, { id: "Forward" }] }),
    /duplicate pass id/,
  );
  assert.throws(() => mergeRenderStates({ blend: null }), /cannot be null/);
  assert.throws(
    () => resolveMaterialPasses(shader, {
      passes: [{ id: "Forward", renderState: { renderQueue: 3000 } }],
    }),
    /renderQueue is material-wide/,
  );
});

test("a default additional pass reuses the mesh and synchronizes morphs without JS", () => {
  let attached = null;
  const parent = { add(object) { attached = object; object.parent = this; } };
  const mesh = {
    name: "Face",
    parent,
    morphTargetInfluences: [0.25, 0.75],
    clone() {
      return {
        morphTargetInfluences: [0, 0],
        onBeforeRender() {},
      };
    },
  };
  const material = {};
  const object = createDefaultPassObject(mesh, material, "Glow");

  assert.equal(object, attached);
  assert.equal(object.name, "Face_Glow");
  assert.equal(object.material, material);
  object.onBeforeRender();
  assert.deepEqual(object.morphTargetInfluences, [0.25, 0.75]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultPassObject,
  mergeRenderStates,
  resolveMaterialPasses,
  realizeMaterialPass,
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

test("material configuration precedes object creation and default passes retain morph synchronization", () => {
  const mesh = { name: "Face", visible: true, renderOrder: 2000,
    morphTargetInfluences: [.3], clone() { return { isObject3D: true, userData: {}, morphTargetInfluences: [0] }; } };
  const scope = { defaultPassObjects: [] };
  const material = {};
  const pass = { id: "Forward", renderState: {} };
  const calls = [];
  const runtimes = [{ configurePass() { material.ready = true; calls.push("configure"); } },
    { createPassObjects() { assert.equal(material.ready, true); calls.push("create"); return []; } }];
  const first = realizeMaterialPass(mesh, "fixture", material, pass, {}, runtimes, 0, true, scope);
  assert.equal(first.sourceMaterial, material);
  assert.deepEqual(first.objects, []);
  const extra = realizeMaterialPass(mesh, "fixture", material, { ...pass, id: "Outline" }, {}, runtimes, 1, false, scope);
  assert.equal(extra.sourceMaterial, null);
  assert.equal(extra.objects[0], scope.defaultPassObjects[0]);
  extra.objects[0].onBeforeRender();
  assert.deepEqual(extra.objects[0].morphTargetInfluences, [.3]);
  assert.deepEqual(calls, ["configure", "create", "configure", "create"]);
});

test("pass hooks enforce void configuration and one array-valued object provider", () => {
  const mesh = { isObject3D: true, visible: true, renderOrder: 2000 };
  const material = {};
  const object = { isObject3D: true, userData: {} };
  const realize = runtimes => realizeMaterialPass(mesh, "fixture", material,
    { id: "Outline", renderState: {} }, {}, runtimes, 1, true, { defaultPassObjects: [] });
  assert.throws(() => realize([{ configurePass: () => material }]), /must not return a value/);
  for (const result of [undefined, null, material, object]) {
    assert.throws(() => realize([{ createPassObjects: () => result }]), /must return Object3D\[\]/);
  }
  for (const result of [[object, object], [mesh], [{}]]) {
    assert.throws(() => realize([{ createPassObjects: () => result }]), /unique additional/);
  }
  assert.throws(() => realize([{ createPassObjects: () => [object] },
    { createPassObjects: () => [{ isObject3D: true, userData: {} }] }]), /multiple .* providers/);
  const result = realize([{ createPassObjects: () => [] }, { createPassObjects: () => [object] }]);
  assert.deepEqual(result.objects, [object]);
  assert.equal(result.sourceMaterial, null);
  assert.equal(object.userData.__parameterizedPassId, "Outline");
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

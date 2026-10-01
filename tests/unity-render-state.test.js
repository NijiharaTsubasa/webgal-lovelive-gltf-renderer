import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  applyRenderState,
  installUnityColorMaskSupport,
  unityColorMaskToChannels,
} from "../src/unity-render-state.js";

test("Unity stencil operations reach the fields consumed by Three and survive cloning", () => {
  const operations = [THREE.KeepStencilOp, THREE.ZeroStencilOp, THREE.ReplaceStencilOp,
    THREE.IncrementStencilOp, THREE.DecrementStencilOp, THREE.InvertStencilOp,
    THREE.IncrementWrapStencilOp, THREE.DecrementWrapStencilOp];
  for (const [value, expected] of operations.entries()) {
    const material = new THREE.MeshBasicMaterial();
    applyRenderState(material, { stencil: { ref: 201, comp: 8, pass: value, fail: value, zFail: value } });
    const clone = material.clone();
    for (const candidate of [material, clone]) {
      assert.equal(candidate.stencilZPass, expected, `StencilOp ${value}`);
      assert.equal(candidate.stencilFail, expected);
      assert.equal(candidate.stencilZFail, expected);
    }
    material.dispose(); clone.dispose();
  }
});

test("Unity BlendMode numeric values map to the corresponding three.js factors", () => {
  const expected = [
    THREE.ZeroFactor,
    THREE.OneFactor,
    THREE.DstColorFactor,
    THREE.SrcColorFactor,
    THREE.OneMinusDstColorFactor,
    THREE.SrcAlphaFactor,
    THREE.OneMinusSrcColorFactor,
    THREE.DstAlphaFactor,
    THREE.OneMinusDstAlphaFactor,
    THREE.SrcAlphaSaturateFactor,
    THREE.OneMinusSrcAlphaFactor,
  ];

  for (let value = 0; value < expected.length; value += 1) {
    const material = { userData: {} };
    applyRenderState(material, {
      surfaceType: 1,
      blend: { srcRgb: value, dstRgb: value, srcAlpha: value, dstAlpha: value },
    });
    assert.equal(material.blendSrc, expected[value]);
    assert.equal(material.blendDst, expected[value]);
    assert.equal(material.blendSrcAlpha, expected[value]);
    assert.equal(material.blendDstAlpha, expected[value]);
  }
});

test("Unity ColorWriteMask uses Alpha=1, Blue=2, Green=4, Red=8", () => {
  assert.deepEqual(unityColorMaskToChannels(1), [false, false, false, true]);
  assert.deepEqual(unityColorMaskToChannels(2), [false, false, true, false]);
  assert.deepEqual(unityColorMaskToChannels(4), [false, true, false, false]);
  assert.deepEqual(unityColorMaskToChannels(8), [true, false, false, false]);
  assert.deepEqual(unityColorMaskToChannels(14), [true, true, true, false]);
  assert.deepEqual(unityColorMaskToChannels(15), [true, true, true, true]);
});

test("renderer state applies partial masks and restores unmarked materials", () => {
  const calls = [];
  const state = {
    setMaterial(material) { calls.push(["base", material]); },
  };
  const renderer = {
    state,
    getContext() {
      return { colorMask: (...channels) => calls.push(channels) };
    },
  };
  installUnityColorMaskSupport(renderer);
  installUnityColorMaskSupport(renderer);

  const rgbOnly = { userData: {} };
  applyRenderState(rgbOnly, { colorMask: 14 });
  assert.equal(rgbOnly.colorWrite, true);
  state.setMaterial(rgbOnly);
  assert.deepEqual(calls.at(-1), [true, true, true, false]);

  state.setMaterial({ colorWrite: true, userData: {} });
  assert.deepEqual(calls.at(-1), [true, true, true, true]);

  state.setMaterial({ colorWrite: false, userData: {} });
  assert.deepEqual(calls.at(-1), [false, false, false, false]);
});

test("render state applies AlphaToMask and rejects invalid Unity masks", () => {
  const material = { userData: {}, alphaToCoverage: false };
  applyRenderState(material, { alphaToMask: 1 });
  assert.equal(material.alphaToCoverage, true);
  assert.throws(
    () => applyRenderState(material, { colorMask: 16 }),
    /Unsupported Unity ColorWriteMask: 16/,
  );
});

test("explicit Unity render queues interleave opaque and blended materials", () => {
  const eyeShadow = new THREE.MeshStandardMaterial();
  applyRenderState(eyeShadow, {
    renderQueue: 2454,
    surfaceType: 1,
    blend: { srcRgb: 5, dstRgb: 10 },
  });
  const eye = new THREE.MeshStandardMaterial();
  applyRenderState(eye, { renderQueue: 2456, surfaceType: 0 });

  assert.equal(eyeShadow.transparent, true);
  assert.equal(eyeShadow.blending, THREE.CustomBlending);
  assert.equal(eye.transparent, true);
  assert.equal(eye.blending, THREE.NoBlending);
  eyeShadow.dispose();
  eye.dispose();
});

test("explicit replace blending overrides glTF transparency without losing queue sorting", () => {
  const material = new THREE.MeshStandardMaterial({transparent:true});
  applyRenderState(material, {renderQueue:2456, blend:{srcRgb:1, dstRgb:0, srcAlpha:1, dstAlpha:0, opRgb:0, opAlpha:0}});
  assert.equal(material.transparent, true);
  assert.equal(material.blending, THREE.NoBlending);
});

test("opaque RGB does not discard a different alpha blend equation", () => {
  const material = new THREE.MeshStandardMaterial();
  applyRenderState(material, {renderQueue:2456, blend:{srcRgb:1, dstRgb:0, srcAlpha:0, dstAlpha:1}});
  assert.equal(material.blending, THREE.CustomBlending);
  assert.equal(material.blendSrcAlpha, THREE.ZeroFactor);
  assert.equal(material.blendDstAlpha, THREE.OneFactor);
});

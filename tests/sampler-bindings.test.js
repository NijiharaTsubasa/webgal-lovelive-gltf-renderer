import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  createGltfTextureBinding,
  resolveSamplerTextures,
  validateSamplerDescriptors,
} from "../src/sampler-bindings.js";

const constantSampler = (name, value) => ({
  name,
  type: "sampler2D",
  missing: { behavior: "constant", value },
});

test("missing normal maps resolve to an exact neutral tangent-space normal", async () => {
  const samplers = [constantSampler("NormalTex", [0.5, 0.5, 1.0, 1.0])];

  const resolved = await resolveSamplerTextures(samplers, {});

  assert.ok(resolved.NormalTex.isDataTexture);
  assert.deepEqual(Array.from(resolved.NormalTex.image.data), [0.5, 0.5, 1.0, 1.0]);
  assert.equal(resolved.NormalTex.type, THREE.FloatType);
  assert.equal(resolved.NormalTex.colorSpace, THREE.NoColorSpace);
});

test("a missing array sampler keeps array type and the declared constant layer", async () => {
  const sampler = {
    name: "CheekTex",
    type: "sampler2DArray",
    missing: { behavior: "constant", value: [1, 1, 1, 1] },
  };
  const resolved = await resolveSamplerTextures([sampler], {});
  assert.ok(resolved.CheekTex.isDataArrayTexture);
  assert.deepEqual(Array.from(resolved.CheekTex.image.data), [1, 1, 1, 1]);
  assert.equal(resolved.CheekTex.image.depth, 1);
  await assert.rejects(resolveSamplerTextures([sampler], { CheekTex: [] }), /at least one layer/);
  assert.throws(() => validateSamplerDescriptors([{
    name: "CheekTex",
    type: "sampler2DArray",
    missing: { behavior: "resource", uri: "cheek.png", colorSpace: "srgb" },
  }]), /array resource fallback/);
});

test("an actual material texture takes precedence over the missing policy", async () => {
  const actual = new THREE.Texture();
  actual.userData.colorSpace = "srgb";
  const samplers = [constantSampler("MainTex", [1, 1, 1, 1])];

  const resolved = await resolveSamplerTextures(samplers, { MainTex: actual });

  assert.equal(resolved.MainTex, actual);
  assert.equal(actual.colorSpace, THREE.SRGBColorSpace);
});

test("material texture color space is explicit and fail-closed", async () => {
  const sampler = constantSampler("RampTex", [0, 0, 0, 1]);
  const linear = new THREE.Texture();
  linear.userData.colorSpace = "linear";
  const linearResolved = await resolveSamplerTextures([sampler], { RampTex: linear });
  assert.equal(linearResolved.RampTex.colorSpace, THREE.NoColorSpace);

  await assert.rejects(
    resolveSamplerTextures([sampler], { RampTex: new THREE.Texture() }),
    /RampTex.*colorSpace/,
  );
  const invalid = new THREE.Texture();
  invalid.userData.colorSpace = "display-p3";
  await assert.rejects(
    resolveSamplerTextures([sampler], { RampTex: invalid }),
    /RampTex.*colorSpace/,
  );
});

test("glTF texture metadata overrides image metadata on isolated runtime bindings", async () => {
  const loaderTexture = new THREE.Texture();
  loaderTexture.userData = { colorSpace: "image-level-value", mimeType: "image/png" };

  const srgb = createGltfTextureBinding(loaderTexture, { extras: { colorSpace: "srgb" } });
  const linear = createGltfTextureBinding(loaderTexture, { extras: { colorSpace: "linear" } });
  const missing = createGltfTextureBinding(loaderTexture, {});

  assert.notEqual(srgb, loaderTexture);
  assert.notEqual(linear, srgb);
  assert.equal(srgb.userData.colorSpace, "srgb");
  assert.equal(linear.userData.colorSpace, "linear");
  assert.equal(Object.hasOwn(missing.userData, "colorSpace"), false);
  assert.equal(missing.userData.mimeType, "image/png");

  const sampler = constantSampler("MainTex", [1, 1, 1, 1]);
  assert.equal((await resolveSamplerTextures([sampler], { MainTex: srgb })).MainTex.colorSpace, THREE.SRGBColorSpace);
  assert.equal((await resolveSamplerTextures([sampler], { MainTex: linear })).MainTex.colorSpace, THREE.NoColorSpace);
  await assert.rejects(
    resolveSamplerTextures([sampler], { MainTex: missing }),
    /MainTex.*colorSpace/,
  );
});

test("an invalid declared texture is an error rather than a missing texture", async () => {
  const samplers = [constantSampler("MainTex", [1, 1, 1, 1])];

  await assert.rejects(
    resolveSamplerTextures(samplers, { MainTex: null }),
    /MainTex.*valid texture/,
  );
});

test("error and resource missing behaviors are resolved explicitly", async () => {
  await assert.rejects(
    resolveSamplerTextures([
      { name: "RequiredTex", type: "sampler2D", missing: { behavior: "error" } },
    ], {}),
    /RequiredTex.*required/,
  );

  const fallback = new THREE.Texture();
  const resourceSampler = {
    name: "RampTex",
    type: "sampler2D",
    missing: { behavior: "resource", uri: "defaults/ramp.png", colorSpace: "srgb" },
  };
  const resolved = await resolveSamplerTextures(
    [resourceSampler],
    {},
    async (uri) => {
      assert.equal(uri, "defaults/ramp.png");
      return fallback;
    },
  );
  assert.equal(resolved.RampTex, fallback);
  assert.equal(fallback.colorSpace, THREE.SRGBColorSpace);
});

test("sampler descriptors fail closed on unsupported or ambiguous input", () => {
  assert.throws(() => validateSamplerDescriptors(["MainTex"]), /descriptor/);
  assert.throws(() => validateSamplerDescriptors([
    { name: "MainTex", type: "samplerCube", missing: { behavior: "error" } },
  ]), /samplerCube/);
  assert.throws(() => validateSamplerDescriptors([
    { name: "MainTex", type: "sampler2D", missing: { behavior: "constant", value: [1, 1, 1] } },
  ]), /four finite/);
  assert.throws(() => validateSamplerDescriptors([
    { name: "MainTex", type: "sampler2D", missing: { behavior: "resource", uri: "../outside.png" } },
  ]), /package-relative/);
  assert.throws(() => validateSamplerDescriptors([
    { name: "MainTex", type: "sampler2D", missing: { behavior: "resource", uri: "defaults/main.png" } },
  ]), /colorSpace/);
});

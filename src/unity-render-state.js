import * as THREE from "three";

// Unity _CullMode: 0 = Off (DoubleSide), 1 = Front (render back faces), 2 =
// Back (render front faces). three.js naming describes the rendered side, so
// Unity Front maps to THREE.BackSide and Unity Back to THREE.FrontSide.
function unityCullToSide(cull) {
  if (cull === 0) return THREE.DoubleSide;
  if (cull === 1) return THREE.BackSide;
  if (cull === 2) return THREE.FrontSide;
  throw new Error(`Unsupported Unity cull mode: ${cull}`);
}

function unityZTestToDepthFunc(zTest) {
  const depth = zTest === 1 ? THREE.NeverDepth
    : zTest === 2 ? THREE.LessDepth
    : zTest === 3 ? THREE.EqualDepth
    : zTest === 4 ? THREE.LessEqualDepth
    : zTest === 5 ? THREE.GreaterDepth
    : zTest === 6 ? THREE.NotEqualDepth
    : zTest === 7 ? THREE.GreaterEqualDepth
    : zTest === 8 ? THREE.AlwaysDepth
    : undefined;
  if (depth === undefined) throw new Error(`Unsupported Unity ZTest: ${zTest}`);
  return depth;
}

// UnityEngine.Rendering.BlendMode. Keep these numeric values identical to
// Unity; compiled ShaderLab state stores the enum value, not the enum name.
const UNITY_BLEND_TO_THREE = {
  0: THREE.ZeroFactor,
  1: THREE.OneFactor,
  2: THREE.DstColorFactor,
  3: THREE.SrcColorFactor,
  4: THREE.OneMinusDstColorFactor,
  5: THREE.SrcAlphaFactor,
  6: THREE.OneMinusSrcColorFactor,
  7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor,
  9: THREE.SrcAlphaSaturateFactor,
  10: THREE.OneMinusSrcAlphaFactor,
};

const UNITY_BLEND_OP_TO_THREE = {
  0: THREE.AddEquation,
  1: THREE.SubtractEquation,
  2: THREE.ReverseSubtractEquation,
  3: THREE.MinEquation,
  4: THREE.MaxEquation,
};

function unityCompareToStencilFunc(val) {
  const func = val === 1 ? THREE.NeverStencilFunc
    : val === 2 ? THREE.LessStencilFunc
    : val === 3 ? THREE.EqualStencilFunc
    : val === 4 ? THREE.LessEqualStencilFunc
    : val === 5 ? THREE.GreaterStencilFunc
    : val === 6 ? THREE.NotEqualStencilFunc
    : val === 7 ? THREE.GreaterEqualStencilFunc
    : val === 8 ? THREE.AlwaysStencilFunc
    : undefined;
  if (func === undefined) throw new Error(`Unsupported Unity stencil comparison: ${val}`);
  return func;
}

function unityStencilOpToThree(val) {
  const operation = val === 0 ? THREE.KeepStencilOp
    : val === 1 ? THREE.ZeroStencilOp
    : val === 2 ? THREE.ReplaceStencilOp
    : val === 3 ? THREE.IncrementStencilOp
    : val === 4 ? THREE.DecrementStencilOp
    : val === 5 ? THREE.InvertStencilOp
    : val === 6 ? THREE.IncrementWrapStencilOp
    : val === 7 ? THREE.DecrementWrapStencilOp
    : undefined;
  if (operation === undefined) throw new Error(`Unsupported Unity stencil operation: ${val}`);
  return operation;
}

function mappedRenderState(table, value, label) {
  const mapped = table[value];
  if (mapped === undefined) throw new Error(`Unsupported Unity ${label}: ${value}`);
  return mapped;
}

function validateUnityColorMask(mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 15) {
    throw new Error(`Unsupported Unity ColorWriteMask: ${mask}`);
  }
  return mask;
}

// UnityEngine.Rendering.ColorWriteMask uses A=1, B=2, G=4, R=8.
export function unityColorMaskToChannels(mask) {
  validateUnityColorMask(mask);
  return [
    (mask & 8) !== 0,
    (mask & 4) !== 0,
    (mask & 2) !== 0,
    (mask & 1) !== 0,
  ];
}

const COLOR_MASK_PATCH = Symbol.for("model-convert.unity-color-write-mask");

// three.js Material.colorWrite is all-or-none. Patch the public renderer state
// boundary so every draw applies Unity's four-channel mask after three.js has
// applied the rest of the material state. Unmarked materials are explicitly
// restored because three.js's boolean state cache cannot observe raw masks.
export function installUnityColorMaskSupport(renderer) {
  const state = renderer?.state;
  const gl = renderer?.getContext?.();
  if (!state || typeof state.setMaterial !== "function" || typeof gl?.colorMask !== "function") {
    throw new Error("Unity ColorWriteMask requires a three.js WebGLRenderer");
  }
  if (state[COLOR_MASK_PATCH]) return;

  const originalSetMaterial = state.setMaterial;
  state.setMaterial = function setMaterialWithUnityColorMask(material, ...args) {
    const result = originalSetMaterial.call(this, material, ...args);
    const storedMask = material?.userData?.__unityColorWriteMask;
    const mask = storedMask === undefined ? (material?.colorWrite === false ? 0 : 15) : storedMask;
    gl.colorMask(...unityColorMaskToChannels(mask));
    return result;
  };
  state[COLOR_MASK_PATCH] = true;
}

// Apply extras.renderState to a three.js material. All fields are optional;
// absent fields preserve the material's current value.
export function applyRenderState(material, rs) {
  if (!rs) return;

  if (rs.surfaceType !== undefined && rs.surfaceType > 0.5) {
    material.transparent = true;
  }

  if (rs.zWrite !== undefined) {
    material.depthWrite = rs.zWrite !== 0;
  }

  if (rs.zTest !== undefined) {
    material.depthTest = rs.zTest !== 0;
    if (material.depthTest) material.depthFunc = unityZTestToDepthFunc(rs.zTest);
  }

  if (rs.cull !== undefined) {
    material.side = unityCullToSide(rs.cull);
  }

  if (rs.alphaToMask !== undefined) {
    material.alphaToCoverage = rs.alphaToMask !== 0;
  }

  if (rs.offset) {
    material.polygonOffset = true;
    if (rs.offset.factor !== undefined) material.polygonOffsetFactor = rs.offset.factor;
    if (rs.offset.units !== undefined) material.polygonOffsetUnits = rs.offset.units;
  }

  if (rs.colorMask !== undefined) {
    const mask = validateUnityColorMask(rs.colorMask);
    material.userData ||= {};
    material.userData.__unityColorWriteMask = mask;
    material.colorWrite = mask !== 0;
  }

  if (rs.blend) {
    const b = rs.blend;
    if (b.srcRgb !== undefined && b.dstRgb !== undefined) {
      const isOpaqueBlend = b.srcRgb === 1 && b.dstRgb === 0 &&
        (b.srcAlpha ?? 1) === 1 && (b.dstAlpha ?? 0) === 0 &&
        (b.opRgb ?? 0) === 0 && (b.opAlpha ?? 0) === 0;
      if (isOpaqueBlend && !(rs.surfaceType > 0.5)) {
        material.blending = THREE.NoBlending;
      } else {
        material.blending = THREE.CustomBlending;
        material.blendSrc = mappedRenderState(UNITY_BLEND_TO_THREE, b.srcRgb, "source blend factor");
        material.blendDst = mappedRenderState(UNITY_BLEND_TO_THREE, b.dstRgb, "destination blend factor");
        if (b.srcAlpha !== undefined) material.blendSrcAlpha = mappedRenderState(UNITY_BLEND_TO_THREE, b.srcAlpha, "source alpha blend factor");
        if (b.dstAlpha !== undefined) material.blendDstAlpha = mappedRenderState(UNITY_BLEND_TO_THREE, b.dstAlpha, "destination alpha blend factor");
        if (b.opRgb !== undefined) material.blendEquation = mappedRenderState(UNITY_BLEND_OP_TO_THREE, b.opRgb, "RGB blend operation");
        if (b.opAlpha !== undefined) material.blendEquationAlpha = mappedRenderState(UNITY_BLEND_OP_TO_THREE, b.opAlpha, "alpha blend operation");
      }
    }
  }

  if (rs.stencil) {
    const s = rs.stencil;
    material.stencilWrite = true;
    if (s.ref !== undefined) material.stencilRef = s.ref;
    if (s.readMask !== undefined) material.stencilFuncMask = s.readMask;
    if (s.writeMask !== undefined) material.stencilWriteMask = s.writeMask;
    if (s.comp !== undefined) material.stencilFunc = unityCompareToStencilFunc(s.comp);
    if (s.pass !== undefined) material.stencilZPass = unityStencilOpToThree(s.pass);
    if (s.fail !== undefined) material.stencilFail = unityStencilOpToThree(s.fail);
    if (s.zFail !== undefined) material.stencilZFail = unityStencilOpToThree(s.zFail);
  }

  // Three sorts opaque and transparent draws in separate lists regardless of
  // renderOrder. Unity's renderQueue interleaves them: an alpha-blended mesh at
  // 2454 must draw before an opaque mesh at 2456. Put every explicitly queued
  // material in Three's transparent list, but retain opaque blending semantics.
  if (rs.renderQueue !== undefined && !material.transparent) {
    if (material.blending !== THREE.CustomBlending) material.blending = THREE.NoBlending;
    material.transparent = true;
  }
}

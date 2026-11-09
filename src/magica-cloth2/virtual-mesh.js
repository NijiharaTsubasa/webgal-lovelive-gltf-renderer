// MagicaCloth2 proxy / mapping mesh updates (Manager/VirtualMesh/VirtualMeshManager.cs, v2.16.0):
// SimulationPreProxyMeshUpdate, SimulationPostProxyMeshUpdate{Line,Triangle,TriangleSum,WorldTransform,
// LocalTransform} and CalcMeshConvert_A/B_Job (MeshCloth render-mesh mapping).  Negative scale is not supported,
// so every negativeScale* factor of the source is 1.
import * as M from "./math.js";
import { isMove, isFixed, isInvalid } from "./simulation.js";

/** SimulationPreProxyMeshUpdate: skin the proxy vertices with the proxy transforms' localToWorld matrices. */
export function preProxyMeshUpdate(s, proxy, transformMatrices) {
  // localToWorld * bindPose once per skin bone (the source multiplies per vertex and weight: same result)
  const skin = proxy.skinBoneBindPoses.map((bp, b) => M.m4mul(transformMatrices[proxy.skinBoneTransformIndices[b]], bp));
  for (let v = 0; v < proxy.count; v++) {
    const bw = proxy.boneWeights[v];
    const [px, py, pz] = proxy.localPositions[v], [nx, ny, nz] = proxy.localNormals[v], [tx, ty, tz] = proxy.localTangents[v];
    let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
    const wcnt = weightCount(bw);
    for (let i = 0; i < wcnt; i++) {
      const w = bw.w[i], m = skin[bw.i[i]];
      x += (m[0] * px + m[4] * py + m[8] * pz + m[12]) * w; y += (m[1] * px + m[5] * py + m[9] * pz + m[13]) * w; z += (m[2] * px + m[6] * py + m[10] * pz + m[14]) * w;
      a += (m[0] * nx + m[4] * ny + m[8] * nz) * w; b += (m[1] * nx + m[5] * ny + m[9] * nz) * w; c += (m[2] * nx + m[6] * ny + m[10] * nz) * w;
      d += (m[0] * tx + m[4] * ty + m[8] * tz) * w; e += (m[1] * tx + m[5] * ty + m[9] * tz) * w; f += (m[2] * tx + m[6] * ty + m[10] * tz) * w;
    }
    s.positions[v] = [x, y, z];
    s.rotations[v] = M.toRotation(M.normalize([a, b, c]), M.normalize([d, e, f]));
  }
}
// rotation matrix (row-major 3x3) of a unit quaternion
function qmat(q) {
  const [x, y, z, w] = q, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)];
}
// VirtualMeshBoneWeight.Count: index of the last positive weight + 1
export function weightCount(bw) {
  for (let i = 3; i >= 0; i--) if (bw.w[i] > 0) return i + 1;
  return 0;
}

/** SimulationPostProxyMeshUpdateLine: rotations along base lines from the simulated child directions. */
export function postProxyLine(s, proxy, params) {
  const { flags, start, count, data } = proxy.baseLine;
  const averageRate = params.rotationalInterpolation, rootInterpolation = params.rootRotation;
  for (let b = 0; b < flags.length; b++) {
    if ((flags[b] & 0x01) === 0) continue;   // BaseLineFlag_IncludeLine
    for (let i = 0; i < count[b]; i++) {
      const v = data[start[b] + i];
      const pos = s.positions[v];
      let rot = s.rotations[v];
      const attr = s.attr[v];
      const pack = proxy.childIndex[v], cstart = pack & 0xfffff, ccnt = (pack >>> 20) & 0xfff;
      if (ccnt === 0) continue;
      let ctv = [0, 0, 0], cv = [0, 0, 0], movecnt = 0;
      for (let j = 0; j < ccnt; j++) {
        const c = proxy.childData[cstart + j];
        const cpos = s.positions[c];
        const tv = M.rotate(rot, proxy.vertexLocalPositions[c]);
        ctv = M.add(ctv, tv);
        if (isMove(s.attr[c])) {
          const d = M.sub(cpos, pos);
          cv = M.add(cv, d);
          const q = M.fromToRotation(tv, d);
          s.rotations[c] = M.qmul(q, M.qmul(rot, proxy.vertexLocalRotations[c]));
          movecnt++;
        } else cv = M.add(cv, tv);
      }
      if (movecnt === 0) continue;
      const t = isMove(attr) ? averageRate : rootInterpolation;
      rot = M.qmul(M.fromToRotation(ctv, cv, t), rot);
      s.rotations[v] = rot;
    }
  }
}

/** SimulationPostProxyMeshUpdateTriangle + TriangleSum: vertex rotations from the simulated triangle normals. */
export function postProxyTriangles(s, proxy) {
  const tris = proxy.triangles, ntri = tris.length / 3;
  if (!ntri) return;
  const nor = s.triNormals ??= Array.from({ length: ntri }, () => [0, 0, 0]);
  const tan = s.triTangents ??= Array.from({ length: ntri }, () => [0, 0, 0]);
  for (let t = 0; t < ntri; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const p1 = s.positions[a], p2 = s.positions[b], p3 = s.positions[c];
    const cr = M.cross(M.sub(p2, p1), M.sub(p3, p1)), len = M.length(cr);
    if (len > M.EPSILON) nor[t] = M.mul(cr, 1 / len);     // (else: keep the previous value, like the source)
    const tg = M.triangleTangent(p1, p2, p3, proxy.uv[a], proxy.uv[b], proxy.uv[c]);
    if (M.lengthsq(tg) > 0) tan[t] = tg;
  }
  for (let v = 0; v < proxy.count; v++) {
    const list = proxy.vertexToTriangles[v];
    if (!list.length) continue;
    let n = [0, 0, 0], g = [0, 0, 0];
    for (const data of list) {
      const flip = (data >>> 20) & 0xfff, t = data & 0xfffff;
      n = M.add(n, M.mul(nor[t], (flip & 1) === 0 ? 1 : -1));
      g = M.add(g, M.mul(tan[t], (flip & 2) === 0 ? 1 : -1));
    }
    const ln = M.length(n), lt = M.length(g);
    if (ln > 1e-6 && lt > 1e-6) {
      n = M.mul(n, 1 / ln); g = M.mul(g, 1 / lt);
      const d = M.dot(n, g);
      if (d !== 1 && d !== -1) {
        const binor = M.normalize(M.cross(n, g));
        s.rotations[v] = M.qmul(M.lookRotation(binor, n), proxy.normalAdjustmentRotations[v]);
      }
    }
  }
}

/**
 * BoneCloth write-back (PostProxyMeshUpdateWorldTransform + LocalTransform, TransformManager.WriteTransformJob):
 * -> per proxy vertex { worldRotation } for fixed bones, { localPosition, localRotation } for moving bones.
 * `transformScales` = lossy scale of each proxy transform.
 */
export function boneClothOutput(s, proxy, transformScales) {
  const wpos = new Array(proxy.count), wrot = new Array(proxy.count), out = new Array(proxy.count);
  for (let v = 0; v < proxy.count; v++) {
    wpos[v] = s.positions[v];
    wrot[v] = M.qmul(s.rotations[v], proxy.vertexToTransformRotations[v]);
  }
  for (let v = 0; v < proxy.count; v++) {
    const attr = s.attr[v], p = proxy.parent[v];
    if (isMove(attr)) {
      if (p < 0) { out[v] = null; continue; }
      const iprot = M.qinverse(wrot[p]);
      out[v] = { localPosition: M.divv(M.rotate(iprot, M.sub(wpos[v], wpos[p])), transformScales[p]), localRotation: M.qmul(iprot, wrot[v]) };
    } else if (isFixed(attr)) out[v] = { worldRotation: wrot[v] };
    else out[v] = null;
  }
  return out;
}

/**
 * CalcMeshConvert_A/B: world-space render vertices of one mapping mesh.  `center` = world pose of the mapping
 * center transform, `proxyCenter` = world pose of the proxy center transform ({position, rotation, scale}).
 * Returns { positions, normals, tangents } indexed like referenceIndices (null for fixed / invalid vertices).
 */
export function mappingWorld(s, proxy, mapping, center, proxyCenter, initScale, useTangent = true) {
  // MathUtility.CompareTransform: exact equality of position, rotation and scale
  const same = (a, b) => a.every((x, i) => x === b[i]);
  const sameSpace = same(center.position, proxyCenter.position) && same(center.rotation, proxyCenter.rotation)
    && same(center.scale, proxyCenter.scale);
  const scaleRatio = M.length(proxyCenter.scale) / M.length(initScale);
  const proxyScl = M.mul(initScale, scaleRatio);
  const n = mapping.attr.length;
  // mapping vertices in proxy space (toProxyMatrix is constant data: transformed once and cached)
  const local = sameSpace ? (mapping._local ??= localFrames(mapping, null)) : (mapping._proxyLocal ??= localFrames(mapping, mapping.toProxyMatrix));
  // per proxy vertex: pos = prot * (proxyScl * (birot * (p0 + bipos))) + ppos = A p0 + b,  dir = Rot(prot * birot) d0
  const A = new Array(proxy.count), B = new Array(proxy.count), N = new Array(proxy.count);
  const used = mapping._usedProxy ??= [...new Set(mapping.boneWeights.flatMap((bw) => bw.i.slice(0, weightCount(bw))))];
  for (const tv of used) {
    const r1 = qmat(s.rotations[tv]), r2 = qmat(proxy.vertexBindPoseRotations[tv]);
    const a = new Array(9), nm = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let sa = 0, sn = 0;
      for (let k = 0; k < 3; k++) { sa += r1[r * 3 + k] * proxyScl[k] * r2[k * 3 + c]; sn += r1[r * 3 + k] * r2[k * 3 + c]; }
      a[r * 3 + c] = sa; nm[r * 3 + c] = sn;
    }
    const [bx, by, bz] = proxy.vertexBindPosePositions[tv], p = s.positions[tv];
    A[tv] = a; N[tv] = nm;
    B[tv] = [a[0] * bx + a[1] * by + a[2] * bz + p[0], a[3] * bx + a[4] * by + a[5] * bz + p[1], a[6] * bx + a[7] * by + a[8] * bz + p[2]];
  }
  const positions = new Array(n), normals = new Array(n), tangents = new Array(n);
  for (let k = 0; k < n; k++) {
    const attr = mapping.attr[k];
    if (isInvalid(attr) || isFixed(attr)) { positions[k] = normals[k] = tangents[k] = null; continue; }
    const [px, py, pz] = local.p[k], [nx, ny, nz] = local.n[k], [tx, ty, tz] = useTangent ? local.t[k] : [0, 0, 0];
    const bw = mapping.boneWeights[k], wcnt = weightCount(bw);
    let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
    for (let i = 0; i < wcnt; i++) {
      const w = bw.w[i], tv = bw.i[i], m = A[tv], q = N[tv], o = B[tv];
      x += (m[0] * px + m[1] * py + m[2] * pz + o[0]) * w; y += (m[3] * px + m[4] * py + m[5] * pz + o[1]) * w; z += (m[6] * px + m[7] * py + m[8] * pz + o[2]) * w;
      a += (q[0] * nx + q[1] * ny + q[2] * nz) * w; b += (q[3] * nx + q[4] * ny + q[5] * nz) * w; c += (q[6] * nx + q[7] * ny + q[8] * nz) * w;
      d += (q[0] * tx + q[1] * ty + q[2] * tz) * w; e += (q[3] * tx + q[4] * ty + q[5] * tz) * w; f += (q[6] * tx + q[7] * ty + q[8] * tz) * w;
    }
    positions[k] = [x, y, z];
    normals[k] = M.normalize([a, b, c]);
    tangents[k] = useTangent ? M.normalize([d, e, f]) : null;
  }
  return { positions, normals, tangents };
}
function localFrames(mapping, matrix) {
  if (!matrix) return { p: mapping.localPositions, n: mapping.localNormals, t: mapping.localTangents };
  return { p: mapping.localPositions.map((v) => M.m4point(matrix, v)), n: mapping.localNormals.map((v) => M.m4vector(matrix, v)),
    t: mapping.localTangents.map((v) => M.m4vector(matrix, v)) };
}

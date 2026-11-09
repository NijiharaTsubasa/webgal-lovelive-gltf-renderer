import * as THREE from "three";

/** Weld only vertices with the same position AND skin binding (UV seams). */
export function clothTopology(geometry, fixed) {
  const position = geometry.getAttribute("position");
  const joints = geometry.getAttribute("skinIndex");
  const weights = geometry.getAttribute("skinWeight");
  if (!position || !joints || !weights) throw new Error("cloth 需要蒙皮 POSITION 数据");
  if (!Array.isArray(fixed) || !fixed.length || fixed.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= position.count)) {
    throw new Error("cloth fixed 需要有效的 POSITION 顶点索引");
  }
  const count = geometry.index?.count ?? position.count;
  if (count % 3) throw new Error("cloth 需要三角形拓扑");
  const used = new Set(Array.from({ length: count }, (_, i) => geometry.index ? geometry.index.getX(i) : i));
  if ([...used].some((i) => !Number.isSafeInteger(i) || i < 0 || i >= position.count)) throw new Error("cloth 三角形索引越界");
  if (fixed.some((i) => !used.has(i))) throw new Error("cloth fixed 顶点未被 primitive 使用");
  const weld = new Map(), vertices = [], mapping = new Int32Array(position.count).fill(-1);
  for (let i = 0; i < position.count; i += 1) {
    if (!used.has(i)) continue;
    const key = [position.getX(i), position.getY(i), position.getZ(i)].map((v) => v.toFixed(6))
      .concat(Array.from({ length: 4 }, (_, k) => `${joints.getComponent(i, k)}:${weights.getComponent(i, k).toFixed(7)}`))
      .concat((geometry.morphAttributes.position ?? []).flatMap((m) => [m.getX(i), m.getY(i), m.getZ(i)].map((v) => v.toFixed(6)))).join(",");
    let node = weld.get(key);
    if (node === undefined) { node = vertices.length; weld.set(key, node); vertices.push(i); }
    mapping[i] = node;
  }
  const indices = [];
  for (let i = 0; i < count; i += 3) {
    const tri = [0, 1, 2].map((k) => mapping[geometry.index ? geometry.index.getX(i + k) : i + k]);
    if (new Set(tri).size === 3) indices.push(...tri);
  }
  if (!indices.length) throw new Error("cloth 没有有效三角形");
  return { vertices, mapping, indices, fixed: new Set(fixed.map((i) => mapping[i])) };
}

/** Same linear blend used by Three's skinning_vertex, before matrixWorld. */
export function vertexSkinMatrix(mesh, index, target = new THREE.Matrix4(), palette) {
  const joints = mesh.geometry.getAttribute("skinIndex");
  const weights = mesh.geometry.getAttribute("skinWeight");
  target.elements.fill(0);
  const bone = new THREE.Matrix4();
  for (let k = 0; k < 4; k += 1) {
    const weight = weights.getComponent(index, k);
    if (!weight) continue;
    const joint = joints.getComponent(index, k);
    if (palette) bone.copy(palette[joint]);
    else bone.multiplyMatrices(mesh.skeleton.bones[joint].matrixWorld, mesh.skeleton.boneInverses[joint]);
    for (let j = 0; j < 16; j += 1) target.elements[j] += weight * bone.elements[j];
  }
  return target.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
}

export function primitiveMesh(node, primitive) {
  const meshes = node.isMesh ? [node] : node.children.filter((child) => child.isMesh);
  const mesh = meshes[primitive];
  if (!mesh?.isSkinnedMesh) throw new Error(`cloth primitive ${primitive} 不是 SkinnedMesh`);
  return mesh;
}

export function morphTerms(mesh, index, attribute, sum) {
  sum.set(0, 0, 0);
  let total = 0;
  const targets = mesh.geometry.morphAttributes[attribute] ?? [];
  for (let i = 0; i < targets.length; i += 1) {
    const weight = mesh.morphTargetInfluences?.[i] ?? 0;
    if (!weight) continue;
    total += weight;
    sum.x += targets[i].getX(index) * weight;
    sum.y += targets[i].getY(index) * weight;
    sum.z += targets[i].getZ(index) * weight;
  }
  const base = mesh.geometry.morphTargetsRelative ? 1 : 1 - total;
  if (Math.abs(base) < 1e-8) throw new Error("cloth 无法写回完全替代基础网格的绝对 Morph");
  return base;
}


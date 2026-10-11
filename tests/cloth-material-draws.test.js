import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createMeshCloth } from '../src/mesh-cloth.js';

test('repeated material primitives share one cloth deformation and restore together', async () => {
  const chunks = [], bufferViews = [], accessors = [];
  let size = 0;
  function attribute(values, componentType, type, count, extra = {}) {
    const padding = (4 - size % 4) % 4;
    chunks.push(Buffer.alloc(padding)); size += padding;
    bufferViews.push({ buffer: 0, byteOffset: size, byteLength: values.byteLength });
    chunks.push(Buffer.from(values.buffer)); size += values.byteLength;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, type, count, ...extra });
    return accessors.length - 1;
  }
  const position = attribute(new Float32Array([-1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1, 0]),
    5126, 'VEC3', 4, { min: [-1, -1, 0], max: [1, 1, 0] });
  const normal = attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 5126, 'VEC3', 4);
  const joints = attribute(new Uint16Array(16), 5123, 'VEC4', 4);
  const weights = attribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 5126, 'VEC4', 4);
  const indices = attribute(new Uint16Array([0, 2, 1, 1, 2, 3]), 5123, 'SCALAR', 6);
  const primitive = { attributes: { POSITION: position, NORMAL: normal, JOINTS_0: joints, WEIGHTS_0: weights }, indices };
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, skin: 0 }, { name: 'cloth-bone' }], skins: [{ joints: [1] }],
    meshes: [{ primitives: [{ ...primitive, material: 0 }, { ...primitive, material: 1 }] }],
    materials: [{ name: 'base' }, { name: 'repeated-draw' }], accessors, bufferViews,
    buffers: [{ byteLength: size, uri: `data:application/octet-stream;base64,${Buffer.concat(chunks).toString('base64')}` }],
  };
  const oldProgressEvent = globalThis.ProgressEvent;
  globalThis.ProgressEvent ??= class extends Event { constructor(type, values) { super(type); Object.assign(this, values); } };
  let gltf;
  try { gltf = await new GLTFLoader().parseAsync(JSON.stringify(document), ''); }
  finally { if (oldProgressEvent === undefined) delete globalThis.ProgressEvent; }
  const node = await gltf.parser.getDependency('node', 0);
  const [base, repeated] = node.children;
  assert.equal(base.geometry, repeated.geometry, 'material-only repetitions must share geometry');
  const geometry = base.geometry, originalPosition = geometry.getAttribute('position'), originalNormal = geometry.getAttribute('normal');
  gltf.scene.updateMatrixWorld(true);
  const physics = { springs: [], colliders: [], cloths: [{ node: 0, primitive: 0,
    fixed: [0, 1], radius: .003, stiffness: 12, damping: .8, gravity: [0, 0, 3], colliders: [] }] };
  const cloth = await createMeshCloth(gltf.scene, [{ physics, resolve: () => node }]);
  try {
    assert.equal(cloth.records.length, 1, 'a repeated draw must not get a second solver');
    for (let i = 0; i < 30; i++) { cloth.beforeAnimation(); gltf.scene.updateMatrixWorld(true); cloth.update(1 / 60); }
    assert.ok(base.geometry.getAttribute('position').getZ(2) > .001, 'the cloth must actually deform');
    assert.equal(base.geometry.getAttribute('position'), repeated.geometry.getAttribute('position'));
    assert.equal(base.geometry.getAttribute('normal'), repeated.geometry.getAttribute('normal'));
  } finally { cloth.destroy(); }
  assert.equal(repeated.geometry.getAttribute('position'), originalPosition);
  assert.equal(repeated.geometry.getAttribute('normal'), originalNormal);
});

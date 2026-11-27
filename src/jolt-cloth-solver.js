import initializeJolt from "./vendor/jolt/jolt-physics.wasm.js";

const ITERATIONS = 5;
let compiledPromise;
let modulePromise;

// Jolt Vec3::Set duplicates z into its fourth SIMD lane. Float3 references
// below deliberately use only three stores instead of this helper.
function writeVec3(heap, index, x, y, z) {
  heap[index] = x; heap[index + 1] = y;
  heap[index + 2] = z; heap[index + 3] = z;
}

async function loadJolt() {
  if (!compiledPromise) compiledPromise = (async () => {
    const url = new URL("./vendor/jolt/jolt-physics.wasm.wasm", import.meta.url);
    let wasmBinary;
    if (typeof document === "undefined") {
      const name = "node:fs/promises";
      wasmBinary = await (await import(/* @vite-ignore */ name)).readFile(url);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法加载布料 WASM: HTTP ${response.status}`);
      wasmBinary = await response.arrayBuffer();
    }
    return WebAssembly.compile(wasmBinary);
  })().catch((error) => { compiledPromise = undefined; throw error; });
  const compiled = await compiledPromise;
  if (!modulePromise) modulePromise = initializeJolt({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiled, imports);
      receive(instance, compiled);
      return instance.exports;
    },
  }).catch((error) => { modulePromise = undefined; throw error; });
  return modulePromise;
}

let activeWorld;
function acquireWorld(J) {
  if (!activeWorld) {
    const settings = new J.JoltSettings();
    settings.mMaxWorkerThreads = 0;
    const pairFilter = new J.ObjectLayerPairFilterTable(2);
    pairFilter.EnableCollision(0, 1);
    const broadPhase = new J.BroadPhaseLayerInterfaceTable(2, 2);
    for (let i = 0; i < 2; i++) {
      const layer = new J.BroadPhaseLayer(i);
      broadPhase.MapObjectToBroadPhaseLayer(i, layer); J.destroy(layer);
    }
    settings.mObjectLayerPairFilter = pairFilter;
    settings.mBroadPhaseLayerInterface = broadPhase;
    settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(broadPhase, 2, pairFilter, 2);
    let world;
    try { world = new J.JoltInterface(settings); } finally { J.destroy(settings); }
    const system = world.GetPhysicsSystem();
    const bodyInterface = system.GetBodyInterface();

    const zero = new J.Vec3(0, 0, 0);
    try { system.SetGravity(zero); } finally { J.destroy(zero); }
    activeWorld = { world, system, bodyInterface, users: 0 };
  }
  activeWorld.users++;
  return activeWorld;
}

function releaseWorld(J, state) {
  if (--state.users === 0) {
    J.destroy(state.world);
    activeWorld = undefined;
  }
}

/** Jolt owns constraints and collision response; coordinates are world metres. */
export async function createJoltClothSolver({ positions, indices, fixed, radius, damping, colliders }) {
  const J = await loadJolt();
  const owned = [], colliderRecords = [], bodies = [];
  let worldState, filter, bodyInterface, shared, motion, vertices, edges, disposed = false;
  const output = positions.map((v) => v.clone());
  const own = (value) => { owned.push(value); return value; };
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    for (const body of bodies) {
      const id = body.GetID();
      if (bodyInterface.IsAdded(id)) bodyInterface.RemoveBody(id);
      bodyInterface.DestroyBody(id);
    }
    bodies.length = 0;
    // Keep an explicit reference until all bodies have released their settings.
    if (shared) { shared.Release(); shared = undefined; }
    for (const object of owned.reverse()) J.destroy(object);
    owned.length = 0;
    if (filter) { filter.Release(); filter = undefined; }
    if (worldState) { releaseWorld(J, worldState); worldState = undefined; }
    colliderRecords.length = 0;
    vertices = edges = motion = bodyInterface = undefined;
  };
  try {
    worldState = acquireWorld(J);
    const { system } = worldState;
    bodyInterface = worldState.bodyInterface;
    filter = new J.GroupFilterTable(2); filter.AddRef();
    // Same group but different filter objects never collide. Within one cloth,
    // subgroup 0 (cloth) collides only with subgroup 1 (its rigid colliders).
    const collisionGroup = own(new J.CollisionGroup(filter, 0, 0));
    const vector = own(new J.Vec3(0, 0, 0)); system.SetGravity(vector);
    const origin = own(new J.RVec3(0, 0, 0));
    const quaternion = own(J.Quat.prototype.sIdentity());

    shared = new J.SoftBodySharedSettings(); shared.AddRef();
    const vertex = new J.SoftBodySharedSettingsVertex();
    try {
      positions.forEach((p, i) => {
        vertex.mPosition.x = p.x; vertex.mPosition.y = p.y; vertex.mPosition.z = p.z;
        vertex.mInvMass = fixed.has(i) ? 0 : 1;
        shared.mVertices.push_back(vertex);
      });
    } finally { J.destroy(vertex); }
    const face = new J.SoftBodySharedSettingsFace(0, 0, 0, 0);
    try {
      for (let i = 0; i < indices.length; i += 3) {
        for (let j = 0; j < 3; j++) face.set_mVertex(j, indices[i + j]);
        shared.AddFace(face);
      }
    } finally { J.destroy(face); }
    const attributes = new J.SoftBodySharedSettingsVertexAttributes();
    try {
      attributes.mCompliance = 1e-6;
      attributes.mShearCompliance = 1e-6;
      attributes.mBendCompliance = 1e-5;
      shared.CreateConstraints(attributes, 1, J.SoftBodySharedSettings_EBendType_Distance);
    } finally { J.destroy(attributes); }
    // The animated surface is the cloth's reference, not just a weak spring
    // destination. Native backstops prevent it folding behind that surface
    // and exposing the body/inner lining. This is not cloth self-collision.
    // Each solver owns its settings; update the reference vertices directly
    // through an identity skin binding, including animated Morph deformation.
    const skinIdentity = own(J.Mat44.prototype.sIdentity());
    shared.mInvBindMatrices.resize(1);
    const skinBind = shared.mInvBindMatrices.at(0);
    skinBind.mJointIndex = 0; skinBind.mInvBind = skinIdentity;
    shared.mSkinnedConstraints.resize(positions.length);
    for (let i = 0; i < positions.length; i++) {
      const constraint = shared.mSkinnedConstraints.at(i);
      constraint.mVertex = i;
      // Movable points retain Jolt's unlimited default maximum distance and
      // default backstop sphere radius; they remain free to move outwards.
      // Fixed points already have zero inverse mass and are transported below;
      // do not also hard-skin them through Jolt's substep interpolation.
      // Backstop projection itself does not honor inverse mass. Leave it
      // disabled on fixed points, which still supply adjacent skin normals.
      if (!fixed.has(i)) constraint.mBackStopDistance = 0;
      for (let k = 0; k < 4; k++) {
        const weight = constraint.get_mWeights(k);
        weight.mInvBindIndex = 0; weight.mWeight = k === 0 ? 1 : 0;
      }
    }
    shared.CalculateSkinnedConstraintNormals();
    shared.Optimize();
    const skinReference = positions.map((_, i) => J.getPointer(shared.mVertices.at(i).mPosition) / Float32Array.BYTES_PER_ELEMENT);
    const skinMatrices = own(new J.ArrayMat44()); skinMatrices.push_back(skinIdentity);
    const skinCenter = own(J.RMat44.prototype.sIdentity());
    edges = Array.from({ length: shared.mEdgeConstraints.size() }, (_, i) => {
      const edge = shared.mEdgeConstraints.at(i);
      return { edge, a: edge.get_mVertex(0), b: edge.get_mVertex(1), restLength: NaN };
    });
    const create = new J.SoftBodyCreationSettings(shared, origin, quaternion, 1);
    create.mCollisionGroup = collisionGroup;
    create.mNumIterations = ITERATIONS;
    create.mUpdatePosition = false;
    create.mAllowSleeping = false;
    create.mGravityFactor = 0;
    create.mLinearDamping = 0;
    create.mVertexRadius = radius;
    let body;
    try { body = bodyInterface.CreateSoftBody(create); } finally { J.destroy(create); }
    bodies.push(body); bodyInterface.AddBody(body.GetID(), J.EActivation_Activate);
    motion = J.castObject(body.GetMotionProperties(), J.SoftBodyMotionProperties);
    const traits = J.SoftBodyVertexTraits.prototype;
    const positionOffset = traits.mPositionOffset, previousOffset = traits.mPreviousPositionOffset, velocityOffset = traits.mVelocityOffset;
    // The arrays are immutable in size after construction. Cache addresses,
    // not a heap view or a guessed structure stride/layout.
    vertices = Array.from({ length: positions.length }, (_, i) => {
      const pointer = J.getPointer(motion.GetVertex(i));
      return {
        x: (pointer + positionOffset) / Float32Array.BYTES_PER_ELEMENT,
        q: (pointer + previousOffset) / Float32Array.BYTES_PER_ELEMENT,
        velocity: (pointer + velocityOffset) / Float32Array.BYTES_PER_ELEMENT,
      };
    });

    const makeShape = (pose) => {
      if (pose.shape === "panel") {
        const [a, b] = pose.halfAxes;
        const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
          .map(([u, v]) => new J.Float3(u * a.x + v * b.x, u * a.y + v * b.y, u * a.z + v * b.z));
        const triangles = new J.TriangleList();
        const materials = new J.PhysicsMaterialList();
        let settings, result;
        try {
          // The two faces have cross(a,b) winding and finite bounds. Jolt owns
          // triangle contacts; unlike an infinite PlaneShape they have edges.
          // Native mesh contacts do not recover deeply embedded backside
          // initial states. Do not replace this finite surface by a half-space.
          for (const indices of [[0, 1, 2], [0, 2, 3]]) {
            const triangle = new J.Triangle(...indices.map((i) => points[i]));
            try { triangles.push_back(triangle); } finally { J.destroy(triangle); }
          }
          settings = new J.MeshShapeSettings(triangles, materials);
          result = settings.Create();
          if (result.HasError()) throw new Error("cloth 无法创建有限碰撞板");
          const shape = result.Get(); shape.AddRef();
          return shape;
        } finally {
          if (result) J.destroy(result);
          if (settings) J.destroy(settings);
          J.destroy(materials); J.destroy(triangles);
          for (const point of points) J.destroy(point);
        }
      }
      let shape;
      if (pose.shape === "plane") {
        vector.Set(0, 1, 0);
        const plane = new J.Plane(vector, 0);
        try { shape = new J.PlaneShape(plane); } finally { J.destroy(plane); }
      } else {
        // A zero-length capsule is exactly a sphere. Jolt requires a positive
        // cylinder half-height; the public sphere shape preserves that limit.
        const r = Math.max(1e-7, pose.radius);
        shape = pose.shape === "capsule" && pose.height > 0
          ? new J.CapsuleShape(pose.height / 2, r) : new J.SphereShape(r);
      }
      shape.AddRef();
      return shape;
    };
    const setPose = (record, pose) => {
      origin.Set(pose.p.x, pose.p.y, pose.p.z);
      quaternion.Set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
      bodyInterface.SetPositionAndRotation(record.body.GetID(), origin, quaternion, J.EActivation_DontActivate);
    };
    for (const pose of colliders) {
      const shape = makeShape(pose);
      origin.Set(pose.p.x, pose.p.y, pose.p.z);
      quaternion.Set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
      const settings = new J.BodyCreationSettings(shape, origin, quaternion, J.EMotionType_Static, 0);
      shape.Release();
      collisionGroup.SetSubGroupID(1);
      settings.mCollisionGroup = collisionGroup;
      let collider;
      try { collider = bodyInterface.CreateBody(settings); } finally { J.destroy(settings); }
      bodies.push(collider); bodyInterface.AddBody(collider.GetID(), J.EActivation_DontActivate);
      colliderRecords.push({ body: collider, shape: pose.shape, radius: pose.radius, height: pose.height,
        halfAxes: pose.halfAxes?.map((axis) => axis.clone()), p: pose.p.clone(), q: pose.q.clone() });
    }
    const updateColliders = (poses) => {
      if (poses.length !== colliderRecords.length) throw new Error("cloth 碰撞体数量不能在运行中改变");
      for (let i = 0; i < poses.length; i++) {
        const record = colliderRecords[i], pose = poses[i];
        if (record.shape !== pose.shape || Math.abs(record.radius - pose.radius) > 1e-6 || Math.abs(record.height - pose.height) > 1e-6
          || (pose.halfAxes && pose.halfAxes.some((axis, j) => axis.distanceToSquared(record.halfAxes[j]) > 1e-12))) {
          const shape = makeShape(pose);
          // SetShape retains the new shape and releases the body's old shape.
          try { bodyInterface.SetShape(record.body.GetID(), shape, false, J.EActivation_DontActivate); }
          finally { shape.Release(); }
          record.shape = pose.shape; record.radius = pose.radius; record.height = pose.height;
          record.halfAxes = pose.halfAxes?.map((axis) => axis.clone());
        }
        if (!record.p.equals(pose.p) || !record.q.equals(pose.q)) {
          setPose(record, pose); record.p.copy(pose.p); record.q.copy(pose.q);
        }
      }
    };
    const updateRestLengths = (targets) => {
      for (const record of edges) {
        // The native setter stores float32. Rigid animated regions often keep
        // the same stored length even while their world coordinates change.
        const length = Math.fround(targets[record.a].distanceTo(targets[record.b]));
        if (length !== record.restLength) {
          record.edge.mRestLength = length; record.restLength = length;
        }
      }
    };
    const updateSkinReference = (targets, reset = false) => {
      const heap = J.HEAPF32;
      for (let i = 0; i < targets.length; i++) {
        const p = skinReference[i], t = targets[i];
        heap[p] = t.x; heap[p + 1] = t.y; heap[p + 2] = t.z;
      }
      // Jolt computes the reference normals from the animated triangles.
      // A reset must reset its previous skin state too, not interpolate from
      // the old pose after a seek/teleport. The body transform stays identity.
      motion.SkinVertices(skinCenter, skinMatrices.data(), 1, reset, worldState.world.GetTempAllocator());
      // JS already transports particles to this step's animated reference.
      // Collapse Jolt's previous/current skin interval as well, without hard
      // skinning away the simulated positions/velocities. Otherwise a surface
      // moving backwards pushes particles out of its obsolete previous plane.
      if (!reset) motion.SkinVertices(skinCenter, skinMatrices.data(), 1, false, worldState.world.GetTempAllocator());
    };
    const reference = positions.map((p) => p.clone());
    const updateReference = (targets, reset = false) => {
      if (!reset && targets.every((p, i) => p.equals(reference[i]))) return;
      updateRestLengths(targets); updateSkinReference(targets, reset);
      targets.forEach((p, i) => reference[i].copy(p));
    };
    const readPositions = () => {
      const heap = J.HEAPF32;
      for (let i = 0; i < vertices.length; i++) {
        const p = vertices[i].x;
        output[i].set(heap[p], heap[p + 1], heap[p + 2]);
        if (!Number.isFinite(output[i].x + output[i].y + output[i].z)) throw new Error("cloth 求解产生非有限坐标");
      }
    };
    const reset = (targets, poses, currentRadius = radius) => {
      if (disposed) throw new Error("cloth 求解器已经释放");
      motion.SetVertexRadius(currentRadius); updateColliders(poses);
      updateReference(targets, true);
      const heap = J.HEAPF32;
      targets.forEach((p, i) => {
        writeVec3(heap, vertices[i].x, p.x, p.y, p.z); writeVec3(heap, vertices[i].q, p.x, p.y, p.z);
        writeVec3(heap, vertices[i].velocity, 0, 0, 0); output[i].copy(p);
      });
      bodyInterface.ActivateBody(body.GetID());
    };
    updateSkinReference(positions, true);
    return {
      positions: output,
      reset,
      step({ targets, previousTargets, stiffness, gravity, delta, colliders: poses, radius: currentRadius = radius }) {
        if (disposed) throw new Error("cloth 求解器已经释放");
        if (!Number.isFinite(delta) || delta <= 0) throw new Error("cloth 步长必须为正有限数");
        motion.SetVertexRadius(currentRadius); updateColliders(poses);
        updateReference(targets);
        // Bullet's kDP is a per-step loss fraction, whereas Jolt damps each
        // native substep by (1 - coefficient * dt). This conversion preserves
        // the free-velocity retention (1-damping) across one complete step.
        motion.SetLinearDamping(ITERATIONS / delta * (1 - Math.pow(1 - damping, 1 / ITERATIONS)));
        const heap = J.HEAPF32;
        for (let i = 0; i < vertices.length; i++) {
          const { x, q, velocity } = vertices[i], t = targets[i], previous = previousTargets[i];
          if (fixed.has(i)) {
            writeVec3(heap, x, t.x, t.y, t.z); writeVec3(heap, q, t.x, t.y, t.z); writeVec3(heap, velocity, 0, 0, 0);
          } else {
            const dx = t.x - previous.x, dy = t.y - previous.y, dz = t.z - previous.z;
            writeVec3(heap, x, heap[x] + dx, heap[x + 1] + dy, heap[x + 2] + dz);
            writeVec3(heap, q, heap[q] + dx, heap[q + 1] + dy, heap[q + 2] + dz);
            // Reload the stored float32 position, just as the native accessor
            // path did; reusing the unrounded JS sum changes the simulation.
            writeVec3(heap, velocity, heap[velocity] + ((t.x - heap[x]) * stiffness + gravity[0]) * delta,
              heap[velocity + 1] + ((t.y - heap[x + 1]) * stiffness + gravity[1]) * delta,
              heap[velocity + 2] + ((t.z - heap[x + 2]) * stiffness + gravity[2]) * delta);
          }
        }
        // Only this cloth advances: model-local updates and warmup must not
        // integrate other avatars or require a renderer-wide batch scheduler.
        motion.CustomUpdate(delta, body, system);
        readPositions();
      },
      destroy,
    };
  } catch (error) { destroy(); throw error; }
}

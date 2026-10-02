import * as THREE from "three";

/** Find the deepest contact of a tapered segment using the collider query API. */
export class PhysicsEdgeContact {
  constructor() {
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.start = new THREE.Vector3();
    this.end = new THREE.Vector3();
    this.axisA = new THREE.Vector3();
    this.axisB = new THREE.Vector3();
    this.relative = new THREE.Vector3();
    this.linear = new THREE.Matrix3();
    this.t = 0;
    this.distance = Infinity;
  }

  query(a, b, radiusA, radiusB, collider) {
    const { shape, collider: object } = collider;
    if (shape.type === "sphere" || shape.type === "capsule") {
      this.start.setFromMatrixPosition(object.colliderMatrix);
      if (shape.type === "capsule") this.end.subVectors(shape.tail, shape.offset).applyMatrix4(object.colliderMatrix);
      else this.end.copy(this.start);
      const padding = shape.radius + Math.max(radiusA, radiusB);
      // Cheap conservative rejection before the continuous contact query.
      for (const axis of ["x", "y", "z"]) {
        if (Math.max(a[axis], b[axis]) < Math.min(this.start[axis], this.end[axis]) - padding
          || Math.min(a[axis], b[axis]) > Math.max(this.start[axis], this.end[axis]) + padding) {
          this.distance = Infinity; return this;
        }
      }
    }
    const evaluate = (t) => {
      this.point.copy(a).lerp(b, t);
      return shape.calculateCollision(object.colliderMatrix, this.point,
        radiusA + (radiusB - radiusA) * t, this.normal);
    };
    let bestT = 0, best = evaluate(0);
    const middle = evaluate(.5);
    if (middle < best) { best = middle; bestT = .5; }
    const cuts = [0, 1];
    if (shape.type === "panel") {
      // Split exactly at the projected parallelogram boundaries. Outside,
      // distance to the finite convex face is convex; inside it is signed
      // plane distance. This also catches very narrow panels crossing an edge.
      this.linear.setFromMatrix4(object.colliderMatrix);
      const x = this.axisA.copy(shape.halfAxes[0]).applyMatrix3(this.linear);
      const y = this.axisB.copy(shape.halfAxes[1]).applyMatrix3(this.linear);
      const aa = x.lengthSq(), bb = y.lengthSq(), ab = x.dot(y), det = aa * bb - ab * ab;
      if (det > 0) {
        const coordinates = (p) => {
          this.relative.copy(p).sub(this.start.setFromMatrixPosition(object.colliderMatrix));
          const px = this.relative.dot(x), py = this.relative.dot(y);
          return [(px * bb - py * ab) / det, (py * aa - px * ab) / det];
        };
        const u = coordinates(a), v = coordinates(b);
        for (let i = 0; i < 2; i++) for (const bound of [-1, 1]) {
          const t = (bound - u[i]) / (v[i] - u[i]);
          if (t > 0 && t < 1) cuts.push(t);
        }
        cuts.sort((u, v) => u - v);
      }
    }
    // Distance to a convex sphere/capsule minus linear radius is convex.
    // Plane distance is linear, so its minimum is one of the endpoints.
    if (shape.type !== "plane") {
      for (let segment = 1; segment < cuts.length; segment++) {
        let lo = cuts[segment - 1], hi = cuts[segment];
        for (const t of [lo, hi]) {
          const d = evaluate(t);
          if (d < best) { best = d; bestT = t; }
        }
        for (let i = 0; i < 24; i++) {
          const left = lo + (hi - lo) / 3, right = hi - (hi - lo) / 3;
          if (evaluate(left) <= evaluate(right)) hi = right;
          else lo = left;
        }
        const t = (lo + hi) / 2, d = evaluate(t);
        if (d < best) { best = d; bestT = t; }
      }
    }
    const end = evaluate(1);
    if (end < best) { best = end; bestT = 1; }
    this.t = bestT;
    this.distance = evaluate(bestT);
    // At the center of a round collider either side is geometrically valid.
    // Choose a direction perpendicular to the edge, not along it.
    if (shape.type === "sphere" || shape.type === "capsule") {
      this.direction.subVectors(b, a).normalize();
      const radius = radiusA + (radiusB - radiusA) * bestT;
      if (Math.abs(this.distance + shape.radius + radius) < 1e-8 * Math.max(1, shape.radius)
        && Math.abs(this.normal.dot(this.direction)) > .999999) {
        this.point.set(Math.abs(this.direction.z) < .8 ? 0 : 1, 0, Math.abs(this.direction.z) < .8 ? 1 : 0);
        this.normal.copy(this.point).addScaledVector(this.direction, -this.point.dot(this.direction)).normalize();
        if (shape.type === "capsule") {
          this.point.subVectors(this.end, this.start).normalize().cross(this.direction);
          if (this.point.lengthSq() > 1e-12) this.normal.copy(this.point).normalize();
        }
      }
    }
    return this;
  }
}

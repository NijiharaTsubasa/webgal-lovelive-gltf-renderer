import * as THREE from "three";

/** A finite, oriented parallelogram, using the VRM collider query interface. */
export class PhysicsPanelShape {
  constructor() {
    this.offset = new THREE.Vector3();
    this.halfAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
    this._linear = new THREE.Matrix3();
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3();
    this._normal = new THREE.Vector3(); this._relative = new THREE.Vector3();
    this._candidate = new THREE.Vector3(); this._closest = new THREE.Vector3();
  }

  get type() { return "panel"; }

  calculateCollision(matrix, position, radius, target) {
    const a = this._a.copy(this.halfAxes[0]).applyMatrix3(this._linear.setFromMatrix4(matrix));
    const b = this._b.copy(this.halfAxes[1]).applyMatrix3(this._linear);
    const n = this._normal.crossVectors(a, b);
    const areaSquared = n.lengthSq();
    // Animated zero scale collapses the surface; it must not poison the solver.
    if (areaSquared === 0) { target.set(0, 0, 1); return Infinity; }
    n.normalize();
    const p = this._relative.setFromMatrixPosition(matrix).negate().add(position);
    const aa = a.lengthSq(), bb = b.lengthSq(), ab = a.dot(b);
    const ap = a.dot(p), bp = b.dot(p);
    const u = (ap * bb - bp * ab) / areaSquared;
    const v = (bp * aa - ap * ab) / areaSquared;
    if (Math.abs(u) <= 1 && Math.abs(v) <= 1) {
      target.copy(n);
      return p.dot(n) - radius;
    }
    // Clamping the two coordinates independently is wrong under affine skew.
    // Minimize on each of the four segments instead, including their corners.
    let best = Infinity;
    for (const sign of [-1, 1]) {
      const edgeV = THREE.MathUtils.clamp((bp - sign * ab) / bb, -1, 1);
      this._candidate.copy(a).multiplyScalar(sign).addScaledVector(b, edgeV);
      let distance = this._candidate.distanceToSquared(p);
      if (distance < best) { best = distance; this._closest.copy(this._candidate); }
      const edgeU = THREE.MathUtils.clamp((ap - sign * ab) / aa, -1, 1);
      this._candidate.copy(b).multiplyScalar(sign).addScaledVector(a, edgeU);
      distance = this._candidate.distanceToSquared(p);
      if (distance < best) { best = distance; this._closest.copy(this._candidate); }
    }
    const distance = Math.sqrt(best);
    if (distance > 0) target.subVectors(p, this._closest).divideScalar(distance);
    else target.copy(n);
    return distance - radius;
  }
}

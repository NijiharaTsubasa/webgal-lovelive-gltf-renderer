import * as THREE from 'three';
import calibration from './garupa/body-calibration.js';
import { interpolateCurve } from './garupa/body-mapping.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const room = (angle, addition, limit) => addition >= 0
  ? Math.min(addition, Math.max(0, limit - angle))
  : Math.max(addition, Math.min(0, -limit - angle));

// Host gaze adaptation in character model space, not muscle solving.
export class CharacterFocus {
  constructor() {
    this.x = 0; this.y = 0; this.targetX = 0; this.targetY = 0; this.targets = [];
    this.rootWorld = new THREE.Quaternion(); this.rootInverse = new THREE.Quaternion();
    this.bodyOffset = new THREE.Quaternion(); this.headOffset = new THREE.Quaternion();
    this.angle = new THREE.Quaternion();
    this.headEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.rollAxis = new THREE.Vector3(0, 0, 1);
    this.headRollCurve = calibration.bodyCurves.find(curve => curve.id === 'PARAM_ANGLE_Z').samples;
    this.lastX = NaN; this.lastY = NaN;
    this.headRows = calibration.head.axis.map(x => [x, calibration.head.samples
      .filter(sample => sample.input[0] === x).map(sample => [sample.input[1], sample.angles])]);
    this.headAlongY = this.headRows.map(([x]) => [x, [0, 0]]);
  }
  set({ x = this.targetX, y = this.targetY, instant = false } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Focus x/y must be finite');
    this.targetX = clamp(x, -1, 1); this.targetY = clamp(y, -1, 1);
    if (instant) { this.x = this.targetX; this.y = this.targetY; }
  }
  update(delta) {
    const weight = -Math.expm1(-12 * Math.max(0, delta));
    this.x += (this.targetX - this.x) * weight;
    this.y += (this.targetY - this.y) * weight;
    if (Math.abs(this.targetX - this.x) < 1e-5) this.x = this.targetX;
    if (Math.abs(this.targetY - this.y) < 1e-5) this.y = this.targetY;
  }
  bind(root) {
    this.restore(); this.targets = [];
    this.root = root;
    root.updateWorldMatrix(true, true);
    root.getWorldQuaternion(this.rootWorld); this.rootInverse.copy(this.rootWorld).invert();
    const nodes = new Map(); root.traverse(node => { if (node.isBone) nodes.set(node.name, node); });
    const neck = nodes.has('Neck');
    for (const [name, weight, body] of [['Chest', 1, true], ['Neck', .25, false], ['Head', neck ? .75 : 1, false]]) {
      const node = nodes.get(name); if (!node) continue;
      const binding = node.getWorldQuaternion(new THREE.Quaternion()).premultiply(this.rootInverse);
      this.targets.push({ node, weight, body, base: node.quaternion.clone(),
        inverse: binding.invert(), delta: new THREE.Quaternion(), offset: new THREE.Quaternion(),
        parentWorld: new THREE.Quaternion(), frame: new THREE.Quaternion(), authoredWorld: new THREE.Quaternion(),
        euler: new THREE.Euler(0, 0, 0, 'YXZ'), addition: new THREE.Euler(0, 0, 0, 'YXZ'), applied: false });
    }
  }
  restore() {
    for (const target of this.targets) if (target.applied) {
      target.node.quaternion.copy(target.base); target.applied = false;
    }
  }
  apply() {
    if (!this.root) return;
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldQuaternion(this.rootWorld); this.rootInverse.copy(this.rootWorld).invert();
    if (this.lastX !== this.x || this.lastY !== this.y) {
      for (let i = 0; i < this.headRows.length; i++) {
        const angles = interpolateCurve(this.headRows[i][1], this.y * 30);
        this.headAlongY[i][1][0] = angles[0]; this.headAlongY[i][1][1] = angles[1];
      }
      const [yaw, pitch] = interpolateCurve(this.headAlongY, this.x * 30);
      const headRoll = -interpolateCurve(this.headRollCurve, -30 * this.x * this.y)[5];
      this.bodyOffset.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,
        THREE.MathUtils.degToRad(interpolateCurve(calibration.bodyYaw, this.x * 10)));
      this.angle.setFromAxisAngle(this.rollAxis, THREE.MathUtils.degToRad(headRoll));
      this.headOffset.setFromEuler(this.headEuler.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0, 'YXZ'));
      this.headOffset.premultiply(this.angle);
      this.lastX = this.x; this.lastY = this.y;
    }
    // Sample every authored world pose before modifying any ancestor. Joint
    // axes in normalized rigs are anatomical, not model X/Y/Z axes.
    for (const target of this.targets) {
      const { node, weight, body, inverse, delta, offset, euler } = target;
      target.base.copy(node.quaternion);
      node.getWorldQuaternion(target.authoredWorld);
      delta.copy(target.authoredWorld).premultiply(this.rootInverse).multiply(inverse);
      euler.setFromQuaternion(delta, 'YXZ');
      offset.copy(body ? this.bodyOffset : this.headOffset);
      if (node.name === 'Neck') offset.copy(this.bodyOffset).slerp(this.headOffset, weight);
      const addition = target.addition.setFromQuaternion(offset, 'YXZ');
      // Preserve strong authored poses; only consume the remaining joint range.
      const ax = room(euler.x, addition.x, THREE.MathUtils.degToRad(body ? 25 : 65));
      const ay = room(euler.y, addition.y, THREE.MathUtils.degToRad(body ? 40 : 80));
      const az = room(euler.z, addition.z, THREE.MathUtils.degToRad(45));
      offset.setFromEuler(euler.set(ax, ay, az, 'YXZ'));
    }
    for (const target of this.targets) {
      const { node, parentWorld, frame, offset } = target;
      node.parent.getWorldQuaternion(parentWorld);
      // Each target is an absolute model-world addition to its authored pose;
      // parent-local conversion prevents adding the torso turn a second time.
      frame.copy(this.rootWorld).multiply(offset).multiply(this.rootInverse).multiply(target.authoredWorld);
      node.quaternion.copy(parentWorld).invert().multiply(frame).normalize();
      node.updateWorldMatrix(false, false); target.applied = true;
    }
  }
}

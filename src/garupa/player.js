import { createWebgalExpression } from './expression.js';

// Parameter storage is authored here; curve sampling and queue fades are
// delegated to the host's real Cubism 2 runtime, never reimplemented from Core.
export class ParameterStore {
  constructor(defaults, ranges) {
    this.values = Object.assign(Object.create(null), defaults); this.ranges = ranges;
  }
  getParamIndex(id) { return String(id); }
  getParamFloat(id) { return Object.hasOwn(this.values, id) ? this.values[id] : 0; }
  setParamFloat(id, value, weight = 1) {
    const next = this.getParamFloat(id) * (1 - weight) + value * weight;
    if (!Number.isFinite(next)) throw new Error(`非有限参数 ${id}`);
    // Ranges inform source motion interpolation, not a global rejection or
    // saturation policy. Each target adapter owns its representable limits.
    this.values[id] = next;
  }
  addToParamFloat(id, value, weight = 1) { this.setParamFloat(id, this.getParamFloat(id) + value * weight); }
  multParamFloat(id, value, weight = 1) { this.setParamFloat(id, this.getParamFloat(id) * (1 + (value - 1) * weight)); }
  getModelContext() {
    return { getParamMin: id => this.ranges[id]?.min ?? -1,
      getParamMax: id => this.ranges[id]?.max ?? 1, getParamFloat: id => this.getParamFloat(id) };
  }
  // Source part visibility is outside standard Humanoid motion.
  getPartsDataIndex(id) { return id; }
  setPartsOpacity() {}
}

export function sharedParameters(calibration) {
  const defaults = { ...calibration.defaults }, ranges = { ...calibration.ranges };
  const define = (id, min, max, initial = 0) => {
    defaults[`PARAM_${id}`] = initial; ranges[`PARAM_${id}`] = { min, max };
  };
  for (const side of ['L', 'R']) {
    define(`EYE_${side}_OPEN`, 0, 1.5, 1); define(`EYE_${side}_SMILE`, 0, 1);
    define(`EYELID_${side}`, -1, 1);
    for (const axis of ['X', 'Y', 'ANGLE', 'FORM']) define(`BROW_${side}_${axis}`, -1, 1);
  }
  for (const id of ['EYE_BALL_X', 'EYE_BALL_Y', 'EYE_SCALE', 'EYE_FORM', 'MOUTH_FORM_01', 'MOUTH_FORM_Y', 'MOUTH_SCALE']) define(id, -1, 1);
  for (const id of ['EYE_HIGHLIGHT', 'TEAR', 'MOUTH_OPEN_Y', 'CHEEK', 'CHEEK2', 'MOUTH_SWITCH', 'MOUTH_OPEN_Y_MANUAL']) define(id, 0, 1);
  define('EYE_BROWS', 0, 1.5);
  return { defaults, ranges };
}

export class ParameterPlayer {
  constructor(runtime, calibration) {
    if (!runtime?.Live2DMotion || !runtime?.AMotion || !runtime?.MotionQueueManager || !runtime?.UtSystem) {
      throw new Error('参数播放需要宿主提供 Cubism 2 运行库');
    }
    this.runtime = runtime;
    const { defaults, ranges } = sharedParameters(calibration);
    this.store = new ParameterStore(defaults, ranges);
    this.baseline = { ...defaults }; this.parameters = { ...defaults };
    this.motionQueue = new runtime.MotionQueueManager();
    this.expressionQueue = new runtime.MotionQueueManager();
    this.time = 0; this.blink = 0; this.speech = null; this.motionUpdated = false;
  }
  withClock(operation) {
    // Queues share the SDK, but actors do not share time. Scope the public
    // clock accessor to this synchronous operation and leave the native host
    // clock untouched (also when an SDK call fails).
    const system = this.runtime.UtSystem;
    const original = system.getUserTimeMSec;
    system.getUserTimeMSec = () => 100000 + this.time * 1000;
    try { return operation(); }
    finally { system.getUserTimeMSec = original; }
  }
  setMotion(text, definition = {}) {
    return this.withClock(() => {
    // Prepare before replacing a valid playing queue.
    let motion = null;
    if (text !== null) {
      const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n|\r|\n/g, '\r\n');
      const bytes = new TextEncoder().encode(normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`);
      motion = this.runtime.Live2DMotion.loadMotion(new DataView(bytes.buffer));
      motion.setFadeIn(definition.fadeIn > 0 ? definition.fadeIn : 500);
      motion.setFadeOut(definition.fadeOut > 0 ? definition.fadeOut : 500);
    }
    this.motionQueue.stopAllMotions();
    this.motion = motion;
    if (motion) this.motionQueue.startMotion(motion);
    });
  }
  setExpression(json) {
    return this.withClock(() => {
    if (json === null) this.expressionQueue.stopAllMotions();
    else this.expressionQueue.startMotion(createWebgalExpression(this.runtime, json));
    });
  }
  update(delta) {
    this.time += delta;
    return this.withClock(() => {
    this.store.values = Object.assign(Object.create(null), this.baseline);
    this.motionUpdated = Boolean(this.motionQueue.updateParam(this.store));
    this.baseline = { ...this.store.values };
    this.expressionQueue.updateParam(this.store);
    if (!this.motionUpdated) for (const side of ['L', 'R']) this.store.multParamFloat(`PARAM_EYE_${side}_OPEN`, 1 - this.blink);
    if (this.speech !== null) this.store.setParamFloat('PARAM_MOUTH_OPEN_Y', this.speech);
    this.parameters = Object.freeze({ ...this.store.values });
    return this.parameters;
    });
  }
  dispose() { this.motionQueue.stopAllMotions(); this.expressionQueue.stopAllMotions(); }
}

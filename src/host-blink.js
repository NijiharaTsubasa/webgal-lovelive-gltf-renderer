// Host-side adaptation of WebGAL's cubism2/Live2DEyeBlink.ts and utils/math.ts.
// Durations remain milliseconds. This is host scheduling, not a model Behavior
// or a recovered native SDK algorithm. The output adapts eye-open to closed.
export class HostBlink {
  constructor(config = {}, random = Math.random) {
    // WebGAL cubism-common/InternalModel.ts: baseBlinkParam.
    this.blinkInterval = 86400000;
    this.blinkIntervalRandom = 1000;
    this.closingDuration = 100;
    this.closedDuration = 50;
    this.openingDuration = 150;
    this.eyeState = 'Idle';
    this.eyeParamValue = 1;
    this.closedTimer = 0;
    this.random = random;
    this.setParameters(config);
  }

  setParameters(config) {
    for (const key of ['blinkInterval', 'blinkIntervalRandom', 'closingDuration', 'closedDuration', 'openingDuration']) {
      if (config[key] !== undefined) this[key] = config[key];
    }
    // Cubism2InternalModel.setBlinkParam recalculates the interval without
    // resetting the current state, eye value or closed timer.
    this.recalculateBlinkInterval();
  }

  recalculateBlinkInterval() {
    this.nextBlinkTimeLeft = Math.max(
      this.blinkInterval + (this.random() * 2 - 1) * this.blinkIntervalRandom, 0,
    );
  }

  setEyeParams(value) {
    // Same clamp as WebGAL utils/math.ts, including its NaN behavior.
    this.eyeParamValue = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  update(dt) {
    // Preserve the C2 switch order and one branch per update, including the
    // strict Idle boundary and discarded overshoot on a state transition.
    switch (this.eyeState) {
      case 'Idle':
        this.nextBlinkTimeLeft -= dt;
        if (this.nextBlinkTimeLeft < 0) {
          this.eyeState = 'Closing';
          this.recalculateBlinkInterval();
        }
        break;
      case 'Closing':
        this.eyeParamValue -= dt / this.closingDuration;
        this.setEyeParams(Math.max(this.eyeParamValue, 0));
        if (this.eyeParamValue <= 0) {
          this.eyeState = 'Closed';
          this.closedTimer = 0;
          this.eyeParamValue = 0;
        }
        break;
      case 'Closed':
        this.closedTimer += dt;
        this.setEyeParams(this.eyeParamValue);
        if (this.closedTimer >= this.closedDuration) this.eyeState = 'Opening';
        break;
      case 'Opening':
        this.eyeParamValue += dt / this.openingDuration;
        this.setEyeParams(Math.min(this.eyeParamValue, 1));
        if (this.eyeParamValue >= 1) {
          this.eyeState = 'Idle';
          this.eyeParamValue = 1;
        }
        break;
    }
    return 1 - this.eyeParamValue;
  }
}

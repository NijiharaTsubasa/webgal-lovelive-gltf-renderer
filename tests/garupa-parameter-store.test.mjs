import test from 'node:test';
import assert from 'node:assert/strict';
import { ParameterStore, ParameterPlayer } from '../src/garupa/player.js';

test('parameter storage supports weighted set/add/multiply without clipping source values', () => {
  const store = new ParameterStore({ value: 2 }, { value: { min: -1, max: 1 } });
  store.setParamFloat('value', 4, .5);
  assert.equal(store.getParamFloat('value'), 3);
  store.addToParamFloat('value', 2, .5);
  assert.equal(store.getParamFloat('value'), 4);
  store.multParamFloat('value', 3, .5);
  assert.equal(store.getParamFloat('value'), 8);
  assert.equal(store.getParamFloat('missing'), 0);
  assert.equal(store.getModelContext().getParamMax('value'), 1);
  assert.throws(() => store.setParamFloat('value', Infinity), /非有限参数/);
});

function runtime() {
  class Queue {
    startMotion(motion) { this.motion = motion; }
    stopAllMotions() { this.motion = null; }
    updateParam(store) { if (!this.motion) return false; this.motion.update(store); return true; }
  }
  return {
    MotionQueueManager: Queue,
    AMotion: class {},
    Live2DMotion: { loadMotion: () => ({ setFadeIn() {}, setFadeOut() {}, update() {} }) },
    UtSystem: { getUserTimeMSec: () => 1234 },
  };
}

test('host queue orchestration preserves baseline, transient controls and scoped clocks', () => {
  const sdk = runtime(), getter = sdk.UtSystem.getUserTimeMSec;
  const player = new ParameterPlayer(sdk, { defaults: {}, ranges: {} });
  player.motionQueue.startMotion({ update(store) {
    assert.equal(sdk.UtSystem.getUserTimeMSec(), 100250);
    store.setParamFloat('PARAM_EYE_L_OPEN', .4);
  } });
  player.expressionQueue.startMotion({ update(store) { store.setParamFloat('PARAM_EYE_L_OPEN', .8); } });
  player.speech = .6;
  player.update(.25);
  assert.equal(player.baseline.PARAM_EYE_L_OPEN, .4);
  assert.equal(player.parameters.PARAM_EYE_L_OPEN, .8);
  assert.equal(player.parameters.PARAM_MOUTH_OPEN_Y, .6);
  assert.ok(Object.isFrozen(player.parameters));
  assert.equal(sdk.UtSystem.getUserTimeMSec, getter);
  player.motionQueue.updateParam = () => { throw new Error('queue failure'); };
  assert.throws(() => player.update(.1), /queue failure/);
  assert.equal(sdk.UtSystem.getUserTimeMSec, getter);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ParameterStore, ParameterPlayer } from '../src/garupa/player.js';
import * as THREE from 'three';
import { CharacterRenderer } from '../src/character-renderer.js';

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

test('motion configuration applies snake-case fades and defaults independently', () => {
  const sdk = runtime(), fades = [];
  sdk.Live2DMotion.loadMotion = () => ({
    setFadeIn(value) { fades.push(['in', value]); },
    setFadeOut(value) { fades.push(['out', value]); },
  });
  const player = new ParameterPlayer(sdk, { defaults: {}, ranges: {} });
  player.setMotion('# fps=30\n', { fade_in: 150, fade_out: 250 });
  player.setMotion('# fps=30\n', { fade_in: 0, fade_out: -1 });
  player.setMotion('# fps=30\n');
  assert.deepEqual(fades, [
    ['in', 150], ['out', 250], ['in', 500], ['out', 500], ['in', 500], ['out', 500],
  ]);
});

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

test('leaving parameter animation clears its saved face values while retaining expression and host inputs', () => {
  const player = new ParameterPlayer(runtime(), { defaults: {}, ranges: {} });
  player.motionQueue.startMotion({ update(store) {
    store.setParamFloat('PARAM_EYE_L_OPEN', .69);
    store.setParamFloat('PARAM_EYE_R_SMILE', 1);
    store.setParamFloat('PARAM_BROW_L_Y', .8);
    store.setParamFloat('PARAM_MOUTH_FORM_01', -.7);
  } });
  player.update(1);
  assert.equal(player.baseline.PARAM_EYE_L_OPEN, .69);
  const character = new CharacterRenderer({ renderer: {}, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
  character.behaviors = { setMotion() {} };
  character.parameterPlayer = player;
  character.pendingMotion = { generation: character.motionGeneration };
  character.applyPendingMotion();
  // An empty idle expression cannot overwrite a prior motion's eye values.
  player.expressionQueue.startMotion({ update() {} });
  player.update(1);
  assert.equal(player.parameters.PARAM_EYE_L_OPEN, 1);
  assert.equal(player.parameters.PARAM_EYE_R_SMILE, 0);
  assert.equal(player.parameters.PARAM_BROW_L_Y, 0);
  assert.equal(player.parameters.PARAM_MOUTH_FORM_01, 0);
  player.expressionQueue.startMotion({ update(store) { store.setParamFloat('PARAM_EYE_L_OPEN', .75); } });
  player.blink = .2;
  player.speech = .4;
  player.update(.1);
  assert.equal(player.parameters.PARAM_EYE_L_OPEN, .75 * .8);
  assert.equal(player.parameters.PARAM_MOUTH_OPEN_Y, .4);
});

test('parameter animation retains saved values between queue samples until explicitly leaving that mode', () => {
  const player = new ParameterPlayer(runtime(), { defaults: {}, ranges: {} });
  player.motionQueue.startMotion({ update(store) { store.setParamFloat('PARAM_EYE_L_OPEN', .69); } });
  player.update(1);
  player.setMotion('next parameter motion');
  player.update(.1);
  assert.equal(player.parameters.PARAM_EYE_L_OPEN, .69);
});

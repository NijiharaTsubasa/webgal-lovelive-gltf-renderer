import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ModelPhysics } from '../src/model-physics.js';
import { CharacterRenderer } from '../src/character-renderer.js';

test('bone settling and cloth contact recovery use independent reset budgets', () => {
  const physics = new ModelPhysics(new THREE.Group(), []);
  const budgets = [];
  physics.meshCloth = { reset: steps => budgets.push(steps) };
  physics.reset(30, 2);
  assert.equal(physics.warmupSteps, 30);
  assert.equal(physics.needsReset, true);
  physics.reset(2);
  physics.reset();
  assert.deepEqual(budgets, [2, 2, 30]);
});

test('motion replacement preserves initial settling and recovers initialized cloth with two steps', () => {
  const character = new CharacterRenderer({ renderer: {}, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
  const budgets = [];
  character.behaviors = { setMotion() {} };
  character.physics = { needsReset: true, reset(...args) { budgets.push(args); this.needsReset = true; } };
  const replace = () => {
    character.pendingMotion = { generation: character.motionGeneration };
    character.applyPendingMotion();
  };
  replace();
  character.physics.needsReset = false;
  replace();
  // Another command before initialization completes still uses full settling.
  replace();
  assert.deepEqual(budgets, [[30, 30], [30, 2], [30, 30]]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { OffscreenCharacter } from '../src/offscreen-character.js';
import { fetchMotionPayload } from '../src/motion-binary.js';
import { CharacterRenderer } from '../src/character-renderer.js';

const entry = (type, name) => ({ type, name,
  config: `https://game.test/game/3d/motion/${name}`,
  component: { src: name.split('/').at(-1) }, basePath: 'https://game.test/game/3d/motion/' });

function fixture(catalog) {
  const calls = [];
  const actor = Object.assign(Object.create(OffscreenCharacter.prototype), {
    disposed: false, motionGeneration: 0, expressionGeneration: 0, catalog,
    character: {
      config: { defaultMotion: 'idle' }, faceDefinition: { defaultExpression: {eye:'Smile',closed:'N',open:'A'} },
      async selectMotion(item, url) { calls.push(['motion', item?.name, url]); },
      async selectParameterMotion(item, url) { calls.push(['parameter-motion', item.name, url]); },
      async selectParameterExpression(item) { calls.push(['parameter-expression', item?.name]); },
      async setParameterFace(enabled) { calls.push(['parameter-face', enabled]); },
      setExpression(name) { calls.push(['expression', name]); },
    },
  });
  return { actor, calls };
}

test('host lookup drives universal and parameter motions without a file catalog', async () => {
  const names = [];
  const { actor, calls } = fixture({ async resolveMotion(name, options) {
    names.push([name, options]); return entry(name.endsWith('.motionbin') ? 'motion' : 'garupa-motion', name);
  } });
  await actor.setMotion('llas/idle.motionbin');
  await actor.setMotion('anon/bye01');
  assert.deepEqual(names, [['llas/idle.motionbin', { optional: false }], ['anon/bye01', { optional: false }]]);
  assert.equal(calls[0][0], 'motion');
  assert.equal(calls[0][2], 'https://game.test/game/3d/motion/llas/idle.motionbin');
  assert.equal(calls[1][0], 'parameter-motion');
});

test('an absent default motion retains the static pose', async () => {
  const { actor, calls } = fixture({ async resolveMotion(name, options) {
    assert.equal(name, 'idle'); assert.equal(options.optional, true); return null;
  } });
  await actor.setMotion('');
  assert.deepEqual(calls, [['motion', undefined, undefined]]);
});

test('native expressions retain priority over host parameter expression lookup', async () => {
  const queried = [];
  const { actor, calls } = fixture({ async resolveExpression(name) {
    queried.push(name); return entry('garupa-expression', name);
  } });
  await actor.setExpression('3d:Smile/N/A');
  await actor.setExpression('anon/sad01');
  assert.deepEqual(queried, ['anon/sad01']);
  assert.deepEqual(calls, [['parameter-face', false], ['expression', {eye:'Smile',closed:'N',open:'A'}],
    ['parameter-expression', 'anon/sad01'], ['parameter-face', true]]);
});

test('named preparation uses the injected lookup and cached bytes', async () => {
  const fetched = [];
  await OffscreenCharacter.preloadNamed('https://unused.test/catalog.json', [
    { kind: 'motion', name: 'idle.motionbin' }, { kind: 'expression', name: '3d:Smile/N/A' },
  ], { async resolveMotion(name, options) {
    assert.equal(options.optional, true); return entry('motion', name);
  }, async resolveExpression() { assert.fail('Native combinations have no external resource'); }, async fetch(url, kind) { fetched.push([url, kind]); } });
  assert.deepEqual(fetched, [['https://game.test/game/3d/motion/idle.motionbin', 'bytes']]);
});

test('empty expression restores the model default after releasing parameter playback', async () => {
  const {actor,calls}=fixture({async resolveExpression(){assert.fail('Default is native');}});
  actor.character.parameterPlayer={};
  await actor.setExpression('');
  assert.deepEqual(calls,[['parameter-expression',undefined],['parameter-face',false],
    ['expression',{eye:'Smile',closed:'N',open:'A'}]]);
});

test('native combination decodes each selected name independently', async () => {
  const {actor,calls}=fixture({async resolveExpression(){assert.fail('Native is local');}});
  await actor.setExpression('3d:Sad%2FWink/Smile%25/A%20wide');
  assert.deepEqual(calls.at(-1),['expression',{eye:'Sad/Wink',closed:'Smile%',open:'A wide'}]);
});

test('model changes preserve available eye and mouth choices independently and retain host opening inputs', () => {
  let selection={eye:'Open',closed:'N',open:'A'}, blink=0, speech=0;
  const actor=Object.assign(Object.create(CharacterRenderer.prototype),{
    faceDefinition:{defaultExpression:{eye:'Open',closed:'N',open:'A'}},
    rememberedFace:{selections:{eye:'Sad',closed:'Missing',open:'I'},blink:.6,speech:.4},
    face:{setExpression(value){selection={...value};},setBlink(value){blink=value;},setSpeech(value){speech=value;},
      getCapabilities(){return {selections:selection,groups:[
        {name:'face',type:'eye',states:['Open','Sad']},{name:'lips',type:'mouth',states:['N','A','I']} ]};}},
  });
  actor.initializeFace();
  assert.deepEqual(selection,{eye:'Sad',closed:'N',open:'I'});
  assert.deepEqual(actor.expressionName,selection);
  assert.equal(blink,.6);assert.equal(speech,.4);
});

test('direct motionbin paths retain the current binary decoder', async () => {
  const header = new TextEncoder().encode(JSON.stringify({ clips: [] }));
  const buffer = new ArrayBuffer(Math.ceil((12 + header.length) / 8) * 8);
  new Uint8Array(buffer).set([77, 79, 84, 73, 79, 78, 0, 0]);
  new DataView(buffer).setUint32(8, header.length, true);
  new Uint8Array(buffer).set(header, 12);
  const fetchResource = async () => new Response(buffer);
  assert.deepEqual(await fetchMotionPayload('https://game.test/idle.motionbin', fetchResource), { clips: [] });
});

test('explicit expression fade settings reach local and worker playback without changing unspecified values', async () => {
  for (const worker of [false, true]) {
    let received;
    const actor = Object.assign(Object.create(CharacterRenderer.prototype), {
      parameterExpressionGeneration: 0, root: {},
      async fetchResource() { return new Response(JSON.stringify({ fade_in: 700, fade_out: 900, params: [] })); },
      ensureParameterPlayer() { return { setExpression(json) { received = json; } }; },
      computeBridge: worker ? { command({ expression }) { received = expression; } } : null,
    });
    await actor.selectParameterExpression({ component: { fade_in: 250 } }, 'https://game.test/smile.exp.json');
    assert.deepEqual(received, { fade_in: 250, fade_out: 900, params: [] });
  }
});

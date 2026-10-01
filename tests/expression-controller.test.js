import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ExpressionController, registerExpressionNodes } from "../src/expression-controller.js";
import { composeHumanoidHeadBody } from "../src/skeleton-composer.js";
import { createDefaultPassObject } from "../src/shader-passes.js";
import { MotionPlayer } from "../src/motion-player.js";
import { BehaviorManager, BehaviorRegistry } from "../src/model-behaviors.js";

function fixture() {
  const root = new THREE.Object3D();
  const face = new THREE.Object3D();
  face.name = "face";
  face.morphTargetDictionary = { joy: 0, close: 1, sad: 2, a: 3, i: 4, unrelated: 5 };
  face.morphTargetInfluences = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  root.add(face);
  register(root, [[face, { nodes: 0, meshes: 0, primitives: 0 }]], [{ name: "face" }]);
  return { root, face };
}
function register(root, entries, nodes) {
  registerExpressionNodes({ scene: root, parser: { associations: new Map(entries), json: { nodes } } });
}
function definition() {
  return {
    morphPoses: ["joy", "close", "sad", "a", "i"].map((name) => ({name, targets:{face:{[name]:1}}})),
    expressionGroups: [
      {name:"face",states:[
        {name:"Joy",poses:{joy:1},controls:{blink:{joy:0,close:1}}},
        {name:"Fixed",poses:{close:1}},
      ]},
      {name:"mouth",states:[
        {name:"Sad",poses:{sad:1},controls:{speech:{a:1},visemes:{a:{a:1},i:{sad:0,i:1}}}},
        {name:"Neutral",poses:{},controls:{speech:{a:0.8},visemes:{a:{a:0.8}}}},
      ]},
    ],
    expressions:[
      {name:"Sad",selections:{face:"Joy",mouth:"Sad"}},
      {name:"Fixed",selections:{face:"Fixed",mouth:"Neutral"}},
    ],
    defaultExpression:"Sad",
  };
}
function close(actual, expected) {
  actual.forEach((value, index) => assert.ok(Math.abs(value-expected[index])<1e-12, `${index}: ${value} != ${expected[index]}`));
}

test("expression query publishes immutable evaluated recipes, not mutable input or Morph guesses", () => {
  const {root,face}=fixture(); const d=definition();
  d.parameters={independent:{face:{unrelated:1}}};
  const c=new ExpressionController(root,d);
  assert.equal(c.getState(),null);
  c.setBlink(.25);c.setSpeech(.6);c.setParameter("independent",.4);c.update();
  const first=c.getState();
  assert.deepEqual(first.poseWeights,{joy:.75,close:.25,sad:1,a:.6});
  assert.equal(first.expression,"Sad");
  assert.deepEqual(first.parameters,{independent:.4});
  assert.throws(()=>{first.poseWeights.joy=9;},TypeError);
  c.setGroup("face","Fixed",0); c.setSpeech(.9);
  assert.equal(c.getState(),first);
  c.update();assert.equal(c.getState().expression,null);
  assert.equal(first.speech,.6);
  c.setMorphPoseWeights({sad:-.25,a:2});c.update();
  assert.equal(c.getState().expression,null);
  assert.deepEqual(c.getState().poseWeights,{sad:-.25,a:2});
  assert.deepEqual(c.getState().rawWeights,{sad:-.25,a:2});
  c.setActive(false);c.beginFrame();face.morphTargetInfluences[0]=.8;c.update();
  assert.equal(c.getState().active,false);
  assert.deepEqual(c.getState().poseWeights,{});
  assert.deepEqual(c.getState().rawWeights,{sad:-.25,a:2});
  assert.equal(face.morphTargetInfluences[0],.8);
  c.setActive(true);c.beginFrame();c.update();
  assert.deepEqual(c.getState().poseWeights,{sad:-.25,a:2});
  c.setMorphPoseWeights({});c.update();
  assert.equal(c.getState().active,true);
  assert.deepEqual(c.getState().poseWeights,{});
  c.reset();c.setVisemes({i:.2});c.update();
  assert.deepEqual(c.getState().visemes,{i:.2});
  assert.equal(c.getState().rawWeights,null);
  c.setMorphPoseWeights({a:Number.MAX_VALUE});
  c.poseBindings.get("a").values().next().value.weight=2;
  const previous=c.getState();
  assert.throws(()=>c.update(),/有限数/);
  assert.equal(c.getState(),previous);
});

test("composed components keep distinct expression queries after their nodes move to one root", async () => {
  const bodyRoot=new THREE.Group(),headRoot=new THREE.Group();
  const makeGltf=(root)=>{
    const face=new THREE.Object3D();face.name="face";
    face.morphTargetDictionary={amount:0};face.morphTargetInfluences=[0];root.add(face);
    const gltf={scene:root,parser:{associations:new Map([[face,{nodes:0,meshes:0,primitives:0}]]),json:{nodes:[{name:"face"}]}}};
    registerExpressionNodes(gltf);return {gltf,face};
  };
  const head=makeGltf(headRoot),body=makeGltf(bodyRoot);
  const def={morphPoses:[{name:"amount",targets:{face:{amount:1}}}],expressionGroups:[],expressions:[]};
  const parts=[{role:"head",root:headRoot,gltf:head.gltf,component:def},{role:"body",root:bodyRoot,gltf:body.gltf,component:def}];
  // This is the same root move performed by skeleton composition. Names now
  // collide across components, but original loader associations stay distinct.
  for(const child of [...headRoot.children])bodyRoot.attach(child);
  assert.equal(headRoot.children.length,0);
  const manager=new BehaviorManager({registry:new BehaviorRegistry(),parts,humanoidScale:1,context:{}});
  await manager.initialize();
  const controllers=parts.map(part=>{
    const c=new ExpressionController(bodyRoot,part.component,part.gltf);
    manager.setExpressionController(part.role,c);return c;
  });
  controllers[0].setMorphPoseWeights({amount:.3});
  controllers[1].setMorphPoseWeights({amount:.8});
  for(const c of controllers){c.beginFrame();c.update();}
  manager.afterMotion();
  assert.equal(head.face.morphTargetInfluences[0],.3);
  assert.equal(body.face.morphTargetInfluences[0],.8);
  const context=manager.createContext("test");
  assert.deepEqual(context.getExpressionState("head").poseWeights,{amount:.3});
  assert.deepEqual(context.getExpressionState("body").poseWeights,{amount:.8});
  manager.destroy();
});

test("sparse endpoints inherit base while explicit zero removes it", () => {
  const {root,face}=fixture();
  const c=new ExpressionController(root,definition());
  c.setBlink(0.25);c.setSpeech(0.63);c.update();
  close(face.morphTargetInfluences,[0.75,0.25,1,0.63,0,0.6]);
  c.setVisemes({a:0.4,i:0.2});c.update();
  close(face.morphTargetInfluences,[0.75,0.25,0.8,0.4,0.2,0.6]);
  c.setVisemes({i:0.2,a:0.4});c.update();
  close(face.morphTargetInfluences,[0.75,0.25,0.8,0.4,0.2,0.6]);
  c.setVisemes(null);c.update();
  close(face.morphTargetInfluences,[0.75,0.25,1,0.63,0,0.6]);
});
test("switching presets and groups preserves inputs but never stale Morphs",()=>{
  const {root,face}=fixture();const c=new ExpressionController(root,definition());
  c.setBlink(0.5);c.setVisemes({a:0.4,i:0.2});c.setExpression("Fixed",0);c.update();
  close(face.morphTargetInfluences,[0,1,0,0.32,0,0.6]);
  assert.deepEqual(c.visemes,{a:0.4,i:0.2});
  assert.deepEqual(c.getCapabilities().visemes,["a"]);
  assert.deepEqual(c.getCapabilities().validVisemes,["a","i"]);
  c.setGroup("mouth","Sad",0);c.update();
  close(face.morphTargetInfluences,[0,1,0.8,0.4,0.2,0.6]);
  c.setExpression("Sad",0);c.update();
  close(face.morphTargetInfluences,[0.5,0.5,0.8,0.4,0.2,0.6]);
  c.reset();c.update();close(face.morphTargetInfluences,[1,0,1,0,0,0.6]);
});
test("preset and group transitions blend rendered recipes and Behavior snapshots",()=>{
  const {root,face}=fixture();const c=new ExpressionController(root,definition());
  c.update();
  c.setExpression("Fixed");
  assert.ok(c.transition?.duration>0);
  c.update(c.transition.duration/2);
  close(face.morphTargetInfluences,[.5,.5,.5,0,0,.6]);
  assert.deepEqual(c.getState().poseWeights,{joy:.5,close:.5,sad:.5,a:0});
  c.setGroup("mouth","Sad",.4);
  c.update(.2);
  close(face.morphTargetInfluences,[.25,.75,.75,0,0,.6]);
  assert.deepEqual(c.getState().poseWeights,{joy:.25,close:.75,sad:.75,a:0});
  c.update(.2);
  close(face.morphTargetInfluences,[0,1,1,0,0,.6]);
  c.setExpression("Sad",0);c.update(0);
  close(face.morphTargetInfluences,[1,0,1,0,0,.6]);
  assert.equal(c.transition,null);
});
test("transition preserves blink and speech input and rejects invalid durations",()=>{
  const {root,face}=fixture();const c=new ExpressionController(root,definition());
  c.update();c.setBlink(.2);c.setSpeech(.4);
  c.setExpression("Fixed",.2);c.update(.1);
  close(face.morphTargetInfluences,[.5,.5,.5,.16,0,.6]);
  assert.deepEqual(c.getState().poseWeights,{joy:.5,close:.5,sad:.5,a:.16000000000000003});
  c.update(.1);
  close(face.morphTargetInfluences,[0,1,0,.32,0,.6]);
  for(const duration of [-1,NaN,Infinity,"0.2",null]) {
    assert.throws(()=>c.setExpression("Sad",duration));
    assert.throws(()=>c.setGroup("mouth","Sad",duration));
  }
});
test("raw mixing is exclusive, additive, unnormalized and unclamped",()=>{
  const {root,face}=fixture();const d=definition();
  d.morphPoses.push({name:"double",targets:{face:{a:2,sad:-1}}});
  const c=new ExpressionController(root,d);
  c.setMorphPoseWeights({double:2,a:-0.5});c.setBlink(1);c.setSpeech(1);c.update();
  close(face.morphTargetInfluences,[0,0,-2,3.5,0,0.6]);
  c.setGroup("mouth","Sad",0);c.update();close(face.morphTargetInfluences,[0,1,1,1,0,0.6]);
  c.setMorphPoseWeights({});c.update();close(face.morphTargetInfluences,[0,0,0,0,0,0.6]);
});
test("different groups add actual Morph contributions rather than overriding",()=>{
  const {root,face}=fixture();const d=definition();
  d.expressionGroups[0].states[0].poses.sad=0.5;
  const c=new ExpressionController(root,d);c.update();
  assert.equal(face.morphTargetInfluences[2],1.5);
});
test("invalid input throws without changing previous state",()=>{
  const {root}=fixture();const c=new ExpressionController(root,definition());
  for(const value of [NaN,Infinity,-0.1,1.1,"0.5",null]) {
    assert.throws(()=>c.setBlink(value));assert.throws(()=>c.setSpeech(value));
  }
  for(const values of [{a:0.6,i:0.5},{a:-0.1},{a:NaN},{unknown:0},[]]) assert.throws(()=>c.setVisemes(values));
  assert.throws(()=>c.setMorphPoseWeights({unknown:1}));
  assert.throws(()=>c.setMorphPoseWeights({a:Infinity}));
  assert.throws(()=>c.setGroup("mouth","missing"));
  assert.throws(()=>c.setExpression("missing"));
  assert.throws(()=>c.setActive(1));
  c.setMorphPoseWeights({a:Number.MAX_VALUE});
  c.poseBindings.get("a").values().next().value.weight=2;
  assert.throws(()=>c.update(),/有限数/);
});
test("actual Morph difference conflict is rejected even with different pose names",()=>{
  const {root}=fixture();const d=definition();
  d.morphPoses.push({name:"alias",targets:{face:{close:1}}});
  d.expressionGroups[0].states[0].controls.speech={alias:1};
  assert.throws(()=>new ExpressionController(root,d),/同一实际 Morph/);
  d.expressionGroups[0].states[0].poses.alias=1;
  // Endpoint equal to baseline makes no change, and is therefore legal.
  assert.doesNotThrow(()=>new ExpressionController(root,d));
});
test("original GLTF names resolve strictly and missing Morphs fail",()=>{
  const {root,face}=fixture();face.userData.name="face original";
  register(root,[[face,{nodes:0,meshes:0,primitives:0}]],[{name:"face original"}]);
  assert.throws(()=>new ExpressionController(root,definition()),/唯一命中/);
  face.userData.name="face";
  const duplicate=face.clone();root.add(duplicate);
  register(root,[[face,{nodes:0,meshes:0,primitives:0}],[duplicate,{nodes:1,meshes:1,primitives:0}]],[{name:"face"},{name:"face"}]);
  assert.throws(()=>new ExpressionController(root,definition()),/实际 2/);
  root.remove(duplicate);delete face.morphTargetDictionary.sad;
  assert.throws(()=>new ExpressionController(root,definition()),/Morph 不存在/);
});
test("every primitive is synchronized and shader clones do not create ambiguity",()=>{
  const {root,face}=fixture();
  const group=new THREE.Group();group.name="face";
  root.remove(face);face.name="primitive 1";group.add(face);root.add(group);
  const second=face.clone();second.name="primitive 2";
  second.morphTargetDictionary={...face.morphTargetDictionary};
  second.morphTargetInfluences=[...face.morphTargetInfluences];group.add(second);
  const clone=group.clone(true);clone.userData.__parameterizedPassObject=true;root.add(clone);
  register(root,[[group,{nodes:0,meshes:0}],[face,{meshes:0,primitives:0}],[second,{meshes:0,primitives:1}]],[{name:"face"}]);
  const c=new ExpressionController(root,definition());c.setSpeech(0.5);c.update();
  assert.deepEqual(face.morphTargetInfluences,second.morphTargetInfluences);
  assert.equal(face.morphTargetInfluences[3],0.5);
});
test("beginFrame removes expression before animation; deactivation restores once",()=>{
  const {root,face}=fixture();const c=new ExpressionController(root,definition());
  c.beginFrame();face.morphTargetInfluences[3]=0.7;c.update();
  assert.equal(face.morphTargetInfluences[3],0);
  c.setActive(false);c.beginFrame();
  close(face.morphTargetInfluences,[0.1,0.2,0.3,0.4,0.5,0.6]);
  face.morphTargetInfluences[3]=0.7;c.update();assert.equal(face.morphTargetInfluences[3],0.7);
  c.beginFrame();assert.equal(face.morphTargetInfluences[3],0.7);
  c.setSpeech(0.6);c.setActive(true);c.beginFrame();c.update();
  assert.equal(face.morphTargetInfluences[3],0.6);
});
test("real MotionPlayer captures initial Morph after pre-construction beginFrame and relinquishes ownership cleanly",()=>{
  const {root,face}=fixture();
  const c=new ExpressionController(root,definition());
  c.setBlink(0.25);c.setSpeech(0.9);c.update();
  assert.equal(face.morphTargetInfluences[3],0.9);
  const payload={
    clips:[{id:"idle",duration:1,sampleRate:1,frames:2,tracks:[],
      groupTracks:[{kind:"morph",node:"face",property:"a",values:[0.25,0.75]}]}],
    auxiliaryClips:[],leftHandPoses:[],rightHandPoses:[],
    program:{parameters:[],commands:{},baseLayer:"Base",poseSlots:[],layers:[{
      id:"Base",blend:"override",weight:1,initialState:"idle",
      states:[{id:"idle",clip:"idle",speed:1,loop:false,transitions:[]}],
    }]},
  };
  // This call is also required before MotionPlayer captures its restore state.
  c.beginFrame();
  const motion=new MotionPlayer(root,1,payload,"fixture","fixture");
  assert.equal(motion.groupTrackResolvedCount,1);
  const frame=(delta)=>{c.beginFrame();motion.update(delta);c.update();};
  frame(0);
  assert.equal(face.morphTargetInfluences[3],0.9);
  c.setActive(false);frame(0);
  assert.equal(face.morphTargetInfluences[3],0.25);
  frame(1);
  assert.equal(face.morphTargetInfluences[3],0.75);
  motion.dispose();
  assert.equal(face.morphTargetInfluences[3],0.4);
  c.beginFrame();c.update();
  assert.equal(face.morphTargetInfluences[3],0.4);
  c.setActive(true);c.beginFrame();c.update();
  close(face.morphTargetInfluences,[0.75,0.25,1,0.9,0,0.6]);
  assert.equal(c.speech,0.9);
  assert.equal(c.blink,0.25);
});
test("default shader pass synchronizes expression results before drawing",()=>{
  const {root,face}=fixture();
  const pass=createDefaultPassObject(face,{},"Extra");
  pass.userData.__parameterizedPassObject=true;
  pass.morphTargetInfluences=[...face.morphTargetInfluences];
  const c=new ExpressionController(root,definition());c.setSpeech(0.63);c.update();
  pass.onBeforeRender();
  assert.deepEqual(pass.morphTargetInfluences,face.morphTargetInfluences);
});
test("distinct Morph names resolving to the same index still conflict",()=>{
  const {root,face}=fixture();const d=definition();
  face.morphTargetDictionary.aliasClose=1;
  d.morphPoses.push({name:"alias",targets:{face:{aliasClose:1}}});
  d.expressionGroups[0].states[0].controls.speech={alias:1};
  assert.throws(()=>new ExpressionController(root,d),/同一实际 Morph/);
  assert.equal(face.morphTargetInfluences[1],0.2);
});
test("without default preset the first declared states are selected",()=>{
  const {root}=fixture();const d=definition();delete d.defaultExpression;
  d.expressionGroups[0].states.reverse();
  const c=new ExpressionController(root,d);
  assert.equal(c.selections.get("face"),"Fixed");
  c.setExpression("Sad");c.setSpeech(1);c.reset();
  assert.equal(c.selections.get("face"),"Fixed");assert.equal(c.speech,0);
});
test("named and unnamed child GLTF nodes are not primitives of their parent",()=>{
  for (const childName of ["Child", undefined]) {
    const {root,face}=fixture();
    const child=new THREE.Object3D();
    child.name="looks_like_primitive";child.morphTargetDictionary={...face.morphTargetDictionary};
    child.morphTargetInfluences=[0.2,0.3,0.4,0.5,0.6,0.7];face.add(child);
    register(root,[[face,{nodes:0,meshes:0,primitives:0}],[child,{nodes:1,meshes:1,primitives:0}]],[{name:"face"},{name:childName}]);
    const c=new ExpressionController(root,definition());c.setSpeech(0.63);c.update();
    close(child.morphTargetInfluences,[0.2,0.3,0.4,0.5,0.6,0.7]);
  }
});
test("each primitive must contain every declared Morph target",()=>{
  const {root,face}=fixture();const group=new THREE.Group();
  root.remove(face);root.add(group);group.add(face);
  const other=new THREE.Object3D();other.morphTargetDictionary={...face.morphTargetDictionary};
  other.morphTargetInfluences=[0,0,0,0,0,0];group.add(other);
  delete other.morphTargetDictionary.sad;
  register(root,[[group,{nodes:0,meshes:0}],[face,{meshes:0,primitives:0}],[other,{meshes:0,primitives:1}]],[{name:"face"}]);
  assert.throws(()=>new ExpressionController(root,definition()),/全部 primitive/);
  delete other.morphTargetDictionary;
  assert.throws(()=>new ExpressionController(root,definition()),/全部 primitive/);
});
test("valid recipe identifiers never inherit Object prototype values",()=>{
  const {root,face}=fixture();const d=definition();
  for (const name of ["toString","constructor","__proto__"]) d.morphPoses.push({name,targets:{face:{a:1}}});
  d.expressionGroups[1].states[0].poses={};
  d.expressionGroups[1].states[0].controls={speech:JSON.parse('{"toString":0.2,"constructor":0.3,"__proto__":0.4}')};
  const c=new ExpressionController(root,d);c.setSpeech(0.5);c.update();
  assert.ok(Math.abs(face.morphTargetInfluences[3]-0.45)<1e-12);
});
test("scene display names without GLTF association cannot bind targets",()=>{
  const root=new THREE.Object3D();const face=new THREE.Object3D();face.name="face";
  face.morphTargetDictionary={joy:0};face.morphTargetInfluences=[0];root.add(face);
  assert.throws(()=>new ExpressionController(root,definition()),/实际 0/);
});
test("real GLTFLoader associations distinguish own primitives and child nodes",async()=>{
  const primitive={attributes:{POSITION:0},targets:[{POSITION:1}]};
  const gltf=await new GLTFLoader().parseAsync(JSON.stringify({
    asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],
    nodes:[{name:"Face original",mesh:0,children:[1,2]},{name:"Child",mesh:1},{mesh:1}],
    meshes:[{primitives:[primitive,primitive],extras:{targetNames:["smile"]}},{primitives:[primitive],extras:{targetNames:["smile"]}}],
    accessors:[0,1].map(()=>({componentType:5126,count:3,type:"VEC3",min:[0,0,0],max:[0,0,0]})),
  }),"");
  registerExpressionNodes(gltf);
  const c=new ExpressionController(gltf.scene,{
    morphPoses:[{name:"smile",targets:{"Face original":{smile:1}}}],
    expressionGroups:[],expressions:[],
  });
  c.setMorphPoseWeights({smile:0.63});c.update();
  const actual=[];
  gltf.scene.traverse((object)=>{
    const a=gltf.parser.associations.get(object);
    if(a?.primitives!==undefined) actual.push({mesh:a.meshes,value:object.morphTargetInfluences[0]});
  });
  assert.deepEqual(actual,[{mesh:0,value:0.63},{mesh:0,value:0.63},{mesh:1,value:0},{mesh:1,value:0}]);
});
test("independent parameters remain unchanged by expression reset",()=>{
  const {root,face}=fixture();const d=definition();
  d.parameters={size:{face:{unrelated:1}}};
  const c=new ExpressionController(root,d);c.setParameter("size",0.6);c.reset();c.update();
  assert.equal(face.morphTargetInfluences[5],0.6);
  d.parameters={size:{face:{a:1}}};
  assert.throws(()=>new ExpressionController(root,d),/重复拥有 Morph/);
});
test("empty capabilities leave unmanaged Morphs alone",()=>{
  const {root,face}=fixture();const c=new ExpressionController(root,{morphPoses:[],expressionGroups:[],expressions:[]});
  c.setBlink(1);c.setSpeech(1);c.update();
  close(face.morphTargetInfluences,[0.1,0.2,0.3,0.4,0.5,0.6]);
  assert.equal(c.getCapabilities().blink,false);
});

test("composition rebinds head skins to the body rig and keeps auxiliary bones", () => {
  const bodyRoot = new THREE.Object3D();
  const bodyHips = new THREE.Bone();
  const bodyHead = new THREE.Bone();
  bodyHips.name = "Hips";
  bodyHead.name = "Head";
  bodyHips.add(bodyHead);
  bodyRoot.add(bodyHips);

  const headRoot = new THREE.Object3D();
  const headHips = new THREE.Bone();
  const headHead = new THREE.Bone();
  const hair = new THREE.Bone();
  headHips.name = "Hips";
  headHead.name = "Head";
  hair.name = "HairRoot";
  headHips.add(headHead);
  headHead.add(hair);
  headRoot.add(headHips);

  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.name = "HeadMesh";
  mesh.bind(new THREE.Skeleton(
    [headHips, headHead, hair],
    [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
  ));
  headRoot.add(mesh);

  const result = composeHumanoidHeadBody(bodyRoot, headRoot);

  assert.deepEqual(mesh.skeleton.bones, [bodyHips, bodyHead, hair]);
  assert.equal(hair.parent, bodyHead);
  assert.equal(headHips.parent, null);
  assert.equal(mesh.parent, bodyRoot);
  assert.equal(result.skins, 1);
  assert.equal(result.reboundJoints, 2);
  assert.equal(result.removedRigRoots, 1);
  mesh.skeleton.boneInverses.forEach((inverse, index) => {
    const bindProduct = mesh.skeleton.bones[index].matrixWorld.clone().multiply(inverse);
    assert.ok(bindProduct.equals(new THREE.Matrix4()));
  });
});

test("composition maps a missing head skin bone to the nearest body ancestor", () => {
  const bodyRoot = new THREE.Object3D();
  const bodyHips = new THREE.Bone();
  const bodySpine = new THREE.Bone();
  bodyHips.name = "Hips";
  bodySpine.name = "Spine";
  bodyHips.add(bodySpine);
  bodyRoot.add(bodyHips);

  const headRoot = new THREE.Object3D();
  const headHips = new THREE.Bone();
  const headSpine = new THREE.Bone();
  const headChest = new THREE.Bone();
  const headUpperChest = new THREE.Bone();
  headHips.name = "Hips";
  headSpine.name = "Spine";
  headChest.name = "Chest";
  headUpperChest.name = "UpperChest";
  headHips.add(headSpine);
  headSpine.add(headChest);
  headChest.add(headUpperChest);
  headRoot.add(headHips);
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.name = "HeadMesh";
  mesh.bind(new THREE.Skeleton(
    [headHips, headUpperChest],
    [new THREE.Matrix4(), new THREE.Matrix4()],
  ));
  headRoot.add(mesh);

  const result = composeHumanoidHeadBody(bodyRoot, headRoot);
  assert.deepEqual(mesh.skeleton.bones, [bodyHips, bodySpine]);
  assert.deepEqual(result.fallbackBones, [
    { source: "Chest", target: "Spine" },
    { source: "UpperChest", target: "Spine" },
  ]);
});

test("composition recognizes unused GLTF joints loaded as Object3D", () => {
  const bodyRoot = new THREE.Object3D();
  const bodyHips = new THREE.Object3D();
  bodyHips.name = "Hips";
  bodyRoot.add(bodyHips);

  const headRoot = new THREE.Object3D();
  const headHips = new THREE.Object3D();
  headHips.name = "Hips";
  const attachment = new THREE.Object3D();
  attachment.name = "HeadAccessory";
  headHips.add(attachment);
  headRoot.add(headHips);

  const result = composeHumanoidHeadBody(bodyRoot, headRoot);
  assert.equal(result.bodyCoreBones, 1);
  assert.equal(result.headCoreBones, 1);
  assert.equal(attachment.parent, bodyHips);
});

test("composition preserves skin and auxiliary world pose across different joint frames", () => {
  const makeRig = (rotation) => {
    const root = new THREE.Object3D();
    const hips = new THREE.Bone();
    const head = new THREE.Bone();
    hips.name = "Hips";
    hips.position.y = 1;
    head.name = "Head";
    head.position.set(0.02, 0.6, -0.03);
    head.quaternion.setFromEuler(rotation);
    hips.add(head);
    root.add(hips);
    root.updateMatrixWorld(true);
    return { root, hips, head };
  };
  const body = makeRig(new THREE.Euler(0.3, -0.2, 0.5));
  const head = makeRig(new THREE.Euler(-0.4, 0.6, -0.1));
  const hair = new THREE.Bone();
  hair.name = "Hair";
  hair.position.set(0.1, 0.08, -0.12);
  hair.quaternion.setFromEuler(new THREE.Euler(0.1, 0.2, 0.3));
  head.head.add(hair);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0.2, 1.7, -0.15], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 1, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([0.6, 0.4, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  head.root.add(mesh);
  head.root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([head.head, hair]));
  const vertexWorld = () => mesh.localToWorld(mesh.applyBoneTransform(
    0, new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), 0),
  ));
  mesh.skeleton.update();
  const vertexBefore = vertexWorld();
  const hairBefore = hair.matrixWorld.clone();

  composeHumanoidHeadBody(body.root, head.root);
  body.root.updateMatrixWorld(true);
  mesh.skeleton.update();

  assert.equal(mesh.skeleton.bones[0], body.head);
  assert.equal(hair.parent, body.head);
  assert.ok(vertexWorld().distanceTo(vertexBefore) < 1e-7);
  assert.ok(hair.matrixWorld.elements.every((value, index) => Math.abs(value - hairBefore.elements[index]) < 1e-9));
  geometry.dispose();
  mesh.material.dispose();
});

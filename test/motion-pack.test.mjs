// Motion packs (the shared clip library, draft): hyprune motion check and the library check of
// motion/<id>/ - motion.json 0.1, clips-only rigs with the skeleton's bones and named animations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateMotionPack,canonicalBone,validateMotion,motionClipName} from '../dist/src/index.js';

const BONES=['Hips','Spine','Head','LeftArm','RightArm','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
const rig=(animations,{prefix='mixamorig:',bones=BONES,mesh=false}={})=>({asset:{version:'2.0'},
 nodes:bones.map(n=>({name:prefix+n})),skins:[{joints:bones.map((_,i)=>i)}],animations:animations.map(name=>({name,channels:[],samplers:[]})),
 ...(mesh?{meshes:[{primitives:[]}]}:{})});
const manifest=(over={})=>({motionVersion:'0.1',id:'moves',name:'Moves',skeleton:{id:'mixamo-v1'},license:'CC-BY-4.0',
 attribution:[{path:'.',author:'Example',license:'CC-BY-4.0'}],rigs:[{id:'a',scene:'a.glb'}],
 clips:[{name:'walk-proud',role:'walk',style:'proud',rig:'a'},{name:'dance-spin',role:'dance',style:'spin',rig:'a',clip:'Spin'}],...over});
// A GLB with only its JSON chunk (the check reads the document, not the buffers).
const glb=doc=>{let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);
 const head=Buffer.alloc(20);head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(20+json.length,8);head.writeUInt32LE(json.length,12);head.writeUInt32LE(0x4e4f534a,16);
 return Buffer.concat([head,json]);};
async function pack(t,{json=manifest(),rigs={'a.glb':rig(['walk-proud','Spin'])},extra={}}={}) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-motion-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'motion.json'),JSON.stringify(json));
 for(const [name,doc] of Object.entries({...rigs,...extra}))await writeFile(join(dir,name),typeof doc==='string'?doc:glb(doc));
 return dir;
}

test('motion helpers: canonical bones and the names characters play',()=>{
 assert.equal(canonicalBone('mixamorig:LeftUpLeg'),'leftupleg');assert.equal(canonicalBone('Hips'),'hips');
 assert.equal(motionClipName('dance','hip-hop'),'dance_hip_hop');assert.equal(motionClipName('sit-down'),'sit');
 assert.ok(validateMotion(manifest()).valid);
});

test('motion check: a valid pack',async t=>{
 const r=await validateMotionPack(await pack(t));
 assert.equal(r.clips,2);assert.equal(r.rigs,1);assert.match(r.digest,/^[0-9a-f]{64}$/);
});

test('motion check refuses stray files, meshes, missing bones and missing animations',async t=>{
 const cases=[
  [{extra:{'notes.txt':'hi'}},/notes.txt is not part of the pack/],
  [{rigs:{'a.glb':rig(['walk-proud','Spin'],{mesh:true})}},/has meshes/],
  [{rigs:{'a.glb':rig(['walk-proud','Spin'],{bones:BONES.filter(b=>b!=='LeftFoot')})}},/no leftfoot bone/],
  [{rigs:{'a.glb':rig(['walk-proud'])}},/clip dance-spin: rig a has no animation Spin/],
  [{rigs:{}},/rig a: missing a.glb/],
  [{json:manifest({clips:[{name:'dance',role:'dance',rig:'a'}]})},/a dance needs a style|must have required property|must match/],
 ];
 for(const [opts,error] of cases)await assert.rejects(validateMotionPack(await pack(t,opts)),error,String(error));
});

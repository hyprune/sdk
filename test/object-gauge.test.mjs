// RFC-0013 (object format 0.10 draft) gauge rules in `hyprune object check`: the running
// average modifier, levels slots and level: targets, stack cap and rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {validateObject} from '../dist/src/index.js';
import {sceneGltf,writeObject} from './object-fixtures.mjs';

const pose=position=>({position,rotation:[0,0,0,1]});
// The fixture triangle drawn by every gauge part; node 1 stays the off-scene proxy.
function gaugeGltf() {
 const g=sceneGltf();
 for(const name of ['liquid','liquid-surface','average-ring','bead']) g.nodes.push({name,mesh:0});
 g.scenes[0].nodes=[0,2,3,4,5];
 return g;
}
function gaugeJson(id) {
 const palette=[['ok',[1,0.62,0.12],1.6],['warn',[1,0.36,0.05],1.6],['fail',[0.9,0.07,0.03],1.6],['stale',[0.35,0.33,0.3],0.2]].map(([id,colour,emission])=>({id,colour,emission}));
 const scale={from:[0,100],to:[0,1]};
 return {formatVersion:'0.10',id,version:'1.0.0',name:'Gauge',category:'machines',scene:'object.gltf',license:'CC0-1.0',
  attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],bounds:{min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]},thumbnail:'thumbnail.png',
  traits:{collidable:{node:'proxy'},movable:{surfaces:['floor']},machine:{primary:'level',
   inputs:[
    {id:'value',type:'number',min:0,max:100,default:0,label:'Value',explain:'The reading.'},
    {id:'display',type:'text',maxLength:12,label:'Display',explain:'The reading as text.'},
    {id:'level',type:'enum',values:['ok','warn','fail'],default:'ok',label:'Level',explain:'The fill colour.'},
    {id:'average',type:'number',min:0,max:100,label:'Average',explain:'An average the source computed.'},
    {id:'tick',type:'event',label:'Tick',explain:'A pulse.'}],
   drives:[
    {input:'level',target:'state:fill'},
    {input:'display',target:'label:display'},
    {input:'value',target:'level:liquid',map:{scale}},
    {input:'value',target:'count:beads',map:{scale:{from:[0,100],to:[0,100]},round:'floor'}},
    {input:'value',target:'level:average-ring',map:{average:{windowS:60,override:'average'},scale}}]}},
  slots:{
   states:[{id:'fill',nodes:['liquid'],palette}],
   labels:[{id:'display',pose:pose([0,0.2,0.26]),size:[0.3,0.08],maxChars:12,font:'mono'}],
   levels:[
    {id:'liquid',node:'liquid',mode:'fill',axis:[0,1,0],length:1,surface:'liquid-surface',settle:'spring'},
    {id:'average-ring',node:'average-ring',mode:'slide',length:1}],
   stacks:[{id:'beads',node:'bead',cap:100,rate:40,layout:{grid:[10,10,1],spacing:[0.02,0.02,0],fill:'xyz'}}]}};
}
async function gauge(t) {
 const root=await mkdtemp(join(tmpdir(),'hyprune-gauge-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,'gauge');await writeObject(dir);
 await writeFile(join(dir,'object.json'),JSON.stringify(gaugeJson('gauge')));
 await writeFile(join(dir,'object.gltf'),JSON.stringify(gaugeGltf()));
 return dir;
}
async function edit(path,fn) {const v=JSON.parse(await readFile(path));fn(v);await writeFile(path,JSON.stringify(v));}
// Applies one change to a fresh copy of the gauge and expects the check to fail with `pattern`.
async function rejects(t,change,pattern,file='object.json') {
 const dir=await gauge(t);await edit(join(dir,file),change);
 await assert.rejects(validateObject(dir),pattern);
}
const lastDrive=m=>m.traits.machine.drives.at(-1);

test('a gauge with levels, an averaged drive and a rated stack passes object check',async t=>{
 const result=await validateObject(await gauge(t));
 assert.equal(result.manifest.formatVersion,'0.10');
 assert.deepEqual(result.manifest.slots.levels.map(l=>l.mode),['fill','slide']);
});
test('average composes with value forms only and needs a numeric input',async t=>{
 await rejects(t,m=>lastDrive(m).map={average:{},becomes:1},/must NOT be valid/);
 await rejects(t,m=>lastDrive(m).map={average:{},counter:true},/must NOT be valid/);
 await rejects(t,m=>lastDrive(m).map.average.windowS=0,/windowS must be >= 1/);
 await rejects(t,m=>lastDrive(m).map.average.windowS=3601,/windowS must be <= 3600/);
 await rejects(t,m=>lastDrive(m).input='display',/average needs an int or number input/);
 // A direct average keeps the input's range: 0-100 doesn't fit a level.
 await rejects(t,m=>lastDrive(m).map={average:{}},/range 0-100 exceeds 0-1/);
 const dir=await gauge(t);
 await edit(join(dir,'object.json'),m=>m.traits.machine.drives.push({input:'value',target:'label:display',map:{average:{windowS:300},format:{decimals:0}}}));
 await validateObject(dir);
});
test('average override names another value input of the machine',async t=>{
 await rejects(t,m=>lastDrive(m).map.average.override='nope',/average override: unknown input nope/);
 await rejects(t,m=>lastDrive(m).map.average.override='value',/average override must name another input/);
 await rejects(t,m=>lastDrive(m).map.average.override='tick',/average override tick must be a value input, not event/);
});
test('level: targets resolve to a levels slot',async t=>{
 await rejects(t,m=>lastDrive(m).target='level:ring',/unknown level target "ring"/);
 await rejects(t,m=>m.slots.levels.pop(),/unknown level target "average-ring"/);
});
test('levels slots: fields, glTF nodes and the surface',async t=>{
 await rejects(t,m=>m.slots.levels[0].mode='pour',/must be equal to one of the allowed values/);
 await rejects(t,m=>m.slots.levels[0].length=11,/length must be <= 10/);
 await rejects(t,m=>m.slots.levels[0].length=0,/length must be > 0/);
 await rejects(t,m=>m.slots.levels[0].axis=[0,0.5,0],/slots\.levels liquid: axis must be a unit vector/);
 await rejects(t,m=>m.slots.levels[1].surface='liquid-surface',/must NOT be valid/);
 await rejects(t,m=>m.slots.levels[1].node='missing',/slots\.levels average-ring: node "missing" not found in the glTF/);
 await rejects(t,m=>m.slots.levels[0].surface='lid',/slots\.levels liquid: node "lid" not found in the glTF/);
 await rejects(t,g=>{g.nodes[2].children=[3];g.scenes[0].nodes=[0,2,4,5];},/surface "liquid-surface" must not be inside the fill node's subtree/,'object.gltf');
});
test('stacks: cap up to 100 and a rate up to 1000 copies per second',async t=>{
 await rejects(t,m=>{m.slots.stacks[0].cap=101;m.slots.stacks[0].layout.grid=[11,10,1];},/cap must be <= 100/);
 await rejects(t,m=>m.slots.stacks[0].rate=1001,/rate must be <= 1000/);
 await rejects(t,m=>m.slots.stacks[0].rate=-1,/rate must be >= 0/);
});
test('CLI object check reports gauge errors and exits 1',async t=>{
 const dir=await gauge(t);
 const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,args);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
 const ok=await run(['dist/src/cli.js','object','check',dir]);assert.equal(ok.code,0,ok.err);
 await edit(join(dir,'object.json'),m=>lastDrive(m).map.average.override='value');
 const bad=await run(['dist/src/cli.js','object','check',dir]);assert.equal(bad.code,1);assert.match(bad.err,/average override must name another input/);
});

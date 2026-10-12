// IPC 0.23 (RFC-0010/RFC-0011 P2): characters, paths and interactions at the wire level.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWire,validateManifest,PROTOCOLS,atLeast} from '../dist/src/validation.js';
const req=(method,params)=>({jsonrpc:'2.0',id:'n1',method,params});
const res=result=>({jsonrpc:'2.0',id:'n1',result});
const schema=v=>JSON.parse(readFileSync(new URL(`../vendor/schema/v${v}/ipc.schema.json`,import.meta.url)));
const route=[{position:[0,0,0],type:'line'},{position:[3,0,0],type:'curve'}];
test('IPC 0.23 npcs, paths and interaction.choose requests; 0.22 frozen',()=>{
 assert.ok(PROTOCOLS.includes('0.23'));assert.ok(atLeast('0.23','0.22') && !atLeast('0.22','0.23'));
 const calls=[
  ['npcs.spawn',{ref:'package/guide',path:'loop',phase:.5,speed:1,accent:null}],['npcs.spawn',{ref:'user/guide',pose:{position:[0,0,0],rotation:[0,0,0,1]}}],
  ['npcs.spawn',{ref:'library/com.example.kit@1.0.0/porter',path:'user/path-1',reverse:true}],['npcs.bind',{id:'u-1',speed:2}],
  ['npcs.disable',{id:'keeper',disabled:false}],['npcs.remove',{id:'u-1'}],['npcs.remove',{all:true}],['paths.list',{}],
  ['paths.set',{path:{use:'route',closed:false,points:route}}],['paths.set',{path:{id:'path-2',name:'Loop',use:'track',closed:true,points:route,speed:2,stops:[{point:0}]}}],
  ['paths.remove',{id:'path-1',unbind:true}],['paths.draw',{}],['paths.draw',{use:'route',name:'Evening walk',bind:'u-1'}],['paths.finish',{}],
  ['interaction.choose',{objectId:'keeper',interactionId:'chat'}],['interaction.choose',{objectId:'keeper',interactionId:null}],
 ];
 for(const [method,params] of calls) {validateWire(req(method,params),'0.23');assert.throws(()=>validateWire(req(method,params),'0.22'),method);}
 for(const [method,params] of [
  ['npcs.spawn',{ref:'package/guide',path:'loop',pose:{position:[0,0,0],rotation:[0,0,0,1]}}],['npcs.spawn',{ref:'package/guide',reverse:true}],
  ['npcs.spawn',{ref:'package/guide',speed:3}],['npcs.spawn',{ref:'package/guide',phase:1}],['npcs.bind',{id:'u-1'}],
  ['npcs.remove',{all:false}],['paths.draw',{spawn:{ref:'package/guide'},bind:'u-1'}],['paths.set',{path:{use:'route',closed:false,points:route.slice(0,1)}}],
  ['paths.set',{path:{use:'route',closed:false,points:route,stops:[{point:0,clip:'wave',seat:'stool'}]}}],['paths.remove',{id:'package/loop'}],
  ['interaction.choose',{objectId:'keeper'}],
 ]) assert.throws(()=>validateWire(req(method,params),'0.23'),JSON.stringify(params));
 validateWire(req('graphics.set',{patch:{npc_motion:'still'}}),'0.23');assert.throws(()=>validateWire(req('graphics.set',{patch:{npc_motion:'still'}}),'0.22'));
 validateWire(res({revision:3,id:null,bound:null}),'0.23','paths.finish');
 validateWire(res({paths:[{ref:'user/path-1',source:'user',id:'path-1',name:null,use:'route',closed:false,points:route,speed:null,stops:[],walkable:true,problems:[],bound:['u-1']}]}),'0.23','paths.list');
});
test('IPC 0.23 inherits every 0.22 definition outside the listed changes',()=>{
 const old=schema('0.22').$defs,latest=schema('0.23').$defs;
 const changed=new Set(['state','session.hello.result','state.delta.notification','request','response','editorPath','graphicsConfig','graphicsPatch','reticle','objectInstance']);
 for(const key of Object.keys(old))if(!changed.has(key))assert.deepEqual(latest[key],old[key],key);
 assert.equal(latest['session.hello.result'].properties.protocol.const,'0.23');
 // The changed shapes only add: every 0.22 property survives.
 for(const key of ['objectInstance','editorPath'])for(const p of Object.keys(old[key].properties))assert.ok(p in latest[key].properties,`${key}.${p}`);
 assert.equal(validateManifest('ipc',req('objects.catalog',{}),undefined,'0.23').valid,true);
});

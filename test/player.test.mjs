import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWire,validateManifest,PROTOCOLS} from '../dist/src/validation.js';
const req=(method,params)=>({jsonrpc:'2.0',id:'p1',method,params});
const schema=v=>JSON.parse(readFileSync(new URL(`../vendor/schema/v${v}/ipc.schema.json`,import.meta.url)));
const defaults={walk_speed:4,run_speed:10,view_bob:'subtle',reticle_style:'cross_dot',reticle_size:18,reticle_thickness:2,reticle_gap:4,
 reticle_opacity:.9,reticle_outline:true,reticle_colour:'theme',reticle_dynamic:true,reach_grab:15,reach_mount:8,reach_placement:12};
const settings={config:defaults,defaults,overrides:{},options:{view_bob:['off','subtle','normal'],reticle_style:['cross_dot','t_dot','circle_dot','dot','cross','chevron']},
 ranges:{walk_speed:[.5,20],run_speed:[.5,30],reticle_size:[6,64],reticle_thickness:[1,6],reticle_gap:[0,20],reticle_opacity:[.2,1],reach_grab:[1,100],reach_mount:[1,100],reach_placement:[1,100]},
 path:'/home/owner/.config/hyprune/player.json',error:''};
const interaction={mode:'movement',tool:1,tools:['pointer','mount','path','position','placement'],noclip:false,cursor:'reticle',taggedSurfaceId:null};
const delta=changes=>({jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:'sub',sessionId:'session',baseRevision:1,revision:2,changes}});
test('IPC 0.19 player settings, fov, overlay colours and reticle; 0.18 frozen',()=>{
 assert.ok(PROTOCOLS.includes('0.19'));
 validateWire(req('player.get',{}),'0.19');
 assert.throws(()=>validateWire(req('player.get',{}),'0.18'));
 for(const patch of [{walk_speed:6,run_speed:12},{reticle_colour:[0,1,0]},{reach_placement:null},{view_bob:'off',reticle_dynamic:false}]) {
  validateWire(req('player.set',{patch}),'0.19');assert.throws(()=>validateWire(req('player.set',{patch}),'0.18'));
 }
 for(const patch of [{},{walk_speed:25},{reticle_style:'square'},{reach_grab:0},{run_multiplier:2}])assert.throws(()=>validateWire(req('player.set',{patch}),'0.19'));
 validateWire({jsonrpc:'2.0',id:'p1',result:settings},'0.19','player.set');
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'p1',result:{...settings,overrides:{walk_speed:null}}},'0.19','player.get'));
 validateWire(req('graphics.set',{patch:{fov:120}}),'0.19');assert.throws(()=>validateWire(req('graphics.set',{patch:{fov:120}}),'0.18'));
 const colours={reticleColor:[1,1,1],validColor:[.35,.95,.6],invalidColor:[1,.62,.35]};
 validateWire(req('overlay.style',{leaseId:'l',style:colours}),'0.19');assert.throws(()=>validateWire(req('overlay.style',{leaseId:'l',style:colours}),'0.18'));
 validateWire(delta({interaction:{...interaction,reticle:{state:'out_of_range',action:'place'}}}),'0.19');
 assert.throws(()=>validateWire(delta({interaction}),'0.19'));
 validateWire(delta({interaction}),'0.18');
 assert.throws(()=>validateWire(delta({interaction:{...interaction,reticle:{state:'valid',action:'grab'}}}),'0.18'));
});
test('IPC 0.19 inherits every 0.18 definition outside the listed changes',()=>{
 const old=schema('0.18').$defs,latest=schema('0.19').$defs;
 const changed=new Set(['session.hello.result','request','response','graphicsConfig','graphicsPatch','overlayStyle','overlayStylePatch','interaction']);
 for(const key of Object.keys(old))if(!changed.has(key))assert.deepEqual(latest[key],old[key],key);
 assert.equal(latest['session.hello.result'].properties.protocol.const,'0.19');
 for(const patch of [{offload_device:'0000:65:00.0'},{offload_power_cap_w:null},{fov:120}])validateWire(req('graphics.set',{patch}),'0.19');
 assert.equal(validateManifest('ipc',req('player.get',{}),undefined,'0.19').valid,true);
});

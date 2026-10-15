// IPC 0.30 (draft, settings presets) on the validator: settings.get and settings.set (a preset,
// overrides set and reset, reset all) and the snapshot they return; 0.29 refuses them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';

const req=(method,params)=>({jsonrpc:'2.0',id:'s',method,params});
const res=result=>({jsonrpc:'2.0',id:'s',result});
const preset=(id,quality)=>({id,name:id,description:'',values:{'graphics.quality':quality},defaults:{'graphics.msaa':quality==='ultra'?4:1,'player.walk_speed':4}});
const snapshot={preset:'medium',presets:[preset('medium','medium'),preset('ultra','ultra')],
 settings:{'graphics.msaa':{value:2,default:1,source:'user'},'graphics.target_fps':{value:60,default:60,source:'lua'},'player.walk_speed':{value:4,default:4,source:'preset'}},
 overrides:1,keymapDefaults:JSON.parse(readFileSync(new URL('../vendor/schema/examples/input-v3.json',import.meta.url))),path:'/x/settings.json',error:''};

test('0.30 constants: negotiable',()=>{
 assert.ok(PROTOCOLS.includes('0.30'));
});

test('0.30 wire: settings.get and settings.set; 0.29 refuses them',()=>{
 for(const params of [{preset:'ultra'},{set:{'graphics.msaa':2,'player.walk_speed':5}},{reset:['graphics.msaa']},{resetAll:true}]){
  validateWire(req('settings.set',params),'0.30');
  assert.throws(()=>validateWire(req('settings.set',params),'0.29'));
 }
 validateWire(req('settings.get',{}),'0.30');
 assert.throws(()=>validateWire(req('settings.get',{}),'0.29'));
 validateWire(res(snapshot),'0.30','settings.get');
 validateWire(res(snapshot),'0.30','settings.set');
 assert.throws(()=>validateWire(res({...snapshot,settings:{'graphics.msaa':{value:2,default:1,source:'shell'}}}),'0.30','settings.get'));
});

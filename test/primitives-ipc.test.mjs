// IPC 0.31 (draft, primitives and materials) on the validator: placement keys, dry runs and asset
// swaps; 0.30 refuses them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';

const req=(method,params)=>({jsonrpc:'2.0',id:'p',method,params});
const res=result=>({jsonrpc:'2.0',id:'p',result});
const pose={position:[0,0,-3],rotation:[0,0,0,1]};

test('0.31 constants: negotiable',()=>{assert.ok(PROTOCOLS.includes('0.31'));});

test('0.31 wire: keys, dry runs and ref swaps; 0.30 refuses them',()=>{
 for(const [method,params] of [['objects.place',{ref:'world/box-1a2b3c4d',pose,key:'desk',ifExists:'update',dryRun:true}],
  ['objects.transform',{key:'desk',pose}],['objects.configure',{key:'desk',patch:{ref:'world/box-99aa00bb'}}],['objects.remove',{key:'desk'}]]) {
  validateWire(req(method,params),'0.31');
  assert.throws(()=>validateWire(req(method,params),'0.30'),method);
 }
 validateWire(res({revision:2,id:'u-1a2b3c',dryRun:true}),'0.31','objects.place');
 validateWire(res({revision:2,removed:false}),'0.31','objects.remove');
});

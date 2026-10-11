import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
const req=(method,params)=>({jsonrpc:'2.0',id:'p1',method,params});
const res=(result,method)=>({jsonrpc:'2.0',id:'p1',result});
const map={svg:'<svg/>',sha256:'a'.repeat(64),bounds:[0,0,1,1],worldToMap:[1,0,0,1,0,0]};
const level={id:'ground',name:'Ground',minY:-2,maxY:4.5,svg:'<svg/>',sha256:'b'.repeat(64)};
test('IPC 0.20 pocket methods and blueprint levels; 0.19 frozen',()=>{
 assert.ok(PROTOCOLS.includes('0.20'));
 for(const m of ['surface.pocket','surface.unpocket']){
  validateWire(req(m,{surfaceId:'surface-3'}),'0.20');
  assert.throws(()=>validateWire(req(m,{surfaceId:'surface-3'}),'0.19'));
  assert.throws(()=>validateWire(req(m,{}),'0.20'));
 }
 validateWire(res({revision:4}),'0.20','surface.pocket');
 validateWire(res({revision:4,placed:false}),'0.20','surface.unpocket');
 assert.throws(()=>validateWire(res({revision:4}),'0.20','surface.unpocket'));
 const snapshot=m=>({jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:'sub',sessionId:'s',baseRevision:1,revision:2,changes:{spatial:{world:null,map:m,output:null,projection:null}}}});
 validateWire(snapshot({...map,levels:[level,{...level,id:'upper',minY:4.5,maxY:40}]}),'0.20');
 validateWire(snapshot(map),'0.20');
 assert.throws(()=>validateWire(snapshot({...map,levels:[level]}),'0.19'));
 assert.throws(()=>validateWire(snapshot({...map,levels:[{...level,svg:''}]}),'0.20'));
});

// IPC 0.32 (draft, RFC-0015 content over IPC) on the validator: content, sources and registry
// methods and the content state key; 0.31 refuses them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';

const req=(method,params)=>({jsonrpc:'2.0',id:'s',method,params});
const res=result=>({jsonrpc:'2.0',id:'s',result});

test('0.32 constants: negotiable',()=>{
 assert.ok(PROTOCOLS.includes('0.32'));
});

test('0.32 wire: content, sources and registry methods; 0.31 refuses them',()=>{
 for(const [method,params] of [['content.install',{source:{entry:{sourceId:'official',id:'com.hyprune.companions'}}}],
  ['content.confirm',{jobId:'j-41f0',accept:true}],['content.update',{all:true}],['content.remove',{id:'com.hyprune.companions'}],
  ['sources.add',{github:'ada/tidepool-world'}],['sources.refresh',{}],['registry.list',{query:'companions',limit:10}],
  ['registry.entry',{sourceId:'official',id:'com.hyprune.companions'}]]){
  validateWire(req(method,params),'0.32');
  assert.throws(()=>validateWire(req(method,params),'0.31'),method);
 }
 assert.throws(()=>validateWire(req('content.install',{source:{github:'ada/tidepool-world'},sha256:'x'}),'0.32'));
 validateWire(res({jobId:'j-41f0'}),'0.32','content.install');
 validateWire(res({entries:[],cursor:null}),'0.32','registry.list');
});

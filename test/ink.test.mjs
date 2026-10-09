import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire} from '../dist/src/validation.js';
test('IPC 0.14 validates live ink tiers and inherits authoring camera',()=>{
 for(const quality of ['fast','smooth',null]) {
  const request={jsonrpc:'2.0',id:'ink',method:'graphics.set',params:{patch:{outline_quality:quality}}};
  validateWire(request,'0.14');assert.throws(()=>validateWire(request,'0.13'));
 }
 validateWire({jsonrpc:'2.0',id:'camera',method:'camera.photo',params:{position:[0,2,4],orientation:[0,0,0,1],fov:15,renderScale:.5}},'0.14');
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'bad',method:'graphics.set',params:{patch:{outline_quality:'ultra'}}},'0.14'));
});

test('IPC 0.15 exposes abstract tool bindings and keeps older contracts frozen',()=>{
 const config=JSON.parse(readFileSync(new URL('../vendor/schema/examples/placement-input.json',import.meta.url)));
 const frame={jsonrpc:'2.0',id:'slots',method:'input.preview',params:{config}};
 assert.doesNotThrow(()=>validateWire(frame,'0.15'));
 assert.throws(()=>validateWire(frame,'0.14'));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
const set=patch=>({jsonrpc:'2.0',id:'od',method:'graphics.set',params:{patch}});
test('IPC 0.18 automatic offload cap and offload device; 0.17 frozen',()=>{
 assert.ok(PROTOCOLS.includes('0.18'));
 for(const patch of [{offload_power_cap_w:null},{offload_power_cap_w:350},{offload_device:'auto'},{offload_device:'0000:65:00.0'}]) {
  validateWire(set(patch),'0.18');assert.throws(()=>validateWire(set(patch),'0.17'));
 }
 validateWire(set({offload_power_cap_w:80}),'0.17');
 for(const patch of [{offload_power_cap_w:10},{offload_power_cap_w:2000},{offload_device:'0000:65:00.0x'},{offload_device:'renderD128'},{offload_device:'0000:6A:00.0'}])
  assert.throws(()=>validateWire(set(patch),'0.18'),JSON.stringify(patch));
});

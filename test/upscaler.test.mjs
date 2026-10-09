import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
test('IPC 0.16 upscaler setting; 0.15 frozen; 0.16 inherits 0.15 graphics keys',()=>{
 assert.equal(PROTOCOLS.at(-1),'0.16');
 for(const upscaler of ['fsr1','bilinear',null]) {
  const request={jsonrpc:'2.0',id:'up',method:'graphics.set',params:{patch:{upscaler}}};
  validateWire(request,'0.16');assert.throws(()=>validateWire(request,'0.15'));
 }
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'bad',method:'graphics.set',params:{patch:{upscaler:'fsr2'}}},'0.16'));
 validateWire({jsonrpc:'2.0',id:'ink',method:'graphics.set',params:{patch:{outline_quality:'smooth',sharpen:.5}}},'0.16');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire} from '../dist/src/validation.js';
const request={jsonrpc:'2.0',id:'graphics',method:'graphics.set',params:{patch:{quality:'low',sharpen:.2,dynamic_resolution:true}}};
test('pinned graphics accepts exact 0.7 and 0.8 and rejects older protocols',()=>{
 for(const v of ['0.7','0.8'])assert.doesNotThrow(()=>validateWire(request,v));
 for(const v of ['0.1','0.2','0.3','0.4','0.5','0.6'])assert.throws(()=>validateWire(request,v));
 assert.throws(()=>validateWire({...request,params:{patch:{sharpen:2}}},'0.7'));
});

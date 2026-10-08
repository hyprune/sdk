import {test} from 'node:test';import assert from 'node:assert/strict';import {validateWire} from '../dist/src/validation.js';
test('recording is pinned at 0.12, after climbing 0.11',()=>{
 const request={jsonrpc:'2.0',id:'r',method:'replay.start',params:{path:'/tmp/session.jsonl',assertions:{recorded:true,tolerance:.002}}};
 assert.doesNotThrow(()=>validateWire(request,'0.12'));
 assert.throws(()=>validateWire(request,'0.11'));
 assert.throws(()=>validateWire({...request,params:{path:'x',smoothingMs:1001}},'0.12'));
});

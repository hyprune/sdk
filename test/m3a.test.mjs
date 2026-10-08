import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWire} from '../dist/src/index.js';
test('IPC 0.5 validates hands/app deltas and keeps 0.4 isolated',()=>{
 const frame={jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:'sub',sessionId:'session',baseRevision:1,revision:2,changes:{interaction:{mode:'typing',tool:2,tools:['pointer','mount','path','path','path'],noclip:false,cursor:'virtual',taggedSurfaceId:null},apps:[{surfaceId:'surface-1',workspaceId:10,title:'Terminal',appClass:'kitty',icon:'kitty'}]}}};
 assert.doesNotThrow(()=>validateWire(frame,'0.5'));
 assert.throws(()=>validateWire(frame,'0.4'));
 frame.params.changes.interaction.tool=6;
 assert.throws(()=>validateWire(frame,'0.5'));
});

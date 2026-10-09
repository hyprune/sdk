import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire} from '../dist/src/validation.js';
test('authoring camera and ink controls validate only on IPC 0.13',()=>{
 const request={jsonrpc:'2.0',id:'a',method:'camera.photo',params:{position:[0,2,4],orientation:[0,0,0,1],fov:15,renderScale:.5,lensShift:[.2,0]}};
 validateWire(request,'0.13');assert.throws(()=>validateWire(request,'0.12'));
 validateWire({jsonrpc:'2.0',id:'b',method:'graphics.set',params:{patch:{outline:false,visibility_culling:true}}},'0.13');
});

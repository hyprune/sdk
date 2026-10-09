import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire} from '../dist/src/validation.js';
test('0.15 accepts omitted unzoned instance area, older wire stays frozen',()=>{
 const mounts={areas:[],anchors:[],objects:[],bindings:[],placements:[],placementZones:[],instances:[{surfaceId:'app',workspaceId:20,anchorId:'',status:'placed'}],carriedSurfaceId:null,desktopWorkspaceId:null};
 const frame={jsonrpc:'2.0',method:'mounts.changed',params:{sessionId:'test',revision:1,mounts}};
 validateWire(frame,'0.15');assert.throws(()=>validateWire(frame,'0.14'));
 mounts.instances[0].areaId='';assert.throws(()=>validateWire(frame,'0.15'));
});

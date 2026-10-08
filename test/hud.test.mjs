import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest as validate} from '../dist/src/validation.js';
test('HUD 0.9 keeps event and method schemas distinct',()=>{
 const r={jsonrpc:'2.0',id:'h',method:'hud.subscribe',params:{topics:['hud.frame','hud.pose']}};
 assert.equal(validate('ipc',r,undefined,'0.9').valid,true);
 assert.equal(validate('ipc',r,undefined,'0.8').valid,false);
 const e={jsonrpc:'2.0',method:'ui.hud.cycle',params:{leaseId:'lease',outputId:'out',sessionId:'s',revision:1,sequence:2,monotonicMs:4}};
 assert.equal(validate('ipc',e,undefined,'0.9').valid,true);
});

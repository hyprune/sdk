import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest} from '../dist/src/validation.js';
test('world 0.6 manifests and invalid bounds reach the SDK validator',()=>{
 const w={formatVersion:'0.6',id:'org.example.bounds',version:'0.1.0',name:'Bounds',license:'CC0-1.0',scene:'scene.gltf',defaultSpawn:'entry',spawns:[{id:'entry',pose:{position:[0,0,0],rotation:[0,0,0,1]}}],attribution:[{path:'.',author:'Tests',license:'CC0-1.0'}]};
 w.formatVersion='0.6';w.playable={volumes:[{type:'box',min:[-5,0,-5],max:[5,8,5]}],maxFlyHeight:7};w.backdrop={farCards:[1]};
 assert.equal(validateManifest('world',w,undefined,'0.6').valid,true);
 w.playable.volumes[0].max=[-10,8,5];assert.equal(validateManifest('world',w,undefined,'0.6').valid,false);
});

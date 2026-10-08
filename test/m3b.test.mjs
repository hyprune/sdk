import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWire} from '../dist/src/validation.js';
const inputSchema=JSON.parse(readFileSync(new URL('../vendor/schema/v0.6/input.schema.json',import.meta.url)));
const config={version:2,longHoldMs:1000,scopeVignette:true,useDistance:6,useTolerance:.12,captureInputLimit:256,modes:Object.fromEntries(Object.entries(inputSchema.properties.modes.properties).map(([mode,s])=>[mode,Object.fromEntries(Object.keys(s.properties).map(action=>[action,[]]))]))};
test('0.6 method/state validation uses the pinned input contract',()=>{
 const request={jsonrpc:'2.0',id:'binding',method:'input.set',params:{config}};
 assert.doesNotThrow(()=>validateWire(request,'0.6'));
 assert.throws(()=>validateWire(request,'0.5'));
 const response={jsonrpc:'2.0',id:'binding',result:{config,conflicts:[],steals:[]}};
 assert.doesNotThrow(()=>validateWire(response,'0.6','input.preview'));
 assert.throws(()=>validateWire(response,'0.6','input.set'));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
const annotate=(params,id='n1')=>({jsonrpc:'2.0',id,method:'capture.annotate',params});
test('IPC 0.17 capture notes: annotate bounded, capture.taken shaped, 0.16 frozen',()=>{
 assert.ok(PROTOCOLS.includes('0.17'));
 for(const note of ['','rail clips the stair','Brücke · 橋 · 🌉','é'.repeat(1000)]) {
  validateWire(annotate({captureId:'capture-1791547507663',note}),'0.17');
  assert.throws(()=>validateWire(annotate({captureId:'capture-1791547507663',note}),'0.16'));
 }
 for(const params of [{captureId:'capture-1',note:'é'.repeat(1001)},{captureId:'capture-1',note:'a\nb'},{captureId:'../x',note:''},{captureId:'capture-1'}])
  assert.throws(()=>validateWire(annotate(params),'0.17'));
 validateWire({jsonrpc:'2.0',method:'capture.taken',params:{captureId:'capture-2',timestampMs:2,mode:'world',sessionId:'s',revision:1}},'0.17');
 assert.throws(()=>validateWire({jsonrpc:'2.0',method:'capture.taken',params:{captureId:'capture-2',timestampMs:2,mode:'world',sessionId:'s',revision:1}},'0.16'));
});

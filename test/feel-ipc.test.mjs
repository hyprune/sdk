// IPC 0.29 (draft, motion feel) on the validator and the typed client: graphics.frame_pacing,
// input version 3, the debug recording's status, state and recording.label. The mock stays at
// 0.28 (it has no recorder).
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
import {MOCK_PROTOCOLS} from '../dist/src/mock.js';

const req=(method,params)=>({jsonrpc:'2.0',id:'f',method,params});
const res=result=>({jsonrpc:'2.0',id:'f',result});
const stats={t:5,windowS:5,final:false,presents:245,presentHz:49,fps:49,frameMs:{p50:20.4,p95:20.6,p99:30.6,max:40.8},
 dtMs:{mean:20.4,std:.3,max:30.6},refreshMs:10.207,missedVblanks:245,hitches:[{t:3.2,ms:61.2}]};
const status={recording:false,playing:false,path:'/x/rec-20261015-101500-pan.jsonl',frame:9000,mode:'input',failures:[],error:null,
 elapsedMs:null,stats:null,last:{path:'/x/rec-20261015-101500-pan.jsonl',label:'pan'}};

test('0.29 constants: negotiable, the mock stays at 0.28',()=>{
 assert.ok(PROTOCOLS.includes('0.29'));
 assert.equal(MOCK_PROTOCOLS.at(-1),'0.28');
});

test('0.29 wire: frame_pacing, recording.label, the status timing; 0.28 refuses them',()=>{
 for(const [method,params] of [['graphics.set',{patch:{frame_pacing:'even'}}],['recording.label',{label:'pan',meta:{shell:{version:'0.2.0'}}}]]){
  validateWire(req(method,params),'0.29');
  assert.throws(()=>validateWire(req(method,params),'0.28'),method);
 }
 assert.throws(()=>validateWire(req('recording.label',{label:''}),'0.29'));
 validateWire(res(status),'0.29','recording.label');
 validateWire(res({...status,recording:true,elapsedMs:61000,stats,last:null}),'0.29','recording.status');
 assert.throws(()=>validateWire(res(status),'0.28','recording.status'));
});

test('0.29 state.recording in deltas',()=>{
 const delta=(recording,v)=>validateWire({jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:'s',sessionId:'x',baseRevision:1,revision:2,changes:{recording}}},v);
 delta({active:true,startedAt:1234,path:'/x/rec.jsonl',stats,last:null},'0.29');
 assert.throws(()=>delta({active:true,startedAt:1234,path:'/x/rec.jsonl',stats,last:null},'0.28'));
});

// IPC 0.24 (RFC-0013) on the mock: catalog machine inputs, the live state key fed by
// published sources, and what 0.23 peers of a 0.24 listener still see.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateState,validateManifest} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,MOCK_PROTOCOLS,LIVE_PROTOCOL,LIVE_GRANTS,NPC_GRANTS,LIVE_LIMIT,defaultSource,machineOf} from '../dist/src/mock.js';

const CAPS=['state.read','objects.control'];
const rack='library/com.hyprune.starter@0.1.0/server-rack',lantern='library/com.hyprune.starter@0.1.0/street-lantern';

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-live-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;scenario.notices=[];
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol:'0.24'});await daemon.start();const clients=[];
 async function connect(caps=CAPS,version='0.24',id='org.example.live') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'live test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};

test('0.24 mock constants: protocol list, no new grant, default source',()=>{
 assert.equal(LIVE_PROTOCOL,'0.24');assert.deepEqual([...MOCK_PROTOCOLS],['0.1','0.2','0.21','0.22','0.23','0.24','0.25']);
 assert.deepEqual(LIVE_GRANTS,NPC_GRANTS);assert.equal(LIVE_LIMIT,64);
 assert.equal(defaultSource('u-3f9a1c'),'com.hyprune.sources.u-3f9a1c');
 const machine=machineOf({machine:{primary:'level',inputs:[{id:'level',type:'number',min:0,max:1,label:'Level',explain:'Fill.'}],drives:[{input:'level',target:'level:tube'}]}});
 assert.deepEqual(machine,{primary:'level',inputs:[{id:'level',type:'number',min:0,max:1,label:'Level',explain:'Fill.'}]},'declarations only, no drives');
 assert.deepEqual(machineOf({machine:{inputs:[{id:'n',type:'int',min:0,max:9,label:'N',explain:'N.',repeat:2}]}}).primary,null);
 assert.equal(machineOf({decorative:{}}),undefined);
});

test('0.24 catalog machine and live state from a placed machine and its source',async t=>{
 const {connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.24');
 await client.subscribe();validateState(client.snapshot,'0.24');
 assert.deepEqual(client.snapshot.state.live,{instances:[]});
 const entries=(await client.call('objects.catalog',{})).entries;
 const server=entries.find(e=>e.ref===rack);
 assert.equal(server.machine.primary,'health');assert.deepEqual(server.machine.inputs.map(i=>[i.id,i.repeat ?? 1]),[['health',4],['load',1]]);
 assert.ok(entries.filter(e=>!e.traits.includes('machine')).every(e=>e.machine===null),'non-machines carry machine: null');
 assert.ok(validateManifest('ipc',{jsonrpc:'2.0',id:'c',result:{revision:1,entries}},'objects.catalog','0.24').valid);

 const {id}=await client.call('objects.place',{ref:rack});
 await client.call('objects.place',{ref:lantern});
 await until(()=>client.snapshot.state.live.instances.length===1);
 let live=client.snapshot.state.live.instances[0];
 assert.deepEqual({id:live.id,asset:live.asset,ref:live.ref,source:live.source,status:live.status,error:live.error,stale:live.stale},
  {id,asset:'server-rack',ref:rack,source:`com.hyprune.sources.${id}`,status:null,error:null,stale:false});
 assert.deepEqual(Object.keys(live.inputs),['health.1','health.2','health.3','health.4','load'],'repeated inputs expanded');
 assert.deepEqual(live.inputs['health.1'],{source:`com.hyprune.sources.${id}`,key:'health.1',value:'ok',raw:null,condition:'missing',publishedAt:null});
 assert.deepEqual(live.inputs.load,{source:`com.hyprune.sources.${id}`,key:'load',value:0,raw:null,condition:'missing',publishedAt:null});

 const publisher=await connect(['data.publish'],'0.24','com.hyprune.sources');
 const before=Date.now();
 await publisher.call('data.publish',{sourceId:`com.hyprune.sources.${id}`,sequence:1,values:{'health.1':'warn','health.2':'purple',load:0.5,_status:'ok'}});
 await until(()=>client.snapshot.state.live.instances[0].status==='ok');
 live=client.snapshot.state.live.instances[0];
 assert.equal(live.inputs['health.1'].condition,'fresh');assert.equal(live.inputs['health.1'].value,'warn');
 assert.ok(live.inputs['health.1'].publishedAt>=before-50 && live.inputs['health.1'].publishedAt<=Date.now()+50,'wall-clock publication time');
 assert.equal(live.inputs.load.value,0.5);assert.equal(live.inputs.load.raw,0.5);
 assert.deepEqual([live.inputs['health.2'].condition,live.inputs['health.2'].value,live.inputs['health.2'].raw],['error','ok','purple'],'a type mismatch is the error condition');
 assert.equal(live.inputs['health.3'].condition,'missing');assert.equal(live.stale,true);

 await new Promise(r=>setTimeout(r,110));
 await publisher.call('data.publish',{sourceId:`com.hyprune.sources.${id}`,sequence:2,values:{'health.1':'warn',load:0.5,_status:'error',_error:'exit status 2'}});
 await until(()=>client.snapshot.state.live.instances[0].status==='error');
 live=client.snapshot.state.live.instances[0];
 assert.equal(live.error,'exit status 2');assert.equal(live.inputs.load.condition,'error');assert.equal(live.stale,true);

 await client.call('objects.remove',{id});
 await until(()=>client.snapshot.state.live.instances.length===0);
});

test('0.23 peers of a 0.24 listener: no machine in the catalog, no live key',async t=>{
 const {connect}=await fixture(t);
 const client=await connect(CAPS,'0.23');assert.equal(client.hello.protocol,'0.23');
 await client.subscribe();validateState(client.snapshot,'0.23');
 assert.equal('live' in client.snapshot.state,false);
 const entries=(await client.call('objects.catalog',{})).entries;
 assert.ok(entries.length && entries.every(e=>!('machine' in e)));
 await client.call('objects.place',{ref:rack});
 await client.resync();assert.equal('live' in client.snapshot.state,false);
});

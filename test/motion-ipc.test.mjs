// IPC 0.28 (draft, the shared clip library) on the mock and the validator: catalog motion, user
// characters' and the companion's styles, the companion's dances (interaction.choose option,
// activity dancing), the aimed interactions' options, and what 0.27 peers of a 0.28 listener see.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateState} from '../dist/src/index.js';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
import {MockDaemon,DEFAULT_SCENARIO,MOCK_PROTOCOLS,MOTION_PROTOCOL,MOTION_GRANTS,SCREENS_GRANTS,MOCK_MOTION,COMPANION_ID} from '../dist/src/mock.js';

const CAPS=['state.read','world.control','movement.control','objects.control'];
const guide='library/com.hyprune.starter@0.1.0/guide';

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-motion-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;scenario.notices=[];
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol:'0.28'});await daemon.start();const clients=[];
 async function connect(caps=CAPS,version='0.28',id='org.example.motion') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'0.28 test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};

test('0.28 constants: protocol list, no new grant',()=>{
 assert.ok(PROTOCOLS.includes('0.28'));
 assert.equal(MOTION_PROTOCOL,'0.28');assert.equal(MOCK_PROTOCOLS.at(-1),'0.28');
 assert.deepEqual(MOTION_GRANTS,SCREENS_GRANTS);
});

test('0.28 wire: styles, dance options and the option validate; 0.27 refuses them',()=>{
 const wire=[['npcs.spawn',{ref:guide,style:{walk:'confident'}}],['npcs.bind',{id:'u-000001',style:null}],
  ['companion.mode',{mode:'follow',style:{idle:'calm'}}],['interaction.choose',{objectId:COMPANION_ID,interactionId:'dance',option:'shimmy'}]];
 for(const [method,params] of wire){
  validateWire({jsonrpc:'2.0',id:'m',method,params},'0.28');
  assert.throws(()=>validateWire({jsonrpc:'2.0',id:'m',method,params},'0.27'),method);
 }
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'m',method:'npcs.bind',params:{id:'u-000001',style:{sit:'calm'}}},'0.28'));
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'m',method:'npcs.bind',params:{id:'u-000001',style:{}}},'0.28'));
});

test('0.28 mock: catalog motion, a styled user character, the companion styles and dances',async t=>{
 const {connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.28');
 await client.subscribe();validateState(client.snapshot,'0.28');
 const {entries}=await client.call('objects.catalog',{});
 assert.deepEqual(entries.find(e=>e.ref===guide).motion,MOCK_MOTION);
 assert.ok(entries.filter(e=>!e.traits.includes('character')).every(e=>e.motion===null));
 // A user character with a style; a rebind with null clears it.
 const {id}=await client.call('npcs.spawn',{ref:guide,style:{walk:'confident',idle:'calm'}});
 const instance=()=>client.snapshot.state.objects.instances.find(i=>i.id===id);
 await until(()=>instance()?.style?.walk==='confident');
 assert.deepEqual(instance().style,{walk:'confident',idle:'calm'});
 assert.ok(client.snapshot.state.objects.instances.filter(i=>i.id!==id).every(i=>i.style===null));
 validateState(client.snapshot,'0.28');
 await client.call('npcs.bind',{id,style:null});
 await until(()=>instance().style===null);
 // The companion: a style through companion.mode, kept across modes; a chosen dance, then any.
 await client.call('companion.set',{ref:guide});
 await until(()=>client.snapshot.state.companion.state==='active');
 assert.deepEqual([client.snapshot.state.companion.style,client.snapshot.state.companion.dance],[null,null]);
 await client.call('companion.mode',{mode:'follow',style:{walk:'groovy'}});
 await until(()=>client.snapshot.state.companion.style?.walk==='groovy');
 await client.call('companion.mode',{mode:'stay'});
 await until(()=>client.snapshot.state.companion.mode==='stay');
 assert.deepEqual(client.snapshot.state.companion.style,{walk:'groovy'},'kept across modes');
 await client.call('interaction.choose',{objectId:COMPANION_ID,interactionId:'dance',option:'step'});
 await until(()=>client.snapshot.state.companion.dance==='step');
 assert.equal(client.snapshot.state.companion.activity,'dancing');
 validateState(client.snapshot,'0.28');
 await assert.rejects(client.call('interaction.choose',{objectId:COMPANION_ID,interactionId:'dance',option:'polka'}),e=>e.code===-32602);
 await assert.rejects(client.call('interaction.choose',{objectId:COMPANION_ID,interactionId:'stay',option:'step'}),e=>e.code===-32602);
 await client.call('interaction.choose',{objectId:COMPANION_ID,interactionId:'dance'});
 await until(()=>MOCK_MOTION.dances.includes(client.snapshot.state.companion.dance));
 await client.call('companion.mode',{mode:'follow'});
 await until(()=>client.snapshot.state.companion.dance===null);
 assert.notEqual(client.snapshot.state.companion.activity,'dancing');
});

test('0.27 peers of a 0.28 listener keep the 0.27 shapes',async t=>{
 const {connect}=await fixture(t);
 const client=await connect(CAPS,'0.27');await client.subscribe();
 validateState(client.snapshot,'0.27');
 const {entries}=await client.call('objects.catalog',{});
 assert.ok(entries.every(e=>!('motion' in e)));
 await client.call('companion.set',{ref:guide});
 await until(()=>client.snapshot.state.companion.state==='active');
 assert.ok(!('style' in client.snapshot.state.companion) && !('dance' in client.snapshot.state.companion));
 assert.ok(client.snapshot.state.objects.instances.every(i=>!('style' in i)));
});

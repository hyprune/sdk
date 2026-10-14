// IPC 0.27 on the mock and the validator: workspace screens (object format 0.11). Catalog entries and
// instances carry screen, objects.place/configure take a workspace, bound screens are homes in mounts,
// and 0.26 peers of a 0.27 listener keep the 0.26 shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateState} from '../dist/src/index.js';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
import {MockDaemon,DEFAULT_SCENARIO,MOCK_PROTOCOLS,SCREENS_PROTOCOL,SCREENS_GRANTS,DEBUG_TOOL_GRANTS} from '../dist/src/mock.js';

const CAPS=['state.read','world.control','movement.control','objects.control'];
const SCREEN='user/workspace-screen-wall-16x9';
const pose={position:[0,1.5,-4],rotation:[0,0,0,1]};

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-screens-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;scenario.notices=[];
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol:'0.27'});await daemon.start();const clients=[];
 async function connect(caps=CAPS,version='0.27',id='org.example.screens') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'0.27 test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};
const rule=async(promise,code,name)=>{await assert.rejects(promise,e=>e.code===code && (!name || e.data?.rule===name));};

test('0.27 constants: protocol list, no new grant',()=>{
 assert.ok(PROTOCOLS.includes('0.27'));
 assert.equal(SCREENS_PROTOCOL,'0.27');assert.equal(MOCK_PROTOCOLS.at(-1),'0.27');
 assert.deepEqual(SCREENS_GRANTS,DEBUG_TOOL_GRANTS);
});

test('0.27 wire: workspace params and screen fields validate; 0.26 refuses them',()=>{
 for(const workspace of [23,'next-free',null]){
  validateWire({jsonrpc:'2.0',id:'c',method:'objects.configure',params:{id:'u-000001',patch:{workspace}}},'0.27');
  validateWire({jsonrpc:'2.0',id:'p',method:'objects.place',params:{ref:SCREEN,workspace}},'0.27');
 }
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'c',method:'objects.configure',params:{id:'u-000001',patch:{workspace:23}}},'0.26'));
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'c',method:'objects.configure',params:{id:'u-000001',patch:{workspace:0}}},'0.27'));
});

test('0.27 mock: place binds the next free workspace, configure rebinds, homes appear in mounts',async t=>{
 const {connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.27');
 await client.subscribe();validateState(client.snapshot,'0.27');
 const {entries}=await client.call('objects.catalog',{});
 const entry=entries.find(e=>e.ref===SCREEN);
 assert.deepEqual(entry.screen,{aspect:'16:9',size:[3.2,1.8],mountType:'hanging-wall'});
 assert.deepEqual([entry.warnings,entry.provenance,entry.imported],[[],{license:'CC-BY-4.0',author:'unknown',source:'unknown'},null]);
 assert.ok(entry.placeable);
 assert.ok(entries.filter(e=>e.ref!==SCREEN).every(e=>e.screen===null));
 const {id}=await client.call('objects.place',{ref:SCREEN,pose});
 const instance=()=>client.snapshot.state.objects.instances.find(i=>i.id===id);
 await until(()=>instance()?.screen?.workspace===21);
 assert.deepEqual(instance().screen,{workspace:21,home:`screen-${id}`,aspect:'16:9',size:[3.2,1.8]});
 const mounts=()=>client.snapshot.state.mounts;
 assert.deepEqual(mounts().bindings.find(b=>b.id===21)?.areaId,`screen-${id}`);
 assert.equal(mounts().anchors.find(a=>a.id===`screen-${id}`)?.mount.role,'mounted-workspace');
 validateState(client.snapshot,'0.27');
 const second=(await client.call('objects.place',{ref:SCREEN,pose:{position:[4,1.5,-4],rotation:[0,0,0,1]},workspace:30})).id;
 await until(()=>client.snapshot.state.objects.instances.find(i=>i.id===second)?.screen?.workspace===30);
 await rule(client.call('objects.configure',{id,patch:{workspace:30}}),-32005,'workspace.taken');
 await rule(client.call('objects.configure',{id,patch:{workspace:20}}),-32005,'workspace.reserved');
 await client.call('objects.configure',{id,patch:{workspace:22}});
 await until(()=>instance().screen.workspace===22 && mounts().bindings.some(b=>b.id===22));
 await client.call('objects.configure',{id,patch:{workspace:null}});
 await until(()=>instance().screen.workspace===null);
 assert.equal(instance().screen.home,null);
 assert.ok(!mounts().areas.some(a=>a.id===`screen-${id}`));
 await client.call('objects.configure',{id,patch:{workspace:'next-free'}});
 await until(()=>instance().screen.workspace===21);
 validateState(client.snapshot,'0.27');
});

test('0.26 peers of a 0.27 listener keep the 0.26 shapes',async t=>{
 const {connect}=await fixture(t);
 const client=await connect();await client.subscribe();
 await client.call('objects.place',{ref:SCREEN,pose});
 const old=await connect(CAPS,'0.26','org.example.older');
 assert.equal(old.hello.protocol,'0.26');
 await old.subscribe();validateState(old.snapshot,'0.26');
 assert.ok(old.snapshot.state.objects.instances.every(i=>!('screen' in i)));
 const {entries}=await old.call('objects.catalog',{});
 assert.ok(entries.every(e=>!('screen' in e) && !('warnings' in e) && !('provenance' in e)));
 await assert.rejects(old.call('objects.configure',{id:old.snapshot.state.objects.instances.at(-1).id,patch:{workspace:23}}));
});

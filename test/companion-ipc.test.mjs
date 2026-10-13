// IPC 0.25 (RFC-0010 companions amendment, draft) on the mock: companion.set/clear/mode, the
// companion state key, catalog capability, the reserved id in npcs.bind, paths.draw {bind},
// paths.list and interaction.choose, and what 0.24 peers of a 0.25 listener still see.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateState,validateManifest} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,MOCK_PROTOCOLS,COMPANION_PROTOCOL,COMPANION_GRANTS,LIVE_GRANTS,COMPANION_ID,COMPANION_REQUIREMENTS,companionOf} from '../dist/src/mock.js';

const CAPS=['state.read','world.control','movement.control','objects.control'];
const guide='library/com.hyprune.starter@0.1.0/guide',rack='library/com.hyprune.starter@0.1.0/server-rack';

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-companion-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;scenario.notices=[];
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol:'0.25'});await daemon.start();const clients=[];
 async function connect(caps=CAPS,version='0.25',id='org.example.companion') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'companion test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};
const rejects=(promise,code)=>assert.rejects(promise,e=>e.code===code);

test('0.25 mock constants: protocol list, no new grant, capability rules',()=>{
 assert.equal(COMPANION_PROTOCOL,'0.25');assert.equal(MOCK_PROTOCOLS.at(-1),'0.25');
 assert.deepEqual(COMPANION_GRANTS,LIVE_GRANTS);assert.equal(COMPANION_ID,'companion');
 assert.deepEqual(Object.keys(COMPANION_REQUIREMENTS),['companion.set','companion.clear','companion.mode']);
 const character={ref:'user/pip',source:'user',name:'Pip',traits:['character'],bounds:{min:[-.3,0,-.2],max:[.3,1.8,.2]},triangles:8000};
 assert.deepEqual(companionOf(character),{capable:true,name:'Pip',reason:null});
 assert.equal(companionOf({...character,bounds:{min:[0,0,0],max:[1,2.4,1]}}).reason,'taller than 2.0 m');
 assert.equal(companionOf({...character,source:'package'}).reason,"world objects can't be companions");
 assert.equal(companionOf({...character,triangles:16_001}).reason,'more than 16,000 triangles');
 assert.equal(companionOf({...character,traits:['decorative']}),null);
});

test('0.25 companion: catalog capability, set, follow, stay, clear',async t=>{
 const {connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.25');
 for(const m of Object.keys(COMPANION_REQUIREMENTS))assert.ok(client.hello.methods.includes(m),m);
 await client.subscribe();validateState(client.snapshot,'0.25');
 assert.equal(client.snapshot.state.companion.state,'none');
 const entries=(await client.call('objects.catalog',{})).entries;
 assert.ok(validateManifest('ipc',{jsonrpc:'2.0',id:'c',result:{revision:1,entries}},'objects.catalog','0.25').valid);
 assert.deepEqual(entries.find(e=>e.ref===guide).companion,{capable:true,name:'Guide',reason:null});
 assert.equal(entries.find(e=>e.ref===rack).companion,null);
 assert.ok(entries.every(e=>'machine' in e),'0.24 fields stay');
 await rejects(client.call('companion.set',{ref:'library/com.example.none@1.0.0/nobody'}),-32004);
 await rejects(client.call('companion.set',{ref:rack}),-32005);
 await rejects(client.call('companion.mode',{mode:'stay'}),-32005);
 await client.call('companion.set',{ref:guide});
 await until(()=>client.snapshot.state.companion.state==='active');
 let c=client.snapshot.state.companion;validateState(client.snapshot,'0.25');
 assert.equal(c.ref,guide);assert.equal(c.name,'Guide');assert.equal(c.mode,'follow');assert.equal(c.carried,false);
 const feet=client.snapshot.state.movement.position;
 assert.ok(Math.abs(Math.hypot(c.position[0]-feet[0],c.position[2]-feet[2])-2)<.01,'2 m behind the player');
 await client.call('companion.mode',{mode:'stay'});
 await until(()=>client.snapshot.state.companion.mode==='stay');
 const at=client.snapshot.state.companion.position;
 await client.call('camera.set',{position:[3,1.7,-2],orientation:[0,0,0,1]});
 await until(()=>client.snapshot.state.movement.position[0]===3);
 assert.deepEqual(client.snapshot.state.companion.position,at,'it stays while the player moves');
 await client.call('interaction.choose',{objectId:'companion',interactionId:'follow'});
 await until(()=>client.snapshot.state.companion.mode==='follow');
 await client.call('companion.clear',{});
 await until(()=>client.snapshot.state.companion.state==='none');
 validateState(client.snapshot,'0.25');
});

test('0.25 companion on a route: tool 3 bind, paths.list bound, npcs.bind, Follow',async t=>{
 const {connect,daemon}=await fixture(t);
 const client=await connect();await client.subscribe();
 await client.call('companion.set',{ref:guide});
 const {id}=await client.call('paths.draw',{use:'route',bind:'companion'});
 for(const p of [[-2,0,-1],[2,0,-1],[2,0,-4]])daemon.drawPoint(p);
 const done=await client.call('paths.finish',{});
 assert.equal(done.id,id);assert.equal(done.bound,'companion');
 await until(()=>client.snapshot.state.companion.mode==='route');
 const c=client.snapshot.state.companion;assert.equal(c.path,`user/${id}`);assert.equal(c.activity,'walking');
 assert.deepEqual(c.position,[-2,0,-1]);validateState(client.snapshot,'0.25');
 const listed=(await client.call('paths.list',{})).paths.find(p=>p.ref===`user/${id}`);
 assert.ok(listed.bound.includes('companion'));
 await client.call('companion.mode',{mode:'follow'});
 await until(()=>client.snapshot.state.companion.mode==='follow');
 assert.equal(client.snapshot.state.companion.path,null);
 await client.call('npcs.bind',{id:'companion',path:`user/${id}`,phase:.5});
 await until(()=>client.snapshot.state.companion.mode==='route');
 await client.call('npcs.bind',{id:'companion',pose:{position:[1,0,-3],rotation:[0,0,0,1]}});
 await until(()=>client.snapshot.state.companion.mode==='stay');
 assert.deepEqual(client.snapshot.state.companion.position,[1,0,-3]);
 await rejects(client.call('npcs.bind',{id:'companion',path:'user/nope'}),-32004);
 await rejects(client.call('npcs.bind',{id:'companion',pose:{position:[0,0,0],rotation:[0,0,0,1]},accent:[1,0,0]}),-32602);
});

test('0.24 peers of a 0.25 listener see no companion',async t=>{
 const {connect}=await fixture(t);
 const now=await connect();await now.call('companion.set',{ref:guide});
 const old=await connect(CAPS,'0.24','org.example.older');
 assert.equal(old.hello.protocol,'0.24');
 assert.ok(!old.hello.methods.some(m=>m.startsWith('companion.')));
 await old.subscribe();validateState(old.snapshot,'0.24');
 assert.ok(!('companion' in old.snapshot.state));
 const entries=(await old.call('objects.catalog',{})).entries;
 assert.ok(entries.every(e=>!('companion' in e)));
 await rejects(old.call('companion.clear',{}),-32601);
 await rejects(old.call('npcs.bind',{id:'companion',pose:{position:[1,0,-3],rotation:[0,0,0,1]}}),-32004);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {HypruneClient,FrameDecoder,encodeFrame,validateWire,StateStore} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,GRANTS} from '../dist/src/mock.js';
import {validateWorld} from '../dist/src/world.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,scenario) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-m1-'));const custom=structuredClone(scenario || DEFAULT_SCENARIO);custom.path=[];custom.tickMs=34;
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario:custom});await daemon.start();const clients=[];
 async function connect(id='org.example.viewer',caps=GRANTS,protocol='0.2') {const client=new HypruneClient({socket:daemon.path,protocol,client:{id,name:'M1 test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});clients.push(client);await client.connect();return client;}
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});return {daemon,connect};
}
async function until(fn,ms=2000){const deadline=Date.now()+ms;while(!fn()){if(Date.now()>deadline)throw new Error('Condition timed out');await wait(15);}}
test('0.2 mock serves exact 0.1 projection and prefers 0.2 negotiation',async t=>{
 const {daemon,connect}=await fixture(t),legacy=await connect('org.example.legacy',['state.read'],'0.1');const snapshot=await legacy.subscribe();assert.deepEqual(Object.keys(snapshot.state).sort(),['movement','runtime','shell','surfaces','world']);assert.ok(!legacy.hello.methods.includes('camera.get'));assert.ok(!legacy.hello.events.includes('location.transition'));
 daemon.commit({location:{...daemon.state.location,waypoint:null}});await once(legacy,'state');assert.equal('location' in legacy.snapshot.state,false);
 const socket=createConnection(daemon.path);t.after(()=>socket.destroy());await once(socket,'connect');const decoder=new FrameDecoder();const hello=new Promise(resolve=>socket.on('data',b=>decoder.feed(b,resolve)));socket.write(encodeFrame({jsonrpc:'2.0',id:'h',method:'session.hello',params:{protocols:['0.1','0.2'],client:{id:'org.example.raw',name:'raw'},capabilities:[]}}));assert.equal((await hello).result.protocol,'0.2');
});
test('whole-key location/integration replacements survive gaps and resync',async t=>{
 const {daemon,connect}=await fixture(t),client=await connect();const snapshot=await client.subscribe(),store=new StateStore();store.install(snapshot,'sub');
 const location={...snapshot.state.location,waypoint:null};assert.equal(store.apply({subscriptionId:'sub',sessionId:snapshot.sessionId,baseRevision:snapshot.revision,revision:snapshot.revision+2,changes:{location,integrations:{sources:[]}}}),true);assert.deepEqual(store.snapshot.state.location,location);
 client.store.snapshot.revision=999999;await client.call('waypoint.clear',{});await once(client,'state');assert.equal(client.snapshot.state.location.waypoint,null);assert.equal(client.snapshot.revision,daemon.revision);
});
test('travel phases keep identity/output, close UI, commit arrival and recover snapshot',async t=>{
 const {connect}=await fixture(t),client=await connect();await client.subscribe();const lease=await client.call('shell.claim',{outputs:['output-main']});await client.call('ui.open',{leaseId:lease.leaseId,outputId:'output-main',panel:'overview'});
 const events=[];client.on('location.transition',e=>events.push(e));const closed=once(client,'ui.closed');const started=await client.call('travel.start',{to:{zoneId:'gallery'},durationMs:180});await closed;
 await assert.rejects(client.call('travel.start',{to:{position:[0,1.7,0]}}),e=>e.code===-32004);await until(()=>events.at(-1)?.phase==='arrived');await client.resync();
 assert.equal(new Set(events.map(e=>e.id)).size,1);assert.ok(events.every(e=>e.outputId==='output-main' && e.sessionId===client.hello.sessionId && e.revision>=started.revision));assert.ok(events.some(e=>e.phase==='travelling'));
 assert.deepEqual(client.snapshot.state.movement.position,[8,1.7,-2]);assert.equal(client.snapshot.state.location.transition.progress,1);assert.equal(client.snapshot.state.shell.leases[0].overlays[0].visible,false);
});
test('zero duration, cancellation, exit and unsupported camera roll follow real contract',async t=>{
 const {connect}=await fixture(t),client=await connect();await client.subscribe();await client.call('travel.start',{to:{position:[1,1.7,2]},durationMs:0});await client.resync();assert.equal(client.snapshot.state.location.transition.phase,'arrived');
 await client.call('travel.start',{to:{position:[3,1.7,2]},durationMs:500});await wait(70);await client.call('travel.cancel',{});const cancelled=await client.resync();assert.equal(cancelled.state.location.transition.phase,'cancelled');assert.notDeepEqual(cancelled.state.movement.position,[3,1.7,2]);
 await assert.rejects(client.call('camera.set',{position:[0,1.7,0],orientation:[0,0,Math.sin(.2),Math.cos(.2)]}),e=>e.code===-32007);
 await client.call('runtime.exit',{});await assert.rejects(client.call('travel.start',{to:{position:[0,1.7,0]}}),e=>e.code===-32005);
});
test('world loading emits before RPC result; failures preserve old world and disconnect cancels',async t=>{
 const scenario=structuredClone(DEFAULT_SCENARIO);scenario.worlds.push({id:'org.example.broken',spawns:['arrival'],failLoad:true,loadMs:80});const {connect,daemon}=await fixture(t,scenario),client=await connect();await client.subscribe();const events=[];client.on('location.transition',e=>events.push(e));
 let completed=false;const call=client.call('world.load',{worldId:'com.hyprune.garden'}).then(r=>{completed=true;return r;});await until(()=>events[0]?.phase==='loading');assert.equal(completed,false);assert.equal(events[0].progress,null);await call;await client.resync();assert.equal(client.snapshot.state.world.id,'com.hyprune.garden');assert.equal(events.at(-1).id,events[0].id);assert.equal(events.at(-1).phase,'arrived');
 events.length=0;await assert.rejects(client.call('world.load',{worldId:'org.example.broken'}),e=>e.code===-32602);await client.resync();assert.equal(client.snapshot.state.world.id,'com.hyprune.garden');assert.equal(client.snapshot.state.location.transition.phase,'failed');
 const abandoned=client.call('world.load',{worldId:'com.hyprune.observatory'});await until(()=>daemon.state.location.transition.phase==='loading');client.close();await assert.rejects(abandoned,/Connection lost/);await until(()=>daemon.state.location.transition.phase==='cancelled');assert.equal(daemon.state.world.id,'com.hyprune.garden');
});
test('autodrive follows explicit routes and stops at scenario obstacles',async t=>{
 const scenario=structuredClone(DEFAULT_SCENARIO);scenario.obstacles=[{min:[2,0,-1],max:[2.2,3,1]}];const {connect}=await fixture(t,scenario),client=await connect();await client.subscribe();await client.call('camera.set',{position:[0,1.7,0],orientation:[0,0,0,1]});await client.call('route.set',{points:[{position:[.2,1.7,0]},{position:[.4,1.7,0]}]});await client.call('autodrive.start',{speed:10});await until(()=>client.snapshot.state.location.autodrive===false && client.snapshot.state.movement.position[0]===.4);
 await client.call('route.set',{points:[{position:[4,1.7,0]}]});await client.call('autodrive.start',{speed:10});await until(()=>client.snapshot.state.location.autodrive===false && client.snapshot.state.movement.position[0]>.4);assert.ok(client.snapshot.state.movement.position[0]<1.8);
 await assert.rejects(client.call('travel.start',{to:{position:[2,1.7,0]}}),e=>e.code===-32004);
});
test('core-style hold timing rejects taps, opens after hold, retains on release and closes on escape',async t=>{
 const {connect,daemon}=await fixture(t),client=await connect();await client.subscribe();const lease=await client.call('shell.claim',{outputs:['output-main']});const opened=[];client.on('ui.opened',e=>opened.push(e));daemon.hold(true);await wait(100);daemon.hold(false);await wait(320);assert.equal(opened.length,0);
 daemon.hold(true);await until(()=>opened.length===1);daemon.hold(false);await client.resync();assert.equal(client.snapshot.state.shell.leases[0].overlays[0].visible,true);assert.equal(opened[0].leaseId,lease.leaseId);assert.equal(opened[0].panel,'overview');
 const closed=once(client,'ui.closed');daemon.escape();await closed;await client.resync();assert.equal(client.snapshot.state.shell.leases[0].overlays[0].visible,false);
 await assert.rejects(client.call('shell.overlay',{leaseId:lease.leaseId,outputId:'output-main',visible:true,exclusiveInput:true}),e=>e.code===-32007);
});
test('publishing requires its own grant, namespace, owner, sequence and bounded rate',async t=>{
 const {connect}=await fixture(t),reader=await connect('org.example.reader',['state.read']),pub=await connect('org.example.publisher',['data.publish']);await reader.subscribe();assert.ok(!pub.hello.methods.includes('state.subscribe'));
 await assert.rejects(reader.call('data.publish',{sourceId:'org.example.reader.data',sequence:1,values:{cpu:1}}),e=>e.code===-32601);
 await assert.rejects(pub.call('data.publish',{sourceId:'org.example.other.data',sequence:1,values:{cpu:1}}),e=>e.code===-32002);
 await pub.call('data.publish',{sourceId:'org.example.publisher.data',sequence:1,values:{cpu:1},ttlMs:500});await assert.rejects(pub.call('data.publish',{sourceId:'org.example.publisher.data',sequence:2,values:{cpu:2}}),e=>e.code===-32008);await wait(110);await assert.rejects(pub.call('data.publish',{sourceId:'org.example.publisher.data',sequence:1,values:{cpu:1}}),e=>e.code===-32004);
 const other=await connect('org.example.publisher',['data.publish']);await assert.rejects(other.call('data.remove',{sourceId:'org.example.publisher.data'}),e=>e.code===-32004);
 await pub.call('data.remove',{sourceId:'org.example.publisher.data'});await reader.resync();assert.deepEqual(reader.snapshot.state.integrations.sources,[]);
});
test('sources replace completely and disappear on TTL or disconnect; no hint replay',async t=>{
 const {connect}=await fixture(t),pub=await connect('org.example.publisher',['data.publish']),reader=await connect('org.example.reader',['state.read']);const hints=[];reader.on('data.updated',e=>hints.push(e));
 await pub.call('data.publish',{sourceId:'org.example.publisher.data',sequence:1,values:{cpu:1,ram:2},ttlMs:150});await reader.subscribe();assert.equal(hints.length,0);assert.equal(reader.snapshot.state.integrations.sources[0].sequence,1);
 await until(()=>reader.snapshot.state.integrations.sources.length===0);
 await pub.call('data.publish',{sourceId:'org.example.publisher.data',sequence:0,values:{cpu:3}});await until(()=>reader.snapshot.state.integrations.sources[0]?.sequence===0);assert.deepEqual(reader.snapshot.state.integrations.sources[0].values,{cpu:3});pub.close();await until(()=>reader.snapshot.state.integrations.sources.length===0);
});
test('stale-session/older-revision presentation hints are discarded',async t=>{
 const {connect,daemon}=await fixture(t),client=await connect();await client.subscribe();await client.call('waypoint.clear',{});await client.resync();let count=0;client.on('location.transition',()=>count++);
 const transition={id:'warp',outputId:'output-main',phase:'arrived',progress:1,to:{position:[0,1.7,0]},monotonicMs:0};
 // Adversarial test transport injects schema-valid envelopes, not local state.
 daemon.broadcast('location.transition',{...transition,sessionId:'previous-session',revision:daemon.revision});daemon.broadcast('location.transition',{...transition,sessionId:daemon.sessionId,revision:daemon.revision-1});await wait(30);assert.equal(count,0);
 daemon.broadcast('location.transition',{...transition,sessionId:daemon.sessionId,revision:daemon.revision});await until(()=>count===1);
});
test('warp scenario uses only real 0.2 actions and valid recoverable state',async t=>{
 const scenario=JSON.parse(await readFile('scenarios/warp.json','utf8'));for(const action of scenario.actions)validateWire({jsonrpc:'2.0',id:'test',method:action.method,params:action.params});const {connect}=await fixture(t,scenario),client=await connect();await client.subscribe();const phases=[];client.on('location.transition',e=>phases.push(e.phase));await until(()=>phases.includes('loading') && phases.at(-1)==='arrived',4000);await client.resync();assert.equal(client.snapshot.state.location.transition.phase,'arrived');
});
test('state.read peer without a subscription gets no 0.2 hints',async t=>{
 const {connect}=await fixture(t),reader=await connect('org.example.reader',['state.read']),controller=await connect('org.example.controller',GRANTS);let count=0;reader.on('location.transition',()=>count++);await controller.call('travel.start',{to:{position:[1,1.7,0]},durationMs:0});await wait(40);assert.equal(count,0);await reader.subscribe();assert.equal(reader.snapshot.state.location.transition.phase,'arrived');assert.equal(count,0);
});

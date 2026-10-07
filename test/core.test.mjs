import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {HypruneClient} from '../dist/src/index.js';
const enabled=Boolean(process.env.HYPRUNE_CORE_BINARY);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=3000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Interop condition timed out');await wait(20);}}
async function fixture(t) {
 const runtime=await mkdtemp(join(tmpdir(),'hyprune-core-sdk-')),token=randomBytes(32).toString('hex'),publisherToken=randomBytes(32).toString('hex'),legacyToken=randomBytes(32).toString('hex');
 const harness=spawn('python3',['scripts/core-harness.py'],{stdio:['pipe','pipe','pipe']});let stderr='';harness.stderr.on('data',b=>stderr+=b);
 t.after(async()=>{if(harness.exitCode===null){const done=once(harness,'close');harness.kill('SIGTERM');await done;}await rm(runtime,{recursive:true,force:true});});
 const ready=new Promise((resolve,reject)=>{harness.stdout.once('data',b=>resolve(b.toString().trim()));harness.once('exit',code=>reject(new Error(`harness exited ${code}: ${stderr}`)));});
 const caps=['state.read','world.control','movement.control','shell.control','runtime.control','data.publish'];
 harness.stdin.end(JSON.stringify({binary:resolve(process.env.HYPRUNE_CORE_BINARY),coreDirectory:process.env.HYPRUNE_CORE_DIR,runtime,grants:[{token,client:'org.example.sdkconformance',capabilities:caps},{token:publisherToken,client:'org.example.publisher',capabilities:['data.publish']},{token:legacyToken,client:'org.example.legacy',capabilities:['state.read']}]}));
 const socket=await ready,client=new HypruneClient({socket,client:{id:'org.example.sdkconformance',name:'SDK conformance'},capabilities:caps,tokenProvider:()=>token,reconnect:false});t.after(()=>client.close());await client.connect();await client.subscribe();
 return {client,socket,publisherToken,legacyToken};
}
test('real hypruned + core Control: camera, waypoint, route, travel, UI and data',{skip:!enabled,timeout:30000},async t=>{
 const {client,socket,publisherToken}=await fixture(t);assert.equal(client.hello.protocol,'0.2');assert.equal(client.snapshot.state.world.id,'org.hyprune.atrium');assert.ok((await client.call('session.ping',{})).monotonicMs>0);
 await client.call('camera.set',{position:[0,1.7,4],orientation:[0,0,0,1]});const camera=await client.call('camera.get',{});assert.ok(Math.abs(camera.position[1]-1.7)<.001);
 await client.call('waypoint.set',{id:'desk',label:'Desk',target:{position:[0,1.7,2]}});await client.resync();assert.equal(client.snapshot.state.location.waypoint.id,'desk');
 await client.call('route.set',{points:[{position:[0,1.7,3]},{position:[0,1.7,2]}]});await client.call('autodrive.start',{speed:10});await until(()=>client.snapshot.state.location.autodrive===false && Math.abs(client.snapshot.state.movement.position[2]-2)<.01);
 const lease=await client.call('shell.claim',{outputs:['output-main']});const opened=once(client,'ui.opened');await client.call('ui.open',{leaseId:lease.leaseId,outputId:'output-main',panel:'overview'});assert.equal((await opened)[0].leaseId,lease.leaseId);
 await assert.rejects(client.call('shell.overlay',{leaseId:lease.leaseId,outputId:'output-main',visible:true,exclusiveInput:true}),e=>e.code===-32007);
 const transitions=[];client.on('location.transition',e=>transitions.push(e));await client.call('travel.start',{to:{position:[1,1.7,2]},durationMs:160});await until(()=>transitions.at(-1)?.phase==='arrived');assert.equal(new Set(transitions.map(e=>e.id)).size,1);assert.ok(transitions.some(e=>e.phase==='travelling'));await client.resync();assert.equal(client.snapshot.state.shell.leases[0].overlays[0].visible,false);
 await client.call('travel.start',{to:{position:[0,1.7,2]},durationMs:0});await client.resync();assert.equal(client.snapshot.state.location.transition.progress,1);
 await client.call('travel.start',{to:{position:[1,1.7,2]},durationMs:600});await client.call('travel.cancel',{});await client.resync();assert.equal(client.snapshot.state.location.transition.phase,'cancelled');
 await client.call('data.publish',{sourceId:'org.example.sdkconformance.metrics',sequence:1,values:{cpu:12,ok:true},ttlMs:180});await client.resync();assert.equal(client.snapshot.state.integrations.sources[0].sequence,1);await until(()=>client.snapshot.state.integrations.sources.length===0);
 const publisher=new HypruneClient({socket,client:{id:'org.example.publisher',name:'Publisher'},capabilities:['data.publish'],tokenProvider:()=>publisherToken,reconnect:false});t.after(()=>publisher.close());await publisher.connect();assert.ok(!publisher.hello.methods.includes('state.subscribe'));
 await publisher.call('data.publish',{sourceId:'org.example.publisher.data',sequence:1,values:{cpu:1}});await client.resync();assert.equal(client.snapshot.state.integrations.sources[0].sourceId,'org.example.publisher.data');publisher.close();await until(()=>client.snapshot.state.integrations.sources.length===0);
 await assert.rejects(client.call('data.publish',{sourceId:'org.other.metrics',sequence:1,values:{cpu:1}}),e=>e.code===-32002);
 await client.call('waypoint.clear',{});await client.call('route.clear',{});const closed=once(client,'ui.closed');await client.call('ui.close',{leaseId:lease.leaseId,outputId:'output-main'});await closed;await client.call('shell.release',{leaseId:lease.leaseId});await client.call('autodrive.stop',{});
 await client.call('runtime.exit',{});await client.resync();assert.equal(client.snapshot.state.runtime.active,false);await client.unsubscribe();
});
test('real hypruned: loading hints precede reply, failure preserves world and legacy stays exact',{skip:!enabled,timeout:30000},async t=>{
 const {client,socket,legacyToken}=await fixture(t),events=[];client.on('location.transition',e=>events.push(e));let complete=false;
 const operation=client.call('world.load',{worldId:'org.hyprune.atrium'}).then(r=>{complete=true;return r;});await until(()=>events.some(e=>e.phase==='loading'));assert.equal(complete,false);assert.equal(events[0].progress,null);await operation;await client.resync();assert.equal(client.snapshot.state.location.transition.phase,'arrived');assert.equal(events[0].id,events.at(-1).id);
 await assert.rejects(client.call('world.load',{worldId:'org.example.missing'}),e=>e.code===-32602);await client.resync();assert.equal(client.snapshot.state.world.id,'org.hyprune.atrium');assert.equal(client.snapshot.state.location.transition.phase,'failed');
 const legacy=new HypruneClient({protocol:'0.1',socket,client:{id:'org.example.legacy',name:'Legacy SDK'},capabilities:['state.read'],tokenProvider:()=>legacyToken,reconnect:false});t.after(()=>legacy.close());await legacy.connect();await legacy.subscribe();assert.equal(legacy.hello.protocol,'0.1');assert.deepEqual(Object.keys(legacy.snapshot.state).sort(),['movement','runtime','shell','surfaces','world']);await assert.rejects(legacy.call('camera.get',{}),e=>e.code===-32601);
 const changed=once(legacy,'state');await client.call('waypoint.set',{id:'legacy-check',label:'Legacy delta',position:[0,1.7,2]});await changed;assert.equal('location' in legacy.snapshot.state,false);await legacy.unsubscribe();
});

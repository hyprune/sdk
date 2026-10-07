import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {HypruneClient,FrameDecoder,encodeFrame,parseJson,StateStore,socketPath,validateWire} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,GRANTS} from '../dist/src/mock.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,protocol='0.1',caps=GRANTS,scenario=DEFAULT_SCENARIO) {
 const root=await mkdtemp(join(tmpdir(),'hyprune-sdk-'));
 const daemon=new MockDaemon({socket:join(root,'control.sock'),protocol,scenario});await daemon.start();
 const client=new HypruneClient({socket:daemon.path,protocol,client:{id:'org.example.test',name:'test'},capabilities:caps,tokenProvider:()=>daemon.issueToken('org.example.test',caps),reconnect:false});
 t.after(async()=>{client.close();await daemon.stop();await rm(root,{recursive:true,force:true});});await client.connect();return {root,daemon,client};
}
for(const invalid of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','1e999','[NaN]','[1,]','{}x']) test(`strict JSON rejects ${invalid}`,()=>assert.throws(()=>parseJson(invalid)));
test('strict JSON protects prototype and rejects excessive nesting',()=>{
 assert.equal(Object.getPrototypeOf(parseJson('{"__proto__":{"polluted":true}}')),Object.prototype);
 assert.equal({}.polluted,undefined);assert.throws(()=>parseJson('['.repeat(65)+'0'+']'.repeat(65)));
 assert.doesNotThrow(()=>parseJson('['.repeat(64)+'0'+']'.repeat(64)));
});
test('split and coalesced framing preserves UTF-8 and order',()=>{
 const bytes=Buffer.concat([encodeFrame({title:'🪐'}),encodeFrame({n:2})]),out=[],d=new FrameDecoder();
 for(const b of bytes) d.feed(Buffer.from([b]),v=>out.push(v)); assert.deepEqual(out,[{title:'🪐'},{n:2}]);
 const coalesced=[];new FrameDecoder().feed(bytes,v=>coalesced.push(v));assert.deepEqual(coalesced,out);
});
test('length, UTF-8, partial deadline and nonfinite output limits',()=>{
 for(const n of [0,1048577]) {const b=Buffer.alloc(4);b.writeUInt32BE(n);assert.throws(()=>new FrameDecoder().feed(b,()=>{}));}
 assert.throws(()=>new FrameDecoder().feed(Buffer.from([0,0,0,1,255]),()=>{}));
 assert.throws(()=>encodeFrame({x:Infinity}));
 const d=new FrameDecoder();d.feed(Buffer.from([0]),()=>{});assert.throws(()=>d.checkDeadline(d.partialSince+10000));
 const max=encodeFrame('x'.repeat(1048574));assert.equal(max.length,1048580);assert.throws(()=>encodeFrame('x'.repeat(1048575)));
});
test('runtime socket selection never falls back and rejects traversal',()=>{
 for(const e of [{},{XDG_RUNTIME_DIR:'/tmp',HYPRLAND_INSTANCE_SIGNATURE:'../x'},{XDG_RUNTIME_DIR:'relative',HYPRLAND_INSTANCE_SIGNATURE:'x'},{XDG_RUNTIME_DIR:'/tmp',HYPRLAND_INSTANCE_SIGNATURE:'..'}]) assert.throws(()=>socketPath(e));
 assert.equal(socketPath({XDG_RUNTIME_DIR:'/run/user/1000',HYPRLAND_INSTANCE_SIGNATURE:'a_1'}),'/run/user/1000/hyprune/a_1/control.sock');
});
test('subscribe ordering, moving pose, typed mutations, lease cleanup',async t=>{
 const {daemon,client}=await fixture(t);assert.equal((await stat(daemon.path)).mode&0o777,0o600);
 const snapshot=await client.subscribe();assert.equal(snapshot.sessionId,client.hello.sessionId);
 const state=once(client,'state');await state;assert.ok(client.snapshot.revision>snapshot.revision);
 const claim=await client.call('shell.claim',{outputs:['output-main']});
 await client.call('shell.overlay',{leaseId:claim.leaseId,outputId:'output-main',visible:true,exclusiveInput:true});
 const fresh=await client.resync();assert.equal(fresh.state.shell.leases[0].overlays[0].exclusiveInput,true);
 await assert.rejects(client.call('shell.claim',{outputs:['output-main']}),e=>e.code===-32004);
 await assert.rejects(client.call('movement.set',{modeId:'com.hyprune.walk'}),e=>e.code===-32007);
 await client.call('world.load',{worldId:'com.hyprune.garden'});await client.resync();assert.equal(client.snapshot.state.world.id,'com.hyprune.garden');
 await assert.rejects(client.call('world.load',{worldId:'org.example.missing'}),e=>e.code===-32003);
 client.close();await wait(20);assert.equal(daemon.state.shell.leases.length,0);
});
test('reducer requires subscription/session/base and replaces complete keys',async t=>{
 const {client}=await fixture(t);const snapshot=await client.subscribe(),store=new StateStore();store.install(snapshot,'sub');
 const d={subscriptionId:'sub',sessionId:snapshot.sessionId,baseRevision:snapshot.revision,revision:snapshot.revision+4,changes:{surfaces:[]}};
 assert.equal(store.apply({...d,sessionId:'other'}),false);assert.equal(store.apply({...d,subscriptionId:'other'}),false);assert.equal(store.apply({...d,baseRevision:999,revision:1000}),false);
 assert.equal(store.apply(d),true);assert.deepEqual(store.snapshot.state.surfaces,[]);assert.equal(store.snapshot.revision,d.revision);
});
test('unauthenticated connections cannot read state or invoke unadvertised methods',async t=>{
 const {daemon}=await fixture(t);const c=new HypruneClient({socket:daemon.path,reconnect:false});t.after(()=>c.close());await c.connect();
 assert.deepEqual(c.hello.capabilities,[]);assert.ok((await c.call('session.ping',{})).monotonicMs>=0);
 await assert.rejects(c.call('state.subscribe',{topics:['state']}),e=>e.code===-32601);
 await assert.rejects(c.mockCall('camera.set',{position:[0,0,0],orientation:[0,0,0,1]}));
});
test('launch token is consumed once and bound to client identity',async t=>{
 const {daemon}=await fixture(t),token=daemon.issueToken('org.example.one',['state.read']);
 const wrong=new HypruneClient({socket:daemon.path,client:{id:'org.example.wrong',name:'wrong'},tokenProvider:()=>token,reconnect:false});t.after(()=>wrong.close());
 await assert.rejects(wrong.connect(),e=>e.code===-32002);
 const one=new HypruneClient({socket:daemon.path,client:{id:'org.example.one',name:'one'},capabilities:GRANTS,tokenProvider:()=>token,reconnect:false});t.after(()=>one.close());await one.connect();assert.deepEqual(one.hello.capabilities,['state.read']);
 const reused=new HypruneClient({socket:daemon.path,client:{id:'org.example.one',name:'two'},tokenProvider:()=>token,reconnect:false});t.after(()=>reused.close());await assert.rejects(reused.connect(),e=>e.code===-32002);
});
test('gap triggers fresh snapshot and reconnect uses a fresh token/subscription',async t=>{
 const {daemon,client}=await fixture(t);client.options.reconnect=true;await client.subscribe();
 const old=client.store.subscriptionId;client.store.snapshot.revision=99999;
 await once(client,'state');assert.equal(client.snapshot.revision<99999,true);
 const ready=once(client,'ready');daemon.disconnectClients();await ready;
 assert.notEqual(client.store.subscriptionId,old);assert.equal(client.snapshot.sessionId,daemon.sessionId);
});
test('experimental demo methods and events are explicitly schema separated',async t=>{
 const {client}=await fixture(t,'0.1-mock.1');let data;client.on('data.updated',p=>data=p);await client.subscribe();
 await client.mockCall('camera.set',{position:[4,2,3],orientation:[0,0,0,1]});await client.resync();assert.deepEqual(client.snapshot.state.movement.position,[4,2,3]);
 await client.mockCall('waypoint.set',{id:'new',position:[1,2,3],label:'New desk'});
 const lease=await client.call('shell.claim',{outputs:['output-main']});await client.mockCall('ui.open',{leaseId:lease.leaseId,outputId:'output-main',panel:'launcher'});
 await client.mockCall('data.publish',{sourceId:'org.example.pulse.data',values:{cpuPercent:20,ramUsedBytes:1,ramTotalBytes:2,netRxBytes:3,netTxBytes:4}});assert.equal(data.values.cpuPercent,20);
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'x',method:'camera.set',params:{position:[0,0,0],orientation:[0,0,0,1]}}));
});
async function raw(socket,messages) {
 const s=createConnection(socket),out=[],d=new FrameDecoder();await once(s,'connect');
 const closed=once(s,'close');s.on('data',b=>d.feed(b,m=>out.push(m)));s.write(Buffer.concat(messages.map(m=>Buffer.isBuffer(m)?m:encodeFrame(m))));await closed;return out;
}
test('mock parse/profile failures close safely and echo valid IDs',async t=>{
 const {daemon}=await fixture(t);
 assert.equal((await raw(daemon.path,[{jsonrpc:'2.0',id:'x',method:'session.ping',params:{}}]))[0].error.code,-32600);
 const bytes=Buffer.from('{oops'),header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);
 assert.equal((await raw(daemon.path,[Buffer.concat([header,bytes])]))[0].error.code,-32700);
 const invalid=Buffer.from([0,0,0,0]);assert.deepEqual(await raw(daemon.path,[invalid]),[]);
 const responses=await raw(daemon.path,[{jsonrpc:'2.0',id:'hello',method:'session.hello',params:{protocols:['9.9'],client:{id:'org.example.raw',name:'raw'},capabilities:[]}}]);assert.equal(responses[0].error.code,-32001);
});
test('revocation stops reconnecting',async t=>{
 const {daemon,client}=await fixture(t);client.options.reconnect=true;await client.subscribe();const revoked=once(client,'session.revoked');daemon.revokeClients();await revoked;await wait(400);assert.equal(client.hello,undefined);
});
test('live sockets are not replaced',async t=>{
 const {daemon}=await fixture(t);const other=new MockDaemon({socket:daemon.path});await assert.rejects(other.start(),/live listener/);
});

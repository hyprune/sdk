import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO} from '../dist/src/mock.js';

// A notice written in the same tick as the hello response reaches the client in the same read
// (the scenario's mock.ready at 500 ms did this on a slow CI runner). The client must already
// hold the hello when it handles the next frame; it used to call the notice unadvertised,
// drop the socket, and fail the first request after connect() with "Not connected".
test('an event in the same read as the hello response is accepted', async t => {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-hello-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.notices=[];
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol:'0.22'});await daemon.start();const clients=[];
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 const send=daemon.send.bind(daemon);
 daemon.send=(peer,message,method)=>{send(peer,message,method);if(method==='session.hello')daemon.broadcast('runtime.notice',{level:'info',code:'test.coalesced',message:'right behind the hello'});};
 for(const protocol of ['0.2','0.21','0.22']) {
  const id='org.example.hello'+protocol.replace('.','');
  const client=new HypruneClient({socket:daemon.path,protocol,client:{id,name:'hello race'},capabilities:['state.read'],tokenProvider:()=>daemon.issueToken(id,['state.read']),reconnect:false});
  clients.push(client);const faults=[],notices=[];client.on('fault',e=>faults.push(e.message));client.on('runtime.notice',n=>notices.push(n.code));
  await client.connect();assert.equal(client.hello.protocol,protocol);
  const snapshot=await client.subscribe();assert.ok(snapshot.state,protocol);
  assert.deepEqual(faults,[],protocol);assert.deepEqual(notices,['test.coalesced'],protocol);
 }
});

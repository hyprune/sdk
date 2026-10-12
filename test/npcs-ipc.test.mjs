// IPC 0.23 (RFC-0010/RFC-0011 P2) on the mock: characters, paths, interactions, npc_motion,
// and what 0.22/0.21 peers of a 0.23 listener still see.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateState} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,MOCK_PROTOCOLS,NPCS_PROTOCOL,NPC_GRANTS,OBJECT_GRANTS,NPC_REQUIREMENTS,NPC_LIMITS,GRAPHICS_DEFAULTS,PROTECTED,samplePath} from '../dist/src/mock.js';

const CAPS=['state.read','objects.control','world.control','movement.control'];
const guide='library/com.hyprune.starter@0.1.0/guide',lantern='library/com.hyprune.starter@0.1.0/street-lantern';
const pose=(x,z,y=0)=>({position:[x,y,z],rotation:[0,0,0,1]});
const line=(...pts)=>pts.map(position=>({position,type:'line'}));
const eye=(x,z)=>({position:[x,1.7,z],orientation:[0,0,0,1]});

async function fixture(t,{protocol='0.23',obstacles}={}) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-npcs-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;scenario.notices=[];
 if(obstacles)scenario.obstacles=obstacles;
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol});await daemon.start();const clients=[];
 async function connect(caps=CAPS,version='0.23',id='org.example.npcs') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'npcs test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};
const rejects=(promise,code,rule)=>assert.rejects(promise,e=>e.code===code && (rule===undefined || e.data?.rule===rule) || assert.fail(`${e.code} ${e.message} ${JSON.stringify(e.data)}`));
const notices=client=>{const seen=[];client.on('runtime.notice',n=>seen.push(n.code));return seen;};
const instance=(client,id)=>client.snapshot.state.objects.instances.find(i=>i.id===id);
// Freeze route motion so poses are deterministic.
const still=client=>client.call('graphics.set',{patch:{npc_motion:'still'}});

test('0.23 mock constants: protocol list, no new grant, method grants',()=>{
 assert.equal(NPCS_PROTOCOL,'0.23');assert.deepEqual([...MOCK_PROTOCOLS],['0.1','0.2','0.21','0.22','0.23']);
 assert.deepEqual(NPC_GRANTS,OBJECT_GRANTS);
 assert.equal(NPC_REQUIREMENTS['paths.list'],'state.read');assert.equal(NPC_REQUIREMENTS['interaction.choose'],'world.control');
 for(const m of ['npcs.spawn','npcs.bind','npcs.disable','npcs.remove','paths.set','paths.remove','paths.draw','paths.finish'])assert.equal(NPC_REQUIREMENTS[m],'objects.control',m);
 assert.deepEqual(NPC_LIMITS,{authored:16,user:8,perPath:8});assert.equal(GRAPHICS_DEFAULTS.npc_motion,'auto');
});

test('route geometry: 24 samples per segment, arcs bow sideways, closed paths return',()=>{
 const open=samplePath(line([0,0,0],[4,0,0],[4,0,4]),false);assert.equal(open.length,1+2*24);assert.deepEqual(open.at(-1),[4,0,4]);
 const arc=samplePath([{position:[0,0,0],type:'line'},{position:[4,0,0],type:'arc'}],false);
 // (b-a) x +Y = (0,0,4) -> the bow goes towards +Z, 0.3*|b-a| at the middle.
 assert.ok(Math.abs(arc[12][2]-1.2)<1e-9 && Math.abs(arc[12][0]-2)<1e-9,JSON.stringify(arc[12]));
 const closed=samplePath(line([0,0,0],[2,0,0],[2,0,2]),true);assert.equal(closed.length,1+3*24);assert.deepEqual(closed.at(-1),[0,0,0]);
 const curve=samplePath([{position:[0,0,0],type:'line'},{position:[2,0,0],type:'curve'}],false);assert.deepEqual(curve.at(-1),[2,0,0]);
});

test('0.23 negotiation, state and the frozen 0.22/0.21 projections',async t=>{
 const {daemon,connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.23');
 for(const m of Object.keys(NPC_REQUIREMENTS))assert.ok(client.hello.methods.includes(m),m);
 await client.subscribe();validateState(client.snapshot,'0.23');
 const npcs=client.snapshot.state.npcs;
 assert.equal(npcs.motion,'auto');assert.equal(npcs.state,'animating');assert.equal(npcs.reason,null);
 assert.deepEqual(npcs.usage,{authored:2,user:0});assert.deepEqual(npcs.limits,{authored:16,user:8});assert.equal(npcs.drawing,null);
 // The player starts 2.2 m from the astronomer: aimed, with the reticle on interact.
 assert.equal(npcs.aimed.objectId,'astronomer');assert.equal(npcs.aimed.prompt,'Say hello');
 assert.deepEqual(client.snapshot.state.interaction.reticle,{state:'valid',action:'interact'});
 const keeper=instance(client,'keeper');
 assert.equal(keeper.character,true);assert.equal(keeper.path,'package/gallery-loop');assert.equal(keeper.activity,'walking');assert.equal(keeper.seat,null);
 assert.deepEqual(instance(client,'astronomer').accent,[0.2,0.4,0.9]);assert.equal(instance(client,'astronomer').activity,'idle');
 const chair=instance(client,'reading-chair');assert.equal(chair.character,false);assert.equal(chair.accent,null);

 // Without objects.control only the reads are advertised.
 const reader=await connect(['state.read'],'0.23','org.example.reader');
 assert.ok(reader.hello.methods.includes('paths.list') && reader.hello.methods.includes('graphics.get'));
 assert.ok(!reader.hello.methods.includes('npcs.spawn') && !reader.hello.methods.includes('interaction.choose'));

 // 0.22 peers: the characters as plain instances, no npcs key, click reticle, no character notices.
 const old=await connect(['state.read','objects.control'],'0.22','org.example.old');assert.equal(old.hello.protocol,'0.22');
 assert.ok(!old.hello.methods.includes('npcs.spawn') && !old.hello.methods.includes('graphics.get'));
 await old.subscribe();validateState(old.snapshot,'0.22');
 assert.equal(old.snapshot.state.npcs,undefined);
 const k22=old.snapshot.state.objects.instances.find(i=>i.id==='keeper');
 assert.equal(k22.path,null);assert.equal(k22.activity,null);assert.ok(!('character' in k22) && !('accent' in k22));
 assert.deepEqual(old.snapshot.state.interaction.reticle,{state:'valid',action:'click'});
 const oldSeen=notices(old),seen=notices(client);
 await still(client);
 const {id}=await client.call('npcs.spawn',{ref:guide,path:'gallery-loop'});
 // objects.remove on a user character works as npcs.remove, also for 0.22 peers.
 await old.call('objects.remove',{id});
 await until(()=>seen.includes('npc.spawned') && seen.includes('npc.removed'));
 await new Promise(r=>setTimeout(r,100));assert.ok(!oldSeen.some(c=>c.startsWith('npc.')),oldSeen.join());

 // 0.21 peers: user paths in the 0.21 editor shape.
 await client.call('paths.set',{path:{use:'generic',closed:false,points:line([0,0,-1],[1,0,-1])}});
 const quest=await connect(['state.read'],'0.21','org.example.quest');await quest.subscribe();
 assert.deepEqual(quest.snapshot.state.editor.paths.map(p=>Object.keys(p).sort()),[['areaId','closed','id','points','worldId']]);
 await client.resync();assert.deepEqual(client.snapshot.state.editor.paths[0],{id:'path-1',worldId:'com.hyprune.observatory',areaId:'work',closed:false,
  points:line([0,0,-1],[1,0,-1]),use:'generic',name:null,speed:null,stops:[]});
 assert.ok(daemon.npcs);
});

test('npcs.spawn, bind, disable and remove with the contract errors',async t=>{
 const {connect}=await fixture(t);const client=await connect();await client.subscribe();await still(client);
 const seen=notices(client);
 // Route spawn (a bare id is package/<id>), standing spot, and in front of the player.
 const onRoute=await client.call('npcs.spawn',{ref:guide,path:'gallery-loop',phase:0,speed:1.5,accent:[1,0.5,0],reverse:true});
 const standing=await client.call('npcs.spawn',{ref:guide,pose:pose(2,-4)});
 const front=await client.call('npcs.spawn',{ref:guide});
 await client.resync();
 const r=instance(client,onRoute.id);assert.equal(r.path,'package/gallery-loop');assert.equal(r.source,'user');assert.equal(r.character,true);assert.deepEqual(r.accent,[1,0.5,0]);
 assert.equal(r.scale,1);assert.equal(r.movable,false);
 // Phase 0: the loop's first point; reverse faces against the first segment (-X).
 assert.deepEqual(r.pose.position,[5,0,-5]);assert.deepEqual(r.pose.rotation,[0,-0.707107,0,0.707107]);
 assert.deepEqual(instance(client,standing.id).pose.position,[2,0,-4]);assert.equal(instance(client,standing.id).path,null);
 assert.deepEqual(instance(client,front.id).pose.position,[0,0,-2]);
 assert.deepEqual(client.snapshot.state.npcs.usage,{authored:2,user:3});
 assert.equal(client.snapshot.state.objects.usage.placements,3);
 // Errors.
 await rejects(client.call('npcs.spawn',{ref:'library/com.hyprune.starter@0.1.0/nobody'}),-32004);
 await rejects(client.call('npcs.spawn',{ref:lantern}),-32005);
 await rejects(client.call('npcs.spawn',{ref:guide,path:'nowhere'}),-32004);
 await rejects(client.call('npcs.spawn',{ref:guide,path:'package/survey-line'}),-32007,'walkable');
 await rejects(client.call('npcs.spawn',{ref:guide,pose:pose(30,30)}),-32007,'playable');
 await rejects(client.call('npcs.spawn',{ref:guide,pose:{position:[0,0,-2],rotation:[0,0,0.5,0.5]}}),-32602);
 // bind: user characters only; reverse needs a path; a pose unbinds.
 await rejects(client.call('npcs.bind',{id:'keeper',speed:2}),-32005);
 await rejects(client.call('npcs.bind',{id:'reading-chair',speed:2}),-32005);
 await rejects(client.call('npcs.bind',{id:'u-000000',speed:2}),-32004);
 await rejects(client.call('npcs.bind',{id:standing.id,reverse:true}),-32602);
 await client.call('npcs.bind',{id:standing.id,path:'package/gallery-loop',phase:0});
 await client.call('npcs.bind',{id:onRoute.id,pose:pose(1,-3)});
 await client.resync();
 assert.equal(instance(client,standing.id).path,'package/gallery-loop');assert.deepEqual(instance(client,standing.id).pose.position,[5,0,-5]);
 assert.equal(instance(client,onRoute.id).path,null);assert.deepEqual(instance(client,onRoute.id).pose.position,[1,0,-3]);
 await client.call('npcs.bind',{id:onRoute.id,accent:null});await client.resync();assert.equal(instance(client,onRoute.id).accent,null);
 // disable: authored and user characters; objects.hide on an authored character is the same.
 await client.call('npcs.disable',{id:'keeper',disabled:true});await client.call('npcs.disable',{id:front.id,disabled:true});
 await client.resync();assert.equal(instance(client,'keeper').state,'hidden');assert.equal(instance(client,'keeper').activity,null);assert.equal(instance(client,front.id).state,'hidden');
 await client.call('objects.hide',{id:'keeper',hidden:false});await client.resync();assert.equal(instance(client,'keeper').state,'active');
 await rejects(client.call('npcs.disable',{id:'reading-chair',disabled:true}),-32005);
 // Protections and the objects.* routes for characters.
 for(const [m,p] of [['objects.transform',{id:'keeper',pose:pose(6,-4)}],['objects.transform',{id:front.id,pose:pose(1,-1)}],['objects.configure',{id:'keeper',patch:{locked:true}}],
  ['objects.pocket',{ref:guide}],['objects.reset',{id:front.id}]])
  await assert.rejects(client.call(m,p),e=>e.code===-32005 && e.message.includes(PROTECTED) || assert.fail(`${m}: ${e.code} ${e.message}`));
 await assert.rejects(client.call('objects.place',{ref:guide}),e=>e.code===-32005 && /use npcs\.spawn/.test(e.message));
 await rejects(client.call('objects.remove',{id:'keeper'}),-32005);
 // remove: user characters only.
 await rejects(client.call('npcs.remove',{id:'keeper'}),-32005);
 await rejects(client.call('npcs.remove',{id:'reading-chair'}),-32005);
 await client.call('npcs.remove',{id:front.id});await client.resync();assert.equal(instance(client,front.id),undefined);
 // Lantern placements survive npcs.remove {all}.
 const placed=await client.call('objects.place',{ref:lantern,pose:pose(-2,-1)});
 await client.call('npcs.remove',{all:true});await client.resync();
 assert.deepEqual(client.snapshot.state.objects.instances.filter(i=>i.source==='user').map(i=>i.id),[placed.id]);
 assert.equal(client.snapshot.state.npcs.usage.user,0);
 await until(()=>['npc.spawned','npc.disabled','npc.enabled','npc.removed'].every(c=>seen.includes(c)));
});

test('the user character budget: 8 per world, then -32008 and npc.budget',async t=>{
 const {connect}=await fixture(t);const client=await connect();await client.subscribe();await still(client);const seen=notices(client);
 for(let i=0;i<8;i++)await client.call('npcs.spawn',{ref:guide,pose:pose(-3+i*0.8,-5)});
 await rejects(client.call('npcs.spawn',{ref:guide,pose:pose(3,-3)}),-32008,'budget');
 await rejects(client.call('paths.draw',{spawn:{ref:guide}}),-32008,'budget');
 await until(()=>seen.includes('npc.budget'));
 await client.resync();assert.deepEqual(client.snapshot.state.npcs.usage,{authored:2,user:8});
});

test('paths.set/list/remove: user paths, walkability, package ids and bound characters',async t=>{
 const {connect}=await fixture(t,{obstacles:[{min:[-0.5,0,-3.5],max:[0.5,2,-2.5]}]});const client=await connect();await client.subscribe();await still(client);
 const seen=notices(client);
 const loop={use:'route',closed:false,points:line([-3,0,-5],[3,0,-5]),stops:[{point:1,seconds:5,clip:'wave'}]};
 const {id}=await client.call('paths.set',{path:{...loop,name:'Desk walk'}});assert.equal(id,'path-1');
 const second=await client.call('paths.set',{path:{use:'track',closed:true,points:line([-3,0,0],[3,0,0],[0,0,-3]),stops:[{point:0,seconds:2}]}});assert.equal(second.id,'path-2');
 // Walkability: off the floor, outside the zones, through an obstacle; fewer than 2 points is a schema error.
 await rejects(client.call('paths.set',{path:{use:'route',closed:false,points:line([0,0,0],[0,0,20])}}),-32007,'walkable');
 await assert.rejects(client.call('paths.set',{path:{use:'route',closed:false,points:line([0,1,0],[1,1,0])}}),e=>e.code===-32007 && /no walkable floor at \(0\.00, 1\.00, 0\.00\)/.test(e.message));
 await assert.rejects(client.call('paths.set',{path:{use:'route',closed:false,points:line([0,0,-1],[0,0,-5])}}),e=>e.code===-32007 && /^walkable: blocked at/.test(e.message));
 await assert.rejects(client.call('paths.set',{path:{use:'route',closed:false,points:line([0,0,0])}}),/Invalid IPC/);
 // Stop and id rules.
 await rejects(client.call('paths.set',{path:{...loop,stops:[{point:2}]}}),-32602);
 await rejects(client.call('paths.set',{path:{use:'generic',closed:false,points:loop.points,stops:[{point:0}]}}),-32602);
 await rejects(client.call('paths.set',{path:{...loop,id:'gallery-loop'}}),-32005);
 const {paths}=await client.call('paths.list',{});
 assert.deepEqual(paths.map(p=>[p.ref,p.source,p.walkable]),[['package/gallery-loop','package',true],['package/survey-line','package',null],['user/path-1','user',true],['user/path-2','user',null]]);
 assert.deepEqual(paths.find(p=>p.id==='gallery-loop').bound,['keeper']);
 assert.equal(paths.find(p=>p.id==='path-1').name,'Desk walk');assert.deepEqual(paths.find(p=>p.id==='path-1').stops,[{point:1,seconds:5,clip:'wave'}]);
 // A bound path must stay a walkable route; removal needs unbind.
 const npc=await client.call('npcs.spawn',{ref:guide,path:'user/path-1',phase:0.5});
 await rejects(client.call('paths.set',{path:{...loop,id,use:'generic',stops:[]}}),-32007,'walkable');
 await rejects(client.call('paths.set',{path:{...loop,id,points:line([-3,0,-5],[3,0,-30])}}),-32007,'walkable');
 await client.call('paths.set',{path:{...loop,id,points:line([-3,0,-4],[3,0,-4])}});
 await rejects(client.call('paths.remove',{id}),-32005);
 await rejects(client.call('paths.remove',{id:'gallery-loop'}),-32005);
 await rejects(client.call('paths.remove',{id:'path-9'}),-32004);
 await client.resync();const before=instance(client,npc.id).pose.position;assert.deepEqual(before,[0,0,-4]);
 await client.call('paths.remove',{id,unbind:true});await client.resync();
 const after=instance(client,npc.id);assert.equal(after.path,null);assert.deepEqual(after.pose.position,before);assert.equal(after.activity,'idle');
 assert.deepEqual((await client.call('paths.list',{})).paths.map(p=>p.id),['gallery-loop','survey-line','path-2']);
 await until(()=>seen.includes('path.saved') && seen.includes('path.removed'));
});

test('paths.draw and paths.finish: tool 3, spawn and bind on the drawn route, short routes',async t=>{
 const {daemon,connect}=await fixture(t);const client=await connect();await client.subscribe();await still(client);const seen=notices(client);
 await client.resync();assert.deepEqual(await client.call('paths.finish',{}),{revision:client.snapshot.revision,id:null,bound:null});
 const draw=await client.call('paths.draw',{name:'Evening walk',spawn:{ref:guide,speed:0.5,accent:[0,1,0]}});
 await client.resync();
 assert.deepEqual(client.snapshot.state.npcs.drawing,{pathId:draw.id,use:'route',spawn:{ref:guide},bind:null});
 assert.equal(client.snapshot.state.editor.tool,3);assert.equal(client.snapshot.state.interaction.tool,3);
 daemon.drawPoint([-3,0,-5]);daemon.drawPoint([3,0,-5],'curve');daemon.drawPoint([3,0,-1],'arc');
 const done=await client.call('paths.finish',{});assert.equal(done.id,draw.id);assert.match(done.bound,/^u-[0-9a-f]{6}$/);
 await client.resync();
 const spawned=instance(client,done.bound);assert.equal(spawned.path,`user/${draw.id}`);assert.deepEqual(spawned.accent,[0,1,0]);
 assert.equal(client.snapshot.state.npcs.drawing,null);assert.equal(client.snapshot.state.editor.tool,1);
 assert.equal(client.snapshot.state.editor.paths.find(p=>p.id===draw.id).name,'Evening walk');
 // Rebinding a user character to a fresh route; a second draw replaces the first (empty) one.
 const first=await client.call('paths.draw',{});const rebind=await client.call('paths.draw',{bind:done.bound});
 await client.resync();assert.ok(!client.snapshot.state.editor.paths.some(p=>p.id===first.id));assert.equal(client.snapshot.state.npcs.drawing.bind,done.bound);
 daemon.drawPoint([-2,0,-3]);daemon.drawPoint([2,0,-3]);
 assert.equal((await client.call('paths.finish',{})).bound,done.bound);
 await client.resync();assert.equal(instance(client,done.bound).path,`user/${rebind.id}`);
 // Too short: the path stays, no character, path.unwalkable.
 const short=await client.call('paths.draw',{spawn:{ref:guide}});daemon.drawPoint([0,0,-2]);
 assert.deepEqual(await client.call('paths.finish',{}),{revision:(await client.resync(),client.snapshot.revision),id:short.id,bound:null});
 await until(()=>seen.includes('path.unwalkable'));
 assert.ok((await client.call('paths.list',{})).paths.some(p=>p.id===short.id && p.walkable===false && /at least 2 points/.test(p.problems[0])));
 // spawn/bind draw routes; bind targets user characters.
 await rejects(client.call('paths.draw',{use:'track',spawn:{ref:guide}}),-32602);
 await rejects(client.call('paths.draw',{bind:'keeper'}),-32005);
 await rejects(client.call('paths.draw',{spawn:{ref:lantern}}),-32005);
 // A track draw just saves the path.
 const track=await client.call('paths.draw',{use:'track'});daemon.drawPoint([0,0,0]);daemon.drawPoint([1,0,0]);
 assert.equal((await client.call('paths.finish',{})).id,track.id);
});

test('interaction.choose: say lines, choices, waypoint, panel-free ends and refusals',async t=>{
 const {daemon,connect}=await fixture(t);const client=await connect();await client.subscribe();await still(client);
 const state=async()=>{await client.resync();return client.snapshot.state.npcs.interaction;};
 await client.call('interaction.choose',{objectId:'astronomer',interactionId:'hello'});
 let i=await state();assert.equal(i.type,'say');assert.equal(i.line,'Clear skies tonight.');assert.equal(i.lineIndex,0);assert.equal(i.lineCount,2);
 assert.equal(instance(client,'astronomer').activity,'interacting');
 await client.call('interaction.choose',{objectId:'astronomer',interactionId:'hello'});
 i=await state();assert.equal(i.lineIndex,1);assert.equal(i.line,'Ask the keeper about the gallery.');
 // Past the last line the interaction ends; the next choose starts over.
 await client.call('interaction.choose',{objectId:'astronomer',interactionId:'hello'});assert.equal(await state(),null);
 await client.call('interaction.choose',{objectId:'astronomer',interactionId:'hello'});assert.equal((await state()).lineIndex,0);
 await client.call('interaction.choose',{objectId:'astronomer',interactionId:null});assert.equal(await state(),null);
 // E (native simulation) on the aimed keeper with two interactions offers the choice list.
 await client.call('camera.set',eye(5.5,-5));await client.resync();assert.equal(client.snapshot.state.npcs.aimed.objectId,'keeper');
 assert.equal(client.snapshot.state.npcs.aimed.prompt,'Talk to Keeper');
 daemon.use();i=await state();assert.equal(i.type,'choose');assert.equal(i.interactionId,null);assert.deepEqual(i.choices,[{id:'chat',label:'Talk'},{id:'desk',label:'Where is my desk?'}]);
 await client.call('interaction.choose',{objectId:'keeper',interactionId:'desk'});
 i=await state();assert.equal(i.type,'waypoint');
 assert.deepEqual(client.snapshot.state.location.waypoint,{id:'npc-keeper',label:'Where is my desk?',target:{zoneId:'work'},position:[0,1.7,-2.5]});
 await client.call('interaction.choose',{objectId:'keeper',interactionId:'chat'});i=await state();assert.equal(i.type,'say');assert.equal(i.line,'Welcome to the gallery.');
 daemon.use();assert.equal((await state()).lineIndex,1);
 // Refusals.
 await rejects(client.call('interaction.choose',{objectId:'keeper',interactionId:'dance'}),-32004);
 await rejects(client.call('interaction.choose',{objectId:'ghost',interactionId:'chat'}),-32004);
 await rejects(client.call('interaction.choose',{objectId:'reading-chair',interactionId:'chat'}),-32005);
 await client.call('npcs.disable',{id:'keeper',disabled:true});assert.equal(await state(),null);
 await rejects(client.call('interaction.choose',{objectId:'keeper',interactionId:'chat'}),-32005);
 await client.call('npcs.disable',{id:'keeper',disabled:false});
 await client.call('graphics.set',{patch:{npc_motion:'off'}});await client.resync();
 assert.equal(client.snapshot.state.npcs.aimed,null);assert.equal(client.snapshot.state.npcs.state,'off');
 await rejects(client.call('interaction.choose',{objectId:'keeper',interactionId:'chat'}),-32005);
 // world.control is the grant.
 const placer=await connect(['state.read','objects.control'],'0.23','org.example.placer');
 assert.ok(!placer.hello.methods.includes('interaction.choose'));
});

test('npc_motion and the power profile: animating, still, paused with reasons; routes move',async t=>{
 const {daemon,connect}=await fixture(t);const client=await connect();await client.subscribe();
 const g=await client.call('graphics.get',{});assert.equal(g.config.npc_motion,'auto');assert.deepEqual(g.overrides,{});assert.equal(g.performance.profile,'full-ac');
 const npcs=async()=>{await client.resync();return client.snapshot.state.npcs;};
 // Animating: the keeper walks its loop (positions published at most twice a second).
 const start=instance(client,'keeper').pose.position;
 await until(()=>JSON.stringify(instance(client,'keeper').pose.position)!==JSON.stringify(start),3000);
 for(const [profile,reason] of [['battery','battery'],['usb-c','usb-c power'],['unknown','power unknown'],['limited-ac',null],['full-ac',null]]){
  daemon.setPowerProfile(profile);const n=await npcs();assert.equal(n.state,reason?'paused':'animating',profile);assert.equal(n.reason,reason,profile);
 }
 await client.call('graphics.set',{patch:{reduced_motion:true}});assert.deepEqual([(await npcs()).state,(await npcs()).reason],['paused','reduced motion']);
 await client.call('graphics.set',{patch:{npc_motion:'always'}});assert.equal((await npcs()).state,'animating');
 const set=await client.call('graphics.set',{patch:{npc_motion:'still',reduced_motion:false}});
 assert.deepEqual(set.overrides,{npc_motion:'still'});assert.equal(set.config.npc_motion,'still');
 assert.equal((await npcs()).state,'still');
 const frozen=instance(client,'keeper').pose.position;await new Promise(r=>setTimeout(r,700));await client.resync();
 assert.deepEqual(instance(client,'keeper').pose.position,frozen);
 await client.call('graphics.set',{patch:{npc_motion:'auto'}});assert.deepEqual((await client.call('graphics.get',{})).overrides,{});
 // No characters at all: none.
 await client.call('npcs.disable',{id:'keeper',disabled:true});await client.call('npcs.disable',{id:'astronomer',disabled:true});
 assert.deepEqual([(await npcs()).state,(await npcs()).reason],['none',null]);
});

test('a 0.22 listener keeps its world: no characters, no 0.23 methods',async t=>{
 const {connect}=await fixture(t,{protocol:'0.22'});
 const client=await connect(['state.read','objects.control'],'0.22');await client.subscribe();
 assert.deepEqual(client.snapshot.state.objects.instances.map(i=>i.id),['observatory-armillary','reading-chair']);
 assert.ok(!client.hello.methods.includes('paths.list'));
 assert.ok(!(await client.call('objects.catalog',{})).entries.some(e=>e.ref==='package/keeper'));
});

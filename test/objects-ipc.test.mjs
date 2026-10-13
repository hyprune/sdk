// IPC 0.22 (RFC-0011 P1) in the SDK: the vendored pin, the mock's object catalog, user
// placements and libraries, and 0.21 isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateWire,validateState,PROTOCOLS,atLeast} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,OBJECT_GRANTS,OBJECTS_PROTOCOL,MOCK_PROTOCOLS,grantsFor,placeability,compareVersions,REASONS,OBJECT_LIMITS} from '../dist/src/mock.js';
import {writeObject,writeLibrary,packLibrary} from './object-fixtures.mjs';

const req=(method,params)=>({jsonrpc:'2.0',id:'o1',method,params});
const OBJECT_CAPS=['state.read','objects.control'];
const NEW_METHODS=['objects.catalog','objects.pocket','objects.place','objects.transform','objects.remove','objects.hide','objects.reset','objects.configure',
 'libraries.list','libraries.install','libraries.remove'];
const rack='library/com.hyprune.starter@0.1.0/server-rack';
const pose=(x,z,y=0)=>({position:[x,y,z],rotation:[0,0,0,1]});

async function fixture(t,{protocol='0.22',objectDir,obstacles}={}) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-objects-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;
 if(obstacles)scenario.obstacles=obstacles;
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol,objectDir});await daemon.start();const clients=[];
 async function connect(caps=OBJECT_CAPS,version='0.22',id='org.example.objects') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'objects test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect,dir};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};
const rejects=(promise,code,rule)=>assert.rejects(promise,e=>e.code===code && (rule===undefined || e.data?.rule===rule) || assert.fail(`${e.code} ${e.message} ${JSON.stringify(e.data)}`));

test('IPC 0.22 is a vendored pin; object methods validate only from 0.22',()=>{
 assert.ok(PROTOCOLS.includes('0.22'));assert.equal(OBJECTS_PROTOCOL,'0.22');
 assert.ok(atLeast('0.22',OBJECTS_PROTOCOL) && !atLeast('0.21',OBJECTS_PROTOCOL));
 assert.deepEqual([...MOCK_PROTOCOLS],['0.1','0.2','0.21','0.22','0.23','0.24','0.25','0.26']);
 assert.ok(OBJECT_GRANTS.includes('objects.control') && OBJECT_GRANTS.includes('quest.control'));
 assert.ok(!grantsFor('0.21').includes('objects.control'));
 for(const [m,p] of [['objects.catalog',{}],['objects.place',{ref:rack}],['objects.remove',{all:true}],['libraries.remove',{id:'com.example.kit',version:'1.0.0'}]]){
  validateWire(req(m,p),'0.22');assert.throws(()=>validateWire(req(m,p),'0.21'),undefined,m);
 }
 validateWire({jsonrpc:'2.0',id:'o1',error:{code:-32007,message:'walls: inside a wall',data:{retryable:false,rule:'walls'}}},'0.22');
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'o1',error:{code:-32007,message:'walls',data:{retryable:false,rule:'walls'}}},'0.21'));
});

test('placeability follows the P1 rules and reasons',()=>{
 const e=(traits,over={})=>placeability({state:'ready',traits,formatVersion:'0.9',errors:[],...over});
 assert.deepEqual(e(['decorative','collidable','movable','seat','machine']),{placeable:true,reason:null});
 assert.equal(e(['character']).reason,REASONS.character);assert.equal(e(['decorative','mover']).reason,REASONS.mover);
 assert.equal(e(['decorative']).reason,REASONS.notMovable);
 assert.equal(e(['movable'],{state:'invalid',errors:['bounds: bad']}).reason,'invalid: bounds: bad');
 assert.match(e(['movable'],{formatVersion:'0.42'}).reason,/^invalid: object format 0\.42/);
 assert.ok(compareVersions('1.10.0','1.9.0')>0 && compareVersions('1.0.0','1.0.0-rc.1')>0 && compareVersions('0.1.0','0.1.0')===0);
});

test('0.22 mock: negotiation, objects state, editor deltas and 0.21/0.2 isolation',async t=>{
 const {daemon,connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.22');
 for(const m of NEW_METHODS)assert.ok(client.hello.methods.includes(m),m);
 assert.ok(client.hello.capabilities.includes('objects.control'));
 const snapshot=await client.subscribe(),objects=snapshot.state.objects;
 assert.deepEqual(objects.limits,OBJECT_LIMITS);assert.equal(objects.usage.placements,0);
 assert.deepEqual(objects.instances.map(i=>[i.id,i.source,i.ref,i.movable]),[['observatory-armillary','authored','package/armillary',false],['reading-chair','authored','package/reading-chair',true]]);
 assert.deepEqual(snapshot.state.editor.gizmo,{space:'world',pivot:'centre',snap:false});assert.deepEqual(snapshot.state.editor.unplaced.objects,[]);
 validateState(daemon.objectsView(daemon.snapshot()),'0.22');
 // A reader without objects.control sees the catalog but no mutations.
 const reader=await connect(['state.read'],'0.22','org.example.reader');
 assert.ok(reader.hello.methods.includes('objects.catalog') && reader.hello.methods.includes('libraries.list') && !reader.hello.methods.includes('objects.place'));
 // 0.21 and 0.2 peers on the same listener: their exact projection, no object method.
 const old=await connect(['state.read','quest.control'],'0.21','org.example.old');assert.equal(old.hello.protocol,'0.21');
 assert.ok(!old.hello.methods.some(m=>NEW_METHODS.includes(m)));
 const oldState=(await old.subscribe()).state;assert.equal(oldState.objects,undefined);assert.equal(oldState.editor.gizmo,undefined);assert.equal(oldState.editor.unplaced.objects,undefined);
 validateState({sessionId:daemon.sessionId,revision:0,state:oldState},'0.21');
 await rejects(old.call('objects.catalog',{}),-32601);
 const legacy=await connect(['state.read'],'0.2','org.example.legacy');assert.equal(legacy.hello.protocol,'0.2');assert.equal((await legacy.subscribe()).state.quests,undefined);
 // A change reaches the 0.21 peer as a delta that validates at 0.21 (the client checks every frame).
 const oldRevision=old.snapshot.revision;await client.call('objects.pocket',{ref:'user/desk-plant'});
 await until(()=>old.snapshot.revision>oldRevision && client.snapshot.state.objects.pocket.length===1);
 assert.equal(old.snapshot.state.objects,undefined);
 assert.equal(client.snapshot.state.editor.unplaced.count,1);assert.deepEqual(client.snapshot.state.editor.unplaced.objects,client.snapshot.state.objects.pocket);
});

test('0.22 mock: catalog, pocket, place, transform, configure, remove and their errors',async t=>{
 const {connect}=await fixture(t,{obstacles:[{min:[2,0,-1],max:[3,3,0]}]});
 const client=await connect();await client.subscribe();
 const notices=[];client.on('runtime.notice',n=>notices.push(n.code));
 const catalog=await client.call('objects.catalog',{});
 assert.equal(catalog.revision,client.snapshot.state.objects.catalogRevision);
 const byRef=Object.fromEntries(catalog.entries.map(e=>[e.ref,e]));
 assert.ok(byRef[rack].placeable && byRef['package/reading-chair'].placeable && byRef['user/desk-plant'].placeable);
 assert.equal(byRef['package/armillary'].reason,REASONS.notMovable);
 assert.equal(byRef['library/com.hyprune.starter@0.1.0/guide'].reason,REASONS.character);
 assert.equal(byRef['library/com.hyprune.starter@0.1.0/mine-cart'].reason,REASONS.mover);
 assert.match(byRef['user/broken-lamp'].reason,/^invalid: bounds/);
 // pocket
 const {itemId}=await client.call('objects.pocket',{ref:rack});assert.match(itemId,/^pocket-\d+$/);
 await rejects(client.call('objects.pocket',{ref:'library/com.hyprune.starter@0.1.0/guide'}),-32005);
 await rejects(client.call('objects.pocket',{ref:'user/nothing-here'}),-32004);
 // place in front of the player (no pose): floor of the work zone, facing the player; uses the pocket item
 const placed=await client.call('objects.place',{ref:rack});assert.match(placed.id,/^u-[0-9a-f]{6}$/);
 await client.resync();let state=client.snapshot.state.objects,mine=state.instances.find(i=>i.id===placed.id);
 assert.deepEqual(mine.pose.position,[0,0,-2]);assert.equal(mine.areaId,'work');assert.equal(mine.state,'active');assert.equal(mine.source,'user');
 assert.deepEqual(state.pocket,[]);assert.deepEqual(state.usage,{placements:1,assets:1,triangles:4210,gpuBytes:1048576,collisionTriangles:12});
 assert.equal(placed.revision,client.snapshot.revision);
 // explicit poses and the placement rules
 const lantern='library/com.hyprune.starter@0.1.0/street-lantern';
 const second=await client.call('objects.place',{ref:lantern,pose:pose(-2,-3),scale:1.25});
 await rejects(client.call('objects.place',{ref:lantern,pose:pose(30,30)}),-32007,'playable');
 await rejects(client.call('objects.place',{ref:lantern,pose:pose(2.5,-0.5)}),-32007,'walls');
 await rejects(client.call('objects.place',{ref:lantern,pose:pose(-2,-3,1)}),-32007,'support');
 await rejects(client.call('objects.place',{ref:lantern,pose:pose(0,0)}),-32007,'player');
 await rejects(client.call('objects.place',{ref:lantern,pose:pose(-2,-3),scale:2}),-32602);
 await rejects(client.call('objects.place',{ref:lantern,pose:{position:[-2,0,-3],rotation:[0,0.5,0,0.5]}}),-32602);
 await rejects(client.call('objects.place',{ref:'package/armillary'}),-32005);
 await rejects(client.call('objects.place',{ref:'package/nothing'}),-32004);
 // transform, lock, reset
 await client.call('objects.transform',{id:second.id,pose:{position:[-1,0,-4],rotation:[0,0.7071068,0,0.7071068]},scale:1.5});
 await rejects(client.call('objects.transform',{id:second.id,pose:pose(30,30)}),-32007,'playable');
 await client.call('objects.configure',{id:second.id,patch:{locked:true}});
 await rejects(client.call('objects.transform',{id:second.id,pose:pose(-1,-4)}),-32005);
 await rejects(client.call('objects.remove',{id:second.id}),-32005);
 await client.call('objects.configure',{id:second.id,patch:{locked:false}});
 await client.call('objects.reset',{id:second.id});await client.resync();
 mine=client.snapshot.state.objects.instances.find(i=>i.id===second.id);
 assert.equal(mine.scale,1);assert.deepEqual(mine.pose.position,[-1,0,-4]);assert.ok(Math.abs(mine.pose.rotation[1]-0.707107)<1e-5,'reset keeps the yaw');
 await rejects(client.call('objects.hide',{id:second.id,hidden:true}),-32005);
 // authored instances: hide/transform/reset; the armillary is not movable
 await rejects(client.call('objects.hide',{id:'observatory-armillary',hidden:true}),-32005);
 await rejects(client.call('objects.transform',{id:'observatory-armillary',pose:pose(8,-2)}),-32005);
 await rejects(client.call('objects.remove',{id:'reading-chair'}),-32005);
 await client.call('objects.hide',{id:'reading-chair',hidden:true});
 await client.call('objects.transform',{id:'reading-chair',pose:pose(-3,-5)});await client.resync();
 let chair=client.snapshot.state.objects.instances.find(i=>i.id==='reading-chair');
 assert.equal(chair.state,'hidden');assert.deepEqual(chair.pose.position,[-3,0,-5]);
 await client.call('objects.reset',{all:true});await client.resync();
 chair=client.snapshot.state.objects.instances.find(i=>i.id==='reading-chair');
 assert.equal(chair.state,'active');assert.deepEqual(chair.pose.position,[-2,0,-4]);
 await rejects(client.call('objects.transform',{id:'nothing',pose:pose(0,-2)}),-32004);
 // remove one, then all
 await client.call('objects.remove',{id:placed.id});await client.resync();
 assert.deepEqual(client.snapshot.state.objects.instances.filter(i=>i.source==='user').map(i=>i.id),[second.id]);
 await client.call('objects.remove',{all:true});await client.resync();
 assert.equal(client.snapshot.state.objects.instances.filter(i=>i.source==='user').length,0);
 assert.equal(client.snapshot.state.objects.instances.length,2,'authored instances stay');
 await until(()=>notices.includes('object.removed'));assert.ok(notices.includes('object.placed') && notices.includes('placement.pocketed'));
});

test('0.22 mock: budgets refuse with -32008 and rule "budget"; the pocket holds 16',async t=>{
 const {connect}=await fixture(t);const client=await connect();
 let refused;
 for(let i=0;i<200 && !refused;i++)await client.call('objects.place',{ref:rack,pose:pose(2,-4)}).catch(e=>{refused=e;});
 assert.equal(refused.code,-32008);assert.deepEqual(refused.data,{retryable:false,rule:'budget'});assert.match(refused.message,/^budget: triangles/);
 for(let i=0;i<16;i++)await client.call('objects.pocket',{ref:'user/desk-plant'});
 await rejects(client.call('objects.pocket',{ref:'user/desk-plant'}),-32008,'budget');
 await client.subscribe();validateState(client.snapshot,'0.22');assert.equal(client.snapshot.state.editor.unplaced.count,16);
});

test('0.22 mock: libraries list, install (hash, idempotence, conflict), remove and fallbacks',async t=>{
 const {connect,dir}=await fixture(t);const client=await connect();await client.subscribe();
 const old=await connect(['state.read'],'0.21','org.example.old');const oldNotices=[];old.on('runtime.notice',n=>oldNotices.push(n.code));
 const notices=[];client.on('runtime.notice',n=>notices.push(n.code));
 const listed=await client.call('libraries.list',{});
 assert.deepEqual(listed.libraries.map(l=>[l.id,l.version,l.root,l.state]),[['com.hyprune.starter','0.1.0','system','ready']]);
 await rejects(client.call('libraries.remove',{id:'com.hyprune.starter',version:'0.1.0'}),-32005);
 await rejects(client.call('libraries.remove',{id:'com.example.none',version:'1.0.0'}),-32004);
 const v1=packLibrary(await writeLibrary(join(dir,'v1')),join(dir,'com.example.street-1.2.0.tar.zst'));
 const sha=createHash('sha256').update(await readFile(v1)).digest('hex');
 await rejects(client.call('libraries.install',{archive:v1,sha256:'0'.repeat(64)}),-32602);
 await rejects(client.call('libraries.install',{archive:join(dir,'missing.tar.zst'),sha256:sha}),-32602);
 const catalogBefore=client.snapshot.state.objects.catalogRevision;
 const installed=await client.call('libraries.install',{archive:v1,sha256:sha});
 assert.deepEqual([installed.id,installed.version],['com.example.street','1.2.0']);
 await client.resync();assert.ok(client.snapshot.state.objects.catalogRevision>catalogBefore);
 const record=(await client.call('libraries.list',{})).libraries.find(l=>l.id==='com.example.street');
 assert.deepEqual([record.root,record.state,record.objects],['user','ready',2]);assert.match(record.digest,/^[0-9a-f]{64}$/);
 const entries=(await client.call('objects.catalog',{})).entries.filter(e=>e.library==='com.example.street@1.2.0');
 assert.deepEqual(entries.map(e=>[e.ref,e.placeable,e.surfaces?.[0]]),[['library/com.example.street@1.2.0/street-lantern',true,'floor'],['library/com.example.street@1.2.0/bench',true,'floor']]);
 // idempotent with the same content; a different archive of the same id@version conflicts
 assert.equal((await client.call('libraries.install',{archive:v1,sha256:sha})).version,'1.2.0');
 const changed=await writeLibrary(join(dir,'v1b'),{name:'Street kit, edited'});
 const v1b=packLibrary(changed,join(dir,'com.example.street-1.2.0b.tar.zst')),shaB=createHash('sha256').update(await readFile(v1b)).digest('hex');
 await rejects(client.call('libraries.install',{archive:v1b,sha256:shaB}),-32007,'library.conflict');
 // a 1.3.0 next to 1.2.0: the catalog shows the highest and lists the other version
 const v13=packLibrary(await writeLibrary(join(dir,'v13'),{version:'1.3.0'}),join(dir,'com.example.street-1.3.0.tar.zst'));
 await client.call('libraries.install',{archive:v13,sha256:createHash('sha256').update(await readFile(v13)).digest('hex')});
 const lantern=(await client.call('objects.catalog',{})).entries.filter(e=>e.id==='street-lantern' && e.library?.startsWith('com.example.street@'));
 assert.deepEqual(lantern.map(e=>[e.library,e.versions]),[['com.example.street@1.3.0',['1.2.0']]]);
 // placements fall back to the same major when their version is removed, else read missing
 const placed=await client.call('objects.place',{ref:'library/com.example.street@1.2.0/bench',pose:pose(-2,-3)});
 await client.call('libraries.remove',{id:'com.example.street',version:'1.2.0'});await client.resync();
 assert.equal(client.snapshot.state.objects.instances.find(i=>i.id===placed.id).ref,'library/com.example.street@1.3.0/bench');
 await client.call('libraries.remove',{id:'com.example.street',version:'1.3.0'});await client.resync();
 const missing=client.snapshot.state.objects.instances.find(i=>i.id===placed.id);assert.equal(missing.state,'missing');assert.equal(missing.movable,false);
 await until(()=>notices.includes('object.missing'));
 assert.ok(notices.includes('library.installed') && notices.includes('object.substituted'));
 assert.ok(!oldNotices.some(c=>/^(object|library)\./.test(c)),'0.21 peers get no object notices');
});

test('0.22 mock: a user folder replaces the fixture user objects and is rescanned',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hyprune-userobjects-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeObject(join(root,'street-lantern'));await writeObject(join(root,'wrong-name'),'other-id');
 const {connect}=await fixture(t,{objectDir:root});const client=await connect();await client.subscribe();
 let users=(await client.call('objects.catalog',{})).entries.filter(e=>e.source==='user');
 assert.deepEqual(users.map(e=>[e.ref,e.state,e.placeable]),[['user/street-lantern','ready',true],['user/wrong-name','invalid',false]]);
 assert.equal(users[0].thumbnail,join(root,'street-lantern','thumbnail.png'));assert.equal(users[0].triangles,1);
 assert.match(users[1].errors[0],/differs from its directory/);
 const revision=client.snapshot.state.objects.catalogRevision;
 await writeObject(join(root,'bench'));
 await until(()=>client.snapshot.state.objects.catalogRevision>revision,4000);
 users=(await client.call('objects.catalog',{})).entries.filter(e=>e.source==='user');
 assert.deepEqual(users.map(e=>e.id),['bench','street-lantern','wrong-name']);
 const placed=await client.call('objects.place',{ref:'user/bench',pose:pose(-2,-3)});
 await rm(join(root,'bench'),{recursive:true});
 await until(()=>client.snapshot.state.objects.instances.find(i=>i.id===placed.id)?.state==='missing',4000);
});

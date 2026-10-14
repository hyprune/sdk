// Compile-only checks: public method and event types follow generated contracts.
import {HypruneClient,clientFromEnvironment,type State} from '../src/index.js';
function check(client:HypruneClient,state:State) {
 client.call('world.load',{worldId:'org.example.world'}).then(result=>{const revision:number=result.revision;void revision;});
 client.on('runtime.notice',notice=>{const level:'info'|'warning'|'error'=notice.level;void level;});
 client.on('state',snapshot=>{const same:State=snapshot.state;void same;});
 // @ts-expect-error missing required subscription ID
 client.call('state.snapshot',{});
 // @ts-expect-error unknown method
 client.call('world.execute',{});
 // @ts-expect-error parameters of another method
 client.call('session.ping',{worldId:'org.example.world'});
 // @ts-expect-error unknown event
 client.on('state.patch',()=>{});
 client.on('runtime.notice',notice=>{
  // @ts-expect-error notices never carry a window title
  console.log(notice.title);
 });
 // @ts-expect-error position is exactly three numbers
 client.call('camera.set',{position:[0,1],orientation:[0,0,0,1]});
 // @ts-expect-error orientation is exactly four numbers
 state.movement.orientation=[0,0,0];
}
void check;

function m1(client:HypruneClient,legacy:HypruneClient<'0.1'>) {
 client.call('data.publish',{sourceId:'org.example.metrics',sequence:1,values:{cpu:2,ok:true,label:'CPU'}});
 client.call('travel.start',{to:{zoneId:'desk'},durationMs:600});
 client.on('location.transition',event=>{const progress:number|null=event.progress;void progress;});
 client.on('state',s=>console.log(s.state.location.transition,s.state.integrations.sources));
 // @ts-expect-error legacy wire has no camera method
 legacy.call('camera.get',{});
 // @ts-expect-error legacy snapshot has exactly the original state keys
 legacy.on('state',s=>console.log(s.state.location));
 // @ts-expect-error sequence is required by real publishing
 client.call('data.publish',{sourceId:'org.example.metrics',values:{cpu:2}});
 // @ts-expect-error nested data values are forbidden
 client.call('data.publish',{sourceId:'org.example.metrics',sequence:1,values:{cpu:{nested:2}}});
 // @ts-expect-error target cannot be an arbitrary package path
 client.call('travel.start',{to:{path:'/tmp/world'}});
}
void m1;

const publisher=clientFromEnvironment({protocol:'0.2',capabilities:['data.publish']});
publisher.call('data.publish',{sourceId:'org.example.metrics',sequence:1,values:{cpu:2}});
const envClient=clientFromEnvironment();
envClient.call('camera.get',{}); // dynamic protocol: unavailable methods reject at runtime
// @ts-expect-error environment-driven clients may be legacy, so location requires narrowing
console.log(envClient.snapshot?.state.location);

function hands(client:HypruneClient<'0.5'>, old:HypruneClient<'0.4'>) {
 client.call('surface.pull',{surfaceId:'terminal'});
 client.on('state',s=>{const slot:number=s.state.interaction.tool;const mode:'movement'|'typing'|'workspace'|'fullscreen'=s.state.interaction.mode;console.log(slot,mode,s.state.apps[0]?.appClass);});
 // @ts-expect-error the frozen 0.4 state has no hands-on mode or app list
 old.on('state',s=>console.log(s.state.interaction));
}
void hands;

function hud(client:HypruneClient<'0.9'>, old:HypruneClient<'0.8'>) {
 client.call('hud.subscribe',{topics:['hud.pose','hud.frame']});
 // @ts-expect-error frozen 0.8 has no opt-in HUD streams
 old.call('hud.subscribe',{topics:['hud.pose']});
 // @ts-expect-error notifications are not callable RPC methods
 client.call('hud.pose',{});
}
void hud;

function performance(client:HypruneClient<'0.10'>, old:HypruneClient<'0.9'>) {
 client.call('graphics.set',{patch:{offload:'on',scale_min:.5,offload_power_cap_w:45}}).then(r=>console.log(r.performance.activeRenderer));
 // @ts-expect-error 0.9 has no offload mutation
 old.call('graphics.set',{patch:{offload:'on'}});
}
void performance;

function recording(client:HypruneClient<'0.12'>, old:HypruneClient<'0.11'>) {
 client.call('recording.start',{includeAppKeys:false});
 client.call('replay.start',{path:'/tmp/session.jsonl',mode:'camera',smoothingMs:100,assertions:{marks:{end:{tool:2}}}}).then(s=>console.log(s.playing));
 // @ts-expect-error 0.11 climbing does not expose input recording
 old.call('recording.start',{});
 // @ts-expect-error camera replay cannot request a native-input injection mode
 client.call('replay.start',{path:'/tmp/session.jsonl',mode:'inject'});
}
void recording;

const photoClient = new HypruneClient({protocol:'0.13',capabilities:['camera.author','state.read']});
void photoClient.call('camera.photo',{position:[0,2,4],orientation:[0,0,0,1],fov:15,lensShift:[.2,0],renderScale:1});
void photoClient.call('camera.release',{});
void photoClient.call('graphics.set',{patch:{outline:true,visibility_culling:false}});

// IPC 0.14 inherits photo controls and exposes a typed nullable ink tier.
declare const inkClient: import('../src/client.js').HypruneClient<'0.14'>;
inkClient.call('graphics.set', {patch:{outline_quality:'smooth'}});
inkClient.call('graphics.set', {patch:{outline_quality:null}});
// @ts-expect-error unsupported tier
inkClient.call('graphics.set', {patch:{outline_quality:'ultra'}});

inkClient.call('graphics.set', {patch:{outline_width_px:3.5,outline_colour:[.2,.4,.6]}});
inkClient.call('graphics.set', {patch:{outline_width_px:null,outline_colour:null}});

// World 0.6 preserves property types alongside its at-least-one-field union.
import type {World06_Document} from '../src/generated.js';
const playable:World06_Document['playable']={volumes:[{type:'convex',points:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]]}],maxFlyHeight:7};
void playable;
// @ts-expect-error height is numeric, even with the anyOf branch
const invalidPlayable:World06_Document['playable']={maxFlyHeight:'high'};
// @ts-expect-error a declaration cannot be empty
const emptyPlayable:World06_Document['playable']={};

// World 0.7 keeps the 0.6 manifest shape under its own format identifier.
import type {World07_Document} from '../src/generated.js';
const format07:World07_Document['formatVersion']='0.7';
void format07;
// @ts-expect-error a 0.7 document is not labelled 0.6
const format06as07:World07_Document['formatVersion']='0.6';

// World 0.8 adds typed object assets and placed objects; 0.7 documents have neither.
import type {World08_Document} from '../src/generated.js';
const objectAssets:World08_Document['objectAssets']=[{id:'armillary',scene:'objects/armillary.gltf',
  animations:[{node:'ring',type:'spin',axis:[1,0,0],pivot:[0,0,0],period:20},{node:'buoy',type:'bob',axis:[0,1,0],amplitude:.05,period:4}],
  collision:{node:'proxy'},lighting:{mode:'probe'}}];
const placed:World08_Document['objects']=[{id:'a',asset:'armillary',pose:{position:[0,0,0],rotation:[0,0,0,1]},speed:1,phase:.5,ambient:[.3,.3,.3]}];
void objectAssets;void placed;
// @ts-expect-error only spin, orbit and bob
const wobble:World08_Document['objectAssets']=[{id:'a',scene:'a.gltf',animations:[{node:'n',type:'wobble',axis:[0,1,0],period:2}]}];
// @ts-expect-error lighting is probe or unlit
const baked:World08_Document['objectAssets']=[{id:'a',scene:'a.gltf',lighting:{mode:'baked'}}];
// @ts-expect-error world 0.7 has no objects
const old07:World07_Document['objects']=[];

// IPC 0.16 adds a typed nullable upscaler choice and inherits 0.14 ink tiers.
declare const upscalerClient: import('../src/client.js').HypruneClient<'0.16'>;
upscalerClient.call('graphics.set', {patch:{upscaler:'fsr1',outline_quality:'fast'}});
upscalerClient.call('graphics.set', {patch:{upscaler:null}});
// @ts-expect-error unsupported upscaler
upscalerClient.call('graphics.set', {patch:{upscaler:'fsr2'}});
// @ts-expect-error 0.15 sessions cannot write the upscaler
inkClient.call('graphics.set', {patch:{upscaler:'bilinear'}});

// IPC 0.18 makes the offload cap nullable (automatic) up to 1000 W, adds the
// offload device choice and reports the cap source and chosen GPU.
declare const offloadClient: import('../src/client.js').HypruneClient<'0.18'>;
declare const captureClient: import('../src/client.js').HypruneClient<'0.17'>;
offloadClient.call('graphics.set', {patch:{offload_power_cap_w:null,offload_device:'auto',upscaler:'fsr1'}});
offloadClient.call('graphics.set', {patch:{offload_power_cap_w:350,offload_device:'0000:65:00.0'}});
// @ts-expect-error the device is a string, not a render node index
offloadClient.call('graphics.set', {patch:{offload_device:128}});
// @ts-expect-error 0.17 sessions cannot choose the offload device
captureClient.call('graphics.set', {patch:{offload_device:'auto'}});
// @ts-expect-error 0.17 sessions cannot request the automatic cap
captureClient.call('graphics.set', {patch:{offload_power_cap_w:null}});
offloadClient.call('graphics.get', {}).then(({performance})=>{
 const source:'profile'|'device'|'configured'|'fallback'=performance.capSource;void source;
 // @ts-expect-error the device is null until one is chosen
 const pci:string=performance.device.pci;void pci;
 if(performance.device){
  const limit:number|null=performance.device.enforcedLimitW;const own:boolean=performance.device.drivesCompositor;
  const selection:'auto'|'explicit'=performance.device.selection;void limit;void own;void selection;
 }
 const cap:number|null=performance.effective.offload_power_cap_w;void cap;
});
captureClient.call('graphics.get', {}).then(({performance})=>{
 // @ts-expect-error 0.17 Performance records have no cap source
 void performance.capSource;
});

// IPC 0.19 adds typed player settings and the interaction reticle.
declare const playerClient: import('../src/client.js').HypruneClient<'0.19'>;
playerClient.call('player.get', {}).then(r=>{const reach:number=r.config.reach_grab;const bob:'off'|'subtle'|'normal'=r.defaults.view_bob;void reach;void bob;});
playerClient.call('player.set', {patch:{walk_speed:5,reticle_colour:[1,0.5,0],view_bob:null}});
playerClient.call('player.set', {patch:{reticle_colour:'theme',reticle_style:'chevron'}});
playerClient.call('graphics.set', {patch:{offload_device:'auto',fov:120}});
playerClient.on('state', s=>{const state:'hidden'|'neutral'|'typing'|'target'|'valid'|'out_of_range'|'invalid'|'holding'=s.state.interaction.reticle.state;void state;});
// @ts-expect-error unknown reticle style
playerClient.call('player.set', {patch:{reticle_style:'square'}});
// @ts-expect-error run_multiplier is not part of the wire contract
playerClient.call('player.set', {patch:{run_multiplier:2}});
// @ts-expect-error 0.18 sessions have no player settings
offloadClient.call('player.get', {});

// IPC 0.20 adds the pocket actions and blueprint map levels.
declare const pocketClient: import('../src/client.js').HypruneClient<'0.20'>;
pocketClient.call('surface.pocket', {surfaceId:'surface-1'}).then(r=>{const revision:number=r.revision;void revision;});
pocketClient.call('surface.unpocket', {surfaceId:'surface-1'}).then(r=>{const placed:boolean=r.placed;void placed;});
pocketClient.on('state', s=>{const level=s.state.spatial.map?.levels?.[0];const name:string|undefined=level?.name;void name;});
// @ts-expect-error unpocket takes only a surface
pocketClient.call('surface.unpocket', {surfaceId:'surface-1', anchorId:'desk'});
// @ts-expect-error 0.19 sessions have no pocket actions
playerClient.call('surface.pocket', {surfaceId:'surface-1'});

// Object and library manifests (RFC-0011): 0.9, the draft 0.10 and the release record.
import type {Object09_Document,Object10_Document,Library09_Document,LibraryReleases09_Document} from '../src/index.js';
const bench:Object09_Document={formatVersion:'0.9',id:'bench',version:'1.0.0',name:'Bench',category:'furniture',scene:'object.glb',license:'CC0-1.0',
 attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],bounds:{min:[-0.8,0,-0.25],max:[0.8,0.85,0.25]},thumbnail:'thumbnail.png',
 traits:{collidable:{node:'proxy'},movable:{surfaces:['floor'],scale:[0.5,2]},seat:{capacity:2,anchors:[{id:'left',position:[-0.4,0,0.55],yaw:0,height:0.45}]}}};
void bench;
const walker:Object09_Document['traits']={character:{height:1.7,clips:{walk:{speed:1.4},idle:{},wave:{}},interactions:[{id:'hello',label:'Talk',action:{type:'say',lines:['Hello']}}]}};
void walker;
// @ts-expect-error reserved traits can never be present in object format 0.9
const mover09:Object09_Document['traits']={mover:{speed:2}};void mover09;
// @ts-expect-error characters need walk and idle clips
const noIdle:Object09_Document['traits']={character:{height:1.7,clips:{walk:{}}}};void noIdle;
// @ts-expect-error unknown category
const badCategory:Object09_Document['category']='weapons';void badCategory;
// @ts-expect-error say interactions carry lines, not a panel
const badAction:Object09_Document['traits']={character:{height:1.7,clips:{walk:{},idle:{}},interactions:[{id:'a',label:'A',action:{type:'say',panel:'map'}}]}};void badAction;
const cart:Object10_Document['traits']={mover:{speed:2,pitch:'follow',item:false},decorative:{animations:[{node:'wheel',type:'spin',axis:[1,0,0],pivot:[0,0,0],period:2}]}};void cart;
const lamp:Object10_Document['traits']={machine:{primary:'on',inputs:[{id:'on',type:'bool',label:'On',explain:'Lamp power',default:true}],drives:[{input:'on',target:'state:lamp',map:{cases:[{equals:true,to:'lit'}],else:'dark'}}]}};void lamp;
// @ts-expect-error mapping cases need equals or in
const noCase:Object10_Document['traits']={machine:{inputs:[{id:'on',type:'bool',label:'On',explain:'Power'}],drives:[{input:'on',target:'state:lamp',map:{cases:[{to:'lit'}]}}]}};void noCase;
// @ts-expect-error 0.10 still reserves mount
const mount10:Object10_Document['traits']={mount:{}};void mount10;
const library:Library09_Document={formatVersion:'0.9',id:'com.example.street',version:'1.2.0',name:'Street',license:'CC0-1.0',attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],objects:['bench','street-lantern']};void library;
// @ts-expect-error a 0.9 library is not a 0.10 one
const library10:Library09_Document={...library,formatVersion:'0.10'};void library10;
const releases:LibraryReleases09_Document={'com.example.street@1.2.0':{id:'com.example.street',version:'1.2.0',formatVersion:'0.9',url:'https://example.com/com.example.street-1.2.0.tar.zst',sha256:'f0'.repeat(32),nixHash:'sha256-',published:false}};void releases;
// @ts-expect-error release records say whether they are published
const unpublished:LibraryReleases09_Document={'a.b@1.0.0':{id:'a.b',version:'1.0.0',formatVersion:'0.9',url:'https://example.com/a.b-1.0.0.tar.zst',sha256:'',nixHash:''}};void unpublished;

// IPC 0.21 adds markers, personal quests and focus sessions.
declare const questClient: import('../src/client.js').HypruneClient<'0.21'>;
questClient.call('quests.create', {quest:{title:'Write the release notes',steps:[{title:'Draft',objectives:[{id:'focus',type:'focus',sessions:2}]}]}})
 .then(r=>{const id:string=r.questRef.id;void id;});
questClient.call('quests.track', {questRef:null});
questClient.call('quests.mark', {questRef:{source:'personal',id:'notes'},stepId:'draft',objectiveId:'done'});
questClient.call('focus.start', {target:{kind:'window',appClass:'org.example.Editor',workspaceId:21},overrides:{work_min:50,cycles:2}}).then(r=>{const s:string=r.sessionId;void s;});
questClient.call('guidance.set', {patch:{'markers.reveal_ms':6000,'focus.calm':null}}).then(r=>{const ms:number=r.config['markers.reveal_ms'];void ms;});
questClient.call('focus.history', {days:7}).then(r=>{const kind:string|undefined=r.intervals[0]?.targetKind;void kind;});
questClient.on('state', s=>{
 const phase:'idle'|'work'|'break'|'ready'|'paused'=s.state.focus.state;
 const tier:number|undefined=s.state.markers.list[0]?.tier;
 const tracked=s.state.quests.tracked?.id;void phase;void tier;void tracked;
});
questClient.on('quest.progress', e=>{const kind:'objective'|'step'|'completed'|'available'|'failed'=e.kind;void kind;});
questClient.on('focus.phase', e=>{const id:string=e.focusSessionId;void id;});
// @ts-expect-error a focus objective needs its sessions
questClient.call('quests.create', {quest:{title:'x',steps:[{title:'y',objectives:[{id:'f',type:'focus'}]}]}});
// @ts-expect-error a window target needs its workspace
questClient.call('focus.start', {target:{kind:'window',appClass:'org.example.Editor'}});
// @ts-expect-error 0.20 sessions have no quests
pocketClient.call('quests.list', {});
// @ts-expect-error 0.20 sessions have no focus events
pocketClient.on('focus.phase', ()=>{});

// IPC 0.22 adds the object catalog, user placements, libraries and objects.control.
declare const objectsClient: import('../src/client.js').HypruneClient<'0.22'>;
new HypruneClient({protocol:'0.22',capabilities:['state.read','objects.control']});
objectsClient.call('objects.catalog', {}).then(r=>{
 const e=r.entries[0];const placeable:boolean|undefined=e?.placeable;const source:'package'|'library'|'user'|undefined=e?.source;
 const thumb:string|null|undefined=e?.thumbnail;void placeable;void source;void thumb;
});
objectsClient.call('objects.place', {ref:'library/com.hyprune.starter@0.1.0/server-rack',pose:{position:[1,0,-2],rotation:[0,0,0,1]},scale:1.2}).then(r=>{const id:string=r.id;void id;});
objectsClient.call('objects.place', {ref:'user/lamp'});
objectsClient.call('objects.pocket', {ref:'user/lamp'}).then(r=>{const item:string=r.itemId;void item;});
objectsClient.call('objects.transform', {id:'u-1a2b3c',pose:{position:[0,0,0],rotation:[0,0,0,1]}});
objectsClient.call('objects.remove', {all:true});
objectsClient.call('objects.reset', {id:'armillary'});
objectsClient.call('objects.hide', {id:'armillary',hidden:true});
objectsClient.call('objects.configure', {id:'u-1a2b3c',patch:{locked:true}});
objectsClient.call('libraries.install', {archive:'/tmp/com.example.kit-1.0.0.tar.zst',sha256:'0'.repeat(64)}).then(r=>{const v:string=r.version;void v;});
objectsClient.call('libraries.list', {}).then(r=>{const root:'user'|'system'|undefined=r.libraries[0]?.root;void root;});
objectsClient.call('libraries.remove', {id:'com.example.kit',version:'1.0.0'});
objectsClient.on('state', s=>{
 const o=s.state.objects;const rev:number=o.catalogRevision;const state:'active'|'hidden'|'missing'|'blocked'|'loading'|'suspended'|undefined=o.instances[0]?.state;
 const path:null|undefined=o.instances[0]?.path;const gizmo:'world'|'local'=s.state.editor.gizmo.space;const items=s.state.editor.unplaced.objects.length;
 void rev;void state;void path;void gizmo;void items;
});
// @ts-expect-error the P1 configure patch only knows locked
objectsClient.call('objects.configure', {id:'u-1a2b3c',patch:{speed:2}});
// @ts-expect-error a transform needs its pose
objectsClient.call('objects.transform', {id:'u-1a2b3c'});
// @ts-expect-error 0.21 sessions have no object catalog
questClient.call('objects.catalog', {});
// @ts-expect-error objects.control is new in 0.22
new HypruneClient({protocol:'0.21',capabilities:['objects.control']});
questClient.on('state', s=>{
 // @ts-expect-error 0.21 state has no objects key
 void s.state.objects;
});

// IPC 0.23 adds characters (npcs), paths and interactions on top of 0.22.
declare const npcClient: import('../src/client.js').HypruneClient<'0.23'>;
new HypruneClient({protocol:'0.23',capabilities:['state.read','objects.control','world.control']});
npcClient.call('npcs.spawn', {ref:'package/guide',path:'user/path-1',phase:.25,speed:1.5,accent:[1,.5,0],reverse:true}).then(r=>{const id:string=r.id;void id;});
npcClient.call('npcs.spawn', {ref:'package/guide',pose:{position:[0,0,-2],rotation:[0,0,0,1]}});
npcClient.call('npcs.spawn', {ref:'package/guide'});
npcClient.call('npcs.bind', {id:'u-1a2b3c',path:'loop'});
npcClient.call('npcs.disable', {id:'keeper',disabled:true});
npcClient.call('npcs.remove', {all:true});
npcClient.call('npcs.remove', {id:'u-1a2b3c'});
npcClient.call('paths.list', {}).then(r=>{
 const p=r.paths[0];const ref:string|undefined=p?.ref;const walkable:boolean|null|undefined=p?.walkable;const bound:string[]|undefined=p?.bound;
 const use:'route'|'track'|'generic'|undefined=p?.use;void ref;void walkable;void bound;void use;
});
npcClient.call('paths.set', {path:{use:'route',closed:false,points:[{position:[0,0,0],type:'line'},{position:[2,0,0],type:'curve'}],stops:[{point:1,seconds:4,clip:'wave'}]}}).then(r=>{const id:string=r.id;void id;});
npcClient.call('paths.remove', {id:'path-1',unbind:true});
npcClient.call('paths.draw', {use:'route',spawn:{ref:'package/guide',speed:1}});
npcClient.call('paths.finish', {}).then(r=>{const id:string|null=r.id;const bound:string|null=r.bound;void id;void bound;});
npcClient.call('interaction.choose', {objectId:'keeper',interactionId:'chat'});
npcClient.call('interaction.choose', {objectId:'keeper',interactionId:null});
npcClient.call('graphics.set', {patch:{npc_motion:'still'}});
npcClient.on('state', s=>{
 const n=s.state.npcs;const motion:'auto'|'always'|'still'|'off'=n.motion;const user:number=n.limits.user;
 const line:string|null|undefined=n.interaction?.line;const aimed:number|undefined=n.aimed?.interactions.length;
 const i=s.state.objects.instances[0];const character:boolean|undefined=i?.character;const path:string|null|undefined=i?.path;
 const activity:string|null|undefined=i?.activity;const accent:[number,number,number]|null|undefined=i?.accent;
 const stops:number|undefined=s.state.editor.paths[0]?.stops.length;
 void motion;void user;void line;void aimed;void character;void path;void activity;void accent;void stops;
});
// @ts-expect-error a stop needs its point
npcClient.call('paths.set', {path:{use:'route',closed:false,points:[],stops:[{seconds:3}]}});
// @ts-expect-error interaction.choose needs an explicit interactionId (null ends it)
npcClient.call('interaction.choose', {objectId:'keeper'});
// @ts-expect-error 0.22 sessions have no characters
objectsClient.call('npcs.spawn', {ref:'package/guide'});
// @ts-expect-error 0.22 sessions have no npc_motion
objectsClient.call('graphics.set', {patch:{npc_motion:'still'}});
objectsClient.on('state', s=>{
 // @ts-expect-error 0.22 state has no npcs key
 void s.state.npcs;
 // @ts-expect-error 0.22 instances have no character flag
 void s.state.objects.instances[0]?.character;
});

// World format 0.9: object asset sources, characters on routes, paths, seats and keepClear.
import type {World09_Document} from '../src/generated.js';
const assets09:World09_Document['objectAssets']=[{id:'guide',dir:'objects/guide'},{id:'bench',library:'com.example.kit@1.0.0',object:'bench'},
 {id:'lamp',scene:'objects/lamp.glb',traits:{collidable:{node:'collision'}}}];
const objects09:World09_Document['objects']=[{id:'g',asset:'guide',path:'loop',reverse:true,accent:[1,0,0],
 interactions:[{id:'hello',label:'Talk',action:{type:'say',lines:['Hello']}},{id:'go',label:'Show me',action:{type:'guide',path:'loop'}}]}];
const paths09:World09_Document['paths']=[{id:'loop',use:'route',closed:true,points:[{position:[0,0,0],type:'line'},{position:[4,0,0],type:'arc'}],stops:[{point:1,face:{object:'g'}}]}];
const seats09:World09_Document['seats']=[{id:'bench-1',pose:{position:[0,0,0],rotation:[0,0,0,1]},height:.45}];
const keep09:World09_Document['keepClear']=[{id:'door',min:[0,0,0],max:[1,2,1]}];
void assets09;void objects09;void paths09;void seats09;void keep09;
// @ts-expect-error 0.8 manifests have no paths
const paths08:World08_Document['paths']=[];void paths08;

// IPC 0.24 adds the catalog's machine inputs and the live state key on top of 0.23.
declare const liveClient: import('../src/client.js').HypruneClient<'0.24'>;
new HypruneClient({protocol:'0.24',capabilities:['state.read','objects.control']});
liveClient.call('objects.catalog', {}).then(r=>{
 const m=r.entries[0]?.machine;const primary:string|null|undefined=m?.primary;const kind:string|undefined=m?.inputs[0]?.type;
 const repeat:number|undefined=m?.inputs[0]?.repeat;void primary;void kind;void repeat;
});
liveClient.on('state', s=>{
 const i=s.state.live.instances[0];const id:string|undefined=i?.id;const source:string|null|undefined=i?.source;
 const status:'ok'|'error'|null|undefined=i?.status;const stale:boolean|undefined=i?.stale;
 const input=i?.inputs['health.1'];const condition:'fresh'|'stale'|'missing'|'error'|undefined=input?.condition;
 const publishedAt:number|null|undefined=input?.publishedAt;const value:string|number|boolean|null|undefined=input?.value;
 const npcs:string=s.state.npcs.motion;
 void id;void source;void status;void stale;void condition;void publishedAt;void value;void npcs;
});
liveClient.on('state.delta', d=>{const l=d.changes.live;void l?.instances.length;});
npcClient.call('objects.catalog', {}).then(r=>{
 // @ts-expect-error 0.23 catalog entries have no machine
 void r.entries[0]?.machine;
});
npcClient.on('state', s=>{
 // @ts-expect-error 0.23 state has no live key
 void s.state.live;
});

// IPC 0.25 adds the companion (methods, state key, catalog capability) on top of 0.24.
declare const companionClient: import('../src/client.js').HypruneClient<'0.25'>;
new HypruneClient({protocol:'0.25',capabilities:['state.read','objects.control']});
companionClient.call('companion.set', {ref:'library/io.github.ada.pip@0.1.0/pip'}).then(r=>{const n:number=r.revision;void n;});
companionClient.call('companion.mode', {mode:'stay'});
companionClient.call('companion.clear', {});
// @ts-expect-error route is set by npcs.bind, not companion.mode
companionClient.call('companion.mode', {mode:'route'});
companionClient.call('npcs.bind', {id:'companion',path:'user/path-3',phase:.4});
companionClient.call('objects.catalog', {}).then(r=>{
 const c=r.entries[0]?.companion;const capable:boolean|undefined=c?.capable;const reason:string|null|undefined=c?.reason;
 const machine=r.entries[0]?.machine;void capable;void reason;void machine;
});
companionClient.on('state', s=>{
 const c=s.state.companion;const state:'none'|'loading'|'unavailable'|'active'|'waiting'|'hidden'=c.state;
 const mode:'follow'|'stay'|'route'=c.mode;const carried:boolean=c.carried;const at=c.position?.[0];
 const live=s.state.live.instances.length;void state;void mode;void carried;void at;void live;
});
companionClient.on('state.delta', d=>{const c=d.changes.companion;void c?.activity;});
// @ts-expect-error 0.24 has no companion methods
liveClient.call('companion.set', {ref:'user/walker'});
liveClient.on('state', s=>{
 // @ts-expect-error 0.24 state has no companion key
 void s.state.companion;
});

// IPC 0.26 names tool 9 (the debug tool), adds the companion's pace and lists up to 128 pocketed windows.
declare const debugClient: import('../src/client.js').HypruneClient<'0.26'>;
new HypruneClient({protocol:'0.26',capabilities:['state.read','objects.control']});
debugClient.call('companion.mode', {mode:'follow',pace:'run'});
debugClient.call('companion.mode', {mode:'stay'});
// @ts-expect-error pace is walk or run
debugClient.call('companion.mode', {mode:'follow',pace:'sprint'});
// @ts-expect-error 0.25 companion.mode has no pace
companionClient.call('companion.mode', {mode:'follow',pace:'run'});
debugClient.on('state', s=>{
 const tool:1|2|3|4|5|9=s.state.editor.tool;const pace:'walk'|'run'=s.state.companion.pace;
 const d=s.state.editor.debugTool;const layer:string|undefined=d?.layer;const card:string[]|null|undefined=d?.card;
 const colour=d?.legend[0]?.colour;const slot9=s.state.editor.toolDefinitions[5].slot;const nine:string[]=s.state.keymap.config.modes.world.tool9;
 void tool;void pace;void layer;void card;void colour;void slot9;void nine;
});
debugClient.on('tool.changed', e=>{const slot:1|2|3|4|5|9=e.slot;void slot;});
companionClient.on('state', s=>{
 // @ts-expect-error 0.25 editor has no debugTool
 void s.state.editor.debugTool;
 // @ts-expect-error 0.25 companion has no pace
 void s.state.companion.pace;
});

// IPC 0.27: workspace screens on catalog entries and instances; objects.place/configure take a workspace.
declare const screensClient: import('../src/client.js').HypruneClient<'0.27'>;
new HypruneClient({protocol:'0.27',capabilities:['state.read','objects.control']});
screensClient.call('objects.configure', {id:'u-7c2e91',patch:{workspace:23}});
screensClient.call('objects.configure', {id:'u-7c2e91',patch:{workspace:'next-free'}});
screensClient.call('objects.configure', {id:'u-7c2e91',patch:{workspace:null}});
screensClient.call('objects.place', {ref:'user/workspace-screen-wall-16x9',workspace:'next-free'});
// @ts-expect-error a workspace is a number, next-free or null
screensClient.call('objects.configure', {id:'u-7c2e91',patch:{workspace:'next'}});
// @ts-expect-error 0.26 objects.configure has no workspace
debugClient.call('objects.configure', {id:'u-7c2e91',patch:{workspace:23}});
screensClient.on('state', s=>{
 const screen=s.state.objects.instances[0]?.screen;
 const workspace:number|null|undefined=screen?.workspace;const home:string|null|undefined=screen?.home;
 const aspect:'16:9'|'21:9'|undefined=screen?.aspect;
 void workspace;void home;void aspect;
});
screensClient.call('objects.catalog', {}).then(r=>{const s=r.entries[0]?.screen;const size:number[]|undefined=s?.size;void size;});
debugClient.on('state', s=>{
 // @ts-expect-error 0.26 instances have no screen
 void s.state.objects.instances[0].screen;
});

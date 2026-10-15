import {createServer,createConnection,type Server,type Socket} from 'node:net';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {chmodSync,lstatSync,unlinkSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {FrameDecoder,FrameError,encodeFrame,MAX_FRAME} from './codec.js';
import {secureDirectory,socketPath} from './paths.js';
import {validateWire,validateState,atLeast,type Protocol} from './validation.js';
import {RpcError} from './client.js';
import type {State,Snapshot} from './state.js';
import type {Common02_Capability,Ipc02_Target,Ipc02_Transition,MethodMap} from './generated.js';
import {QuestEngine,QUEST_REQUIREMENTS,QUEST_EVENTS,BASELINE_021} from './mock-quests.js';
import {ObjectEngine,OBJECT_REQUIREMENTS,catalogEntry22,catalogEntry24,catalogScreen27,catalogImport27,type Notice} from './mock-objects.js';
import {liveState} from './mock-live.js';
import {NpcEngine,NPC_REQUIREMENTS,type NpcCall,type PowerProfile} from './mock-npcs.js';
import {CompanionEngine,COMPANION_ID,COMPANION_REQUIREMENTS,companionOf,companion28,MOCK_MOTION,MOCK_DANCE_MS} from './mock-companion.js';
export {QuestEngine,QUEST_REQUIREMENTS,QUEST_EVENTS,BASELINE_021,GUIDANCE_DEFAULTS,slugify} from './mock-quests.js';
export {ObjectEngine,OBJECT_REQUIREMENTS,OBJECT_LIMITS,PLACEABLE_TRAITS,REASONS,PROTECTED,FIXTURE_CHARACTERS,placeability,manifestEntry,compareVersions,listArchive} from './mock-objects.js';
export {NpcEngine,NPC_REQUIREMENTS,NPC_LIMITS,GRAPHICS_DEFAULTS,WALK_SPEED,USE_DISTANCE,samplePath,type PowerProfile} from './mock-npcs.js';
export {LIVE_LIMIT,defaultSource,machineOf,liveState} from './mock-live.js';
export {CompanionEngine,COMPANION_ID,COMPANION_REQUIREMENTS,COMPANION_LIMITS,companionOf,MOCK_MOTION,MOCK_DANCE_MS} from './mock-companion.js';
export type Capability=Common02_Capability|'quest.control'|'objects.control';
export const GRANTS:Capability[]=['state.read','world.control','surface.control','movement.control','shell.control','runtime.control','data.publish'];
/** IPC 0.21 adds quest.control (quest and focus mutations, guidance.set). */
export const QUEST_GRANTS:Capability[]=[...GRANTS,'quest.control'];
/** The quest protocol the mock implements next to 0.1/0.2 (RFC-0012 P1). */
export const QUEST_PROTOCOL='0.21' satisfies Protocol;
/** The object catalog protocol (RFC-0011 P1): objects state, object and library methods, objects.control. */
export const OBJECTS_PROTOCOL='0.22' satisfies Protocol;
/** Characters, paths and interactions (RFC-0011 P2): the npcs state key, npcs/paths/interaction methods, graphics npc_motion. */
export const NPCS_PROTOCOL='0.23' satisfies Protocol;
/** Live machines (RFC-0013): catalog entries carry machine, the live state key. */
export const LIVE_PROTOCOL='0.24' satisfies Protocol;
/** Companions (RFC-0010 companions amendment, draft): companion methods, the companion key, catalog capability. */
export const COMPANION_PROTOCOL='0.25' satisfies Protocol;
/** The debug tool (tool 9 named on the wire), the companion's pace and the 128-item pocket list. */
export const DEBUG_TOOL_PROTOCOL='0.26' satisfies Protocol;
/** Workspace screens (object format 0.11): catalog and instance screen fields, objects.place/configure workspace. */
export const SCREENS_PROTOCOL='0.27' satisfies Protocol;
/** The shared clip library (draft): character styles, catalog motion, companion dances. */
export const MOTION_PROTOCOL='0.28' satisfies Protocol;
/**
 * The projections the mock serves: 0.1, 0.2 and the feature versions it models. A listener
 * started at version V negotiates every one of these up to V (compared with atLeast).
 */
export const MOCK_PROTOCOLS=['0.1','0.2',QUEST_PROTOCOL,OBJECTS_PROTOCOL,NPCS_PROTOCOL,LIVE_PROTOCOL,COMPANION_PROTOCOL,DEBUG_TOOL_PROTOCOL,SCREENS_PROTOCOL,MOTION_PROTOCOL] as const;
export type MockProtocol=typeof MOCK_PROTOCOLS[number];
/** Developer grants a listener at `protocol` can hand out. */
export function grantsFor(protocol:Protocol):Capability[] {
 return [...GRANTS,...(atLeast(protocol,QUEST_PROTOCOL)?['quest.control' as const]:[]),...(atLeast(protocol,OBJECTS_PROTOCOL)?['objects.control' as const]:[])];
}
/** IPC 0.22 adds objects.control (object placements and library installs). */
export const OBJECT_GRANTS:Capability[]=grantsFor(OBJECTS_PROTOCOL);
/** IPC 0.23 adds no grant: characters and paths use objects.control, interactions world.control. */
export const NPC_GRANTS:Capability[]=grantsFor(NPCS_PROTOCOL);
/** IPC 0.24 adds no grant: live reads with state.read. */
export const LIVE_GRANTS:Capability[]=grantsFor(LIVE_PROTOCOL);
/** IPC 0.25 adds no grant: the companion methods use objects.control. */
export const COMPANION_GRANTS:Capability[]=grantsFor(COMPANION_PROTOCOL);
/** IPC 0.26 adds no grant. */
export const DEBUG_TOOL_GRANTS:Capability[]=grantsFor(DEBUG_TOOL_PROTOCOL);
/** IPC 0.27 adds no grant. */
export const SCREENS_GRANTS:Capability[]=grantsFor(SCREENS_PROTOCOL);
/** IPC 0.28 adds no grant. */
export const MOTION_GRANTS:Capability[]=grantsFor(MOTION_PROTOCOL);
export const REQUIREMENTS:Record<string,Capability|undefined>={
 'session.hello':undefined,'session.ping':undefined,'state.subscribe':'state.read','state.snapshot':'state.read','state.unsubscribe':'state.read',
 'world.load':'world.control','surface.focus':'surface.control','movement.set':'movement.control','shell.claim':'shell.control','shell.release':'shell.control','shell.overlay':'shell.control','runtime.exit':'runtime.control',
 'camera.get':'state.read','camera.set':'movement.control','waypoint.set':'world.control','waypoint.clear':'world.control','route.set':'world.control','route.clear':'world.control',
 'travel.start':'movement.control','travel.cancel':'movement.control','autodrive.start':'movement.control','autodrive.stop':'movement.control',
 'ui.open':'shell.control','ui.close':'shell.control','data.publish':'data.publish','data.remove':'data.publish'
};
const LEGACY=new Set(Object.keys(REQUIREMENTS).slice(0,12));
type Vec3=[number,number,number];
type Bounds={min:Vec3;max:Vec3};
export interface Scenario {
 state:State; path:Vec3[];
 worlds:Array<{id:string;spawns:string[];zones?:State['location']['zones'];loadMs?:number;failLoad?:boolean}>;
 notices:Array<{atMs:number;level:'info'|'warning'|'error';code:string;message:string}>;
 transactions?:Array<{atMs:number;changes:Partial<State>}>;
 /** Trusted supervisor commands, not public protocol additions. */
 actions?:Array<{atMs:number;method:keyof MethodMap;params:unknown}>;
 input?:Array<{atMs:number;kind:'hold'|'escape';pressed?:boolean}>;
 obstacles?:Bounds[]; tickMs?:number;
}
const zones:State['location']['zones']=[{id:'work',name:'Work nook',bounds:{min:[-4,0,-6],max:[4,4,1]}},{id:'gallery',name:'Gallery',bounds:{min:[4,0,-6],max:[12,4,2]}}];
export const DEFAULT_SCENARIO:Scenario={
 state:{runtime:{active:true,outputs:['output-main']},world:{id:'com.hyprune.observatory',spawnId:'arrival'},surfaces:[
 {id:'surface-terminal',kind:'window',title:'Terminal · sdk',logicalSize:[1000,700],focused:true},
 {id:'surface-browser',kind:'window',title:'Hyprune documentation',logicalSize:[1280,900],focused:false},
 {id:'surface-music',kind:'window',title:'Music · ambient',logicalSize:[600,400],focused:false}],
 movement:{modeId:'com.hyprune.fly',position:[0,1.7,0],orientation:[0,0,0,1]},shell:{leases:[]},
 location:{zones,waypoint:{id:'desk',label:'Work desk',target:{position:[2,1.7,-4]},position:[2,1.7,-4]},route:[],autodrive:false,transition:null},integrations:{sources:[]}},
 path:[[0,1.7,0],[3,1.7,-2],[2,2,-5],[-3,1.7,-3],[0,1.7,0]],
 worlds:[{id:'com.hyprune.observatory',spawns:['arrival','desk'],zones},{id:'com.hyprune.garden',spawns:['arrival'],zones:[{id:'garden',name:'Garden',bounds:{min:[-6,0,-6],max:[6,4,6]}}],loadMs:250}],
 notices:[{atMs:500,level:'info',code:'mock.ready',message:'Observatory ready. Follow the path to the work nook.'},{atMs:5000,level:'warning',code:'mock.demo',message:'This is a synthetic development session.'}],tickMs:100
};
/** Slot 9, the debug tool, as core defines it (IPC 0.26 editor.toolDefinitions). */
export const DEBUG_TOOL_DEFINITION={slot:9 as const,name:'Debug',slots:{primary:{action:'debug.inspect',label:'Inspect'},
 secondary:{action:'debug.clear',label:'Close info card'},alternate:null,cycle:{action:'tool.cycle',label:'Debug layer'}}};
type Grant={token:string;clientId:string;capabilities:Capability[];expires:number};
type Peer={socket?:Socket;decoder:FrameDecoder;hello:boolean;protocol:Protocol;clientId:string;grants:Capability[];methods:string[];ids:Set<string>;subscription?:string;baseline:number;leases:Set<string>;timer?:NodeJS.Timeout;closing:boolean;outstanding:number};
type Hint={method:string;params:unknown};
export class MockDaemon {
 readonly sessionId=randomUUID(); revision=0;
 /** Wall-clock Unix ms at performance.now() 0, fixed so live publishedAt values are stable. */
 private readonly wallOffset=Date.now()-performance.now(); state:State; readonly scenario:Scenario;readonly protocol:Protocol;readonly path:string;
 /** Markers, personal quests and focus sessions, served to 0.21 peers. */
 /** Object catalog, user placements and libraries, served to 0.22 peers. */
 readonly objects:ObjectEngine;
 /** Characters, paths, interactions and graphics, served to 0.23 peers of a 0.23 listener. */
 readonly npcs?:NpcEngine;
 /** The companion, served to 0.25 peers of a 0.25 listener. */
 readonly companion?:CompanionEngine;
 readonly quests=new QuestEngine(()=>({zones:this.state.location.zones,loaded:!!this.state.world,
  waypoint:this.state.location.waypoint?{id:this.state.location.waypoint.id,label:this.state.location.waypoint.label,position:this.state.location.waypoint.position}:null}));
 private server?:Server;private peers=new Set<Peer>();private tokens:Grant[]=[];
 private tick?:NodeJS.Timeout;private flush?:NodeJS.Timeout;private scripted:NodeJS.Timeout[]=[];private timers=new Map<NodeJS.Timeout,()=>void>();private stopped=false;
 private started=0;private lastTick=0;private lastPose=0;private motion?:{from:Vec3;to:Vec3;start:number;duration:number};private driveIndex=0;private speed=3.5;
 private styles=new Map<string,object>();
 private objectTick?:Promise<void>;private load?:{peer:Peer;cancel:()=>void};private publications=new Map<string,{owner:Peer;time:number}>();private holding=false;private heldSince=0;private opened=false;
 private supervisor:Peer={decoder:new FrameDecoder(),hello:true,protocol:'0.2',clientId:'com.hyprune.mock',grants:GRANTS,methods:Object.keys(REQUIREMENTS),ids:new Set(),baseline:0,leases:new Set(),closing:false,outstanding:0};
 /** objectDir: list this user object folder in the 0.22 catalog instead of the fixture user objects. */
 constructor(options:{socket?:string;protocol?:Protocol;scenario?:Scenario;objectDir?:string}={}) {
  this.path=options.socket || socketPath();if(!isAbsolute(this.path)) throw new Error('Mock socket must be an absolute path in a private directory');this.protocol=options.protocol || '0.2';
  if(!(MOCK_PROTOCOLS as readonly string[]).includes(this.protocol)) throw new Error('Unsupported protocol');
  this.scenario=structuredClone(options.scenario || DEFAULT_SCENARIO);this.state=structuredClone(this.scenario.state);
  this.objects=new ObjectEngine(()=>({id:this.state.world?.id ?? null,active:this.state.runtime.active,zones:this.state.location.zones,obstacles:this.scenario.obstacles || [],
   position:this.state.movement.position,orientation:this.state.movement.orientation}),{objectDir:options.objectDir,characters:atLeast(this.protocol,NPCS_PROTOCOL),screens:atLeast(this.protocol,SCREENS_PROTOCOL)});
  if(atLeast(this.protocol,NPCS_PROTOCOL))this.npcs=new NpcEngine(this.objects,()=>({id:this.state.world?.id ?? null,active:this.state.runtime.active,zones:this.state.location.zones,
   obstacles:this.scenario.obstacles || [],position:this.state.movement.position,orientation:this.state.movement.orientation}));
  if(this.npcs && atLeast(this.protocol,COMPANION_PROTOCOL))this.companion=new CompanionEngine(this.objects,this.npcs,()=>({id:this.state.world?.id ?? null,
   position:this.state.movement.position,orientation:this.state.movement.orientation}));
  validateState(this.snapshot());if(atLeast(this.protocol,QUEST_PROTOCOL))validateState(this.project(this.snapshot(),this.protocol),this.protocol);
  if(!Array.isArray(this.scenario.path) || this.scenario.path.some(p=>p.length!==3 || p.some(n=>!Number.isFinite(n)))) throw new Error('Scenario path requires finite vec3 points');
  if(this.scenario.tickMs!==undefined && (!Number.isFinite(this.scenario.tickMs) || this.scenario.tickMs<34)) throw new Error('tickMs must be >=34');
  for(const world of this.scenario.worlds) {
   if(!world.spawns.length || new Set(world.spawns).size!==world.spawns.length) throw new Error('Scenario world requires unique spawns');
   for(const spawnId of world.spawns) validateState({...this.snapshot(),state:{...this.state,world:{id:world.id,spawnId},location:{...this.state.location,zones:world.zones || []}}});
   if(world.loadMs!==undefined && (!Number.isFinite(world.loadMs) || world.loadMs<0 || world.loadMs>10_000)) throw new Error('loadMs must be 0..10000');
  }
  for(const z of [...this.state.location.zones,...(this.scenario.obstacles || [])].map(z=>'bounds' in z?z.bounds:z)) if(z.min.some((n,i)=>n>=z.max[i])) throw new Error('Scenario bounds must be ordered');
  for(const t of this.scenario.transactions || []) validateState({...this.snapshot(),state:{...this.state,...t.changes}});
  for(const n of this.scenario.notices) {const {atMs,...params}=n;validateWire({jsonrpc:'2.0',method:'runtime.notice',params});}
  for(const a of this.scenario.actions || []) validateWire({jsonrpc:'2.0',id:'scenario',method:a.method,params:a.params});
  for(const input of this.scenario.input || []) if(!['hold','escape'].includes(input.kind) || (input.kind==='hold' && typeof input.pressed!=='boolean')) throw new Error('Invalid scenario input');
  for(const entry of [...this.scenario.notices,...(this.scenario.transactions || []),...(this.scenario.actions || []),...(this.scenario.input || [])]) if(!Number.isFinite(entry.atMs) || entry.atMs<0) throw new Error('Invalid scenario time');
 }
 snapshot():Snapshot {return {sessionId:this.sessionId,revision:this.revision,state:structuredClone(this.state)};}
 private view(p:Peer):Snapshot<Protocol> {const snapshot=this.snapshot();if(p.protocol==='0.1') {const {location,integrations,...state}=snapshot.state;return {...snapshot,state};}return this.project(snapshot,p.protocol);}
 /** The snapshot as a peer at `protocol` (0.2 or newer) sees it: no key of a newer version ever reaches an older peer. */
 project(snapshot:Snapshot,protocol:Protocol):Snapshot<Protocol> {
  if(!atLeast(protocol,QUEST_PROTOCOL))return snapshot;
  if(atLeast(protocol,MOTION_PROTOCOL))return this.motionView(snapshot);
  if(atLeast(protocol,SCREENS_PROTOCOL))return this.screensView(snapshot);
  if(atLeast(protocol,DEBUG_TOOL_PROTOCOL))return this.debugToolView(snapshot);
  if(atLeast(protocol,COMPANION_PROTOCOL))return this.companionView(snapshot);
  if(atLeast(protocol,LIVE_PROTOCOL))return this.liveView(snapshot);
  if(atLeast(protocol,NPCS_PROTOCOL))return this.npcsView(snapshot);
  return atLeast(protocol,OBJECTS_PROTOCOL)?this.objectsView(snapshot):this.questView(snapshot);
 }
 /**
  * The 0.28 projection: the 0.27 one plus each instance's style (a user character's, else null), the
  * companion's style and dance (activity dancing while it lasts) and the aimed interactions' options
  * (null: the mock's world characters have no dance).
  */
 motionView(snapshot:Snapshot):Snapshot<typeof MOTION_PROTOCOL> {
  const base=this.screensView(snapshot),s=base.state as any;
  const instances=s.objects.instances.map((i:any)=>({...i,style:i.character && i.source==='user'?this.styles.get(i.id) ?? null:null}));
  const aimed=s.npcs.aimed?{...s.npcs.aimed,interactions:s.npcs.aimed.interactions.map((i:any)=>({...i,options:null}))}:null;
  return {...base,state:{...s,objects:{...s.objects,instances},companion:companion28(s.companion,this.companion!),npcs:{...s.npcs,aimed}}} as Snapshot<typeof MOTION_PROTOCOL>;
 }
 /**
  * The 0.27 projection: the 0.26 one plus each instance's screen and, for every bound screen of the
  * loaded world, a home in mounts (area screen-<id>, its anchor and the binding, after the world's own).
  * builder is null: the mock loads no world folder (RFC-0014 editor mode is core's).
  */
 screensView(snapshot:Snapshot):Snapshot<typeof SCREENS_PROTOCOL> {
  const base=this.debugToolView(snapshot),s=base.state,worldId=s.world?.id ?? null;
  const instances=s.objects.instances.map(i=>({...i,screen:worldId && i.source==='user'?this.objects.instanceScreen(worldId,i.id):null}));
  const homes=this.objects.screenHomes(worldId),mounts=s.mounts;
  const taken=new Set(mounts.bindings.map(b=>b.id)),bound=homes.filter(h=>!taken.has(h.workspace));
  return {...base,state:{...s,builder:null,objects:{...s.objects,instances},mounts:{...mounts,
   areas:[...mounts.areas,...bound.map(h=>({id:h.area,workspaceSlot:String(h.workspace).padStart(2,'0'),primaryAnchor:h.area,toolAnchors:[],dataAnchors:[],theme:h.name,spawnId:h.area}))],
   anchors:[...mounts.anchors,...bound.map(h=>({id:h.area,pose:h.pose,size:h.size,mount:{type:h.mountType,role:'mounted-workspace',interaction:'focus-in'},areaId:h.area}))],
   bindings:[...mounts.bindings,...bound.map(h=>({id:h.workspace,worldId:worldId!,areaId:h.area}))]}}} as Snapshot<typeof SCREENS_PROTOCOL>;
 }
 /**
  * The 0.26 projection: the 0.25 one plus the companion's pace, the slot-9 tool definition, the
  * world action tool9 (unbound in the mock) and editor.debugTool (null: the mock never takes
  * out the debug tool).
  */
 debugToolView(snapshot:Snapshot):Snapshot<typeof DEBUG_TOOL_PROTOCOL> {
  const base=this.companionView(snapshot),s=base.state,keymap=s.keymap;
  const world={...keymap.config.modes.world,tool9:['9']};
  return {...base,state:{...s,companion:{...s.companion,pace:this.companion!.pace},
   keymap:{...keymap,config:{...keymap.config,modes:{...keymap.config.modes,world}}},
   editor:{...s.editor,debugTool:null,toolDefinitions:[...s.editor.toolDefinitions,DEBUG_TOOL_DEFINITION]}}} as Snapshot<typeof DEBUG_TOOL_PROTOCOL>;
 }
 /** The 0.25 projection: the 0.24 one plus the companion key, the companion in paths' bound lists and the aimed companion. */
 companionView(snapshot:Snapshot):Snapshot<typeof COMPANION_PROTOCOL> {
  const base=this.liveView(snapshot);
  return {...base,state:{...base.state,companion:this.companion!.state()}} as Snapshot<typeof COMPANION_PROTOCOL>;
 }
 /** The 0.24 projection: the 0.23 one plus the live key from the placed machines and published sources. */
 liveView(snapshot:Snapshot):Snapshot<typeof LIVE_PROTOCOL> {
  const base=this.npcsView(snapshot);
  const live=liveState(this.objects.machinePlacements(),snapshot.state.integrations.sources,this.wallOffset);
  return {...base,state:{...base.state,live}} as Snapshot<typeof LIVE_PROTOCOL>;
 }
 /** The 0.23 projection: the 0.22 one with the 0.23 instance and editor path fields, the npcs key and reticle interact. */
 npcsView(snapshot:Snapshot):Snapshot<typeof NPCS_PROTOCOL> {
  const base=this.objectsView(snapshot) as unknown as Snapshot<typeof NPCS_PROTOCOL>,npcs=this.npcs!;
  const state=base.state,aimed=npcs.aimed();
  return {...base,state:{...state,objects:this.objects.state(),editor:{...state.editor,paths:npcs.editorPaths()},
   interaction:{...state.interaction,reticle:aimed?{state:'valid',action:'interact'}:state.interaction.reticle},npcs:npcs.state23()}} as Snapshot<typeof NPCS_PROTOCOL>;
 }
 /** The 0.22 projection: the 0.21 one plus the objects key, editor.gizmo and the object pocket items in editor.unplaced. */
 objectsView(snapshot:Snapshot):Snapshot<typeof OBJECTS_PROTOCOL> {
  const base=this.questView(snapshot),objects=this.objects.state(),editor=base.state.editor;
  // 0.22 instances: no character or accent; path, activity and seat are always null.
  const instances=objects.instances.map(({character,accent,...i})=>({...i,path:null,activity:null,seat:null}));
  return {...base,state:{...base.state,objects:{...objects,instances},editor:{...editor,gizmo:{space:'world',pivot:'centre',snap:false},
   unplaced:{...editor.unplaced,count:editor.unplaced.windows.length+objects.pocket.length,objects:structuredClone(objects.pocket)}}}} as Snapshot<typeof OBJECTS_PROTOCOL>;
 }
 /** The 0.21 projection: 0.2 keys, neutral values for keys the mock does not model, and the quest keys. */
 questView(snapshot:Snapshot):Snapshot<typeof QUEST_PROTOCOL> {
  const state=snapshot.state,base=structuredClone(BASELINE_021);
  if(this.npcs){
   // A 0.23 listener: user paths (pre-0.23 shape), tool 3 while a route is drawn, a valid click reticle on an aimed character.
   base.editor.paths=this.npcs.editorPaths().map(({use,name,speed,stops,...p})=>p);
   if(this.npcs.drawingPath){base.editor.tool=3;base.interaction.tool=3;}
   if(this.npcs.aimed())base.interaction.reticle={state:'valid',action:'click'};
  }
  return {...snapshot,state:{...state,movement:{...state.movement,state:'flying',ladderId:null,prompt:''},...base,...this.quests.state()}} as Snapshot<typeof QUEST_PROTOCOL>;
 }
 issueToken(clientId:string,capabilities:Capability[],ttlMs=60_000):string {
  const protocol=atLeast(this.protocol,QUEST_PROTOCOL)?this.protocol:'0.2';validateWire({jsonrpc:'2.0',id:'grant',method:'session.hello',params:{protocols:[protocol],client:{id:clientId,name:'supervised'},capabilities}},protocol);
  const token=randomBytes(32).toString('hex');this.tokens=this.tokens.filter(t=>t.expires>Date.now());this.tokens.push({token,clientId,capabilities:[...capabilities],expires:Date.now()+ttlMs});return token;
 }
 async start():Promise<void> {
  secureDirectory(dirname(this.path));
  try {
   const st=lstatSync(this.path);if(!st.isSocket() || st.isSymbolicLink() || st.uid!==process.getuid?.()) throw new Error('Refusing to replace unsafe socket');
   const alive=await new Promise<boolean>((resolve,reject)=>{const s=createConnection(this.path);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',(e:any)=>{s.destroy();if(e.code==='ECONNREFUSED') resolve(false);else reject(e);});});
   if(alive) throw new Error('Socket already has a live listener');unlinkSync(this.path);
  }catch(e:any){if(e.code!=='ENOENT') throw e;}
  this.server=createServer(s=>this.accept(s));await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.path,resolve);});chmodSync(this.path,0o600);
  this.started=this.lastTick=Date.now();this.flush=setInterval(()=>this.flushDeltas(),34);this.tick=setInterval(()=>this.advance(),this.scenario.tickMs || 100);
  const schedule=(atMs:number,fn:()=>void)=>this.scripted.push(setTimeout(fn,atMs));
  for(const n of this.scenario.notices) schedule(n.atMs,()=>{const {atMs,...params}=n;this.broadcast('runtime.notice',params);});
  for(const t of this.scenario.transactions || []) schedule(t.atMs,()=>this.commit(t.changes));
  for(const a of this.scenario.actions || []) schedule(a.atMs,()=>{this.runAction(a.method,a.params).catch(e=>this.broadcast('runtime.notice',{level:'warning',code:'scenario.rejected',message:e.message}));});
  for(const i of this.scenario.input || []) schedule(i.atMs,()=>i.kind==='hold'?this.hold(i.pressed!):this.escape());
 }
 async stop():Promise<void> {
  this.stopped=true;this.load?.cancel();clearInterval(this.tick);clearInterval(this.flush);for(const t of this.scripted) clearTimeout(t);
  for(const [timer,cancel] of this.timers) {clearTimeout(timer);cancel();}this.timers.clear();
  for(const p of this.peers) p.socket?.destroy();if(this.server) await new Promise<void>((resolve,reject)=>this.server!.close(e=>e?reject(e):resolve()));
 }
 disconnectClients():void {for(const p of this.peers) p.socket?.destroy();}
 revokeClients(reason='Mock approval revoked'):void {for(const p of this.peers) {if(p.hello) this.send(p,{jsonrpc:'2.0',method:'session.revoked',params:{reason}});p.closing=true;p.socket?.end();}}
 /** Native input simulation for scenarios; never an IPC method or shell timer. */
 hold(pressed:boolean):void {if(!pressed){this.holding=false;this.opened=false;}else if(!this.holding && this.state.runtime.active){this.holding=true;this.heldSince=Date.now();}}
 escape():void {this.load?.cancel();const hints=this.stopMotion();this.commit({location:{...this.state.location,autodrive:false},shell:this.hideUI(hints)},hints);}
 async runAction(method:keyof MethodMap,params:unknown):Promise<unknown> {validateWire({jsonrpc:'2.0',id:'scenario',method,params});return this.execute(this.supervisor,method,params);}
 private accept(socket:Socket):void {
  // Trusted local tooling: Node does not expose portable SO_PEERCRED.
  const p:Peer={socket,decoder:new FrameDecoder(),hello:false,protocol:this.protocol,clientId:'',grants:[],methods:[],ids:new Set(),baseline:0,leases:new Set(),timer:setTimeout(()=>socket.destroy(),5000),closing:false,outstanding:0};this.peers.add(p);
  const deadline=setInterval(()=>{try{p.decoder.checkDeadline();}catch{socket.destroy();}},1000);socket.on('error',()=>{});
  socket.on('data',chunk=>{if(p.closing)return;try{p.decoder.feed(chunk,m=>{if(!p.closing) void this.handle(p,m);});}catch(e){p.closing=true;if(e instanceof FrameError && e.parseError){this.error(p,null,-32700,'Parse error');socket.end();}else socket.destroy();}});
  socket.on('close',()=>{clearTimeout(p.timer);clearInterval(deadline);p.closing=true;this.peers.delete(p);if(this.load?.peer===p)this.load.cancel();this.cleanup(p);});
 }
 private send(p:Peer,message:unknown,method?:string):void {
  if(!p.socket || p.socket.destroyed) return;validateWire(message,p.protocol,method);const frame=encodeFrame(message);
  if(p.socket.writableLength+frame.length>4*1024*1024){p.socket.destroy();return;}p.socket.write(frame);
 }
 private error(p:Peer,id:string|null,code:number,message:string,data?:{retryable:boolean;rule?:string}):void {
  // Error data carries a placement rule from 0.22 on; older peers get retryable only.
  const shown=data && !atLeast(p.protocol,OBJECTS_PROTOCOL)?{retryable:data.retryable}:data;
  this.send(p,{jsonrpc:'2.0',id,error:{code,message,...(shown?{data:shown}:{})}});
 }
 private async handle(p:Peer,message:unknown):Promise<void> {
  const m:any=message;const id:string|null=m && typeof m.id==='string' && m.id.length>0 && m.id.length<=128?m.id:null;
  try {
   if(!m || Array.isArray(m) || typeof m!=='object' || m.jsonrpc!=='2.0' || id===null || typeof m.method!=='string' || !Object.hasOwn(m,'params') || Object.keys(m).some(k=>!['jsonrpc','id','method','params'].includes(k))) throw new RpcError(-32600,'Invalid request profile');
   if(p.ids.has(id)) throw new RpcError(-32600,'Request ID reused');if(p.ids.size>=100_000) throw new RpcError(-32008,'Connection request limit; reconnect');p.ids.add(id);
   if(!p.hello && m.method!=='session.hello') throw new RpcError(-32600,'First request must be session.hello');
   if(p.hello && m.method==='session.hello') throw new RpcError(-32600,'Hello already complete');
   if(p.hello && !p.methods.includes(m.method)) throw new RpcError(-32601,'Method not advertised');
   try{validateWire(m,p.protocol);}catch{throw new RpcError(-32602,'Invalid params');}
   if(m.method==='session.hello') {
    const supported=MOCK_PROTOCOLS.filter(v=>this.protocol==='0.1'?v==='0.1':atLeast(this.protocol,v)).reverse() as string[];const selected=supported.find(version=>m.params.protocols.includes(version));
    if(!selected){this.error(p,id,-32001,'Incompatible protocol');p.closing=true;p.socket!.end();return;}p.protocol=selected as Protocol;
    try{validateWire(m,p.protocol);}catch{throw new RpcError(-32602,'Invalid capabilities for protocol');}
    if(m.params.token){const index=this.tokens.findIndex(t=>t.clientId===m.params.client.id && t.expires>Date.now() && timingSafeEqual(Buffer.from(t.token),Buffer.from(m.params.token)));if(index<0)throw new RpcError(-32002,'Invalid launch token');const [grant]=this.tokens.splice(index,1);p.grants=m.params.capabilities.filter((c:Capability)=>grant.capabilities.includes(c));}
    p.clientId=m.params.client.id;p.methods=Object.keys(REQUIREMENTS).filter(k=>(!REQUIREMENTS[k] || p.grants.includes(REQUIREMENTS[k]!)) && (p.protocol!=='0.1' || LEGACY.has(k)));
    if(atLeast(p.protocol,QUEST_PROTOCOL))p.methods.push(...Object.entries(QUEST_REQUIREMENTS).filter(([,grant])=>p.grants.includes(grant)).map(([k])=>k));
    if(atLeast(p.protocol,OBJECTS_PROTOCOL))p.methods.push(...Object.entries(OBJECT_REQUIREMENTS).filter(([,grant])=>p.grants.includes(grant)).map(([k])=>k));
    if(this.npcs && atLeast(p.protocol,NPCS_PROTOCOL))p.methods.push(...Object.entries(NPC_REQUIREMENTS).filter(([,grant])=>p.grants.includes(grant)).map(([k])=>k));
    if(this.companion && atLeast(p.protocol,COMPANION_PROTOCOL))p.methods.push(...Object.entries(COMPANION_REQUIREMENTS).filter(([,grant])=>p.grants.includes(grant)).map(([k])=>k));p.hello=true;clearTimeout(p.timer);
    this.send(p,{jsonrpc:'2.0',id,result:{protocol:p.protocol,sessionId:this.sessionId,capabilities:p.grants,methods:p.methods,events:p.grants.includes('state.read')?['state.delta','runtime.notice','session.revoked',...(p.protocol!=='0.1'?['location.transition','ui.opened','ui.closed','data.updated']:[]),...(atLeast(p.protocol,QUEST_PROTOCOL)?QUEST_EVENTS:[])]:['session.revoked']}},'session.hello');return;
   }
   if(p.outstanding>=64)throw new RpcError(-32008,'64 outstanding calls exceeded');p.outstanding++;
   try{const operation=this.execute(p,m.method,m.params);const result=operation instanceof Promise?await operation:operation;this.send(p,{jsonrpc:'2.0',id,result},m.method);}finally{p.outstanding--;}
  }catch(e){const error=e instanceof RpcError?e:new RpcError(-32603,'Internal error');this.error(p,id,error.code,error.message,error.data);if(!p.hello || id===null || error.code===-32008 && p.outstanding>=64){p.closing=true;p.socket!.end();}}
 }
 private subscription(p:Peer,id:string):void {if(!p.subscription || p.subscription!==id)throw new RpcError(-32003,'Unknown subscription');}
 private lease(p:Peer,id:string){const lease=this.state.shell.leases.find(l=>l.id===id);if(!lease || !p.leases.has(id))throw new RpcError(-32004,'Stale or foreign lease');return lease;}
 private target(target:Ipc02_Target):Vec3 {
  if(!this.state.world)throw new RpcError(-32005,'No world loaded');if('position' in target)return structuredClone(target.position);
  const zone=this.state.location.zones.find(z=>z.id===target.zoneId);if(!zone)throw new RpcError(-32003,'Unknown zone');const {min,max}=zone.bounds;return [(min[0]+max[0])/2,min[1]+1.7,(min[2]+max[2])/2];
 }
 private blocked(point:Vec3):boolean {return (this.scenario.obstacles || []).some(b=>point[0]>b.min[0]-.3 && point[0]<b.max[0]+.3 && point[2]>b.min[2]-.3 && point[2]<b.max[2]+.3 && point[1]>b.min[1]-.1 && point[1]<b.max[1]+1.7);}
 private hideUI(hints:Hint[]):State['shell'] {
  return {leases:this.state.shell.leases.map(l=>({...l,overlays:l.overlays.map(o=>{if(o.visible)hints.push({method:'ui.closed',params:{leaseId:l.id,outputId:o.outputId}});return {...o,visible:false,exclusiveInput:false};})}))};
 }
 private transition(phase:Ipc02_Transition['phase'],progress:number|null):Hint[] {
  const transition=this.state.location.transition;if(!transition)return [];
  const next={...transition,phase,progress,monotonicMs:Math.floor(performance.now())};this.state.location={...this.state.location,transition:next};return [{method:'location.transition',params:next}];
 }
 private stopMotion():Hint[] {
  this.holding=false;this.opened=false;const hints=this.motion?this.transition('cancelled',Math.min(1,(Date.now()-this.motion.start)/this.motion.duration)):[];this.motion=undefined;return hints;
 }
 private execute(p:Peer,method:string,params:any):any {
  switch(method) {
   case 'session.ping':return {monotonicMs:Math.floor(performance.now())};
   case 'state.subscribe':if(p.subscription)throw new RpcError(-32004,'Already subscribed');p.subscription=randomUUID();p.baseline=this.revision;return {subscriptionId:p.subscription,snapshot:this.view(p)};
   case 'state.snapshot':this.subscription(p,params.subscriptionId);p.baseline=this.revision;return {snapshot:this.view(p)};
   case 'state.unsubscribe':this.subscription(p,params.subscriptionId);p.subscription=undefined;return {ok:true};
   case 'world.load':return this.loadWorld(p,params);
   case 'camera.get':return {position:structuredClone(this.state.movement.position),orientation:structuredClone(this.state.movement.orientation)};
   case 'camera.set': {
    if(!this.state.world)throw new RpcError(-32005,'No world loaded');
    const [x,y,z,w]=params.orientation;const fx=-2*(x*z+w*y),fy=-2*(y*z-w*x),fz=-(1-2*(x*x+y*y));const yaw=Math.atan2(fx,-fz),pitch=Math.asin(Math.max(-1,Math.min(1,fy)));const cy=Math.cos(-yaw/2),sy=Math.sin(-yaw/2),cp=Math.cos(pitch/2),sp=Math.sin(pitch/2);
    if(Math.abs(x*cy*sp+y*sy*cp-z*sy*sp+w*cy*cp)<=.9999 || Math.abs(pitch)>=1.49)throw new RpcError(-32007,'Camera roll or vertical pitch unsupported');
    const hints=this.stopMotion();this.lastPose=Infinity;this.commit({movement:{...this.state.movement,position:params.position,orientation:params.orientation},location:{...this.state.location,autodrive:false}},hints);break;
   }
   case 'waypoint.set':{const target=params.target || {position:params.position};const position=this.target(target);this.commit({location:{...this.state.location,waypoint:{id:params.id,label:params.label,target,position}}});break;}
   case 'waypoint.clear':this.commit({location:{...this.state.location,waypoint:null}});break;
   case 'route.set':{const route=params.points.map((target:Ipc02_Target)=>({target,position:this.target(target)}));this.driveIndex=0;this.commit({location:{...this.state.location,route,autodrive:false}});break;}
   case 'route.clear':this.commit({location:{...this.state.location,route:[],autodrive:false}});break;
   case 'travel.start': {
    if(!this.state.runtime.active)throw new RpcError(-32005,'World mode inactive');if(this.load || this.motion || this.state.location.autodrive)throw new RpcError(-32004,'Automatic operation already active');
    const to=this.target(params.to);if(this.blocked(to))throw new RpcError(-32004,'Destination obstructed');const duration=params.durationMs ?? 600;
    const hints=this.stopMotion(),shell=this.hideUI(hints),transition:Ipc02_Transition={id:randomUUID(),outputId:this.state.runtime.outputs[0] || null,phase:'departing',progress:0,to:params.to,monotonicMs:Math.floor(performance.now())};
    this.lastPose=Infinity;this.motion=duration?{from:[...this.state.movement.position],to,start:Date.now(),duration}:undefined;
    hints.push({method:'location.transition',params:transition});this.commit({shell,location:{...this.state.location,autodrive:false,transition}},hints);
    if(!duration){const events=this.transition('arrived',1);this.commit({movement:{...this.state.movement,position:to},location:this.state.location},events);}break;
   }
   case 'travel.cancel':{const hints=this.stopMotion();this.commit({location:this.state.location},hints);break;}
   case 'autodrive.start':{
    if(!this.state.runtime.active || !this.state.world || !this.state.location.route.length)throw new RpcError(-32005,'Active world and route required');if(this.load || this.motion || this.state.location.autodrive)throw new RpcError(-32004,'Automatic operation already active');
    this.speed=params.speed ?? 3.5;this.driveIndex=0;this.lastPose=Infinity;const hints=this.stopMotion();this.commit({shell:this.hideUI(hints),location:{...this.state.location,autodrive:true}},hints);break;
   }
   case 'autodrive.stop':this.commit({location:{...this.state.location,autodrive:false}});break;
   case 'surface.focus':if(!this.state.surfaces.some(s=>s.id===params.surfaceId))throw new RpcError(-32003,'Unknown surface');if(params.intent==='keyboard')this.commit({surfaces:this.state.surfaces.map(s=>({...s,focused:s.id===params.surfaceId}))});break;
   case 'movement.set':if(params.modeId!=='com.hyprune.fly')throw new RpcError(-32007,'Mock implements free flight only');this.commit({movement:{...this.state.movement,modeId:params.modeId}});break;
   case 'shell.claim':{
    if(params.outputs.some((o:string)=>!this.state.runtime.outputs.includes(o)))throw new RpcError(-32003,'Unknown output');if(this.state.shell.leases.some(l=>l.outputs.some(o=>params.outputs.includes(o))))throw new RpcError(-32004,'Output already claimed');
    const leaseId=randomUUID();p.leases.add(leaseId);this.commit({shell:{leases:[...this.state.shell.leases,{id:leaseId,outputs:params.outputs,overlays:params.outputs.map((outputId:string)=>({outputId,visible:false,exclusiveInput:false}))}]}});return {leaseId,revision:this.revision};
   }
   case 'shell.release':this.lease(p,params.leaseId);p.leases.delete(params.leaseId);this.commit({shell:{leases:this.state.shell.leases.filter(l=>l.id!==params.leaseId)}});break;
   case 'shell.overlay':case 'ui.open':case 'ui.close':{
    const lease=this.lease(p,params.leaseId);if(!lease.outputs.includes(params.outputId))throw new RpcError(-32003,'Output outside lease');if(params.exclusiveInput)throw new RpcError(-32007,'Exclusive input requires trusted Wayland association');
    const visible=method==='ui.open' || method==='shell.overlay' && params.visible;const hints=method==='shell.overlay'?[]:[{method:method==='ui.open'?'ui.opened':'ui.closed',params}];
    this.commit({shell:{leases:this.state.shell.leases.map(l=>l.id===lease.id?{...l,overlays:l.overlays.map(o=>o.outputId===params.outputId?{...o,visible,exclusiveInput:false}:o)}:l)}},hints);break;
   }
   case 'data.publish':case 'data.remove':this.publish(p,method,params);break;
   case 'runtime.exit':{this.load?.cancel();const hints=this.stopMotion();this.hideUI(hints);this.commit({runtime:{...this.state.runtime,active:false},shell:{leases:[]},location:{...this.state.location,autodrive:false}},hints);for(const peer of [...this.peers,this.supervisor])peer.leases.clear();break;}
   default:{
    if(this.companion && method in COMPANION_REQUIREMENTS){const call=this.companion.execute(method,params);if(call.changed)this.extendedCommit([]);this.notify(call.notices);return {revision:this.revision};}
    if(method in OBJECT_REQUIREMENTS)return this.objectCall(method,params,p.protocol);
    if(this.npcs && method in NPC_REQUIREMENTS)return this.npcCall(method,params,p.protocol);
    if(!(method in QUEST_REQUIREMENTS))throw new RpcError(-32601,'Unimplemented');
    const {result,hints,changed}=this.quests.execute(method,params);
    if(changed)this.extendedCommit(hints);
    if(result===undefined)break;
    return method==='quests.create' || method==='focus.start'?{revision:this.revision,...result as object}:result;
   }
  }
  return {revision:this.revision};
 }
 /** 0.22 object and library methods: results carry the state revision (the catalog revision for objects.catalog). */
 private async objectCall(method:string,params:unknown,protocol:Protocol):Promise<Record<string,unknown>> {
  const call=await this.objects.execute(method,params);
  // Catalog entries carry machine from 0.24 on (null for non-machines).
  if(method==='objects.catalog' && call.result){
   const entries=call.result.entries as Parameters<typeof catalogEntry24>[0][];
   // Catalog entries carry companion from 0.25 on (null for non-characters).
   call.result={...call.result,entries:atLeast(protocol,COMPANION_PROTOCOL)?entries.map(e=>({...catalogEntry24(e),companion:companionOf(e),
    // Catalog entries carry screen from 0.27 on (null for objects that are no workspace screen).
    ...(atLeast(protocol,SCREENS_PROTOCOL)?{screen:catalogScreen27(e),...catalogImport27(e)}:{}),
    // Catalog entries carry motion from 0.28 on (null for objects that are no character).
    ...(atLeast(protocol,MOTION_PROTOCOL)?{motion:(e as {traits:string[]}).traits.includes('character')?structuredClone(MOCK_MOTION):null}:{})})):entries.map(atLeast(protocol,LIVE_PROTOCOL)?catalogEntry24:catalogEntry22)};
  }
  if(call.changed)this.extendedCommit([]);
  this.notify(call.notices);
  return {...(call.revision==='none'?{}:{revision:call.revision==='catalog'?this.objects.catalogRevision:this.revision}),...call.result};
 }
 /** Object and character notices reach peers from their version on (0.22, or `since`). */
 private notify(notices:Notice[]):void {
  for(const {since,...notice} of notices)for(const p of this.peers)if(p.hello && p.grants.includes('state.read') && atLeast(p.protocol,(since || OBJECTS_PROTOCOL) as Protocol))this.send(p,{jsonrpc:'2.0',method:'runtime.notice',params:notice});
 }
 /** 0.23 character, path, interaction and graphics methods; an interaction's waypoint lands in location. */
 private npcCall(method:string,params:any,protocol:Protocol='0.23'):Record<string,unknown> {
  // 0.25: the reserved id companion in npcs.bind, paths.draw {bind}, paths.finish and interaction.choose.
  const companion=this.companion && atLeast(protocol,COMPANION_PROTOCOL)?this.companion:undefined;
  if(companion && (method==='npcs.bind' && params?.id===COMPANION_ID || method==='interaction.choose' && params?.objectId===COMPANION_ID)){
   const call=method==='npcs.bind'?companion.bind(params):companion.choose(params.interactionId,params.option);
   // 0.28: the state shows the dance until it ends.
   if(method==='interaction.choose' && params.interactionId==='dance'){const timer=setTimeout(()=>{this.timers.delete(timer);this.extendedCommit([]);},MOCK_DANCE_MS+20);this.timers.set(timer,()=>{});}
   if(call.changed)this.extendedCommit([]);this.notify(call.notices);return {revision:this.revision};
  }
  if(companion && method==='paths.draw' && params?.bind===COMPANION_ID){companion.draw();const {bind,...rest}=params;params=rest;}
  // 0.28: a user character's style (the mock keeps it beside the placement; null clears it).
  const style=(method==='npcs.spawn' || method==='npcs.bind') && params?.style!==undefined?params.style:undefined;
  if(style!==undefined){const {style:_,...rest}=params;params=rest;}
  if(method==='interaction.choose' && params?.option!==undefined) throw new RpcError(-32602,'only a dance takes an option');
  let call:NpcCall;
  try{call=this.npcs!.execute(method,params);}finally{this.notify(this.npcs!.outbox.splice(0));}
  if(companion && method==='paths.finish'){const done=companion.finished((call.result as {id?:string|null})?.id ?? null);if(done.bound)call.result={...call.result,bound:done.bound};call.notices.push(...done.notices);call.changed=true;}
  if(companion && method==='paths.list' && call.result)call.result={...call.result,paths:(call.result.paths as Array<{ref:string;bound:string[]}>).map(p=>companion.boundTo(p.ref) && p.bound.length<8?{...p,bound:[...p.bound,COMPANION_ID]}:p)};
  if(style!==undefined){const id=method==='npcs.spawn'?(call.result as {id?:string})?.id:params.id;if(id){if(style)this.styles.set(id,style);else this.styles.delete(id);call.changed=true;}}
  this.applyNpc(call);
  return {...(call.revision==='none'?{}:{revision:this.revision}),...call.result};
 }
 private applyNpc(call:NpcCall):void {
  if(call.waypoint){const {id,label,target}=call.waypoint;this.commit({location:{...this.state.location,waypoint:{id,label,target,position:this.target(target)}}});}
  if(call.changed)this.extendedCommit([]);
  this.notify(call.notices);
 }
 /** E on the aimed character (native input simulation, 0.23 listeners): advance, run or offer the choice list. */
 use():void {if(this.npcs)this.applyNpc(this.npcs.use());}
 /** A tool-3 click while paths.draw is active (native input simulation): append a point. */
 drawPoint(position:Vec3,type:'line'|'curve'|'arc'='line'):void {if(this.npcs?.drawPoint(position,type))this.extendedCommit([]);}
 /** Simulate the offload power profile that npc_motion auto follows (full-ac, limited-ac, battery, usb-c, unknown). */
 setPowerProfile(profile:PowerProfile):void {if(this.npcs && this.npcs.profile!==profile){this.npcs.profile=profile;this.extendedCommit([]);}}
 private publish(p:Peer,method:string,params:any):void {
  const id=params.sourceId;if(id!==p.clientId && !id.startsWith(p.clientId+'.'))throw new RpcError(-32002,'Source outside authenticated namespace');
  const prior=this.publications.get(id);if(prior && prior.owner!==p)throw new RpcError(-32004,'Source belongs to another connection');
  const sources=this.state.integrations.sources,old=sources.find(s=>s.sourceId===id);
  if(method==='data.remove'){this.publications.delete(id);this.commit({integrations:{sources:sources.filter(s=>s.sourceId!==id)}});return;}
  if(prior && Date.now()-prior.time<100)throw new RpcError(-32008,'Publication rate exceeds 10 Hz');if(old && params.sequence<=old.sequence)throw new RpcError(-32004,'Stale source sequence');
  if(!old && sources.length>=32)throw new RpcError(-32008,'Source limit');const size=Buffer.byteLength(JSON.stringify(params.values));
  if(size>16384)throw new RpcError(-32602,'Value map exceeds 16 KiB');if(size+sources.filter(s=>s.sourceId!==id).reduce((n,s)=>n+Buffer.byteLength(JSON.stringify(s.values)),0)>65536)throw new RpcError(-32008,'Aggregate values exceed 64 KiB');
  const source={sourceId:id,sequence:params.sequence,values:structuredClone(params.values),monotonicMs:Math.floor(performance.now()),ttlMs:params.ttlMs ?? 5000};
  this.commit({integrations:{sources:[...sources.filter(s=>s.sourceId!==id),source]}},[{method:'data.updated',params:source}]);this.publications.set(id,{owner:p,time:Date.now()});
 }
 private async loadWorld(p:Peer,params:any):Promise<{revision:number}> {
  if(this.load)throw new RpcError(-32004,'World load pending');const world=this.scenario.worlds.find(w=>w.id===params.worldId);
  const hints=this.stopMotion();const shell=this.hideUI(hints);const transition:Ipc02_Transition={id:randomUUID(),outputId:this.state.runtime.outputs[0] || null,phase:'loading',progress:null,to:params,monotonicMs:Math.floor(performance.now())};
  this.commit({shell,location:{...this.state.location,autodrive:false,transition}},[...hints,{method:'location.transition',params:transition}]);
  let cancelled=false;let finish:()=>void=()=>{};const cancel=()=>{cancelled=true;finish();};this.load={peer:p,cancel};
  await new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.timers.delete(timer);resolve();},world?.loadMs ?? 150);finish=()=>{clearTimeout(timer);this.timers.delete(timer);resolve();};this.timers.set(timer,resolve);});this.load=undefined;
  if(cancelled || this.stopped || p.closing){const events=this.transition('cancelled',0);this.commit({location:this.state.location},events);throw new RpcError(-32004,'World load cancelled');}
  const spawn=params.spawnId || world?.spawns[0];if(!world || world.failLoad || !spawn || !world.spawns.includes(spawn)){const events=this.transition('failed',0);this.commit({location:this.state.location},events);throw new RpcError(world?.failLoad?-32602:-32003,'World load failed');}
  const arrival={...transition,phase:'arrived' as const,progress:1,monotonicMs:Math.floor(performance.now())};this.lastPose=Date.now();
  this.commit({world:{id:world.id,spawnId:spawn},runtime:{...this.state.runtime,active:true},movement:{...this.state.movement,position:[0,1.7,0],modeId:'com.hyprune.fly'},location:{zones:world.zones || [],waypoint:null,route:[],autodrive:false,transition:arrival}},[{method:'location.transition',params:arrival}]);return {revision:this.revision};
 }
 private cleanup(p:Peer):void {
  const owned=[...this.publications].filter(([,v])=>v.owner===p).map(([id])=>id);for(const id of owned)this.publications.delete(id);
  this.commit({shell:{leases:this.state.shell.leases.filter(l=>!p.leases.has(l.id))},integrations:{sources:this.state.integrations.sources.filter(s=>!owned.includes(s.sourceId))}});
 }
 commit(changes:Partial<State>,hints:Hint[]=[]):void {
  const next={...this.state,...structuredClone(changes)};validateState({sessionId:this.sessionId,revision:this.revision,state:next});
  if(encodeFrame({jsonrpc:'2.0',id:'budget',result:{subscriptionId:randomUUID(),snapshot:{sessionId:this.sessionId,revision:this.revision,state:next}}}).length>MAX_FRAME-4096)throw new RpcError(-32008,'State exceeds frame budget');
  // Some native control helpers stage a transition before committing it.
  if(JSON.stringify(next)!==JSON.stringify(this.state) || hints.length){if(this.revision>=Number.MAX_SAFE_INTEGER)throw new RpcError(-32008,'Session revision exhausted');this.revision++;}this.state=next;
  for(const hint of hints)this.broadcast(hint.method,{...(hint.params as object),sessionId:this.sessionId,revision:this.revision});
 }
 /** Quest, focus, marker and object changes live outside the 0.2 state: bump the revision and hint newer readers. */
 private extendedCommit(hints:Array<{method:string;params:unknown}>):void {
  if(atLeast(this.protocol,QUEST_PROTOCOL))validateState(this.project(this.snapshot(),this.protocol),this.protocol);
  if(this.revision>=Number.MAX_SAFE_INTEGER)throw new RpcError(-32008,'Session revision exhausted');this.revision++;
  for(const hint of hints)this.broadcast(hint.method,{...(hint.params as object),sessionId:this.sessionId,revision:this.revision});
 }
 private flushDeltas():void {for(const p of this.peers)if(p.subscription && p.baseline!==this.revision){this.send(p,{jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:p.subscription,sessionId:this.sessionId,baseRevision:p.baseline,revision:this.revision,changes:this.view(p).state}});p.baseline=this.revision;}}
 private broadcast(method:string,params:unknown):void {for(const p of this.peers)if(p.hello && p.grants.includes('state.read') && (method==='runtime.notice' || p.protocol!=='0.1' && p.subscription && ((QUEST_EVENTS as readonly string[]).includes(method)?atLeast(p.protocol,QUEST_PROTOCOL):true)))this.send(p,{jsonrpc:'2.0',method,params});}
 private advance():void {
  const now=Date.now(),dt=Math.min(.1,(now-this.lastTick)/1000);this.lastTick=now;
  const expired=this.state.integrations.sources.filter(s=>Math.floor(performance.now())-s.monotonicMs>=s.ttlMs);if(expired.length){for(const s of expired)this.publications.delete(s.sourceId);this.commit({integrations:{sources:this.state.integrations.sources.filter(s=>!expired.includes(s))}});}
  if(this.holding && !this.opened && now-this.heldSince>=350){this.opened=true;const hints:Hint[]=[];const shell={leases:this.state.shell.leases.map(l=>({...l,overlays:l.overlays.map(o=>{hints.push({method:'ui.opened',params:{leaseId:l.id,outputId:o.outputId,panel:'overview'}});return {...o,visible:true,exclusiveInput:false};})}))};this.commit({shell},hints);}
  if(atLeast(this.protocol,QUEST_PROTOCOL)){const hints=this.quests.tick();if(hints)this.extendedCommit(hints);}
  if(this.npcs?.tick())this.extendedCommit([]);
  if(atLeast(this.protocol,OBJECTS_PROTOCOL) && !this.objectTick)this.objectTick=this.objects.tick().then(changed=>{if(changed && !this.stopped)this.extendedCommit([]);},()=>{}).finally(()=>{this.objectTick=undefined;});
  if(this.load || !this.state.runtime.active)return;
  if(this.motion){const motion=this.motion,progress=Math.min(1,(now-motion.start)/motion.duration),eased=progress*progress*(3-2*progress);const position=motion.from.map((n,i)=>n+(motion.to[i]-n)*eased) as Vec3;const hints=this.transition(progress===1?'arrived':'travelling',progress);this.commit({movement:{...this.state.movement,position},location:this.state.location},hints);if(progress===1)this.motion=undefined;return;}
  if(this.state.location.autodrive){const point=this.state.location.route[this.driveIndex]?.position;if(!point){this.commit({location:{...this.state.location,autodrive:false}});return;}const from=this.state.movement.position,distance=Math.hypot(...point.map((n,i)=>n-from[i])),step=this.speed*dt,position=distance<=step?point:from.map((n,i)=>n+(point[i]-n)*step/distance) as Vec3;
   const steps=Math.max(1,Math.ceil(Math.min(distance,step)/.05));if(Array.from({length:steps},(_,i)=>from.map((n,j)=>n+(position[j]-n)*(i+1)/steps) as Vec3).some(p=>this.blocked(p))){this.commit({location:{...this.state.location,autodrive:false}});return;}
   const done=distance<=step && ++this.driveIndex>=this.state.location.route.length;this.commit({movement:{...this.state.movement,position},location:{...this.state.location,autodrive:!done}});return;
  }
  const path=this.scenario.path;if(path.length<2 || now-this.lastPose<1000)return;const t=((now-this.started)/2500)%(path.length-1),i=Math.floor(t),f=t-i;const position=path[i].map((n,j)=>n+(path[i+1][j]-n)*f) as Vec3;this.commit({movement:{...this.state.movement,position}});
 }
}

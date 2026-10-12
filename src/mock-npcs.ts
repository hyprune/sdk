// Characters, paths, interactions and the npc_motion graphics setting for the mock daemon
// (IPC 0.23, RFC-0010/RFC-0011 P2). Development simulation only: characters live among the
// ObjectEngine's instances (authored fixture characters, user characters as placements);
// routes are sampled with the world 0.9 segment geometry and checked box-level against the
// mock's zones and obstacles (no collision or navmesh); nothing is persisted.
import {RpcError} from './client.js';
import {type ObjectEngine,type Notice,type CharacterData,type Placement,type PackagePath,type CharacterLive,FIXTURE_CHARACTERS} from './mock-objects.js';
import type {Ipc23_EditorPath,Ipc23_GraphicsConfig,Ipc23_GraphicsGetResult,Ipc23_GraphicsPatch,Ipc23_NpcsState,Ipc23_ObjectPose,Ipc23_PathRecord,
 Ipc23_PathStop,Ipc23_PathPoint,Ipc23_Performance,Ipc23_Target,World09_InstanceInteraction} from './generated.js';

/** Grant per 0.23 method on the mock (RFC-0011 P2; graphics as RFC-0008). */
export const NPC_REQUIREMENTS={
 'npcs.spawn':'objects.control','npcs.bind':'objects.control','npcs.disable':'objects.control','npcs.remove':'objects.control',
 'paths.list':'state.read','paths.set':'objects.control','paths.remove':'objects.control','paths.draw':'objects.control','paths.finish':'objects.control',
 'interaction.choose':'world.control','graphics.get':'state.read','graphics.set':'world.control'
} as const;
/** Character limits per world (RFC-0011 P2) and per path. */
export const NPC_LIMITS={authored:16,user:8,perPath:8} as const;
/** Mock route pace in m/s before the character's and the path's speed. */
export const WALK_SPEED=1.2;
/** The use distance the mock aims characters within (horizontal metres). */
export const USE_DISTANCE=3;
export type PowerProfile=Ipc23_Performance['profile'];
const PAUSE_REASONS:Record<PowerProfile,string|null>={'full-ac':null,'limited-ac':null,battery:'battery','usb-c':'usb-c power',unknown:'power unknown'};
export const GRAPHICS_DEFAULTS:Ipc23_GraphicsConfig={quality:'high',msaa:4,bloom:'low',fog:'height',sky:'environment',anisotropy:8,reflections:true,normal_maps:true,
 specular:true,ambient_occlusion:true,alpha_haze:true,dynamic_resolution:false,reduced_motion:false,render_scale:1,target_fps:60,fov:70,exposure:1,bloom_strength:0.5,
 sharpen:0,offload:'off',offload_power_cap_w:null,offload_device:'auto',scale_min:0.5,scale_max:1,outline:null,visibility_culling:true,outline_quality:null,
 outline_width_px:null,outline_colour:null,upscaler:null,npc_motion:'auto'};
const SAMPLES=24,PUBLISH_MS=500,FLOOR_REACH=0.35,BODY_RADIUS=0.35;

type Vec3=[number,number,number];
type Pose=Ipc23_ObjectPose;
type Point=Ipc23_PathPoint;
type Box={min:number[];max:number[]};
export interface NpcWorld {id:string|null;active:boolean;zones:Array<{id:string;bounds:Box}>;obstacles:Box[];position:number[];orientation:number[]}
/** A user path in the overlay (editor.json path record with the 0.23 fields). */
interface UserPath {id:string;name:string|null;use:'route'|'track'|'generic';closed:boolean;points:Point[];speed:number|null;stops:Ipc23_PathStop[];areaId:string}
interface AnyPath {ref:string;source:'package'|'user';id:string;name:string|null;use:'route'|'track'|'generic';closed:boolean;points:Point[];speed:number|null;stops:Ipc23_PathStop[]}
interface Drawing {pathId:string;use:'route'|'track'|'generic';spawn:{ref:string;phase?:number;speed?:number;accent?:Vec3|null}|null;bind:string|null}
interface Character {id:string;source:'authored'|'user';name:string;pose:Pose;npc:CharacterData;hidden:boolean;placement?:Placement}
type Interaction=NonNullable<Ipc23_NpcsState['interaction']>;
/** What a call did: its result, whether state changed, notices, and a waypoint for the daemon to set. */
export interface NpcCall {result?:Record<string,unknown>;changed:boolean;notices:Notice[];waypoint?:{id:string;label:string;target:Ipc23_Target};revision?:'none'}

// ---- route geometry (world 0.9: a point's type is its arriving segment) ----
const sub=(a:number[],b:number[])=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const fmt=(p:number[])=>`(${p.map(v=>(Math.round(v*100)/100).toFixed(2)).join(', ')})`;
/** Samples along a path, 24 per segment: line straight, curve cubic Hermite, arc bowed sideways. */
export function samplePath(points:Point[],closed:boolean):Vec3[] {
 const n=points.length;if(n===0) return [];
 const out:Vec3[]=[[...points[0].position] as Vec3];
 const segments=closed && n>1?n:n-1;
 for(let s=0;s<segments;s++){
  const i=s,j=(s+1)%n,a=points[i].position,b=points[j].position,type=points[j].type,ab=sub(b,a);
  const prev=i>0 || closed?points[(i-1+n)%n].position:undefined,m0=prev?sub(b,prev).map(v=>v/2):ab,m1=ab;
  const h=Math.hypot(ab[0],ab[2]),side=h>1e-9?[-ab[2]/h,0,ab[0]/h]:[0,0,0];
  for(let k=1;k<=SAMPLES;k++){
   const t=k/SAMPLES;let p:number[];
   if(type==='curve'){
    const t2=t*t,t3=t2*t,h00=2*t3-3*t2+1,h10=t3-2*t2+t,h01=-2*t3+3*t2,h11=t3-t2;
    p=[0,1,2].map(c=>h00*a[c]+h10*m0[c]+h01*b[c]+h11*m1[c]);
   }else{
    p=[0,1,2].map(c=>a[c]+ab[c]*t);
    if(type==='arc'){const o=0.3*Math.hypot(...ab)*Math.sin(Math.PI*t);p=p.map((v,c)=>v+side[c]*o);}
   }
   out.push(p as Vec3);
  }
 }
 return out;
}
/** Cumulative arc length per sample. */
function lengths(samples:Vec3[]):number[] {const out=[0];for(let i=1;i<samples.length;i++) out.push(out[i-1]+Math.hypot(...sub(samples[i],samples[i-1])));return out;}
/** The position and heading (yaw quaternion) at arc distance d. */
function along(samples:Vec3[],cumulative:number[],d:number,direction:1|-1):Pose {
 const total=cumulative.at(-1) || 0;d=Math.max(0,Math.min(total,d));
 let i=1;while(i<cumulative.length-1 && cumulative[i]<d) i++;
 const a=samples[Math.max(0,i-1)],b=samples[Math.min(samples.length-1,i)],span=(cumulative[i] ?? 0)-(cumulative[i-1] ?? 0),t=span>1e-9?(d-cumulative[i-1])/span:0;
 const position=[0,1,2].map(c=>Math.round((a[c]+(b[c]-a[c])*t)*1e4)/1e4) as Vec3;
 const dir=sub(b,a).map(v=>v*direction),yaw=Math.hypot(dir[0],dir[2])>1e-9?Math.atan2(dir[0],dir[2]):0;
 return {position,rotation:[0,Math.round(Math.sin(yaw/2)*1e6)/1e6,0,Math.round(Math.cos(yaw/2)*1e6)/1e6]};
}

export class NpcEngine {
 private paths=new Map<string,UserPath[]>();private counters=new Map<string,number>();
 private drawing:Drawing|null=null;private interaction:Interaction|null=null;
 /** Notices of refused calls (npc.budget), drained by the daemon after every call. */
 outbox:Notice[]=[];
 private overrides:Ipc23_GraphicsPatch={};
 /** Simulated offload power profile (RFC-0009); `auto` animates on full-ac and limited-ac only. */
 profile:PowerProfile='full-ac';
 private progress=new Map<string,{distance:number;direction:1|-1;route:string}>();private lastTick=Date.now();private lastPublish=0;
 constructor(private readonly objects:ObjectEngine,private readonly world:()=>NpcWorld) {
  objects.live=(worldId,id)=>this.live(worldId,id);
 }

 // ---- graphics ----
 get config():Ipc23_GraphicsConfig {return {...GRAPHICS_DEFAULTS,...this.overrides} as Ipc23_GraphicsConfig;}
 graphics():Ipc23_GraphicsGetResult {
  const config=this.config;
  const performance:Ipc23_Performance={profile:this.profile,powerW:null,capW:80,capSource:'fallback',device:null,targetFPS:60,reason:'',pid:null,generation:0,mode:'off',
   activeRenderer:'in-process',status:'local',preset:'high',requested:structuredClone(config),effective:structuredClone(config),costsMs:{},workerTimings:null,controls:{}};
  return {config:structuredClone(config),effective:structuredClone(config),overrides:structuredClone(this.overrides),path:'',error:'',presets:{},
   options:{npc_motion:['auto','always','still','off']},unsupported:[],timings:{},performance};
 }

 // ---- characters ----
 private characters(worldId:string|null):Character[] {
  if(!worldId) return [];
  const authored=this.objects.authoredOf(worldId).filter(o=>o.npc).map(o=>({id:o.id,source:'authored' as const,name:this.objects.resolve(`package/${o.asset}`)?.name || o.asset,
   pose:o.pose,npc:o.npc!,hidden:this.objects.authoredHidden(worldId,o.id)}));
  const user=this.objects.placementsOf(worldId).filter(p=>p.npc).map(p=>{
   const e=this.objects.resolve(p.ref);
   return {id:p.id,source:'user' as const,name:e?.name || p.ref,pose:p.pose,npc:p.npc!,hidden:p.npc!.disabled || e?.state!=='ready',placement:p};
  });
  return [...authored,...user];
 }
 private character(worldId:string,id:string):Character {
  const c=this.characters(worldId).find(x=>x.id===id);
  if(c) return c;
  this.objects.find(worldId,id);// -32004 when unknown
  throw new RpcError(-32005,`not a character: ${id}`);
 }
 /** Motion state and pause reason (RFC-0010 amendment): setting, then activity, then power. */
 private motion():{state:Ipc23_NpcsState['state'];reason:string|null} {
  const w=this.world(),motion=this.config.npc_motion || 'auto';
  if(!this.characters(w.id).some(c=>!c.hidden)) return {state:'none',reason:null};
  if(motion==='off') return {state:'off',reason:null};
  if(motion==='still') return {state:'still',reason:null};
  if(!w.active) return {state:'paused',reason:'inactive'};
  if(motion==='auto' && this.config.reduced_motion) return {state:'paused',reason:'reduced motion'};
  const power=motion==='auto'?PAUSE_REASONS[this.profile]:null;
  return power?{state:'paused',reason:power}:{state:'animating',reason:null};
 }
 private route(worldId:string,ref:string|null):{samples:Vec3[];cumulative:number[];path:AnyPath}|undefined {
  if(!ref) return undefined;
  const path=this.allPaths(worldId).find(p=>p.ref===ref);if(!path || path.points.length<2) return undefined;
  const samples=samplePath(path.points,path.closed);return {samples,cumulative:lengths(samples),path};
 }
 private live(worldId:string,id:string):CharacterLive|undefined {
  const c=this.characters(worldId).find(x=>x.id===id);if(!c) return undefined;
  const interacting=this.interaction?.objectId===id && this.interaction.type!=='choose';
  const activity=interacting?(this.interaction!.type==='guide'?'guiding':'interacting'):undefined;
  const r=this.route(worldId,c.npc.path);
  if(!r) return {activity:activity || 'idle'};
  const p=this.walk(worldId,c,r);
  return {pose:along(r.samples,r.cumulative,p.distance,p.direction),activity:activity || 'walking'};
 }
 private walk(worldId:string,c:Character,r:{cumulative:number[]}):{distance:number;direction:1|-1;route:string} {
  const key=`${worldId}/${c.id}`;let p=this.progress.get(key);
  if(!p || p.route!==c.npc.path){p={distance:c.npc.phase*(r.cumulative.at(-1) || 0),direction:c.npc.reverse?-1:1,route:c.npc.path!};this.progress.set(key,p);}
  return p;
 }
 /** Advance route characters while animating; true when positions should be published (at most twice a second). */
 tick(now=Date.now()):boolean {
  const dt=Math.min(1,(now-this.lastTick)/1000);this.lastTick=now;
  const w=this.world();if(!w.id || this.motion().state!=='animating') return false;
  let moved=false;
  for(const c of this.characters(w.id)){
   if(c.hidden || this.interaction?.objectId===c.id) continue;
   const r=this.route(w.id,c.npc.path);if(!r) continue;
   const total=r.cumulative.at(-1) || 0;if(total<=0) continue;
   const p=this.walk(w.id,c,r),pace=(r.path.speed ?? WALK_SPEED)*c.npc.speed;
   p.distance+=p.direction*pace*dt;
   if(r.path.closed) p.distance=((p.distance%total)+total)%total;
   else if(p.distance>total || p.distance<0){p.distance=Math.max(0,Math.min(total,p.distance));p.direction=p.direction===1?-1:1;}
   moved=true;
  }
  if(!moved || now-this.lastPublish<PUBLISH_MS) return false;
  this.lastPublish=now;return true;
 }

 // ---- state ----
 state23():Ipc23_NpcsState {
  const w=this.world(),chars=this.characters(w.id),{state,reason}=this.motion();
  return {motion:this.config.npc_motion || 'auto',state,reason,
   usage:{authored:chars.filter(c=>c.source==='authored').length,user:chars.filter(c=>c.source==='user').length},limits:{authored:NPC_LIMITS.authored,user:NPC_LIMITS.user},
   drawing:this.drawing?{pathId:this.drawing.pathId,use:this.drawing.use,spawn:this.drawing.spawn?{ref:this.drawing.spawn.ref}:null,bind:this.drawing.bind}:null,
   // An interaction ends with its character (removed or disabled through objects.*).
   aimed:this.aimed(),interaction:this.interaction && chars.some(c=>c.id===this.interaction!.objectId && !c.hidden)?structuredClone(this.interaction):null};
 }
 /** The character with interactions nearest the player within the use distance (the mock has no reticle). */
 aimed():Ipc23_NpcsState['aimed'] {
  const w=this.world();if(!w.id || !w.active || this.config.npc_motion==='off') return null;
  let best:{c:Character;d:number}|undefined;
  for(const c of this.characters(w.id)){
   if(c.hidden || !c.npc.interactions.length) continue;
   const pose=this.live(w.id,c.id)?.pose || c.pose,d=Math.hypot(pose.position[0]-w.position[0],pose.position[2]-w.position[2]);
   if(d<=USE_DISTANCE && (!best || d<best.d)) best={c,d};
  }
  if(!best) return null;
  const c=best.c,list=c.npc.interactions,single=list.length===1?list[0]:undefined;
  return {objectId:c.id,name:c.name.slice(0,64),prompt:(single?single.prompt ?? single.label:`Talk to ${c.name}`).slice(0,64),
   interactions:list.map(i=>({id:i.id,label:i.label,type:i.action.type as 'say'|'waypoint'|'guide'|'panel'}))};
 }
 /** Whether a tool-3 draw is in progress (the view selects tool 3 meanwhile). */
 get drawingPath():boolean {return !!this.drawing;}
 editorPaths():Ipc23_EditorPath[] {
  const w=this.world();if(!w.id) return [];
  return (this.paths.get(w.id) || []).map(p=>({id:p.id,worldId:w.id!,areaId:p.areaId,closed:p.closed,points:structuredClone(p.points),use:p.use,name:p.name,speed:p.speed,stops:structuredClone(p.stops)}));
 }

 // ---- paths ----
 private allPaths(worldId:string):AnyPath[] {
  const pkg=(FIXTURE_CHARACTERS[worldId]?.paths || []).map((p:PackagePath)=>({...structuredClone(p),ref:`package/${p.id}`,source:'package' as const,stops:p.stops as Ipc23_PathStop[]}));
  const user=(this.paths.get(worldId) || []).map(p=>({ref:`user/${p.id}`,source:'user' as const,id:p.id,name:p.name,use:p.use,closed:p.closed,points:p.points,speed:p.speed,stops:p.stops}));
  return [...pkg,...user];
 }
 /** A bare id means package/<id>. */
 private qualify(param:string):string {return param.includes('/')?param:`package/${param}`;}
 /**
  * The mock's walkability: at least 2 points; every sample inside a zone, within 0.35 m above its
  * floor and clear of obstacles (grown by the body radius). Box-level only, no collision or navmesh.
  */
 problems(points:Point[],closed:boolean):string[] {
  if(points.length<2) return [`a route needs at least 2 points, has ${points.length}`];
  const w=this.world(),out:string[]=[];let last='';
  for(const s of samplePath(points,closed)){
   let kind='';
   const zone=w.zones.find(z=>s[0]>=z.bounds.min[0] && s[0]<=z.bounds.max[0] && s[2]>=z.bounds.min[2] && s[2]<=z.bounds.max[2] && s[1]>=z.bounds.min[1]-0.05 && s[1]<=z.bounds.min[1]+FLOOR_REACH);
   if(w.zones.length && !zone) kind=`no walkable floor at ${fmt(s)}`;
   else if(w.obstacles.some(o=>s[0]>o.min[0]-BODY_RADIUS && s[0]<o.max[0]+BODY_RADIUS && s[2]>o.min[2]-BODY_RADIUS && s[2]<o.max[2]+BODY_RADIUS && s[1]<o.max[1] && s[1]+1.8>o.min[1])) kind=`blocked at ${fmt(s)}`;
   if(kind && kind.split(' at ')[0]!==last) out.push(kind);
   last=kind.split(' at ')[0];
   if(out.length>=8) break;
  }
  return out;
 }
 private bound(worldId:string,ref:string):string[] {return this.characters(worldId).filter(c=>c.npc.path===ref).map(c=>c.id);}
 private record(worldId:string,p:AnyPath):Ipc23_PathRecord {
  const route=p.use==='route',problems=route?this.problems(p.points,p.closed):[];
  return {ref:p.ref,source:p.source,id:p.id,name:p.name,use:p.use,closed:p.closed,points:structuredClone(p.points).slice(0,256),speed:p.speed,stops:structuredClone(p.stops).slice(0,32),
   walkable:route?problems.length===0:null,problems:problems.map(m=>m.slice(0,256)),bound:this.bound(worldId,p.ref).slice(0,8)};
 }
 private nextPathId(worldId:string):string {
  const list=this.paths.get(worldId) || [],pkg=FIXTURE_CHARACTERS[worldId]?.paths || [];let n=this.counters.get(worldId) || 0,id:string;
  do id=`path-${++n}`;while(list.some(p=>p.id===id) || pkg.some(p=>p.id===id));
  this.counters.set(worldId,n);return id;
 }
 private areaOf(points:Point[]):string {const p=points[0]?.position;return p?this.objects.areaOf(p):'';}
 private walkableRoute(worldId:string,param:string):string {
  const ref=this.qualify(param),path=this.allPaths(worldId).find(p=>p.ref===ref);
  if(!path) throw new RpcError(-32004,`unknown path ${ref}`);
  if(path.use!=='route') throw new RpcError(-32007,`walkable: ${ref} is not a route (use ${path.use})`,{retryable:false,rule:'walkable'});
  const problems=this.problems(path.points,path.closed);
  if(problems.length) throw new RpcError(-32007,`walkable: ${ref}: ${problems[0]}`,{retryable:false,rule:'walkable'});
  return ref;
 }
 private perPath(worldId:string,ref:string,except?:string):void {
  if(this.bound(worldId,ref).filter(id=>id!==except).length>=NPC_LIMITS.perPath) throw new RpcError(-32008,`budget: ${ref} already carries ${NPC_LIMITS.perPath} characters`,{retryable:false,rule:'budget'});
 }
 private checkStops(points:Point[],stops:Ipc23_PathStop[]|undefined,use:string):void {
  const seen=new Set<number>();
  for(const s of stops || []){
   if(s.point>=points.length) throw new RpcError(-32602,`stops: point ${s.point} is past the path's ${points.length} points`);
   if(seen.has(s.point)) throw new RpcError(-32602,`stops: more than one stop at point ${s.point}`);seen.add(s.point);
   if(use==='track' && (s.clip || s.face || s.seat)) throw new RpcError(-32602,'stops: track stops take point and seconds only');
  }
  if(use==='generic' && stops?.length) throw new RpcError(-32602,'stops: generic paths have no stops');
 }

 // ---- spawning ----
 private characterEntry(ref:string) {
  const e=this.objects.resolve(ref);if(!e) throw new RpcError(-32004,`unknown object ${ref}`);
  if(!e.traits.includes('character')) throw new RpcError(-32005,`not a character: ${ref}`);
  if(e.state!=='ready') throw new RpcError(-32005,`invalid: ${e.errors[0] || ref+' did not validate'}`);
  return e;
 }
 private userBudget(worldId:string):void {
  if(this.characters(worldId).filter(c=>c.source==='user').length>=NPC_LIMITS.user){
   this.outbox.push({level:'warning',code:'npc.budget',message:`at most ${NPC_LIMITS.user} user characters per world`,since:'0.23'});
   throw new RpcError(-32008,`budget: at most ${NPC_LIMITS.user} user characters per world`,{retryable:false,rule:'budget'});
  }
 }
 private spawn(worldId:string,params:{ref:string;path?:string;pose?:Pose;phase?:number;speed?:number;accent?:Vec3|null;reverse?:boolean},notices:Notice[]):string {
  const e=this.characterEntry(params.ref);this.userBudget(worldId);
  let path:string|null=null,pose:Pose;
  if(params.path!==undefined){path=this.walkableRoute(worldId,params.path);this.perPath(worldId,path);}
  if(path){const r=this.route(worldId,path)!;pose=along(r.samples,r.cumulative,(params.phase ?? 0)*(r.cumulative.at(-1) || 0),params.reverse?-1:1);}
  else if(params.pose){this.objects.checkPose(params.pose);pose=structuredClone(params.pose);const rule=this.objects.rule(e,pose,1);if(rule) this.objects.refuse(rule,`${e.name} cannot stand there`);}
  else pose=this.objects.spawnPose(e,1);
  const id=this.objects.newId(worldId),list=this.objects.placementsOf(worldId);
  const placement:Placement={id,ref:e.ref,areaId:this.objects.areaOf(pose.position),pose,scale:1,locked:false,
   npc:{path,phase:params.phase ?? 0,speed:params.speed ?? 1,accent:params.accent ?? null,reverse:params.reverse ?? false,disabled:false,interactions:[]}};
  this.objects.budget([...list,placement]);
  list.push(placement);
  notices.push({level:'info',code:'npc.spawned',message:`${e.name} spawned${path?' on '+path:''}`,since:'0.23'});
  return id;
 }
 private userCharacter(worldId:string,id:string):Character & {placement:Placement} {
  const c=this.character(worldId,id);
  if(c.source==='authored') throw new RpcError(-32005,`authored: ${id} belongs to the world; it can only be disabled`);
  return c as Character & {placement:Placement};
 }
 private bind(worldId:string,id:string,params:{path?:string;pose?:Pose;phase?:number;speed?:number;accent?:Vec3|null;reverse?:boolean}):void {
  const c=this.userCharacter(worldId,id),npc=c.placement.npc!,e=this.objects.resolve(c.placement.ref);
  let path=npc.path,pose=c.placement.pose;
  if(params.path!==undefined){path=this.walkableRoute(worldId,params.path);if(path!==npc.path) this.perPath(worldId,path,id);}
  if(params.pose){
   this.objects.checkPose(params.pose);
   if(e){const rule=this.objects.rule(e,params.pose,1);if(rule) this.objects.refuse(rule,`${e.name} cannot stand there`);}
   path=null;pose=structuredClone(params.pose);
  }
  if(params.reverse!==undefined && !path) throw new RpcError(-32602,'reverse needs a path');
  if(!path && npc.path && !params.pose) pose=this.live(worldId,id)?.pose || pose;
  Object.assign(npc,{path,phase:params.phase ?? npc.phase,speed:params.speed ?? npc.speed,accent:params.accent!==undefined?params.accent:npc.accent,
   reverse:path?(params.reverse ?? npc.reverse):false});
  if(path){const r=this.route(worldId,path)!;pose=along(r.samples,r.cumulative,npc.phase*(r.cumulative.at(-1) || 0),npc.reverse?-1:1);}
  Object.assign(c.placement,{pose,areaId:this.objects.areaOf(pose.position)});
  // A new binding or phase restarts the walk from the phase.
  if(params.path!==undefined || params.phase!==undefined || params.reverse!==undefined || params.pose) this.progress.delete(`${worldId}/${id}`);
 }

 // ---- interactions ----
 private run(worldId:string,c:Character,i:World09_InstanceInteraction):NpcCall['waypoint'] {
  const base={objectId:c.id,interactionId:i.id,label:i.label,choices:[],line:null,lineIndex:0,lineCount:0,panel:null};
  const a=i.action;
  if(a.type==='say'){
   const cur=this.interaction,next=cur?.objectId===c.id && cur.interactionId===i.id && cur.type==='say'?cur.lineIndex+1:0;
   this.interaction=next<a.lines.length?{...base,type:'say',line:a.lines[next],lineIndex:next,lineCount:a.lines.length}:null;
   return undefined;
  }
  if(a.type==='panel'){this.interaction={...base,type:'panel',panel:a.panel};return undefined;}
  if(a.type==='guide'){this.interaction={...base,type:'guide'};return undefined;}
  if(a.type==='waypoint'){
   this.interaction={...base,type:'waypoint'};
   const t=a.target as {zoneId?:string;position?:Vec3;anchor?:string;object?:string};
   let target:Ipc23_Target;
   if(t.zoneId!==undefined) target={zoneId:t.zoneId};
   else if(t.position) target={position:[...t.position] as Vec3};
   else if(t.object!==undefined){const o=this.objects.state().instances.find(x=>x.id===t.object);if(!o) throw new RpcError(-32004,`unknown object ${t.object}`);target={position:[...o.pose.position] as Vec3};}
   else throw new RpcError(-32004,`unknown anchor ${t.anchor}`);
   return {id:`npc-${c.id}`,label:i.label,target};
  }
  throw new RpcError(-32005,`reserved action ${(a as {type:string}).type}`);
 }
 private interactive(worldId:string,id:string):Character {
  const c=this.character(worldId,id);
  if(c.hidden) throw new RpcError(-32005,`disabled: ${id} offers no interactions`);
  if(this.config.npc_motion==='off') throw new RpcError(-32005,'npc_motion is off: characters offer no interactions');
  return c;
 }
 /** E on the aimed character (native input simulation): advance a running say, run a single interaction, or offer the choice list. */
 use():NpcCall {
  const w=this.world(),aimed=this.aimed();if(!w.id || !aimed) return {changed:false,notices:[]};
  const c=this.interactive(w.id,aimed.objectId),cur=this.interaction;
  if(cur?.objectId===c.id && cur.type==='say' && cur.interactionId){const i=c.npc.interactions.find(x=>x.id===cur.interactionId)!;return {changed:true,notices:[],waypoint:this.run(w.id,c,i)};}
  if(c.npc.interactions.length===1) return {changed:true,notices:[],waypoint:this.run(w.id,c,c.npc.interactions[0])};
  this.interaction={objectId:c.id,interactionId:null,type:'choose',label:c.name.slice(0,64),choices:c.npc.interactions.map(i=>({id:i.id,label:i.label})),line:null,lineIndex:0,lineCount:0,panel:null};
  return {changed:true,notices:[]};
 }
 /** A tool-3 click while drawing (native input simulation): append a point to the drawn path. */
 drawPoint(position:Vec3,type:Point['type']='line'):boolean {
  const w=this.world();if(!w.id || !this.drawing) return false;
  const p=(this.paths.get(w.id) || []).find(x=>x.id===this.drawing!.pathId);if(!p || p.points.length>=256) return false;
  p.points.push({position:[...position] as Vec3,type});if(p.points.length===1) p.areaId=this.areaOf(p.points);
  return true;
 }

 // ---- methods ----
 private requireWorld():string {
  const w=this.world();if(!w.id || !w.active) throw new RpcError(-32005,'exploration inactive: load a world first');return w.id;
 }
 execute(method:string,params:any):NpcCall {
  const notices:Notice[]=[];
  switch(method){
   case 'graphics.get':return {result:this.graphics() as unknown as Record<string,unknown>,changed:false,notices,revision:'none'};
   case 'graphics.set':{
    const before=JSON.stringify(this.state23());
    for(const [k,v] of Object.entries(params.patch as Record<string,unknown>)){
     if(JSON.stringify(v)===JSON.stringify((GRAPHICS_DEFAULTS as Record<string,unknown>)[k])) delete (this.overrides as Record<string,unknown>)[k];
     else (this.overrides as Record<string,unknown>)[k]=structuredClone(v);
    }
    if(this.config.npc_motion==='off') this.interaction=null;
    return {result:this.graphics() as unknown as Record<string,unknown>,changed:before!==JSON.stringify(this.state23()),notices,revision:'none'};
   }
   case 'paths.list':{
    const w=this.world();
    return {result:{paths:w.id?this.allPaths(w.id).slice(0,192).map(p=>this.record(w.id!,p)):[]},changed:false,notices,revision:'none'};
   }
   case 'paths.set':{
    const worldId=this.requireWorld(),input=params.path,list=this.paths.get(worldId) || [];
    if(input.id!==undefined && (FIXTURE_CHARACTERS[worldId]?.paths || []).some(p=>p.id===input.id)) throw new RpcError(-32005,`protected: ${input.id} is a package path`);
    this.checkStops(input.points,input.stops,input.use);
    const id=input.id ?? this.nextPathId(worldId),ref=`user/${id}`,bound=this.bound(worldId,ref);
    if(input.use==='route'){
     const problems=this.problems(input.points,input.closed);
     if(problems.length) throw new RpcError(-32007,`walkable: ${problems[0]}`,{retryable:false,rule:'walkable'});
    }else if(bound.length) throw new RpcError(-32007,`walkable: ${ref} carries ${bound.join(', ')} and must stay a route`,{retryable:false,rule:'walkable'});
    const path:UserPath={id,name:input.name ?? null,use:input.use,closed:input.closed,points:structuredClone(input.points),speed:input.speed ?? null,stops:structuredClone(input.stops || []),areaId:this.areaOf(input.points)};
    const index=list.findIndex(p=>p.id===id);if(index>=0) list[index]=path;else list.push(path);this.paths.set(worldId,list);
    // Bound characters follow the new geometry from their phase.
    for(const c of bound) this.progress.delete(`${worldId}/${c}`);
    notices.push({level:'info',code:'path.saved',message:`${ref} saved`,since:'0.23'});
    return {result:{id},changed:true,notices};
   }
   case 'paths.remove':{
    const worldId=this.requireWorld(),list=this.paths.get(worldId) || [];
    if((FIXTURE_CHARACTERS[worldId]?.paths || []).some(p=>p.id===params.id)) throw new RpcError(-32005,`protected: ${params.id} is a package path`);
    const path=list.find(p=>p.id===params.id);if(!path) throw new RpcError(-32004,`unknown path user/${params.id}`);
    const ref=`user/${path.id}`,bound=this.characters(worldId).filter(c=>c.npc.path===ref);
    if(bound.length && !params.unbind) throw new RpcError(-32005,`bound: ${bound.map(c=>c.id).join(', ')} walk ${ref}; pass unbind to leave them standing`);
    for(const c of bound){
     // Unbound characters stand where they are.
     const pose=this.live(worldId,c.id)?.pose || c.pose;c.npc.path=null;c.npc.reverse=false;
     if(c.placement) Object.assign(c.placement,{pose,areaId:this.objects.areaOf(pose.position)});
     this.progress.delete(`${worldId}/${c.id}`);
    }
    this.paths.set(worldId,list.filter(p=>p!==path));
    if(this.drawing?.pathId===path.id) this.drawing=null;
    notices.push({level:'info',code:'path.removed',message:`${ref} removed`,since:'0.23'});
    return {changed:true,notices};
   }
   case 'paths.draw':{
    const worldId=this.requireWorld(),use=params.use ?? 'route';
    if((params.spawn || params.bind) && use!=='route') throw new RpcError(-32602,'spawn and bind draw a route (use route)');
    if(params.spawn){this.characterEntry(params.spawn.ref);this.userBudget(worldId);}
    if(params.bind) this.userCharacter(worldId,params.bind);
    // A second draw replaces the first; an empty earlier path goes away.
    const list=this.paths.get(worldId) || [];
    if(this.drawing){const old=list.findIndex(p=>p.id===this.drawing!.pathId && !p.points.length);if(old>=0) list.splice(old,1);}
    const id=this.nextPathId(worldId);
    list.push({id,name:params.name ?? null,use,closed:false,points:[],speed:null,stops:[],areaId:''});this.paths.set(worldId,list);
    this.drawing={pathId:id,use,spawn:params.spawn?structuredClone(params.spawn):null,bind:params.bind ?? null};
    return {result:{id},changed:true,notices};
   }
   case 'paths.finish':{
    const w=this.world(),d=this.drawing;
    if(!w.id || !d) return {result:{id:null,bound:null},changed:false,notices};
    this.drawing=null;
    const path=(this.paths.get(w.id) || []).find(p=>p.id===d.pathId);
    if(!path) return {result:{id:null,bound:null},changed:true,notices};
    const ref=`user/${path.id}`;
    notices.push({level:'info',code:'path.saved',message:`${ref} saved`,since:'0.23'});
    if(path.use!=='route' || (!d.spawn && !d.bind)) return {result:{id:path.id,bound:null},changed:true,notices};
    const problems=this.problems(path.points,path.closed);
    if(problems.length){
     notices.push({level:'warning',code:'path.unwalkable',message:`${ref}: ${problems[0]}`,since:'0.23'});
     return {result:{id:path.id,bound:null},changed:true,notices};
    }
    let bound:string|null=null;
    try{
     if(d.spawn) bound=this.spawn(w.id,{ref:d.spawn.ref,path:ref,phase:d.spawn.phase,speed:d.spawn.speed,accent:d.spawn.accent},notices);
     else{this.bind(w.id,d.bind!,{path:ref});bound=d.bind;}
    }catch(e){
     // The path stays; the character could not be placed (budget or a vanished character).
     if(!(e instanceof RpcError)) throw e;
     if(!this.outbox.some(n=>n.code==='npc.budget')) notices.push({level:'warning',code:'path.unwalkable',message:`${ref}: ${e.message}`.slice(0,512),since:'0.23'});
    }
    return {result:{id:path.id,bound},changed:true,notices};
   }
   case 'npcs.spawn':{
    const worldId=this.requireWorld(),id=this.spawn(worldId,params,notices);
    return {result:{id},changed:true,notices};
   }
   case 'npcs.bind':{
    const worldId=this.requireWorld();this.bind(worldId,params.id,params);return {changed:true,notices};
   }
   case 'npcs.disable':{
    const worldId=this.requireWorld(),c=this.character(worldId,params.id);
    const was=c.source==='authored'?this.objects.authoredHidden(worldId,c.id):c.npc.disabled;
    if(c.source==='authored') this.objects.setAuthoredHidden(worldId,c.id,params.disabled);else c.npc.disabled=params.disabled;
    if(params.disabled && this.interaction?.objectId===c.id) this.interaction=null;
    if(was!==params.disabled) notices.push({level:'info',code:params.disabled?'npc.disabled':'npc.enabled',message:`${c.id} ${params.disabled?'disabled':'enabled'}`,since:'0.23'});
    return {changed:was!==params.disabled,notices};
   }
   case 'npcs.remove':{
    const worldId=this.requireWorld(),list=this.objects.placementsOf(worldId);
    const gone=params.all?list.filter(p=>p.npc).map(p=>p.id):[this.userCharacter(worldId,params.id).id];
    for(const id of gone){list.splice(list.findIndex(p=>p.id===id),1);this.progress.delete(`${worldId}/${id}`);}
    if(this.interaction && gone.includes(this.interaction.objectId)) this.interaction=null;
    if(this.drawing?.bind && gone.includes(this.drawing.bind)) this.drawing={...this.drawing,bind:null};
    if(gone.length) notices.push({level:'info',code:'npc.removed',message:gone.length===1?`${gone[0]} removed`:`${gone.length} characters removed`,since:'0.23'});
    return {changed:gone.length>0,notices};
   }
   case 'interaction.choose':{
    const worldId=this.requireWorld();
    if(params.interactionId===null){
     const c=this.character(worldId,params.objectId);
     if(this.interaction?.objectId!==c.id) return {changed:false,notices};
     this.interaction=null;return {changed:true,notices};
    }
    const c=this.interactive(worldId,params.objectId),i=c.npc.interactions.find(x=>x.id===params.interactionId);
    if(!i) throw new RpcError(-32004,`unknown interaction ${params.interactionId} on ${c.id}`);
    return {changed:true,notices,waypoint:this.run(worldId,c,i)};
   }
  }
  throw new RpcError(-32601,'Unimplemented');
 }
}

// In-memory object catalog, user placements and libraries for the mock daemon (IPC 0.22,
// RFC-0011 P1). Development simulation only: a fixture catalog (or a real user folder),
// box-level placement rules against the mock's zones and obstacles, nothing persisted.
// With `characters` (a 0.23 listener, RFC-0011 P2) the fixture world also has authored
// characters and user characters live among the placements; mock-npcs.ts drives them.
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RpcError} from './client.js';
import {validateObject,validateLibrary,USER_FOLDER_OBJECTS,type ObjectManifest} from './object.js';
import {objectFormats} from './validation.js';
import type {Ipc22_CatalogEntry,Ipc22_ObjectBounds,Ipc22_LibraryRecord,Ipc22_ObjectPocketItem,Ipc22_ObjectPose,Ipc22_ObjectRule,
 Ipc22_ObjectsState,Ipc22_ObjectTraitName,Ipc23_ObjectInstance,Ipc23_ObjectsState,Ipc23_NpcActivity,World09_InstanceInteraction} from './generated.js';

/** Grant per 0.22 method (RFC-0011 P1): reads need state.read, every change objects.control. */
export const OBJECT_REQUIREMENTS={
 'objects.catalog':'state.read','objects.pocket':'objects.control','objects.place':'objects.control','objects.transform':'objects.control',
 'objects.remove':'objects.control','objects.hide':'objects.control','objects.reset':'objects.control','objects.configure':'objects.control',
 'libraries.list':'state.read','libraries.install':'objects.control','libraries.remove':'objects.control'
} as const;
/** User-placement limits per world (RFC-0011 "Budgets and limits"). */
export const OBJECT_LIMITS:Ipc22_ObjectsState['limits']={placements:128,assets:32,triangles:400_000,gpuBytes:201_326_592,collisionTriangles:10_000};
/** Traits a P1 placement may carry; seat anchors and machine are inert (the static body places). */
export const PLACEABLE_TRAITS:readonly string[]=['decorative','collidable','movable','seat','machine'];
export const REASONS={
 character:'character: user characters arrive with routes (RFC-0011 P2)',
 mover:'mover: tracks and items need world format 0.10 (RFC-0011 P3)',
 notMovable:'not movable: only objects with the movable trait can be placed'
} as const;
const POCKET_MAX=16,SCAN_MS=1000;

type Entry=Ipc22_CatalogEntry;
type Pose=Ipc22_ObjectPose;
type Vec3=[number,number,number];
type Box={min:number[];max:number[]};
/** `since`: the first protocol that receives the notice (default the object catalog's 0.22). */
export type Notice={level:'info'|'warning'|'error';code:string;message:string;since?:string};
export interface ObjectWorld {id:string|null;active:boolean;zones:Array<{id:string;bounds:Box}>;obstacles:Box[];position:number[];orientation:number[]}
export interface ObjectCall {result?:Record<string,unknown>;changed:boolean;notices:Notice[];revision?:'state'|'catalog'|'none'}

/** P1 placeability of a catalog entry (contract order: invalid, character, mover, not movable, format). */
export function placeability(e:Pick<Entry,'state'|'traits'|'formatVersion'|'errors'>):{placeable:boolean;reason:string|null} {
 const no=(reason:string)=>({placeable:false,reason:reason.slice(0,512)});
 if(e.state!=='ready') return no('invalid: '+(e.errors[0] || 'the object did not validate'));
 if(e.traits.includes('character')) return no(REASONS.character);
 if(e.traits.includes('mover')) return no(REASONS.mover);
 if(!e.traits.includes('movable')) return no(REASONS.notMovable);
 const other=e.traits.find(t=>!PLACEABLE_TRAITS.includes(t));
 if(other) return no(`invalid: traits.${other}: not placeable in P1`);
 if(e.formatVersion!==null && !objectFormats.includes(e.formatVersion)) return no(`invalid: object format ${e.formatVersion} is not supported`);
 return {placeable:true,reason:null};
}
function entry(e:Partial<Entry> & Pick<Entry,'ref'|'source'|'id'|'name'|'category'>):Entry {
 const base:Entry={version:null,formatVersion:null,description:null,tags:[],traits:[],surfaces:null,scale:null,bounds:null,triangles:null,gpuBytes:null,
  collisionTriangles:null,thumbnail:null,license:null,library:null,versions:[],state:'ready',placeable:false,reason:null,errors:[],...e};
 return {...base,...placeability(base)};
}
/** A catalog entry from a checked object manifest (user folder or library). */
export function manifestEntry(m:ObjectManifest,ref:string,source:'library'|'user',extra:Partial<Entry>={}):Entry {
 const traits=m.traits as Record<string,any>,movable=traits.movable;
 return entry({ref,source,id:m.id,version:m.version,formatVersion:m.formatVersion,name:m.name,description:m.description ?? null,category:m.category,tags:m.tags || [],
  traits:Object.keys(traits) as Ipc22_ObjectTraitName[],surfaces:movable?movable.surfaces || ['floor']:null,scale:movable?movable.scale || [1,1]:null,
  bounds:structuredClone(m.bounds),license:m.license,...extra});
}

// ---- fixtures ----
const lib='com.hyprune.starter',libVersion='0.1.0',libKey=`${lib}@${libVersion}`;
const box=(w:number,h:number,d:number,wall=false):Ipc22_ObjectBounds=>({min:[-w/2,0,wall?0:-d/2],max:[w/2,h,wall?d:d/2]});
const starter=(id:string,name:string,e:Partial<Entry>)=>entry({ref:`library/${libKey}/${id}`,source:'library',id,name,category:'other',version:'1.0.0',formatVersion:'0.9',
 license:'CC0-1.0',library:libKey,...e});
const FIXTURE_LIBRARY:Entry[]=[
 starter('server-rack','Server rack',{category:'machines',formatVersion:'0.10',tags:['rack'],traits:['decorative','collidable','movable','machine'],surfaces:['floor'],scale:[1,1],
  bounds:box(1.24,2.16,1.3),triangles:4210,gpuBytes:1_048_576,collisionTriangles:12}),
 starter('street-lantern','Street lantern',{category:'lighting',tags:['lamp','street'],traits:['decorative','collidable','movable'],surfaces:['floor'],scale:[0.75,1.5],
  bounds:box(0.5,2.4,0.5),triangles:1800,gpuBytes:786_432,collisionTriangles:12}),
 starter('wall-clock','Wall clock',{category:'decor',traits:['decorative','movable'],surfaces:['wall'],scale:[0.5,2],bounds:box(0.4,0.4,0.06,true),triangles:640,gpuBytes:262_144}),
 starter('guide','Guide',{category:'characters',traits:['character'],bounds:box(0.6,1.8,0.4),triangles:12_000,gpuBytes:4_194_304}),
 starter('mine-cart','Mine cart',{category:'vehicles',formatVersion:'0.10',traits:['decorative','mover'],bounds:box(1,1.1,1.6),triangles:2000,gpuBytes:524_288})
];
const FIXTURE_USER:Entry[]=[
 entry({ref:'user/desk-plant',source:'user',id:'desk-plant',name:'Desk plant',category:'plants',version:'1.0.0',formatVersion:'0.9',traits:['decorative','movable'],
  surfaces:['floor'],scale:[0.5,2],bounds:box(0.3,0.5,0.3),triangles:900,gpuBytes:131_072,license:'CC0-1.0'}),
 entry({ref:'user/broken-lamp',source:'user',id:'broken-lamp',name:'broken-lamp',category:'other',state:'invalid',errors:['bounds: min y must be 0 (the base at the origin), is 0.1']})
];
/** A character's binding and settings (RFC-0011 P2): authored from the world, user ones from npcs.spawn/bind. */
export interface CharacterData {path:string|null;phase:number;speed:number;accent:Vec3|null;reverse:boolean;disabled:boolean;interactions:World09_InstanceInteraction[]}
export interface Authored {id:string;asset:string;areaId:string;pose:Pose;scale:number;movable:boolean;locked?:boolean;npc?:CharacterData}
const FIXTURE_WORLDS:Record<string,{assets:Entry[];objects:Authored[]}>={
 'com.hyprune.observatory':{
  assets:[
   entry({ref:'package/armillary',source:'package',id:'armillary',name:'Armillary',category:'decor',traits:['decorative'],bounds:box(1.2,1.8,1.2),triangles:3200,gpuBytes:2_097_152}),
   entry({ref:'package/reading-chair',source:'package',id:'reading-chair',name:'Reading chair',category:'furniture',formatVersion:'0.9',version:'1.0.0',
    traits:['decorative','collidable','movable'],surfaces:['floor'],scale:[0.75,1.25],bounds:box(0.8,1,0.8),triangles:2400,gpuBytes:1_048_576,collisionTriangles:24})],
  objects:[
   {id:'observatory-armillary',asset:'armillary',areaId:'gallery',pose:{position:[8,0,-2],rotation:[0,0,0,1]},scale:1,movable:false},
   {id:'reading-chair',asset:'reading-chair',areaId:'work',pose:{position:[-2,0,-4],rotation:[0,0.7071068,0,0.7071068]},scale:1,movable:true}]
 }
};
/** A world 0.9 package path of a fixture world (paths.list source package). */
export interface PackagePath {id:string;name:string|null;use:'route'|'track'|'generic';closed:boolean;points:Array<{position:Vec3;type:'line'|'curve'|'arc'}>;speed:number|null;
 stops:Array<{point:number;seconds?:number;clip?:'look_around'|'wave'|'nod'|'idle_fidget'}>}
const npc=(e:Partial<CharacterData>):CharacterData=>({path:null,phase:0,speed:1,accent:null,reverse:false,disabled:false,interactions:[],...e});
/** The 0.23 additions to the fixture worlds: a package character asset, two authored characters and package paths. */
export const FIXTURE_CHARACTERS:Record<string,{assets:Entry[];objects:Authored[];paths:PackagePath[]}>={
 'com.hyprune.observatory':{
  assets:['Keeper','Astronomer'].map(name=>entry({ref:`package/${name.toLowerCase()}`,source:'package',id:name.toLowerCase(),name,category:'characters',formatVersion:'0.9',
   version:'1.0.0',traits:['character'],bounds:box(0.6,1.8,0.4),triangles:12_000,gpuBytes:4_194_304})),
  objects:[
   {id:'keeper',asset:'keeper',areaId:'gallery',pose:{position:[5,0,-5],rotation:[0,0,0,1]},scale:1,movable:false,npc:npc({path:'package/gallery-loop',interactions:[
    {id:'chat',label:'Talk',prompt:'Talk to the keeper',action:{type:'say',lines:['Welcome to the gallery.','The armillary turns once a minute.','Mind the steps on your way out.']}},
    {id:'desk',label:'Where is my desk?',action:{type:'waypoint',target:{zoneId:'work'}}}]})},
   {id:'astronomer',asset:'astronomer',areaId:'work',pose:{position:[-1,0,-2],rotation:[0,0,0,1]},scale:1,movable:false,npc:npc({accent:[0.2,0.4,0.9],interactions:[
    {id:'hello',label:'Say hello',action:{type:'say',lines:['Clear skies tonight.','Ask the keeper about the gallery.']}}]})}],
  paths:[
   {id:'gallery-loop',name:'Gallery loop',use:'route',closed:true,speed:null,stops:[{point:1,seconds:4,clip:'look_around'}],
    points:[{position:[5,0,-5],type:'line'},{position:[11,0,-5],type:'line'},{position:[11,0,1],type:'curve'},{position:[5,0,1],type:'line'}]},
   {id:'survey-line',name:null,use:'generic',closed:false,speed:null,stops:[],points:[{position:[-3,0,-5],type:'line'},{position:[3,0,-5],type:'line'}]}]
 }
};

// ---- helpers ----
const semver=(v:string)=>{const [core,pre]=v.split('+')[0].split(/-(.*)/s);return {parts:core.split('.').map(Number),pre:pre ?? null};};
/** SemVer precedence (numeric parts, then a release above its prereleases). */
export function compareVersions(a:string,b:string):number {
 const x=semver(a),y=semver(b);for(let i=0;i<3;i++) if(x.parts[i]!==y.parts[i]) return x.parts[i]-y.parts[i];
 if(x.pre===y.pre) return 0;if(x.pre===null) return 1;if(y.pre===null) return -1;return x.pre<y.pre?-1:1;
}
const rotate=(q:number[],v:number[]):Vec3=>{
 const [x,y,z,w]=q,[vx,vy,vz]=v,tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);
 return [vx+w*tx+(y*tz-z*ty),vy+w*ty+(z*tx-x*tz),vz+w*tz+(x*ty-y*tx)];
};
const yawQuat=(yaw:number):[number,number,number,number]=>[0,Math.sin(yaw/2),0,Math.cos(yaw/2)];
/** The yaw (about +Y) that turns +Z into the quaternion's +Z, projected on the floor. */
const yawOf=(q:number[])=>{const f=rotate(q,[0,0,1]);return Math.hypot(f[0],f[2])<1e-6?0:Math.atan2(f[0],f[2]);};
const round=(n:number)=>Math.round(n*1e6)/1e6;
const inside=(b:Box,p:number[],grow=0)=>p.every((v,i)=>v>=b.min[i]-grow && v<=b.max[i]+grow);
const overlap=(a:Box,b:Box)=>[0,1,2].every(i=>a.min[i]<b.max[i] && a.max[i]>b.min[i]);

export interface Placement {id:string;ref:string;areaId:string;pose:Pose;scale:number;locked:boolean;npc?:CharacterData}
interface Override {pose?:Pose;scale?:number;hidden?:boolean;locked?:boolean}
/** A character's moment-to-moment state from the NPC engine (a route pose, the activity). */
export interface CharacterLive {pose?:Pose;activity:Ipc23_NpcActivity|null}
/** Refused for characters by objects.transform/configure/pocket/reset (RFC-0011 P2). */
export const PROTECTED='characters are protected';
interface Library extends Ipc22_LibraryRecord {entries:Entry[]}

export class ObjectEngine {
 catalogRevision=0;
 private libraries:Library[]=[{id:lib,version:libVersion,name:'Hyprune starter kit',formatVersion:'0.10',objects:FIXTURE_LIBRARY.length,root:'system',state:'ready',errors:[],
  digest:createHash('sha256').update(libKey).digest('hex'),entries:FIXTURE_LIBRARY}];
 private user:Entry[];
 private placements=new Map<string,Placement[]>();private overrides=new Map<string,Map<string,Override>>();
 private pocketItems:Ipc22_ObjectPocketItem[]=[];private pocketCounter=0;
 private scanned=new Map<string,{fingerprint:string;entry:Entry}>();private lastScan=0;private scanning?:Promise<boolean>;
 /** Character poses and activities, supplied by the NPC engine of a 0.23 listener. */
 live?:(worldId:string,id:string)=>CharacterLive|undefined;
 /**
  * world: the mock's loaded world, zones, obstacles and player pose; objectDir: a user folder to list
  * instead of the fixture; characters: the 0.23 fixture characters and character placements.
  */
 constructor(private readonly world:()=>ObjectWorld,readonly options:{objectDir?:string;characters?:boolean}={}) {this.user=options.objectDir?[]:structuredClone(FIXTURE_USER);}

 // ---- state ----
 /** The 0.23 objects state; older projections drop the character fields (mock.ts). */
 state():Ipc23_ObjectsState {
  const w=this.world(),placements=w.id?this.placements.get(w.id) || []:[];
  const instances=[...this.authoredInstances(w.id),...placements.map(p=>this.instance(w.id!,p))].slice(0,512);
  return {catalogRevision:this.catalogRevision,instances,pocket:structuredClone(this.pocketItems),usage:this.usage(placements),limits:{...OBJECT_LIMITS}};
 }
 get pocket():Ipc22_ObjectPocketItem[] {return structuredClone(this.pocketItems);}
 /** Authored objects of a fixture world, with its characters on a characters listener. */
 authoredOf(worldId:string|null):Authored[] {
  if(!worldId) return [];
  return [...(FIXTURE_WORLDS[worldId]?.objects || []),...(this.options.characters?FIXTURE_CHARACTERS[worldId]?.objects || []:[])];
 }
 /** User placements (and user characters) of a world; the array is live. */
 placementsOf(worldId:string):Placement[] {let list=this.placements.get(worldId);if(!list) this.placements.set(worldId,list=[]);return list;}
 private packageAssets(worldId:string|null):Entry[] {
  if(!worldId) return [];
  return [...(FIXTURE_WORLDS[worldId]?.assets || []),...(this.options.characters?FIXTURE_CHARACTERS[worldId]?.assets || []:[])];
 }
 private characterFields(worldId:string,id:string,c:CharacterData|undefined,hidden:boolean,pose:Pose):Pick<Ipc23_ObjectInstance,'pose'|'path'|'activity'|'seat'|'character'|'accent'> {
  if(!c) return {pose:structuredClone(pose),path:null,activity:null,seat:null,character:false,accent:null};
  const live=hidden?undefined:this.live?.(worldId,id);
  return {pose:structuredClone(live?.pose || pose),path:c.path,activity:live?.activity ?? null,seat:null,character:true,accent:c.accent?[...c.accent] as Vec3:null};
 }
 private authoredInstances(worldId:string|null):Ipc23_ObjectInstance[] {
  if(!worldId) return [];
  const overrides=this.overrides.get(worldId) || new Map<string,Override>(),assets=this.packageAssets(worldId);
  return this.authoredOf(worldId).map(o=>{
   const over=overrides.get(o.id) || {},asset=assets.find(a=>a.id===o.asset),hidden=!!over.hidden;
   return {id:o.id,source:'authored',ref:`package/${o.asset}`,name:(asset?.name || o.asset).slice(0,64),areaId:o.areaId,scale:over.scale ?? o.scale,
    state:hidden?'hidden':'active',movable:o.movable,locked:over.locked ?? o.locked ?? false,rule:null,...this.characterFields(worldId,o.id,o.npc,hidden,over.pose || o.pose)};
  });
 }
 private instance(worldId:string,p:Placement):Ipc23_ObjectInstance {
  const e=this.resolve(p.ref),ready=e?.state==='ready',hidden=!!p.npc?.disabled;
  return {id:p.id,source:'user',ref:p.ref,name:(e?.name || p.ref.slice(p.ref.lastIndexOf('/')+1)).slice(0,64),areaId:p.areaId,scale:p.scale,
   state:!ready?'missing':hidden?'hidden':'active',movable:ready && !p.npc,locked:p.locked,rule:null,...this.characterFields(worldId,p.id,p.npc,hidden || !ready,p.pose)};
 }
 private usage(placements:Placement[]):Ipc22_ObjectsState['usage'] {
  const refs=new Set<string>();let triangles=0,gpuBytes=0,collisionTriangles=0;
  for(const p of placements){
   const e=this.resolve(p.ref);if(!e || e.state!=='ready') continue;
   triangles+=e.triangles || 0;collisionTriangles+=e.collisionTriangles || 0;
   if(!refs.has(p.ref)){refs.add(p.ref);gpuBytes+=e.gpuBytes || 0;}
  }
  return {placements:placements.length,assets:refs.size,triangles,gpuBytes,collisionTriangles};
 }

 // ---- catalog ----
 /** Every resolvable entry: this world's package assets, every installed library version, the user folder. */
 private all():Entry[] {
  const w=this.world();
  return [...this.packageAssets(w.id),...this.libraries.filter(l=>l.state==='ready').flatMap(l=>l.entries),...this.user];
 }
 resolve(ref:string):Entry|undefined {return this.all().find(e=>e.ref===ref);}
 /** The catalog: library objects at their highest installed version, the others in `versions`. */
 catalog():Entry[] {
  const out:Entry[]=[],seen=new Map<string,Entry>();
  for(const e of this.all()){
   if(e.source!=='library'){out.push(structuredClone(e));continue;}
   const key=`${e.library!.split('@')[0]}/${e.id}`,prior=seen.get(key);
   if(!prior){const copy={...structuredClone(e),versions:[]};seen.set(key,copy);out.push(copy);continue;}
   const version=e.library!.split('@')[1],priorVersion=prior.library!.split('@')[1];
   if(compareVersions(version,priorVersion)>0){const copy={...structuredClone(e),versions:[...prior.versions,priorVersion]};out[out.indexOf(prior)]=copy;seen.set(key,copy);}
   else prior.versions.push(version);
  }
  for(const e of out) e.versions=e.versions.sort(compareVersions).reverse().slice(0,16);
  return out.slice(0,1024);
 }
 libraryList():Ipc22_LibraryRecord[] {return this.libraries.map(({entries,...record})=>structuredClone(record));}
 private fingerprint(dir:string):string {
  const parts:string[]=[];
  const walk=(path:string,rel:string,depth:number)=>{
   if(depth>8 || parts.length>256) return;
   for(const name of readdirSync(path).sort()){const st=lstatSync(join(path,name));parts.push(`${rel}${name}:${st.size}:${st.mtimeMs}:${st.mode}`);if(st.isDirectory()) walk(join(path,name),`${rel}${name}/`,depth+1);}
  };
  walk(dir,'',0);return parts.join('\n');
 }
 /** Rescan the user folder (directories only, dot entries skipped, cached by a stat fingerprint); true when the catalog changed. */
 scan():Promise<boolean> {
  const root=this.options.objectDir;if(!root) return Promise.resolve(false);
  if(this.scanning) return this.scanning;
  this.lastScan=Date.now();
  this.scanning=(async()=>{
   const names=existsSync(root)?readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory() && /^[a-z][a-z0-9-]{0,63}$/.test(d.name)).map(d=>d.name).sort().slice(0,USER_FOLDER_OBJECTS):[];
   const next:Entry[]=[];
   for(const name of names){
    const dir=join(root,name);let fingerprint:string;
    try{fingerprint=this.fingerprint(dir);}catch{continue;}
    const cached=this.scanned.get(name);
    if(cached?.fingerprint===fingerprint){next.push(cached.entry);continue;}
    let e:Entry;
    try{
     const check=await validateObject(dir);
     e=manifestEntry(check.manifest,`user/${name}`,'user',{triangles:check.triangles ?? null,gpuBytes:check.measured.gpuBytes,
      thumbnail:check.manifest.thumbnail?join(dir,check.manifest.thumbnail):null});
    }catch(error:any){
     const errors=String(error.message).split('\n').filter(Boolean).slice(0,8).map(m=>m.slice(0,512));
     e=entry({ref:`user/${name}`,source:'user',id:name,name,category:'other',state:'invalid',errors:errors.length?errors:['invalid object']});
    }
    this.scanned.set(name,{fingerprint,entry:e});next.push(e);
   }
   for(const name of [...this.scanned.keys()]) if(!names.includes(name)) this.scanned.delete(name);
   const changed=JSON.stringify(next)!==JSON.stringify(this.user);
   if(changed){this.user=next;this.catalogRevision++;}
   return changed;
  })().finally(()=>{this.scanning=undefined;});
  return this.scanning;
 }
 /** Periodic work: the user-folder watch (1 s quiet period stands in for inotify). */
 async tick():Promise<boolean> {return this.options.objectDir && Date.now()-this.lastScan>=SCAN_MS?this.scan():false;}

 // ---- rules ----
 private shape(e:Entry,pose:Pose,scale:number):Box {
  const b=e.bounds || {min:[-0.25,0,-0.25],max:[0.25,0.5,0.25]},lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let k=0;k<8;k++){
   const corner=[k&1?b.max[0]:b.min[0],k&2?b.max[1]:b.min[1],k&4?b.max[2]:b.min[2]].map(v=>v*scale),w=rotate(pose.rotation,corner);
   for(let j=0;j<3;j++){lo[j]=Math.min(lo[j],w[j]+pose.position[j]+0.02);hi[j]=Math.max(hi[j],w[j]+pose.position[j]-0.02);}
  }
  return {min:lo,max:hi};
 }
 /** The mock's placement rules, in contract order: playable, walls, support (floor), player. */
 rule(e:Entry,pose:Pose,scale:number):Ipc22_ObjectRule|null {
  const w=this.world(),shape=this.shape(e,pose,scale),p=pose.position;
  if(w.zones.length && !w.zones.some(z=>inside(z.bounds,p,0.001))) return 'playable';
  if(w.obstacles.some(o=>overlap(o,shape))) return 'walls';
  if(e.surfaces?.length===1 && e.surfaces[0]==='floor' && w.zones.length && !w.zones.some(z=>inside(z.bounds,p,0.001) && p[1]-z.bounds.min[1]>=-0.02 && p[1]-z.bounds.min[1]<=0.05)) return 'support';
  if(e.traits.includes('collidable')){
   const eye=w.position,capsule={min:[eye[0]-0.3,eye[1]-1.7,eye[2]-0.3],max:[eye[0]+0.3,eye[1]+0.2,eye[2]+0.3]};
   if(overlap(capsule,shape)) return 'player';
  }
  return null;
 }
 refuse(rule:string,detail:string):never {throw new RpcError(-32007,`${rule}: ${detail}`,{retryable:false,rule});}
 checkPose(pose:Pose):void {
  const n=Math.hypot(...pose.rotation);if(Math.abs(n-1)>0.002) throw new RpcError(-32602,'pose.rotation must be a unit quaternion (within 0.002)');
 }
 private checkScale(e:Entry,scale:number):void {
  const [lo,hi]=e.scale || [1,1];if(scale<lo-1e-9 || scale>hi+1e-9) throw new RpcError(-32602,`scale ${scale} is outside the object's range ${lo}..${hi}`);
 }
 areaOf(p:number[]):string {return this.world().zones.find(z=>inside(z.bounds,p,0.001))?.id || '';}
 /** Without a pose: in front of the player at 2 m, then 1.5 m and 1 m, facing the player; floor objects on the zone floor. */
 spawnPose(e:Entry,scale:number):Pose {
  const w=this.world(),f=rotate(w.orientation,[0,0,-1]),len=Math.hypot(f[0],f[2]) || 1,dir=[f[0]/len,f[2]/len];
  const rotation=yawQuat(Math.atan2(-dir[0],-dir[1])).map(round) as Pose["rotation"];let last:Ipc22_ObjectRule='playable';
  for(const distance of [2,1.5,1]){
   const x=w.position[0]+dir[0]*distance,z=w.position[2]+dir[1]*distance;
   const zone=w.zones.find(zn=>x>=zn.bounds.min[0] && x<=zn.bounds.max[0] && z>=zn.bounds.min[2] && z<=zn.bounds.max[2]);
   const floor=e.surfaces?.includes('floor') || !e.surfaces;
   const y=floor?(zone?zone.bounds.min[1]:w.position[1]-1.7):w.position[1]-0.5;
   const pose={position:[round(x),round(y),round(z)] as Vec3,rotation};
   const rule=this.rule(e,pose,scale);if(!rule) return pose;last=rule;
  }
  this.refuse(last,'no free spot in front of the player');
 }
 requireWorld():ObjectWorld & {id:string} {
  const w=this.world();if(!w.id || !w.active) throw new RpcError(-32005,'exploration inactive: load a world first');return w as ObjectWorld & {id:string};
 }
 private placeable(ref:string):Entry {
  const e=this.resolve(ref);if(!e) throw new RpcError(-32004,`unknown object ${ref}`);
  if(!e.placeable){
   if(e.reason?.startsWith('budget:')) throw new RpcError(-32008,e.reason,{retryable:false,rule:'budget'});
   throw new RpcError(-32005,e.reason || 'not placeable');
  }
  return e;
 }
 budget(placements:Placement[]):void {
  const usage=this.usage(placements);
  for(const key of Object.keys(OBJECT_LIMITS) as Array<keyof typeof OBJECT_LIMITS>)
   if(usage[key]>OBJECT_LIMITS[key]) throw new RpcError(-32008,`budget: ${key} would be ${usage[key]}, the limit is ${OBJECT_LIMITS[key]}`,{retryable:false,rule:'budget'});
 }
 find(worldId:string,id:string):{placement?:Placement;authored?:Authored} {
  const placement=(this.placements.get(worldId) || []).find(p=>p.id===id);if(placement) return {placement};
  const authored=this.authoredOf(worldId).find(o=>o.id===id);if(authored) return {authored};
  throw new RpcError(-32004,`unknown object instance ${id}`);
 }
 /** A fresh u-xxxxxx id, unique among this world's placements and authored objects. */
 newId(worldId:string):string {
  const list=this.placements.get(worldId) || [];let id:string;
  do id='u-'+randomBytes(3).toString('hex');while(list.some(p=>p.id===id) || this.authoredOf(worldId).some(o=>o.id===id));
  return id;
 }
 /** Whether an authored character is disabled (the objects.hide override). */
 authoredHidden(worldId:string,id:string):boolean {return !!this.overrides.get(worldId)?.get(id)?.hidden;}
 setAuthoredHidden(worldId:string,id:string,hidden:boolean):void {this.override(worldId,id).hidden=hidden;}
 private isCharacter(found:{placement?:Placement;authored?:Authored}):boolean {return !!(found.placement?.npc || found.authored?.npc);}
 private protectedCharacter(found:{placement?:Placement;authored?:Authored}):void {
  if(this.isCharacter(found)) throw new RpcError(-32005,`${PROTECTED}: ${(found.placement || found.authored)!.id} is a character`);
 }
 override(worldId:string,id:string):Override {
  let map=this.overrides.get(worldId);if(!map) this.overrides.set(worldId,map=new Map());
  let o=map.get(id);if(!o) map.set(id,o={});return o;
 }
 private authoredLocked(worldId:string,a:Authored):boolean {return this.overrides.get(worldId)?.get(a.id)?.locked ?? a.locked ?? false;}

 // ---- methods ----
 async execute(method:string,params:any):Promise<ObjectCall> {
  const notices:Notice[]=[];
  switch(method){
   case 'objects.catalog':{await this.scan();return {result:{entries:this.catalog()},changed:false,notices,revision:'catalog'};}
   case 'libraries.list':return {result:{libraries:this.libraryList()},changed:false,notices,revision:'none'};
   case 'objects.pocket':{
    if(this.options.characters && this.resolve(params.ref)?.traits.includes('character')) throw new RpcError(-32005,`${PROTECTED}: ${params.ref} is a character`);
    const e=this.placeable(params.ref);
    if(this.pocketItems.length>=POCKET_MAX) throw new RpcError(-32008,`budget: the pocket holds at most ${POCKET_MAX} objects`,{retryable:false,rule:'budget'});
    const itemId=`pocket-${++this.pocketCounter}`;this.pocketItems.push({itemId,ref:e.ref,name:e.name});
    notices.push({level:'info',code:'placement.pocketed',message:`${e.name} is in the pocket`});
    return {result:{itemId},changed:true,notices};
   }
   case 'objects.place':{
    if(this.options.characters && this.resolve(params.ref)?.traits.includes('character')) throw new RpcError(-32005,`character: use npcs.spawn for ${params.ref}`);
    const w=this.requireWorld(),e=this.placeable(params.ref),scale=params.scale ?? 1;this.checkScale(e,scale);
    if(params.pose) this.checkPose(params.pose);
    const list=this.placements.get(w.id) || [],id=this.newId(w.id);
    const pose:Pose=params.pose?structuredClone(params.pose):this.spawnPose(e,scale);
    const placement:Placement={id,ref:e.ref,areaId:this.areaOf(pose.position),pose,scale,locked:false};
    this.budget([...list,placement]);
    if(params.pose){const rule=this.rule(e,pose,scale);if(rule) this.refuse(rule,`${e.name} cannot go there`);}
    this.placements.set(w.id,[...list,placement]);
    // Placing a ref that is in the pocket uses that pocket item (the mock has no tool 5).
    const item=this.pocketItems.findIndex(i=>i.ref===e.ref);if(item>=0) this.pocketItems.splice(item,1);
    notices.push({level:'info',code:'object.placed',message:`${e.name} placed`});
    return {result:{id},changed:true,notices};
   }
   case 'objects.transform':{
    const w=this.requireWorld(),found=this.find(w.id,params.id),{placement,authored}=found;this.protectedCharacter(found);this.checkPose(params.pose);
    if(placement){
     if(placement.locked) throw new RpcError(-32005,`locked: ${placement.id} is locked`);
     const e=this.resolve(placement.ref);if(!e || e.state!=='ready') throw new RpcError(-32005,`not movable: ${placement.id} is missing its object`);
     const scale=params.scale ?? placement.scale;this.checkScale(e,scale);
     const rule=this.rule(e,params.pose,scale);if(rule) this.refuse(rule,`${e.name} cannot go there`);
     Object.assign(placement,{pose:structuredClone(params.pose),scale,areaId:this.areaOf(params.pose.position)});
    }else{
     const a=authored!;if(!a.movable) throw new RpcError(-32005,`not movable: ${a.id} is not movable`);
     if(this.authoredLocked(w.id,a)) throw new RpcError(-32005,`locked: ${a.id} is locked`);
     const e=this.resolve(`package/${a.asset}`)!,scale=params.scale ?? this.overrides.get(w.id)?.get(a.id)?.scale ?? a.scale;this.checkScale(e,scale);
     const rule=this.rule(e,params.pose,scale);if(rule) this.refuse(rule,`${e.name} cannot go there`);
     Object.assign(this.override(w.id,a.id),{pose:structuredClone(params.pose),scale});
    }
    return {changed:true,notices};
   }
   case 'objects.remove':{
    const w=this.requireWorld(),list=this.placements.get(w.id) || [];
    if(params.all){this.placements.set(w.id,[]);notices.push({level:'info',code:'object.removed',message:`${list.length} objects removed`});return {changed:list.length>0,notices};}
    const {placement,authored}=this.find(w.id,params.id);
    if(authored) throw new RpcError(-32005,`protected: ${authored.id} belongs to the world; ${authored.npc?'disable':'hide'} it instead`);
    // A user character: the same as npcs.remove.
    if(placement!.npc){this.placements.set(w.id,list.filter(p=>p!==placement));notices.push({level:'info',code:'npc.removed',message:`${placement!.id} removed`,since:'0.23'});return {changed:true,notices};}
    if(placement!.locked) throw new RpcError(-32005,`locked: ${placement!.id} is locked`);
    this.placements.set(w.id,list.filter(p=>p!==placement));notices.push({level:'info',code:'object.removed',message:`${placement!.id} removed`});
    return {changed:true,notices};
   }
   case 'objects.hide':{
    const w=this.requireWorld(),{placement,authored}=this.find(w.id,params.id);
    if(placement) throw new RpcError(-32005,`not movable: ${placement.id} is a user placement; ${placement.npc?'disable or ':''}remove it instead`);
    // An authored character: the same as npcs.disable.
    if(authored!.npc){
     const was=this.authoredHidden(w.id,authored!.id);this.setAuthoredHidden(w.id,authored!.id,params.hidden);
     if(was!==params.hidden) notices.push({level:'info',code:params.hidden?'npc.disabled':'npc.enabled',message:`${authored!.id} ${params.hidden?'disabled':'enabled'}`,since:'0.23'});
     return {changed:was!==params.hidden,notices};
    }
    if(!authored!.movable) throw new RpcError(-32005,`not movable: ${authored!.id} is not movable`);
    if(this.authoredLocked(w.id,authored!)) throw new RpcError(-32005,`locked: ${authored!.id} is locked`);
    this.override(w.id,authored!.id).hidden=params.hidden;return {changed:true,notices};
   }
   case 'objects.reset':{
    const w=this.requireWorld();
    if(params.all){const had=(this.overrides.get(w.id)?.size || 0)>0;this.overrides.delete(w.id);return {changed:had,notices};}
    const found=this.find(w.id,params.id),{placement,authored}=found;
    if(authored){this.overrides.get(w.id)?.delete(authored.id);return {changed:true,notices};}
    this.protectedCharacter(found);
    const p=placement!;if(p.locked) throw new RpcError(-32005,`locked: ${p.id} is locked`);
    const e=this.resolve(p.ref);if(!e || e.state!=='ready') throw new RpcError(-32005,`not movable: ${p.id} is missing its object`);
    const pose={position:p.pose.position,rotation:yawQuat(yawOf(p.pose.rotation)).map(round)} as Pose;
    const rule=this.rule(e,pose,1);if(rule) this.refuse(rule,`${e.name} cannot stand upright there`);
    Object.assign(p,{pose,scale:1});return {changed:true,notices};
   }
   case 'objects.configure':{
    const w=this.requireWorld(),found=this.find(w.id,params.id),{placement,authored}=found;this.protectedCharacter(found);
    if(params.patch.locked!==undefined){if(placement) placement.locked=params.patch.locked;else this.override(w.id,authored!.id).locked=params.patch.locked;}
    return {changed:true,notices};
   }
   case 'libraries.install':return this.install(params.archive,params.sha256);
   case 'libraries.remove':{
    const index=this.libraries.findIndex(l=>l.id===params.id && l.version===params.version);
    if(index<0) throw new RpcError(-32004,`unknown library ${params.id}@${params.version}`);
    if(this.libraries[index].root!=='user') throw new RpcError(-32005,`system library: ${params.id}@${params.version} is installed read-only`);
    this.libraries.splice(index,1);this.catalogRevision++;
    notices.push(...this.substitute(params.id,params.version));
    return {changed:true,notices};
   }
  }
  throw new RpcError(-32601,'Unimplemented');
 }
 /** Placements of a removed library version fall back to the highest installed version with the same major, else read missing. */
 private substitute(id:string,version:string):Notice[] {
  const notices:Notice[]=[],prefix=`library/${id}@${version}/`,major=version.split('.')[0];
  for(const list of this.placements.values()) for(const p of list){
   if(!p.ref.startsWith(prefix)) continue;
   const objectId=p.ref.slice(prefix.length);
   const fallback=this.libraries.filter(l=>l.id===id && l.state==='ready' && l.version.split('.')[0]===major && l.entries.some(e=>e.id===objectId))
    .sort((a,b)=>compareVersions(b.version,a.version))[0];
   if(fallback){p.ref=`library/${id}@${fallback.version}/${objectId}`;notices.push({level:'info',code:'object.substituted',message:`${p.id} now uses ${id}@${fallback.version}`});}
   else notices.push({level:'warning',code:'object.missing',message:`${p.id}: ${id}@${version} is no longer installed`});
  }
  return notices;
 }
 /** libraries.install: hash first, then the RFC-0004 archive rules, then the library validator; nothing is kept on disk. */
 private async install(archive:string,sha256:string):Promise<ObjectCall> {
  let st;try{st=lstatSync(archive);}catch{throw new RpcError(-32602,'archive: no such file');}
  if(st.isSymbolicLink() || !st.isFile()) throw new RpcError(-32602,'archive: not a regular file');
  const actual=createHash('sha256').update(readFileSync(archive)).digest('hex');
  if(actual!==sha256) throw new RpcError(-32602,`sha256 mismatch: the archive hashes to ${actual}`);
  const root=listArchive(archive),staging=mkdtempSync(join(tmpdir(),'hyprune-mock-library-'));
  try{
   try{execFileSync('tar',['--zstd','-xf',archive,'-C',staging,'--no-same-owner','--no-same-permissions'],{stdio:'pipe'});}
   catch{throw new RpcError(-32602,'invalid archive: extraction failed');}
   let check;
   try{check=await validateLibrary(join(staging,root));}catch(e:any){throw new RpcError(-32602,('invalid library: '+String(e.message).split('\n')[0]).slice(0,4096));}
   const {id,version}=check.manifest;
   if(root!==id) throw new RpcError(-32602,`invalid archive: the root directory ${root} is not the library id ${id}`);
   const existing=this.libraries.find(l=>l.id===id && l.version===version);
   if(existing){
    if(existing.digest===check.digest) return {result:{id,version},changed:false,notices:[]};
    throw new RpcError(-32007,`library.conflict: ${id}@${version} is installed with different content`,{retryable:false,rule:'library.conflict'});
   }
   const key=`${id}@${version}`,entries=check.objects.map(o=>{
    const manifest=JSON.parse(readFileSync(join(staging,root,'objects',o.id,'object.json'),'utf8')) as ObjectManifest;
    return manifestEntry(manifest,`library/${key}/${o.id}`,'library',{library:key,triangles:o.triangles ?? null});
   });
   this.libraries.push({id,version,name:check.manifest.name.slice(0,64),formatVersion:check.manifest.formatVersion,objects:entries.length,root:'user',state:'ready',errors:[],digest:check.digest,entries});
   this.catalogRevision++;
   return {result:{id,version},changed:true,notices:[{level:'info',code:'library.installed',message:`${key} installed`}]};
  }finally{rmSync(staging,{recursive:true,force:true});}
 }
}

/** Members of a .tar.zst checked against the RFC-0004 archive rules; returns the single root directory. */
export function listArchive(archive:string):string {
 let listing:string;
 try{listing=execFileSync('tar',['--zstd','-tvf',archive,'--numeric-owner'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024});}
 catch{throw new RpcError(-32602,'invalid archive: not a readable .tar.zst');}
 const lines=listing.split('\n').filter(Boolean),bad=(why:string):never=>{throw new RpcError(-32602,'invalid archive: '+why);};
 if(!lines.length) bad('empty');if(lines.length>4000) bad('more than 4000 members');
 let root:string|undefined,total=0;
 for(const line of lines){
  const m=/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);if(!m) bad('unreadable listing');
  const [,type,size,raw]=m!,name=raw.replace(/\/$/,'');
  if(type!=='-' && type!=='d') bad(`${name}: links and devices are forbidden`);
  if(/[\\%?#:]/.test(name) || name.startsWith('/') || name.split('/').some(p=>!p || p==='.' || p==='..')) bad(`${name}: unsafe path`);
  const top=name.split('/')[0];root??=top;if(top!==root) bad('members must share one root directory');
  if(type==='-' && name===root) bad('the root must be a directory');
  if(Number(size)>32*1048576) bad(`${name}: larger than 32 MiB`);
  total+=Number(size);if(total>512*1048576) bad('more than 512 MiB expanded');
 }
 return root!;
}

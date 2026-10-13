// The companion for the mock daemon (IPC 0.25, RFC-0010 companions amendment, draft).
// Development simulation only: a companion-capable library or user character follows the
// mock player 2 m behind (no walking, planning or view checks), stays at a spot, or stands at
// the start of the route it is bound to. Bindings are per world; nothing is persisted.
import {RpcError} from './client.js';
import type {Ipc25_CompanionState} from './generated.js';
import type {ObjectEngine,Notice} from './mock-objects.js';
import type {NpcEngine} from './mock-npcs.js';

type Vec3=[number,number,number];
type Entry=NonNullable<ReturnType<ObjectEngine['resolve']>>;
export interface CompanionWorld {id:string|null;position:number[];orientation:number[]}
/** The reserved object id of the companion in npcs.bind, paths.draw {bind} and interaction.choose. */
export const COMPANION_ID='companion';
export const COMPANION_REQUIREMENTS={'companion.set':'objects.control','companion.clear':'objects.control','companion.mode':'objects.control'} as const;
/** Mock capability limits (core checks the rig and clips too). */
export const COMPANION_LIMITS={height:2,triangles:20_000,follow:2};
const notice=(code:string,message:string):Notice=>({level:'info',code,message,since:'0.25'});

/** The 0.25 catalog field: null for non-characters, else {capable, name, reason}. */
export function companionOf(e:Entry):{capable:boolean;name:string;reason:string|null}|null {
 if(!e.traits.includes('character')) return null;
 const name=e.name.slice(0,32);
 const reason=e.source==='package'?'a world resident, not yours to take along'
  :e.bounds && e.bounds.max[1]-e.bounds.min[1]>COMPANION_LIMITS.height+.05?'taller than 2.0 m'
  :(e.triangles ?? 0)>COMPANION_LIMITS.triangles?'more than 20000 triangles':null;
 return {capable:reason===null,name,reason};
}

type ListedPath={ref:string;use:string;walkable:boolean|null;points:Array<{position:number[]}>};
type Binding={path:string;phase:number}|{pose:Vec3};
export class CompanionEngine {
 ref:string|null=null;
 private name:string|null=null;
 private bindings=new Map<string,Binding>();
 private pendingDraw=false;
 constructor(private readonly objects:ObjectEngine,private readonly npcs:NpcEngine,private readonly world:()=>CompanionWorld) {}

 /** The required 0.25 state key. */
 state():Ipc25_CompanionState {
  const none:Ipc25_CompanionState={ref:null,name:null,state:'none',reason:null,mode:'follow',path:null,activity:null,position:null,carried:false};
  if(!this.ref) return none;
  const w=this.world(),e=this.objects.resolve(this.ref),verdict=e && companionOf(e);
  const base={...none,ref:this.ref,name:verdict?.name ?? this.name};
  if(!e || !verdict) return {...base,state:'unavailable',reason:'not installed'};
  if(!verdict.capable) return {...base,state:'unavailable',reason:verdict.reason};
  if(!w.id) return {...base,state:'hidden',reason:'no world'};
  const b=this.bindings.get(w.id);
  if(b && 'path' in b) return {...base,state:'active',mode:'route',path:b.path,activity:'walking',position:this.routePoint(b.path)};
  if(b) return {...base,state:'active',mode:'stay',activity:'idle',position:b.pose};
  return {...base,state:'active',mode:'follow',activity:'idle',position:this.behind(w)};
 }
 /** 2 m behind the player's feet, along their view (y up, -z forward). */
 private behind(w:CompanionWorld):Vec3 {
  const [x,y,z,qw]=w.orientation,f=[-(2*(x*z+qw*y)),0,-(1-2*(x*x+y*y))],len=Math.hypot(f[0],f[2]) || 1;
  const r=(n:number)=>Math.round(n*1000)/1000;
  return [r(w.position[0]-f[0]/len*COMPANION_LIMITS.follow),r(w.position[1]-1.7),r(w.position[2]-f[2]/len*COMPANION_LIMITS.follow)];
 }
 private routePoint(ref:string):Vec3|null {
  const p=this.paths().find(x=>x.ref===ref);
  return p?.points[0]?[...p.points[0].position] as Vec3:null;
 }
 private paths():ListedPath[] {return (this.npcs.execute('paths.list',{}).result?.paths ?? []) as ListedPath[];}
 private requireChosen():void {if(!this.ref) throw new RpcError(-32005,'no companion chosen');}
 private requireWorld():string {const id=this.world().id;if(!id) throw new RpcError(-32005,'no world loaded');return id;}

 /** companion.set/clear/mode. */
 execute(method:string,params:any):{changed:boolean;notices:Notice[]} {
  switch(method){
   case 'companion.set':{
    const e=this.objects.resolve(params.ref);
    if(!e) throw new RpcError(-32004,`unknown ref ${params.ref}`);
    const verdict=companionOf(e);
    if(!verdict) throw new RpcError(-32005,`${e.name} is not a character`);
    if(!verdict.capable) throw new RpcError(-32005,`${e.name} can't be your companion: ${verdict.reason}`);
    const changed=this.ref!==e.ref;this.ref=e.ref;this.name=verdict.name;
    return {changed,notices:[notice('companion.set',`${verdict.name} is your companion`)]};
   }
   case 'companion.clear':{
    if(!this.ref) return {changed:false,notices:[]};
    this.ref=null;this.name=null;
    return {changed:true,notices:[notice('companion.cleared','No companion')]};
   }
   case 'companion.mode':{
    this.requireChosen();const id=this.requireWorld();
    if(params.mode==='follow'){this.bindings.delete(id);return {changed:true,notices:[notice('companion.following',`${this.name} follows you`)]};}
    const at=this.state().position ?? this.behind(this.world());
    this.bindings.set(id,{pose:at});
    return {changed:true,notices:[notice('companion.staying',`${this.name} stays here`)]};
   }
  }
  throw new RpcError(-32601,'Unimplemented');
 }
 /** npcs.bind {id: "companion", path | pose, phase?}: a route of this world or a standing spot. */
 bind(params:any):{changed:boolean;notices:Notice[]} {
  this.requireChosen();const id=this.requireWorld();
  if(params.accent!==undefined) throw new RpcError(-32602,'accent is not for the companion');
  if(params.path!==undefined && params.path!==null){
   const ref=String(params.path).includes('/')?String(params.path):`user/${params.path}`;
   const p=this.paths().find(x=>x.ref===ref);
   if(!p) throw new RpcError(-32004,`unknown path ${ref}`);
   if(p.use!=='route' || p.walkable===false) throw new RpcError(-32007,`walkable: ${ref} is not a walkable route`,{retryable:false,rule:'walkable'});
   this.bindings.set(id,{path:ref,phase:Math.min(.999,Math.max(0,params.phase ?? 0))});
   return {changed:true,notices:[notice('companion.bound',`${this.name} walks this route`)]};
  }
  if(params.pose){this.bindings.set(id,{pose:[...params.pose.position] as Vec3});return {changed:true,notices:[notice('companion.staying',`${this.name} stays here`)]};}
  throw new RpcError(-32602,'name at least one setting');
 }
 /** paths.draw {bind: "companion"}: the draw runs unbound and paths.finish binds the companion. */
 draw():void {this.requireChosen();this.pendingDraw=true;}
 finished(id:string|null):{bound:string|null;notices:Notice[]} {
  if(!this.pendingDraw) return {bound:null,notices:[]};
  this.pendingDraw=false;
  if(!id) return {bound:null,notices:[]};
  try{return {bound:COMPANION_ID,notices:this.bind({path:`user/${id}`}).notices};}
  catch(e){if(e instanceof RpcError) return {bound:null,notices:[{level:'warning',code:'path.unwalkable',message:e.message.slice(0,512),since:'0.25'}]};throw e;}
 }
 /** The bound paths' extra entry for paths.list `bound`. */
 boundTo(ref:string):boolean {const id=this.world().id,b=id?this.bindings.get(id):undefined;return !!this.ref && !!b && 'path' in b && b.path===ref;}
 /** interaction.choose {objectId: "companion"}: stay or follow (talk shows nothing in the mock). */
 choose(interactionId:string|null):{changed:boolean;notices:Notice[]} {
  this.requireChosen();
  if(interactionId==='stay' || interactionId==='follow') return this.execute('companion.mode',{mode:interactionId});
  if(interactionId==='talk' || interactionId===null) return {changed:false,notices:[]};
  throw new RpcError(-32004,`unknown interaction ${interactionId} on companion`);
 }
}

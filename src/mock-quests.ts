// In-memory markers, personal quests and focus sessions for the mock daemon (IPC 0.21,
// RFC-0012 P1). Development simulation only: nothing is persisted, every work second
// credits (wall mode), and markers resolve against the mock's zones and waypoint.
import {randomBytes} from 'node:crypto';
import {RpcError} from './client.js';
import type {Ipc21_State,Ipc21_QuestRef,Ipc21_QuestTarget,Ipc21_PersonalQuestInput,Ipc21_GuidanceConfig,Ipc21_GuidancePatch,
 Ipc21_GuidanceSettings,Ipc21_GuidanceMarker,Ipc21_MarkersState,Ipc21_QuestsState,Ipc21_FocusState,Ipc21_FocusTarget,Ipc21_FocusTargetInput,
 Ipc21_FocusOverrides,Ipc21_FocusInterval,Ipc21_QuestSummary,Ipc21_QuestDetail,Ipc21_ActiveQuest} from './generated.js';

/** Grant per 0.21 method (RFC-0012). */
export const QUEST_REQUIREMENTS={
 'markers.reveal':'shell.control','guidance.get':'state.read','guidance.set':'quest.control',
 'quests.list':'state.read','quests.get':'state.read','quests.track':'quest.control','quests.accept':'quest.control','quests.abandon':'quest.control',
 'quests.resume':'quest.control','quests.create':'quest.control','quests.update':'quest.control','quests.delete':'quest.control','quests.mark':'quest.control',
 'focus.start':'quest.control','focus.pause':'quest.control','focus.resume':'quest.control','focus.skip':'quest.control','focus.stop':'quest.control',
 'focus.history':'state.read'
} as const;
export const QUEST_EVENTS=['quest.progress','focus.phase'] as const;
export type QuestHint={method:typeof QUEST_EVENTS[number];params:Record<string,unknown>};

type Pick21<K extends keyof Ipc21_State>=Ipc21_State[K];
/** The 0.21 state keys the 0.2 mock does not model, at fixed neutral values. */
export const BASELINE_021:{spatial:Pick21<'spatial'>;workspaces:Pick21<'workspaces'>;mounts:Pick21<'mounts'>;presentation:Pick21<'presentation'>;
 interaction:Pick21<'interaction'>;apps:Pick21<'apps'>;keymap:Pick21<'keymap'>;editor:Pick21<'editor'>}={
 spatial:{world:null,map:null,output:null,projection:null},
 workspaces:{currentId:null,locations:[]},
 mounts:{areas:[],anchors:[],bindings:[],placements:[],objects:[],carriedSurfaceId:null,desktopWorkspaceId:null,placementZones:[],instances:[]},
 presentation:{profile:null,fov:70,quality:'high'},
 interaction:{mode:'movement',tool:1,tools:['pointer','mount','path','position','placement'],noclip:false,cursor:'reticle',taggedSurfaceId:null,reticle:{state:'neutral',action:''}},
 apps:[],
 keymap:{config:{version:2,longHoldMs:1000,scopeVignette:false,useDistance:3,useTolerance:0.05,captureInputLimit:64,modes:{
  world:{look:[],forward:['W'],back:['S'],left:['A'],right:['D'],menu:['Escape'],sprint:['Shift'],up:['Space'],down:['Control'],use:['E'],focus:['F'],noclip:[],scope:[],debug:[],
   capture:[],carry:[],resize:[],distance:[],rotate:[],tool1:['1'],tool2:['2'],tool3:['3'],tool4:['4'],'hud.cycle':[],transport:[],autopilot:[],primary:[],secondary:[],fly:[],
   'record.toggle':[],exit:['[L]Tab'],tool5:['5'],'carry.facing':[],'content.scale':[],'window.reset':[],cycle:[],alternate:[],'markers.reveal':['Tab']},
  interactive:{exit:['Escape'],'record.toggle':[]},focus:{exit:['Escape'],'record.toggle':[]},menu:{exit:['Escape'],'record.toggle':[]}}},
  path:'',steals:[],conflicts:[],capture:null,error:'',holds:[]},
 editor:{mode:'world',tool:1,submode:'normal',selectedId:null,selectedKind:'',paths:[],objects:[],locked:[],debug:false,
  unplaced:{count:0,windows:[],selectedId:null,preview:false},carryFacing:null,contentScale:null,
  toolSlots:{primary:null,secondary:null,alternate:null,cycle:null},
  toolDefinitions:(['Pointer','Mount','Path','Position','Placement'] as const).map((name,i)=>({slot:i+1,name,slots:{primary:null,secondary:null,alternate:null,cycle:null}})) as unknown as Pick21<'editor'>['toolDefinitions'],
  toolInput:{modifiers:0,override:false,gestures:[]}}
};

export const GUIDANCE_DEFAULTS:Ipc21_GuidanceConfig={
 'markers.reveal_ms':4000,'markers.reveal_mode':'timer','markers.max_revealed':12,'markers.labels':5,'markers.persistent':'edge','markers.core_draw':true,
 'quests.notifications':'all','focus.work_min':25,'focus.short_break_min':5,'focus.long_break_min':15,'focus.long_break_every':4,'focus.cycles':4,
 'focus.auto_start_breaks':true,'focus.auto_start_work':false,'focus.count_mode':'focus','focus.idle_s':180,'focus.grace_s':30,'focus.calm':true,
 'focus.calm_npc_distance':6,'focus.desktop_chip':false,'focus.history_days':90
};
const RANGES:Ipc21_GuidanceSettings['ranges']={'markers.reveal_ms':[1000,15000],'markers.max_revealed':[4,16],'markers.labels':[2,8],'focus.work_min':[5,120],
 'focus.short_break_min':[1,30],'focus.long_break_min':[5,60],'focus.long_break_every':[2,12],'focus.cycles':[1,12],'focus.idle_s':[60,900],'focus.grace_s':[0,120],
 'focus.calm_npc_distance':[2,20],'focus.history_days':[0,365]};
const OPTIONS:Ipc21_GuidanceSettings['options']={'markers.reveal_mode':['timer','toggle'],'markers.persistent':['off','edge','always'],
 'quests.notifications':['all','important','off'],'focus.count_mode':['focus','wall']};

type Objective={id:string;type:'manual'|'reach'|'focus';count:number;label?:string;target?:Ipc21_QuestTarget;radius?:number;sessions?:number;minutes?:number;focusTarget?:'quest'|'any'};
type Step={id:string;title:string;optional:boolean;any:boolean;target:Ipc21_QuestTarget|null;objectives:Objective[]};
type QuestState=Ipc21_QuestSummary['state'];
interface Quest {id:string;title:string;summary:string;sequential:boolean;expires:string|null;steps:Step[];state:QuestState;
 progress:Record<string,Record<string,number>>;credited:Record<string,Record<string,number>>;createdAt:string;updatedAt:string;completedAt:string|null;}
interface Focus {sessionId:string;state:'work'|'break'|'ready'|'paused';pausedState:'work'|'break'|'ready'|null;phaseMs:number;phaseStartedAtMs:number|null;
 remainingMs:number;creditedMs:number;cycle:number;breakKind:'short'|'long'|null;started:string;
 config:{work:number;shortBreak:number;longBreak:number;every:number;cycles:number;countMode:'focus'|'wall';calm:boolean;autoBreaks:boolean;autoWork:boolean};
 target:Ipc21_FocusTarget;questRef?:Ipc21_QuestRef;objectiveId?:string;}

const pad=(n:number)=>String(n).padStart(2,'0');
/** Local wall time, ISO without offset (the contract's "ISO local"). */
export function localIso(date=new Date()):string {return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;}
function parseLocal(text:string):number {const [d,t]=text.split('T'),[y,m,day]=d.split('-').map(Number),[h,mi]=t.split(':').map(Number);return new Date(y,m-1,day,h,mi).getTime();}
/** A quest slug from a title (RFC-0012: lowercase, digits, dashes, at most 64). */
export function slugify(title:string):string {return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64).replace(/-+$/,'') || 'quest';}
const same=(a:Ipc21_QuestRef|null|undefined,b:Ipc21_QuestRef|null|undefined)=>!!a && !!b && a.source===b.source && a.id===b.id;
const MAX_PERSONAL=64;

export class QuestEngine {
 private quests:Quest[]=[];private tracked:Ipc21_QuestRef|null=null;private overrides:Partial<Ipc21_GuidanceConfig>={};
 private reveal:Ipc21_MarkersState['reveal']=null;private focus?:Focus;private history:Array<Ipc21_FocusInterval & {endMs:number}>=[];
 /** world: the mock's zones/waypoint; clock: CLOCK_MONOTONIC-like milliseconds (injectable for tests). */
 constructor(private readonly world:()=>{zones:Array<{id:string;name:string;bounds:{min:number[];max:number[]}}>;waypoint:{id:string;label:string;position:number[]}|null;loaded:boolean},
  private readonly clock:()=>number=()=>Math.floor(performance.now())) {}
 get config():Ipc21_GuidanceConfig {return {...GUIDANCE_DEFAULTS,...this.overrides} as Ipc21_GuidanceConfig;}
 settings():Ipc21_GuidanceSettings {return {config:this.config,defaults:{...GUIDANCE_DEFAULTS},overrides:{...this.overrides},ranges:structuredClone(RANGES),options:structuredClone(OPTIONS),path:'',error:''};}

 // ---- state keys ----
 state():{markers:Ipc21_MarkersState;quests:Ipc21_QuestsState;focus:Ipc21_FocusState} {
  const config=this.config;
  return {markers:{reveal:this.reveal?{...this.reveal}:null,persistent:config['markers.persistent'],calm:this.calm(),coreDraw:config['markers.core_draw'],list:this.markers()},
   quests:{enabled:true,tracked:this.tracked?{...this.tracked}:null,active:this.activeList(),counts:{available:this.count('available'),active:this.count('active'),completed:this.count('completed')},world:null},
   focus:this.focusState()};
 }
 private count(state:QuestState):number {return this.quests.filter(q=>q.state===state).length;}
 private calm():boolean {return this.focus?.state==='work' && this.focus.config.calm;}
 private ref(q:Quest):Ipc21_QuestRef {return {source:'personal',id:q.id};}
 private activeList():Ipc21_ActiveQuest[] {
  const active=this.quests.filter(q=>q.state==='active').sort((a,b)=>Number(same(this.ref(b),this.tracked))-Number(same(this.ref(a),this.tracked)) || b.updatedAt.localeCompare(a.updatedAt));
  return active.slice(0,16).map(q=>{const step=this.currentSteps(q)[0];return {id:q.id,source:'personal',title:q.title,step:step?{id:step.id,title:step.title,progress:this.stepProgress(q,step)}:null,progress:this.questProgress(q)};});
 }
 private resolve(target:Ipc21_QuestTarget|null|undefined):[number,number,number]|null {
  if(!target)return null;const world=this.world();if(!world.loaded)return null;
  if('position' in target)return [...target.position];
  if('zoneId' in target){const z=world.zones.find(z=>z.id===target.zoneId);if(!z)return null;const {min,max}=z.bounds;return [(min[0]+max[0])/2,min[1]+1.7,(min[2]+max[2])/2];}
  return null; // areas, places and workspace homes do not exist in the mock world
 }
 private markers():Ipc21_GuidanceMarker[] {
  const list:Ipc21_GuidanceMarker[]=[],world=this.world();
  const add=(m:Omit<Ipc21_GuidanceMarker,'position'|'areaId'|'range'|'labelRange'|'occlusion'>&{occlusion?:Ipc21_GuidanceMarker['occlusion']})=>{
   list.push({...m,label:m.label.slice(0,48),position:this.resolve(m.target),areaId:null,range:[m.tier===1?2:4,m.tier===4?80:m.tier===3?150:400],labelRange:m.tier===4?30:120,occlusion:m.occlusion || (m.tier<=2?'through':'visible')});
  };
  if(world.waypoint)add({id:`waypoint:${world.waypoint.id}`.slice(0,160),kind:'waypoint',tier:1,label:world.waypoint.label,icon:'waypoint',target:{position:world.waypoint.position as [number,number,number]},tracked:false,source:{waypoint:true}});
  for(const q of this.quests.filter(q=>q.state==='active')){
   const tracked=same(this.ref(q),this.tracked);
   for(const step of this.currentSteps(q))for(const o of step.objectives){
    const target=o.target || step.target;if(!target || this.done(q,step,o))continue;
    add({id:`quest:personal/${q.id}/${step.id}/${o.id}`.slice(0,160),kind:'quest',tier:tracked?1:2,label:step.title,icon:step.optional?'quest-optional':'quest',target,tracked,
     source:{questId:`personal/${q.id}`,stepId:step.id,objectiveId:o.id}});
   }
  }
  for(const z of world.loaded?world.zones:[])add({id:`place:${z.id}`.slice(0,160),kind:'place',tier:4,label:z.name,icon:'place',target:{zoneId:z.id},tracked:false,source:{zoneId:z.id}});
  if(this.focus?.target.kind==='workspace' && this.focus.target.workspaceId)add({id:`focus:workspace/${this.focus.target.workspaceId}`,kind:'focus',tier:1,label:this.focus.target.label,icon:'focus',
   target:{workspaceId:this.focus.target.workspaceId},tracked:false,source:{focus:true,workspaceId:this.focus.target.workspaceId}});
  return list.sort((a,b)=>a.tier-b.tier || (a.id<b.id?-1:a.id>b.id?1:0)).slice(0,64);
 }
 private focusState():Ipc21_FocusState {
  const f=this.focus,cycles=this.config['focus.cycles'];
  if(!f)return {state:'idle',pausedState:null,sessionId:null,phaseStartedAtMs:null,phaseEndsAtMs:null,phaseMs:0,remainingMs:0,creditedMs:0,crediting:false,
   cycle:0,cycles,breakKind:null,countMode:this.config['focus.count_mode'],target:null,calm:false};
  const running=f.state==='work' || f.state==='break',now=this.clock();
  const remaining=running?Math.max(0,f.phaseStartedAtMs!+f.phaseMs-now):f.remainingMs;
  return {state:f.state,pausedState:f.pausedState,sessionId:f.sessionId,phaseStartedAtMs:running?f.phaseStartedAtMs:null,phaseEndsAtMs:running?f.phaseStartedAtMs!+f.phaseMs:null,
   phaseMs:f.phaseMs,remainingMs:remaining,creditedMs:this.credited(f),crediting:f.state==='work',cycle:f.cycle,cycles:f.config.cycles,breakKind:f.breakKind,
   countMode:f.config.countMode,target:structuredClone(f.target),calm:this.calm()};
 }
 // Wall-mode credit: elapsed work time (phaseStartedAtMs is shifted back by the time worked before a pause).
 private credited(f:Focus):number {return f.state==='work'?Math.min(f.phaseMs,this.clock()-f.phaseStartedAtMs!):f.creditedMs;}

 // ---- quest model ----
 private steps(q:Ipc21_PersonalQuestInput):Step[] {
  const steps=q.steps.map((s,i)=>({id:s.id || `step-${i+1}`,title:s.title,optional:!!s.optional,any:!!s.any,target:s.target?structuredClone(s.target):null,
   objectives:(s.objectives || [{id:'done',type:'manual' as const}]).map(o=>({...structuredClone(o),count:o.type==='focus'?o.sessions:o.count ?? 1}) as Objective)}));
  if(new Set(steps.map(s=>s.id)).size!==steps.length)throw new RpcError(-32602,'Duplicate step id');
  for(const s of steps){
   if(new Set(s.objectives.map(o=>o.id)).size!==s.objectives.length)throw new RpcError(-32602,'Duplicate objective id in '+s.id);
   if(s.objectives.some(o=>o.type==='reach' && !o.target && !s.target))throw new RpcError(-32602,'A reach objective needs a target on it or its step');
  }
  if(steps.every(s=>s.optional))throw new RpcError(-32602,'At least one step must be required');
  return steps;
 }
 private find(ref:Ipc21_QuestRef,edit=false):Quest {
  if(ref.source!=='personal'){if(edit)throw new RpcError(-32007,'Only personal quests can be edited');throw new RpcError(-32003,'Unknown quest');}
  const q=this.quests.find(q=>q.id===ref.id);if(!q)throw new RpcError(-32003,'Unknown quest');return q;
 }
 private done(q:Quest,step:Step,o:Objective):boolean {return (q.progress[step.id]?.[o.id] || 0)>=o.count;}
 private stepDone(q:Quest,step:Step):boolean {return step.any?step.objectives.some(o=>this.done(q,step,o)):step.objectives.every(o=>this.done(q,step,o));}
 private currentSteps(q:Quest):Step[] {
  if(q.state!=='active')return [];
  const open=q.steps.filter(s=>!this.stepDone(q,s));
  if(!q.sequential)return open;const first=open.find(s=>!s.optional);return open.filter(s=>s===first || s.optional);
 }
 private stepProgress(q:Quest,step:Step):[number,number] {const done=step.objectives.filter(o=>this.done(q,step,o)).length;return step.any?[Math.min(done,1),1]:[done,step.objectives.length];}
 private questProgress(q:Quest):[number,number] {const required=q.steps.filter(s=>!s.optional);return [required.filter(s=>this.stepDone(q,s)).length,required.length];}
 private label(o:Objective):string {
  if(o.label)return o.label;if(o.type==='manual')return 'Done';
  if(o.type==='focus')return `${o.sessions} focus session${o.sessions===1?'':'s'}`;
  const t=o.target;return t && 'zoneId' in t?`Reach ${this.world().zones.find(z=>z.id===t.zoneId)?.name || t.zoneId}`.slice(0,64):'Reach the target';
 }
 private summary(q:Quest):Ipc21_QuestSummary {
  const step=this.currentSteps(q)[0],targets=q.steps.flatMap(s=>[s.target,...s.objectives.map(o=>o.target)]).filter(Boolean);
  return {questRef:this.ref(q),title:q.title,category:'personal',state:q.state,tracked:same(this.ref(q),this.tracked),
   step:step?{id:step.id,title:step.title,progress:this.stepProgress(q,step)}:null,progress:this.questProgress(q),
   offWorld:targets.length>0 && targets.every(t=>!this.resolve(t)),updatedAt:q.updatedAt};
 }
 private detail(q:Quest):Ipc21_QuestDetail {
  const current=new Set(this.currentSteps(q));
  return {questRef:this.ref(q),title:q.title,summary:q.summary,category:'personal',state:q.state,tracked:same(this.ref(q),this.tracked),sequential:q.sequential,
   expires:q.expires,createdAt:q.createdAt,updatedAt:q.updatedAt,completedAt:q.completedAt,personal:true,
   steps:q.steps.map(s=>({id:s.id,title:s.title,optional:s.optional,any:s.any,state:this.stepDone(q,s)?'done':current.has(s)?'current':'pending',target:s.target?structuredClone(s.target):null,
    objectives:s.objectives.map(o=>({id:o.id,type:o.type,label:this.label(o),count:o.count,done:Math.min(o.count,q.progress[s.id]?.[o.id] || 0),
     ...(o.type==='reach'?{...(o.target?{target:structuredClone(o.target)}:{}),radius:o.radius ?? 4}:{}),
     ...(o.type==='focus'?{sessions:o.sessions!,minutes:o.minutes ?? Math.max(1,0.8*this.config['focus.work_min']),focusTarget:o.focusTarget || 'quest',creditedMinutes:Math.round((q.credited[s.id]?.[o.id] || 0)*10)/10}:{})}))}))};
 }
 /** Advance one objective; returns the progress hints. */
 private advance(q:Quest,step:Step,o:Objective):QuestHint[] {
  const before=this.stepDone(q,step),bucket=q.progress[step.id] ||= {};bucket[o.id]=Math.min(o.count,(bucket[o.id] || 0)+1);q.updatedAt=localIso();
  const base={questRef:this.ref(q),title:q.title,stepId:step.id,stepTitle:step.title};
  if(this.questProgress(q).every((n,i,a)=>n===a[1])){
   q.state='completed';q.completedAt=localIso();if(same(this.ref(q),this.tracked))this.tracked=null;
   return [{method:'quest.progress',params:{...base,kind:'completed',progress:this.questProgress(q)}}];
  }
  if(!before && this.stepDone(q,step)){const next=this.currentSteps(q).find(s=>!s.optional);return [{method:'quest.progress',params:{...base,kind:'step',...(next?{nextStepTitle:next.title}:{}),progress:this.stepProgress(q,step)}}];}
  return [{method:'quest.progress',params:{...base,kind:'objective',objectiveId:o.id,progress:[bucket[o.id],o.count]}}];
 }

 // ---- methods ----
 execute(method:string,params:any):{result?:unknown;hints:QuestHint[];changed:boolean} {
  const hints:QuestHint[]=[];
  switch(method){
   case 'guidance.get':return {result:this.settings(),hints,changed:false};
   case 'guidance.set':{
    for(const [k,v] of Object.entries(params.patch as Ipc21_GuidancePatch))if(v===null)delete (this.overrides as any)[k];else (this.overrides as any)[k]=v;
    return {result:this.settings(),hints,changed:true};
   }
   case 'markers.reveal':{
    const toggle=params.durationMs===undefined && this.config['markers.reveal_mode']==='toggle';
    this.reveal=toggle && this.reveal?null:{startedAtMs:this.clock(),holdMs:toggle?0:params.durationMs ?? this.config['markers.reveal_ms'],fadeMs:600,reason:'request'};return {hints,changed:true};
   }
   case 'quests.list':{
    const states:string[]|undefined=params.states,sources:string[]|undefined=params.sources;
    const quests=this.quests.filter(q=>(!states || states.includes(q.state)) && (!sources || sources.includes('personal')))
     .sort((a,b)=>Number(b.state==='active')-Number(a.state==='active') || b.updatedAt.localeCompare(a.updatedAt)).slice(0,256).map(q=>this.summary(q));
    return {result:{quests},hints,changed:false};
   }
   case 'quests.get':return {result:{quest:this.detail(this.find(params.questRef))},hints,changed:false};
   case 'quests.track':{
    if(params.questRef===null)this.tracked=null;
    else {const q=this.find(params.questRef);if(q.state!=='active')throw new RpcError(-32004,'Only active quests can be tracked');this.tracked=this.ref(q);}
    return {hints,changed:true};
   }
   case 'quests.accept':case 'quests.abandon':case 'quests.resume':{
    const q=this.find(params.questRef),from:Record<string,QuestState[]>={'quests.accept':['available'],'quests.abandon':['active'],'quests.resume':['failed','abandoned']};
    if(!from[method].includes(q.state))throw new RpcError(-32004,`Cannot ${method.slice(7)} a ${q.state} quest`);
    q.state=method==='quests.abandon'?'abandoned':'active';q.updatedAt=localIso();
    if(q.state==='abandoned' && same(this.ref(q),this.tracked))this.tracked=null;
    if(q.state==='active' && !this.tracked)this.tracked=this.ref(q);
    return {hints,changed:true};
   }
   case 'quests.create':{
    const input=params.quest as Ipc21_PersonalQuestInput;if(this.quests.length>=MAX_PERSONAL)throw new RpcError(-32008,'At most 64 personal quests');
    let id=input.id || slugify(input.title);
    if(this.quests.some(q=>q.id===id)){if(input.id)throw new RpcError(-32004,'A personal quest with this id exists');const stem=id.slice(0,60);let n=2;while(this.quests.some(q=>q.id===`${stem}-${n}`))n++;id=`${stem}-${n}`;}
    const now=localIso(),q:Quest={id,title:input.title,summary:input.summary || '',sequential:input.sequential ?? true,expires:input.expires || null,steps:this.steps(input),
     state:'active',progress:{},credited:{},createdAt:now,updatedAt:now,completedAt:null};
    this.quests.push(q);if(!this.tracked)this.tracked=this.ref(q);
    return {result:{questRef:this.ref(q)},hints,changed:true};
   }
   case 'quests.update':{
    const q=this.find(params.questRef,true),input=params.quest as Ipc21_PersonalQuestInput,steps=this.steps(input);
    const keep=(old:Record<string,Record<string,number>>)=>Object.fromEntries(steps.map(s=>[s.id,Object.fromEntries(s.objectives.filter(o=>old[s.id]?.[o.id]!==undefined).map(o=>[o.id,Math.min(o.count,old[s.id][o.id])]))]));
    Object.assign(q,{title:input.title,summary:input.summary || '',sequential:input.sequential ?? true,expires:input.expires || null,steps,progress:keep(q.progress),credited:keep(q.credited),updatedAt:localIso()});
    if(q.state==='active' && this.questProgress(q).every((n,i,a)=>n===a[1])){q.state='completed';q.completedAt=localIso();if(same(this.ref(q),this.tracked))this.tracked=null;}
    return {hints,changed:true};
   }
   case 'quests.delete':{
    const q=this.find(params.questRef,true);this.quests=this.quests.filter(x=>x!==q);if(same(this.ref(q),this.tracked))this.tracked=null;return {hints,changed:true};
   }
   case 'quests.mark':{
    const q=this.find(params.questRef),step=q.steps.find(s=>s.id===params.stepId),o=step?.objectives.find(o=>o.id===params.objectiveId);
    if(!step || !o)throw new RpcError(-32003,'Unknown step or objective');if(o.type!=='manual')throw new RpcError(-32602,'Only manual objectives can be marked');
    if(q.state!=='active')throw new RpcError(-32004,'Quest is not active');if(!this.currentSteps(q).includes(step))throw new RpcError(-32004,'Step is not current');
    if(this.done(q,step,o))throw new RpcError(-32004,'Objective already done');
    return {hints:this.advance(q,step,o),changed:true};
   }
   case 'focus.start':{
    if(this.focus)throw new RpcError(-32004,'A focus session is running');
    let questRef:Ipc21_QuestRef|undefined,label:string|undefined;
    if(params.questRef){const q=this.find(params.questRef);questRef=this.ref(q);label=q.title;
     if(params.objectiveId && !q.steps.some(s=>s.objectives.some(o=>o.id===params.objectiveId && o.type==='focus')))throw new RpcError(-32003,'Unknown focus objective');}
    const c=this.config,o:Ipc21_FocusOverrides=params.overrides || {},input:Ipc21_FocusTargetInput=params.target || {kind:'any'};
    const generated=input.kind==='any'?(label || 'Any window'):input.kind==='workspace'?`Workspace ${input.workspaceId}`:input.kind==='window'?`${input.appClass} on ${input.workspaceId}`:input.appClass;
    const target:Ipc21_FocusTarget={kind:input.kind,label:(input.label ?? generated).slice(0,64),...('workspaceId' in input?{workspaceId:input.workspaceId}:{}),...('appClass' in input?{appClass:input.appClass}:{}),...(questRef?{questRef}:{})};
    this.focus={sessionId:'focus-'+randomBytes(6).toString('hex'),state:'work',pausedState:null,phaseMs:0,phaseStartedAtMs:null,remainingMs:0,creditedMs:0,cycle:0,breakKind:null,started:localIso(),
     config:{work:o.work_min ?? c['focus.work_min'],shortBreak:o.short_break_min ?? c['focus.short_break_min'],longBreak:o.long_break_min ?? c['focus.long_break_min'],
      every:o.long_break_every ?? c['focus.long_break_every'],cycles:o.cycles ?? c['focus.cycles'],countMode:o.count_mode ?? c['focus.count_mode'],calm:o.calm ?? c['focus.calm'],
      autoBreaks:o.auto_start_breaks ?? c['focus.auto_start_breaks'],autoWork:o.auto_start_work ?? c['focus.auto_start_work']},
     target,...(questRef?{questRef}:{}),...(params.objectiveId?{objectiveId:params.objectiveId}:{})};
    hints.push(...this.work());
    return {result:{sessionId:this.focus.sessionId},hints,changed:true};
   }
   case 'focus.pause':{
    const f=this.requireFocus();if(f.state==='paused')throw new RpcError(-32004,'Already paused');
    if(f.state==='work' || f.state==='break'){f.creditedMs=this.credited(f);f.remainingMs=Math.max(0,f.phaseStartedAtMs!+f.phaseMs-this.clock());}
    f.pausedState=f.state;f.state='paused';f.phaseStartedAtMs=null;hints.push(this.phase('paused'));return {hints,changed:true};
   }
   case 'focus.resume':{
    const f=this.requireFocus();
    if(f.state==='ready')hints.push(...this.work());
    else if(f.state==='paused'){
     const was=f.pausedState!;f.pausedState=null;
     if(was==='ready'){f.state='ready';hints.push(...this.work());}
     else {f.state=was;f.phaseStartedAtMs=this.clock()-(f.phaseMs-f.remainingMs);hints.push(this.phase(was));}
    }else throw new RpcError(-32004,'Focus session is not paused');
    return {hints,changed:true};
   }
   case 'focus.skip':{
    const f=this.requireFocus(),state=f.state==='paused'?f.pausedState!:f.state;f.pausedState=null;
    if(state==='work'){f.creditedMs=this.credited(f);f.state='work';hints.push(...this.endWork('skipped'));}
    else {if(state==='break')this.record('break',f,0,'skipped');hints.push(...this.work());}
    return {hints,changed:true};
   }
   case 'focus.stop':{
    const f=this.requireFocus(),state=f.state==='paused'?f.pausedState:f.state;
    if(state==='work')this.record('work',f,this.credited(f),'stopped');else if(state==='break')this.record('break',f,0,'stopped');
    hints.push(this.phase('ended',{outcome:'stopped'}));this.focus=undefined;return {hints,changed:true};
   }
   case 'focus.history':{
    const days=params.days ?? this.config['focus.history_days'],since=Date.now()-days*86_400_000;
    return {result:{intervals:this.history.filter(i=>i.endMs>=since).slice(0,512).map(({endMs,...i})=>i)},hints,changed:false};
   }
  }
  throw new RpcError(-32601,'Unimplemented');
 }
 private requireFocus():Focus {if(!this.focus)throw new RpcError(-32004,'No focus session');return this.focus;}
 private phase(phase:'work'|'break'|'ready'|'paused'|'ended',extra:Record<string,unknown>={}):QuestHint {
  const f=this.focus!;return {method:'focus.phase',params:{focusSessionId:f.sessionId,phase,cycle:f.cycle,cycles:f.config.cycles,creditedMs:f.creditedMs,...(f.breakKind && phase==='break'?{breakKind:f.breakKind}:{}),...extra}};
 }
 private work():QuestHint[] {
  const f=this.focus!;f.cycle++;f.state='work';f.breakKind=null;f.phaseMs=f.config.work*60_000;f.remainingMs=f.phaseMs;f.creditedMs=0;f.phaseStartedAtMs=this.clock();f.started=localIso();
  return [this.phase('work')];
 }
 private record(phase:'work'|'break',f:Focus,creditedMs:number,outcome:'completed'|'skipped'|'stopped'):void {
  if(!this.config['focus.history_days'])return;
  const t=f.target,end=new Date();
  this.history.unshift({start:f.started,end:localIso(end),phase,plannedMin:Math.round(f.phaseMs/600)/100,creditedMin:Math.round(creditedMs/600)/100,targetKind:t.kind,
   ...(t.appClass?{appClass:t.appClass}:{}),...(t.workspaceId?{workspaceId:t.workspaceId}:{}),...(f.questRef?{questId:`${f.questRef.source}/${f.questRef.id}`}:{}),outcome,endMs:end.getTime()});
  this.history=this.history.slice(0,512);
 }
 /** A work interval ended (time up or skipped): credit focus objectives, then break, ready or end. */
 private endWork(outcome:'completed'|'skipped'):QuestHint[] {
  const f=this.focus!,hints:QuestHint[]=[];this.record('work',f,f.creditedMs,outcome);
  let counted=false;
  if(outcome==='completed')for(const q of this.quests.filter(q=>q.state==='active'))for(const step of this.currentSteps(q))for(const o of step.objectives){
   if(o.type!=='focus' || this.done(q,step,o) || (f.objectiveId && same(f.questRef,this.ref(q)) && o.id!==f.objectiveId))continue;
   if((o.focusTarget || 'quest')==='quest' && !same(f.questRef,this.ref(q)))continue;
   const minutes=o.minutes ?? 0.8*this.config['focus.work_min'];(q.credited[step.id] ||= {})[o.id]=(q.credited[step.id][o.id] || 0)+f.creditedMs/60_000;
   if(f.creditedMs>=minutes*60_000 && q.state==='active'){counted=true;hints.push(...this.advance(q,step,o));}
  }
  if(f.cycle>=f.config.cycles){hints.unshift(this.phase('ended',{outcome,counted}));this.focus=undefined;return hints;}
  f.breakKind=f.cycle%f.config.every===0?'long':'short';f.phaseMs=(f.breakKind==='long'?f.config.longBreak:f.config.shortBreak)*60_000;f.remainingMs=f.phaseMs;f.started=localIso();
  if(f.config.autoBreaks){f.state='break';f.phaseStartedAtMs=this.clock();hints.unshift(this.phase('break',{outcome,counted}));}
  else {f.state='ready';f.phaseStartedAtMs=null;f.phaseMs=f.config.work*60_000;f.remainingMs=f.phaseMs;hints.unshift(this.phase('ready',{outcome,counted}));}
  return hints;
 }
 /** Timers: reveal end, phase ends, quest expiry. Returns undefined when nothing changed. */
 tick():QuestHint[]|undefined {
  const now=this.clock(),hints:QuestHint[]=[];let changed=false;
  if(this.reveal && this.reveal.holdMs>0 && now>=this.reveal.startedAtMs+this.reveal.holdMs+this.reveal.fadeMs){this.reveal=null;changed=true;}
  const f=this.focus;
  if(f && (f.state==='work' || f.state==='break') && now>=f.phaseStartedAtMs!+f.phaseMs){
   changed=true;
   if(f.state==='work'){f.creditedMs=f.phaseMs;hints.push(...this.endWork('completed'));}
   else {this.record('break',f,0,'completed');if(f.config.autoWork)hints.push(...this.work());else {f.state='ready';f.phaseStartedAtMs=null;f.phaseMs=f.config.work*60_000;f.remainingMs=f.phaseMs;f.breakKind=null;hints.push(this.phase('ready'));}}
  }
  for(const q of this.quests)if(q.state==='active' && q.expires && Date.now()>=parseLocal(q.expires)){
   q.state='failed';q.updatedAt=localIso();if(same(this.ref(q),this.tracked))this.tracked=null;changed=true;
   hints.push({method:'quest.progress',params:{questRef:this.ref(q),kind:'failed',title:q.title}});
  }
  return changed || hints.length?hints:undefined;
 }
}

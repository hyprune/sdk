// `hyprune quest ...` and `hyprune focus ...`: personal quests and focus sessions over
// IPC 0.21 (RFC-0012). Kept apart from cli.ts because these verbs take repeated, ordered
// flags (--step/--focus) that the generic parser does not model.
import {parseArgs} from 'node:util';
import {clientFromEnvironment} from './launch.js';
import {atLeast,PROTOCOLS,type Protocol} from './validation.js';
import type {HypruneClient} from './client.js';
import type {Ipc21_PersonalQuestInput,Ipc21_StepInput,Ipc21_QuestRef,Ipc21_FocusTargetInput,Ipc21_FocusOverrides,Ipc21_FocusState,Ipc21_QuestSummary} from './generated.js';

/** The first IPC version with quests and focus sessions; the CLI asks for it unless told otherwise. */
export const QUESTS_SINCE='0.21';
export const questHelp=`hyprune quest add <title> [--step <title>]... [--focus N] [--summary text] [--expires YYYY-MM-DDTHH:MM] [--any-order]
hyprune quest list [--state active|available|completed|failed|abandoned]...
hyprune quest show <id>
hyprune quest track <id> | hyprune quest untrack
hyprune quest done <id> <stepId> [objectiveId]
hyprune quest abandon|resume <id>
hyprune quest rm <id>
hyprune focus start [--work MIN] [--break MIN] [--long-break MIN] [--cycles N] [--workspace ID] [--app CLASS] [--quest ID [--objective ID]]
hyprune focus pause|resume|skip|stop|status

--focus N gives the step named by the --step before it a focus objective of N sessions
(without --step, the quest's single step). <id> is a personal quest slug or "<source>/<id>".
Common: [--socket path] [--protocol 0.21] [--json]. Needs the quest.control grant.`;

type Token={kind:'option';name:string;value?:string}|{kind:'positional';value:string}|{kind:'option-terminator'};
/** Build a personal quest from `quest add` arguments (ordered: each --focus belongs to the preceding --step). */
export function buildQuest(title:string,tokens:Token[],extra:{summary?:string;expires?:string;sequential?:boolean}={}):Ipc21_PersonalQuestInput {
 const steps:Ipc21_StepInput[]=[];let pendingFocus:number|undefined;
 const sessions=(text:string|undefined)=>{const n=Number(text);if(!Number.isInteger(n) || n<1 || n>12)throw new Error('--focus takes 1..12 sessions');return n;};
 const focus=(step:Ipc21_StepInput,n:number)=>{step.objectives=[{id:'focus',type:'focus',sessions:n}];};
 for(const t of tokens){
  if(t.kind!=='option')continue;
  if(t.name==='step'){if(!t.value)throw new Error('--step needs a title');steps.push({title:t.value});}
  else if(t.name==='focus'){
   const n=sessions(t.value);
   if(steps.length)focus(steps.at(-1)!,n);else if(pendingFocus===undefined)pendingFocus=n;else throw new Error('--focus given twice for the quest step');
  }
 }
 if(pendingFocus!==undefined && steps.length)throw new Error('Put --focus after the --step it belongs to');
 if(!steps.length){const step:Ipc21_StepInput={title:title.slice(0,64)};if(pendingFocus!==undefined)focus(step,pendingFocus);steps.push(step);}
 if(steps.length>16)throw new Error('At most 16 steps');
 return {title,steps,...(extra.summary?{summary:extra.summary}:{}),...(extra.expires?{expires:extra.expires}:{}),...(extra.sequential===false?{sequential:false}:{})};
}
/** "<id>" (personal) or "<source>/<id>". */
export function questRef(text:string|undefined):Ipc21_QuestRef {
 if(!text)throw new Error('A quest id is required');const at=text.lastIndexOf('/');
 return at<0?{source:'personal',id:text}:{source:text.slice(0,at),id:text.slice(at+1)};
}
const minutes=(text:string|undefined,name:string,lo:number,hi:number)=>{if(text===undefined)return undefined;const n=Number(text);if(!Number.isInteger(n) || n<lo || n>hi)throw new Error(`--${name} takes ${lo}..${hi}`);return n;};
/** focus.start params from `focus start` options. */
export function focusParams(v:{work?:string;break?:string;'long-break'?:string;cycles?:string;workspace?:string;app?:string;quest?:string;objective?:string}) {
 const overrides:Ipc21_FocusOverrides={};
 const set=(key:keyof Ipc21_FocusOverrides,value:number|undefined)=>{if(value!==undefined)(overrides as any)[key]=value;};
 set('work_min',minutes(v.work,'work',1,120));set('short_break_min',minutes(v.break,'break',1,30));set('long_break_min',minutes(v['long-break'],'long-break',1,60));set('cycles',minutes(v.cycles,'cycles',1,12));
 const workspaceId=minutes(v.workspace,'workspace',1,2147483647);
 const target:Ipc21_FocusTargetInput|undefined=v.app && workspaceId!==undefined?{kind:'window',appClass:v.app,workspaceId}:v.app?{kind:'app',appClass:v.app}:workspaceId!==undefined?{kind:'workspace',workspaceId}:undefined;
 if(v.objective && !v.quest)throw new Error('--objective needs --quest');
 return {...(target?{target}:{}),...(v.quest?{questRef:questRef(v.quest)}:{}),...(v.objective?{objectiveId:v.objective}:{}),...(Object.keys(overrides).length?{overrides}:{})};
}
const clock=(ms:number)=>{const s=Math.max(0,Math.round(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
/** One status line for a focus state; `now` is the core's monotonic clock (session.ping). */
export function focusLine(f:Ipc21_FocusState,now?:number):string {
 if(f.state==='idle')return 'focus: idle';
 const remaining=f.phaseEndsAtMs!==null && now!==undefined?f.phaseEndsAtMs-now:f.remainingMs;
 const phase=f.state==='paused'?`paused (${f.pausedState})`:f.state==='break'?`${f.breakKind || 'short'} break`:f.state;
 return `focus: ${phase} ${clock(remaining)} left · cycle ${f.cycle}/${f.cycles} · credited ${clock(f.creditedMs)}${f.target?` · ${f.target.label}`:''}`;
}
export function questLine(q:Ipc21_QuestSummary):string {
 const ref=q.questRef.source==='personal'?q.questRef.id:`${q.questRef.source}/${q.questRef.id}`;
 return `${q.tracked?'*':' '} ${ref.padEnd(28)} ${q.state.padEnd(9)} ${q.progress[0]}/${q.progress[1]}  ${q.title}${q.step?`  → ${q.step.title} (${q.step.progress[0]}/${q.step.progress[1]})`:''}`;
}

export async function questMain(argv:string[]):Promise<void> {
 const [group,verb]=argv;
 const {values:v,positionals:p,tokens}=parseArgs({args:argv.slice(2),allowPositionals:true,tokens:true,options:{
  help:{type:'boolean',short:'h'},socket:{type:'string'},protocol:{type:'string'},json:{type:'boolean'},
  step:{type:'string',multiple:true},focus:{type:'string',multiple:true},summary:{type:'string'},expires:{type:'string'},'any-order':{type:'boolean'},
  state:{type:'string',multiple:true},work:{type:'string'},break:{type:'string'},'long-break':{type:'string'},cycles:{type:'string'},
  workspace:{type:'string'},app:{type:'string'},quest:{type:'string'},objective:{type:'string'}}});
 if(v.help || !verb){console.log(questHelp);return;}
 const protocol=v.protocol || process.env.HYPRUNE_PROTOCOL || QUESTS_SINCE;
 if(!(PROTOCOLS as readonly string[]).includes(protocol) || !atLeast(protocol,QUESTS_SINCE))throw new Error(`Quests and focus sessions need IPC ${QUESTS_SINCE} or newer (got ${protocol})`);
 if(v.socket)process.env.HYPRUNE_SOCKET=v.socket;
 const client=clientFromEnvironment({protocol:protocol as Protocol,capabilities:['state.read','quest.control'] as any}) as unknown as HypruneClient<'0.21'>;
 const out=(value:unknown,text:string)=>console.log(v.json?JSON.stringify(value,null,2):text);
 const signal=()=>client.close();process.once('SIGINT',signal);process.once('SIGTERM',signal);
 try {
  await client.connect();
  if(group==='quest'){
   switch(verb){
    case 'add':{
     if(!p[0])throw new Error('quest add needs a title');
     const quest=buildQuest(p[0],tokens as Token[],{summary:v.summary,expires:v.expires,sequential:v['any-order']?false:undefined});
     const r=await client.call('quests.create',{quest});return out(r,`added ${r.questRef.id}`);
    }
    case 'list':{
     const states=v.state as Ipc21_QuestSummary['state'][]|undefined;const r=await client.call('quests.list',states?{states}:{});
     return out(r,r.quests.length?r.quests.map(questLine).join('\n'):'no quests');
    }
    case 'show':{const r=await client.call('quests.get',{questRef:questRef(p[0])});return out(r,JSON.stringify(r.quest,null,2));}
    case 'track':{const r=await client.call('quests.track',{questRef:questRef(p[0])});return out(r,`tracking ${p[0]}`);}
    case 'untrack':{const r=await client.call('quests.track',{questRef:null});return out(r,'tracking nothing');}
    case 'abandon':case 'resume':{const r=await client.call(`quests.${verb}`,{questRef:questRef(p[0])});return out(r,`${verb==='abandon'?'abandoned':'resumed'} ${p[0]}`);}
    case 'rm':{const r=await client.call('quests.delete',{questRef:questRef(p[0])});return out(r,`removed ${p[0]}`);}
    case 'done':{
     const ref=questRef(p[0]),stepId=p[1];if(!stepId)throw new Error('quest done needs <id> <stepId> [objectiveId]');
     let objectiveId=p[2];
     if(!objectiveId){
      const step=(await client.call('quests.get',{questRef:ref})).quest.steps.find(s=>s.id===stepId);
      objectiveId=step?.objectives.find(o=>o.type==='manual' && o.done<o.count)?.id || 'done';
     }
     const r=await client.call('quests.mark',{questRef:ref,stepId,objectiveId});return out(r,`marked ${stepId}/${objectiveId}`);
    }
   }
  }else if(group==='focus'){
   switch(verb){
    case 'start':{const r=await client.call('focus.start',focusParams(v));return out(r,`focus session ${r.sessionId} started`);}
    case 'pause':case 'resume':case 'skip':case 'stop':{const r=await client.call(`focus.${verb}`,{});return out(r,`focus ${verb}`);}
    case 'status':{
     const snapshot=await client.subscribe(),ping=await client.call('session.ping',{});
     return out(snapshot.state.focus,focusLine(snapshot.state.focus,ping.monotonicMs));
    }
   }
  }
  throw new Error(`Unknown command: ${group} ${verb}\n${questHelp}`);
 }finally{client.close();process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
}

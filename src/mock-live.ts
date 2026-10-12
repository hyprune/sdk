// Live machine state for the mock daemon (IPC 0.24, RFC-0013). Development simulation only:
// every active user placement of a machine binds by default, input <id> reading source
// com.hyprune.sources.<instance id>, key <id> (repeated inputs expanded to <id>.N), from
// the mock's integrations state. Values pass through unmapped when their type fits the
// input; the mock has no stale threshold, so a condition is fresh, missing or error.
import type {Ipc24_CatalogMachine,Ipc24_LiveInput,Ipc24_LiveInstance,Ipc24_LiveState,Ipc24_MachineInput} from './generated.js';

/** At most 64 bound instances (RFC-0013 bound-instance cap). */
export const LIVE_LIMIT=64;
/** The default source of a placed machine (RFC-0013 "Default bindings"). */
export const defaultSource=(instanceId:string)=>`com.hyprune.sources.${instanceId}`;
const INPUT_KEYS=['id','type','label','explain','default','repeat','values','min','max','maxLength','states'] as const;

/** The catalog's machine field from an object manifest's traits.machine (declarations as authored). */
export function machineOf(traits:Record<string,unknown>):Ipc24_CatalogMachine|undefined {
 const m=traits.machine as {primary?:string;inputs?:Array<Record<string,unknown>>}|undefined;
 if(!m || !Array.isArray(m.inputs) || !m.inputs.length) return undefined;
 const inputs=m.inputs.slice(0,16).map(i=>Object.fromEntries(INPUT_KEYS.filter(k=>k in i).map(k=>[k,structuredClone(i[k])])) as Ipc24_MachineInput);
 return {primary:m.primary ?? null,inputs};
}

type Scalar=string|number|boolean;
type Source={sourceId:string;values:Record<string,Scalar>;monotonicMs:number};
/** The value an input shows without data: its default, else the type's rest value. */
function fallback(input:Ipc24_MachineInput):Scalar|null {
 if(input.default!==undefined) return input.default;
 switch(input.type){
  case 'enum':return input.values?.[0] ?? null;
  case 'text':return '';
  case 'bool':return false;
  case 'int':case 'number':return Math.max(0,input.min ?? 0);
  default:return null;
 }
}
/** The raw value when its type fits the input, else undefined (a type mismatch is the error condition). */
function fit(input:Ipc24_MachineInput,raw:Scalar):Scalar|undefined {
 switch(input.type){
  case 'enum':return typeof raw==='string' && input.values?.includes(raw)?raw:undefined;
  case 'int':return typeof raw==='number' && Number.isFinite(raw)?Math.round(Math.min(input.max ?? raw,Math.max(input.min ?? raw,raw))):undefined;
  case 'number':return typeof raw==='number' && Number.isFinite(raw)?Math.min(input.max ?? raw,Math.max(input.min ?? raw,raw)):undefined;
  case 'bool':return typeof raw==='boolean'?raw:undefined;
  case 'text':return typeof raw==='string'?raw.slice(0,input.maxLength ?? 64):String(raw).slice(0,input.maxLength ?? 64);
  case 'event':return typeof raw==='number' && Number.isInteger(raw) && raw>=0?raw:undefined;
  default:return undefined;
 }
}
const clip=(v:Scalar|null)=>typeof v==='string'?v.slice(0,256):v;

/**
 * The live key for the given machine placements. `wallOffsetMs` turns a source's monotonic
 * publication time into wall-clock Unix ms (Date.now() - performance.now()).
 */
export function liveState(placed:Array<{id:string;asset:string;ref:string;machine:Ipc24_CatalogMachine}>,sources:Source[],wallOffsetMs:number):Ipc24_LiveState {
 const instances:Ipc24_LiveInstance[]=[];
 for(const p of placed.slice(0,LIVE_LIMIT)){
  const sourceId=defaultSource(p.id),source=sources.find(s=>s.sourceId===sourceId);
  const status=source?.values._status,error=source?.values._error;
  const failed=status==='error';
  const inputs:Record<string,Ipc24_LiveInput>={};
  for(const input of p.machine.inputs){
   const keys=input.repeat?Array.from({length:input.repeat},(_,k)=>`${input.id}.${k+1}`):[input.id];
   for(const key of keys){
    if(Object.keys(inputs).length>=16) break;
    const raw=source?.values[key];
    if(!source || raw===undefined){inputs[key]={source:sourceId,key,value:clip(fallback(input)),raw:null,condition:'missing',publishedAt:null};continue;}
    const value=fit(input,raw);
    inputs[key]={source:sourceId,key,value:clip(value ?? fallback(input)),raw:clip(raw),condition:failed || value===undefined?'error':'fresh',
     publishedAt:Math.round(wallOffsetMs+source.monotonicMs)};
   }
  }
  instances.push({id:p.id,asset:p.asset,ref:p.ref,source:sourceId,status:status==='ok' || status==='error'?status:null,
   error:typeof error==='string'?error.slice(0,256):null,stale:Object.values(inputs).some(i=>i.condition==='error'),inputs});
 }
 return {instances};
}

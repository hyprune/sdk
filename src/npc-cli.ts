// `hyprune npc list|spawn|disable|enable|remove` and `hyprune path list`: characters and
// paths over IPC 0.23 (RFC-0011 P2). Thin wrappers: the state's character instances,
// npcs.spawn/disable/remove and paths.list.
import {parseArgs} from 'node:util';
import {clientFromEnvironment} from './launch.js';
import {atLeast,PROTOCOLS,type Protocol} from './validation.js';
import type {HypruneClient} from './client.js';
import type {Ipc23_ObjectInstance,Ipc23_PathRecord,Ipc23_NpcsSpawnParams} from './generated.js';

/** The first IPC version with characters and paths; the CLI asks for it unless told otherwise. */
export const NPCS_SINCE='0.23';
export const npcHelp=`hyprune npc list [--json]
hyprune npc spawn <ref> [--path route] [--phase 0..1] [--speed 0.25..2] [--accent r,g,b] [--reverse]
hyprune npc disable|enable <id>
hyprune npc remove <id> | --all
hyprune path list [--json]

<ref> is a character's catalog ref (package/<id>, library/<id>@<version>/<object>, user/<id>);
--path is a route (package/<id>, user/<id>; a bare id means package/<id>). Without --path the
character stands in front of the player. Common: [--socket path] [--protocol 0.23];
spawn, disable, enable and remove need objects.control.`;

const number=(flag:string,text:string|undefined,min:number,max:number,open=false):number|undefined=>{
 if(text===undefined) return undefined;
 const n=Number(text);if(!Number.isFinite(n) || n<min || (open?n>=max:n>max)) throw new Error(`--${flag} must be ${min}..${max}${open?' (exclusive)':''}`);
 return n;
};
/** npcs.spawn params from `npc spawn` flags. */
export function spawnParams(ref:string|undefined,flags:{path?:string;phase?:string;speed?:string;accent?:string;reverse?:boolean}):Ipc23_NpcsSpawnParams {
 if(!ref) throw new Error('npc spawn needs a character ref, e.g. library/com.hyprune.starter@0.1.0/resident-blue');
 if(flags.reverse && !flags.path) throw new Error('--reverse needs --path');
 const params:Ipc23_NpcsSpawnParams={ref};
 if(flags.path) params.path=flags.path;
 const phase=number('phase',flags.phase,0,1,true),speed=number('speed',flags.speed,0.25,2);
 if(phase!==undefined) params.phase=phase;
 if(speed!==undefined) params.speed=speed;
 if(flags.accent!==undefined){
  const rgb=flags.accent.split(',').map(Number);
  if(rgb.length!==3 || rgb.some(v=>!Number.isFinite(v) || v<0 || v>1)) throw new Error('--accent takes three numbers 0..1, e.g. 0.9,0.4,0.1');
  params.accent=rgb as [number,number,number];
 }
 if(flags.reverse) params.reverse=true;
 return params;
}
/** One line per character instance: id, source, state, activity, binding and name. */
export function npcTable(instances:Ipc23_ObjectInstance[]):string {
 const characters=instances.filter(i=>i.character);
 if(!characters.length) return 'no characters';
 const width=Math.max(...characters.map(c=>c.id.length));
 return characters.map(c=>{
  const where=c.path?`on ${c.path}`:c.seat?`seated ${c.seat}`:`standing at ${c.pose.position.map(v=>Math.round(v*100)/100).join(',')}`;
  return `${c.id.padEnd(width)}  ${c.source.padEnd(8)}  ${c.state.padEnd(9)}  ${(c.activity || '-').padEnd(11)}  ${c.name}  ${where}`;
 }).join('\n');
}
/** One line per path: ref, use, walkability, points, bound characters and name. */
export function pathTable(paths:Ipc23_PathRecord[]):string {
 if(!paths.length) return 'no paths';
 const width=Math.max(...paths.map(p=>p.ref.length));
 return paths.map(p=>{
  const walk=p.walkable===null?'-':p.walkable?'walkable':'unwalkable';
  return `${p.ref.padEnd(width)}  ${p.use.padEnd(7)}  ${walk.padEnd(10)}  ${String(p.points.length).padStart(3)} points  ${p.name ?? ''}${p.bound.length?`  [${p.bound.join(', ')}]`:''}${p.problems.length?`  (${p.problems[0]})`:''}`;
 }).join('\n');
}

export async function npcMain(argv:string[]):Promise<void> {
 const [group,verb]=argv;
 const {values:v,positionals:p}=parseArgs({args:argv.slice(2),allowPositionals:true,options:{
  help:{type:'boolean',short:'h'},socket:{type:'string'},protocol:{type:'string'},json:{type:'boolean'},
  path:{type:'string'},phase:{type:'string'},speed:{type:'string'},accent:{type:'string'},reverse:{type:'boolean'},all:{type:'boolean'}}});
 if(v.help){console.log(npcHelp);return;}
 const out=(value:unknown,text:string)=>console.log(v.json?JSON.stringify(value,null,2):text);
 const known=group==='npc' && ['list','spawn','disable','enable','remove'].includes(verb) || group==='path' && verb==='list';
 if(!known) throw new Error(`Unknown command: ${group} ${verb}\n${npcHelp}`);
 // Check arguments before connecting.
 const spawn=verb==='spawn'?spawnParams(p[0],v):undefined;
 if((verb==='disable' || verb==='enable') && !p[0]) throw new Error(`npc ${verb} needs a character id`);
 if(verb==='remove' && !p[0]===!v.all) throw new Error('npc remove needs a character id or --all');
 const protocol=v.protocol || process.env.HYPRUNE_PROTOCOL || NPCS_SINCE;
 if(!(PROTOCOLS as readonly string[]).includes(protocol) || !atLeast(protocol,NPCS_SINCE)) throw new Error(`Characters and paths need IPC ${NPCS_SINCE} or newer (got ${protocol})`);
 if(v.socket) process.env.HYPRUNE_SOCKET=v.socket;
 const capabilities=verb==='list'?['state.read']:['state.read','objects.control'];
 const client=clientFromEnvironment({protocol:protocol as Protocol,capabilities:capabilities as any}) as unknown as HypruneClient<'0.23'>;
 const signal=()=>client.close();process.once('SIGINT',signal);process.once('SIGTERM',signal);
 try {
  await client.connect();
  if(group==='path'){const r=await client.call('paths.list',{});return out(r,pathTable(r.paths));}
  if(spawn){const r=await client.call('npcs.spawn',spawn);return out(r,`spawned ${r.id}`);}
  if(verb==='disable' || verb==='enable'){const r=await client.call('npcs.disable',{id:p[0],disabled:verb==='disable'});return out(r,`${verb}d ${p[0]}`);}
  if(verb==='remove'){const r=await client.call('npcs.remove',v.all?{all:true}:{id:p[0]});return out(r,v.all?'removed every user character':`removed ${p[0]}`);}
  const {state}=await client.subscribe(),characters=state.objects.instances.filter(i=>i.character);
  return out({npcs:state.npcs,characters},npcTable(characters));
 } finally {client.close();process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
}

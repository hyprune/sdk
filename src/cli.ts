#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync} from 'node:fs';
import {validateWorld,packWorld} from './world.js';
import {validateObject,validateLibrary,validateMotionPack,type ObjectMeasured} from './object.js';
import {scaffold,type ExtensionType} from './scaffold.js';
import {clientFromEnvironment} from './launch.js';
import {socketPath} from './paths.js';
import {validateWire} from './validation.js';
import {parseJson} from './codec.js';
import {questMain,questHelp} from './quest-cli.js';
import {objectMain,objectHelp} from './object-cli.js';
import {npcMain,npcHelp} from './npc-cli.js';
import {registryMain,registryHelp,isRegistryCommand} from './registry-cli.js';
import {builderMain,builderHelp} from './builder-cli.js';
const help=`hyprune world validate <dir>\nhyprune world pack <dir> [--output file.tar.zst]\n${registryHelp}\nhyprune object check <dir> [--measured measured.json]\nhyprune library check <dir>\nhyprune motion check <dir>\n${objectHelp}\n${builderHelp}\n${npcHelp}\nhyprune ext new <screen-type|widget|movement-mode|integration> [dir] [--id org.example.id]\nhyprune ipc call <method> [JSON params] [--socket path] [--protocol 0.3|0.2|0.1]\nhyprune ipc subscribe [--socket path] [--count N]\nhyprune doctor [--socket path]\n${questHelp}\n\nAuthentication: supervisor supplies HYPRUNE_TOKEN_FD (>=3), HYPRUNE_CLIENT_ID, HYPRUNE_SOCKET.\nNo tokens on the command line. Use hyprune-mock --launch for developer grants.`;
export async function main(argv=process.argv.slice(2)):Promise<void> {
 if(argv[0]==='quest' || argv[0]==='focus') return questMain(argv);
 if(isRegistryCommand(argv)) return registryMain(argv);
 if(argv[0]==='object' && ['add','list','import'].includes(argv[1])) return objectMain(argv);
 if(argv[0]==='npc' || argv[0]==='path') return npcMain(argv);
 if(argv[0]==='builder') return builderMain(argv);
 const {values:v,positionals:p}=parseArgs({args:argv,allowPositionals:true,options:{help:{type:'boolean',short:'h'},socket:{type:'string'},protocol:{type:'string'},output:{type:'string'},measured:{type:'string'},id:{type:'string'},count:{type:'string'},capabilities:{type:'string'}}});
 if(v.help || !p.length) {console.log(help);return;}
 if(v.protocol) process.env.HYPRUNE_PROTOCOL=v.protocol;
 const [group,verb,arg,extra]=p;
 if(group==='world' && ['validate','pack'].includes(verb) && arg) {
  const result=verb==='validate'?await validateWorld(arg):await packWorld(arg,v.output);console.log(JSON.stringify(result,null,2));return;
 }
 // RFC-0011: an object directory (optionally with import-tool measurements) or a library.
 if(group==='object' && verb==='check' && arg) {
  let measured:ObjectMeasured|undefined;
  if(v.measured) {
   const value=parseJson(readFileSync(v.measured,'utf8'));
   if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('--measured must be a JSON object ({bounds, maxTextureSize, gpuBytes})');
   measured=value as ObjectMeasured;
  }
  console.log(JSON.stringify(await validateObject(arg,{measured}),null,2));return;
 }
 if(group==='library' && verb==='check' && arg) {console.log(JSON.stringify(await validateLibrary(arg),null,2));return;}
 // The shared clip library (draft): a motion pack directory (motion.json and its rigs).
 if(group==='motion' && verb==='check' && arg) {const {manifest,...rest}=await validateMotionPack(arg);console.log(JSON.stringify({id:manifest.id,skeleton:manifest.skeleton.id,...rest},null,2));return;}
 if(group==='ext' && verb==='new' && arg) {console.log(scaffold(arg as ExtensionType,extra || arg,v.id));return;}
 if(group==='ipc' && ['call','subscribe'].includes(verb)) {
  if(v.socket) process.env.HYPRUNE_SOCKET=v.socket;if(v.protocol) process.env.HYPRUNE_PROTOCOL=v.protocol;
  const caps=(v.capabilities || 'state.read').split(',').filter(Boolean);
  validateWire({jsonrpc:'2.0',id:'config',method:'session.hello',params:{protocols:[process.env.HYPRUNE_PROTOCOL || '0.2'],client:{id:process.env.HYPRUNE_CLIENT_ID || 'com.hyprune.sdk',name:'CLI'},capabilities:caps}},(process.env.HYPRUNE_PROTOCOL || '0.2') as '0.3'|'0.2'|'0.1');
  const client=clientFromEnvironment({capabilities:caps as any});
  const signal=()=>client.close();process.once('SIGINT',signal);process.once('SIGTERM',signal);
  try {
   await client.connect();
   if(verb==='call') {
    if(!arg) throw new Error('ipc call requires a method');const params=extra?parseJson(extra):{};
    const result=await client.call(arg as any,params as any);
    console.log(JSON.stringify(result,null,2));
   }else {
    const count=v.count===undefined?Infinity:Number(v.count);if(count!==Infinity && (!Number.isInteger(count) || count<1)) throw new Error('--count must be a positive integer');
    await new Promise<void>((resolve,reject)=>{
     let emitted=0;client.on('state',s=>{console.log(JSON.stringify({event:'state',snapshot:s}));if(++emitted>=count) resolve();});
     client.on('notification',m=>console.log(JSON.stringify(m)));client.once('disconnect',resolve);client.on('fault',reject);client.subscribe().catch(reject);
    });
   }
  }finally{client.close();process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}return;
 }
 if(group==='doctor') {
  const checks:Array<{check:string;ok:boolean;detail:string}>=[];
  checks.push({check:'node',ok:Number(process.versions.node.split('.')[0])>=22,detail:process.version});
  for(const command of ['tar','zstd']) {try{const text=execFileSync(command,['--version'],{encoding:'utf8'});checks.push({check:command,ok:true,detail:text.split('\n')[0]});}catch{checks.push({check:command,ok:false,detail:'Required for world pack'});}}
  const source=JSON.parse(readFileSync(new URL('../vendor/schema/source.json',import.meta.url),'utf8'));checks.push({check:'schema pin',ok:true,detail:source.commit});
  try {
   const path=v.socket || process.env.HYPRUNE_SOCKET || socketPath(),st=lstatSync(path);const ok=st.isSocket() && st.uid===process.getuid?.() && (st.mode&0o777)===0o600;
   checks.push({check:'socket ownership/mode',ok,detail:path});
   if(ok) {const client=clientFromEnvironment({socket:path,capabilities:[]});try{await client.connect();const ping=await client.call('session.ping',{});checks.push({check:'IPC hello/ping',ok:true,detail:`${client.hello?.protocol}, ${ping.monotonicMs}ms`});}finally{client.close();}}
  }catch(e:any){checks.push({check:'session IPC',ok:false,detail:e.message});}
  console.log(JSON.stringify({ok:checks.every(c=>c.ok),checks},null,2));if(checks.some(c=>!c.ok)) process.exitCode=1;return;
 }
 throw new Error('Unknown/incomplete command.\n'+help);
}
main().catch(e=>{console.error('hyprune: '+e.message);process.exitCode=1;});

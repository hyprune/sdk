// `hyprune source|world|library|install|update|rollback|pin|unpin|remove|browse|installed|
// content|registry` (RFC-0015 CLI, DESIGN "CLI JSON contract"). Jobs with --json print JSON
// lines on stdout and nothing else; listings print one JSON document. Exit codes: 0 ok,
// 1 failure, 2 usage, 3 refused by a rule.
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {RegistryError} from './registry/errors.js';
import {listSources,addSource,refreshSource,labelSource,enableSource,removeSource,findSource,readCachedIndex,CUSTOM_NOTICE,type Context} from './registry/sources.js';
import {install,update,rollback,setPin,remove,type JobOptions,type JobEvent,type Plan} from './registry/install.js';
import {sourceList,browse,contentList} from './registry/list.js';
import {contentLock} from './registry/lock.js';
import {writeFileSync} from 'node:fs';
import {packRelease,packLibrary} from './registry/pack.js';
import {entryFromDirectory,entryFromGithub} from './registry/entry.js';
import {checkEntry,type Tombstone} from './registry/check.js';
import {githubClient} from './registry/github.js';
import {openSession,type Session} from './registry/session.js';
import {contentRoots} from './registry/paths.js';
import {packWorld} from './world.js';
import {parseJson} from './codec.js';
import {socketPath} from './paths.js';
import {libraryInstallParams,objectMain} from './object-cli.js';
import type {PackageType} from './registry/archive.js';

export const registryHelp=`hyprune world|library add <id[@tag] | github:owner/repo[/name][@tag] | https://…/x.release.json | https://…/x.tar.zst --sha256 HEX | ./x.tar.zst>
    [--from SOURCE] [--sha256 HEX] [--pin] [--override] [--track --label TEXT] [--pre-release] [--plan] [--yes] [--accept-source-change]
hyprune world|library list [--json] [--updates]      hyprune world|library info <id> [--json]
hyprune world|library update [<id>… | --all] [--dry-run] [--yes]
hyprune world|library rollback|pin|unpin <id>        hyprune world|library remove <id> [--force]  (library: also <id>@<version>)
hyprune world|library pack <dir> --release [--tag TAG] [--repo URL] [--commit SHA] [--thumbnail FILE]… [--output DIR]
hyprune library pack <dir> [--output file.tar.zst]
hyprune install|update|rollback|pin|unpin|remove …  (type taken from the entry)
hyprune browse [TEXT] [--type world|library] [--source ID] [--refresh] [--json]
hyprune installed [--json]   (= hyprune content list)
hyprune content lock [--output FILE]   (installed content at exact releases, for the Nix modules)
hyprune source add <url | github:owner/repo[/name]> [--label TEXT] [--id SLUG] [--sha256 HEX]
hyprune source list [--json] | refresh [ID…] | label <id> <text> | enable <id> | disable <id> | remove <id>
hyprune registry entry <dir | github:owner/repo[/name]@tag> [--existing entry.json] [--summary T] [--description T] [--tags a,b]
hyprune registry check <entry.json> [--existing old.json] [--removed dir] [--indexes official.json,community.json] [--author LOGIN] [--official]

Jobs take --json (JSON lines), --no-session (commit without a running session). Without --yes the
plan is confirmed on a terminal; without a terminal the job stops after the plan (exit 3).
Exit codes: 0 ok, 1 failure, 2 usage, 3 refused by a rule.`;

class UsageError extends Error {}
const usage=(m:string):never=>{throw new UsageError(m);};
const options={
 help:{type:'boolean',short:'h'},json:{type:'boolean'},yes:{type:'boolean',short:'y'},plan:{type:'boolean'},'dry-run':{type:'boolean'},
 'accept-source-change':{type:'boolean'},from:{type:'string'},sha256:{type:'string'},pin:{type:'boolean'},override:{type:'boolean'},
 track:{type:'boolean'},label:{type:'string'},id:{type:'string'},'pre-release':{type:'boolean'},force:{type:'boolean'},'no-session':{type:'boolean'},
 type:{type:'string'},source:{type:'string'},refresh:{type:'boolean'},all:{type:'boolean'},updates:{type:'boolean'},
 output:{type:'string'},release:{type:'boolean'},tag:{type:'string'},repo:{type:'string'},commit:{type:'string'},thumbnail:{type:'string',multiple:true},
 existing:{type:'string'},removed:{type:'string'},indexes:{type:'string'},author:{type:'string'},official:{type:'boolean'},
 summary:{type:'string'},description:{type:'string'},tags:{type:'string'},releases:{type:'string'},archive:{type:'string'},
 socket:{type:'string'},protocol:{type:'string'},verbose:{type:'boolean'},
} as const;
type Values=ReturnType<typeof parseArgs<{options:typeof options;allowPositionals:true}>>['values'];

const JOBS=new Set(['add','install','update','rollback','pin','unpin','remove']);
/** True when argv is a registry command (the dispatcher in cli.ts asks). */
export function isRegistryCommand(argv:string[]):boolean {
 const [group,verb]=argv;
 if(['source','sources','browse','installed','content','registry'].includes(group)) return true;
 if(JOBS.has(group)) return true;
 if(group==='world') return ['add','install','list','info','update','rollback','pin','unpin','remove'].includes(verb) || (verb==='pack' && argv.includes('--release'));
 if(group==='library') return ['add','install','list','info','update','rollback','pin','unpin','remove','pack'].includes(verb);
 return false;
}

const MiB=(n:number|null)=>n===null?'?':n>=1048576?`${(n/1048576).toFixed(1)} MiB`:`${(n/1024).toFixed(1)} KiB`;
const LICENCE:Record<string,string>={reviewed:'reviewed by Hyprune',declared:'declared by the creator, not reviewed',unchecked:'declared by the package, not checked'};
export function planText(plan:Plan):string {
 const lines=['Plan:'];
 for(const p of plan.packages) {
  const what=p.action==='already-installed'?'already installed':p.action==='update'?`update from ${p.replaces}`:p.action==='downgrade'?`downgrade from ${p.replaces}`:'install';
  lines.push(`  ${p.type} ${p.id} ${p.version}${p.tag?` (tag ${p.tag})`:''}: ${what}`);
  lines.push(`    Source: ${p.sourceLabel}${p.url && p.action!=='already-installed'?` (${p.url})`:''}`);
  if(p.creator || p.repo) lines.push(`    Creator: ${p.creator ?? '?'}${p.repo?`  Repository: ${p.repo}`:''}`);
  if(p.license) lines.push(`    Licence: ${p.license} · ${LICENCE[p.licenceNote]}`);
  if(p.action!=='already-installed') lines.push(`    Download ${MiB(p.bytes)}, installed ${MiB(p.expandedBytes)}, sha256 ${p.sha256?.slice(0,12)}…`);
 }
 if(plan.sourceChange) lines.push(`Source change: ${plan.sourceChange.id} is installed from ${plan.sourceChange.from.display}; this installs it from ${plan.sourceChange.to.display}.`);
 if(plan.override) lines.push('This replaces content managed by the system configuration with your own copy.');
 if(plan.diskFreeAfter!==null) lines.push(`Disk free after: ${MiB(plan.diskFreeAfter)}`);
 lines.push("Worlds and libraries contain no code. Installing doesn't run anything.");
 return lines.join('\n');
}
async function ask(question:string):Promise<boolean> {
 const rl=createInterface({input:process.stdin,output:process.stderr});
 try {return /^(y|yes)$/i.test((await rl.question(question)).trim());} finally {rl.close();}
}
function jobContext(v:Values,session:Session|null,type?:PackageType):JobOptions {
 const json=!!v.json,interactive=!json && !!process.stdin.isTTY && !!process.stderr.isTTY;
 let lastStage='';
 const emit=(e:JobEvent)=>{
  if(json) {process.stdout.write(JSON.stringify(e)+'\n');return;}
  if(e.event==='plan') process.stderr.write(planText(e.plan)+'\n');
  else if(e.event==='stage' && e.stage!==lastStage) {lastStage=e.stage;if(v.verbose || e.stage!=='resolving') process.stderr.write(`${e.stage}…\n`);}
  else if(e.event==='progress' && process.stderr.isTTY) process.stderr.write(`\r${MiB(e.bytes)} / ${MiB(e.total)}${e.bytes>=e.total?'\n':''}`);
 };
 return {type:type ?? (v.type as PackageType|undefined),from:v.from,sha256:v.sha256,pin:v.pin,override:v.override,track:v.track,label:v.label,
  yes:v.yes,acceptSourceChange:v['accept-source-change'],planOnly:v.plan || v['dry-run'],prerelease:v['pre-release'],force:v.force,session,emit,
  confirm:interactive?async(_plan,kind)=>kind==='source-change'?ask('Install from the other source? Type "yes" to confirm: ').then(ok=>ok):ask('Proceed? [y/N] '):undefined};
}
async function withSession<T>(v:Values,fn:(s:Session|null)=>Promise<T>):Promise<T> {
 if(v.socket) process.env.HYPRUNE_SOCKET=v.socket;
 if(v.protocol) process.env.HYPRUNE_PROTOCOL=v.protocol;
 const {session,reason}=v['no-session']?{session:null,reason:'--no-session'}:await openSession(process.env);
 if(v.verbose) process.stderr.write(`session: ${session?`connected (loaded world ${session.loadedWorld ?? 'none'}, libraries ${session.canInstallLibraries?'through core':'committed by the CLI'})`:reason}\n`);
 try {return await fn(session);} finally {session?.close();}
}
const print=(v:Values,value:unknown,text:string)=>console.log(v.json?JSON.stringify(value,null,2):text);
const ctxOf=():Context=>({});
const typeArg=(v:Values):PackageType|undefined=>{
 if(v.type===undefined) return undefined;
 if(v.type!=='world' && v.type!=='library') usage('--type is world or library');
 return v.type as PackageType;
};

async function job(v:Values,run:(o:JobOptions)=>Promise<unknown>,type?:PackageType,done?:(r:any)=>string):Promise<void> {
 await withSession(v,async session=>{
  const o=jobContext(v,session,type),inner=o.emit!;let finished=false;
  o.emit=e=>{if(e.event==='done') finished=true;inner(e);};
  const r:any=await run(o);
  // Jobs without their own events (rollback, pin, unpin, remove) end with one done line.
  if(v.json && !finished && r?.action!=='plan') process.stdout.write(JSON.stringify({event:'done',result:r})+'\n');
  if(!v.json && done) console.log(done(r));
 });
}
function summary(r:any):string {
 if(r.action==='plan') return `planned ${r.type} ${r.id} ${r.tag ?? r.version}`;
 if(r.action==='already-installed') return `${r.id} ${r.tag ?? r.version} is already installed`;
 return `${r.action==='install'?'installed':r.action==='update'?'updated':r.action==='downgrade'?'downgraded':r.action} ${r.type} ${r.id} ${r.tag ?? r.version}`;
}

async function sourceCommand(verb:string|undefined,p:string[],v:Values):Promise<void> {
 const ctx=ctxOf();
 if(verb==='list' || verb===undefined) {
  const doc=sourceList(ctx);
  return print(v,doc,doc.sources.map(s=>`${s.id.padEnd(16)} ${(s.enabled?'enabled':'disabled').padEnd(8)} ${String(s.entries).padStart(5)} entries  ${s.display}  ${s.url ?? s.repo}${s.error?`  (${s.error})`:''}`).join('\n'));
 }
 if(verb==='add') {
  if(!p[0]) usage('source add needs a URL or github:owner/repo');
  if(v.json) process.stdout.write(JSON.stringify({event:'stage',stage:'resolving'})+'\n');
  const {source,refresh}=await addSource(p[0],{label:v.label,id:v.id,sha256:v.sha256},ctx);
  if(v.json) process.stdout.write(JSON.stringify({event:'done',result:{...source,entries:refresh.entries,skipped:refresh.skipped ?? [],notice:CUSTOM_NOTICE}})+'\n');
  else {console.error(CUSTOM_NOTICE);console.log(`added ${source.id}: ${source.display} (${refresh.entries} entries)`);for(const s of refresh.skipped ?? []) console.error(`skipped ${s.tag}: ${s.reason}`);}
  return;
 }
 if(verb==='refresh') {
  const all=listSources(ctx),chosen=p.length?p.map(id=>findSource(id,ctx)):all.filter(s=>s.enabled);
  if(v.json) process.stdout.write(JSON.stringify({event:'stage',stage:'resolving'})+'\n');
  const results=[];for(const s of chosen) results.push(await refreshSource(s,ctx));
  if(v.json) process.stdout.write(JSON.stringify({event:'done',result:{refreshed:results}})+'\n');
  else for(const r of results) console.log(`${r.id}: ${r.error?`failed (${r.error})`:`${r.entries} entries, serial ${r.serial}`}`);
  if(results.some(r=>r.error)) process.exitCode=1;
  return;
 }
 if(verb==='label') {if(!p[0] || !p[1]) usage('source label <id> <text>');const s=labelSource(p[0],p.slice(1).join(' '),ctx);return print(v,s,`${s.id}: ${s.display}`);}
 if(verb==='enable' || verb==='disable') {if(!p[0]) usage(`source ${verb} <id>`);const s=enableSource(p[0],verb==='enable',ctx);return print(v,s,`${s.id}: ${verb}d`);}
 if(verb==='remove') {if(!p[0]) usage('source remove <id>');removeSource(p[0],ctx);return print(v,{removed:p[0]},`removed source ${p[0]} (installed content stays)`);}
 usage(`unknown source command ${verb}`);
}
function listCommand(v:Values,type?:PackageType):void {
 let doc=contentList(ctxOf(),{type});
 if(v.updates) doc={installs:doc.installs.filter((i:any)=>i.newerTag)};
 print(v,doc,doc.installs.length?doc.installs.map((i:any)=>`${i.type.padEnd(7)} ${i.id}  ${i.tag ?? i.version}${i.previous?` (previous ${i.previous.tag ?? i.previous.version})`:''}  ${i.display}${i.pinned?'  pinned':''}${i.newerTag?`  update: ${i.newerTag}`:''}${i.removedFromSource?'  removed from source':''}${i.managed==='system'?'  system':''}${i.missing?'  missing':''}`).join('\n'):'nothing installed');
}
function infoCommand(id:string|undefined,v:Values,type?:PackageType):void {
 if(!id) usage('info needs an id');
 const install=contentList(ctxOf(),{type}).installs.find((i:any)=>i.id===id);
 if(!install) throw new RegistryError('not.found',`${id} is not installed`);
 const record=JSON.parse(existsSync(join(contentRoots().state,'content.json'))?readFileSync(join(contentRoots().state,'content.json'),'utf8'):'{"installs":[]}').installs.find((r:any)=>r.id===id && r.type===install.type) ?? null;
 const entry=readCachedIndex(install.sourceId)?.entries.find(e=>e.id===id && e.type===install.type) ?? null;
 const info={...install,record,entry};
 print(v,info,[`${install.type} ${id} ${install.tag ?? install.version}`,`  Source: ${install.display}`,`  Licence: ${install.license ?? '?'}`,
  ...(record?.current.url?[`  From: ${record.current.url}`]:[]),...(record?.current.sha256?[`  sha256: ${record.current.sha256}`]:[]),
  ...(entry?[`  Creator: ${entry.creator}${entry.repo?`  Repository: ${entry.repo}`:''}`]:[]),
  ...(install.previous?[`  Previous: ${install.previous.tag ?? install.previous.version}`]:[]),`  Pinned: ${install.pinned?'yes':'no'}`,`  Path: ${install.path}`].join('\n'));
}
async function updateCommand(p:string[],v:Values,type?:PackageType):Promise<void> {
 if(!p.length && !v.all) usage('update needs ids or --all');
 await withSession(v,async session=>{
  const o=jobContext(v,session,type),inner=o.emit!;
  // Several updates end with one aggregated done event.
  if(v.all || p.length!==1) o.emit=e=>{if(e.event!=='done') inner(e);};
  const results=await update(p,{...o,all:v.all});
  if(v.json && (v.all || p.length!==1)) process.stdout.write(JSON.stringify({event:'done',result:{action:'update',results}})+'\n');
  else if(v.json && results[0]?.status!=='updated' && results[0]?.status!=='planned') process.stdout.write(JSON.stringify({event:'done',result:{id:results[0].id,type:results[0].type,tag:results[0].tag,action:'update',status:results[0].status,newerTag:results[0].newerTag,...(results[0].reason?{reason:results[0].reason}:{})}})+'\n');
  if(!v.json) for(const r of results) console.log(`${r.id}: ${r.status}${r.newerTag?` ${r.status==='pinned'?`(newer ${r.newerTag})`:r.newerTag}`:''}${r.reason?` (${r.reason})`:''}`);
 });
}
async function registryCommand(verb:string|undefined,p:string[],v:Values):Promise<void> {
 if(verb==='entry') {
  if(!p[0]) usage('registry entry <dir | github:owner/repo@tag>');
  const existing=v.existing?parseJson(readFileSync(v.existing,'utf8')) as any:undefined;
  const o={existing,summary:v.summary,description:v.description,tags:v.tags?.split(',').filter(Boolean),id:v.id};
  const entry=p[0].startsWith('github:')?await entryFromGithub(p[0],o):entryFromDirectory(p[0],o);
  console.log(JSON.stringify(entry,null,2));return;
 }
 if(verb==='check') {
  if(!p[0]) usage('registry check <entry.json>');
  const value=parseJson(readFileSync(p[0],'utf8'));
  const existing=v.existing?parseJson(readFileSync(v.existing,'utf8')) as any:undefined;
  const removed:Tombstone[]=v.removed?readdirSync(v.removed).filter(n=>n.endsWith('.json')).map(n=>parseJson(readFileSync(join(v.removed!,n),'utf8')) as Tombstone):[];
  const indexes=(v.indexes?.split(',').filter(Boolean) ?? []).map(f=>parseJson(readFileSync(f,'utf8')) as any);
  const report=await checkEntry(value,{github:githubClient(),author:v.author,fileName:p[0],existing,removed,indexes,tier:v.official?'official':'community'});
  print(v,report,[...report.results.map(r=>`${r.ok?(r.skipped?'skip':'ok  '):'FAIL'} ${String(r.check).padStart(2)} ${r.name}${r.skipped?` (${r.skipped})`:''}${r.errors.length?'\n'+r.errors.map(e=>`       ${e}`).join('\n'):''}`),
   ...report.warnings.map(w=>`warning: ${w}`),report.ok?'all checks passed':'checks failed'].join('\n'));
  if(!report.ok) process.exitCode=1;
  return;
 }
 usage(`unknown registry command ${verb}`);
}
async function packCommand(type:PackageType,dir:string|undefined,v:Values):Promise<void> {
 if(!dir) usage(`${type} pack needs a directory`);
 if(!v.release) {const r=type==='world'?await packWorld(dir!,v.output):await packLibrary(dir!,v.output);console.log(JSON.stringify(r,null,2));return;}
 const r=await packRelease(dir!,{type,tag:v.tag,repo:v.repo,commit:v.commit,output:v.output,thumbnails:v.thumbnail});
 const {recordValue,...files}=r;
 console.log(JSON.stringify({...files,record:r.record,id:recordValue.id,version:recordValue.version},null,2));
}

/** Entry point for registry commands; sets process.exitCode (2 usage, 3 rule refusals, 1 failures). */
export async function registryMain(argv:string[]):Promise<void> {
 let v:Values;
 try {
  const parsed=parseArgs({args:argv,allowPositionals:true,options});v=parsed.values;
  const p=parsed.positionals;
  if(v.help) {console.log(registryHelp);return;}
  let [group,verb,...rest]=p;
  if(group==='sources') group='source';
  if(group==='installed') {group='content';verb='list';}
  if(group==='source') return await sourceCommand(verb,rest,v);
  if(group==='content' && verb==='lock') {
   const {lock,skipped}=contentLock(ctxOf());
   for(const s of skipped) console.error(`skipped ${s.type} ${s.id}: ${s.reason}`);
   const text=JSON.stringify(lock,null,2)+'\n';
   if(v.output) {writeFileSync(v.output,text);if(!v.json) console.error(`wrote ${lock.packages.length} packages to ${v.output}`);}
   else process.stdout.write(text);
   return;
  }
  if(group==='content') {if(verb!=='list') usage('content list|lock [--json]');return listCommand(v,typeArg(v));}
  if(group==='browse') {
   if(v.refresh) for(const s of listSources(ctxOf()).filter(s=>s.enabled)) await refreshSource(s,ctxOf());
   const doc=browse({text:[verb,...rest].filter(Boolean).join(' ') || undefined,type:typeArg(v),source:v.source},ctxOf());
   return print(v,doc,doc.entries.length?doc.entries.map(e=>`${e.type.padEnd(7)} ${e.id}  ${e.latest?.tag ?? '-'}  ${e.name}  [${e.display}]${e.installed?`  installed ${e.installed.tag ?? ''}`:''}${e.update?`  update: ${e.update}`:''}${e.latest && !e.latest.loadable?'  needs a newer Hyprune':''}`).join('\n'):'no entries (hyprune source refresh)');
  }
  if(group==='registry') return await registryCommand(verb,rest,v);
  let type:PackageType|undefined;
  if(group==='world' || group==='library') {type=group;group=verb;rest=[...rest];verb=rest.shift() as string;}
  else type=typeArg(v);
  const target=verb,args=[verb,...rest].filter(Boolean);
  switch(group) {
   case 'add': case 'install': {
    // `library install` with a local archive or a releases record keeps its RFC-0011 behaviour:
    // no confirmation step and the `installed <id>@<version>` line.
    const legacy=group==='install' && type==='library' && (!!v.releases || /\.tar\.zst$/.test(target ?? ''));
    const legacyText=(r:any)=>`installed ${r.id}@${r.version}`;
    if(type==='library' && v.releases) {
     const params=await libraryInstallParams(target,{releases:v.releases,archive:v.archive});
     return await job({...v,yes:true,sha256:params.sha256},o=>install(params.archive,o),type,legacyText);
    }
    if(legacy) return await job({...v,yes:true},o=>install(target,o),type,legacyText);
    if(v.archive || v.releases) usage('--releases and --archive apply to library install <id>@<version>');
    if(!target) usage(`${group} needs a package: an id, github:owner/repo, a URL or a local .tar.zst`);
    return await job(v,o=>install(target,o),type,summary);
   }
   case 'list': {
    // With a running session `library list` keeps showing core's libraries.list (as before).
    if(type==='library' && !v.updates && !v['no-session'] && sessionSocket(v)) return objectMain(['library','list',...(v.json?['--json']:[]),...(v.socket?['--socket',v.socket]:[]),...(v.protocol?['--protocol',v.protocol]:[])]);
    return listCommand(v,type);
   }
   case 'info': return infoCommand(target,v,type);
   case 'update': return await updateCommand(args,v,type);
   case 'rollback': if(!target) usage('rollback <id>');return await job(v,o=>rollback(target,o),type,r=>`rolled back ${r.id} to ${r.tag ?? r.version} (pinned)`);
   case 'pin': case 'unpin': if(!target) usage(`${group} <id>`);return await job(v,o=>setPin(target,group==='pin',o),type,r=>`${r.pinned?'pinned':'unpinned'} ${r.id} at ${r.tag ?? r.version}`);
   case 'remove': if(!target) usage('remove <id>');return await job(v,o=>remove(target,o),type,r=>`removed ${r.removed.join(', ')}`);
   case 'pack': return await packCommand(type ?? usage('pack needs world or library'),target,v);
  }
  usage(`unknown command ${p.join(' ')}`);
 } catch(e:any) {
  const json=argv.includes('--json');
  if(e instanceof UsageError || e?.code==='ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code==='ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || e?.code==='ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
   console.error(`hyprune: ${e.message}\n${registryHelp}`);process.exitCode=2;return;
  }
  const error=e instanceof RegistryError?e:new RegistryError('fetch.failed',e?.message ?? String(e));
  const rule=e instanceof RegistryError?e.rule:null;
  if(json && isJob(argv)) process.stdout.write(JSON.stringify({event:'error',error:{rule:rule ?? 'failed',message:error.message}})+'\n');
  else console.error(`hyprune: ${rule?`${rule}: `:''}${error.message}`);
  process.exitCode=e instanceof RegistryError?e.exitCode:1;
 }
}
function isJob(argv:string[]):boolean {
 const [g,verb]=argv,second=g==='world' || g==='library'?verb:g;
 return JOBS.has(second) || (g==='source' || g==='sources') && (verb==='add' || verb==='refresh') || second==='update';
}
function sessionSocket(v:Values):boolean {
 try {return existsSync(v.socket || process.env.HYPRUNE_SOCKET || socketPath());} catch {return false;}
}

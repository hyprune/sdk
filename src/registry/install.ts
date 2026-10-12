// The install pipeline (RFC-0015 "Install pipeline", DESIGN phase-1 shape): resolve → plan →
// confirm → download → verify → extract → validate → commit, for worlds and libraries from any
// source, plus update, rollback, pin and remove. Runs under the content lock; nothing is
// downloaded before the plan is confirmed except index and release metadata.
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,renameSync,rmSync,statfsSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fail,RegistryError} from './errors.js';
import {download,sha256File,type Progress} from './fetch.js';
import {extractArchive,limitsFor,ANY_LIMITS,type PackageType} from './archive.js';
import {newestInstallable,newerThan,loadable,available,type IndexEntry,type IndexVersion,type IndexDocument} from './index.js';
import {compareSemver,matchTag,isPrerelease} from './semver.js';
import {listSources,findSource,refreshSource,readCachedIndex,cachedEntries,addSource,fetchSource,display,licenceNote,readManifest,libraryRefs,
 rootsOf,type Source,type Context} from './sources.js';
import {withLock,findRecord,putRecord,dropRecord,writeContent,scanWorlds,scanLibraries,requiredLibraries,
 type ContentFile,type InstallRecord,type InstallState} from './content.js';
import {parseGithub,githubRepoUrl} from './github.js';
import {allowedUrl} from './fetch.js';
import type {Session} from './session.js';
import {validateWorld} from '../world.js';
import {validateLibrary} from '../object.js';

export type Action='install'|'update'|'downgrade'|'already-installed';
export interface PlanPackage {
 id:string;type:PackageType;tag:string|null;version:string;formatVersion:string|null;replaces:string|null;
 sourceId:string;sourceLabel:string;creator:string|null;repo:string|null;license:string|null;licenceNote:'reviewed'|'declared'|'unchecked';
 bytes:number|null;expandedBytes:number|null;sha256:string|null;url:string|null;action:Action;requires:string[];
}
export interface Plan {
 packages:PlanPackage[];
 sourceChange:null|{id:string;from:{sourceId:string;display:string};to:{sourceId:string;display:string}};
 /** True when the main package replaces system-managed content (needs --override). */
 override:boolean;
 diskFreeAfter:number|null;
}
export type JobEvent={event:'stage';stage:string}|{event:'plan';plan:Plan}|{event:'progress';bytes:number;total:number}|
 {event:'done';result:Record<string,unknown>}|{event:'error';error:{rule:string;message:string}};
export interface JobOptions extends Context {
 type?:PackageType;from?:string;sha256?:string;pin?:boolean;override?:boolean;track?:boolean;label?:string;
 yes?:boolean;acceptSourceChange?:boolean;planOnly?:boolean;prerelease?:boolean;force?:boolean;
 session?:Session|null;
 /** Interactive confirmation (TTY): `kind` says what is asked. Without it, --yes/--accept-source-change decide. */
 confirm?:(plan:Plan,kind:'plan'|'source-change'|'override')=>Promise<boolean>;
 emit?:(event:JobEvent)=>void;
}
export interface JobResult {id:string;type:PackageType;tag:string|null;version:string;action:Action|'rollback'|'pin'|'unpin'|'remove'|'plan';sourceId?:string;pinned?:boolean;path?:string;removed?:string[]}

const now=()=>new Date().toISOString().replace(/\.\d+Z$/,'Z');
interface SourceRef {id:string;kind:Source['kind'];display:string}
/** The source of a one-off github: or URL install (not added as a source): recorded by its spec. */
const oneOff=(spec:string,label:string):SourceRef=>({id:spec,kind:'url',display:display({kind:'url',label})});
function sourceRef(id:string,ctx:Context):SourceRef {
 const s=listSources(ctx).find(s=>s.id===id);
 if(s) return {id:s.id,kind:s.kind,display:s.display};
 if(id==='local') return {id,kind:'url',display:'Local'};
 if(id==='file') return {id,kind:'url',display:'File'};
 if(id.startsWith('github:')) return oneOff(id,id.slice(7).split('/').slice(0,2).join('/'));
 if(id.startsWith('https:') || id.startsWith('http:')) {try {return oneOff(id,new URL(id).host);} catch {}}
 return {id,kind:'url',display:`Custom: ${id}`};
}

interface Resolved {source:SourceRef;entry:IndexEntry;version:IndexVersion;index:IndexDocument|null}
/** Split `<spec>[@tag]`: the last @ after the spec's own syntax (URLs and paths take no tag). */
export function splitTarget(target:string):{spec:string;tag:string|null} {
 if(/^https?:\/\//.test(target) || target.includes('/') && !target.startsWith('github:')) return {spec:target,tag:null};
 const at=target.lastIndexOf('@');
 return at>0?{spec:target.slice(0,at),tag:target.slice(at+1) || null}:{spec:target,tag:null};
}
function pickVersion(entry:IndexEntry,tag:string|null,prerelease:boolean):IndexVersion {
 if(tag) {
  const v=matchTag(entry.versions,tag);
  if(!v) fail('not.found',`${entry.id} has no tag ${tag} (tags: ${entry.versions.map(v=>v.tag).join(', ')})`);
  if(!available(v!)) fail('not.found',`${entry.id} ${v!.tag} is unavailable at its source`);
  if(!loadable(entry.type,v!.formatVersion)) fail('format.unsupported',`${entry.id} ${v!.tag} uses ${entry.type} format ${v!.formatVersion}: needs a newer Hyprune`);
  return v!;
 }
 const best=newestInstallable(entry,{prerelease});
 if(best) return best;
 if(entry.versions.some(v=>available(v) && !loadable(entry.type,v.formatVersion))) fail('format.unsupported',`${entry.id}: every available version needs a newer Hyprune`);
 return fail('not.found',`${entry.id}: no installable version${prerelease?'':' (pre-releases need an explicit tag or --pre-release)'}`);
}
/** Make sure every enabled source has a cache (indexes are metadata: allowed before confirmation). */
async function ensureCaches(ctx:Context,force=false):Promise<void> {
 for(const s of listSources(ctx)) if(s.enabled && (force || !readCachedIndex(s.id,ctx))) await refreshSource(s,ctx);
}
async function resolveId(id:string,tag:string|null,opts:JobOptions,doc:ContentFile):Promise<Resolved> {
 const lookup=()=>cachedEntries(opts).filter(c=>c.entry.id===id && (!opts.type || c.entry.type===opts.type) && (!opts.from || c.source.id===opts.from));
 if(opts.from) {const s=findSource(opts.from,opts);if(!s.enabled) fail('source.invalid',`${s.display} is disabled (hyprune source enable ${s.id})`);}
 await ensureCaches(opts);
 let found=lookup();
 if(!found.length) {await ensureCaches(opts,true);found=lookup();}
 if(!found.length) fail('not.found',`${id} is not listed by ${opts.from?`source ${opts.from}`:'any enabled source'}`);
 if(found.length>1) {
  const installed=findRecord(doc,id,found[0].entry.type);
  const same=installed && found.find(c=>c.source.id===installed.source);
  if(!same) fail('source.invalid',`${id} is listed by several sources (${found.map(c=>`${c.source.id}: ${c.source.display}`).join(', ')}); pass --from SOURCE`);
  found=[same!];
 }
 const {source,entry}=found[0];
 return {source:{id:source.id,kind:source.kind,display:source.display},entry,version:pickVersion(entry,tag,!!opts.prerelease),index:readCachedIndex(source.id,opts) ?? null};
}
async function resolveTarget(target:string,opts:JobOptions,doc:ContentFile):Promise<Resolved> {
 const {spec,tag}=splitTarget(target);
 if(spec.startsWith('github:') || /^https?:\/\//.test(spec)) {
  if(opts.track) {
   const {source}=await addSource(spec,{label:opts.label,sha256:opts.sha256},opts);
   const idx=readCachedIndex(source.id,opts)!;
   const entry=pickEntry(idx,spec,opts);
   return {source:{id:source.id,kind:source.kind,display:source.display},entry,version:pickVersion(entry,tag,!!opts.prerelease),index:idx};
  }
  let ref:SourceRef,source:{kind:'github'|'url';repo?:string;url?:string;sha256?:string};
  if(spec.startsWith('github:')) {
   const g=parseGithub(spec);source={kind:'github',repo:`${g.owner}/${g.repo}${g.name?'/'+g.name:''}`};
   ref=oneOff(`github:${source.repo}`,`${g.owner}/${g.repo}`);
  } else {
   if(!allowedUrl(spec,opts.env ?? process.env)) fail('source.invalid',`${spec}: only https:// URLs`);
   const archive=new URL(spec).pathname.endsWith('.tar.zst');
   if(archive && !opts.sha256) fail('source.invalid','an archive URL needs --sha256 (every install is pinned)');
   if(!archive && !new URL(spec).pathname.endsWith('.json')) fail('source.invalid',`${spec}: expected a .tar.zst archive (with --sha256) or a .release.json record`);
   source={kind:'url',url:spec,...(archive?{sha256:opts.sha256}:{})};ref=oneOff(spec,new URL(spec).host);
  }
  const {index}=await fetchSource(source,opts);
  const entry=pickEntry(index,spec,opts);
  return {source:ref,entry,version:pickVersion(entry,tag,!!opts.prerelease),index};
 }
 if(!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(spec)) fail('source.invalid',`${target}: expected <id>[@tag], github:owner/repo[/name][@tag], an https:// URL or a local .tar.zst`);
 return resolveId(spec,tag,opts,doc);
}
function pickEntry(index:IndexDocument,spec:string,opts:JobOptions):IndexEntry {
 const entries=index.entries.filter(e=>!opts.type || e.type===opts.type);
 if(!entries.length) fail('not.found',`${spec}: no ${opts.type ?? 'package'} release follows the release convention`);
 if(entries.length>1) fail('source.invalid',`${spec} publishes several packages (${entries.map(e=>e.id).join(', ')}); name one: github:owner/repo/<name> or add the source and install by id`);
 return entries[0];
}

const presentLibrary=(ctx:Context,id:string,version:string)=>scanLibraries(rootsOf(ctx)).find(l=>l.id===id && l.version===version);
function actionFor(record:InstallRecord|undefined,presentVersion:string|null,version:IndexVersion,id:string):Action {
 if(record?.current.tag===version.tag) {
  if(record.current.sha256 && record.current.sha256!==version.sha256)
   fail('content.conflict',`replaced asset: ${id} ${version.tag} was installed with sha256 ${record.current.sha256}; its source now pins ${version.sha256}. Published assets are immutable: refused`);
  return 'already-installed';
 }
 const current=record?.current.version ?? presentVersion;
 if(current===null) return 'install';
 const order=compareSemver(version.version,current);
 return order<0?'downgrade':'update';
}
function planPackage(r:Resolved,action:Action,replaces:string|null):PlanPackage {
 const v=r.version;
 return {id:r.entry.id,type:r.entry.type,tag:v.tag,version:v.version,formatVersion:v.formatVersion,replaces,sourceId:r.source.id,sourceLabel:r.source.display,
  creator:r.entry.creator,repo:r.entry.repo ?? null,license:v.license,licenceNote:licenceNote(r.source.kind),bytes:v.bytes,expandedBytes:v.expandedBytes,
  sha256:v.sha256,url:v.url,action,requires:v.requires?.libraries ?? []};
}
/** Required libraries: installed (user or system) or found in the same source, then official, then community (RFC-0015 Plan). */
function planRequirements(r:Resolved,opts:JobOptions,doc:ContentFile):Array<{pkg:PlanPackage;resolved?:Resolved}> {
 const out:Array<{pkg:PlanPackage;resolved?:Resolved}>=[];
 for(const ref of r.version.requires?.libraries ?? []) {
  const at=ref.lastIndexOf('@'),id=ref.slice(0,at),version=ref.slice(at+1);
  const present=presentLibrary(opts,id,version);
  const candidates:Array<{source:SourceRef;index:IndexDocument|null}>=[{source:r.source,index:r.index}];
  for(const s of listSources(opts).filter(s=>(s.id==='official' || s.id==='community') && s.enabled)) candidates.push({source:{id:s.id,kind:s.kind,display:s.display},index:readCachedIndex(s.id,opts) ?? null});
  let hit:Resolved|undefined;
  for(const c of candidates) {
   const entry=c.index?.entries.find(e=>e.id===id && e.type==='library'),v=entry?.versions.find(v=>v.version===version);
   if(entry && v) {hit={source:c.source,entry,version:v,index:c.index};break;}
  }
  if(present) {
   const rec=findRecord(doc,id,'library');
   out.push({pkg:{...(hit?planPackage(hit,'already-installed',null):{id,type:'library',tag:rec?.current.version===version?rec.current.tag:null,version,formatVersion:null,replaces:null,
    sourceId:present.managed==='system'?'system':rec?.source ?? 'local',sourceLabel:present.managed==='system'?'System':sourceRef(rec?.source ?? 'local',opts).display,creator:null,repo:null,
    license:present.license,licenceNote:'unchecked',bytes:null,expandedBytes:null,sha256:null,url:null,requires:[]}),action:'already-installed'}});
   continue;
  }
  if(!hit) fail('requirement.missing',`${r.entry.id} ${r.version.tag} needs library ${ref}, which is not installed and not listed by ${r.source.display}, Official or Community registry`);
  if(!loadable('library',hit!.version.formatVersion)) fail('format.unsupported',`required library ${ref} uses format ${hit!.version.formatVersion}: needs a newer Hyprune`);
  out.push({pkg:planPackage(hit!,'install',null),resolved:hit});
 }
 return out;
}
function diskFree(path:string):number|null {
 for(let p=resolve(path);;p=dirname(p)) {
  if(existsSync(p)) {try {const s=statfsSync(p);return s.bavail*s.bsize;} catch {return null;}}
  if(p==='/') return null;
 }
}
/** Ask for what the plan needs: source change and override explicitly, then the plan itself (--yes). */
async function confirmPlan(plan:Plan,opts:JobOptions):Promise<void> {
 if(plan.sourceChange && !opts.acceptSourceChange) {
  if(!opts.confirm || !await opts.confirm(plan,'source-change'))
   fail('source.change',`${plan.sourceChange.id} is installed from ${plan.sourceChange.from.display}; installing it from ${plan.sourceChange.to.display} is a source change and needs explicit confirmation (--accept-source-change)`);
 }
 if(plan.override && !opts.override) fail('managed.system',`${plan.packages.at(-1)!.id} is managed by the system configuration; --override installs your own copy`);
 if(opts.yes) return;
 if(!opts.confirm) fail('confirm.required','confirmation required: run on a terminal or pass --yes');
 if(!await opts.confirm(plan,'plan')) fail('confirm.required','cancelled');
}
const moveInto=(from:string,to:string)=>{
 try {renameSync(from,to);}
 catch(e:any) {if(e.code!=='EXDEV') throw e;cpSync(from,to,{recursive:true,errorOnExist:true,force:false});rmSync(from,{recursive:true,force:true});}
};
const trash=(path:string)=>{
 try {lstatSync(path);} catch {return;}
 if(lstatSync(path).isSymbolicLink()) {unlinkSync(path);return;}
 const doomed=join(dirname(path),`.removing-${process.pid}-${Date.now()}-${path.split('/').at(-1)}`);
 renameSync(path,doomed);rmSync(doomed,{recursive:true,force:true});
};
const DATA_EXTENSIONS=['com.hyprune.map','com.hyprune.blueprint'];

interface Staged {dir:string;staging:string;digest:string;manifest:any;type:PackageType;license:string|null}
/** Extract and validate an archive into a staging directory under `root`. */
async function stage(archive:string,root:string,expect:{id?:string;type?:PackageType;version?:string;formatVersion?:string|null},emit:(e:JobEvent)=>void):Promise<Staged> {
 mkdirSync(root,{recursive:true});
 const staging=mkdtempSync(join(root,'.staging-'));
 try {
  emit({event:'stage',stage:'extracting'});
  const extracted=await extractArchive(archive,staging,{limits:expect.type?limitsFor(expect.type):ANY_LIMITS,expectRoot:expect.id});
  const dir=join(staging,extracted.root),{type,manifest}=readManifest(dir);
  const limits=limitsFor(type);
  if(extracted.files.length>limits.files || extracted.expandedBytes>limits.expandedBytes || extracted.files.some(f=>f.size>limits.fileBytes))
   fail('archive.limit',`the archive exceeds the ${type} limits (${limits.files} files, ${limits.expandedBytes} bytes, ${limits.fileBytes} per file)`);
  emit({event:'stage',stage:'validating'});
  if(manifest?.id!==extracted.root) fail('package.invalid',`the archive root ${extracted.root} is not the manifest id ${manifest?.id}`);
  if(expect.type && type!==expect.type) fail('package.invalid',`expected a ${expect.type}, the archive holds a ${type}`);
  if(expect.version && manifest.version!==expect.version) fail('package.invalid',`the manifest version ${manifest.version} is not the entry's ${expect.version}`);
  if(expect.formatVersion && manifest.formatVersion!==expect.formatVersion) fail('package.invalid',`the manifest format ${manifest.formatVersion} is not the entry's ${expect.formatVersion}`);
  if(!loadable(type,manifest.formatVersion)) fail('format.unsupported',`${manifest.id} uses ${type} format ${manifest.formatVersion}: needs a newer Hyprune`);
  for(const ext of manifest.requiredExtensions || []) if(!DATA_EXTENSIONS.includes(ext))
   fail('data.executable',`${manifest.id} requires extension ${ext}; only data extensions core implements (${DATA_EXTENSIONS.join(', ')}) can be required by an installed package`);
  let digest:string;
  try {digest=type==='world'?(await validateWorld(dir)).digest:(await validateLibrary(dir)).digest;}
  catch(e:any) {const lines=String(e.message).split('\n');return fail('package.invalid',`${manifest.id}: ${lines[0]}${lines.length>1?` (+${lines.length-1} more)`:''}`);}
  return {dir,staging,digest,manifest,type,license:manifest.license ?? null};
 } catch(e) {rmSync(staging,{recursive:true,force:true});throw e;}
}
function newState(pkg:{tag:string|null;version:string;sha256:string|null;url:string|null},staged:Staged):InstallState {
 return {tag:pkg.tag,version:pkg.version,sha256:pkg.sha256,digest:staged.digest,license:staged.license,url:pkg.url,installed:now()};
}
/** Commit a staged world: journal, previous replaced, current moved aside, staged tree in place, record. */
function commitWorld(doc:ContentFile,opts:JobOptions,staged:Staged,record:InstallRecord):void {
 const roots=rootsOf(opts),id=staged.manifest.id,target=join(roots.worlds,id),previousDir=join(roots.worlds,'.previous',id);
 doc.journal={type:'world',id,staging:staged.dir,target,previousDir,record};writeContent(roots,doc);
 let st;try {st=lstatSync(target);} catch {}
 if(st) {
  if(st.isSymbolicLink()) unlinkSync(target);
  else {mkdirSync(join(roots.worlds,'.previous'),{recursive:true});trash(previousDir);renameSync(target,previousDir);}
 }
 moveInto(staged.dir,target);
 putRecord(doc,record);doc.journal=null;writeContent(roots,doc);
}
/** Commit a staged library: core's libraries.install with a session, else the CLI renames it into the user root. */
async function commitLibrary(doc:ContentFile,opts:JobOptions,staged:Staged,archive:string,hash:string):Promise<void> {
 const roots=rootsOf(opts),id=staged.manifest.id,version=staged.manifest.version,key=`${id}@${version}`;
 if(opts.session?.canInstallLibraries) {await opts.session.installLibrary(resolve(archive),hash);return;}
 for(const [root,managed] of [[roots.libraries,'user'],...roots.systemLibraries.map(r=>[r,'system'])]) {
  const existing=join(root,key);
  if(!existsSync(existing)) continue;
  let digest:string|undefined;try {digest=(await validateLibrary(existing)).digest;} catch {}
  if(digest===staged.digest) return;
  fail('content.conflict',`${key} is installed${managed==='system'?' by the system':''} with different content`);
 }
 mkdirSync(roots.libraries,{recursive:true});
 moveInto(staged.dir,join(roots.libraries,key));
}
async function dropLibraryVersion(opts:JobOptions,id:string,version:string):Promise<void> {
 const roots=rootsOf(opts),dir=join(roots.libraries,`${id}@${version}`);
 if(!existsSync(dir)) return;
 if(opts.session?.canInstallLibraries) await opts.session.removeLibrary(id,version);
 else trash(dir);
}

/** Run one plan package: download, verify, extract, validate, commit, record. */
async function runPackage(doc:ContentFile,pkg:PlanPackage,opts:JobOptions,emit:(e:JobEvent)=>void,{pin}:{pin?:boolean}={}):Promise<JobResult> {
 const roots=rootsOf(opts);
 emit({event:'stage',stage:'downloading'});
 const archive=await download(pkg.url!,{bytes:pkg.bytes!,sha256:pkg.sha256!,dir:join(roots.cache,'downloads'),env:opts.env,signal:opts.signal,
  onProgress:(p:Progress)=>emit({event:'progress',bytes:p.bytes,total:p.total})});
 emit({event:'stage',stage:'verifying'});
 const actual=await sha256File(archive);
 if(actual!==pkg.sha256) {unlinkSync(archive);fail('hash.mismatch',`${pkg.id} ${pkg.tag}: sha256 ${actual}, pinned ${pkg.sha256}`);}
 const staged=await stage(archive,pkg.type==='world'?roots.worlds:roots.libraries,{id:pkg.id,type:pkg.type,version:pkg.version,formatVersion:pkg.formatVersion},emit);
 try {
  emit({event:'stage',stage:'committing'});
  await commitPackage(doc,pkg,staged,archive,opts,pin);
 } finally {rmSync(staged.staging,{recursive:true,force:true});}
 try {unlinkSync(archive);} catch {}
 return {id:pkg.id,type:pkg.type,tag:pkg.tag,version:pkg.version,action:pkg.action,sourceId:pkg.sourceId,pinned:findRecord(doc,pkg.id,pkg.type)?.pinned};
}
async function commitPackage(doc:ContentFile,pkg:PlanPackage,staged:Staged,archive:string,opts:JobOptions,pin?:boolean):Promise<void> {
 const roots=rootsOf(opts),old=findRecord(doc,pkg.id,pkg.type),state=newState(pkg,staged);
 if(pkg.type==='world') {
  const present=scanWorlds(roots).find(w=>w.id===pkg.id);
  const previous:InstallState|null=old?old.current:present && present.managed==='user'?{tag:null,version:present.version,sha256:null,digest:null,license:present.license,url:null,installed:now()}:null;
  commitWorld(doc,opts,staged,{id:pkg.id,type:'world',source:pkg.sourceId,pinned:pin ?? old?.pinned ?? false,current:state,previous,pending:null});
  return;
 }
 await commitLibrary(doc,opts,staged,archive,pkg.sha256 ?? await sha256File(archive));
 let previous=old?.previous ?? null;
 if(old && old.current.version!==pkg.version) {
  // The old previous version goes unless a world still requires it.
  if(previous && previous.version!==pkg.version && !requiredLibraries(roots).has(`${pkg.id}@${previous.version}`)) await dropLibraryVersion(opts,pkg.id,previous.version);
  previous=old.current;
 }
 if(previous?.version===pkg.version) previous=null;
 putRecord(doc,{id:pkg.id,type:'library',source:pkg.sourceId,pinned:pin ?? old?.pinned ?? false,current:state,previous,pending:null});
 writeContent(roots,doc);
}

function emitter(opts:JobOptions):(e:JobEvent)=>void {return opts.emit ?? (()=>{});}
function checkActive(opts:JobOptions,id:string,type:PackageType,what:string):void {
 if(type==='world' && opts.session?.loadedWorld===id) fail('world.active',`${id} is the loaded world: load another world first, then ${what}`);
}
/** `add`/`install`: one package (and the libraries it requires) from any source or a local archive. */
export async function install(target:string,opts:JobOptions):Promise<JobResult> {
 const emit=emitter(opts),roots=rootsOf(opts);
 return withLock(roots,async doc=>{
  emit({event:'stage',stage:'resolving'});
  const local=/\.tar\.zst$/.test(target) && !/^https?:\/\//.test(target);
  if(local) return installLocal(doc,target,opts,emit);
  const r=await resolveTarget(target,opts,doc);
  const record=findRecord(doc,r.entry.id,r.entry.type);
  const present=r.entry.type==='world'?scanWorlds(roots).find(w=>w.id===r.entry.id):undefined;
  const systemLib=r.entry.type==='library'?scanLibraries(roots).find(l=>l.id===r.entry.id && l.version===r.version.version && l.managed==='system'):undefined;
  let action=actionFor(record,present?.version ?? null,r.version,r.entry.id);
  if(systemLib) action='already-installed';
  if(action!=='already-installed' && action!=='install') checkActive(opts,r.entry.id,r.entry.type,'update it');
  if(action==='install' && present?.managed==='user') action='update';
  const main=planPackage(r,action,action==='update' || action==='downgrade'?record?.current.tag ?? (present?`${present.version} (local)`:null):null);
  const requirements=r.entry.type==='world' && action!=='already-installed'?planRequirements(r,opts,doc):[];
  const fromId=record?.source ?? (present && present.managed==='user'?'local':null);
  const plan:Plan={packages:[...requirements.map(q=>q.pkg),main],
   sourceChange:fromId && fromId!==r.source.id?{id:r.entry.id,from:{sourceId:fromId,display:sourceRef(fromId,opts).display},to:{sourceId:r.source.id,display:r.source.display}}:null,
   override:present?.managed==='system' && action!=='already-installed',diskFreeAfter:null};
  const free=diskFree(r.entry.type==='world'?roots.worlds:roots.libraries);
  const need=plan.packages.filter(p=>p.action!=='already-installed').reduce((n,p)=>n+(p.bytes ?? 0)+(p.expandedBytes ?? 0),0);
  plan.diskFreeAfter=free===null?null:free-need;
  emit({event:'plan',plan});
  if(opts.planOnly) return {id:main.id,type:main.type,tag:main.tag,version:main.version,action:'plan'};
  if(plan.diskFreeAfter!==null && plan.diskFreeAfter<0) fail('disk.full',`needs ${need} bytes; ${free} free`);
  if(action==='already-installed' && !plan.sourceChange) {
   if(opts.pin && record && !record.pinned) {record.pinned=true;writeContent(roots,doc);}
   emit({event:'done',result:{...main,action}});
   return {id:main.id,type:main.type,tag:main.tag,version:main.version,action,sourceId:r.source.id,pinned:record?.pinned};
  }
  await confirmPlan(plan,opts);
  for(const q of requirements) if(q.pkg.action==='install') await runPackage(doc,q.pkg,opts,emit);
  const result=action==='already-installed'?await adopt(doc,main,opts):await runPackage(doc,main,opts,emit,{pin:opts.pin?true:undefined});
  emit({event:'done',result:{id:result.id,type:result.type,tag:result.tag,version:result.version,action:result.action,sourceId:result.sourceId,pinned:result.pinned ?? false}});
  return result;
 });
}
/** The same tag and hash from another (confirmed) source: only the record's source changes. */
async function adopt(doc:ContentFile,pkg:PlanPackage,opts:JobOptions):Promise<JobResult> {
 const record=findRecord(doc,pkg.id,pkg.type);
 if(record) {record.source=pkg.sourceId;if(opts.pin) record.pinned=true;writeContent(rootsOf(opts),doc);}
 return {id:pkg.id,type:pkg.type,tag:pkg.tag,version:pkg.version,action:'already-installed',sourceId:pkg.sourceId,pinned:record?.pinned};
}
/**
 * Offline install (RFC-0015 "Offline install"): hash the local archive; check it against
 * --sha256, else a cached index entry with the same id and version (whose source and tag are
 * recorded), else record it as {source: "file"}. Extraction and validation come before the
 * plan, since only the archive names the package.
 */
async function installLocal(doc:ContentFile,path:string,opts:JobOptions,emit:(e:JobEvent)=>void):Promise<JobResult> {
 const roots=rootsOf(opts),archive=resolve(path);
 let st;try {st=lstatSync(archive);} catch {return fail('not.found',`${path}: no such file`);}
 if(!st.isFile() || st.isSymbolicLink()) fail('archive.unsafe',`${path}: not a regular file (symlinks are refused)`);
 emit({event:'stage',stage:'verifying'});
 const hash=await sha256File(archive);
 if(opts.sha256 && opts.sha256!==hash) fail('hash.mismatch',`${path}: sha256 ${hash}, expected ${opts.sha256}`);
 const scratch=join(roots.cache,'staging');mkdirSync(scratch,{recursive:true,mode:0o700});
 const staged=await stage(archive,scratch,{type:opts.type},emit);
 try {
  const {manifest,type}=staged,id=manifest.id,version=manifest.version;
  let source:SourceRef={id:'file',kind:'url',display:'File'},entryVersion:IndexVersion|undefined,entry:IndexEntry|undefined;
  if(!opts.sha256) {
   for(const c of cachedEntries(opts).filter(c=>c.entry.id===id && c.entry.type===type)) {
    const v=c.entry.versions.find(v=>v.version===version);
    if(!v) continue;
    if(v.sha256!==hash) fail('hash.mismatch',`${path}: sha256 ${hash}; ${c.source.display} pins ${id} ${v.tag} as ${v.sha256}`);
    source={id:c.source.id,kind:c.source.kind,display:c.source.display};entryVersion=v;entry=c.entry;break;
   }
  }
  const record=findRecord(doc,id,type),present=type==='world'?scanWorlds(roots).find(w=>w.id===id):undefined;
  const tag=entryVersion?.tag ?? null;
  const pseudo:IndexVersion=entryVersion ?? {tag:tag ?? `v${version}`,version,formatVersion:manifest.formatVersion,published:'1970-01-01',license:manifest.license,url:archive,sha256:hash,bytes:st.size,expandedBytes:0,files:1};
  let action:Action;
  if(record?.current.sha256===hash) action='already-installed';
  else if(record?.current.tag && tag && record.current.tag===tag) return fail('content.conflict',`replaced asset: ${id} ${tag} was installed with sha256 ${record.current.sha256}; this archive is ${hash}`);
  else action=record || present?(compareSemver(version,record?.current.version ?? present!.version)<0?'downgrade':'update'):'install';
  if(action!=='install' && action!=='already-installed') checkActive(opts,id,type,'update it');
  const main:PlanPackage={id,type,tag,version,formatVersion:manifest.formatVersion,replaces:action==='update' || action==='downgrade'?record?.current.tag ?? record?.current.version ?? present?.version ?? null:null,
   sourceId:source.id,sourceLabel:source.display,creator:entry?.creator ?? null,repo:entry?.repo ?? null,license:manifest.license ?? null,licenceNote:source.id==='file'?'unchecked':licenceNote(source.kind),
   bytes:st.size,expandedBytes:null,sha256:hash,url:null,action,requires:type==='world'?libraryRefs(manifest):[]};
  const r:Resolved={source,entry:entry ?? {id,type,name:String(manifest.name).slice(0,64),creator:'local',versions:[pseudo]},version:{...pseudo,requires:type==='world' && libraryRefs(manifest).length?{libraries:libraryRefs(manifest)}:undefined},index:null};
  const requirements=type==='world' && action!=='already-installed'?planRequirements(r,opts,doc):[];
  const fromId=record?.source ?? (present && present.managed==='user'?'local':null);
  const plan:Plan={packages:[...requirements.map(q=>q.pkg),main],
   sourceChange:fromId && fromId!==source.id && source.id!=='file'?{id,from:{sourceId:fromId,display:sourceRef(fromId,opts).display},to:{sourceId:source.id,display:source.display}}:null,
   override:present?.managed==='system',diskFreeAfter:diskFree(type==='world'?roots.worlds:roots.libraries)};
  emit({event:'plan',plan});
  if(opts.planOnly) return {id,type,tag,version,action:'plan'};
  if(action==='already-installed') {emit({event:'done',result:{...main}});return {id,type,tag,version,action,sourceId:source.id};}
  await confirmPlan(plan,opts);
  for(const q of requirements) if(q.pkg.action==='install') await runPackage(doc,q.pkg,opts,emit);
  emit({event:'stage',stage:'committing'});
  // Worlds and direct library commits move the staged tree into their root (copy across file systems).
  await commitPackage(doc,main,staged,archive,opts,opts.pin?true:undefined);
  const result={id,type,tag,version,action,sourceId:source.id,pinned:findRecord(doc,id,type)?.pinned ?? false};
  emit({event:'done',result});
  return result;
 } finally {rmSync(staged.staging,{recursive:true,force:true});}
}

/** Installs to update: the named ids, or every unpinned, user-managed install. */
export interface UpdateOutcome {id:string;type:PackageType;status:'updated'|'current'|'pinned'|'skipped'|'planned';tag:string|null;newerTag:string|null;reason?:string;result?:JobResult}
export async function update(ids:string[],opts:JobOptions&{all?:boolean;refresh?:boolean}):Promise<UpdateOutcome[]> {
 const roots=rootsOf(opts),emit=emitter(opts);
 const {records}=await withLock(roots,doc=>({records:doc.installs.filter(r=>(!opts.type || r.type===opts.type) && (opts.all || ids.includes(r.id)))}));
 for(const id of ids) if(!records.some(r=>r.id===id)) fail('not.found',`${id} has no install record${opts.type?` (${opts.type})`:''}`);
 const out:UpdateOutcome[]=[],refreshed=new Set<string>();
 for(const record of records) {
  const base={id:record.id,type:record.type,tag:record.current.tag};
  if(record.pinned) {
   const entry=readCachedIndex(record.source,opts)?.entries.find(e=>e.id===record.id && e.type===record.type);
   out.push({...base,status:'pinned',newerTag:entry?newerThan(entry,record.current.version)?.tag ?? null:null});continue;
  }
  const source=listSources(opts).find(s=>s.id===record.source);
  if(!source) {out.push({...base,status:'skipped',newerTag:null,reason:['local','file'].includes(record.source) || record.source.includes(':')?'not installed from a source':'source removed'});continue;}
  if(!source.enabled) {out.push({...base,status:'skipped',newerTag:null,reason:'source disabled'});continue;}
  if(opts.refresh!==false && !refreshed.has(source.id)) {refreshed.add(source.id);await refreshSource(source,opts);}
  const entry=readCachedIndex(source.id,opts)?.entries.find(e=>e.id===record.id && e.type===record.type);
  const newer=entry && newerThan(entry,record.current.version);
  if(!newer) {out.push({...base,status:entry?'current':'skipped',newerTag:null,...(entry?{}:{reason:'removed from source'})});continue;}
  const result=await install(`${record.id}@${newer.tag}`,{...opts,from:source.id,type:record.type,emit});
  out.push({...base,status:opts.planOnly?'planned':'updated',newerTag:newer.tag,result});
 }
 return out;
}
/** Swap the current and previous installs (two renames, no download) and pin the restored tag. */
export async function rollback(id:string,opts:JobOptions):Promise<JobResult> {
 const roots=rootsOf(opts);
 return withLock(roots,async doc=>{
  const record=one(doc,id,opts.type);
  systemCheck(opts,record.id,record.type,'roll back');
  if(!record.previous) fail('not.found',`${id} has no previous install to roll back to; install an older tag explicitly (add ${id}@<tag>)`);
  checkActive(opts,id,record.type,'roll it back');
  if(record.type==='world') {
   const target=join(roots.worlds,id),prev=join(roots.worlds,'.previous',id),swap=join(roots.worlds,'.previous',`.swap-${id}`);
   if(!existsSync(prev)) fail('not.found',`${prev} is missing; the previous install is gone`);
   renameSync(target,swap);
   try {renameSync(prev,target);} catch(e) {renameSync(swap,target);throw e;}
   renameSync(swap,prev);
  } else if(!existsSync(join(roots.libraries,`${id}@${record.previous.version}`))) fail('not.found',`${id}@${record.previous.version} is no longer installed`);
  [record.current,record.previous]=[record.previous,record.current];record.pinned=true;
  writeContent(roots,doc);
  return {id,type:record.type,tag:record.current.tag,version:record.current.version,action:'rollback',pinned:true,sourceId:record.source};
 });
}
function one(doc:ContentFile,id:string,type?:PackageType):InstallRecord {
 const matches=doc.installs.filter(r=>r.id===id && (!type || r.type===type));
 if(!matches.length) fail('not.found',`${id} has no install record`);
 if(matches.length>1) fail('source.invalid',`${id} is both a world and a library; use hyprune world|library`);
 return matches[0];
}
function systemCheck(opts:JobOptions,id:string,type:PackageType,what:string):void {
 const roots=rootsOf(opts);
 const system=type==='world'?scanWorlds(roots).some(w=>w.id===id && w.managed==='system'):false;
 if(system) fail('managed.system',`${id} is managed by the system configuration; can't ${what} it here`);
}
/** Pin or unpin the current tag. A world found on disk without a record is recorded as local first. */
export async function setPin(id:string,pinned:boolean,opts:JobOptions):Promise<JobResult> {
 const roots=rootsOf(opts);
 return withLock(roots,async doc=>{
  let record=doc.installs.find(r=>r.id===id && (!opts.type || r.type===opts.type));
  if(!record) {
   const present=scanWorlds(roots).find(w=>w.id===id && (!opts.type || opts.type==='world'));
   if(present?.managed==='system') fail('managed.system',`${id} is managed by the system configuration; pin it there`);
   if(!present) {
    const lib=scanLibraries(roots).find(l=>l.id===id && (!opts.type || opts.type==='library'));
    if(lib?.managed==='system') fail('managed.system',`${id} is managed by the system configuration; pin it there`);
    fail('not.found',`${id} is not installed`);
   }
   record={id,type:'world',source:'local',pinned,current:{tag:null,version:present!.version,sha256:null,digest:null,license:present!.license,url:null,installed:now()},previous:null,pending:null};
   putRecord(doc,record);
  }
  systemCheck(opts,record.id,record.type,pinned?'pin':'unpin');
  record.pinned=pinned;writeContent(roots,doc);
  return {id,type:record.type,tag:record.current.tag,version:record.current.version,action:pinned?'pin':'unpin',pinned};
 });
}
/**
 * Remove an install: current and previous, and the record. Libraries also take <id>@<version>
 * for one version. Refused for the loaded world, system-managed content and library versions
 * an installed world requires (unless --force).
 */
export async function remove(target:string,opts:JobOptions):Promise<JobResult> {
 const roots=rootsOf(opts);
 return withLock(roots,async doc=>{
  const at=target.lastIndexOf('@'),id=at>0?target.slice(0,at):target,oneVersion=at>0?target.slice(at+1):null;
  const worlds=scanWorlds(roots),libraries=scanLibraries(roots);
  const type:PackageType=opts.type ?? (oneVersion || (!worlds.some(w=>w.id===id) && libraries.some(l=>l.id===id)) || findRecord(doc,id,'library') && !findRecord(doc,id,'world')?'library':'world');
  if(type==='world') {
   const present=worlds.find(w=>w.id===id),record=findRecord(doc,id,'world');
   if(!present && !record) fail('not.found',`${id} is not installed`);
   if(present?.managed==='system') fail('managed.system',`${id} is managed by the system configuration; remove it there`);
   checkActive(opts,id,'world','remove it');
   trash(join(roots.worlds,id));trash(join(roots.worlds,'.previous',id));
   dropRecord(doc,id,'world');writeContent(roots,doc);
   return {id,type,tag:record?.current.tag ?? null,version:record?.current.version ?? present!.version,action:'remove',removed:[id]};
  }
  const record=findRecord(doc,id,'library'),mine=libraries.filter(l=>l.id===id);
  const versions=oneVersion?[oneVersion]:[...new Set([record?.current.version,record?.previous?.version].filter((v):v is string=>!!v).concat(record?[]:mine.filter(l=>l.managed==='user').map(l=>l.version)))];
  if(!versions.length && !mine.length) fail('not.found',`${id} is not installed`);
  const system=versions.filter(v=>mine.some(l=>l.version===v && l.managed==='system'));
  if(system.length || (!versions.length && mine.length)) fail('managed.system',`${id}@${system[0] ?? mine[0].version} is managed by the system configuration; remove it there`);
  // With a session core knows its own roots: it answers for versions the CLI doesn't see.
  const viaCore=!!opts.session?.canInstallLibraries;
  if(!viaCore) for(const v of versions) if(!mine.some(l=>l.version===v) && !record) fail('not.found',`${id}@${v} is not installed`);
  const required=requiredLibraries(roots);
  const blocked=versions.flatMap(v=>(required.get(`${id}@${v}`) ?? []).map(w=>`${id}@${v} (required by ${w})`));
  if(blocked.length && !opts.force) fail('requirement.missing',`refused: ${blocked.join(', ')}; --force removes it anyway (placements become missing)`);
  for(const v of versions) {
   if(viaCore) {
    try {await opts.session!.removeLibrary(id,v);}
    catch(e:any) {if(!(record && /unknown library/.test(e.message))) throw e;}
   } else trash(join(roots.libraries,`${id}@${v}`));
  }
  if(record) {
   if(versions.includes(record.current.version)) {
    if(record.previous && !versions.includes(record.previous.version)) {record.current=record.previous;record.previous=null;}
    else dropRecord(doc,id,'library');
   } else if(record.previous && versions.includes(record.previous.version)) record.previous=null;
   writeContent(roots,doc);
  }
  return {id,type,tag:record?.current.tag ?? null,version:versions[0],action:'remove',removed:versions.map(v=>`${id}@${v}`)};
 });
}
export {RegistryError,isPrerelease,githubRepoUrl};

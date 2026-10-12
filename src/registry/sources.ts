// Sources (RFC-0015 "Sources", "Custom sources", "Labels"): the built-in official and
// community registry indexes (can be disabled, never removed or relabelled) and up to 32
// custom sources (index URL, github: repository, package URL), each with a user label that
// always displays behind its kind. sources.json is replaced atomically with mode 0600.
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fail,RegistryError} from './errors.js';
import {fetchBytes,fetchJson,download,allowedUrl,sha256,FETCH_LIMITS,type FetchContext} from './fetch.js';
import {parseIndex,parseRecord,checkIndex,forSchema,newestInstallable,type IndexDocument,type IndexEntry,type IndexVersion,type ReleaseRecord} from './index.js';
import {githubIndex,githubClient,parseGithub,type GithubClient} from './github.js';
import {extractArchive,ANY_LIMITS} from './archive.js';
import {contentRoots,type ContentRoots} from './paths.js';
import {validateRegistry} from '../validation.js';
import {imageHeader} from '../object.js';
import {parseJson} from '../codec.js';
import type {Sources01_Document,Sources01_Source} from '../generated.js';

type Env=Record<string,string|undefined>;
export type SourceKind='official'|'community'|'index'|'github'|'url';
export type CustomSource=Sources01_Source;
export type SourcesConfig=Sources01_Document;
export interface Source {
 id:string;kind:SourceKind;label:string;display:string;url?:string;repo?:string;sha256?:string;
 enabled:boolean;builtin:boolean;system:boolean;added?:string;
}
export interface SourceMeta {serial:number|null;fetched:string|null;url:string|null;error:string|null;successor?:string|null;skipped?:Array<{tag:string;reason:string}>}
export const MAX_CUSTOM=32;
export const DEFAULT_OFFICIAL='https://hyprune.github.io/registry/v0.1/official.json';
export const DEFAULT_COMMUNITY='https://hyprune.github.io/registry/v0.1/community.json';
export const CUSTOM_NOTICE="Hyprune doesn't check custom sources. Packages from them are installed with the same safety checks, but nobody has reviewed them.";

export interface Context extends FetchContext {roots?:ContentRoots;github?:GithubClient}
export const rootsOf=(ctx:Context)=>ctx.roots ?? contentRoots(ctx.env ?? process.env);
const envOf=(ctx:Context):Env=>ctx.env ?? process.env;
const today=()=>new Date().toISOString().slice(0,10);

/** The display label: the kind first, so content can never present itself as built in. */
export function display(s:{kind:SourceKind;label:string}):string {
 return s.kind==='official'?'Official':s.kind==='community'?'Community registry':`Custom: ${s.label}`;
}
export const tierOf=(kind:SourceKind)=>kind==='official'?'official':kind==='community'?'community':'custom';
export const licenceNote=(kind:SourceKind)=>kind==='official'?'reviewed':kind==='community'?'declared':'unchecked';
/** A user label: 1-48 printable characters, trimmed. */
export function checkLabel(text:string):string {
 const label=text.trim();
 if(!label || [...label].length>48 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) fail('source.invalid','a label is 1-48 printable characters');
 return label;
}
/** A slug id from a label, unique among `taken` (built-in ids are always taken). */
export function slugId(label:string,taken:Iterable<string>):string {
 const used=new Set([...taken,'official','community']);
 let base=label.toLowerCase().normalize('NFKD').replace(/['’]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/,'') || 'source';
 let id=base;for(let n=2;used.has(id);n++) id=`${base}-${n}`;
 return id;
}

function readConfig(path:string,what:string,env:Env):SourcesConfig|undefined {
 if(!existsSync(path)) return undefined;
 let doc:unknown;
 try {doc=parseJson(readFileSync(path,'utf8'));} catch(e:any) {return fail('source.invalid',`${what}: ${e.message}`);}
 const r=validateRegistry('sources',forSchema(doc,env));
 if(!r.valid) fail('source.invalid',`${what}: ${r.errors.slice(0,3).join('; ')}`);
 return doc as SourcesConfig;
}
/** Write a JSON file atomically with mode 0600. */
export function writeJsonAtomic(path:string,value:unknown):void {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const temp=`${path}.${process.pid}.tmp`;
 writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 renameSync(temp,path);
}
export function loadConfig(ctx:Context={}):SourcesConfig {
 return readConfig(rootsOf(ctx).sourcesFile,'sources.json',envOf(ctx)) ?? {version:1,builtin:{official:{enabled:true},community:{enabled:true}},custom:[]};
}
export function saveConfig(config:SourcesConfig,ctx:Context={}):void {
 const r=validateRegistry('sources',forSchema(config,envOf(ctx)));
 if(!r.valid) fail('source.invalid',`sources.json: ${r.errors[0]}`);
 writeJsonAtomic(rootsOf(ctx).sourcesFile,config);
}
/** Every source in resolution order: official, community registry, user custom sources, then system ones. */
export function listSources(ctx:Context={}):Source[] {
 const env=envOf(ctx),roots=rootsOf(ctx),config=loadConfig(ctx);
 const systems=roots.systemSourcesFiles.map(f=>readConfig(f,f,env)).filter((c):c is SourcesConfig=>!!c);
 const builtin=(id:'official'|'community'):Source=>{
  const fromSystem=systems.map(s=>s.builtin?.[id]?.enabled).find(v=>v!==undefined);
  const enabled=config.builtin?.[id]?.enabled ?? fromSystem ?? true;
  const url=id==='official'?env.HYPRUNE_REGISTRY_OFFICIAL_URL || DEFAULT_OFFICIAL:env.HYPRUNE_REGISTRY_COMMUNITY_URL || DEFAULT_COMMUNITY;
  return {id,kind:id,label:id==='official'?'Official':'Community registry',display:display({kind:id,label:''}),url,enabled,builtin:true,system:false};
 };
 const custom=(c:CustomSource,system:boolean):Source=>({...c,display:display({kind:c.kind,label:c.label}),builtin:false,system});
 const out=[builtin('official'),builtin('community'),...(config.custom || []).map(c=>custom(c,false))];
 for(const s of systems) for(const c of s.custom || []) if(!out.some(o=>o.id===c.id)) out.push(custom(c,true));
 return out;
}
export function findSource(id:string,ctx:Context={}):Source {
 const s=listSources(ctx).find(s=>s.id===id);
 if(!s) fail('not.found',`no source ${id} (hyprune source list)`);
 return s!;
}

// Index cache: <cache>/sources/<id>/{index.json,meta.json}.
const cacheDir=(id:string,ctx:Context)=>join(rootsOf(ctx).cache,'sources',id);
export function readMeta(id:string,ctx:Context={}):SourceMeta {
 try {return JSON.parse(readFileSync(join(cacheDir(id,ctx),'meta.json'),'utf8'));} catch {return {serial:null,fetched:null,url:null,error:null};}
}
export function readCachedIndex(id:string,ctx:Context={}):IndexDocument|undefined {
 try {return JSON.parse(readFileSync(join(cacheDir(id,ctx),'index.json'),'utf8'));} catch {return undefined;}
}
function writeCache(id:string,index:IndexDocument|undefined,meta:SourceMeta,ctx:Context):void {
 const dir=cacheDir(id,ctx);mkdirSync(dir,{recursive:true,mode:0o700});
 if(index) writeJsonAtomic(join(dir,'index.json'),index);
 writeJsonAtomic(join(dir,'meta.json'),meta);
}

/** Classify an argument of `source add`: github:owner/repo[/name], an archive URL, a record URL, or an index URL. */
export function classify(spec:string,env:Env=process.env):{kind:'index'|'github'|'url';url?:string;repo?:string} {
 if(spec.startsWith('github:')) {const g=parseGithub(spec);return {kind:'github',repo:`${g.owner}/${g.repo}${g.name?'/'+g.name:''}`};}
 if(!allowedUrl(spec,env)) fail('source.invalid',`${spec}: expected an https:// URL or github:owner/repo`);
 const path=new URL(spec).pathname;
 return {kind:path.endsWith('.tar.zst') || path.endsWith('.release.json')?'url':'index',url:spec};
}

/** Read a manifest from an extracted package root: world.json or library.json. */
export function readManifest(dir:string):{type:'world'|'library';manifest:any} {
 for(const [file,type] of [['world.json','world'],['library.json','library']] as const) {
  if(existsSync(join(dir,file))) {
   const text=readFileSync(join(dir,file));
   if(text.length>1048576) fail('package.invalid',`${file} exceeds 1 MiB`);
   try {return {type,manifest:parseJson(new TextDecoder('utf-8',{fatal:true}).decode(text))};} catch(e:any) {return fail('package.invalid',`${file}: ${e.message}`);}
  }
 }
 return fail('package.invalid','the archive has no world.json or library.json at its root');
}
/** Exact library references of a world manifest (world 0.9 objectAssets[].library). */
export function libraryRefs(manifest:any):string[] {
 return [...new Set<string>((manifest?.objectAssets || []).map((a:any)=>a?.library).filter((l:unknown)=>typeof l==='string'))].sort();
}
/** One index version from a release record found at `recordUrl` (assets resolve next to it). */
export function recordVersion(record:ReleaseRecord,recordUrl:string,recordBytes:Buffer,published=today()):IndexVersion {
 const at=(name:string)=>new URL(name,recordUrl).href;
 return {tag:record.source.tag,version:record.version,formatVersion:record.formatVersion,published,license:record.license,
  url:at(record.archive.name),sha256:record.archive.sha256,bytes:record.archive.bytes,expandedBytes:record.archive.expandedBytes,files:record.archive.files,
  record:{url:recordUrl,sha256:sha256(recordBytes)},...(record.requires?{requires:record.requires}:{}),
  ...(record.thumbnails?.length?{thumbnails:record.thumbnails.map(t=>({url:at(t.name),sha256:t.sha256,width:t.width,height:t.height}))}:{}),status:'available'};
}
export function recordEntry(record:ReleaseRecord,version:IndexVersion,creator:string):IndexEntry {
 return {id:record.id,type:record.type,name:record.name,creator:creator.slice(0,64),...(record.source.repo.startsWith('https://')?{repo:record.source.repo}:{}),versions:[version]};
}
const singleIndex=(name:string,entries:IndexEntry[]):IndexDocument=>({indexVersion:'0.1',name:name.slice(0,64),serial:1,generated:new Date().toISOString().replace(/\.\d+Z$/,'Z'),successor:null,entries});
/**
 * A direct archive URL pinned by sha256: download it (verified) into the download cache and
 * read its manifest; the archive stays cached for the install.
 */
export async function archiveEntry(url:string,hash:string,ctx:Context,size?:number):Promise<IndexEntry> {
 const roots=rootsOf(ctx),downloads=join(roots.cache,'downloads');
 const path=await download(url,{bytes:size ?? ANY_LIMITS.bytes,sha256:hash,dir:downloads,env:ctx.env,signal:ctx.signal,exact:size!==undefined});
 const staging=mkdtempSync(join(downloads,'.inspect-'));
 try {
  const result=await extractArchive(path,staging,{limits:ANY_LIMITS});
  const {type,manifest}=readManifest(join(staging,result.root));
  if(manifest?.id!==result.root) fail('package.invalid',`the archive root ${result.root} is not the manifest id ${manifest?.id}`);
  const bytes=readFileSync(path).length;
  const version:IndexVersion={tag:`v${manifest.version}`,version:manifest.version,formatVersion:manifest.formatVersion,published:today(),license:manifest.license,
   url,sha256:hash,bytes,expandedBytes:result.expandedBytes,files:result.files.length,...(type==='world' && libraryRefs(manifest).length?{requires:{libraries:libraryRefs(manifest)}}:{}),status:'available'};
  return {id:manifest.id,type,name:String(manifest.name).slice(0,64),creator:new URL(url).host,versions:[version]};
 } finally {rmSync(staging,{recursive:true,force:true});}
}
/** Fetch a source into an index document (no cache side effects). */
export async function fetchSource(source:{kind:SourceKind;url?:string;repo?:string;sha256?:string},ctx:Context,lastSerial?:number|null):Promise<{index:IndexDocument;skipped?:Array<{tag:string;reason:string}>}> {
 const env=envOf(ctx);
 if(source.kind==='github') {
  const spec=parseGithub(source.repo!),client=ctx.github ?? githubClient(ctx);
  const records=recordCache(source,ctx);
  // Records are cached per asset URL, size and update time: a re-uploaded record is fetched again.
  const fetch=async(url:string,max:number,key?:string)=>{
   const id=key===undefined?undefined:`${url} ${key}`,hit=id && records.get(id);if(hit) return Buffer.from(hit,'base64');
   const bytes=await fetchBytes(url,max,ctx);if(id) records.set(id,bytes.toString('base64'));return bytes;
  };
  const r=await githubIndex(spec,client,fetch,env);records.save();return r;
 }
 if(source.kind==='url') {
  const path=new URL(source.url!).pathname;
  if(path.endsWith('.tar.zst')) {
   if(!source.sha256) fail('source.invalid','an archive URL needs --sha256 (every install is pinned)');
   return {index:checkIndex(singleIndex(new URL(source.url!).host,[await archiveEntry(source.url!,source.sha256!,ctx)]),env)};
  }
  const {bytes}=await fetchJson(source.url!,FETCH_LIMITS.record,ctx);
  const record=parseRecord(bytes,{what:source.url,env});
  return {index:checkIndex(singleIndex(record.name,[recordEntry(record,recordVersion(record,source.url!,bytes),new URL(source.url!).host)]),env)};
 }
 const bytes=await fetchBytes(source.url!,FETCH_LIMITS.index,ctx);
 return {index:parseIndex(bytes,{what:source.url,lastSerial,env})};
}
// github: record bytes are cached per asset URL (published assets are immutable; the archive
// hash is checked against the record at install time anyway).
function recordCache(source:{repo?:string},ctx:Context) {
 const file=join(rootsOf(ctx).cache,'records',sha256(source.repo || '')+'.json');
 let map:Record<string,string>={};try {map=JSON.parse(readFileSync(file,'utf8'));} catch {}
 return {get:(u:string)=>map[u],set:(u:string,v:string)=>{map[u]=v;},save:()=>writeJsonAtomic(file,map)};
}
export interface RefreshResult {id:string;display:string;entries:number;serial:number|null;error:string|null;skipped?:Array<{tag:string;reason:string}>}
/**
 * Refresh one source into its cache. A failure keeps the cached index and records the error
 * (rollback of the serial included); the result carries it instead of throwing.
 */
export async function refreshSource(source:Source,ctx:Context={}):Promise<RefreshResult> {
 const meta=readMeta(source.id,ctx),now=new Date().toISOString();
 try {
  const {index,skipped}=await fetchSource(source,ctx,meta.serial);
  writeCache(source.id,index,{serial:index.serial,fetched:now,url:source.url ?? source.repo ?? null,error:null,successor:index.successor ?? null,...(skipped?.length?{skipped}:{})},ctx);
  await cacheThumbnails(index,ctx).catch(()=>{});
  return {id:source.id,display:source.display,entries:index.entries.length,serial:index.serial,error:null,...(skipped?.length?{skipped}:{})};
 } catch(e:any) {
  const error=e instanceof RegistryError?`${e.rule}: ${e.message}`:e.message;
  writeCache(source.id,undefined,{...meta,error},ctx);
  return {id:source.id,display:source.display,entries:readCachedIndex(source.id,ctx)?.entries.length ?? 0,serial:meta.serial,error};
 }
}
/** The cached, verified card thumbnail of a version (thumbnail 1), or null. */
export function thumbnailPath(version:IndexVersion|undefined,ctx:Context={}):string|null {
 const t=version?.thumbnails?.[0];if(!t) return null;
 for(const ext of ['png','jpg']) {const p=join(rootsOf(ctx).cache,'thumbnails',`${t.sha256}.${ext}`);if(existsSync(p)) return p;}
 return null;
}
/** Download card thumbnails (thumbnail 1 of the newest version) not yet cached: hash, PNG/JPEG and size checked; at most 64 per refresh. */
async function cacheThumbnails(index:IndexDocument,ctx:Context):Promise<void> {
 const dir=join(rootsOf(ctx).cache,'thumbnails');let budget=64;
 for(const entry of index.entries) {
  const v=newestInstallable(entry,{prerelease:true}),t=v?.thumbnails?.[0];
  if(!t || thumbnailPath(v,ctx) || budget--<=0) continue;
  try {
   const bytes=await fetchBytes(t.url,FETCH_LIMITS.thumbnail,ctx);
   if(sha256(bytes)!==t.sha256) continue;
   const header=imageHeader(bytes);
   if(!header || header.format==='ktx2' || header.width>1280 || header.height>720 || header.width!==t.width || header.height!==t.height) continue;
   mkdirSync(dir,{recursive:true,mode:0o700});
   writeFileSync(join(dir,`${t.sha256}.${header.format==='png'?'png':'jpg'}`),bytes,{mode:0o600});
  } catch {}
 }
}

export interface AddOptions {label?:string;id?:string;sha256?:string}
/**
 * `source add`: classify, fetch once and validate (a source that fails is not added), pick
 * the label (given, else the index name, the repository or the URL host) and a unique id.
 */
export async function addSource(spec:string,options:AddOptions,ctx:Context={}):Promise<{source:Source;refresh:RefreshResult}> {
 const config=loadConfig(ctx),existing=listSources(ctx),custom=config.custom ?? [];
 if(custom.length>=MAX_CUSTOM) fail('source.invalid',`at most ${MAX_CUSTOM} custom sources`);
 const c=classify(spec,envOf(ctx));
 if(options.sha256 && !(c.kind==='url' && new URL(c.url!).pathname.endsWith('.tar.zst'))) fail('source.invalid','--sha256 applies to an archive URL');
 if(options.sha256 && !/^[0-9a-f]{64}$/.test(options.sha256)) fail('source.invalid','--sha256 needs 64 lowercase hex digits');
 const same=existing.find(s=>(c.url && s.url===c.url) || (c.repo && s.repo===c.repo));
 if(same) fail('source.invalid',`already added as ${same.id} (${same.display})`);
 const candidate={kind:c.kind,...(c.url?{url:c.url}:{}),...(c.repo?{repo:c.repo}:{}),...(options.sha256?{sha256:options.sha256}:{})};
 const {index,skipped}=await fetchSource(candidate,ctx);
 const label=checkLabel(options.label ?? (c.kind==='index' && index.name?index.name:c.repo?c.repo.split('/').slice(0,2).join('/'):new URL(c.url!).host));
 if(options.id!==undefined && (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.id) || options.id.length>48)) fail('source.invalid','--id is a lowercase slug of at most 48 characters');
 const id=options.id ?? slugId(label,existing.map(s=>s.id));
 if(existing.some(s=>s.id===id)) fail('source.invalid',`a source with id ${id} exists`);
 const entry:CustomSource={id,label,...candidate,enabled:true,added:today()} as CustomSource;
 saveConfig({...config,custom:[...custom,entry]},ctx);
 const now=new Date().toISOString();
 writeCache(id,index,{serial:index.serial,fetched:now,url:c.url ?? c.repo ?? null,error:null,successor:index.successor ?? null,...(skipped?.length?{skipped}:{})},ctx);
 await cacheThumbnails(index,ctx).catch(()=>{});
 const source=findSource(id,ctx);
 return {source,refresh:{id,display:source.display,entries:index.entries.length,serial:index.serial,error:null,...(skipped?.length?{skipped}:{})}};
}
function editable(id:string,ctx:Context,what:string):{config:SourcesConfig;index:number} {
 const source=findSource(id,ctx);
 if(source.system) fail('managed.system',`${id} is declared by the system configuration; change it there`);
 if(source.builtin) fail('source.invalid',`${source.display} is built in: it can be disabled, not ${what}`);
 const config=loadConfig(ctx);return {config,index:config.custom!.findIndex(c=>c.id===id)};
}
export function labelSource(id:string,text:string,ctx:Context={}):Source {
 const {config,index}=editable(id,ctx,'relabelled');
 config.custom![index]={...config.custom![index],label:checkLabel(text)};saveConfig(config,ctx);return findSource(id,ctx);
}
export function removeSource(id:string,ctx:Context={}):void {
 const {config,index}=editable(id,ctx,'removed');
 config.custom!.splice(index,1);saveConfig(config,ctx);
 rmSync(cacheDir(id,ctx),{recursive:true,force:true});
}
export function enableSource(id:string,enabled:boolean,ctx:Context={}):Source {
 const source=findSource(id,ctx);
 if(source.system) fail('managed.system',`${id} is declared by the system configuration; change it there`);
 const config=loadConfig(ctx);
 if(source.builtin) config.builtin={...config.builtin,[id]:{enabled}};
 else {const i=config.custom!.findIndex(c=>c.id===id);config.custom![i]={...config.custom![i],enabled};}
 saveConfig(config,ctx);return findSource(id,ctx);
}
/** Cached entries of every enabled source (no network), in resolution order. */
export function cachedEntries(ctx:Context={},{all=false}:{all?:boolean}={}):Array<{source:Source;entry:IndexEntry}> {
 const out:Array<{source:Source;entry:IndexEntry}>=[];
 for(const source of listSources(ctx)) {
  if(!all && !source.enabled) continue;
  for(const entry of readCachedIndex(source.id,ctx)?.entries ?? []) out.push({source,entry});
 }
 return out;
}
export const sourcesDir=(ctx:Context)=>join(rootsOf(ctx).cache,'sources');
export const knownCaches=(ctx:Context)=>existsSync(sourcesDir(ctx))?readdirSync(sourcesDir(ctx)):[];

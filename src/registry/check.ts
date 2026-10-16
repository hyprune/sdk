// Community registry checks 1-14 (RFC-0015 "Pull request checks"), as functions the registry
// CI and `hyprune registry check` share. GitHub API lookups go through an injectable
// GithubClient; downloads through the fetch helper (or an injected fetcher).
import {mkdtempSync,rmSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {RegistryError} from './errors.js';
import {fetchBytes,download,sha256,FETCH_LIMITS,type FetchContext} from './fetch.js';
import {parseRecord,forSchema,INSTALLABLE_TYPES,type IndexDocument,type IndexEntry,type IndexVersion,type ReleaseRecord} from './index.js';
import {extractArchive,limitsFor} from './archive.js';
import {readManifest,libraryRefs} from './sources.js';
import {tagVersion,isPrerelease} from './semver.js';
import {type GithubClient,type GithubRelease} from './github.js';
import {validateRegistry} from '../validation.js';
import parseSpdx from 'spdx-expression-parse';
import {validateWorld} from '../world.js';
import {validateLibrary,imageHeader} from '../object.js';

export interface CheckResult {check:number;name:string;ok:boolean;errors:string[];warnings:string[];skipped?:string}
export interface Tombstone {id:string;versions:'*'|string[];sha256?:string[];reason:string;date?:string;report?:number|string}
export interface CheckOptions extends FetchContext {
 github:GithubClient;
 /** The pull request author (check 2: write access to repo). */
 author?:string;
 /** The entry file's name (check 1: must be <id>.json). */
 fileName?:string;
 /** Other entry files the pull request changes (check 1: one entry per pull request). */
 otherChanges?:string[];
 /** The entry before the change (checks 3-12 run on new versions only; check 14 compares). */
 existing?:IndexEntry|null;
 /** Tombstones of removed links (check 13). */
 removed?:Tombstone[];
 /** The official and community indexes (checks 2 and 11). */
 indexes?:IndexDocument[];
 /** `community` (default) refuses com.hyprune.* ids; `official` requires them. */
 tier?:'community'|'official';
 /** Download and scratch directory (default: a temporary directory). */
 workDir?:string;
 /** Fetch small documents (records, checksums, thumbnails); default: the fetch helper. */
 fetch?:(url:string,max:number)=>Promise<Buffer>;
 /** Run hyprune-world-check when it is on PATH (default true). */
 worldCheck?:boolean;
}
export interface EntryReport {ok:boolean;id:string|null;results:CheckResult[];warnings:string[]}

const result=(check:number,name:string):CheckResult=>({check,name,ok:true,errors:[],warnings:[]});
const err=(r:CheckResult,m:string)=>{r.ok=false;r.errors.push(m);};
const GITHUB_ASSET=/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
/** owner/repo of a https://github.com/<owner>/<repo> URL. */
export function githubRepo(url:string|undefined):{owner:string;repo:string}|undefined {
 const m=/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url ?? '');
 return m?{owner:m[1],repo:m[2]}:undefined;
}
/** Check 1: entry schema, file name, one entry per change. */
export function checkSchema(entry:unknown,o:Pick<CheckOptions,'fileName'|'otherChanges'|'env'>={}):CheckResult {
 const r=result(1,'entry schema'),v=validateRegistry('registry-entry',forSchema(entry,o.env));
 for(const e of v.errors) err(r,e);
 const id=(entry as any)?.id;
 if(v.valid && !INSTALLABLE_TYPES.includes((entry as any).type)) err(r,`type ${(entry as any).type} is reserved: the registry lists worlds and libraries until an extension host exists (RFC-0007)`);
 if(o.fileName && basename(o.fileName)!==`${id}.json`) err(r,`the file must be named ${id}.json, not ${basename(o.fileName)}`);
 for(const other of o.otherChanges ?? []) err(r,`the change also touches ${other}; one entry per pull request`);
 return r;
}
/**
 * Check 2: reserved and owner-bound ids, write access of the author, ids held by another repository.
 * GitHub only shows collaborator permissions to tokens with push access, so the author also
 * counts as a maintainer when they own the repository or created the release of every new version.
 */
export async function checkOwnership(entry:IndexEntry,o:CheckOptions):Promise<CheckResult> {
 const r=result(2,'id and ownership'),repo=githubRepo(entry.repo),tier=o.tier ?? 'community';
 if(tier==='community' && entry.id.startsWith('com.hyprune.')) err(r,'com.hyprune.* ids are reserved for official entries');
 if(tier==='official' && !entry.id.startsWith('com.hyprune.')) err(r,'official entries use com.hyprune.* ids');
 if(!repo) {err(r,'repo must be a https://github.com/<owner>/<repo> URL (the registry lists GitHub Release assets)');return r;}
 const gh=/^io\.github\.([a-z0-9-]+)\./.exec(entry.id);
 if(gh && gh[1]!==repo.owner.toLowerCase()) err(r,`io.github.${gh[1]}.* ids belong to repositories owned by ${gh[1]}, not ${repo.owner}`);
 const info=await o.github.repository(repo.owner,repo.repo);
 if(!info) err(r,`${repo.owner}/${repo.repo} does not exist`);
 if(o.author) {
  const author=o.author.toLowerCase(),p=await o.github.permission(repo.owner,repo.repo,o.author);
  let maintainer=!!p && ['admin','maintain','write'].includes(p) || info?.owner?.toLowerCase()===author;
  if(!maintainer) {
   const fresh=entry.versions.filter(v=>!o.existing?.versions.some(old=>old.tag===v.tag)),releases=fresh.length?await o.github.releases(repo.owner,repo.repo):[];
   maintainer=fresh.length>0 && fresh.every(v=>releases.find(x=>x.tag_name===v.tag)?.author?.login?.toLowerCase()===author);
  }
  if(!maintainer) err(r,`${o.author} has no write access to ${repo.owner}/${repo.repo} (only its maintainers can list it: the owner, a collaborator with write access, or whoever created each new release)`);
 } else if(tier==='community') r.warnings.push('no pull request author given: write access not checked');
 for(const index of o.indexes ?? []) for(const other of index.entries) {
  if(other.id===entry.id && other.repo && entry.repo && githubRepo(other.repo)?.owner.toLowerCase()+'/'+githubRepo(other.repo)?.repo.toLowerCase()!==repo.owner.toLowerCase()+'/'+repo.repo.toLowerCase())
   err(r,`${entry.id} is held by ${other.repo}`);
 }
 return r;
}
/** The repository-naming recommendation (owner addendum): a warning, never a failure. */
export async function checkNaming(entry:IndexEntry,o:Pick<CheckOptions,'github'>):Promise<string[]> {
 const repo=githubRepo(entry.repo);if(!repo) return [];
 const multi=entry.versions.some(v=>tagVersion(v.tag)?.name);
 if(multi) return [];
 const kinds=entry.type==='world'?['world']:['objects','companion','extension','shell'];
 const out:string[]=[];
 const m=/^hyprune-(world|objects|companion|extension|shell)-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(repo.repo);
 if(!m) out.push(`repository name ${repo.repo} doesn't follow the recommended hyprune-<kind>-<name> (kinds world, objects, companion, extension, shell)`);
 else if(!kinds.includes(m[1])) out.push(`repository kind ${m[1]} is unusual for a ${entry.type}`);
 const info=await o.github.repository(repo.owner,repo.repo).catch(()=>null);
 const kind=m?.[1] ?? kinds[0];
 if(info && (!info.topics.includes('hyprune') || !info.topics.includes(`hyprune-${kind}`))) out.push(`recommended GitHub topics: hyprune and hyprune-${kind}`);
 return out;
}
export interface VersionArtifacts {version:IndexVersion;record?:ReleaseRecord;recordBytes?:Buffer;archive?:string;manifest?:any;type?:'world'|'library';root?:string;files?:Array<{path:string;size:number}>;expandedBytes?:number}
/** Check 3: tag naming the version, pointing to the record's commit; release exists, not a draft, pre-release flag right; url an asset of it. */
export async function checkTagRelease(entry:IndexEntry,v:VersionArtifacts,releases:GithubRelease[],o:CheckOptions):Promise<CheckResult> {
 const r=result(3,'tag and release'),repo=githubRepo(entry.repo);
 const named=tagVersion(v.version.tag);
 if(!named || named.version!==v.version.version) err(r,`${v.version.tag} does not name version ${v.version.version}`);
 if(!repo) {err(r,'repo is not a GitHub repository');return r;}
 const commit=await o.github.tagCommit(repo.owner,repo.repo,v.version.tag);
 if(!commit) err(r,`tag ${v.version.tag} does not exist in ${repo.owner}/${repo.repo}`);
 else if(v.record && v.record.source.commit!==commit) err(r,`tag ${v.version.tag} points to ${commit}, the record says ${v.record.source.commit}`);
 const release=releases.find(x=>x.tag_name===v.version.tag);
 if(!release) {err(r,`no release for ${v.version.tag}`);return r;}
 if(release.draft) err(r,`the release for ${v.version.tag} is a draft`);
 if(isPrerelease(v.version.version) && !release.prerelease) err(r,`${v.version.version} is a pre-release but the release is not marked as one`);
 const assets=release.assets.map(a=>a.browser_download_url);
 if(!assets.includes(v.version.url)) err(r,`${v.version.url} is not an asset of the ${v.version.tag} release`);
 const m=GITHUB_ASSET.exec(v.version.url);
 if(m && (m[1].toLowerCase()!==repo.owner.toLowerCase() || m[2].toLowerCase()!==repo.repo.toLowerCase() || decodeURIComponent(m[3])!==v.version.tag)) err(r,'url is not a release asset of the entry\'s repo at its tag');
 if(v.version.record && !assets.includes(v.version.record.url)) err(r,`the record ${v.version.record.url} is not an asset of the release`);
 return r;
}
/** Checks 4 and 5: download within bytes; archive, .sha256 asset, record and entry hashes agree. */
export async function checkDownload(v:VersionArtifacts,release:GithubRelease|undefined,o:CheckOptions,dir:string):Promise<[CheckResult,CheckResult]> {
 const d=result(4,'download and size'),h=result(5,'hashes'),fetch=o.fetch ?? ((u:string,m:number)=>fetchBytes(u,m,o));
 try {v.archive=await download(v.version.url,{bytes:v.version.bytes,sha256:v.version.sha256,dir,...o});}
 catch(e:any) {
  if(e instanceof RegistryError && e.rule==='hash.mismatch') err(h,`archive: ${e.message}`);
  else err(d,e.message);
 }
 if(v.record && v.record.archive.sha256!==v.version.sha256) err(h,`the record pins ${v.record.archive.sha256}, the entry ${v.version.sha256}`);
 if(v.recordBytes && v.version.record && sha256(v.recordBytes)!==v.version.record.sha256) err(h,`the record hashes to ${sha256(v.recordBytes)}, the entry pins ${v.version.record.sha256}`);
 const sum=release?.assets.find(a=>a.name===basename(new URL(v.version.url).pathname)+'.sha256');
 if(!sum) err(h,'missing the .sha256 asset');
 else {
  try {
   const line=(await fetch(sum.browser_download_url,FETCH_LIMITS.checksum)).toString('utf8'),m=/^([0-9a-f]{64})  (\S+)\n?$/.exec(line);
   if(!m) err(h,`${sum.name} is not one sha256sum line`);
   else if(m[1]!==v.version.sha256) err(h,`${sum.name} says ${m[1]}, the entry ${v.version.sha256}`);
  } catch(e:any) {err(h,`${sum.name}: ${e.message}`);}
 }
 return [d,h];
}
/** Checks 7 and 8: the safe extractor (archive rules, limits) and the data-only rules. */
export async function checkExtraction(entry:IndexEntry,v:VersionArtifacts,dir:string):Promise<[CheckResult,CheckResult]> {
 const x=result(7,'safe extraction'),d=result(8,'data only');
 if(!v.archive) {x.skipped=d.skipped='no archive';return [x,d];}
 const staging=mkdtempSync(join(dir,'.extract-'));
 try {
  const out=await extractArchive(v.archive,staging,{limits:limitsFor(entry.type),expectRoot:entry.id});
  v.root=join(staging,out.root);v.files=out.files;v.expandedBytes=out.expandedBytes;
  const {type,manifest}=readManifest(v.root);v.type=type;v.manifest=manifest;
  for(const ext of manifest.requiredExtensions ?? []) if(!['com.hyprune.map','com.hyprune.blueprint'].includes(ext)) err(d,`requiredExtensions: ${ext} is not a data extension core implements`);
 } catch(e:any) {
  const rule=e instanceof RegistryError?e.rule:'';
  if(rule==='data.executable') err(d,e.message);else err(x,e.message);
 }
 return [x,d];
}
/** Check 6: record, entry and manifest agree. */
export function checkAgreement(entry:IndexEntry,v:VersionArtifacts):CheckResult {
 const r=result(6,'record agreement'),rec=v.record,m=v.manifest;
 const same=(what:string,a:unknown,b:unknown,where:string)=>{if(JSON.stringify(a)!==JSON.stringify(b)) err(r,`${what}: ${where} ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);};
 if(rec) {
  same('id',rec.id,entry.id,'record/entry');same('type',rec.type,entry.type,'record/entry');same('version',rec.version,v.version.version,'record/entry');
  same('formatVersion',rec.formatVersion,v.version.formatVersion,'record/entry');same('license',rec.license,v.version.license,'record/entry');
  same('bytes',rec.archive.bytes,v.version.bytes,'record/entry');same('expandedBytes',rec.archive.expandedBytes,v.version.expandedBytes,'record/entry');
  same('files',rec.archive.files,v.version.files,'record/entry');same('requires',rec.requires?.libraries ?? [],v.version.requires?.libraries ?? [],'record/entry');
  same('tag',rec.source.tag,v.version.tag,'record/entry');
  same('thumbnails',(rec.thumbnails ?? []).map(t=>[t.sha256,t.width,t.height]),(v.version.thumbnails ?? []).map(t=>[t.sha256,t.width,t.height]),'record/entry');
 } else r.warnings.push('no release record (required in the official and community registry indexes)');
 if(m) {
  same('id',m.id,entry.id,'manifest/entry');same('version',m.version,v.version.version,'manifest/entry');
  same('formatVersion',m.formatVersion,v.version.formatVersion,'manifest/entry');same('license',m.license,v.version.license,'manifest/entry');
  same('type',v.type,entry.type,'manifest/entry');
  if(entry.type==='world') same('requires',libraryRefs(m),v.version.requires?.libraries ?? [],'manifest/entry');
  if(v.expandedBytes!==undefined) same('expandedBytes',v.expandedBytes,v.version.expandedBytes,'archive/entry');
  if(v.files) same('files',v.files.length,v.version.files,'archive/entry');
 }
 if(v.archive) same('bytes',readFileSync(v.archive).length,v.version.bytes,'archive/entry');
 return r;
}
/** Run hyprune-world-check on a world directory when the binary is on PATH; undefined when it isn't. */
export function worldCheck(dir:string):{ok:boolean;output:string}|undefined {
 try {return {ok:true,output:execFileSync('hyprune-world-check',[dir],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:600_000})};}
 catch(e:any) {if(e.code==='ENOENT') return undefined;return {ok:false,output:String(e.stderr || e.stdout || e.message).trim()};}
}
/** Checks 9 and 10: package validation (SDK, plus hyprune-world-check for worlds when present) and the declared licence. */
export async function checkPackage(entry:IndexEntry,v:VersionArtifacts,o:Pick<CheckOptions,'worldCheck'>={}):Promise<[CheckResult,CheckResult]> {
 const p=result(9,'package validation'),l=result(10,'declared licence');
 if(!v.root || !v.manifest) {p.skipped=l.skipped='not extracted';return [p,l];}
 try {
  if(v.type==='world') {
   await validateWorld(v.root);
   if(o.worldCheck!==false) {
    const w=worldCheck(v.root);
    if(!w) p.warnings.push('hyprune-world-check is not on PATH: core world checks skipped');
    else if(!w.ok) err(p,`hyprune-world-check: ${w.output.split('\n').slice(0,3).join('; ')}`);
   }
  } else await validateLibrary(v.root);
 } catch(e:any) {for(const line of String(e.message).split('\n').slice(0,8)) err(p,line);}
 let spdx=typeof v.manifest.license==='string';
 try {if(spdx) parseSpdx(v.manifest.license);} catch {spdx=false;}
 if(!spdx) err(l,'license is missing or not a valid SPDX expression');
 const attribution:Array<{path:string}>=v.manifest.attribution ?? [];
 for(const f of v.files ?? []) {
  if(v.type==='library' && f.path.startsWith('objects/')) continue;
  if(!attribution.some(a=>a.path==='.' || a.path===f.path || f.path.startsWith(a.path+'/'))) err(l,`attribution does not cover ${f.path}`);
 }
 return [p,l];
}
/** Check 11: every required library id@version is listed in the official or community index. */
export function checkRequirements(v:VersionArtifacts,o:Pick<CheckOptions,'indexes'>):CheckResult {
 const r=result(11,'requirements');
 const refs=v.version.requires?.libraries ?? [];
 if(refs.length && !o.indexes?.length) {r.skipped='no indexes given (--indexes official.json,community.json)';return r;}
 for(const ref of refs) {
  const at=ref.lastIndexOf('@'),id=ref.slice(0,at),version=ref.slice(at+1);
  if(!o.indexes!.some(i=>i.entries.some(e=>e.id===id && e.type==='library' && e.versions.some(x=>x.version===version)))) err(r,`required library ${ref} is not listed in the official or community index`);
 }
 return r;
}
/** Check 12: thumbnails present, hashes, PNG/JPEG, within 1280x720 and 512 KiB. */
export async function checkThumbnails(v:VersionArtifacts,o:CheckOptions):Promise<CheckResult> {
 const r=result(12,'thumbnails'),fetch=o.fetch ?? ((u:string,m:number)=>fetchBytes(u,m,o));
 for(const t of v.version.thumbnails ?? []) {
  try {
   const bytes=await fetch(t.url,FETCH_LIMITS.thumbnail);
   if(sha256(bytes)!==t.sha256) {err(r,`${t.url}: hash differs`);continue;}
   const h=imageHeader(bytes);
   if(!h || h.format==='ktx2') err(r,`${t.url}: not PNG or JPEG`);
   else if(h.width!==t.width || h.height!==t.height || h.width>1280 || h.height>720) err(r,`${t.url}: ${h.width}x${h.height} (declared ${t.width}x${t.height}, at most 1280x720)`);
  } catch(e:any) {err(r,`${t.url}: ${e.message}`);}
 }
 return r;
}
/** Check 13: the id, a version or an archive hash matches a tombstone. */
export function checkRemoved(entry:IndexEntry,o:Pick<CheckOptions,'removed'>):CheckResult {
 const r=result(13,'removed');
 for(const t of o.removed ?? []) {
  if(t.id===entry.id) {
   if(t.versions==='*') err(r,`${entry.id} was removed (${t.reason})`);
   else for(const v of entry.versions) if(t.versions.includes(v.version)) err(r,`${entry.id} ${v.version} was removed (${t.reason})`);
  }
  for(const v of entry.versions) if(t.sha256?.includes(v.sha256)) err(r,`${v.tag}: archive ${v.sha256} was removed (${t.reason}, ${t.id})`);
 }
 return r;
}
/** Check 14: existing versions keep tag, url and sha256; none disappears without a removal. */
export function checkHistory(entry:IndexEntry,o:Pick<CheckOptions,'existing'|'removed'>):CheckResult {
 const r=result(14,'version history');
 for(const old of o.existing?.versions ?? []) {
  const now=entry.versions.find(v=>v.version===old.version);
  if(!now) {
   const removed=(o.removed ?? []).some(t=>t.id===entry.id && (t.versions==='*' || t.versions.includes(old.version)));
   if(!removed) err(r,`version ${old.version} (${old.tag}) disappeared without a removal`);
   continue;
  }
  for(const k of ['tag','url','sha256'] as const) if(now[k]!==old[k]) err(r,`${old.version}: ${k} changed (${old[k]} -> ${now[k]}); a fix is a new version`);
 }
 return r;
}
/**
 * All checks for an entry file. Versions not in `existing` (or whose bytes changed) get the
 * release checks 3-12; checks 1, 2, 13 and 14 cover the whole entry.
 */
export async function checkEntry(value:unknown,o:CheckOptions):Promise<EntryReport> {
 const results:CheckResult[]=[],warnings:string[]=[];
 const schema=checkSchema(value,o);results.push(schema);
 const id=typeof (value as any)?.id==='string'?(value as any).id:null;
 if(!schema.ok) return {ok:false,id,results,warnings};
 const entry=value as IndexEntry;
 results.push(await checkOwnership(entry,o));
 warnings.push(...await checkNaming(entry,o));
 const repo=githubRepo(entry.repo);
 const fresh=entry.versions.filter(v=>!o.existing?.versions.some(old=>old.version===v.version && old.sha256===v.sha256 && old.url===v.url && old.tag===v.tag));
 const work=o.workDir ?? mkdtempSync(join(tmpdir(),'hyprune-check-'));mkdirSync(work,{recursive:true});
 const fetch=o.fetch ?? ((u:string,m:number)=>fetchBytes(u,m,o));
 try {
  const releases=repo && fresh.length?await o.github.releases(repo.owner,repo.repo):[];
  for(const version of fresh) {
   const v:VersionArtifacts={version},label=(r:CheckResult)=>({...r,name:`${r.name} (${version.tag})`});
   if(version.record) {
    try {v.recordBytes=await fetch(version.record.url,FETCH_LIMITS.record);v.record=parseRecord(v.recordBytes,{what:version.record.url,env:o.env});}
    catch(e:any) {const r=result(6,'record agreement');err(r,`release record: ${e.message}`);results.push(label(r));}
   }
   results.push(label(await checkTagRelease(entry,v,releases,o)));
   const dir=join(work,version.sha256);mkdirSync(dir,{recursive:true});
   const release=releases.find(x=>x.tag_name===version.tag);
   for(const r of await checkDownload(v,release,o,dir)) results.push(label(r));
   const [x,d]=await checkExtraction(entry,v,dir);
   results.push(label(checkAgreement(entry,v)),label(x),label(d));
   for(const r of await checkPackage(entry,v,o)) results.push(label(r));
   results.push(label(checkRequirements(v,o)),label(await checkThumbnails(v,o)));
  }
 } finally {if(!o.workDir) rmSync(work,{recursive:true,force:true});}
 results.push(checkRemoved(entry,o),checkHistory(entry,o));
 for(const r of results) warnings.push(...r.warnings);
 return {ok:results.every(r=>r.ok),id,results:results.sort((a,b)=>a.check-b.check),warnings};
}
export {existsSync};

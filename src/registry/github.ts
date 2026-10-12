// github: sources (RFC-0015 "Custom sources"): the repository's release list through the
// GitHub REST API, never the repository itself. Each release that follows the release
// convention becomes a version; releases without a valid release record are skipped.
import {fail,RegistryError} from './errors.js';
import {fetchBytes,decodeJson,githubApi,FETCH_LIMITS,sha256,type FetchContext} from './fetch.js';
import {parseRecord,checkIndex,type IndexDocument,type IndexEntry,type IndexVersion,type ReleaseRecord} from './index.js';
import {tagVersion,isPrerelease,compareSemver} from './semver.js';

export interface GithubAsset {name:string;size:number;browser_download_url:string;updated_at?:string}
export interface GithubRelease {tag_name:string;draft:boolean;prerelease:boolean;published_at:string|null;assets:GithubAsset[]}
export type Permission='admin'|'maintain'|'write'|'triage'|'read'|'none';
/** The GitHub API calls registry code needs; tests and the registry CI inject their own. */
export interface GithubClient {
 releases(owner:string,repo:string):Promise<GithubRelease[]>;
 /** The commit a tag points to (annotated tags peeled), or null when the tag doesn't exist. */
 tagCommit(owner:string,repo:string,tag:string):Promise<string|null>;
 /** A user's permission on a repository, or null when unknown. */
 permission(owner:string,repo:string,user:string):Promise<Permission|null>;
 /** The repository's owner login, full name and topics, or null when it doesn't exist. */
 repository(owner:string,repo:string):Promise<{owner:string;fullName:string;topics:string[]}|null>;
}
export interface GithubSpec {owner:string;repo:string;name:string|null}
const OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,REPO=/^[A-Za-z0-9._-]{1,100}$/,NAME=/^[a-z0-9]+(-[a-z0-9]+)*$/;
/** `owner/repo[/name]` (with or without the github: prefix). */
export function parseGithub(text:string):GithubSpec {
 const [owner,repo,name,...rest]=text.replace(/^github:/,'').split('/');
 if(!owner || !repo || rest.length || !OWNER.test(owner) || !REPO.test(repo) || repo==='.' || repo==='..' || (name!==undefined && !NAME.test(name)))
  fail('source.invalid',`${text}: expected github:owner/repo or github:owner/repo/name`);
 return {owner,repo,name:name ?? null};
}
export const githubRepoUrl=(s:GithubSpec)=>`https://github.com/${s.owner}/${s.repo}`;

/** The HTTP implementation (HYPRUNE_GITHUB_API, GITHUB_TOKEN to the API host only). */
export function githubClient(ctx:FetchContext={}):GithubClient {
 const api=githubApi(ctx.env),json=async(path:string,allow404=false)=>{
  try {return decodeJson(await fetchBytes(api+path,FETCH_LIMITS.apiPage,{...ctx,accept:'application/vnd.github+json'}),path) as any;}
  catch(e) {if(allow404 && e instanceof RegistryError && / HTTP 404$/.test(e.message)) return null;throw e;}
 };
 const seg=encodeURIComponent;
 return {
  async releases(owner,repo) {
   const all:GithubRelease[]=[];
   for(let page=1;page<=10;page++) {
    const list=await json(`/repos/${seg(owner)}/${seg(repo)}/releases?per_page=100&page=${page}`);
    if(!Array.isArray(list)) fail('source.invalid',`${owner}/${repo}: unexpected release list`);
    all.push(...list);
    if(list.length<100) break;
   }
   return all;
  },
  async tagCommit(owner,repo,tag) {
   const ref=await json(`/repos/${seg(owner)}/${seg(repo)}/git/ref/tags/${seg(tag)}`,true);
   if(!ref?.object) return null;
   if(ref.object.type==='commit') return ref.object.sha;
   const annotated=await json(`/repos/${seg(owner)}/${seg(repo)}/git/tags/${seg(ref.object.sha)}`,true);
   return annotated?.object?.type==='commit'?annotated.object.sha:null;
  },
  async permission(owner,repo,user) {
   const r=await json(`/repos/${seg(owner)}/${seg(repo)}/collaborators/${seg(user)}/permission`,true);
   return r?.role_name==='maintain'?'maintain':(r?.permission ?? null);
  },
  async repository(owner,repo) {
   const r=await json(`/repos/${seg(owner)}/${seg(repo)}`,true);
   return r?{owner:r.owner?.login,fullName:r.full_name,topics:Array.isArray(r.topics)?r.topics:[]}:null;
  },
 };
}

export interface ReleaseVersion {record:ReleaseRecord;version:IndexVersion;release:GithubRelease}
export interface Skipped {tag:string;reason:string}
/** Fetch an asset of at most `max` bytes; `key` identifies the asset version (size, update time) for caches. */
type Fetch=(url:string,max:number,key?:string)=>Promise<Buffer>;
/**
 * Read one release by the convention: exactly one `<id>-<version>.release.json` record, its
 * archive and `.sha256` assets agreeing with it, the tag naming the record's version, and
 * the pre-release flag matching the version. Returns the index version or a skip reason.
 */
export async function readRelease(spec:GithubSpec,release:GithubRelease,fetch:Fetch,env=process.env):Promise<ReleaseVersion|Skipped> {
 const tag=release.tag_name,skip=(reason:string)=>({tag,reason});
 if(release.draft) return skip('draft release');
 const named=tagVersion(tag);
 if(!named) return skip('tag does not follow v<version> or <name>-v<version>');
 if(spec.name!==null && named.name!==spec.name) return skip(`not a ${spec.name}-v<version> tag`);
 if(isPrerelease(named.version)!==release.prerelease) return skip(release.prerelease?'marked pre-release but the version has no pre-release part':'pre-release version not marked as a pre-release');
 const records=release.assets.filter(a=>a.name.endsWith(`-${named.version}.release.json`));
 if(records.length!==1) return skip(records.length?'several release records':'no release record');
 let record:ReleaseRecord,recordBytes:Buffer;
 try {recordBytes=await fetch(records[0].browser_download_url,FETCH_LIMITS.record,`${records[0].size}:${records[0].updated_at ?? ''}`);record=parseRecord(recordBytes,{what:records[0].name,env});}
 catch(e:any) {return skip(`release record: ${e.message}`);}
 if(records[0].name!==`${record.id}-${record.version}.release.json`) return skip('record name does not match its id and version');
 if(record.version!==named.version || record.source.tag!==tag) return skip(`record names ${record.source.tag} (${record.version})`);
 const asset=(name:string)=>release.assets.find(a=>a.name===name);
 const archive=asset(record.archive.name),sum=asset(record.archive.name+'.sha256');
 if(!archive) return skip(`missing asset ${record.archive.name}`);
 if(archive.size!==record.archive.bytes) return skip(`${record.archive.name} is ${archive.size} bytes, the record says ${record.archive.bytes}`);
 if(!sum) return skip(`missing asset ${record.archive.name}.sha256`);
 try {
  const line=(await fetch(sum.browser_download_url,FETCH_LIMITS.checksum)).toString('utf8');
  const m=/^([0-9a-f]{64})  (\S+)\n?$/.exec(line);
  if(!m || m[2]!==record.archive.name) return skip(`${sum.name} is not one sha256sum line for ${record.archive.name}`);
  if(m[1]!==record.archive.sha256) return skip(`${sum.name} disagrees with the record`);
 } catch(e:any) {return skip(`${sum.name}: ${e.message}`);}
 const thumbnails=[];
 for(const t of record.thumbnails || []) {
  const a=asset(t.name);
  if(!a) return skip(`missing asset ${t.name}`);
  thumbnails.push({url:a.browser_download_url,sha256:t.sha256,width:t.width,height:t.height});
 }
 const version:IndexVersion={tag,version:record.version,formatVersion:record.formatVersion,
  published:(release.published_at || new Date().toISOString()).slice(0,10),license:record.license,url:archive.browser_download_url,
  sha256:record.archive.sha256,bytes:record.archive.bytes,expandedBytes:record.archive.expandedBytes,files:record.archive.files,
  record:{url:records[0].browser_download_url,sha256:sha256(recordBytes)},
  ...(record.requires?{requires:record.requires}:{}),...(thumbnails.length?{thumbnails}:{}),status:'available'};
 return {record,version,release};
}
/**
 * The entries of a repository's releases, newest version first, as an index document (serial
 * 1: GitHub sources have no rollback serial; tags never move). `skipped` lists ignored releases.
 */
export async function githubIndex(spec:GithubSpec,client:GithubClient,fetch:Fetch,env=process.env):Promise<{index:IndexDocument;skipped:Skipped[]}> {
 const releases=await client.releases(spec.owner,spec.repo),skipped:Skipped[]=[];
 const byId=new Map<string,{entry:IndexEntry;records:ReleaseVersion[]}>();
 for(const release of releases) {
  const r=await readRelease(spec,release,fetch,env);
  if(!('record' in r)) {skipped.push(r);continue;}
  const known=byId.get(r.record.id);
  if(known && known.entry.type!==r.record.type) {skipped.push({tag:r.version.tag,reason:`${r.record.id} is listed as a ${known.entry.type}`});continue;}
  if(known?.records.some(x=>x.version.version===r.version.version)) {skipped.push({tag:r.version.tag,reason:`duplicate version ${r.version.version}`});continue;}
  if(known) known.records.push(r);
  else byId.set(r.record.id,{entry:{id:r.record.id,type:r.record.type,name:r.record.name,creator:spec.owner,repo:githubRepoUrl(spec),versions:[]},records:[r]});
 }
 const entries:IndexEntry[]=[];
 for(const {entry,records} of byId.values()) {
  records.sort((a,b)=>compareSemver(b.version.version,a.version.version));
  // The newest version names the entry; at most 64 versions are listed.
  entry.name=records[0].record.name;entry.versions=records.slice(0,64).map(r=>r.version);
  entries.push(entry);
 }
 const index:IndexDocument={indexVersion:'0.1',name:`${spec.owner}/${spec.repo}${spec.name?'/'+spec.name:''}`.slice(0,64),serial:1,
  generated:new Date().toISOString().replace(/\.\d+Z$/,'Z'),successor:null,entries};
 return {index:checkIndex(index,env),skipped};
}

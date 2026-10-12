// Listing documents of the CLI JSON contract (DESIGN "CLI JSON contract"): sources, browse
// (from the cache only) and content (installs).
import {join} from 'node:path';
import {listSources,readMeta,readCachedIndex,cachedEntries,thumbnailPath,tierOf,licenceNote,rootsOf,type Context,type Source} from './sources.js';
import {readContent,scanWorlds,scanLibraries,type InstallRecord} from './content.js';
import {newestInstallable,newerThan,loadable,available,type IndexEntry,type IndexVersion} from './index.js';
import {isPrerelease,compareSemver} from './semver.js';
import type {PackageType} from './archive.js';

export interface SourceListItem {id:string;kind:Source['kind'];label:string;display:string;url?:string;repo?:string;sha256?:string;enabled:boolean;builtin:boolean;system:boolean;
 lastRefresh:string|null;serial:number|null;entries:number;error:string|null;successor?:string}
export function sourceList(ctx:Context={}):{sources:SourceListItem[]} {
 return {sources:listSources(ctx).map((s):SourceListItem=>{
  const meta=readMeta(s.id,ctx);
  return {id:s.id,kind:s.kind,label:s.label,display:s.display,...(s.kind==='github'?{repo:s.repo}:{url:s.url}),...(s.sha256?{sha256:s.sha256}:{}),
   enabled:s.enabled,builtin:s.builtin,system:s.system,lastRefresh:meta.fetched,serial:meta.serial,entries:readCachedIndex(s.id,ctx)?.entries.length ?? 0,
   error:meta.error,...(meta.successor?{successor:meta.successor}:{})};
 })};
}
const versionInfo=(type:PackageType,v:IndexVersion)=>({tag:v.tag,version:v.version,formatVersion:v.formatVersion,license:v.license,bytes:v.bytes,expandedBytes:v.expandedBytes,
 published:v.published,status:v.status ?? 'available',prerelease:isPrerelease(v.version),loadable:loadable(type,v.formatVersion),requires:v.requires?.libraries ?? []});
export interface BrowseOptions {text?:string;type?:PackageType;source?:string}
export function browse(opts:BrowseOptions,ctx:Context={}) {
 const records=readContent(rootsOf(ctx)).installs,needle=opts.text?.toLowerCase();
 const entries=cachedEntries(ctx).filter(({source,entry})=>(!opts.type || entry.type===opts.type) && (!opts.source || source.id===opts.source) &&
  (!needle || [entry.id,entry.name,entry.summary ?? '',...(entry.tags ?? [])].some(t=>t.toLowerCase().includes(needle))));
 return {entries:entries.map(({source,entry})=>{
  const latest=newestInstallable(entry) ?? entry.versions[0],record=records.find(r=>r.id===entry.id && r.type===entry.type);
  return {sourceId:source.id,display:source.display,tier:tierOf(source.kind),id:entry.id,type:entry.type,name:entry.name,summary:entry.summary ?? null,
   description:entry.description ?? null,creator:entry.creator,repo:entry.repo ?? null,tags:entry.tags ?? [],
   latest:latest?versionInfo(entry.type,latest):null,licenceNote:licenceNote(source.kind),thumbnail:thumbnailPath(latest,ctx),
   installed:record?{tag:record.current.tag,sourceId:record.source}:null,
   update:record && record.source===source.id?newerThan(entry,record.current.version)?.tag ?? null:null,
   versions:entry.versions.map(v=>versionInfo(entry.type,v))};
 })};
}
function sourceState(id:string,sources:Source[]):{display:string;state:'enabled'|'disabled'|'removed'|null;source?:Source} {
 const s=sources.find(s=>s.id===id);
 if(s) return {display:s.display,state:s.enabled?'enabled':'disabled',source:s};
 if(id==='local') return {display:'Local',state:null};
 if(id==='file') return {display:'File',state:null};
 if(id==='system') return {display:'System',state:null};
 if(id.startsWith('github:')) return {display:`Custom: ${id.slice(7).split('/').slice(0,2).join('/')}`,state:null};
 try {return {display:`Custom: ${new URL(id).host}`,state:null};} catch {return {display:`Custom: ${id}`,state:'removed'};}
}
export function contentList(ctx:Context={},{type}:{type?:PackageType}={}) {
 const roots=rootsOf(ctx),doc=readContent(roots),sources=listSources(ctx),worlds=scanWorlds(roots),libraries=scanLibraries(roots);
 const installs:any[]=[];
 const describe=(r:InstallRecord,path:string,managed:'user'|'system')=>{
  const s=sourceState(r.source,sources);let entry:IndexEntry|undefined;
  if(s.source?.enabled) entry=readCachedIndex(s.source.id,ctx)?.entries.find(e=>e.id===r.id && e.type===r.type);
  const cached=s.source?.enabled && readCachedIndex(s.source.id,ctx);
  return {id:r.id,type:r.type,sourceId:r.source,display:s.display,sourceState:s.state,tag:r.current.tag,version:r.current.version,
   previous:r.previous?{tag:r.previous.tag,version:r.previous.version}:null,pinned:r.pinned,pending:r.pending,managed,
   removedFromSource:!!cached && !entry,newerTag:entry?newerThan(entry,r.current.version)?.tag ?? null:null,
   license:r.current.license,sha256:r.current.sha256,path};
 };
 const bare=(id:string,t:PackageType,version:string,path:string,managed:'user'|'system',license:string|null)=>({id,type:t,sourceId:managed==='system'?'system':'local',
  display:managed==='system'?'System':'Local',sourceState:null,tag:null,version,previous:null,pinned:false,pending:null,managed,removedFromSource:false,newerTag:null,license,sha256:null,path});
 for(const w of worlds) {
  const r=doc.installs.find(r=>r.id===w.id && r.type==='world');
  installs.push(r && w.managed==='user'?describe(r,w.path,'user'):bare(w.id,'world',w.version,w.path,w.managed,w.license));
 }
 for(const r of doc.installs.filter(r=>r.type==='world' && !worlds.some(w=>w.id===r.id))) installs.push({...describe(r,join(roots.worlds,r.id),'user'),missing:true});
 const recorded=new Set<string>();
 for(const r of doc.installs.filter(r=>r.type==='library')) {
  const dir=libraries.find(l=>l.id===r.id && l.version===r.current.version && l.managed==='user');
  installs.push({...describe(r,dir?.path ?? join(roots.libraries,`${r.id}@${r.current.version}`),'user'),...(dir?{}:{missing:true})});
  recorded.add(`${r.id}@${r.current.version}`);if(r.previous) recorded.add(`${r.id}@${r.previous.version}`);
 }
 for(const l of libraries) if(l.managed==='system' || !recorded.has(`${l.id}@${l.version}`)) installs.push(bare(l.id,'library',l.version,l.path,l.managed,l.license));
 installs.sort((a,b)=>a.type.localeCompare(b.type) || a.id.localeCompare(b.id) || compareSemver(b.version,a.version));
 return {installs:installs.filter(i=>!type || i.type===type)};
}
export {available};

// Index documents (RFC-0015 "Index format"): parse with every limit, serial rollback
// protection, entries keyed by (sourceId, id), and version loadability.
import {fail} from './errors.js';
import {decodeJson,FETCH_LIMITS} from './fetch.js';
import {validateRegistry,worldFormats,objectFormats} from '../validation.js';
import {compareSemver,isPrerelease} from './semver.js';
import type {Index01_Document,Index01_Entry,Index01_VersionEntry,ReleaseRecord01_Document} from '../generated.js';

export type IndexDocument=Index01_Document;
export type IndexEntry=Index01_Entry;
export type IndexVersion=Index01_VersionEntry;
export type ReleaseRecord=ReleaseRecord01_Document;
type Env=Record<string,string|undefined>;

/** Index format versions this SDK reads (the registry schema directories it vendors). */
export const SUPPORTED_INDEX=['0.1'];
// Loopback HTTP URLs (tests with HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP=1) validate as HTTPS.
export function forSchema(value:unknown,env:Env=process.env):unknown {
 if(env.HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP!=='1') return value;
 return JSON.parse(JSON.stringify(value).replace(/"http:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/])/g,'"https://$1$2'));
}
/**
 * Parse and validate an index: at most 16 MiB, UTF-8 JSON without duplicate keys, a
 * supported indexVersion, the 0.1 schema and semantic rules, and a serial not lower than
 * the last one accepted from the source.
 */
export function parseIndex(bytes:Buffer,{what='index',lastSerial,env=process.env}:{what?:string;lastSerial?:number|null;env?:Env}={}):IndexDocument {
 if(bytes.length>FETCH_LIMITS.index) fail('source.invalid',`${what}: ${bytes.length} bytes, more than 16 MiB`);
 const value=decodeJson(bytes,what) as any;
 if(value && typeof value==='object' && typeof value.indexVersion==='string' && !SUPPORTED_INDEX.includes(value.indexVersion))
  fail('format.unsupported',`${what}: index version ${value.indexVersion}; this source needs a newer Hyprune`);
 const result=validateRegistry('registry-index',forSchema(value,env));
 if(!result.valid) fail('source.invalid',`${what}: ${result.errors.slice(0,3).join('; ')}${result.errors.length>3?` (+${result.errors.length-3} more)`:''}`);
 if(lastSerial!=null && value.serial<lastSerial) fail('source.invalid',`${what}: serial ${value.serial} is lower than the last accepted ${lastSerial} (rollback refused; the cached index is kept)`);
 return value as IndexDocument;
}
/** Validate a release record (1 MiB cap, schema and semantic rules). */
export function parseRecord(bytes:Buffer,{what='release record',env=process.env}:{what?:string;env?:Env}={}):ReleaseRecord {
 if(bytes.length>FETCH_LIMITS.record) fail('source.invalid',`${what}: more than 1 MiB`);
 const value=decodeJson(bytes,what);
 // A meta-repository pins map (libraries/releases.json shape: {"<id>@<version>": {id, version, url,
 // sha256, ...}}) is not a release record: say so, and name the archive to add instead.
 if(value && typeof value==='object' && !Array.isArray(value) && !('recordVersion' in value)) {
  const pins=Object.entries(value as Record<string,any>).filter(([k,v])=>/@/.test(k) && v && typeof v==='object' && typeof v.url==='string' && typeof v.sha256==='string');
  if(pins.length) {
   const [,p]=pins[0];
   fail('source.invalid',`${what}: this is a meta-repository pins map (libraries/releases.json shape, keyed by id@version), not an RFC-0015 release record (recordVersion 0.1). `+
    `Add the release record (<id>-<version>.release.json) instead, or the archive itself: hyprune library add ${p.url} --sha256 ${p.sha256}`);
  }
 }
 const result=validateRegistry('release-record',forSchema(value,env));
 if(!result.valid) fail('source.invalid',`${what}: ${result.errors.slice(0,3).join('; ')}`);
 return value as ReleaseRecord;
}
/** Validate an index built from another source (GitHub releases, a record or an archive). */
export function checkIndex(index:IndexDocument,env:Env=process.env):IndexDocument {
 const result=validateRegistry('registry-index',forSchema(index,env));
 if(!result.valid) fail('source.invalid',`index: ${result.errors.slice(0,3).join('; ')}`);
 return index;
}
/** True when this SDK knows the package format: world formats, or object formats for libraries. */
export function loadable(type:'world'|'library',formatVersion:string):boolean {
 return (type==='world'?worldFormats:objectFormats).includes(formatVersion);
}
export const available=(v:IndexVersion)=>(v.status ?? 'available')==='available';
/**
 * The version an install takes without a tag: the newest available, loadable, non-pre-release
 * tag (RFC-0015 Resolve). With `prerelease` pre-releases count too.
 */
export function newestInstallable(entry:IndexEntry,{prerelease=false}:{prerelease?:boolean}={}):IndexVersion|undefined {
 return [...entry.versions].filter(v=>available(v) && loadable(entry.type,v.formatVersion) && (prerelease || !isPrerelease(v.version)))
  .sort((a,b)=>compareSemver(b.version,a.version))[0];
}
/** The update for an installed version: a newer, available, loadable, non-pre-release tag. */
export function newerThan(entry:IndexEntry,version:string|null):IndexVersion|undefined {
 const best=newestInstallable(entry);
 return best && (version===null || compareSemver(best.version,version)>0)?best:undefined;
}

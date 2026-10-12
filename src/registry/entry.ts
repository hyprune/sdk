// `hyprune registry entry`: the community registry entry for a release, from the release
// assets in a directory (pack --release output) or from a published GitHub release.
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {fail} from './errors.js';
import {parseRecord,checkIndex,type IndexEntry,type IndexVersion,type ReleaseRecord} from './index.js';
import {readRelease,parseGithub,githubClient,type GithubClient} from './github.js';
import {fetchBytes,sha256,githubDownload,type FetchContext} from './fetch.js';
import {compareSemver,matchTag} from './semver.js';
import {githubRepo} from './check.js';

export const ENTRY_SCHEMA='https://hyprune.com/schema/registry/v0.1/index.schema.json#/$defs/entry';
export interface EntryOptions extends FetchContext {
 /** Merge into this existing entry (new version first; the same version is replaced). */
 existing?:IndexEntry;summary?:string;description?:string;tags?:string[];id?:string;
 github?:GithubClient;
}
function merge(base:IndexEntry|undefined,fresh:IndexEntry,o:EntryOptions):IndexEntry & {$schema:string} {
 const versions=[fresh.versions[0],...(base?.versions ?? []).filter(v=>v.version!==fresh.versions[0].version)].sort((a,b)=>compareSemver(b.version,a.version));
 if(base && base.id!==fresh.id) fail('package.invalid',`the existing entry is ${base.id}, the release ${fresh.id}`);
 const entry:any={$schema:ENTRY_SCHEMA,id:fresh.id,type:fresh.type,name:fresh.name,
  ...(o.summary ?? base?.summary?{summary:o.summary ?? base?.summary}:{}),...(o.description ?? base?.description?{description:o.description ?? base?.description}:{}),
  creator:base?.creator ?? fresh.creator,repo:fresh.repo ?? base?.repo,...(o.tags ?? base?.tags?{tags:o.tags ?? base?.tags}:{}),versions:versions.slice(0,64)};
 if(!entry.repo) delete entry.repo;
 return entry;
}
/** The entry for the release assets in `dir` (the record names the GitHub repository and tag the assets will be published at). */
export function entryFromDirectory(dir:string,o:EntryOptions={}):IndexEntry & {$schema:string} {
 const records=readdirSync(dir).filter(n=>n.endsWith('.release.json') && (!o.id || n.startsWith(o.id+'-')));
 if(records.length!==1) fail('not.found',`${dir}: expected one <id>-<version>.release.json${records.length?` (found ${records.join(', ')}; pass --id)`:''}`);
 const bytes=readFileSync(join(dir,records[0])),record=parseRecord(bytes,{what:records[0],env:o.env});
 const repo=githubRepo(record.source.repo);
 if(!repo) fail('package.invalid',`${record.source.repo}: the community registry lists GitHub Release assets; the record's repo must be https://github.com/<owner>/<repo>`);
 const base=`${githubDownload(o.env)}/${repo!.owner}/${repo!.repo}/releases/download/${encodeURIComponent(record.source.tag)}/`;
 for(const name of [record.archive.name,record.archive.name+'.sha256',...(record.thumbnails ?? []).map(t=>t.name)])
  if(!existsSync(join(dir,name))) fail('not.found',`${dir}: missing ${name}`);
 if(statSync(join(dir,record.archive.name)).size!==record.archive.bytes) fail('package.invalid',`${record.archive.name} is not ${record.archive.bytes} bytes`);
 const version:IndexVersion={tag:record.source.tag,version:record.version,formatVersion:record.formatVersion,published:new Date().toISOString().slice(0,10),license:record.license,
  url:base+record.archive.name,sha256:record.archive.sha256,bytes:record.archive.bytes,expandedBytes:record.archive.expandedBytes,files:record.archive.files,
  record:{url:base+records[0],sha256:sha256(bytes)},...(record.requires?{requires:record.requires}:{}),
  ...(record.thumbnails?.length?{thumbnails:record.thumbnails.map(t=>({url:base+t.name,sha256:t.sha256,width:t.width,height:t.height}))}:{})};
 return merge(o.existing,{id:record.id,type:record.type,name:record.name,creator:repo!.owner,repo:`https://github.com/${repo!.owner}/${repo!.repo}`,versions:[version]},o);
}
/** The entry for a published release: `github:owner/repo[/name]@tag`. */
export async function entryFromGithub(spec:string,o:EntryOptions={}):Promise<IndexEntry & {$schema:string}> {
 const at=spec.lastIndexOf('@');
 if(at<0) fail('source.invalid',`${spec}: expected github:owner/repo[/name]@tag`);
 const g=parseGithub(spec.slice(0,at)),tag=spec.slice(at+1),client=o.github ?? githubClient(o);
 const releases=await client.releases(g.owner,g.repo);
 const release=releases.find(r=>r.tag_name===tag) ?? (()=>{const v=matchTag(releases.map(r=>({tag:r.tag_name,version:r.tag_name.replace(/^.*v/,'')})),tag);return v && releases.find(r=>r.tag_name===v.tag);})();
 if(!release) fail('not.found',`${g.owner}/${g.repo} has no release ${tag}`);
 const r=await readRelease(g,release!,(url,max)=>fetchBytes(url,max,o),o.env);
 if(!('record' in r)) return fail('package.invalid',`${tag}: ${r.reason}`);
 const fresh:IndexEntry={id:r.record.id,type:r.record.type,name:r.record.name,creator:g.owner,repo:`https://github.com/${g.owner}/${g.repo}`,versions:[r.version]};
 const entry=merge(o.existing,fresh,o);
 checkIndex({indexVersion:'0.1',serial:1,generated:'2026-01-01T00:00:00Z',entries:[{...entry,$schema:undefined} as any].map(({$schema,...e})=>e)},o.env);
 return entry;
}
export type {ReleaseRecord};

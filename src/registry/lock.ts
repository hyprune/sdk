// `hyprune content lock` (RFC-0015 P3): the user's installed content at exact releases, for the
// Nix and Home Manager modules (registry/v0.1/content-lock.schema.json). Only installs with an
// archive URL and hash can be locked; local and offline installs are reported as skipped.
import {listSources,rootsOf,type Context} from './sources.js';
import {readContent} from './content.js';
import {forSchema} from './index.js';
import {validateRegistry} from '../validation.js';
import {RegistryError} from './errors.js';
import type {PackageType} from './archive.js';

export interface LockPackage {id:string;type:PackageType;version:string;tag:string|null;url:string;sha256:string;nixHash:string;sourceId:string;sourceLabel:string;license:string|null}
export interface ContentLock {lockVersion:'0.1';generated:string;packages:LockPackage[]}
export interface LockResult {lock:ContentLock;skipped:Array<{id:string;type:PackageType;reason:string}>}

/** The SRI form of a hex sha256 (what Nix's fetchurl takes as `hash`). */
export const nixHash=(sha256:string)=>'sha256-'+Buffer.from(sha256,'hex').toString('base64');

export function contentLock(ctx:Context={}):LockResult {
 const env=(ctx as any).env ?? process.env;
 const sources=listSources(ctx),records=readContent(rootsOf(ctx)).installs;
 const label=(id:string)=>sources.find(s=>s.id===id)?.display ?? (id.startsWith('github:')?`Custom: ${id.slice(7)}`:id);
 const packages:LockPackage[]=[],skipped:LockResult['skipped']=[];
 for(const r of [...records].sort((a,b)=>a.type.localeCompare(b.type) || a.id.localeCompare(b.id))) {
  const c=r.current;
  if(!c.url || !c.sha256) {skipped.push({id:r.id,type:r.type,reason:r.source==='local'?'installed by hand (no archive)':'no archive URL recorded (an offline install)'});continue;}
  packages.push({id:r.id,type:r.type,version:c.version,tag:c.tag ?? null,url:c.url,sha256:c.sha256,nixHash:nixHash(c.sha256),
   sourceId:r.source,sourceLabel:label(r.source).slice(0,160),license:c.license ?? null});
 }
 const lock:ContentLock={lockVersion:'0.1',generated:new Date().toISOString().replace(/\.\d+Z$/,'Z'),packages};
 const check=validateRegistry('content-lock' as any,forSchema(lock,env));
 if(!check.valid) throw new RegistryError('package.invalid',`content lock: ${check.errors.slice(0,3).join('; ')}`);
 return {lock,skipped};
}

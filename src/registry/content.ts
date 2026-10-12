// Install records (RFC-0015 "Where state lives"): $XDG_STATE_HOME/hyprune/content.json,
// replaced atomically (0600) under content.lock (O_EXCL + pid; a lock whose pid is gone is
// stale). Commit renames are journalled first, so an interrupted commit is completed or
// undone by the next content operation.
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,unlinkSync,writeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {fail} from './errors.js';
import {writeJsonAtomic,readManifest} from './sources.js';
import type {ContentRoots} from './paths.js';

import type {PackageType} from './archive.js';

export interface InstallState {tag:string|null;version:string;sha256:string|null;digest:string|null;license:string|null;url:string|null;installed:string}
export interface InstallRecord {
 id:string;type:PackageType;
 /** A source id, or `local` (found on disk without a record) or `file` (an offline archive without a matching index entry). */
 source:string;pinned:boolean;current:InstallState;previous:InstallState|null;pending:null;
}
/** A world commit in progress: staging holds the new tree; `record` is written once it is in place. */
export interface Journal {type:PackageType;id:string;staging:string;target:string;previousDir:string|null;record:InstallRecord|null}
export interface ContentFile {version:1;installs:InstallRecord[];journal?:Journal|null}

const file=(roots:ContentRoots)=>join(roots.state,'content.json');
export function readContent(roots:ContentRoots):ContentFile {
 try {
  const doc=JSON.parse(readFileSync(file(roots),'utf8'));
  if(doc?.version!==1 || !Array.isArray(doc.installs)) fail('package.invalid',`${file(roots)}: not a version 1 content file`);
  return doc;
 } catch(e:any) {if(e.code==='ENOENT') return {version:1,installs:[]};throw e;}
}
export const writeContent=(roots:ContentRoots,doc:ContentFile)=>writeJsonAtomic(file(roots),doc);
export const findRecord=(doc:ContentFile,id:string,type?:PackageType)=>doc.installs.find(r=>r.id===id && (!type || r.type===type));
export function putRecord(doc:ContentFile,record:InstallRecord):void {
 const i=doc.installs.findIndex(r=>r.id===record.id && r.type===record.type);
 if(i<0) doc.installs.push(record);else doc.installs[i]=record;
 doc.installs.sort((a,b)=>a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}
export function dropRecord(doc:ContentFile,id:string,type:PackageType):void {doc.installs=doc.installs.filter(r=>!(r.id===id && r.type===type));}

const alive=(pid:number)=>{try {process.kill(pid,0);return true;} catch(e:any) {return e.code==='EPERM';}};
/**
 * Run `fn` under content.lock. Waits up to `waitMs` for another holder; a lock left by a
 * dead process is taken over. Recovers an interrupted commit before `fn` runs.
 */
export async function withLock<T>(roots:ContentRoots,fn:(doc:ContentFile)=>Promise<T>|T,{waitMs=10_000}:{waitMs?:number}={}):Promise<T> {
 mkdirSync(roots.state,{recursive:true,mode:0o700});
 const lock=join(roots.state,'content.lock'),deadline=Date.now()+waitMs;
 for(;;) {
  try {
   const fd=openSync(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
   writeSync(fd,`${process.pid}\n`);closeSync(fd);break;
  } catch(e:any) {
   if(e.code!=='EEXIST') throw e;
   const pid=Number(readFileSync(lock,'utf8').trim());
   if(!Number.isInteger(pid) || pid<=0 || !alive(pid)) {try {unlinkSync(lock);} catch {}continue;}
   if(Date.now()>deadline) fail('content.conflict',`another content operation holds ${lock} (pid ${pid})`);
   await new Promise(r=>setTimeout(r,100));
  }
 }
 try {
  const doc=readContent(roots);
  if(doc.journal) {recover(roots,doc);writeContent(roots,doc);}
  return await fn(doc);
 } finally {try {unlinkSync(lock);} catch {}}
}
/** Complete (the staged tree exists and the target is free) or undo (the target is still there) a journalled commit. */
export function recover(roots:ContentRoots,doc:ContentFile):void {
 const j=doc.journal;if(!j) return;
 const exists=(p:string)=>{try {lstatSync(p);return true;} catch {return false;}};
 if(exists(j.staging) && !exists(j.target)) {
  renameSync(j.staging,j.target);
  if(j.record) putRecord(doc,j.record);
 } else if(!exists(j.staging) && exists(j.target) && j.record) putRecord(doc,j.record);
 else {
  if(exists(j.staging)) rmSync(j.staging,{recursive:true,force:true});
  // The old previous install may already be gone.
  const r=findRecord(doc,j.id,j.type);
  if(r?.previous && j.previousDir && !exists(j.previousDir)) r.previous=null;
 }
 doc.journal=null;
}

export interface Present {id:string;type:PackageType;version:string;path:string;managed:'user'|'system';license:string|null}
/** Worlds on disk: <world root>/<id>/world.json (dot directories ignored; a symlinked world is system-managed). */
export function scanWorlds(roots:ContentRoots):Present[] {
 if(!existsSync(roots.worlds)) return [];
 const out:Present[]=[];
 for(const name of readdirSync(roots.worlds).sort()) {
  if(name.startsWith('.')) continue;
  const path=join(roots.worlds,name);
  try {
   const st=lstatSync(path);
   const {type,manifest}=readManifest(path);
   if(type!=='world') continue;
   out.push({id:name,type,version:String(manifest.version),path,managed:st.isSymbolicLink()?'system':'user',license:manifest.license ?? null});
  } catch {}
 }
 return out;
}
/** Libraries on disk: <root>/<id>@<version>/ in the user root and the system roots. */
export function scanLibraries(roots:ContentRoots):Present[] {
 const out:Present[]=[];
 for(const [root,managed] of [[roots.libraries,'user'],...roots.systemLibraries.map(r=>[r,'system'])] as Array<[string,'user'|'system']>) {
  if(!existsSync(root)) continue;
  for(const name of readdirSync(root).sort()) {
   const at=name.lastIndexOf('@');
   if(name.startsWith('.') || at<=0) continue;
   let license:string|null=null;
   try {license=JSON.parse(readFileSync(join(root,name,'library.json'),'utf8')).license ?? null;} catch {continue;}
   out.push({id:name.slice(0,at),type:'library',version:name.slice(at+1),path:join(root,name),managed,license});
  }
 }
 return out;
}
/** Library id@version references of every installed world (current and previous installs). */
export function requiredLibraries(roots:ContentRoots):Map<string,string[]> {
 const out=new Map<string,string[]>();
 const add=(dir:string,label:string)=>{
  try {
   const {manifest}=readManifest(dir);
   for(const a of manifest?.objectAssets || []) if(typeof a?.library==='string') out.set(a.library,[...new Set([...(out.get(a.library) || []),label])]);
  } catch {}
 };
 for(const w of scanWorlds(roots)) add(w.path,w.id);
 const prev=join(roots.worlds,'.previous');
 if(existsSync(prev)) for(const name of readdirSync(prev)) add(join(prev,name),`${name} (previous)`);
 return out;
}

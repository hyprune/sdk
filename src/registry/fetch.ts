// The in-process fetch helper (RFC-0015 "Fetch helper"; DESIGN phase-1 shape): the only code
// that opens network connections for content. HTTPS only (plus loopback HTTP when
// HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP=1, for tests), at most 5 redirects and only to HTTPS,
// 30 s connect and idle timeouts, byte caps, Range resume of <sha256>.tar.zst.part files,
// no cookies or credentials except GITHUB_TOKEN to the GitHub API host.
import http from 'node:http';
import https from 'node:https';
import {createReadStream,createWriteStream,existsSync,mkdirSync,renameSync,statSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {IncomingMessage} from 'node:http';
import {RegistryError,diskFull,fail} from './errors.js';
import {parseJson} from '../codec.js';

type Env=Record<string,string|undefined>;
export const FETCH_LIMITS=Object.freeze({index:16*1048576,record:1048576,thumbnail:512*1024,apiPage:4*1048576,checksum:4096,redirects:5,timeoutMs:30_000,concurrent:2});
export const DEFAULT_GITHUB_API='https://api.github.com',DEFAULT_GITHUB_DOWNLOAD='https://github.com';
export interface FetchContext {env?:Env;signal?:AbortSignal}
export interface Progress {bytes:number;total:number}

const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]','::1']);
/** True when `url` may be fetched: HTTPS, or loopback HTTP with the test switch. */
export function allowedUrl(url:string|URL,env:Env=process.env):boolean {
 let u:URL;try {u=new URL(url);} catch {return false;}
 if(u.username || u.password) return false;
 if(u.protocol==='https:') return true;
 return u.protocol==='http:' && env.HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP==='1' && LOOPBACK.has(u.hostname);
}
function checked(url:string|URL,env:Env):URL {
 if(!allowedUrl(url,env)) fail('fetch.failed',`refusing ${String(url).slice(0,200)}: only HTTPS URLs are fetched`);
 return new URL(url);
}
export const githubApi=(env:Env=process.env)=>(env.HYPRUNE_GITHUB_API || DEFAULT_GITHUB_API).replace(/\/+$/,'');
export const githubDownload=(env:Env=process.env)=>(env.HYPRUNE_GITHUB_DOWNLOAD || DEFAULT_GITHUB_DOWNLOAD).replace(/\/+$/,'');

// At most two downloads at a time across the process.
let running=0;const queue:Array<()=>void>=[];
async function slot<T>(fn:()=>Promise<T>):Promise<T> {
 if(running>=FETCH_LIMITS.concurrent) await new Promise<void>(r=>queue.push(r));
 running++;
 try {return await fn();} finally {running--;queue.shift()?.();}
}

/** One GET with redirects; resolves with the final response (status not checked). */
async function get(url:string,{env=process.env,signal,headers={}}:FetchContext&{headers?:Record<string,string>}={}):Promise<{res:IncomingMessage;url:URL}> {
 let u=checked(url,env);const api=githubApi(env)+'/';
 for(let hop=0;;hop++) {
  const h:Record<string,string>={'user-agent':'hyprune-sdk','accept-encoding':'identity',...headers};
  // The token goes only to the GitHub API (URLs under HYPRUNE_GITHUB_API), never elsewhere.
  if(env.GITHUB_TOKEN && u.href.startsWith(api)) h.authorization=`Bearer ${env.GITHUB_TOKEN}`;
  const res=await new Promise<IncomingMessage>((resolve,reject)=>{
   const req=(u.protocol==='https:'?https:http).request(u,{method:'GET',headers:h,agent:false,signal},resolve);
   // Socket inactivity covers both the connect and idle timeouts (30 s each).
   req.setTimeout(FETCH_LIMITS.timeoutMs,()=>req.destroy(new RegistryError('fetch.failed',`${u.host}: no data for ${FETCH_LIMITS.timeoutMs/1000} s`)));
   req.on('error',e=>reject(e instanceof RegistryError?e:new RegistryError('fetch.failed',`${u.host}: ${e.message}`)));
   req.end();
  });
  if([301,302,303,307,308].includes(res.statusCode || 0)) {
   res.resume();
   if(hop>=FETCH_LIMITS.redirects) fail('fetch.failed',`${url}: more than ${FETCH_LIMITS.redirects} redirects`);
   const location=res.headers.location;
   if(!location) fail('fetch.failed',`${u.host}: redirect without a location`);
   const next=new URL(location!,u);
   if(!allowedUrl(next,env)) fail('fetch.failed',`${u.host}: redirect to a non-HTTPS URL refused`);
   u=next;continue;
  }
  return {res,url:u};
 }
}
async function readAll(res:IncomingMessage,max:number,what:string):Promise<Buffer> {
 const length=Number(res.headers['content-length']);
 if(Number.isFinite(length) && length>max) {res.destroy();fail('fetch.failed',`${what}: ${length} bytes, more than ${max}`);}
 const chunks:Buffer[]=[];let total=0;
 for await (const chunk of res) {
  total+=chunk.length;
  if(total>max) {res.destroy();fail('fetch.failed',`${what}: more than ${max} bytes`);}
  chunks.push(chunk);
 }
 return Buffer.concat(chunks);
}
/** GET a small document (index, record, API page, checksum) of at most `max` bytes. */
export async function fetchBytes(url:string,max:number,ctx:FetchContext&{accept?:string}={}):Promise<Buffer> {
 const {res}=await get(url,{...ctx,headers:ctx.accept?{accept:ctx.accept}:{}});
 if(res.statusCode!==200) {res.resume();fail('fetch.failed',`${url}: HTTP ${res.statusCode}`);}
 return readAll(res,max,url);
}
/** GET a JSON document: UTF-8, no duplicate keys, at most `max` bytes. */
export async function fetchJson(url:string,max:number,ctx:FetchContext&{accept?:string}={}):Promise<{value:unknown;bytes:Buffer}> {
 const bytes=await fetchBytes(url,max,ctx);
 return {value:decodeJson(bytes,url),bytes};
}
export function decodeJson(bytes:Buffer,what:string):unknown {
 let text:string;
 try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {return fail('source.invalid',`${what}: not UTF-8`);}
 try {return parseJson(text.replace(/^﻿/,''));} catch(e:any) {return fail('source.invalid',`${what}: ${e.message}`);}
}
export function sha256File(path:string):Promise<string> {
 return new Promise((resolve,reject)=>{const h=createHash('sha256');createReadStream(path).on('error',reject).on('data',b=>h.update(b)).on('end',()=>resolve(h.digest('hex')));});
}
export const sha256=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

/**
 * Download an archive into `<dir>/<sha256>.tar.zst`: through `<name>.part` (resumed with
 * Range when a part exists), never more than `bytes`, renamed only after the hash check. A
 * hash mismatch deletes the part (`hash.mismatch`). Interrupted transfers retry twice.
 */
export async function download(url:string,{bytes,sha256:expected,dir,onProgress,exact=true,...ctx}:{bytes:number;sha256:string;dir:string;onProgress?:(p:Progress)=>void;exact?:boolean}&FetchContext):Promise<string> {
 mkdirSync(dir,{recursive:true,mode:0o700});
 const final=join(dir,`${expected}.tar.zst`),part=final+'.part';
 if(existsSync(final)) {
  const size=statSync(final).size;
  if((exact?size===bytes:size<=bytes) && await sha256File(final)===expected) {onProgress?.({bytes:size,total:size});return final;}
  unlinkSync(final);
 }
 return slot(async()=>{
  for(let attempt=0;;attempt++) {
   try {await transfer(url,part,bytes,exact,onProgress,ctx);break;}
   catch(e:any) {
    if(!(e instanceof RegistryError) || e.rule!=='fetch.failed' || attempt>=2 || !/no data|ECONNRESET|socket hang up|aborted|ended early/.test(e.message)) throw e;
   }
  }
  const actual=await sha256File(part);
  if(actual!==expected) {unlinkSync(part);fail('hash.mismatch',`${url}: sha256 ${actual}, expected ${expected}`);}
  renameSync(part,final);
  return final;
 });
}
async function transfer(url:string,part:string,bytes:number,exact:boolean,onProgress:((p:Progress)=>void)|undefined,ctx:FetchContext):Promise<void> {
 // Without an exact size (a direct archive URL pinned only by hash) `bytes` is a cap and no resume.
 let have=exact && existsSync(part)?statSync(part).size:0;
 if(have>=bytes || (!exact && existsSync(part))) {unlinkSync(part);have=0;}
 const {res}=await get(url,{...ctx,headers:have?{range:`bytes=${have}-`}:{}});
 if(res.statusCode===206) {
  const start=/^bytes (\d+)-/.exec(String(res.headers['content-range'] || ''))?.[1];
  if(Number(start)!==have) {res.resume();unlinkSync(part);fail('fetch.failed',`${url}: unexpected Content-Range; restarting needs a new attempt`);}
 } else if(res.statusCode===200) have=0;
 else {res.resume();fail('fetch.failed',`${url}: HTTP ${res.statusCode}`);}
 const length=Number(res.headers['content-length']);
 if(Number.isFinite(length) && have+length>bytes) {res.destroy();fail('fetch.failed',`${url}: ${have+length} bytes, more than the pinned ${bytes}`);}
 const out=createWriteStream(part,{flags:have?'a':'w',mode:0o600});
 // A write error (disk full, quota) arrives as an 'error' event: keep it, stop reading, report it.
 let writeError:any=null;
 out.on('error',e=>{writeError=e;res.destroy();});
 let total=have,last=0;
 try {
  for await (const chunk of res) {
   if(writeError) break;
   total+=chunk.length;
   if(total>bytes) {res.destroy();fail('fetch.failed',`${url}: more than the pinned ${bytes} bytes`);}
   if(!out.write(chunk)) await new Promise<void>(r=>{out.once('drain',()=>r());out.once('error',()=>r());});
   const now=Date.now();
   if(onProgress && now-last>=250) {last=now;onProgress({bytes:total,total:exact?bytes:Number.isFinite(length)?length:0});}
  }
 } catch(e:any) {
  if(e instanceof RegistryError) throw e;
  if(!writeError) fail(diskFull(e)?'disk.full':'fetch.failed',`${url}: ${diskFull(e)?'disk full':e.message}`);
 } finally {
  if(!writeError) await new Promise<void>(resolve=>out.end(()=>resolve()));
  else out.destroy();
 }
 if(writeError) fail(diskFull(writeError)?'disk.full':'fetch.failed',`${diskFull(writeError)?'disk full or quota exceeded':'cannot write'} while downloading ${url} (${writeError.message})`);
 if(exact && total<bytes) fail('fetch.failed',`${url}: transfer ended early (${total} of ${bytes} bytes)`);
 if(!exact && Number.isFinite(length) && total<length) fail('fetch.failed',`${url}: transfer ended early (${total} of ${length} bytes)`);
 onProgress?.({bytes:total,total:exact?bytes:total});
}

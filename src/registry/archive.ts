// The safe extractor (RFC-0015 "Archive" and "Data only"; RFC-0004/RFC-0011 archive rules).
// `zstd -dc --memory=128MB` decompresses (window log at most 27); a JS ustar parser streams
// the tar and enforces every rule and limit while extracting into a fresh staging directory.
// Nothing here follows a link: the parser never creates one and refuses every non-regular,
// non-directory member.
import {spawn} from 'node:child_process';
import {closeSync,fstatSync,lstatSync,mkdirSync,openSync,writeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {fail,RegistryError} from './errors.js';
import {registryLimits} from '../validation.js';

export type PackageType='world'|'library';
export interface ExtractLimits {bytes:number;expandedBytes:number;files:number;fileBytes:number}
export interface ExtractResult {root:string;files:Array<{path:string;size:number}>;expandedBytes:number}
export const limitsFor=(type:PackageType):ExtractLimits=>({...registryLimits[type]});
/** Limits that fit either package type, for archives whose type isn't known yet. */
export const ANY_LIMITS:ExtractLimits={...registryLimits.world};

const DATA_EXTENSIONS=new Set(['json','glb','gltf','bin','png','jpg','jpeg','ktx2','svg','ogg','wav','md','txt']);
const DOC_NAMES=/^(LICENSE|NOTICE|COPYING|ATTRIBUTION)(\.(md|txt))?$/;
/** Data-only allowlist (RFC-0015): manifest/json, glTF, images, SVG, audio, documentation. */
export function dataFile(path:string):boolean {
 const name=path.split('/').at(-1)!,dot=name.lastIndexOf('.');
 if(DOC_NAMES.test(name)) return true;
 return dot>0 && DATA_EXTENSIONS.has(name.slice(dot+1).toLowerCase());
}
/** Executable or script signatures: ELF, PE (MZ), Mach-O (and fat), #!, WebAssembly. */
export function executableSignature(head:Buffer):string|undefined {
 if(head.length>=4 && head.readUInt32BE(0)===0x7f454c46) return 'ELF';
 if(head.length>=2 && head[0]===0x4d && head[1]===0x5a) return 'PE (MZ)';
 if(head.length>=4 && [0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe,0xbebafeca].includes(head.readUInt32BE(0))) return 'Mach-O';
 if(head.length>=2 && head[0]===0x23 && head[1]===0x21) return '#!';
 if(head.length>=4 && head.readUInt32BE(0)===0x0061736d) return 'WebAssembly';
 return undefined;
}
/**
 * The map SVG subset as far as a text check goes: no scripts, event attributes, external
 * references, foreign objects, entities or DOCTYPE. Returns the problem, or undefined.
 */
export function svgProblem(bytes:Buffer):string|undefined {
 let text:string;
 try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {return 'not UTF-8';}
 if(/<\s*script\b/i.test(text)) return 'script element';
 if(/<\s*foreignObject\b/i.test(text)) return 'foreignObject element';
 if(/<!\s*(DOCTYPE|ENTITY)/i.test(text)) return 'DOCTYPE or entity';
 if(/[\s"'/]on[a-z]+\s*=/i.test(text)) return 'event attribute';
 for(const m of text.matchAll(/(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi)) if(!(m[2] ?? m[3] ?? '').startsWith('#')) return 'external reference';
 for(const m of text.matchAll(/url\(\s*['"]?([^)'"]*)/gi)) if(!m[1].trim().startsWith('#')) return 'external reference';
 if(/@import\b/i.test(text)) return 'external reference';
 return undefined;
}
const UNSAFE_CHARS=/[\\%?#:\x00-\x1f\x7f]/;
function memberPath(name:string,directory:boolean):string {
 if(directory && name.endsWith('/')) name=name.slice(0,-1);
 if(!name || name.startsWith('/') || UNSAFE_CHARS.test(name) || name.split('/').some(s=>!s || s==='.' || s==='..'))
  fail('archive.unsafe',`unsafe archive member name: ${JSON.stringify(name.slice(0,200))}`);
 if(name.split('/').length>64) fail('archive.unsafe',`archive member nested deeper than 64: ${name.slice(0,200)}`);
 return name;
}
const field=(block:Buffer,start:number,length:number)=>{const b=block.subarray(start,start+length),z=b.indexOf(0);return b.subarray(0,z<0?length:z).toString('utf8');};
function octal(block:Buffer,start:number,length:number,what:string):number {
 if(block[start]&0x80) fail('archive.unsafe',`archive ${what} uses base-256 encoding`);
 const text=field(block,start,length).trim();
 if(text && !/^[0-7]+$/.test(text)) fail('archive.unsafe',`archive ${what} is not octal`);
 return text?parseInt(text,8):0;
}
const TYPES:Record<string,string>={'1':'hard link','2':'symlink','3':'character device','4':'block device','6':'FIFO','7':'contiguous file','x':'pax header','g':'pax global header','L':'GNU long name','K':'GNU long link'};

/**
 * Extract `archive` (a zstd ustar stream) into `into` (an existing, empty staging directory).
 * Enforces: one root directory named `expectRoot` when given; regular files and directories
 * only; safe names; no executable bits, executable signatures or files outside the data-only
 * allowlist; SVG subset; compressed size, expanded size, file count and file size limits;
 * zstd window at most 128 MiB. Throws RegistryError (archive.unsafe, archive.limit,
 * data.executable) and leaves partial output for the caller to delete with the staging directory.
 */
export async function extractArchive(archive:string,into:string,{limits,expectRoot}:{limits:ExtractLimits;expectRoot?:string}):Promise<ExtractResult> {
 const st=lstatSync(archive);
 if(!st.isFile()) fail('archive.unsafe','archive is not a regular file');
 if(st.size>limits.bytes) fail('archive.limit',`archive is ${st.size} bytes, more than ${limits.bytes}`);
 const zstd=spawn('zstd',['-dc','-q','--no-progress','--memory=128MB','--',archive],{stdio:['ignore','pipe','pipe']});
 let stderr='';zstd.stderr.on('data',b=>{if(stderr.length<4096) stderr+=b;});
 const exited=new Promise<number>((resolve,reject)=>{zstd.on('error',reject);zstd.on('close',code=>resolve(code ?? 1));});
 let root:string|undefined;const files:ExtractResult['files']=[];const dirs=new Set<string>(),written=new Set<string>();let expanded=0;
 let buffer:Buffer<ArrayBufferLike>=Buffer.alloc(0);
 // Current member being written.
 let current:{fd:number;path:string;remaining:number;padding:number;head:Buffer;svg?:Buffer[]}|undefined;
 let skip=0,ended=false,zeros=0,trailing=0;
 const ensureDir=(path:string)=>{
  const parts=path.split('/');
  for(let i=1;i<=parts.length;i++) {
   const p=parts.slice(0,i).join('/');
   if(dirs.has(p)) continue;
   if(written.has(p)) fail('archive.unsafe',`archive member ${p} is both a file and a directory`);
   try {mkdirSync(join(into,p),{mode:0o755});} catch(e:any) {if(e.code!=='EEXIST') throw e;if(!lstatSync(join(into,p)).isDirectory()) fail('archive.unsafe',`archive member ${p} is both a file and a directory`);}
   dirs.add(p);
  }
 };
 const finishFile=()=>{
  if(!current) return;
  const c=current;current=undefined;closeSync(c.fd);
  const sig=executableSignature(c.head);
  if(sig) fail('data.executable',`${c.path} starts with an executable signature (${sig})`);
  if(c.svg) {const problem=svgProblem(Buffer.concat(c.svg));if(problem) fail('data.executable',`${c.path}: SVG outside the map subset (${problem})`);}
  skip=c.padding;
 };
 const header=(block:Buffer)=>{
  if(block.every(b=>b===0)) {if(++zeros>=2) ended=true;return;}
  if(zeros) fail('archive.unsafe','archive has data after an end-of-archive block');
  const sum=octal(block,148,8,'checksum');let computed=0;
  for(let i=0;i<512;i++) computed+=i>=148 && i<156?32:block[i];
  if(sum!==computed) fail('archive.unsafe','archive header checksum mismatch (not a tar stream?)');
  if(block.toString('latin1',257,262)!=='ustar') fail('archive.unsafe','archive must be ustar');
  const type=String.fromCharCode(block[156] || 0x30);
  const prefix=field(block,345,155),raw=(prefix?prefix+'/':'')+field(block,0,100);
  if(type!=='0' && type!=='5') fail('archive.unsafe',`archive member ${JSON.stringify(raw.slice(0,200))} is a ${TYPES[type] || `type ${JSON.stringify(type)} entry`}; only files and directories are allowed`);
  const path=memberPath(raw,type==='5'),top=path.split('/')[0];
  if(root===undefined) {
   root=top;
   if(expectRoot!==undefined && root!==expectRoot) fail('archive.unsafe',`archive root must be ${expectRoot}, not ${root}`);
  } else if(top!==root) fail('archive.unsafe','archive members must share one root directory');
  const mode=octal(block,100,8,'mode'),size=octal(block,124,12,'size');
  if(type==='5') {if(size) fail('archive.unsafe',`directory ${path} has a size`);ensureDir(path);return;}
  if(path===root) fail('archive.unsafe','archive root must be a directory');
  if(mode&0o111) fail('data.executable',`${path} has an executable mode bit`);
  if(!dataFile(path)) fail('data.executable',`${path} is not a data file (allowed: json, glTF, png/jpg/ktx2, SVG, ogg/wav, md/txt and LICENSE-type documents)`);
  if(files.length>=limits.files) fail('archive.limit',`archive has more than ${limits.files} files`);
  if(size>limits.fileBytes) fail('archive.limit',`${path} is ${size} bytes, more than ${limits.fileBytes}`);
  expanded+=size;
  if(expanded>limits.expandedBytes) fail('archive.limit',`archive expands to more than ${limits.expandedBytes} bytes`);
  ensureDir(path.split('/').slice(0,-1).join('/'));
  let fd:number;
  try {fd=openSync(join(into,path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);}
  catch(e:any) {return fail('archive.unsafe',e.code==='EEXIST'?`duplicate archive member ${path}`:`cannot write ${path}: ${e.code}`);}
  if(!fstatSync(fd).isFile()) {closeSync(fd);fail('archive.unsafe',`cannot write ${path}`);}
  files.push({path:path.slice(root!.length+1),size});written.add(path);
  current={fd,path,remaining:size,padding:(512-size%512)%512,head:Buffer.alloc(0),svg:path.toLowerCase().endsWith('.svg')?[]:undefined};
  if(!size) finishFile();
 };
 try {
  for await (const chunk of zstd.stdout as AsyncIterable<Buffer>) {
   buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;
   let at=0;
   // After the end-of-archive blocks only zero padding may follow (GNU tar pads to its record size).
   if(ended) {
    if(!buffer.every(b=>b===0)) fail('archive.unsafe','archive has data after an end-of-archive block');
    trailing+=buffer.length;buffer=Buffer.alloc(0);
    if(trailing>1048576) fail('archive.limit','archive has more than 1 MiB after its end-of-archive blocks');
    continue;
   }
   while(at<buffer.length && !ended) {
    if(skip) {const n=Math.min(skip,buffer.length-at);skip-=n;at+=n;continue;}
    if(current) {
     const n=Math.min(current.remaining,buffer.length-at),part=buffer.subarray(at,at+n);
     if(current.head.length<8) current.head=Buffer.concat([current.head,part.subarray(0,8-current.head.length)]);
     current.svg?.push(Buffer.from(part));
     try {writeSync(current.fd,part);} catch(e:any) {fail(e.code==='ENOSPC'?'disk.full':'archive.unsafe',`writing ${current.path}: ${e.code}`);}
     current.remaining-=n;at+=n;
     if(!current.remaining) finishFile();
     continue;
    }
    if(buffer.length-at<512) break;
    header(buffer.subarray(at,at+512));at+=512;
   }
   buffer=buffer.subarray(at);
   if(ended && !buffer.every(b=>b===0)) fail('archive.unsafe','archive has data after an end-of-archive block');
   if(ended) {trailing+=buffer.length;buffer=Buffer.alloc(0);}
  }
 } catch(e) {
  zstd.kill();
  if(current) {closeSync(current.fd);current=undefined;}
  throw e;
 } finally {zstd.stdout.destroy();}
 if(current) {closeSync(current.fd);fail('archive.unsafe','truncated archive member');}
 const code=await exited.catch((e:any)=>fail('archive.unsafe',`zstd is required to extract archives (${e.message})`));
 if(!ended) {
  if(/memory|window/i.test(stderr)) fail('archive.limit','archive needs a zstd window larger than 128 MiB');
  if(code!==0) fail('archive.unsafe',`archive is not a valid zstd stream${stderr?`: ${stderr.trim().split('\n').at(-1)}`:''}`);
  fail('archive.unsafe','truncated archive (no end-of-archive blocks)');
 }
 if(root===undefined) fail('archive.unsafe','empty archive');
 if(!dirs.has(root!)) ensureDir(root!);
 return {root:root!,files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),expandedBytes:expanded};
}
export {RegistryError};

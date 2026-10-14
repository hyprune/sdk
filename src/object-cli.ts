// `hyprune object add|list` and `hyprune library install|list|remove` (RFC-0011 "Shell, SDK
// and tooling"). Adding writes only to the user object folder; installing hands core a local
// archive and its hash over IPC 0.22. Nothing here downloads anything.
import {parseArgs} from 'node:util';
import {createReadStream,copyFileSync,chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {clientFromEnvironment} from './launch.js';
import {atLeast,PROTOCOLS,objectLimits,validateManifest,type Protocol} from './validation.js';
import {validateObject,gltfBounds,USER_FOLDER_OBJECTS,type ObjectManifest} from './object.js';
import {inventory,readAsset,gltfDocument} from './world.js';
import {objectDir} from './paths.js';
import {parseJson} from './codec.js';
import type {HypruneClient} from './client.js';
import {buildImport,inspectImport,CATEGORIES,type ImportOptions,type Measure} from './import.js';
import type {Ipc22_CatalogEntry,Ipc22_LibraryRecord,LibraryReleases09_Document} from './generated.js';

/** The first IPC version with the object catalog and libraries; the CLI asks for it unless told otherwise. */
export const OBJECTS_SINCE='0.22';
export const objectHelp=`hyprune object add <dir | file.glb> [--name N --license SPDX --author A --surface floor|wall|ceiling|any] [--replace]
hyprune object import <file> [--inspect] [--name N --id ID --category C --tags a,b --surface floor|wall|ceiling|any]
  [--units auto|m|cm|mm|in|ft | --scale X] [--up y|z] [--yaw 0|90|180|270] [--max-triangles N] [--max-texture PX]
  [--collision convex|box|none] [--ktx2 auto|all|off] [--lighting lit|unlit] [--license SPDX --author A --source S] [--replace] [--json]
hyprune object list [--json]
hyprune library install <archive.tar.zst | id@version> [--releases releases.json] [--archive file.tar.zst]
hyprune library list [--json]
hyprune library remove <id@version>

object add checks an object directory (or wraps a bare .glb in a minimal object.json from
the flags) and copies it atomically into $HYPRUNE_OBJECT_DIR, else
$XDG_DATA_HOME/hyprune/objects/<id>/. library install id@version reads the record from a
libraries/releases.json and needs the archive next to it or as --archive.
object import converts a glTF/GLB (or OBJ, FBX, DAE, 3DS, PLY, STL through Assimp) into an object
directory without Blender: units, up axis, facing and pivot; meshoptimizer decimation to
--max-triangles (default 50000); textures shrunk to --max-texture (2048) and, over 1024 px,
KTX2; a convex or box collision proxy; a CPU thumbnail; import.json with the provenance.
--inspect only measures. --json prints JSON lines: {event: stage|done|error, ...}.
IPC commands: [--socket path] [--protocol 0.22]; install/remove need objects.control.`;

const SURFACES=['floor','wall','ceiling','any'] as const;
export type Surface=typeof SURFACES[number];
export interface AddOptions {name?:string;license?:string;author?:string;surface?:string;replace?:boolean;root?:string}
export interface AddResult {id:string;ref:string;path:string;digest:string;replaced:boolean;warnings:string[]}

/** An object id from a file name: lowercase slug starting with a letter (the user/<id> ref pattern), at most 64. */
export function objectSlug(file:string):string {
 let slug=basename(file,extname(file)).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
 if(!/^[a-z]/.test(slug)) slug='object-'+slug;
 return slug.slice(0,64).replace(/-+$/,'');
}
const round=(n:number)=>Math.round(n*1e5)/1e5+0;
/** The minimal object.json for a bare .glb: format 0.9, version 1.0.0, category other, measured bounds, movable on one surface. */
export function glbManifest(file:string,gltf:unknown,options:AddOptions):ObjectManifest {
 if(!options.license) throw new Error('--license is required for a bare .glb (an SPDX expression, e.g. CC0-1.0 or LicenseRef-Private)');
 if(!options.author) throw new Error('--author is required for a bare .glb (the attribution for the whole object)');
 const surface=(options.surface || 'floor') as Surface;
 if(!SURFACES.includes(surface)) throw new Error(`--surface must be one of ${SURFACES.join(', ')}`);
 const bounds=gltfBounds(gltf);
 if(!bounds) throw new Error('bounds: the GLB has no measurable rest bounds (skinned meshes or POSITION accessors without min/max need the import tool)');
 const stem=basename(file,extname(file)).replace(/[-_.]+/g,' ').trim();
 const name=(options.name ?? (stem.charAt(0).toUpperCase()+stem.slice(1))).slice(0,64);
 return {formatVersion:'0.9',id:objectSlug(file),version:'1.0.0',name:name || 'Object',category:'other',scene:'object.glb',license:options.license,
  attribution:[{path:'.',author:options.author,license:options.license}],bounds:{min:bounds.min.map(round) as [number,number,number],max:bounds.max.map(round) as [number,number,number]},
  traits:{movable:{surfaces:[surface]}}} as ObjectManifest;
}
/**
 * Stage <root>/.hyprune-add-XXXXXX/<id>/ next to the target, let `fill` write it, check the
 * staged copy with validateObject, then rename it to <root>/<id> (with --replace the old copy
 * moves aside first and comes back if the rename fails). The staging directory never stays.
 */
async function commit(root:string,id:string,replace:boolean,fill:(dir:string)=>void):Promise<{check:Awaited<ReturnType<typeof validateObject>>;path:string;replaced:boolean}> {
 mkdirSync(root,{recursive:true});
 const target=join(root,id),exists=existsSync(target);
 if(exists && !replace) throw new Error(`${target} exists; pass --replace to update it`);
 if(exists && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory())) throw new Error(`${target} is not an object directory`);
 const count=readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory() && !d.name.startsWith('.') && d.name!==id).length;
 if(count>=USER_FOLDER_OBJECTS) throw new Error(`the user folder already holds ${USER_FOLDER_OBJECTS} objects`);
 const staging=mkdtempSync(join(root,'.hyprune-add-'));
 try {
  const dir=join(staging,id);mkdirSync(dir);fill(dir);
  const check=await validateObject(dir);
  if(exists) {
   const old=join(staging,'.previous');renameSync(target,old);
   try {renameSync(dir,target);} catch(e) {renameSync(old,target);throw e;}
  } else renameSync(dir,target);
  return {check,path:target,replaced:exists};
 } finally {rmSync(staging,{recursive:true,force:true});}
}
/** `hyprune object add`: a checked copy of an object directory, or a bare .glb wrapped in a minimal object.json. */
export async function addObject(path:string,options:AddOptions={}):Promise<AddResult> {
 const source=resolve(path),root=resolve(options.root || objectDir());
 let st;try {st=lstatSync(source);} catch {throw new Error(`${path}: no such file or directory`);}
 if(st.isSymbolicLink()) throw new Error(`${path}: symlinks are not added; pass the real path`);
 const flags=(['name','license','author','surface'] as const).filter(k=>options[k]!==undefined);
 if(st.isDirectory()) {
  if(flags.length) throw new Error(`--${flags[0]} applies to a bare .glb; an object directory brings its own object.json`);
  const files=inventory(source,{files:objectLimits.files,single:objectLimits.fileBytes,total:objectLimits.directoryBytes,label:'Object'});
  if(!files.some(f=>f.path==='object.json')) throw new Error(`${path}: missing object.json`);
  const manifest:any=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(readAsset(source,'object.json',1_048_576)));
  const id=manifest?.id;
  if(typeof id!=='string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || id.endsWith('-')) throw new Error('id: object.json needs a slug id starting with a letter (it names the user/<id> folder entry)');
  const {check,path:target,replaced}=await commit(root,id,!!options.replace,dir=>{
   for(const f of files) {mkdirSync(dirname(join(dir,f.path)),{recursive:true});copyFileSync(join(source,f.path),join(dir,f.path));}
  });
  return {id,ref:`user/${id}`,path:target,digest:check.digest,replaced,warnings:check.warnings};
 }
 if(!st.isFile()) throw new Error(`${path}: not a file or directory`);
 if(extname(source).toLowerCase()!=='.glb') throw new Error(`${path}: only a bare .glb can be added as a file; put a .gltf and its resources in an object directory`);
 // Bare .glb: each step stops the add on its first failure; nothing is written to the folder.
 if(st.size>objectLimits.fileBytes) throw new Error(`${path}: larger than ${objectLimits.fileBytes/1048576} MiB`);
 const gltf=gltfDocument(readFileSync(source),source);
 const manifest=glbManifest(source,gltf,options);
 try {
  const {check,path:target,replaced}=await commit(root,manifest.id,!!options.replace,dir=>{
   copyFileSync(source,join(dir,'object.glb'));chmodSync(join(dir,'object.glb'),0o644);
   writeFileSync(join(dir,'object.json'),JSON.stringify(manifest,null,2)+'\n');
  });
  return {id:manifest.id,ref:`user/${manifest.id}`,path:target,digest:check.digest,replaced,warnings:check.warnings};
 } catch(e:any) {
  const errors=String(e.message).split('\n').filter(Boolean);
  throw new Error(errors[0]+(errors.length>1?` (${errors.length-1} more; fix this first)`:''));
 }
}

export interface ImportCliOptions extends ImportOptions {replace?:boolean;root?:string}
export interface ImportResult {id:string;ref:string;path:string;digest:string;replaced:boolean;warnings:string[];steps:string[];
 before:Measure;after:Measure;manifest:Record<string,unknown>}
/** `hyprune object import`: build the object in memory, then check and commit it like `object add`. */
export async function importObject(file:string,options:ImportCliOptions={}):Promise<ImportResult> {
 const root=resolve(options.root || objectDir()),version=sdkVersion();
 const build=await buildImport(resolve(file),options,version);
 let id=build.manifest.id as string;
 // A new id when the name is taken (unless replacing): crate, crate-2, crate-3, ...
 if(!options.replace && existsSync(join(root,id))) {
  let n=2;while(existsSync(join(root,`${id.slice(0,60)}-${n}`)) && n<1000) n++;
  id=`${id.slice(0,60)}-${n}`;build.manifest.id=id;
 }
 options.progress?.('check');
 const {check,path,replaced}=await commit(root,id,!!options.replace,dir=>{
  writeFileSync(join(dir,'object.glb'),build.glb);
  writeFileSync(join(dir,'thumbnail.png'),build.thumbnail);
  writeFileSync(join(dir,'object.json'),JSON.stringify(build.manifest,null,1)+'\n');
  writeFileSync(join(dir,'import.json'),JSON.stringify(build.record,null,1)+'\n');
 });
 return {id,ref:`user/${id}`,path,digest:check.digest,replaced,warnings:[...build.warnings,...check.warnings],steps:build.steps,
  before:build.before,after:{...build.after,gpuBytes:check.measured.gpuBytes},manifest:build.manifest};
}
function sdkVersion():string {
 try {return JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;} catch {return '0.0.0';}
}
/** Command-line flags to import options (numbers and enums checked). */
export function importOptions(v:Record<string,any>):ImportCliOptions {
 const pick=<T extends string>(key:string,allowed:readonly T[]):T|undefined=>{
  if(v[key]===undefined) return undefined;
  if(!allowed.includes(v[key])) throw new Error(`--${key} must be one of ${allowed.join(', ')}`);
  return v[key];
 };
 const number=(key:string,lo:number,hi:number)=>{
  if(v[key]===undefined) return undefined;
  const n=Number(v[key]);if(!Number.isFinite(n) || n<lo || n>hi) throw new Error(`--${key} must be a number from ${lo} to ${hi}`);return n;
 };
 const yaw=number('yaw',0,270);
 if(yaw!==undefined && ![0,90,180,270].includes(yaw)) throw new Error('--yaw must be 0, 90, 180 or 270');
 const maxTexture=number('max-texture',256,8192);
 if(maxTexture!==undefined && ![256,512,1024,2048,4096,8192].includes(maxTexture)) throw new Error('--max-texture must be 256, 512, 1024, 2048, 4096 or 8192');
 if(v.id!==undefined && (!/^[a-z][a-z0-9-]{0,63}$/.test(v.id) || v.id.endsWith('-'))) throw new Error('--id must be a slug starting with a letter');
 if(v.category!==undefined && !(CATEGORIES as readonly string[]).includes(v.category)) throw new Error(`--category must be one of ${CATEGORIES.join(', ')}`);
 return {name:v.name,id:v.id,category:v.category,description:v.description,tags:v.tags?String(v.tags).split(',').filter(Boolean):undefined,
  surface:pick('surface',['floor','wall','ceiling','any'] as const),units:pick('units',['auto','m','cm','mm','in','ft'] as const),scale:number('scale',1e-6,1000),
  up:pick('up',['y','z'] as const),yaw:yaw as ImportOptions['yaw'],maxTriangles:number('max-triangles',100,2000000),maxTexture:maxTexture as ImportOptions['maxTexture'],
  collision:pick('collision',['convex','box','none'] as const),ktx2:pick('ktx2',['auto','all','off'] as const),lighting:pick('lighting',['lit','unlit'] as const),
  license:v.license,author:v.author,source:v.source,replace:!!v.replace};
}

/** SHA-256 of a file, streamed. */
export function sha256File(path:string):Promise<string> {
 return new Promise((resolvePromise,reject)=>{const hash=createHash('sha256');createReadStream(path).on('error',reject).on('data',b=>hash.update(b)).on('end',()=>resolvePromise(hash.digest('hex')));});
}
function archiveFile(path:string):string {
 const full=resolve(path);
 if(!full.endsWith('.tar.zst')) throw new Error(`${path}: a library archive is a .tar.zst file`);
 let st;try {st=lstatSync(full);} catch {throw new Error(`${path}: no such file`);}
 if(st.isSymbolicLink() || !st.isFile()) throw new Error(`${path}: not a regular file (symlinks are refused)`);
 if(full.length>4096) throw new Error(`${path}: path longer than 4096 bytes`);
 return full;
}
/** "id@version" split at the last @. */
export function libraryKey(text:string|undefined):{id:string;version:string} {
 const at=text?.lastIndexOf('@') ?? -1;
 if(!text || at<=0 || at===text.length-1) throw new Error('Expected <id>@<version>, e.g. com.hyprune.starter@0.1.0');
 return {id:text.slice(0,at),version:text.slice(at+1)};
}
/**
 * libraries.install params for `library install`: a local archive is hashed as is; an
 * id@version is looked up in a library-releases record and its archive (--archive, else the
 * record URL's file name or <id>-<version>.tar.zst next to the record) must match the pinned hash.
 */
export async function libraryInstallParams(target:string|undefined,options:{releases?:string;archive?:string}={}):Promise<{archive:string;sha256:string}> {
 if(!target) throw new Error('library install needs an archive.tar.zst or <id>@<version>');
 if(target.endsWith('.tar.zst')) {
  if(options.releases || options.archive) throw new Error('--releases and --archive apply to <id>@<version>');
  const archive=archiveFile(target);return {archive,sha256:await sha256File(archive)};
 }
 const {id,version}=libraryKey(target);
 if(!options.releases) throw new Error(`${target}: pass --releases <libraries/releases.json> to look up its archive and hash (nothing is downloaded)`);
 const records=parseJson(readFileSync(options.releases,'utf8')) as LibraryReleases09_Document;
 const checked=validateManifest('library-releases',records) as {valid:boolean;errors:string[]};
 if(!checked.valid) throw new Error(`${options.releases}: ${checked.errors[0]}`);
 const record=records[`${id}@${version}`];
 if(!record) throw new Error(`${options.releases} has no record for ${id}@${version}`);
 const near=dirname(resolve(options.releases));
 const candidates=options.archive?[options.archive]:[...new Set([join(near,basename(new URL(record.url).pathname)),join(near,`${id}-${version}.tar.zst`)])];
 const found=candidates.find(c=>existsSync(c));
 if(!found) throw new Error(`No archive for ${id}@${version}: expected ${candidates.join(' or ')} (download it from ${record.url} yourself, or pass --archive)`);
 const archive=archiveFile(found),sha256=await sha256File(archive);
 if(sha256!==record.sha256) throw new Error(`${archive} hashes to ${sha256}, not the pinned ${record.sha256}`);
 return {archive,sha256};
}

/** One line per catalog entry: ref, status (placeable, invalid or view-only) and name, with the reason when it can't be placed. */
export function catalogTable(entries:Ipc22_CatalogEntry[]):string {
 if(!entries.length) return 'no objects';
 const width=Math.min(56,Math.max(...entries.map(e=>e.ref.length)));
 return entries.map(e=>{
  const status=e.placeable?'placeable':e.state==='invalid'?'invalid':'view-only';
  return `${e.ref.padEnd(width)}  ${status.padEnd(9)}  ${e.name}${e.versions.length?` [also ${e.versions.join(', ')}]`:''}${e.reason && !e.placeable?`  (${e.reason})`:''}`;
 }).join('\n');
}
export function libraryTable(libraries:Ipc22_LibraryRecord[]):string {
 if(!libraries.length) return 'no libraries';
 const width=Math.max(...libraries.map(l=>l.id.length+l.version.length+1));
 return libraries.map(l=>`${`${l.id}@${l.version}`.padEnd(width)}  ${l.root.padEnd(6)}  ${l.state.padEnd(8)}  ${String(l.objects).padStart(3)} objects  ${l.name}${l.errors.length?`  (${l.errors[0]})`:''}`).join('\n');
}

export async function objectMain(argv:string[]):Promise<void> {
 const [group,verb]=argv;
 const {values:v,positionals:p}=parseArgs({args:argv.slice(2),allowPositionals:true,options:{
  help:{type:'boolean',short:'h'},socket:{type:'string'},protocol:{type:'string'},json:{type:'boolean'},
  name:{type:'string'},license:{type:'string'},author:{type:'string'},surface:{type:'string'},replace:{type:'boolean'},
  releases:{type:'string'},archive:{type:'string'},inspect:{type:'boolean'},id:{type:'string'},category:{type:'string'},tags:{type:'string'},
  description:{type:'string'},units:{type:'string'},scale:{type:'string'},up:{type:'string'},yaw:{type:'string'},'max-triangles':{type:'string'},
  'max-texture':{type:'string'},collision:{type:'string'},ktx2:{type:'string'},lighting:{type:'string'},source:{type:'string'}}});
 if(v.help){console.log(objectHelp);return;}
 const out=(value:unknown,text:string)=>console.log(v.json?JSON.stringify(value,null,2):text);
 if(group==='object' && verb==='add') {
  if(!p[0]) throw new Error('object add needs an object directory or a .glb');
  const r=await addObject(p[0],{name:v.name,license:v.license,author:v.author,surface:v.surface,replace:v.replace});
  for(const w of r.warnings) console.error('warning: '+w);
  return out(r,`${r.replaced?'replaced':'added'} ${r.ref} (${r.path})`);
 }
 if(group==='object' && verb==='import') {
  if(!p[0]) throw new Error('object import needs a model file');
  // --json: JSON lines on stdout ({event: stage|done|error}) for the Director's Import job.
  const line=(value:unknown):void=>{process.stdout.write(JSON.stringify(value)+'\n');};
  try {
   if(v.inspect) {const r=await inspectImport(resolve(p[0]));return v.json?line({event:'done',result:r}):console.log(JSON.stringify(r,null,2));}
   const options=importOptions(v);
   options.progress=(stage,message)=>v.json?line({event:'stage',stage,...(message?{message}:{})}):console.error(`${stage}${message?': '+message:''}`);
   const r=await importObject(p[0],options);
   if(v.json) return line({event:'done',result:r});
   for(const w of r.warnings) console.error('warning: '+w);
   return console.log(`${r.replaced?'replaced':'imported'} ${r.ref} (${r.path}): ${r.after.triangles} triangles, ${r.steps.join('; ')}`);
  } catch(e:any) {
   if(!v.json) throw e;
   line({event:'error',error:{message:String(e.message).split('\n')[0],rule:e.rule || 'import.failed'}});
   process.exitCode=1;return;
  }
 }
 // Everything else talks to core.
 let install:{archive:string;sha256:string}|undefined,remove:{id:string;version:string}|undefined;
 if(group==='library' && verb==='install') install=await libraryInstallParams(p[0],{releases:v.releases,archive:v.archive});
 else if(group==='library' && verb==='remove') remove=libraryKey(p[0]);
 else if(!((group==='object' || group==='library') && verb==='list')) throw new Error(`Unknown command: ${group} ${verb}\n${objectHelp}`);
 const protocol=v.protocol || process.env.HYPRUNE_PROTOCOL || OBJECTS_SINCE;
 if(!(PROTOCOLS as readonly string[]).includes(protocol) || !atLeast(protocol,OBJECTS_SINCE)) throw new Error(`The object catalog and libraries need IPC ${OBJECTS_SINCE} or newer (got ${protocol})`);
 if(v.socket) process.env.HYPRUNE_SOCKET=v.socket;
 const capabilities=install || remove?['state.read','objects.control']:['state.read'];
 const client=clientFromEnvironment({protocol:protocol as Protocol,capabilities:capabilities as any}) as unknown as HypruneClient<'0.22'>;
 const signal=()=>client.close();process.once('SIGINT',signal);process.once('SIGTERM',signal);
 try {
  await client.connect();
  if(install){const r=await client.call('libraries.install',install);return out(r,`installed ${r.id}@${r.version}`);}
  if(remove){const r=await client.call('libraries.remove',remove);return out(r,`removed ${remove.id}@${remove.version}`);}
  if(group==='object'){const r=await client.call('objects.catalog',{});return out(r,catalogTable(r.entries));}
  const r=await client.call('libraries.list',{});return out(r,libraryTable(r.libraries));
 } finally {client.close();process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
}

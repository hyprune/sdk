import {lstatSync,readdirSync,readFileSync,openSync,closeSync,fstatSync,constants,mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,relative,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateBytes} from 'gltf-validator';
import {parseJson} from './codec.js';
import {validateObject} from './object.js';
import {validateManifest,atLeast} from './validation.js';
import type {World_Document,World02_Document,World04_Document,World05_Document,World06_Document,World07_Document,World08_Document,World09_Document} from './generated.js';
export type WorldManifest=World_Document|World02_Document|World04_Document|World05_Document|World06_Document|World07_Document|World08_Document|World09_Document;
export const LIMITS={files:10_000,single:128*1024*1024,total:1024*1024*1024,gpu:512*1024*1024};
export function packagePath(root:string,path:string):string {
 if(!path || path.startsWith('/') || /[\\:%?#\x00-\x1f]/.test(path) || path.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Unsafe package path: '+path);
 const full=resolve(root,path);if(!full.startsWith(resolve(root)+'/')) throw new Error('Path escapes package');
 let part=resolve(root);
 if(lstatSync(part).isSymbolicLink()) throw new Error('Symlink package root');
 for(const segment of path.split('/')) {part=join(part,segment);if(lstatSync(part).isSymbolicLink()) throw new Error('Symlink rejected: '+path);}
 return full;
}
// A no-follow read of a regular package file of at most `limit` bytes.
export function readAsset(root:string,path:string,limit=LIMITS.single):Buffer {
 const full=packagePath(root,path),fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const st=fstatSync(fd);if(!st.isFile() || st.size>limit) throw new Error(`Asset must be a regular file <=${limit/1048576} MiB: `+path);return readFileSync(fd);}finally{closeSync(fd);}
}
// Package directory caps: world packages by default; objects and libraries pass RFC-0011's.
export interface InventoryLimits {files:number;single:number;total:number;label:string}
const WORLD_INVENTORY:InventoryLimits={files:LIMITS.files,single:LIMITS.single,total:LIMITS.total,label:'World'};
export function inventory(root:string,limits:InventoryLimits=WORLD_INVENTORY):Array<{path:string;size:number}> {
 root=resolve(root);const st=lstatSync(root);if(!st.isDirectory() || st.isSymbolicLink()) throw new Error(limits.label+' root must be a plain directory');
 const files:Array<{path:string;size:number}>=[];let total=0;
 function walk(dir:string,depth:number) {
  if(depth>64) throw new Error('Package directory depth exceeds 64');
  for(const entry of readdirSync(dir).sort()) {
   const full=join(dir,entry),s=lstatSync(full),path=relative(root,full);
   if(s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error('Links/devices are forbidden: '+path);
   if(s.isDirectory()) walk(full,depth+1);
   else {
    packagePath(root,path);total+=s.size;
    if(s.size>limits.single || total>limits.total || files.length>=limits.files)
     throw new Error(limits===WORLD_INVENTORY?'Package exceeds size/file limits':`${limits.label} directory exceeds ${limits.files} files, ${limits.total/1048576} MiB or ${limits.single/1048576} MiB per file: ${path}`);
    if(/\.(?:js|mjs|cjs|py|sh|lua|so|wasm|html|exe)$/i.test(path) || (s.mode&0o111)) throw new Error(`Executable ${limits.label.toLowerCase()} content rejected: `+path);
    files.push({path,size:s.size});
   }
  }
 }
 walk(root,0);return files;
}
export function gltfDocument(bytes:Buffer,path:string):any {
 if(extname(path)==='.gltf') return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(bytes.length<20 || bytes.readUInt32LE(0)!==0x46546c67 || bytes.readUInt32LE(4)!==2 || bytes.readUInt32LE(8)!==bytes.length || bytes.readUInt32LE(16)!==0x4e4f534a) throw new Error('Invalid GLB header/JSON chunk');
 const length=bytes.readUInt32LE(12);if(length>bytes.length-20) throw new Error('Invalid GLB chunk length');
 return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(20,20+length)));
}
// A package glTF's external resources (scene.gltf, world 0.8 object assets, object
// directories): every URI safe and present, then the Khronos validator, whose errors throw.
export function gltfResourcePath(root:string,scene:string,uri:string):string {
 const sceneDir=relative(root,dirname(join(root,scene)));
 // Do not decode percent escapes: forbidden even if they encode benign text.
 if(!uri || uri.startsWith('/') || /[\\:%?#\x00-\x1f]/.test(uri) || uri.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Unsafe glTF URI: '+uri);
 return sceneDir?sceneDir+'/'+uri:uri;
}
export async function gltfResources(root:string,scene:string,document:any,documentBytes:Buffer,label='',limit=LIMITS.single) {
 const resource=(uri:string)=>gltfResourcePath(root,scene,uri);
 for(const ref of [...(document.buffers || []),...(document.images || [])]) if(ref.uri!==undefined) readAsset(root,resource(ref.uri),limit);
 const report=await validateBytes(new Uint8Array(documentBytes),{uri:scene,maxIssues:1000,writeTimestamp:false,externalResourceFunction:async uri=>new Uint8Array(readAsset(root,resource(uri),limit))});
 if(report.issues.numErrors) throw new Error(label+'glTF validation failed: '+report.issues.messages.filter(m=>m.severity===0).map(m=>`${m.code} ${m.pointer || ''}: ${m.message}`).join('; '));
 return report;
}
// The bundled glTF validator predates KHR_texture_basisu: its KTX2 complaints are noise
// once KHR_texture_basisu is required (the format's extension rules validate it).
export function ktx2Noise(gltf:any):(m:{code:string;message:string;pointer?:string})=>boolean {
 const ktx2Image=(pointer:string|undefined)=>{const i=/^\/images\/(\d+)/.exec(pointer || '');return !!i && gltf.images?.[Number(i[1])]?.mimeType==='image/ktx2';};
 return m=>(gltf.extensionsRequired || []).includes('KHR_texture_basisu') &&
  ((m.code==='VALUE_NOT_IN_LIST' && /'image\/ktx2'/.test(m.message)) || (m.code==='IMAGE_UNRECOGNIZED_FORMAT' && ktx2Image(m.pointer)));
}
// SDK authoring digest: sorted path, size and bytes with NUL separators.
export function packageDigest(root:string,files:Array<{path:string;size:number}>,limit=LIMITS.single):string {
 const digest=createHash('sha256');for(const f of files) {digest.update(f.path+'\0'+f.size+'\0');digest.update(readAsset(root,f.path,limit));}
 return digest.digest('hex');
}
export async function validateWorld(directory:string):Promise<{manifest:WorldManifest;files:Array<{path:string;size:number}>;digest:string;warnings:string[]}> {
 const root=resolve(directory),files=inventory(root),manifestBytes=readAsset(root,'world.json');
 if(manifestBytes.length>1_048_576) throw new Error('Manifest exceeds 1 MiB');
 const manifest=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes)) as WorldManifest;
 const result=validateManifest('world',manifest,undefined,manifest.formatVersion);if(!result.valid) throw new Error(result.errors.join('\n'));
 // World 0.9 dir assets: each object directory is checked like `hyprune object check` (its id
 // need not match the directory name inside a world package), and its object.json goes back to
 // the validator as options.assets so traits (character, seat, movable) are known. Library
 // assets resolve against installed libraries at activation; the SDK has no library roots.
 const objectWarnings:string[]=[];
 if(atLeast(manifest.formatVersion,'0.9') && 'objectAssets' in manifest && manifest.objectAssets) {
  const assets:Record<string,unknown>={};
  for(const asset of manifest.objectAssets as NonNullable<World09_Document['objectAssets']>) {
   if('dir' in asset) {
    let checked;
    try {
     if(!existsSync(join(root,asset.dir))) throw new Error('no such directory in the package');
     packagePath(root,asset.dir);checked=await validateObject(join(root,asset.dir),{directoryName:false});
    }
    catch(e:any) {throw new Error(`Object asset ${asset.id} (${asset.dir}): `+e.message.split('\n').join(`\nObject asset ${asset.id} (${asset.dir}): `));}
    assets[asset.id]=checked.manifest;
    objectWarnings.push(...checked.warnings.map(w=>`object asset ${asset.id}: ${w}`));
   } else if('library' in asset) objectWarnings.push(`object asset ${asset.id}: ${asset.library} ${asset.object} resolves against the installed libraries at activation (not checked here)`);
  }
  if(Object.keys(assets).length) {
   const withAssets=validateManifest('world',manifest,undefined,manifest.formatVersion,{assets});
   if(!withAssets.valid) throw new Error(withAssets.errors.join('\n'));
  }
 }
 if(manifest.requiredExtensions?.length) throw new Error('M0 validator supports no required Hyprune world extensions');
 const paths=[manifest.scene,manifest.preview,...(manifest.audio || []).map(a=>a.path),...manifest.attribution.filter(a=>a.path!=='.').map(a=>a.path)].filter((x):x is string=>!!x);
 for(const p of paths) packagePath(root,p);
 for(const f of files) if(!manifest.attribution.some(a=>a.path==='.' || a.path===f.path || f.path.startsWith(a.path+'/'))) throw new Error('Missing attribution coverage: '+f.path);
 for(const required of ['LICENSE','ATTRIBUTION.md']) if(!files.some(f=>f.path===required)) throw new Error('Missing '+required);
 const bytes=readAsset(root,manifest.scene),gltf=gltfDocument(bytes,manifest.scene);
 // RFC-0004: required glTF extensions and PNG lightmaps, gated by world format (0.7 adds KTX2/meshopt/quantization).
 const sceneCheck=validateManifest('scene',gltf,undefined,manifest.formatVersion,{world:manifest});
 if(!sceneCheck.valid) throw new Error('Unsupported required glTF extension or lightmap for world '+manifest.formatVersion+': '+sceneCheck.errors.join('; '));
 const report=await gltfResources(root,manifest.scene,gltf,bytes);
 // World 0.8+ inline object assets: each glTF with the world format's extension rules and the
 // asset rules (node names, animation nesting, collision proxy; 0.9 character skin and clips);
 // never lightmapped. Dir and library assets were handled above.
 if('objectAssets' in manifest && manifest.objectAssets) for(const asset of manifest.objectAssets) {
  if(!('scene' in asset) || !asset.scene) continue;
  const assetBytes=readAsset(root,asset.scene),assetGltf=gltfDocument(assetBytes,asset.scene);
  const check=validateManifest('scene',assetGltf,undefined,manifest.formatVersion,{world:manifest,asset:asset.id});
  if(!check.valid) throw new Error('Object asset '+asset.id+': '+check.errors.join('; '));
  const assetReport=await gltfResources(root,asset.scene,assetGltf,assetBytes,'Object asset '+asset.id+': ');
  for(const m of assetReport.issues.messages) if(m.severity===1) objectWarnings.push(`object asset ${asset.id}: ${m.code}: ${m.message}`);
  if((assetGltf.meshes || []).some((mesh:any)=>mesh.primitives.some((p:any)=>p.attributes?.TEXCOORD_1!==undefined)))
   objectWarnings.push(`object asset ${asset.id}: TEXCOORD_1 is unused; object assets are never lightmapped`);
 }
 const nodes=gltf.nodes || [];
 const backdropWarnings:string[]=[];
 const node=(index:number,label:string)=>{if(!Number.isInteger(index) || index<0 || index>=nodes.length) throw new Error(label+': unknown node '+index);};
 const parents=new Map<number,number>();
 for(let i=0;i<nodes.length;i++) for(const c of nodes[i].children || []) {node(c,'child');if(parents.has(c)) throw new Error('Multiple-parent node');parents.set(c,i);}
 const indegree=nodes.map((_:unknown,i:number)=>parents.has(i)?1:0),queue:number[]=indegree.flatMap((n:number,i:number)=>n===0?[i]:[]);
 let count=0;for(let i=0;i<queue.length;i++){const n=queue[i];count++;for(const c of nodes[n].children || []) if(--indegree[c]===0) queue.push(c);}if(count!==nodes.length) throw new Error('Node cycle');
 if('visibility' in manifest && manifest.visibility) {
  const owners=new Map<number,string>();
  for(const area of manifest.visibility.areas)for(const n of area.nodes){node(n,'visibility');owners.set(n,area.id);}
  for(const [n,owner] of owners)for(let parent=parents.get(n);parent!==undefined;parent=parents.get(parent))
   if(owners.has(parent) && owners.get(parent)!==owner)throw new Error('Conflicting visibility subtree');
 }
 if('backdrop' in manifest && manifest.backdrop) for(const card of manifest.backdrop.farCards) {
  node(card,'backdrop farCards');
  for(let i=0;i<nodes.length;i++) {
   let ancestor:number|undefined=i;while(ancestor!==undefined && ancestor!==card)ancestor=parents.get(ancestor);
   if(ancestor===undefined)continue;
   for(const primitive of gltf.meshes?.[nodes[i].mesh]?.primitives || []) {
    const material=gltf.materials?.[primitive.material] || {}, pbr=material.pbrMetallicRoughness || {};
    const diffuse=material.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture;
    for(const slot of [pbr.baseColorTexture,diffuse,pbr.metallicRoughnessTexture,material.normalTexture,material.occlusionTexture,material.emissiveTexture]) {
     if(!slot)continue;
     const sampler=gltf.samplers?.[gltf.textures?.[slot.index]?.sampler];
     if(sampler?.wrapS!==33071 && sampler?.wrapT!==33071)continue;
     const warning=`backdrop far card node ${card} texture ${slot.index} uses CLAMP_TO_EDGE (${sampler.wrapS===33071?'S':''}${sampler.wrapT===33071?'T':''}); far cards may smear at their edges`;
     if(!backdropWarnings.includes(warning))backdropWarnings.push(warning);
    }
   }
  }
 }
 for(const entry of [...manifest.spawns,...(manifest.anchors || [])]) if(entry.node!==undefined) node(entry.node,entry.id);
 for(const entry of [...(manifest.collision || []),...(manifest.navigation?[manifest.navigation]:[])]) {
  node(entry.node,'collision/navigation');const mesh=gltf.meshes?.[nodes[entry.node].mesh];
  if(!mesh || mesh.primitives.some((p:any)=>(p.mode ?? 4)!==4)) throw new Error('Collision/navigation requires triangular mesh');
 }
 for(const light of manifest.lightmaps || []) {
  if(!gltf.materials?.[light.material] || !gltf.textures?.[light.texture]) throw new Error('Unknown lightmap material/texture');
  const image=gltf.images?.[gltf.textures[light.texture].source];
  if(!image || (image.uri?!image.uri.endsWith('.png'):image.mimeType!=='image/png')) throw new Error('Lightmaps require PNG images');
  for(const mesh of gltf.meshes || []) for(const p of mesh.primitives) if(p.material===light.material && p.attributes.TEXCOORD_1===undefined) throw new Error('Missing lightmap TEXCOORD_1');
 }
 for(const audio of manifest.audio || []) {
  const b=readAsset(root,audio.path);
  if(audio.path.endsWith('.wav')?!(b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WAVE'):!(b.subarray(0,4).toString()==='OggS' && b.includes(Buffer.from('vorbis')))) throw new Error('Invalid WAV/Ogg Vorbis audio: '+audio.path);
 }
 // Preliminary on-disk and buffer budget; decoded image/driver costs stay core-owned.
 const gpu=files.reduce((n,f)=>n+(/\.(png|jpg|jpeg|ktx2|bin|glb)$/i.test(f.path)?f.size:0),0)+(gltf.buffers || []).reduce((n:number,b:any)=>n+b.byteLength,0);
 if(gpu>LIMITS.gpu) throw new Error('World exceeds preliminary 512 MiB resource budget');
 const digest=packageDigest(root,files);
 // The scene check above validates KHR_texture_basisu, so its validator noise is dropped.
 const noise=ktx2Noise(gltf);
 const warnings=report.issues.messages.filter(m=>m.severity===1 && !(sceneCheck.valid && noise(m))).map(m=>`${m.code}: ${m.message}`);
 warnings.push(...backdropWarnings,...objectWarnings);
 if(manifest.collision?.length || manifest.navigation) warnings.push('Collision/navigation and spawn clearance need authoritative core runtime validation.');
 warnings.push('GPU allocation and image decode budgets require core validation; this is an authoring check.');
 return {manifest,files,digest,warnings};
}
export async function packWorld(directory:string,output?:string):Promise<{path:string;sha256:string;packageDigest:string}> {
 const root=resolve(directory),checked=await validateWorld(root),destination=resolve(output || `${checked.manifest.id}-${checked.manifest.version}.tar.zst`);
 if(destination===root || destination.startsWith(root+'/')) throw new Error('Archive output must be outside the package');
 if(existsSync(destination)) throw new Error('Refusing to overwrite archive');
 const staging=mkdtempSync(join(tmpdir(),'hyprune-pack-')),archiveDirectory=mkdtempSync(join(dirname(destination),'.hyprune-pack-')),temp=join(archiveDirectory,'world.tar.zst');
 try {
  const stageRoot=join(staging,checked.manifest.id);mkdirSync(stageRoot);
  for(const file of checked.files) {const path=join(stageRoot,file.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,readAsset(root,file.path),{mode:0o644});}
  const rechecked=await validateWorld(stageRoot);if(rechecked.digest!==checked.digest) throw new Error('Package changed during packing');
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--format=ustar','--zstd','-cf',temp,'-C',staging,'--',checked.manifest.id],{stdio:'pipe'});
  const sha256=createHash('sha256').update(readFileSync(temp)).digest('hex');linkSync(temp,destination);unlinkSync(temp);
  return {path:destination,sha256,packageDigest:checked.digest};
 } finally {rmSync(staging,{recursive:true,force:true});rmSync(archiveDirectory,{recursive:true,force:true});}
}

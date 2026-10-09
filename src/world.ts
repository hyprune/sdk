import {lstatSync,readdirSync,readFileSync,openSync,closeSync,fstatSync,constants,mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,relative,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateBytes} from 'gltf-validator';
import {parseJson} from './codec.js';
import {validateManifest} from './validation.js';
import type {World_Document,World02_Document,World04_Document,World05_Document,World06_Document,World07_Document} from './generated.js';
export const LIMITS={files:10_000,single:128*1024*1024,total:1024*1024*1024,gpu:512*1024*1024};
export function packagePath(root:string,path:string):string {
 if(!path || path.startsWith('/') || /[\\:%?#\x00-\x1f]/.test(path) || path.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Unsafe package path: '+path);
 const full=resolve(root,path);if(!full.startsWith(resolve(root)+'/')) throw new Error('Path escapes package');
 let part=resolve(root);
 if(lstatSync(part).isSymbolicLink()) throw new Error('Symlink package root');
 for(const segment of path.split('/')) {part=join(part,segment);if(lstatSync(part).isSymbolicLink()) throw new Error('Symlink rejected: '+path);}
 return full;
}
function readAsset(root:string,path:string):Buffer {
 const full=packagePath(root,path),fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const st=fstatSync(fd);if(!st.isFile() || st.size>LIMITS.single) throw new Error('Asset must be a regular file <=128 MiB: '+path);return readFileSync(fd);}finally{closeSync(fd);}
}
export function inventory(root:string):Array<{path:string;size:number}> {
 root=resolve(root);const st=lstatSync(root);if(!st.isDirectory() || st.isSymbolicLink()) throw new Error('World root must be a plain directory');
 const files:Array<{path:string;size:number}>=[];let total=0;
 function walk(dir:string,depth:number) {
  if(depth>64) throw new Error('Package directory depth exceeds 64');
  for(const entry of readdirSync(dir).sort()) {
   const full=join(dir,entry),s=lstatSync(full),path=relative(root,full);
   if(s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error('Links/devices are forbidden: '+path);
   if(s.isDirectory()) walk(full,depth+1);
   else {
    packagePath(root,path);total+=s.size;
    if(s.size>LIMITS.single || total>LIMITS.total || files.length>=LIMITS.files) throw new Error('Package exceeds size/file limits');
    if(/\.(?:js|mjs|cjs|py|sh|lua|so|wasm|html|exe)$/i.test(path) || (s.mode&0o111)) throw new Error('Executable world content rejected: '+path);
    files.push({path,size:s.size});
   }
  }
 }
 walk(root,0);return files;
}
function gltfDocument(bytes:Buffer,path:string):any {
 if(extname(path)==='.gltf') return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(bytes.length<20 || bytes.readUInt32LE(0)!==0x46546c67 || bytes.readUInt32LE(4)!==2 || bytes.readUInt32LE(8)!==bytes.length || bytes.readUInt32LE(16)!==0x4e4f534a) throw new Error('Invalid GLB header/JSON chunk');
 const length=bytes.readUInt32LE(12);if(length>bytes.length-20) throw new Error('Invalid GLB chunk length');
 return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(20,20+length)));
}
export async function validateWorld(directory:string):Promise<{manifest:World_Document|World02_Document|World04_Document|World05_Document|World06_Document|World07_Document;files:Array<{path:string;size:number}>;digest:string;warnings:string[]}> {
 const root=resolve(directory),files=inventory(root),manifestBytes=readAsset(root,'world.json');
 if(manifestBytes.length>1_048_576) throw new Error('Manifest exceeds 1 MiB');
 const manifest=parseJson(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes)) as World_Document|World02_Document|World04_Document|World05_Document|World06_Document|World07_Document;
 const result=validateManifest('world',manifest,undefined,manifest.formatVersion);if(!result.valid) throw new Error(result.errors.join('\n'));
 if(manifest.requiredExtensions?.length) throw new Error('M0 validator supports no required Hyprune world extensions');
 const paths=[manifest.scene,manifest.preview,...(manifest.audio || []).map(a=>a.path),...manifest.attribution.filter(a=>a.path!=='.').map(a=>a.path)].filter((x):x is string=>!!x);
 for(const p of paths) packagePath(root,p);
 for(const f of files) if(!manifest.attribution.some(a=>a.path==='.' || a.path===f.path || f.path.startsWith(a.path+'/'))) throw new Error('Missing attribution coverage: '+f.path);
 for(const required of ['LICENSE','ATTRIBUTION.md']) if(!files.some(f=>f.path===required)) throw new Error('Missing '+required);
 const bytes=readAsset(root,manifest.scene),gltf=gltfDocument(bytes,manifest.scene);
 // RFC-0004: required glTF extensions and PNG lightmaps, gated by world format (0.7 adds KTX2/meshopt/quantization).
 const sceneCheck=validateManifest('scene',gltf,undefined,manifest.formatVersion,{world:manifest});
 if(!sceneCheck.valid) throw new Error('Unsupported required glTF extension or lightmap for world '+manifest.formatVersion+': '+sceneCheck.errors.join('; '));
 const sceneDir=relative(root,dirname(join(root,manifest.scene)));
 const resource=(uri:string)=>{
  // Do not decode percent escapes: forbidden even if they encode benign text.
  if(!uri || uri.startsWith('/') || /[\\:%?#\x00-\x1f]/.test(uri) || uri.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Unsafe glTF URI: '+uri);
  return sceneDir?sceneDir+'/'+uri:uri;
 };
 for(const ref of [...(gltf.buffers || []),...(gltf.images || [])]) if(ref.uri!==undefined) readAsset(root,resource(ref.uri));
 const report=await validateBytes(new Uint8Array(bytes),{uri:manifest.scene,maxIssues:1000,writeTimestamp:false,externalResourceFunction:async uri=>new Uint8Array(readAsset(root,resource(uri)))});
 if(report.issues.numErrors) throw new Error('glTF validation failed: '+report.issues.messages.filter(m=>m.severity===0).map(m=>`${m.code} ${m.pointer || ''}: ${m.message}`).join('; '));
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
 const digest=createHash('sha256');for(const f of files) {digest.update(f.path+'\0'+f.size+'\0');digest.update(readAsset(root,f.path));}
 // The bundled glTF validator predates KHR_texture_basisu; the scene check above validates it.
 const ktx2Image=(pointer:string|undefined)=>{const i=/^\/images\/(\d+)/.exec(pointer || '');return !!i && gltf.images?.[Number(i[1])]?.mimeType==='image/ktx2';};
 const ktx2Noise=(m:any)=>sceneCheck.valid && (gltf.extensionsRequired || []).includes('KHR_texture_basisu') &&
  ((m.code==='VALUE_NOT_IN_LIST' && /'image\/ktx2'/.test(m.message)) || (m.code==='IMAGE_UNRECOGNIZED_FORMAT' && ktx2Image(m.pointer)));
 const warnings=report.issues.messages.filter(m=>m.severity===1 && !ktx2Noise(m)).map(m=>`${m.code}: ${m.message}`);
 warnings.push(...backdropWarnings);
 if(manifest.collision?.length || manifest.navigation) warnings.push('Collision/navigation and spawn clearance need authoritative core runtime validation.');
 warnings.push('GPU allocation and image decode budgets require core validation; this is an authoring check.');
 return {manifest,files,digest:digest.digest('hex'),warnings};
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

// RFC-0011 object directories and libraries: gather what the pure schema validator
// needs (inventory, glTF, thumbnail, texture headers, measured budgets) and run it.
import {existsSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {parseJson} from './codec.js';
import {validateManifest,objectLimits} from './validation.js';
import {inventory,packagePath,readAsset,gltfDocument,gltfResources,gltfResourcePath,ktx2Noise,packageDigest} from './world.js';
import type {Object09_Document,Object10_Document,Library09_Document,Library10_Document} from './generated.js';

export type ObjectManifest=Object09_Document|Object10_Document;
export type LibraryManifest=Library09_Document|Library10_Document;
/** Values only a geometry or image decoder knows; they override the SDK's own measurements. */
export interface ObjectMeasured {bounds?:{min:number[];max:number[]};maxTextureSize?:number;gpuBytes?:number}
export interface ObjectCheck {manifest:ObjectManifest;files:Array<{path:string;size:number}>;digest:string;warnings:string[];triangles?:number;measured:{maxTextureSize:number;gpuBytes:number}}
export interface LibraryCheck {manifest:LibraryManifest;files:Array<{path:string;size:number}>;digest:string;warnings:string[];objects:Array<{id:string;version:string;formatVersion:string;digest:string;triangles?:number}>}
type Result={valid:boolean;errors:string[];warnings?:string[];triangles?:number};
const MANIFEST_BYTES=1_048_576;

function readManifest(root:string,name:string,limit:number):any {
 const bytes=readAsset(root,name,limit);
 if(bytes.length>MANIFEST_BYTES) throw new Error(name+' exceeds 1 MiB');
 return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
const safeFile=(root:string,path:unknown,files:Array<{path:string}>):path is string=>{
 if(typeof path!=='string') return false;
 try {packagePath(root,path);} catch {return false;}
 return files.some(f=>f.path===path);
};

/** Image dimensions from the file header: PNG IHDR, JPEG SOFn, KTX2 pixelWidth/pixelHeight. */
export function imageHeader(bytes:Buffer):{format:'png'|'jpeg'|'ktx2';width:number;height:number}|undefined {
 if(bytes.length>=24 && bytes.readUInt32BE(0)===0x89504e47 && bytes.readUInt32BE(4)===0x0d0a1a0a && bytes.toString('latin1',12,16)==='IHDR')
  return {format:'png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(bytes.length>=28 && bytes.subarray(0,12).equals(Buffer.from([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a])))
  return {format:'ktx2',width:bytes.readUInt32LE(20),height:Math.max(1,bytes.readUInt32LE(24))};
 if(bytes.length>=4 && bytes[0]===0xff && bytes[1]===0xd8) {
  // Walk the marker segments to the first start-of-frame (SOF0-15 except DHT, JPG, DAC).
  for(let i=2;i+9<bytes.length;) {
   if(bytes[i]!==0xff) return undefined;
   const marker=bytes[i+1];
   if(marker===0xff) {i++;continue;}
   if(marker===0xd8 || marker===0x01 || (marker>=0xd0 && marker<=0xd7)) {i+=2;continue;}
   if(marker>=0xc0 && marker<=0xcf && ![0xc4,0xc8,0xcc].includes(marker)) return {format:'jpeg',width:bytes.readUInt16BE(i+7),height:bytes.readUInt16BE(i+5)};
   i+=2+bytes.readUInt16BE(i+2);
  }
 }
 return undefined;
}

/**
 * Check an RFC-0011 object directory (object.json next to its glTF) and return its
 * manifest, sorted inventory, digest, warnings and drawn triangles. Throws with every
 * error joined by newlines.
 *
 * GPU bytes are an estimate: PNG and JPEG textures at 4 B/px, KTX2 at 1 B/px (block
 * compressed after transcoding), each x4/3 for mips, plus every glTF buffer's byteLength.
 * `options.measured` replaces these values (and adds exact rest bounds) when an import
 * tool has decoded the assets.
 */
export async function validateObject(directory:string,options:{measured?:ObjectMeasured}={}):Promise<ObjectCheck> {
 const root=resolve(directory),label='Object';
 const files=inventory(root,{files:objectLimits.files,single:objectLimits.fileBytes,total:objectLimits.directoryBytes,label});
 const manifest=readManifest(root,'object.json',objectLimits.fileBytes);
 const errors:string[]=[],warnings:string[]=[];
 const read=(path:string)=>readAsset(root,path,objectLimits.fileBytes);
 // Scene: the glTF (or GLB JSON chunk), its resources and the Khronos validator.
 let gltf:any,bin:Buffer|undefined;
 if(safeFile(root,manifest?.scene,files)) {
  try {
   const bytes=read(manifest.scene);gltf=gltfDocument(bytes,manifest.scene);
   if(manifest.scene.endsWith('.glb')) {
    const json=bytes.readUInt32LE(12),at=20+json;
    if(at+8<=bytes.length && bytes.readUInt32LE(at+4)===0x004e4942) bin=bytes.subarray(at+8,at+8+bytes.readUInt32LE(at));
   }
   // Every external resource must be a file of the directory (URI safety first).
   const missing=[...(gltf.buffers || []),...(gltf.images || [])].filter((r:any)=>r?.uri!==undefined)
    .map((r:any)=>gltfResourcePath(root,manifest.scene,r.uri)).filter((path:string)=>!files.some(f=>f.path===path));
   if(missing.length) throw new Error('missing glTF resource '+missing.join(', '));
   const noise=ktx2Noise(gltf),report=await gltfResources(root,manifest.scene,gltf,bytes,'',objectLimits.fileBytes);
   for(const m of report.issues.messages) if(m.severity===1 && !noise(m)) warnings.push(`${m.code}: ${m.message}`);
  } catch(e:any) {errors.push('scene: '+e.message);}
 }
 // Textures: the largest dimension and the GPU estimate (see above).
 let maxTextureSize=0,gpuBytes=0;
 if(gltf && typeof gltf==='object' && !errors.length) {
  for(const b of Array.isArray(gltf.buffers)?gltf.buffers:[]) if(Number.isFinite(b?.byteLength)) gpuBytes+=b.byteLength;
  (Array.isArray(gltf.images)?gltf.images:[]).forEach((image:any,i:number)=>{
   try {
    let bytes:Buffer;
    if(image?.uri!==undefined) bytes=read(gltfResourcePath(root,manifest.scene,image.uri));
    else {
     const view=gltf.bufferViews?.[image?.bufferView],buffer=gltf.buffers?.[view?.buffer];
     const data=buffer?.uri!==undefined?read(gltfResourcePath(root,manifest.scene,buffer.uri)):bin;
     if(!view || !data) throw new Error('no image data');
     bytes=data.subarray(view.byteOffset || 0,(view.byteOffset || 0)+view.byteLength);
    }
    const header=imageHeader(bytes);
    if(!header) throw new Error('not a PNG, JPEG or KTX2 image');
    maxTextureSize=Math.max(maxTextureSize,header.width,header.height);
    gpuBytes+=Math.ceil(header.width*header.height*(header.format==='ktx2'?1:4)*4/3);
   } catch(e:any) {errors.push(`images/${i}: ${e.message}`);}
  });
 }
 // Thumbnail: the PNG's IHDR size and its bytes.
 let thumbnail:{width:number;height:number;bytes:number}|undefined;
 if(safeFile(root,manifest?.thumbnail,files)) {
  const bytes=read(manifest.thumbnail),header=imageHeader(bytes);
  if(header?.format!=='png') errors.push('thumbnail: not a PNG image');
  else thumbnail={width:header.width,height:header.height,bytes:bytes.length};
 }
 const measured={maxTextureSize,gpuBytes,...options.measured};
 const result=validateManifest('object',manifest,undefined,undefined,{gltf,directory:basename(root),files,thumbnail,measured}) as Result;
 errors.unshift(...result.errors);warnings.unshift(...(result.warnings || []));
 if(errors.length) throw new Error(errors.join('\n'));
 return {manifest:manifest as ObjectManifest,files,digest:packageDigest(root,files,objectLimits.fileBytes),warnings,
  ...(result.triangles!==undefined?{triangles:result.triangles}:{}),measured:{maxTextureSize:measured.maxTextureSize ?? 0,gpuBytes:measured.gpuBytes ?? 0}};
}

/**
 * Check an RFC-0011 library: library.json, LICENSE, ATTRIBUTION.md and one checked
 * object directory per objects/<id>/. Throws with every error joined by newlines.
 */
export async function validateLibrary(directory:string):Promise<LibraryCheck> {
 const root=resolve(directory);
 const files=inventory(root,{files:objectLimits.libraryFiles,single:objectLimits.fileBytes,total:objectLimits.libraryBytes,label:'Library'});
 const manifest=readManifest(root,'library.json',objectLimits.fileBytes);
 const errors:string[]=[],warnings:string[]=[],objects:Record<string,{id?:string;formatVersion?:string}>={},checked:LibraryCheck['objects']=[];
 const objectsDir=join(root,'objects');
 const dirs=existsSync(objectsDir) && lstatSync(objectsDir).isDirectory()?readdirSync(objectsDir).sort():[];
 for(const name of dirs) {
  if(!lstatSync(join(objectsDir,name)).isDirectory()) {errors.push(`objects/${name}: not an object directory`);continue;}
  if(!files.some(f=>f.path===`objects/${name}/object.json`)) {errors.push(`objects/${name}: missing object.json`);continue;}
  try {const m=readManifest(join(root,'objects',name),'object.json',objectLimits.fileBytes);objects[name]=m && typeof m==='object'?m:{};}
  catch(e:any) {errors.push(`objects/${name}: ${e.message}`);continue;}
  try {
   const o=await validateObject(join(root,'objects',name));
   checked.push({id:o.manifest.id,version:o.manifest.version,formatVersion:o.manifest.formatVersion,digest:o.digest,...(o.triangles!==undefined?{triangles:o.triangles}:{})});
   warnings.push(...o.warnings.map(w=>`objects/${name}: ${w}`));
  } catch(e:any) {errors.push(...e.message.split('\n').map((m:string)=>`objects/${name}: ${m}`));}
 }
 const result=validateManifest('library',manifest,undefined,undefined,{objects,files}) as Result;
 errors.unshift(...result.errors);warnings.unshift(...(result.warnings || []));
 if(errors.length) throw new Error(errors.join('\n'));
 // Catalog order is the manifest's.
 const order=(manifest as LibraryManifest).objects;checked.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
 return {manifest:manifest as LibraryManifest,files,digest:packageDigest(root,files,objectLimits.fileBytes),warnings,objects:checked};
}

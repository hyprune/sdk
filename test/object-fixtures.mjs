// Shared RFC-0011 fixtures: a minimal textured object directory, a two-object library,
// a GLB container and a packed library archive.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {deflateSync,crc32} from 'node:zlib';

// A minimal valid RGB PNG (one filter byte per row, then zlib-deflated pixels).
export function png(width,height) {
 const chunk=(type,data)=>{const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);out.write(type,4,'latin1');data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,8+data.length)),8+data.length);return out;};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 const raw=Buffer.alloc((width*3+1)*height,0x80);for(let y=0;y<height;y++) raw[y*(width*3+1)]=0;
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// One textured triangle (bounds [-0.25,0,-0.25]..[0.25,2.5,0.25]) drawn by node "lantern";
// node "proxy" (outside the scene) is the collision proxy using the same mesh.
export const positions=[-0.25,0,-0.25, 0.25,0,0.25, 0,2.5,0.25],uvs=[0,0, 1,0, 0.5,1];
export function meshBin() {const b=Buffer.alloc(60);[...positions,...uvs].forEach((n,i)=>b.writeFloatLE(n,i*4));return b;}
export function sceneGltf() {
 return {asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'lantern',mesh:0},{name:'proxy',mesh:0}],
  meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],
  textures:[{source:0}],images:[{uri:'albedo.png'}],buffers:[{uri:'object.bin',byteLength:60}],
  bufferViews:[{buffer:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:24,target:34962}],
  accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}]};
}
export function objectJson(id) {
 return {formatVersion:'0.9',id,version:'1.0.0',name:'Street lantern',category:'lighting',tags:['lamp'],scene:'object.gltf',license:'CC0-1.0',
  attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],bounds:{min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]},thumbnail:'thumbnail.png',
  lighting:{mode:'probe'},traits:{collidable:{node:'proxy'},movable:{surfaces:['floor'],scale:[0.75,1.5]}}};
}
export async function writeObject(dir,id=dir.split('/').at(-1)) {
 await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'object.json'),JSON.stringify(objectJson(id)));
 await writeFile(join(dir,'object.gltf'),JSON.stringify(sceneGltf()));
 await writeFile(join(dir,'object.bin'),meshBin());
 await writeFile(join(dir,'albedo.png'),png(64,64));
 await writeFile(join(dir,'thumbnail.png'),png(256,256));
}
/** com.example.street with objects street-lantern and bench under <root>/<id>; returns the library directory. */
export async function writeLibrary(root,{id='com.example.street',version='1.2.0',name='Street kit'}={}) {
 const dir=join(root,id);
 await writeObject(join(dir,'objects','street-lantern'));await writeObject(join(dir,'objects','bench'));
 await writeFile(join(dir,'LICENSE'),'CC0-1.0\n');await writeFile(join(dir,'ATTRIBUTION.md'),'# Attribution\n');
 await writeFile(join(dir,'library.json'),JSON.stringify({formatVersion:'0.9',id,version,name,license:'CC0-1.0',
  attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],objects:['street-lantern','bench']}));
 return dir;
}
/** A deterministic .tar.zst of a library directory (one root directory named like it). */
export function packLibrary(dir,output) {
 const parent=join(dir,'..'),name=dir.split('/').at(-1);
 execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--format=ustar','--zstd','-cf',output,'-C',parent,'--',name],{stdio:'pipe'});
 return output;
}
/** A GLB container: the glTF JSON chunk, then an optional BIN chunk. */
export function glb(gltf,bin) {
 const json=Buffer.from(JSON.stringify(gltf)),jsonChunk=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);
 const header=Buffer.alloc(12),jh=Buffer.alloc(8);jh.writeUInt32LE(jsonChunk.length,0);jh.writeUInt32LE(0x4e4f534a,4);
 const chunks=[header,jh,jsonChunk];
 if(bin){const padded=Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]),bh=Buffer.alloc(8);bh.writeUInt32LE(padded.length,0);bh.writeUInt32LE(0x004e4942,4);chunks.push(bh,padded);}
 const length=chunks.reduce((n,c)=>n+c.length,0);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(length,8);
 return Buffer.concat(chunks);
}
/** A bare, untextured GLB of the fixture triangle (positions only), optionally offset. */
export function triangleGlb(offset=[0,0,0]) {
 const bin=Buffer.alloc(36);positions.forEach((n,i)=>bin.writeFloatLE(n+offset[i%3],i*4));
 const min=[0,1,2].map(j=>Math.min(...[0,1,2].map(k=>positions[k*3+j]))+offset[j]),max=[0,1,2].map(j=>Math.max(...[0,1,2].map(k=>positions[k*3+j]))+offset[j]);
 return glb({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'body',mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],
  buffers:[{byteLength:36}],bufferViews:[{buffer:0,byteLength:36,target:34962}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min,max}]},bin);
}

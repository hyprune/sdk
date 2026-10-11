// RFC-0011 object directories and libraries: validateObject, validateLibrary and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,cp,writeFile,readFile,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {deflateSync,crc32} from 'node:zlib';
import {validateObject,validateLibrary,imageHeader,objectLimits,objectFormats} from '../dist/src/index.js';

// A minimal valid RGB PNG (one filter byte per row, then zlib-deflated pixels).
function png(width,height) {
 const chunk=(type,data)=>{const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);out.write(type,4,'latin1');data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,8+data.length)),8+data.length);return out;};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 const raw=Buffer.alloc((width*3+1)*height,0x80);for(let y=0;y<height;y++) raw[y*(width*3+1)]=0;
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// One textured triangle (bounds [-0.25,0,-0.25]..[0.25,2.5,0.25]) drawn by node "lantern";
// node "proxy" (outside the scene) is the collision proxy using the same mesh.
const positions=[-0.25,0,-0.25, 0.25,0,0.25, 0,2.5,0.25],uvs=[0,0, 1,0, 0.5,1];
function meshBin() {const b=Buffer.alloc(60);[...positions,...uvs].forEach((n,i)=>b.writeFloatLE(n,i*4));return b;}
function sceneGltf() {
 return {asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'lantern',mesh:0},{name:'proxy',mesh:0}],
  meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],
  textures:[{source:0}],images:[{uri:'albedo.png'}],buffers:[{uri:'object.bin',byteLength:60}],
  bufferViews:[{buffer:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:24,target:34962}],
  accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}]};
}
function objectJson(id) {
 return {formatVersion:'0.9',id,version:'1.0.0',name:'Street lantern',category:'lighting',tags:['lamp'],scene:'object.gltf',license:'CC0-1.0',
  attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],bounds:{min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]},thumbnail:'thumbnail.png',
  lighting:{mode:'probe'},traits:{collidable:{node:'proxy'},movable:{surfaces:['floor'],scale:[0.75,1.5]}}};
}
async function writeObject(dir,id=dir.split('/').at(-1)) {
 await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'object.json'),JSON.stringify(objectJson(id)));
 await writeFile(join(dir,'object.gltf'),JSON.stringify(sceneGltf()));
 await writeFile(join(dir,'object.bin'),meshBin());
 await writeFile(join(dir,'albedo.png'),png(64,64));
 await writeFile(join(dir,'thumbnail.png'),png(256,256));
}
async function temp(t) {const root=await mkdtemp(join(tmpdir(),'hyprune-object-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function fixture(t,id='street-lantern') {const root=await temp(t),dir=join(root,id);await writeObject(dir);return {root,dir};}
async function edit(path,fn) {const v=JSON.parse(await readFile(path));fn(v);await writeFile(path,JSON.stringify(v));}
function command(args) {return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});}

test('objectFormats and objectLimits come from the vendored validator',()=>{
 assert.ok(objectFormats.includes('0.9'));
 assert.equal(objectLimits.files,64);assert.equal(objectLimits.libraryFiles,4000);assert.equal(objectLimits.thumbnailSize,256);
});
test('image headers: PNG IHDR, KTX2 pixel size and JPEG SOF',()=>{
 assert.deepEqual(imageHeader(png(3,5)),{format:'png',width:3,height:5});
 const ktx2=Buffer.alloc(80);Buffer.from([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a]).copy(ktx2);ktx2.writeUInt32LE(512,20);ktx2.writeUInt32LE(256,24);
 assert.deepEqual(imageHeader(ktx2),{format:'ktx2',width:512,height:256});
 // SOI, an APP0 segment, then SOF0 (length 17, precision 8, height 300, width 400).
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x04,0x00,0x00,0xff,0xc0,0x00,0x11,0x08,0x01,0x2c,0x01,0x90,0x03,0,0,0,0,0,0,0,0,0,0]);
 assert.deepEqual(imageHeader(jpeg),{format:'jpeg',width:400,height:300});
 assert.equal(imageHeader(Buffer.from('not an image')),undefined);
});
test('a static object directory validates with triangles, texture size and GPU estimate',async t=>{
 const {dir}=await fixture(t),result=await validateObject(dir);
 assert.equal(result.manifest.id,'street-lantern');
 assert.deepEqual(result.files.map(f=>f.path),['albedo.png','object.bin','object.gltf','object.json','thumbnail.png']);
 assert.match(result.digest,/^[0-9a-f]{64}$/);assert.equal(result.triangles,1);
 assert.deepEqual(result.measured,{maxTextureSize:64,gpuBytes:Math.ceil(64*64*4*4/3)+60});
 assert.ok(Array.isArray(result.warnings));
 // Measured values from an import tool replace the SDK's and reach the validator.
 await assert.rejects(validateObject(dir,{measured:{gpuBytes:objectLimits.gpuBytes+1}}),/gpu: \d+ bytes exceeds/);
 await assert.rejects(validateObject(dir,{measured:{maxTextureSize:4096}}),/textures: 4096 px exceeds 2048 px/);
 await assert.rejects(validateObject(dir,{measured:{bounds:{min:[-0.25,0,-0.25],max:[0.25,2.6,0.25]}}}),/more than 1 cm/);
});
test('a GLB object with an embedded PNG validates',async t=>{
 const {dir}=await fixture(t),g=sceneGltf(),image=png(32,16),bin=Buffer.concat([meshBin(),image,Buffer.alloc((4-image.length%4)%4)]);
 g.buffers=[{byteLength:bin.length}];g.bufferViews.push({buffer:0,byteOffset:60,byteLength:image.length});g.images=[{bufferView:2,mimeType:'image/png'}];
 const json=Buffer.from(JSON.stringify(g)),jsonChunk=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);
 const header=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);
 jh.writeUInt32LE(jsonChunk.length,0);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+jsonChunk.length+8+bin.length,8);
 await writeFile(join(dir,'object.glb'),Buffer.concat([header,jh,jsonChunk,bh,bin]));
 await rm(join(dir,'object.gltf'));await rm(join(dir,'object.bin'));await rm(join(dir,'albedo.png'));
 await edit(join(dir,'object.json'),m=>m.scene='object.glb');
 const result=await validateObject(dir);assert.equal(result.measured.maxTextureSize,32);assert.equal(result.triangles,1);
});
test('object rejects symlinks',async t=>{
 const {dir}=await fixture(t);await symlink('/etc/passwd',join(dir,'linked'));await assert.rejects(validateObject(dir),/Links\/devices are forbidden: linked/);
});
test('object rejects unsafe or missing glTF resources',async t=>{
 const {dir}=await fixture(t);
 for(const uri of ['../object.bin','https://example.com/object.bin','a%2fb.bin']) {
  await edit(join(dir,'object.gltf'),g=>g.buffers[0].uri=uri);await assert.rejects(validateObject(dir),/scene: Unsafe glTF URI/);
 }
 await edit(join(dir,'object.gltf'),g=>g.buffers[0].uri='missing.bin');await assert.rejects(validateObject(dir),/^Error: scene: missing glTF resource missing.bin$/);
});
test('object id must equal its directory name',async t=>{
 const {root,dir}=await fixture(t);await rename(dir,join(root,'lantern'));
 await assert.rejects(validateObject(join(root,'lantern')),/id: "street-lantern" differs from its directory "lantern"/);
});
test('object needs attribution coverage for every file',async t=>{
 const {dir}=await fixture(t);
 await edit(join(dir,'object.json'),m=>m.attribution=[{path:'object.gltf',author:'Example Author',license:'CC0-1.0'}]);
 await assert.rejects(validateObject(dir),e=>/attribution: object\.bin is not covered/.test(e.message) && /attribution: thumbnail\.png is not covered/.test(e.message));
});
test('object thumbnail must be a 256 x 256 PNG',async t=>{
 const {dir}=await fixture(t);await writeFile(join(dir,'thumbnail.png'),png(128,128));
 await assert.rejects(validateObject(dir),/thumbnail: 128 x 128, must be 256 x 256/);
 await writeFile(join(dir,'thumbnail.png'),'not a png');await assert.rejects(validateObject(dir),/thumbnail: not a PNG image/);
});
test('object rejects reserved traits and over-limit directories',async t=>{
 const {dir}=await fixture(t);
 await edit(join(dir,'object.json'),m=>m.traits.mount={});await assert.rejects(validateObject(dir),/traits\.mount: reserved/);
 await edit(join(dir,'object.json'),m=>{delete m.traits.mount;m.traits.mover={speed:2};});await assert.rejects(validateObject(dir),/traits\.mover: needs object format 0\.10/);
 await edit(join(dir,'object.json'),m=>delete m.traits.mover);
 for(let i=0;i<objectLimits.files;i++) await writeFile(join(dir,`extra-${i}.txt`),'x');
 await assert.rejects(validateObject(dir),/Object directory exceeds 64 files/);
});

async function library(t) {
 const root=await temp(t),dir=join(root,'com.example.street');
 await writeObject(join(dir,'objects','street-lantern'));await writeObject(join(dir,'objects','bench'));
 await writeFile(join(dir,'LICENSE'),'CC0-1.0\n');await writeFile(join(dir,'ATTRIBUTION.md'),'# Attribution\n');
 await writeFile(join(dir,'library.json'),JSON.stringify({formatVersion:'0.9',id:'com.example.street',version:'1.2.0',name:'Street kit',license:'CC0-1.0',
  attribution:[{path:'.',author:'Example Author',license:'CC0-1.0'}],objects:['street-lantern','bench']}));
 return dir;
}
test('a library validates every listed object in catalog order',async t=>{
 const dir=await library(t),result=await validateLibrary(dir);
 assert.equal(result.manifest.id,'com.example.street');assert.deepEqual(result.objects.map(o=>o.id),['street-lantern','bench']);
 assert.equal(result.objects[0].triangles,1);assert.match(result.digest,/^[0-9a-f]{64}$/);
});
test('library rejects unlisted object directories and invalid objects',async t=>{
 const dir=await library(t);await writeObject(join(dir,'objects','extra'));
 await assert.rejects(validateLibrary(dir),/objects: objects\/extra is not listed/);
 await rm(join(dir,'objects','extra'),{recursive:true});
 await edit(join(dir,'objects','bench','object.json'),m=>m.traits.interactive={});
 await assert.rejects(validateLibrary(dir),/objects\/bench: traits\.interactive: reserved/);
});
test('library objects may not be newer than the library format',async t=>{
 const dir=await library(t);
 await edit(join(dir,'objects','bench','object.json'),m=>m.formatVersion='0.10');
 assert.equal((await validateObject(join(dir,'objects','bench'))).manifest.formatVersion,'0.10','a draft 0.10 object on its own');
 await assert.rejects(validateLibrary(dir),/objects: bench uses object format 0\.10, newer than the library's 0\.9/);
});
test('library needs LICENSE and ATTRIBUTION.md and rejects symlinks',async t=>{
 const dir=await library(t);await rm(join(dir,'LICENSE'));await assert.rejects(validateLibrary(dir),/library: missing LICENSE/);
 await writeFile(join(dir,'LICENSE'),'CC0-1.0\n');await symlink('/etc/passwd',join(dir,'objects','bench','linked'));
 await assert.rejects(validateLibrary(dir),/Links\/devices are forbidden/);
});
test('CLI object check and library check print JSON; failures exit 1',async t=>{
 const dir=await library(t),object=join(dir,'objects','bench');
 const ok=await command(['dist/src/cli.js','object','check',object]);assert.equal(ok.code,0,ok.err);
 const printed=JSON.parse(ok.out);assert.equal(printed.manifest.id,'bench');assert.equal(printed.triangles,1);
 const measured=join(dir,'..','measured.json');await writeFile(measured,JSON.stringify({gpuBytes:objectLimits.gpuBytes+1}));
 const over=await command(['dist/src/cli.js','object','check',object,'--measured',measured]);assert.equal(over.code,1);assert.match(over.err,/gpu: /);
 const lib=await command(['dist/src/cli.js','library','check',dir]);assert.equal(lib.code,0,lib.err);assert.equal(JSON.parse(lib.out).objects.length,2);
 const help=await command(['dist/src/cli.js','--help']);assert.match(help.out,/hyprune object check <dir> \[--measured measured\.json\]/);assert.match(help.out,/hyprune library check <dir>/);
});

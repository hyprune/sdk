import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,cp,writeFile,readFile,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {validateWorld,packWorld,packagePath} from '../dist/src/world.js';
import {scaffold,EXTENSION_TYPES} from '../dist/src/scaffold.js';
import {validateManifest} from '../dist/src/validation.js';
import {readPulse} from '../examples/system-pulse/metrics.mjs';
async function fixture(t) {const root=await mkdtemp(join(tmpdir(),'hyprune-world-'));const world=join(root,'world');await cp('examples/world-minimal',world,{recursive:true});t.after(()=>rm(root,{recursive:true,force:true}));return {root,world};}
async function mutate(world,fn) {const path=join(world,'world.json'),v=JSON.parse(await readFile(path));fn(v);await writeFile(path,JSON.stringify(v));}
test('offline schema semantics plus glTF validation and deterministic archive',async t=>{
 const {root,world}=await fixture(t),valid=await validateWorld(world);assert.match(valid.digest,/^[0-9a-f]{64}$/);
 const a=await packWorld(world,join(root,'a.tar.zst')),b=await packWorld(world,join(root,'b.tar.zst'));assert.equal(a.sha256,b.sha256);assert.equal(a.packageDigest,valid.digest);
 const listing=execFileSync('tar',['--zstd','-tf',a.path],{encoding:'utf8'});assert.match(listing,/org.example.minimal\/world.json/);
 await assert.rejects(packWorld(world,a.path),/overwrite/);await assert.rejects(packWorld(world,join(world,'out.tar.zst')),/outside/);
});
for(const [name,mutator,message] of [
 ['unknown spawn',m=>m.defaultSpawn='missing',/unknown spawn/],
 ['non-normalized pose',m=>m.spawns[0].pose.rotation=[0,0,0,2],/normalized/],
 ['invalid AABB',m=>m.zones=[{id:'a',name:'A',bounds:{min:[1,1,1],max:[0,0,0]}}],/bounds/],
 ['unknown node',m=>m.spawns[0].node=99,/unknown node/],
 ['required metadata',m=>{m.extensions={'org.example.required':{}};m.requiredExtensions=['org.example.required'];},/required/],
 ['missing attribution',m=>m.attribution=[{path:'scene.gltf',author:'author',license:'MIT'}],/attribution/]
]) test('world rejects '+name,async t=>{const {world}=await fixture(t);await mutate(world,mutator);await assert.rejects(validateWorld(world),message);});
test('world rejects symlinks, unsafe paths, scripts and malformed JSON',async t=>{
 const {world}=await fixture(t);for(const path of ['../scene.gltf','/etc/passwd','x//y','x/./y','x\\y','https://x','x%2Fy']) assert.throws(()=>packagePath(world,path));
 await symlink('/etc/passwd',join(world,'linked'));await assert.rejects(validateWorld(world),/Links/);await rm(join(world,'linked'));
 await writeFile(join(world,'script.js'),'console.log(1)');await assert.rejects(validateWorld(world),/Executable/);await rm(join(world,'script.js'));
 await chmod(join(world,'scene.gltf'),0o755);await assert.rejects(validateWorld(world),/Executable/);await chmod(join(world,'scene.gltf'),0o644);
 await writeFile(join(world,'world.json'),'{"id":"a","id":"b"}');await assert.rejects(validateWorld(world),/Duplicate/);
});
test('world rejects remote/data glTF resources and cycles',async t=>{
 const {world}=await fixture(t),path=join(world,'scene.gltf'),gltf=JSON.parse(await readFile(path));
 for(const uri of ['https://example.com/b.bin','data:application/octet-stream;base64,AA==','../b.bin','a%2f.bin']) {await writeFile(path,JSON.stringify({...gltf,buffers:[{uri,byteLength:4}]}));await assert.rejects(validateWorld(world),/Unsafe glTF/);}
 await writeFile(path,JSON.stringify({...gltf,nodes:[{children:[0]}]}));await assert.rejects(validateWorld(world),/glTF validation|cycle/);
});
test('all four scaffolds validate and protect destinations/contribution identity',async t=>{
 const {root}=await fixture(t);
 for(const type of EXTENSION_TYPES) {
  const dir=scaffold(type,join(root,type),'org.example.'+type.replaceAll('-',''));
  const manifest=JSON.parse(await readFile(join(dir,'extension.json')));assert.equal(validateManifest('extension',manifest).valid,true);
  assert.match(await readFile(join(dir,'main.mjs'),'utf8'),/client.subscribe/);
  if(type==='screen-type') assert.equal(validateManifest('screen-type',JSON.parse(await readFile(join(dir,'screen-type.json')))).valid,true);
  assert.throws(()=>scaffold(type,dir),/already exists/);
 }
 assert.throws(()=>scaffold('widget',join(root,'invalid'),'bad'),/pattern/);
 assert.throws(()=>scaffold('widget',join(root,'reserved'),'com.hyprune.core'),/Reserved/);
});
test('/proc integration calculates CPU deltas, RAM and network counters',()=>{
 const files={'/proc/stat':'cpu 20 0 10 70 0 0 0 0\n','/proc/meminfo':'MemTotal: 1000 kB\nMemAvailable: 400 kB\n','/proc/net/dev':'header\nheader\nlo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n'};
 const first=readPulse(undefined,p=>files[p]);assert.equal(first.values.cpuPercent,0);assert.equal(first.values.ramUsedBytes,600*1024);assert.equal(first.values.netTxBytes,200);
 files['/proc/stat']='cpu 40 0 20 140 0 0 0 0\n';assert.equal(readPulse(first.cpu,p=>files[p]).values.cpuPercent,30.000000000000004);
});
function command(args,env={}) {return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env:{...process.env,...env}});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code===0?resolve({out,err}):reject(new Error(`${code}: ${err}`)));});}
test('CLI launcher transfers token by FD; call, subscribe and doctor work',async t=>{
 const {root}=await fixture(t),socket=join(root,'ipc','control.sock');
 const call=await command(['dist/src/mock-cli.js','--socket',socket,'--launch',process.execPath,'dist/src/cli.js','ipc','call','session.ping']);assert.ok(JSON.parse(call.out).monotonicMs>=0);
 const sub=await command(['dist/src/mock-cli.js','--socket',socket,'--launch',process.execPath,'dist/src/cli.js','ipc','subscribe','--count','2']);assert.equal(sub.out.trim().split('\n').filter(l=>JSON.parse(l).event==='state').length,2);
 const doctor=await command(['dist/src/mock-cli.js','--socket',socket,'--launch',process.execPath,'dist/src/cli.js','doctor']);assert.equal(JSON.parse(doctor.out).ok,true);
 const world=await command(['dist/src/cli.js','world','validate','examples/world-minimal']);assert.equal(JSON.parse(world.out).manifest.id,'org.example.minimal');
});
test('both example manifests are valid and mock demo publishes /proc values',async t=>{
 for(const name of ['system-pulse','pulse-widget']) assert.equal(validateManifest('extension',JSON.parse(await readFile(`examples/${name}/extension.json`))).valid,true);
 const {root}=await fixture(t),demo=await command(['dist/src/mock-cli.js','--socket',join(root,'demo','control.sock'),'--demo','--duration','2.5']);assert.match(demo.out,/CPU .*RAM .*net RX/);
});
test('world rejects unsupported required glTF extensions',async t=>{
 const {world}=await fixture(t),path=join(world,'scene.gltf'),gltf=JSON.parse(await readFile(path));gltf.extensionsRequired=['VENDOR_unknown'];gltf.extensionsUsed=['VENDOR_unknown'];await writeFile(path,JSON.stringify(gltf));await assert.rejects(validateWorld(world),/Unsupported required glTF/);
});
test('world checks lightmap UV1 and supports GLB JSON/BIN packages',async t=>{
 const {world}=await fixture(t),positions=Buffer.alloc(36);[0,0,0,1,0,0,0,1,0].forEach((n,i)=>positions.writeFloatLE(n,i*4));await writeFile(join(world,'mesh.bin'),positions);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');await writeFile(join(world,'light.png'),png);
 const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],materials:[{}],textures:[{source:0}],images:[{uri:'light.png'}],buffers:[{uri:'mesh.bin',byteLength:36}],bufferViews:[{buffer:0,byteLength:36,target:34962}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}]};
 await writeFile(join(world,'scene.gltf'),JSON.stringify(gltf));await validateWorld(world);await mutate(world,m=>m.lightmaps=[{material:0,texture:0,texCoord:1,encoding:'linear',intensity:1}]);
 await assert.rejects(validateWorld(world),/TEXCOORD_1/);
 // A minimal GLB with an empty scene is a legal package fixture.
 await mutate(world,m=>{delete m.lightmaps;m.scene='scene.glb';});
 const json=Buffer.from(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{}]})),padding=(4-json.length%4)%4,chunk=Buffer.concat([json,Buffer.alloc(padding,0x20)]),glb=Buffer.alloc(20+chunk.length);
 glb.writeUInt32LE(0x46546c67,0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(chunk.length,12);glb.writeUInt32LE(0x4e4f534a,16);chunk.copy(glb,20);await writeFile(join(world,'scene.glb'),glb);await validateWorld(world);
});

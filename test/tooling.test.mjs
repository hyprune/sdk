import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,cp,writeFile,readFile,symlink,chmod} from 'node:fs/promises';
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
// Runs until stdout matches, then stops it with SIGINT (the CLI's graceful stop); `--duration` only caps a stuck run.
function commandUntil(args,pattern) {return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args);let out='',err='',sent=false;child.stdout.on('data',b=>{out+=b;if(!sent && pattern.test(out)){sent=true;child.kill('SIGINT');}});child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code===0?resolve({out,err}):reject(new Error(`${code}: ${err}`)));});}
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
 const pulse=JSON.parse(await readFile('examples/system-pulse/extension.json'));pulse.capabilities=['data.publish'];assert.equal(validateManifest('extension',pulse).valid,false,'publishing grant still requires an upstream manifest update');
 const {root}=await fixture(t),demo=await commandUntil(['dist/src/mock-cli.js','--socket',join(root,'demo','control.sock'),'--demo','--duration','30'],/CPU .*RAM .*net RX/);assert.match(demo.out,/CPU .*RAM .*net RX/);assert.doesNotMatch(demo.err,/system-pulse:|pulse-widget:/,'publishers finish cleanup before the socket closes');
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
test('world format 0.2 accepts the ratified material profile and retains 0.1',async t=>{
 const {world}=await fixture(t);await mutate(world,m=>m.formatVersion='0.2');const path=join(world,'scene.gltf'),gltf=JSON.parse(await readFile(path));gltf.extensionsRequired=['KHR_texture_transform'];gltf.extensionsUsed=['KHR_texture_transform'];await writeFile(path,JSON.stringify(gltf));assert.equal((await validateWorld(world)).manifest.formatVersion,'0.2');await mutate(world,m=>m.formatVersion='0.1');assert.equal((await validateWorld(world)).manifest.formatVersion,'0.1');
});
test('world 0.5 visibility validates glTF node ownership',async t=>{
 const {world}=await fixture(t);
 await mutate(world,m=>{m.formatVersion='0.5';m.visibility={areas:[{id:'room',bounds:{min:[-4,-1,-4],max:[4,4,4]},nodes:[0],visibleFrom:[]}]};});
 assert.equal((await validateWorld(world)).manifest.formatVersion,'0.5');
 await mutate(world,m=>m.visibility.areas[0].nodes=[999]);
 await assert.rejects(validateWorld(world),/unknown node/);
 await mutate(world,m=>{m.visibility.areas[0].nodes=[0];m.visibility.areas.push({id:'other',bounds:{min:[5,-1,-4],max:[10,4,4]},nodes:[1],visibleFrom:[]});});
 const path=join(world,'scene.gltf'),gltf=JSON.parse(await readFile(path));
 gltf.nodes[0].children=[1];gltf.nodes.push({});await writeFile(path,JSON.stringify(gltf));
 await assert.rejects(validateWorld(world),/Conflicting visibility subtree/);
});
test('world 0.6 far-card declarations warn for descendant CLAMP textures only',async t=>{
 const {world}=await fixture(t),positions=Buffer.alloc(60);
 [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1].forEach((n,i)=>positions.writeFloatLE(n,i*4));await writeFile(join(world,'mesh.bin'),positions);
 await writeFile(join(world,'card.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
 const g={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{children:[1]},{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],textures:[{source:0,sampler:0}],samplers:[{wrapS:33071,wrapT:10497}],images:[{uri:'card.png'}],buffers:[{uri:'mesh.bin',byteLength:60}],bufferViews:[{buffer:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:24,target:34962}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}]};
 const save=()=>writeFile(join(world,'scene.gltf'),JSON.stringify(g));await save();
 await mutate(world,m=>{m.formatVersion='0.6';m.playable={maxFlyHeight:12};m.backdrop={farCards:[0]};});
 assert.ok((await validateWorld(world)).warnings.some(w=>w.includes('node 0 texture 0 uses CLAMP_TO_EDGE (S)')));
 g.samplers[0].wrapS=10497;await save();assert.ok(!(await validateWorld(world)).warnings.some(w=>w.includes('CLAMP_TO_EDGE')));
 await mutate(world,m=>m.backdrop.farCards=[99]);await assert.rejects(validateWorld(world),/backdrop farCards: unknown node/);
});

// World 0.7 (RFC-0004): KTX2 material textures; lightmaps stay PNG; older formats reject.
const KTX2='q0tUWCAyMLsNChoKAAAAAAEAAAAIAAAACAAAAAAAAAAAAAAAAQAAAAQAAAACAAAAsAAAACwAAADcAAAAJAAAAAAAAAAAAAAAAAAAAAAAAABLAQAAAAAAADQAAAAAAAAAQAAAAAAAAAAyAQAAAAAAABkAAAAAAAAAEAAAAAAAAAAZAQAAAAAAABkAAAAAAAAAEAAAAAAAAAAAAQAAAAAAABkAAAAAAAAAEAAAAAAAAAAsAAAAAAAAAAIAKACmAQEAAwMAABAAAAAAAAAAAAB/AAAAAAAAAAAA/////x8AAABLVFh3cml0ZXIAQmFzaXMgVW5pdmVyc2FsIDIuMTAAACi1L/0gEIEAABcODvB/bO0BAAAAAAAAAAAotS/9IBCBAADbFQ+fDzPM/8PM8//z//P/KLUv/SAQgQAA26QGn2+eef9DyFHZYupz+yi1L/0gQF0BAAQC25IGAA8wwP9DyFHZYupz+9uSAwH/E5QNGQ/wTwMa/9MDAGATYIoxZhM=';
const PNG1='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
test('world 0.7 accepts KHR_texture_basisu material textures and rejects them before 0.7',async t=>{
 const {world}=await fixture(t),positions=Buffer.alloc(60);
 [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1].forEach((n,i)=>positions.writeFloatLE(n,i*4));await writeFile(join(world,'mesh.bin'),positions);
 await writeFile(join(world,'albedo.ktx2'),Buffer.from(KTX2,'base64'));await writeFile(join(world,'light.png'),Buffer.from(PNG1,'base64'));
 const g={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],extensionsUsed:['KHR_texture_basisu'],extensionsRequired:['KHR_texture_basisu'],
  meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1,TEXCOORD_1:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],
  textures:[{extensions:{KHR_texture_basisu:{source:0}}},{source:1}],images:[{uri:'albedo.ktx2',mimeType:'image/ktx2'},{uri:'light.png',mimeType:'image/png'}],
  buffers:[{uri:'mesh.bin',byteLength:60}],bufferViews:[{buffer:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:24,target:34962}],
  accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}]};
 const save=()=>writeFile(join(world,'scene.gltf'),JSON.stringify(g));await save();
 const light={material:0,texture:1,texCoord:1,encoding:'srgb',intensity:1};
 await mutate(world,m=>{m.formatVersion='0.7';m.lightmaps=[light];});
 assert.ok(!(await validateWorld(world)).warnings.some(w=>w.includes('image/ktx2') || w.includes('IMAGE_UNRECOGNIZED_FORMAT')));
 await mutate(world,m=>m.formatVersion='0.6');await assert.rejects(validateWorld(world),/KHR_texture_basisu is not allowed in world 0.6/);
 await mutate(world,m=>{m.formatVersion='0.7';m.lightmaps=[{...light,texture:0}];});await assert.rejects(validateWorld(world),/PNG/);
 await mutate(world,m=>m.lightmaps=[light]);g.extensionsRequired=[];await save();await assert.rejects(validateWorld(world),/must be listed/);
});
test('world 0.7 manifests inherit 0.6',()=>{
 const w=JSON.parse(execFileSync('cat',['examples/world-minimal/world.json'],{encoding:'utf8'}));
 w.formatVersion='0.7';w.playable={volumes:[{type:'box',min:[-5,0,-5],max:[5,8,5]}]};
 assert.equal(validateManifest('world',w,undefined,'0.7').valid,true);
 assert.equal(validateManifest('world',w,undefined,'0.6').valid,false);
});

// World 0.8 (RFC-0004): placed world objects (object asset glTFs, instances).
test('world 0.8 validates object assets and their glTF',async t=>{
 const {world}=await fixture(t),positions=Buffer.alloc(60);
 [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1].forEach((n,i)=>positions.writeFloatLE(n,i*4));
 await writeFile(join(world,'mesh.bin'),positions);await mkdir(join(world,'objects'));await writeFile(join(world,'objects','mesh.bin'),positions);
 const mesh={buffers:[{uri:'mesh.bin',byteLength:60}],bufferViews:[{buffer:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:24,target:34962}],
  accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}]};
 await writeFile(join(world,'scene.gltf'),JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],...mesh}));
 // base > {ring, moon}; proxy outside the scene graph.
 const asset={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'base',mesh:0,children:[1,2]},{name:'ring',mesh:0},{name:'moon',mesh:0,translation:[1,0,0]},{name:'proxy',mesh:0}],
  meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1,TEXCOORD_1:1}}]}],...mesh};
 const saveAsset=()=>writeFile(join(world,'objects','armillary.gltf'),JSON.stringify(asset));await saveAsset();
 const assets=[{id:'armillary',scene:'objects/armillary.gltf',animations:[{node:'ring',type:'spin',axis:[1,0,0],pivot:[0,0,0],period:20},
  {node:'moon',type:'orbit',axis:[0,1,0],pivot:[0,0,0],period:60,phase:.5}],collision:{node:'proxy'}}];
 const objects=[{id:'west',asset:'armillary',pose:{position:[-3,0,-6],rotation:[0,0,0,1]}},{id:'east',asset:'armillary',pose:{position:[3,0,-6],rotation:[0,0,0,1]},phase:.5}];
 await mutate(world,m=>{m.formatVersion='0.8';m.objectAssets=assets;m.objects=objects;});
 const result=await validateWorld(world);
 assert.ok(result.warnings.some(w=>w.includes('object asset armillary: TEXCOORD_1 is unused')),result.warnings);
 await mutate(world,m=>m.formatVersion='0.7');await assert.rejects(validateWorld(world),/additional properties/);
 await mutate(world,m=>{m.formatVersion='0.8';m.objects[1].asset='orrery';});await assert.rejects(validateWorld(world),/unknown asset orrery/);
 await mutate(world,m=>{m.objects=objects;m.objectAssets=[{id:'armillary',library:'org.example.armillary@1.0.0'}];});await assert.rejects(validateWorld(world),/library references are reserved/);
 await mutate(world,m=>m.objectAssets=assets);
 asset.nodes[2].children=[3];await saveAsset();await assert.rejects(validateWorld(world),/Object asset armillary: .*collision node "proxy" is inside animated node "moon"/);
 delete asset.nodes[2].children;asset.nodes[1].children=[2];asset.nodes[0].children=[1];await saveAsset();
 await assert.rejects(validateWorld(world),/animation "moon" is inside animated node "ring"/);
 asset.nodes[1].children=[];asset.nodes[0].children=[1,2];asset.nodes[2].name='ring';await saveAsset();await assert.rejects(validateWorld(world),/node "ring" is not unique/);
 asset.nodes[2].name='moon';asset.extensionsUsed=asset.extensionsRequired=['KHR_draco_mesh_compression'];await saveAsset();
 await assert.rejects(validateWorld(world),/KHR_draco_mesh_compression is not allowed in world 0.8/);
 delete asset.extensionsUsed;delete asset.extensionsRequired;asset.buffers[0].uri='../mesh.bin';await saveAsset();await assert.rejects(validateWorld(world),/Unsafe glTF URI/);
});
test('world 0.8 manifests inherit 0.7',()=>{
 const w=JSON.parse(execFileSync('cat',['examples/world-minimal/world.json'],{encoding:'utf8'}));
 w.formatVersion='0.8';w.playable={volumes:[{type:'box',min:[-5,0,-5],max:[5,8,5]}]};
 assert.equal(validateManifest('world',w,undefined,'0.8').valid,true);
 assert.equal(validateManifest('world',{...w,objects:[],objectAssets:[]},undefined,'0.8').valid,true);
 assert.equal(validateManifest('world',{...w,formatVersion:'0.7',objects:[]},undefined,'0.7').valid,false);
});

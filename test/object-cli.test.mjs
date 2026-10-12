// hyprune object add|list and hyprune library install|list|remove (RFC-0011 P1 tooling).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,readdir,symlink,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {validateObject,gltfBounds,objectDir,dataHome} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO} from '../dist/src/mock.js';
import {addObject,objectSlug,glbManifest,libraryInstallParams,libraryKey,catalogTable,OBJECTS_SINCE} from '../dist/src/object-cli.js';
import {writeObject,writeLibrary,packLibrary,triangleGlb,sceneGltf} from './object-fixtures.mjs';

async function temp(t) {const root=await mkdtemp(join(tmpdir(),'hyprune-objcli-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const sha=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const nixHash=hex=>'sha256-'+Buffer.from(hex,'hex').toString('base64');
const visible=async dir=>(await readdir(dir)).sort();

test('user folder paths: HYPRUNE_OBJECT_DIR, then XDG_DATA_HOME, then ~/.local/share',()=>{
 assert.equal(objectDir({HYPRUNE_OBJECT_DIR:'/srv/objects',XDG_DATA_HOME:'/x'}),'/srv/objects');
 assert.equal(objectDir({XDG_DATA_HOME:'/x',HOME:'/h'}),'/x/hyprune/objects');
 assert.equal(objectDir({XDG_DATA_HOME:'relative',HOME:'/h'}),'/h/.local/share/hyprune/objects','a relative XDG_DATA_HOME is ignored');
 assert.equal(dataHome({HOME:'/h'}),'/h/.local/share');assert.throws(()=>dataHome({}));
});

test('bare .glb manifests: slug ids, measured bounds and required flags',()=>{
 assert.equal(objectSlug('/x/My Lamp v2.glb'),'my-lamp-v2');assert.equal(objectSlug('3d-chair.glb'),'object-3d-chair');
 const gltf=sceneGltf();
 assert.deepEqual(gltfBounds(gltf),{min:[-0.25,0,-0.25],max:[0.25,2.5,0.25],exact:true});
 gltf.nodes[0].translation=[1,0,0];assert.deepEqual(gltfBounds(gltf).min,[0.75,0,-0.25]);
 gltf.nodes[0].rotation=[0,0.3826834,0,0.9238795];assert.equal(gltfBounds(gltf).exact,false);
 delete gltf.accessors[0].min;assert.equal(gltfBounds(gltf),undefined);
 assert.throws(()=>glbManifest('lamp.glb',sceneGltf(),{author:'A'}),/--license is required/);
 assert.throws(()=>glbManifest('lamp.glb',sceneGltf(),{license:'CC0-1.0'}),/--author is required/);
 assert.throws(()=>glbManifest('lamp.glb',sceneGltf(),{license:'CC0-1.0',author:'A',surface:'roof'}),/--surface must be one of/);
 const m=glbManifest('/x/street_lamp.glb',sceneGltf(),{license:'CC0-1.0',author:'A',surface:'any'});
 assert.deepEqual(m,{formatVersion:'0.9',id:'street-lamp',version:'1.0.0',name:'Street lamp',category:'other',scene:'object.glb',license:'CC0-1.0',
  attribution:[{path:'.',author:'A',license:'CC0-1.0'}],bounds:{min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]},traits:{movable:{surfaces:['any']}}});
});

test('object add copies a checked directory atomically into the user folder',async t=>{
 const root=await temp(t),folder=join(root,'objects'),source=join(root,'download','lantern-v2');
 await writeObject(source,'street-lantern');
 const r=await addObject(source,{root:folder});
 assert.equal(r.ref,'user/street-lantern');assert.equal(r.path,join(folder,'street-lantern'));assert.equal(r.replaced,false);
 assert.deepEqual(await visible(folder),['street-lantern'],'no staging directory stays behind');
 assert.equal((await validateObject(r.path)).digest,r.digest);
 await assert.rejects(addObject(source,{root:folder}),/exists; pass --replace/);
 const again=await addObject(source,{root:folder,replace:true});assert.equal(again.replaced,true);assert.deepEqual(await visible(folder),['street-lantern']);
 await assert.rejects(addObject(source,{root:folder,name:'x'}),/--name applies to a bare \.glb/);
 // An invalid directory writes nothing.
 const bad=join(root,'bad');await writeObject(bad,'broken');const m=JSON.parse(await readFile(join(bad,'object.json')));m.bounds.max[1]=3;await writeFile(join(bad,'object.json'),JSON.stringify(m));
 await assert.rejects(addObject(bad,{root:folder}),/bounds: max y/);assert.deepEqual(await visible(folder),['street-lantern']);
 await symlink(source,join(root,'linked'));await assert.rejects(addObject(join(root,'linked'),{root:folder}),/symlinks are not added/);
});

test('object add wraps a bare .glb and stops at the first failure',async t=>{
 const root=await temp(t),folder=join(root,'objects'),file=join(root,'Desk Lamp.glb');
 await writeFile(file,triangleGlb());
 const r=await addObject(file,{root:folder,license:'CC0-1.0',author:'Example Author',name:'Desk lamp'});
 assert.equal(r.ref,'user/desk-lamp');assert.deepEqual(await visible(r.path),['object.glb','object.json']);
 const manifest=JSON.parse(await readFile(join(r.path,'object.json')));
 assert.deepEqual(manifest.bounds,{min:[-0.25,0,-0.25],max:[0.25,2.5,0.25]});assert.deepEqual(manifest.traits,{movable:{surfaces:['floor']}});
 assert.equal((await validateObject(r.path)).triangles,1);
 // Floor objects need the base at the origin: the first error is reported, nothing is written.
 const lifted=join(root,'lifted.glb');await writeFile(lifted,triangleGlb([0,0.5,0]));
 await assert.rejects(addObject(lifted,{root:folder,license:'CC0-1.0',author:'A'}),e=>/^bounds: min y must be 0/.test(e.message) && !e.message.includes('\n'));
 assert.deepEqual(await visible(folder),['desk-lamp']);
 await assert.rejects(addObject(lifted,{root:folder,license:'not a licence',author:'A',surface:'any'}),/licen/i);
 await assert.rejects(addObject(join(root,'missing.glb'),{root:folder}),/no such file/);
 await writeFile(join(root,'scene.gltf'),'{}');await assert.rejects(addObject(join(root,'scene.gltf'),{root:folder}),/only a bare \.glb/);
});

test('library install arguments: local archives, releases records, no downloads',async t=>{
 const root=await temp(t),lib=await writeLibrary(join(root,'src'));
 const archive=packLibrary(lib,join(root,'com.example.street-1.2.0.tar.zst')),digest=await sha(archive);
 assert.deepEqual(await libraryInstallParams(archive),{archive,sha256:digest});
 assert.deepEqual(libraryKey('com.example.street@1.2.0'),{id:'com.example.street',version:'1.2.0'});assert.throws(()=>libraryKey('street'),/<id>@<version>/);
 await assert.rejects(libraryInstallParams(undefined),/needs an archive/);
 await assert.rejects(libraryInstallParams(join(root,'nope.tar.zst')),/no such file/);
 await assert.rejects(libraryInstallParams(join(root,'x.zip')),/<id>@<version>/);
 await symlink(archive,join(root,'link.tar.zst'));await assert.rejects(libraryInstallParams(join(root,'link.tar.zst')),/symlinks are refused/);
 await assert.rejects(libraryInstallParams(archive,{releases:'r.json'}),/apply to <id>@<version>/);
 await assert.rejects(libraryInstallParams('com.example.street@1.2.0'),/pass --releases/);
 const record=(over={})=>({'com.example.street@1.2.0':{id:'com.example.street',version:'1.2.0',formatVersion:'0.9',
  url:'https://github.com/example/libraries/releases/download/com.example.street-v1.2.0/com.example.street-1.2.0.tar.zst',sha256:digest,nixHash:nixHash(digest),published:true,...over}});
 const releases=join(root,'releases.json');await writeFile(releases,JSON.stringify(record()));
 assert.deepEqual(await libraryInstallParams('com.example.street@1.2.0',{releases}),{archive,sha256:digest},'the archive next to the record');
 await assert.rejects(libraryInstallParams('com.example.street@9.9.9',{releases}),/no record/);
 await writeFile(releases,JSON.stringify(record({sha256:'0'.repeat(64),nixHash:nixHash('0'.repeat(64))})));
 await assert.rejects(libraryInstallParams('com.example.street@1.2.0',{releases}),/not the pinned/);
 await writeFile(releases,JSON.stringify(record({url:'http://insecure.example/x.tar.zst'})));
 await assert.rejects(libraryInstallParams('com.example.street@1.2.0',{releases}),/releases\.json: /);
 const elsewhere=join(root,'records');await mkdir(elsewhere);const moved=join(elsewhere,'releases.json');await writeFile(moved,JSON.stringify(record()));
 await assert.rejects(libraryInstallParams('com.example.street@1.2.0',{releases:moved}),/No archive for com\.example\.street@1\.2\.0: expected .*download it from https:\/\/github\.com/);
 assert.deepEqual(await libraryInstallParams('com.example.street@1.2.0',{releases:moved,archive}),{archive,sha256:digest});
});

test('catalog table: status and reasons in one line per entry',()=>{
 const e=(ref,over)=>({ref,source:'user',id:'x',version:null,formatVersion:null,name:'X',description:null,category:'other',tags:[],traits:[],surfaces:null,scale:null,
  bounds:null,triangles:null,gpuBytes:null,collisionTriangles:null,thumbnail:null,license:null,library:null,versions:[],state:'ready',placeable:true,reason:null,errors:[],...over});
 assert.equal(catalogTable([]),'no objects');
 assert.equal(catalogTable([e('user/lamp',{name:'Lamp'}),e('user/bad',{name:'bad',state:'invalid',placeable:false,reason:'invalid: bounds'})]),
  'user/lamp  placeable  Lamp\nuser/bad   invalid    bad  (invalid: bounds)');
});

test('hyprune object add|list and library install|list|remove end to end against the 0.22 mock',async t=>{
 const root=await temp(t),folder=join(root,'objects');await mkdir(folder);
 const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];
 const daemon=new MockDaemon({socket:join(root,'control.sock'),scenario,protocol:'0.22',objectDir:folder});await daemon.start();t.after(()=>daemon.stop());
 const run=(args,caps=['state.read','objects.control'])=>new Promise((resolve,reject)=>{
  const token=daemon.issueToken('org.example.cli',caps);
  const child=spawn(process.execPath,['dist/src/cli.js',...args],{stdio:['ignore','pipe','pipe','pipe'],
   env:{...process.env,HYPRUNE_SOCKET:daemon.path,HYPRUNE_CLIENT_ID:'org.example.cli',HYPRUNE_TOKEN_FD:'3',HYPRUNE_PROTOCOL:'',HYPRUNE_OBJECT_DIR:folder,
    XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),XDG_CONFIG_HOME:join(root,'config'),HYPRUNE_LIBRARY_DIR:'',HYPRUNE_WORLD_DIR:''}});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(token+'\n');let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(`${code}: ${err}`)));
 });
 await writeFile(join(root,'lamp.glb'),triangleGlb());
 assert.equal(await run(['object','add',join(root,'lamp.glb'),'--license','CC0-1.0','--author','Example Author']),`added user/lamp (${join(folder,'lamp')})`);
 await writeObject(join(root,'street-lantern'));
 assert.match(await run(['object','add',join(root,'street-lantern')]),/^added user\/street-lantern /);
 const list=await run(['object','list'],['state.read']);
 assert.match(list,/^user\/lamp\s+placeable\s+Lamp$/m);assert.match(list,/^user\/street-lantern\s+placeable\s+Street lantern$/m);
 assert.match(list,/^library\/com\.hyprune\.starter@0\.1\.0\/guide\s+view-only\s+Guide\s+\(character: /m);
 assert.ok(JSON.parse(await run(['object','list','--json'],['state.read'])).entries.some(e=>e.ref==='user/lamp'));
 const archive=packLibrary(await writeLibrary(join(root,'lib')),join(root,'com.example.street-1.2.0.tar.zst')),digest=await sha(archive);
 assert.equal(await run(['library','install',archive]),'installed com.example.street@1.2.0');
 const releases=join(root,'releases.json');
 await writeFile(releases,JSON.stringify({'com.example.street@1.2.0':{id:'com.example.street',version:'1.2.0',formatVersion:'0.9',
  url:'https://example.com/com.example.street-1.2.0.tar.zst',sha256:digest,nixHash:nixHash(digest),published:true}}));
 assert.equal(await run(['library','install','com.example.street@1.2.0','--releases',releases]),'installed com.example.street@1.2.0','idempotent');
 assert.match(await run(['library','list'],['state.read']),/^com\.example\.street@1\.2\.0\s+user\s+ready\s+2 objects  Street kit$/m);
 // Without objects.control the CLI commits libraries itself (RFC-0015 phase 1); the record makes this one idempotent.
 assert.equal(await run(['library','install',archive],['state.read']),'installed com.example.street@1.2.0');
 await assert.rejects(run(['library','remove','com.hyprune.starter@0.1.0']),/system library/);
 assert.equal(await run(['library','remove','com.example.street@1.2.0']),'removed com.example.street@1.2.0');
 assert.doesNotMatch(await run(['library','list'],['state.read']),/com\.example\.street/);
 await assert.rejects(run(['object','list','--protocol','0.21'],['state.read']),/need IPC 0\.22 or newer/);
 assert.equal(OBJECTS_SINCE,'0.22');
 const help=await run(['--help']);assert.match(help,/hyprune object add <dir \| file\.glb>/);assert.match(help,/hyprune library install <archive\.tar\.zst \| id@version>/);assert.match(help,/hyprune world\|library add <id\[@tag\]/);
});

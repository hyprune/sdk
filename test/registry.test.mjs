// RFC-0015 registry units: SemVer and tags, index parsing and limits, serial rollback, labels,
// pre-release handling, the fetch helper's transport rules, and the shared extractor fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,stat,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {registry} from '../dist/src/index.js';
import {startFakeGithub} from './fake-github.mjs';
import {tar,tarEntry,zstd,libraryEntries,tempDir,isolatedEnv} from './registry-fixtures.mjs';

const {parseIndex,parseRecord,newestInstallable,newerThan,compareSemver,matchTag,versionTag,display,checkLabel,slugId,classify,extractArchive,limitsFor,
 download,fetchBytes,allowedUrl,RegistryError,svgProblem,executableSignature,dataFile,refreshSource,listSources,readCachedIndex,readMeta,contentRoots,parseGithub}=registry;
const sha=b=>createHash('sha256').update(b).digest('hex');
const H='5d2f0c6e3b9a41d8e7c2b0f4a6d9e1c3b5a7f9e2d4c6b8a0f1e3d5c7b9a2e4f6';
const version=(v,over={})=>({tag:`v${v}`,version:v,formatVersion:'0.9',published:'2026-10-01',license:'CC0-1.0',url:`https://example.org/x-${v}.tar.zst`,sha256:H,bytes:100,expandedBytes:200,files:3,...over});
const entry=(over={})=>({id:'org.example.tiny',type:'library',name:'Tiny',creator:'example',versions:[version('1.2.0'),version('1.2.0-rc.1'),version('1.1.0')],...over});
const index=(over={})=>({indexVersion:'0.1',name:'Example',serial:5,generated:'2026-10-12T08:00:00Z',entries:[entry()],...over});
const bytes=v=>Buffer.from(JSON.stringify(v));
const rule=r=>e=>e instanceof RegistryError && e.rule===r;

test('SemVer order, tags and bare versions',()=>{
 const order=['0.9.0','1.0.0-alpha','1.0.0-alpha.1','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0','1.0.1','1.10.0','10.0.0'];
 for(let i=1;i<order.length;i++) assert.equal(compareSemver(order[i-1],order[i]),-1,`${order[i-1]} < ${order[i]}`);
 assert.equal(versionTag('1.2.0'),'v1.2.0');assert.equal(versionTag('1.2.0','street'),'street-v1.2.0');
 const vs=[{tag:'street-v1.2.0',version:'1.2.0'},{tag:'v1.1.0',version:'1.1.0'}];
 assert.equal(matchTag(vs,'1.2.0').tag,'street-v1.2.0');assert.equal(matchTag(vs,'v1.1.0').tag,'v1.1.0');assert.equal(matchTag(vs,'v9.9.9'),undefined);
});
test('index parsing: schema, limits, duplicate keys, versions, serial rollback',()=>{
 assert.equal(parseIndex(bytes(index())).serial,5);
 assert.throws(()=>parseIndex(Buffer.alloc(16*1048576+1,32)),rule('source.invalid'));
 assert.throws(()=>parseIndex(Buffer.from('{"indexVersion":"0.1","indexVersion":"0.1"}')),/Duplicate JSON key/);
 assert.throws(()=>parseIndex(Buffer.from([0xff,0xfe])),/not UTF-8/);
 assert.throws(()=>parseIndex(bytes(index({indexVersion:'0.2'}))),e=>rule('format.unsupported')(e) && /newer Hyprune/.test(e.message));
 assert.throws(()=>parseIndex(bytes(index({entries:[entry(),entry()]}))),/duplicate id/);
 assert.throws(()=>parseIndex(bytes(index({entries:[entry({versions:[version('1.0.0'),version('1.1.0')]})]}))),/newest first/);
 assert.throws(()=>parseIndex(bytes(index({entries:[entry({versions:[version('1.0.0',{url:'http://example.org/x.tar.zst'})]})]}))),/pattern/);
 assert.throws(()=>parseIndex(bytes(index({entries:[entry({versions:[version('1.0.0',{tag:'v1.0.1'})]})]}))),/tag must name version/);
 assert.throws(()=>parseIndex(bytes(index({entries:[entry({versions:[version('1.0.0',{bytes:300*1048576})]})]}))),/library archive limit/);
 assert.throws(()=>parseIndex(bytes(index({entries:Array.from({length:20001},(_,i)=>({id:`org.example.e${i}`,type:'library',name:'E',creator:'e',versions:[version('1.0.0',{url:'https://e.org/x'})]}))}))),/more than 20000/);
 // Rollback protection: a lower serial than the last accepted is refused; equal or higher is fine.
 assert.throws(()=>parseIndex(bytes(index({serial:4})),{lastSerial:5}),/rollback refused/);
 assert.equal(parseIndex(bytes(index()),{lastSerial:5}).serial,5);
 // Loopback HTTP only validates with the test switch.
 const loop=index({entries:[entry({versions:[version('1.0.0',{url:'http://127.0.0.1:9/x.tar.zst'})]})]});
 assert.throws(()=>parseIndex(bytes(loop),{env:{}}));assert.equal(parseIndex(bytes(loop),{env:{HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP:'1'}}).entries.length,1);
});
test('pre-releases: never offered unless asked; loadability by known formats',()=>{
 const e=entry({versions:[version('2.0.0-rc.1'),version('1.2.0'),version('1.1.0',{status:'unavailable'})]});
 assert.equal(newestInstallable(e).tag,'v1.2.0');assert.equal(newestInstallable(e,{prerelease:true}).tag,'v2.0.0-rc.1');
 assert.equal(newerThan(e,'1.1.0').tag,'v1.2.0');assert.equal(newerThan(e,'1.2.0'),undefined);
 const future=entry({versions:[version('3.0.0',{formatVersion:'0.99'}),version('1.0.0')]});
 assert.equal(newestInstallable(future).tag,'v1.0.0','a version the SDK cannot load is skipped');
 assert.equal(newestInstallable(entry({type:'world',versions:[version('1.0.0',{formatVersion:'0.9'})]})).tag,'v1.0.0');
});
test('labels: display by kind, printable 1-48 characters, slug ids',()=>{
 assert.equal(display({kind:'official',label:'x'}),'Official');assert.equal(display({kind:'community',label:'x'}),'Community registry');
 assert.equal(display({kind:'index',label:'Official'}),'Custom: Official','a custom source never displays as built in');
 assert.equal(checkLabel("  Frank's stuff "),"Frank's stuff");
 for(const bad of ['','   ','x'.repeat(49),'tab\there']) assert.throws(()=>checkLabel(bad),rule('source.invalid'));
 assert.equal(checkLabel('é'.repeat(48)).length,48);
 assert.equal(slugId("Frank's stuff",[]),'franks-stuff');assert.equal(slugId('Official',[]),'official-2');assert.equal(slugId('A',['a']),'a-2');
 assert.deepEqual(classify('github:frank/hyprune-stuff'),{kind:'github',repo:'frank/hyprune-stuff'});
 assert.deepEqual(classify('github:hyprune/worlds/lumen-reach'),{kind:'github',repo:'hyprune/worlds/lumen-reach'});
 assert.equal(classify('https://example.org/v0.1/index.json').kind,'index');assert.equal(classify('https://example.org/x-1.0.0.tar.zst').kind,'url');
 assert.throws(()=>classify('http://example.org/index.json',{}),rule('source.invalid'));
 assert.throws(()=>parseGithub('github:../x'),rule('source.invalid'));assert.throws(()=>parseGithub('github:a/b/Bad_Name'),rule('source.invalid'));
});
test('records: schema, tag naming the version',()=>{
 const record={recordVersion:'0.1',type:'library',id:'org.example.tiny',version:'1.0.0',formatVersion:'0.9',name:'Tiny',license:'CC0-1.0',
  archive:{name:'org.example.tiny-1.0.0.tar.zst',sha256:H,bytes:10,expandedBytes:20,files:3},source:{repo:'https://github.com/example/tiny',tag:'v1.0.0',commit:'a'.repeat(40)}};
 assert.equal(parseRecord(bytes(record)).id,'org.example.tiny');
 assert.throws(()=>parseRecord(bytes({...record,source:{...record.source,tag:'v1.0.1'}})),/must name version/);
 assert.throws(()=>parseRecord(Buffer.alloc(1048577,32)),/more than 1 MiB/);
 // A meta pins map (libraries/releases.json shape) is named as such, with the archive to add instead.
 const pinsMap={'com.hyprune.starter@0.3.0':{id:'com.hyprune.starter',version:'0.3.0',formatVersion:'0.11',url:'https://github.com/hyprune/worlds/releases/download/hyprune-starter-v0.3.0/com.hyprune.starter-0.3.0.tar.zst',sha256:'8'.repeat(64),nixHash:'sha256-x',published:true}};
 assert.throws(()=>parseRecord(bytes(pinsMap)),/pins map.*not an RFC-0015 release record.*hyprune library add https:\/\/github\.com\/hyprune\/worlds\/releases\/download\/hyprune-starter-v0\.3\.0\/com\.hyprune\.starter-0\.3\.0\.tar\.zst --sha256 8{64}/);
});

test('fetch: HTTPS only, redirects only to allowed URLs, token only to the API host, byte caps',async t=>{
 const fake=await startFakeGithub();t.after(()=>fake.close());
 fake.indexes.set('small',{hello:'world'});
 assert.equal(allowedUrl('http://127.0.0.1/x',{}),false);assert.equal(allowedUrl('http://127.0.0.1/x',fake.env),true);
 assert.equal(allowedUrl('http://example.org/x',fake.env),false,'loopback only');assert.equal(allowedUrl('https://user:pw@example.org/x',{}),false);
 await assert.rejects(fetchBytes(`${fake.base}/index/small.json`,1024,{env:{}}),rule('fetch.failed'));
 assert.equal(JSON.parse(await fetchBytes(`${fake.base}/index/small.json`,1024,{env:fake.env})).hello,'world');
 await assert.rejects(fetchBytes(`${fake.base}/index/small.json`,5,{env:fake.env}),/more than 5/);
 await assert.rejects(fetchBytes(`${fake.base}/redirect?to=${encodeURIComponent('http://example.org/x')}`,1024,{env:fake.env}),/non-HTTPS/);
 assert.equal(JSON.parse(await fetchBytes(`${fake.base}/redirect?to=${encodeURIComponent(fake.base+'/index/small.json')}`,1024,{env:fake.env})).hello,'world');
 let chain=`${fake.base}/index/small.json`;for(let i=0;i<6;i++) chain=`${fake.base}/redirect?to=${encodeURIComponent(chain)}`;
 await assert.rejects(fetchBytes(chain,1024,{env:fake.env}),/more than 5 redirects/);
 fake.repo('example','tiny');
 const env={...fake.env,GITHUB_TOKEN:'secret-token'};
 await fetchBytes(`${fake.base}/api/repos/example/tiny`,4096,{env});await fetchBytes(`${fake.base}/index/small.json`,1024,{env});
 const api=fake.requests.find(r=>r.path==='/api/repos/example/tiny'),idx=fake.requests.filter(r=>r.path==='/index/small.json').at(-1);
 assert.equal(api.headers.authorization,'Bearer secret-token');assert.equal(idx.headers.authorization,undefined,'the token goes to the API host only');
 assert.ok(fake.requests.every(r=>!r.headers.cookie));
 fake.repo('example','tiny').releases.push({tag_name:'v1.0.0',assets:[{name:'a.bin',bytes:Buffer.from('asset')}]});
 assert.equal((await fetchBytes('https://github.com/example/tiny/releases/download/v1.0.0/a.bin',1024,{env:fake.env})).toString(),'asset','github.com downloads go through HYPRUNE_GITHUB_DOWNLOAD');
});
test('download: pinned size and hash, Range resume, hash failure deletes the part',async t=>{
 const fake=await startFakeGithub(),dir=await tempDir(t);t.after(()=>fake.close());
 const body=Buffer.alloc(300000,7),hash=sha(body);
 fake.repo('example','tiny').releases.push({tag_name:'v1.0.0',assets:[{name:'a.tar.zst',bytes:body}]});
 const url=fake.assetUrl('example','tiny','v1.0.0','a.tar.zst');
 // A partial download resumes with Range.
 await writeFile(join(dir,`${hash}.tar.zst.part`),body.subarray(0,1000));
 const progress=[];
 const path=await download(url,{bytes:body.length,sha256:hash,dir,env:fake.env,onProgress:p=>progress.push(p)});
 assert.equal(path,join(dir,`${hash}.tar.zst`));assert.deepEqual(await readFile(path),body);
 assert.equal(fake.requests.at(-1).headers.range,'bytes=1000-');assert.deepEqual(progress.at(-1),{bytes:body.length,total:body.length});
 // Cached and verified: no new request.
 const before=fake.requests.length;await download(url,{bytes:body.length,sha256:hash,dir,env:fake.env});assert.equal(fake.requests.length,before);
 await assert.rejects(download(url,{bytes:body.length,sha256:'0'.repeat(64),dir,env:fake.env}),rule('hash.mismatch'));
 assert.ok(!existsSync(join(dir,`${'0'.repeat(64)}.tar.zst.part`)),'a mismatching part is deleted');
 await assert.rejects(download(url,{bytes:1000,sha256:hash,dir:join(dir,'x'),env:fake.env}),/more than the pinned 1000/);
 await assert.rejects(download(url,{bytes:body.length+1,sha256:hash,dir:join(dir,'y'),env:fake.env}),/ended early/);
 // A full disk is an error with its rule, never an unhandled stream error (the part file
 // links to /dev/full, where every write fails with ENOSPC).
 if(existsSync('/dev/full')) {
  const full=join(dir,'full');await mkdir(full);await symlink('/dev/full',join(full,`${hash}.tar.zst.part`));
  await assert.rejects(download(url,{bytes:body.length,sha256:hash,dir:full,env:fake.env}),rule('disk.full'));
 }
});

async function extract(t,bytes,options={}) {
 const dir=await tempDir(t),archive=join(dir,'a.tar.zst');await writeFile(archive,bytes);
 const into=join(dir,'into');await mkdir(into);
 return extractArchive(archive,into,{limits:limitsFor('library'),expectRoot:'com.example.tiny',...options}).then(r=>({...r,into}));
}
test('extractor: a valid library archive',async t=>{
 const r=await extract(t,zstd(tar(libraryEntries())));
 assert.equal(r.root,'com.example.tiny');assert.deepEqual(r.files.map(f=>f.path),['ATTRIBUTION.md','LICENSE','library.json']);
 const st=await stat(join(r.into,'com.example.tiny','library.json'));assert.equal(st.mode&0o777,0o644);
});
const unsafe=[
 ['path traversal',[['com.example.tiny/../evil.json',{data:'{}'}]],'archive.unsafe'],
 ['absolute path',[['/etc/evil.json',{data:'{}'}]],'archive.unsafe'],
 ['empty segment',[['com.example.tiny//x.json',{data:'{}'}]],'archive.unsafe'],
 ['dot segment',[['com.example.tiny/./x.json',{data:'{}'}]],'archive.unsafe'],
 ['backslash',[['com.example.tiny/a\\b.json',{data:'{}'}]],'archive.unsafe'],
 ['percent',[['com.example.tiny/a%2e.json',{data:'{}'}]],'archive.unsafe'],
 ['colon',[['com.example.tiny/a:b.json',{data:'{}'}]],'archive.unsafe'],
 ['question mark',[['com.example.tiny/a?.json',{data:'{}'}]],'archive.unsafe'],
 ['symlink',[['com.example.tiny/link.json',{type:'2',linkname:'/etc/passwd'}]],'archive.unsafe'],
 ['hard link',[['com.example.tiny/link.json',{type:'1',linkname:'com.example.tiny/library.json'}]],'archive.unsafe'],
 ['character device',[['com.example.tiny/dev.json',{type:'3'}]],'archive.unsafe'],
 ['block device',[['com.example.tiny/dev.json',{type:'4'}]],'archive.unsafe'],
 ['FIFO',[['com.example.tiny/fifo.json',{type:'6'}]],'archive.unsafe'],
 ['pax header',[['com.example.tiny/pax',{type:'x'}]],'archive.unsafe'],
 ['second root',[['other/x.json',{data:'{}'}]],'archive.unsafe'],
 ['duplicate member',[['com.example.tiny/LICENSE',{data:'again'}]],'archive.unsafe'],
 ['executable bit',[['com.example.tiny/run.json',{data:'{}',mode:0o755}]],'data.executable'],
 ['ELF signature',[['com.example.tiny/model.bin',{data:Buffer.from([0x7f,0x45,0x4c,0x46,2,1,1,0])}]],'data.executable'],
 ['PE signature',[['com.example.tiny/model.bin',{data:Buffer.from('MZ\x90\x00')}]],'data.executable'],
 ['Mach-O signature',[['com.example.tiny/model.bin',{data:Buffer.from([0xcf,0xfa,0xed,0xfe])}]],'data.executable'],
 ['script signature',[['com.example.tiny/notes.txt',{data:'#!/bin/sh\nrm -rf ~\n'}]],'data.executable'],
 ['WebAssembly signature',[['com.example.tiny/model.bin',{data:Buffer.from([0,0x61,0x73,0x6d,1,0,0,0])}]],'data.executable'],
 ['not on the allowlist',[['com.example.tiny/tool.py',{data:'print(1)'}]],'data.executable'],
 ['SVG with a script',[['com.example.tiny/map.svg',{data:'<svg><script>alert(1)</script></svg>'}]],'data.executable'],
 ['SVG with an event attribute',[['com.example.tiny/map.svg',{data:'<svg onload="x()"></svg>'}]],'data.executable'],
 ['SVG with an external reference',[['com.example.tiny/map.svg',{data:'<svg><image href="https://example.org/x.png"/></svg>'}]],'data.executable'],
 ['oversized file',[['com.example.tiny/big.bin',{data:Buffer.alloc(16),size:32*1048576+1}]],'archive.limit'],
];
for(const [name,extra,expected] of unsafe) test(`extractor refuses: ${name}`,async t=>{
 const entries=name==='second root' || name==='absolute path'?[...libraryEntries(),...extra]:libraryEntries('com.example.tiny','1.0.0',extra);
 await assert.rejects(extract(t,zstd(tar(entries))),e=>{assert.equal(e.rule,expected,e.message);return true;});
});
test('extractor refuses: wrong root, too many files, expanded size, zstd window, not ustar, truncation, trailing data',async t=>{
 await assert.rejects(extract(t,zstd(tar(libraryEntries('com.example.other')))),/root must be com\.example\.tiny/);
 const many=Array.from({length:12},(_,i)=>[`com.example.tiny/f${i}.json`,{data:'{}'}]);
 await assert.rejects(extract(t,zstd(tar(libraryEntries('com.example.tiny','1.0.0',many))),{limits:{...limitsFor('library'),files:10}}),rule('archive.limit'));
 await assert.rejects(extract(t,zstd(tar(libraryEntries('com.example.tiny','1.0.0',[['com.example.tiny/a.bin',{data:Buffer.alloc(4096)}]]))),{limits:{...limitsFor('library'),expandedBytes:1024}}),rule('archive.limit'));
 await assert.rejects(extract(t,zstd(tar(libraryEntries()),['--long=28'])),e=>e.rule==='archive.limit' && /window/.test(e.message));
 assert.equal((await extract(t,zstd(tar(libraryEntries()),['--long=27']))).root,'com.example.tiny');
 await assert.rejects(extract(t,zstd(tar([[`com.example.tiny/x.json`,{data:'{}',magic:'xxxxx\0'}]]))),/ustar/);
 await assert.rejects(extract(t,zstd(tar(libraryEntries()).subarray(0,1100))),rule('archive.unsafe'));
 await assert.rejects(extract(t,Buffer.from('not zstd at all')),rule('archive.unsafe'));
 await assert.rejects(extract(t,zstd(Buffer.concat([tar(libraryEntries()),tarEntry('com.example.tiny/late.json',{data:'{}'})]))),/after an end-of-archive/);
 await assert.rejects(extract(t,zstd(Buffer.alloc(1024))),/empty archive/);
 const huge=Buffer.alloc(1024);
 await assert.rejects(extract(t,huge,{limits:{...limitsFor('library'),bytes:100}}),rule('archive.limit'));
});
test('data-only helpers',()=>{
 for(const ok of ['a/world.json','a/scene.glb','a/scene.gltf','a/b.bin','a/t.PNG','a/t.jpg','a/t.jpeg','a/t.ktx2','a/map.svg','a/s.ogg','a/s.wav','a/README.md','a/n.txt','a/LICENSE','a/NOTICE.md','a/COPYING','a/ATTRIBUTION.txt'])
  assert.ok(dataFile(ok),ok);
 for(const bad of ['a/x.js','a/x.so','a/x.html','a/x.wasm','a/x','a/LICENSE.sh','a/.json']) assert.ok(!dataFile(bad),bad);
 assert.equal(executableSignature(Buffer.from('{"a":1}')),undefined);
 assert.equal(svgProblem(Buffer.from('<svg viewBox="0 0 10 10"><use href="#a"/><path fill="url(#g)" d="M0 0"/></svg>')),undefined);
 assert.equal(svgProblem(Buffer.from('<svg><style>@import "x.css";</style></svg>')),'external reference');
 assert.equal(svgProblem(Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')),'DOCTYPE or entity');
});

test('sources: built-ins, refresh into the cache, serial rollback keeps the cached index',async t=>{
 const fake=await startFakeGithub(),root=await tempDir(t);t.after(()=>fake.close());
 const env=isolatedEnv(root,{...fake.env,HYPRUNE_REGISTRY_OFFICIAL_URL:`${fake.base}/index/official.json`,HYPRUNE_REGISTRY_COMMUNITY_URL:`${fake.base}/index/community.json`});
 const ctx={env,roots:contentRoots(env)};
 const list=listSources(ctx);
 assert.deepEqual(list.map(s=>[s.id,s.display,s.enabled,s.builtin]),[['official','Official',true,true],['community','Community registry',true,true]]);
 fake.indexes.set('official',index({serial:7}));
 let r=await refreshSource(list[0],ctx);
 assert.equal(r.error,null);assert.equal(r.serial,7);assert.equal(readCachedIndex('official',ctx).serial,7);
 fake.indexes.set('official',index({serial:6,entries:[]}));
 r=await refreshSource(list[0],ctx);
 assert.match(r.error,/rollback refused/);assert.equal(readCachedIndex('official',ctx).entries.length,1,'the cached index stays');
 assert.equal(readMeta('official',ctx).serial,7);
 r=await refreshSource(list[1],ctx);assert.match(r.error,/HTTP 404/);
});
test('archive URL sources: the tag comes from a release asset URL, else v<version>',async t=>{
 const fake=await startFakeGithub(),root=await tempDir(t);t.after(()=>fake.close());
 const env=isolatedEnv(root,fake.env),ctx={env,roots:contentRoots(env)};
 const archive=zstd(tar(libraryEntries('com.example.tiny','1.0.0')));
 fake.repo('example','tiny').releases.push({tag_name:'tiny-v1.0.0',assets:[{name:'com.example.tiny-1.0.0.tar.zst',bytes:archive}]});
 const e=await registry.archiveEntry(fake.assetUrl('example','tiny','tiny-v1.0.0','com.example.tiny-1.0.0.tar.zst'),sha(archive),ctx);
 assert.deepEqual([e.id,e.type,e.versions[0].tag,e.versions[0].bytes,e.versions[0].files],['com.example.tiny','library','tiny-v1.0.0',archive.length,3]);
 fake.indexes.set('x',archive);
 assert.equal((await registry.archiveEntry(`${fake.base}/index/x.json`,sha(archive),ctx)).versions[0].tag,'v1.0.0');
});

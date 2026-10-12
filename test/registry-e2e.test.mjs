// RFC-0015 end to end through the CLI against test/fake-github.mjs (no network): publish with
// pack --release, a github: source, install, a newer tag, update, rollback, pin, remove; an
// index source with requirements; a custom labelled source; replaced assets, hash and id
// mismatches, pre-releases, offline installs, source changes and core's libraries.install.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {startFakeGithub} from './fake-github.mjs';
import {writeLibrary,png} from './object-fixtures.mjs';
import {tempDir,isolatedEnv,cli,writeWorld} from './registry-fixtures.mjs';
import {MockDaemon,DEFAULT_SCENARIO} from '../dist/src/mock.js';
import {registry} from '../dist/src/index.js';

const LIB='io.github.example-creator.street',OWNER='example-creator',REPO='hyprune-objects-street',COMMIT=n=>String(n).repeat(40).slice(0,40);
const stages=lines=>lines.filter(l=>l.event==='stage').map(l=>l.stage);
const done=lines=>lines.find(l=>l.event==='done')?.result;
const error=lines=>lines.find(l=>l.event==='error')?.error;
const ok=r=>{assert.equal(r.code,0,`exit ${r.code}\n${r.err}\n${r.out}`);return r;};

async function context(t) {
 const fake=await startFakeGithub(),root=await tempDir(t,'hyprune-e2e-');t.after(()=>fake.close());
 fake.indexes.set('official',{indexVersion:'0.1',serial:1,generated:'2026-10-12T00:00:00Z',entries:[]});
 fake.indexes.set('community',{indexVersion:'0.1',serial:1,generated:'2026-10-12T00:00:00Z',entries:[]});
 const env=isolatedEnv(root,{...fake.env,HYPRUNE_REGISTRY_OFFICIAL_URL:`${fake.base}/index/official.json`,HYPRUNE_REGISTRY_COMMUNITY_URL:`${fake.base}/index/community.json`});
 const run=(...args)=>cli(args,env);
 const data=join(root,'data','hyprune');
 return {fake,root,env,run,data,libraries:join(data,'libraries'),worlds:join(data,'worlds'),
  content:()=>run('installed','--json').then(r=>JSON.parse(ok(r).out).installs)};
}
/** pack --release a library version into <root>/rel-<version>[-suffix]. */
async function releaseLibrary(c,version,{name='Street kit',suffix='',thumbnail=false,tag=`v${version}`}={}) {
 const src=join(c.root,`src-${version}${suffix}`),dir=await writeLibrary(src,{id:LIB,version,name}),out=join(c.root,`rel-${version}${suffix}`);
 const args=['library','pack',dir,'--release','--repo',`https://github.com/${OWNER}/${REPO}`,'--commit',COMMIT(version.length),'--output',out,'--tag',tag];
 if(thumbnail) {await writeFile(join(c.root,'thumb.png'),png(320,180));args.push('--thumbnail',join(c.root,'thumb.png'));}
 const r=ok(await c.run(...args));
 return {out,result:JSON.parse(r.out)};
}

test('publish → github: source → install → newer tag → update → rollback → pin → remove',async t=>{
 const c=await context(t);
 // Publish v1.0.0 with a thumbnail.
 const v1=await releaseLibrary(c,'1.0.0',{thumbnail:true});
 assert.deepEqual((await readdir(v1.out)).sort(),[`${LIB}-1.0.0.release.json`,`${LIB}-1.0.0.tar.zst`,`${LIB}-1.0.0.tar.zst.sha256`,`${LIB}-1.0.0.thumb-1.png`]);
 const record=JSON.parse(await readFile(join(v1.out,`${LIB}-1.0.0.release.json`)));
 assert.equal(record.source.tag,'v1.0.0');assert.equal(record.type,'library');assert.equal(record.archive.files,13);
 assert.match(await readFile(join(v1.out,`${LIB}-1.0.0.tar.zst.sha256`),'utf8'),new RegExp(`^${record.archive.sha256}  ${LIB}-1\\.0\\.0\\.tar\\.zst\\n$`));
 assert.equal(registry.validateRegistry('release-record',record).valid,true);
 // A tag that doesn't name the manifest version is refused.
 const bad=await c.run('library','pack',join(c.root,'src-1.0.0',LIB),'--release','--repo','https://github.com/x/y','--commit',COMMIT(1),'--output',join(c.root,'bad'),'--tag','v2.0.0');
 assert.equal(bad.code,3);assert.match(bad.err,/tag v2\.0\.0 must name the manifest version 1\.0\.0/);
 c.fake.repo(OWNER,REPO);c.fake.publish(OWNER,REPO,'v1.0.0',v1.out);
 // A draft and a release without a record are skipped.
 c.fake.repo(OWNER,REPO).releases.push({tag_name:'v0.9.0',assets:[{name:'notes.txt',bytes:Buffer.from('x')}]},{tag_name:'v0.8.0',draft:true,assets:[]});

 // github: source with a user label.
 let r=ok(await c.run('source','add',`github:${OWNER}/${REPO}`,'--label',"Ada's objects",'--json'));
 const added=done(r.lines);
 assert.equal(added.display,"Custom: Ada's objects");assert.equal(added.kind,'github');assert.equal(added.entries,1);assert.equal(added.id,'adas-objects');
 assert.ok(added.skipped.some(s=>s.tag==='v0.9.0' && /no release record/.test(s.reason)));assert.ok(added.skipped.some(s=>s.tag==='v0.8.0' && /draft/.test(s.reason)));
 const sources=JSON.parse(ok(await c.run('source','list','--json')).out).sources;
 assert.deepEqual(sources.map(s=>s.display),['Official','Community registry',"Custom: Ada's objects"]);
 assert.equal(sources[2].repo,`${OWNER}/${REPO}`);assert.equal(sources[2].entries,1);
 assert.equal(c.fake.requests.filter(q=>q.path.includes('.tar.zst') && !q.path.endsWith('.sha256')).length,0,'adding a github: source downloads no archive');

 // Browse (cache only): tier, licence note, verified thumbnail.
 const before=c.fake.requests.length;
 const browse=JSON.parse(ok(await c.run('browse','street','--json')).out).entries;
 assert.equal(c.fake.requests.length,before,'browse reads the cache only');
 assert.equal(browse.length,1);const e=browse[0];
 assert.equal(e.tier,'custom');assert.equal(e.licenceNote,'unchecked');assert.equal(e.latest.tag,'v1.0.0');assert.equal(e.installed,null);
 assert.ok(e.thumbnail && existsSync(e.thumbnail),'card thumbnail cached and verified');assert.equal(e.creator,OWNER);

 // Plan only: no download.
 r=ok(await c.run('library','add',LIB,'--plan','--json','--no-session'));
 assert.deepEqual(r.lines.map(l=>l.event),['stage','plan']);
 const plan=r.lines[1].plan;
 assert.equal(plan.packages[0].action,'install');assert.equal(plan.packages[0].sourceLabel,"Custom: Ada's objects");assert.equal(plan.packages[0].licenceNote,'unchecked');
 assert.equal(plan.sourceChange,null);assert.ok(plan.diskFreeAfter>0);
 // Without --yes and without a terminal the job stops after the plan.
 r=await c.run('library','add',LIB,'--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'confirm.required');assert.ok(!existsSync(join(c.libraries,`${LIB}@1.0.0`)));

 // Install.
 r=ok(await c.run('library','add',LIB,'--yes','--json','--no-session'));
 assert.deepEqual(stages(r.lines),['resolving','downloading','verifying','extracting','validating','committing']);
 assert.ok(r.lines.some(l=>l.event==='progress'));
 assert.deepEqual(done(r.lines),{id:LIB,type:'library',tag:'v1.0.0',version:'1.0.0',action:'install',sourceId:'adas-objects',pinned:false});
 assert.ok(existsSync(join(c.libraries,`${LIB}@1.0.0`,'library.json')));
 assert.deepEqual((await readdir(c.libraries)).filter(n=>n.startsWith('.')),[],'no staging directory stays');
 assert.deepEqual(await readdir(join(c.root,'cache','hyprune','downloads')),[],'the download is pruned after commit');
 let installs=await c.content();
 assert.equal(installs.length,1);
 assert.deepEqual({...installs[0],path:undefined},{id:LIB,type:'library',sourceId:'adas-objects',display:"Custom: Ada's objects",sourceState:'enabled',tag:'v1.0.0',version:'1.0.0',
  previous:null,pinned:false,pending:null,managed:'user',removedFromSource:false,newerTag:null,license:'CC0-1.0',sha256:record.archive.sha256,path:undefined});
 // Same tag, same hash: idempotent.
 r=ok(await c.run('library','add',`${LIB}@v1.0.0`,'--yes','--json','--no-session'));
 assert.equal(done(r.lines).action,'already-installed');

 // A newer tag and a pre-release.
 const v11=await releaseLibrary(c,'1.1.0');c.fake.publish(OWNER,REPO,'v1.1.0',v11.out);
 const rc=await releaseLibrary(c,'1.2.0-rc.1');c.fake.publish(OWNER,REPO,'v1.2.0-rc.1',rc.out,{prerelease:true});
 // A pre-release version not marked as one is skipped.
 const rc2=await releaseLibrary(c,'1.3.0-rc.1');c.fake.publish(OWNER,REPO,'v1.3.0-rc.1',rc2.out,{prerelease:false});
 r=ok(await c.run('source','refresh','adas-objects','--json'));
 assert.equal(done(r.lines).refreshed[0].entries,1);
 assert.ok(done(r.lines).refreshed[0].skipped.some(s=>s.tag==='v1.3.0-rc.1' && /not marked/.test(s.reason)));
 installs=await c.content();assert.equal(installs[0].newerTag,'v1.1.0','pre-releases are never offered as updates');
 assert.equal(JSON.parse(ok(await c.run('library','list','--updates','--json','--no-session')).out).installs.length,1);

 // Update.
 r=ok(await c.run('library','update',LIB,'--yes','--json','--no-session'));
 assert.deepEqual(done(r.lines),{id:LIB,type:'library',tag:'v1.1.0',version:'1.1.0',action:'update',sourceId:'adas-objects',pinned:false});
 assert.equal(r.lines.find(l=>l.event==='plan').plan.packages[0].replaces,'v1.0.0');
 installs=await c.content();
 assert.equal(installs[0].tag,'v1.1.0');assert.deepEqual(installs[0].previous,{tag:'v1.0.0',version:'1.0.0'});
 assert.ok(existsSync(join(c.libraries,`${LIB}@1.0.0`)) && existsSync(join(c.libraries,`${LIB}@1.1.0`)),'current and previous versions are kept');
 r=ok(await c.run('update','--all','--yes','--json','--no-session'));
 assert.deepEqual(done(r.lines).results.map(x=>[x.id,x.status]),[[LIB,'current']]);

 // Rollback: swap and pin.
 r=ok(await c.run('library','rollback',LIB,'--json','--no-session'));
 installs=await c.content();
 assert.equal(installs[0].tag,'v1.0.0');assert.equal(installs[0].pinned,true);assert.deepEqual(installs[0].previous,{tag:'v1.1.0',version:'1.1.0'});
 assert.equal(installs[0].newerTag,'v1.1.0','a pinned install still shows the newer tag');
 r=ok(await c.run('update','--all','--yes','--json','--no-session'));
 assert.deepEqual(done(r.lines).results.map(x=>[x.id,x.status,x.newerTag]),[[LIB,'pinned','v1.1.0']]);
 ok(await c.run('library','unpin',LIB,'--no-session'));assert.equal((await c.content())[0].pinned,false);
 ok(await c.run('pin',LIB,'--no-session'));assert.equal((await c.content())[0].pinned,true);
 ok(await c.run('library','unpin',LIB,'--no-session'));

 // An explicit pre-release tag installs (and --pin pins it).
 r=ok(await c.run('library','add',`${LIB}@1.2.0-rc.1`,'--pin','--yes','--json','--no-session'));
 assert.equal(done(r.lines).tag,'v1.2.0-rc.1');assert.equal(done(r.lines).pinned,true);
 assert.equal(done(r.lines).action,'update');
 assert.ok(!existsSync(join(c.libraries,`${LIB}@1.1.0`)),'the old previous version is deleted');
 r=ok(await c.run('library','add',`${LIB}@v1.0.0`,'--yes','--json','--no-session'));
 assert.equal(done(r.lines).action,'downgrade');

 // A creator replaces the published v1.0.0 assets: the recorded tag now pins another hash.
 const replaced=await releaseLibrary(c,'1.0.0',{name:'Street kit (re-uploaded)',suffix:'-b'});
 c.fake.publish(OWNER,REPO,'v1.0.0',replaced.out);
 ok(await c.run('source','refresh','adas-objects'));
 r=await c.run('library','add',`${LIB}@v1.0.0`,'--yes','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'content.conflict');assert.match(error(r.lines).message,/replaced asset/);

 // Remove: current and previous, and the record.
 r=ok(await c.run('remove',LIB,'--json','--no-session'));
 assert.deepEqual(done(r.lines).removed.sort(),[`${LIB}@1.0.0`,`${LIB}@1.2.0-rc.1`]);
 assert.deepEqual((await c.content()),[]);
 assert.deepEqual((await readdir(c.libraries)).filter(n=>n.startsWith(LIB)),[]);
 r=await c.run('remove',LIB,'--json','--no-session');assert.equal(r.code,1);assert.equal(error(r.lines).rule,'not.found');

 // Disable, relabel and remove the source; built-ins can't be removed.
 assert.equal(JSON.parse(ok(await c.run('source','label','adas-objects','Street kits','--json')).out).display,'Custom: Street kits');
 assert.equal(JSON.parse(ok(await c.run('source','disable','official','--json')).out).enabled,false);
 r=await c.run('source','remove','official');assert.equal(r.code,3);assert.match(r.err,/built in/);
 ok(await c.run('source','remove','adas-objects'));
 assert.deepEqual(JSON.parse(ok(await c.run('source','list','--json')).out).sources.map(s=>s.id),['official','community']);
});

test('index source: labels, requirements, world update and rollback, hash and id mismatches, source change, offline install',async t=>{
 const c=await context(t);
 // A library and a world 0.9 that requires it, released from one multi-package repository.
 const lib=await writeLibrary(join(c.root,'lsrc'),{id:'org.example.street',version:'1.1.0'});
 const libOut=join(c.root,'rel-lib');
 ok(await c.run('library','pack',lib,'--release','--tag','street-v1.1.0','--repo','https://github.com/example-org/worlds','--commit',COMMIT(3),'--output',libOut));
 const world=async(version,out)=>{
  const dir=await writeWorld(join(c.root,`w-${version}`,'org.example.harbour'),{id:'org.example.harbour',version});
  const w=JSON.parse(await readFile(join(dir,'world.json')));w.formatVersion='0.9';w.objectAssets=[{id:'bench',library:'org.example.street@1.1.0',object:'bench'}];
  await writeFile(join(dir,'world.json'),JSON.stringify(w));
  ok(await c.run('world','pack',dir,'--release','--tag',`harbour-v${version}`,'--repo','https://github.com/example-org/worlds','--commit',COMMIT(version.length+4),'--output',out));
  return out;
 };
 const w1=await world('1.0.0',join(c.root,'rel-w1'));
 const rec=JSON.parse(await readFile(join(w1,'org.example.harbour-1.0.0.release.json')));
 assert.deepEqual(rec.requires,{libraries:['org.example.street@1.1.0']});assert.equal(rec.type,'world');
 c.fake.repo('example-org','worlds');
 c.fake.publish('example-org','worlds','street-v1.1.0',libOut);c.fake.publish('example-org','worlds','harbour-v1.0.0',w1);
 // registry entry from the release directory: URLs at the GitHub release of the tag.
 const entryOf=async dir=>JSON.parse(ok(await c.run('registry','entry',dir,'--summary','A harbour.')).out);
 const harbour=await entryOf(w1),street=await entryOf(libOut);
 assert.equal(harbour.versions[0].url,c.fake.assetUrl('example-org','worlds','harbour-v1.0.0','org.example.harbour-1.0.0.tar.zst'));
 assert.equal(harbour.$schema,'https://hyprune.com/schema/registry/v0.1/index.schema.json#/$defs/entry');
 const strip=({$schema,...e})=>e;
 let serial=10;
 const publishIndex=entries=>c.fake.indexes.set('frank',{indexVersion:'0.1',name:"Frank's worlds",serial:serial++,generated:'2026-10-12T00:00:00Z',entries:entries.map(strip)});
 publishIndex([harbour]);
 let r=ok(await c.run('source','add',`${c.fake.base}/index/frank.json`,'--json'));
 assert.equal(done(r.lines).display,"Custom: Frank's worlds",'the default label is the index name');
 // The required library isn't listed anywhere: refused at the plan.
 r=await c.run('world','add','org.example.harbour','--yes','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'requirement.missing');
 publishIndex([harbour,street]);ok(await c.run('source','refresh'));
 const downloads=()=>c.fake.requests.filter(q=>q.path.startsWith('/dl/') && q.path.endsWith('.tar.zst')).length;
 const before=downloads();
 r=ok(await c.run('world','add','org.example.harbour','--plan','--json','--no-session'));
 const plan=r.lines.find(l=>l.event==='plan').plan;
 assert.deepEqual(plan.packages.map(p=>[p.id,p.type,p.tag,p.action]),[['org.example.street','library','street-v1.1.0','install'],['org.example.harbour','world','harbour-v1.0.0','install']]);
 assert.equal(downloads(),before,'nothing is downloaded before confirmation');
 r=ok(await c.run('world','add','org.example.harbour','--yes','--json','--no-session'));
 assert.equal(done(r.lines).tag,'harbour-v1.0.0');
 assert.ok(existsSync(join(c.worlds,'org.example.harbour','world.json')));assert.ok(existsSync(join(c.libraries,'org.example.street@1.1.0')));
 // A library version an installed world requires can't be removed without --force.
 r=await c.run('library','remove','org.example.street@1.1.0','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'requirement.missing');assert.match(error(r.lines).message,/org\.example\.harbour/);

 // World update and rollback (previous in .previous/<id>/).
 const w2=await world('1.1.0',join(c.root,'rel-w2'));c.fake.publish('example-org','worlds','harbour-v1.1.0',w2);
 const harbour2=await entryOf(w2);publishIndex([{...harbour2,versions:[harbour2.versions[0],harbour.versions[0]]},street]);
 r=ok(await c.run('world','update','--all','--yes','--json','--no-session'));
 assert.deepEqual(done(r.lines).results.map(x=>[x.id,x.status,x.newerTag]),[['org.example.harbour','updated','harbour-v1.1.0']]);
 const version=p=>JSON.parse(readFileSync(join(p,'world.json'),'utf8')).version;
 assert.equal(version(join(c.worlds,'org.example.harbour')),'1.1.0');assert.equal(version(join(c.worlds,'.previous','org.example.harbour')),'1.0.0');
 ok(await c.run('world','rollback','org.example.harbour','--no-session'));
 assert.equal(version(join(c.worlds,'org.example.harbour')),'1.0.0');assert.equal(version(join(c.worlds,'.previous','org.example.harbour')),'1.1.0');
 const info=JSON.parse(ok(await c.run('world','info','org.example.harbour','--json')).out);
 assert.equal(info.tag,'harbour-v1.0.0');assert.equal(info.pinned,true);assert.equal(info.newerTag,'harbour-v1.1.0');assert.equal(info.entry.summary,'A harbour.');

 // Serial rollback: the cached index stays.
 c.fake.indexes.set('frank',{...c.fake.indexes.get('frank'),serial:1});
 r=await c.run('source','refresh','franks-worlds','--json');
 assert.equal(r.code,1);assert.match(done(r.lines).refreshed[0].error,/rollback refused/);
 assert.equal(JSON.parse(ok(await c.run('browse','--source','franks-worlds','--json')).out).entries.length,2);
 publishIndex([{...harbour2,versions:[harbour2.versions[0],harbour.versions[0]]},street]);

 // Hash mismatch: an entry pinning the wrong hash fails and leaves nothing behind.
 const wrong={...harbour,id:'org.example.wrong-hash',versions:[{...harbour.versions[0],sha256:'0'.repeat(64)}]};
 // Id mismatch: an entry naming another id for the harbour archive.
 const otherId={...harbour,id:'org.example.other'};
 publishIndex([{...harbour2,versions:[harbour2.versions[0],harbour.versions[0]]},street,wrong,otherId]);ok(await c.run('source','refresh'));
 r=await c.run('world','add','org.example.wrong-hash','--yes','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'hash.mismatch');
 assert.deepEqual((await readdir(join(c.root,'cache','hyprune','downloads'))).filter(n=>n.includes('0'.repeat(64))),[]);
 r=await c.run('world','add','org.example.other','--yes','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'archive.unsafe');assert.match(error(r.lines).message,/root must be org\.example\.other/);
 assert.ok(!existsSync(join(c.worlds,'org.example.other')));
 assert.deepEqual((await readdir(c.worlds)).filter(n=>n.startsWith('.staging')),[]);

 // The same id from a one-off github: install is a source change.
 r=await c.run('world','add','github:example-org/worlds/harbour@harbour-v1.0.0','--yes','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'source.change');
 const change=r.lines.find(l=>l.event==='plan').plan.sourceChange;
 assert.deepEqual(change,{id:'org.example.harbour',from:{sourceId:'franks-worlds',display:"Custom: Frank's worlds"},to:{sourceId:'github:example-org/worlds/harbour',display:'Custom: example-org/worlds'}});
 r=ok(await c.run('world','add','github:example-org/worlds/harbour@harbour-v1.0.0','--yes','--accept-source-change','--json','--no-session'));
 assert.equal(done(r.lines).action,'already-installed');
 assert.equal((await c.content()).find(i=>i.id==='org.example.harbour').sourceId,'github:example-org/worlds/harbour');
 // Several packages in one repository need a name.
 r=ok(await c.run('world','add','github:example-org/worlds','--plan','--json','--no-session'));
 assert.equal(r.lines.find(l=>l.event==='plan').plan.packages.at(-1).id,'org.example.harbour','type world narrows it to the one world');
 r=await c.run('install','github:example-org/worlds','--yes','--json','--no-session');
 assert.equal(r.code,3);assert.match(error(r.lines).message,/several packages/);

 // Offline: an archive matching a cached entry records its source and tag; another is {source: "file"}.
 const offline=await writeWorld(join(c.root,'offline','org.example.offline'),{id:'org.example.offline',version:'2.0.0'});
 ok(await c.run('world','pack',offline,'--output',join(c.root,'offline.tar.zst')));
 r=ok(await c.run('world','add',join(c.root,'offline.tar.zst'),'--yes','--json','--no-session'));
 assert.equal(done(r.lines).sourceId,'file');assert.equal(done(r.lines).tag,null);
 assert.deepEqual(stages(r.lines).slice(0,4),['resolving','verifying','extracting','validating']);
 r=await c.run('world','add',join(c.root,'offline.tar.zst'),'--sha256','1'.repeat(64),'--yes','--json','--no-session');
 assert.equal(r.code,3);assert.equal(error(r.lines).rule,'hash.mismatch');
 ok(await c.run('world','remove','org.example.harbour','--no-session'));
 r=ok(await c.run('world','add',join(w2,'org.example.harbour-1.1.0.tar.zst'),'--yes','--json','--no-session'));
 assert.equal(done(r.lines).sourceId,'franks-worlds');assert.equal(done(r.lines).tag,'harbour-v1.1.0');
 // Legacy library install of a local archive keeps its output and needs no --yes.
 ok(await c.run('library','remove','org.example.street@1.1.0','--force','--no-session'));
 r=ok(await c.run('library','install',join(libOut,'org.example.street-1.1.0.tar.zst'),'--no-session'));
 assert.equal(r.out.trim(),'installed org.example.street@1.1.0');
 // registry check against the fake GitHub: every check passes for a maintainer.
 c.fake.repo('example-org','worlds').collaborators={frank:'write',mallory:'read'};
 await writeFile(join(c.root,'org.example.harbour.json'),JSON.stringify(harbour));
 await writeFile(join(c.root,'community.json'),JSON.stringify({indexVersion:'0.1',serial:1,generated:'2026-10-12T00:00:00Z',entries:[strip(street)]}));
 r=await c.run('registry','check',join(c.root,'org.example.harbour.json'),'--json','--author','frank','--indexes',join(c.root,'community.json'));
 const report=JSON.parse(r.out);
 assert.equal(r.code,0,JSON.stringify(report.results.filter(x=>!x.ok)));
 assert.deepEqual([...new Set(report.results.map(x=>x.check))],[1,2,3,4,5,6,7,8,9,10,11,12,13,14]);
 r=await c.run('registry','check',join(c.root,'org.example.harbour.json'),'--json','--author','mallory');
 assert.equal(r.code,1);assert.match(JSON.stringify(JSON.parse(r.out).results.find(x=>x.check===2).errors),/no write access/);
 // A token without push access gets 403 on collaborator permissions: the repository owner
 // and whoever created every new release still count as maintainers; nobody else does.
 const restricted=c.fake.repo('example-org','worlds');restricted.restricted=true;
 const check2=async(author)=>{const x=await c.run('registry','check',join(c.root,'org.example.harbour.json'),'--json','--author',author);return JSON.parse(x.out).results.find(y=>y.check===2);};
 assert.equal((await check2('example-org')).ok,true);
 assert.match(JSON.stringify((await check2('frank')).errors),/no write access/);
 for(const rel of restricted.releases) rel.author='frank';
 assert.equal((await check2('frank')).ok,true,'the release author');
 restricted.restricted=false;
});

test('library installs are handed to core with a session (libraries.install), else committed by the CLI',async t=>{
 const c=await context(t);
 const v1=await releaseLibrary(c,'1.0.0');c.fake.repo(OWNER,REPO);c.fake.publish(OWNER,REPO,'v1.0.0',v1.out);
 ok(await c.run('source','add',`github:${OWNER}/${REPO}`));
 const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];
 const daemon=new MockDaemon({socket:join(c.root,'control.sock'),scenario,protocol:'0.22',objectDir:join(c.root,'objects')});await daemon.start();t.after(()=>daemon.stop());
 const withToken=(args,caps)=>new Promise((resolve,reject)=>{
  const token=daemon.issueToken('org.example.cli',caps);
  const child=spawn(process.execPath,['dist/src/cli.js',...args],{stdio:['ignore','pipe','pipe','pipe'],
   env:{...c.env,HYPRUNE_SOCKET:daemon.path,HYPRUNE_CLIENT_ID:'org.example.cli',HYPRUNE_TOKEN_FD:'3'}});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(token+'\n');let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.on('close',code=>resolve({code,out,err,lines:out.trim().split('\n').filter(l=>l.startsWith('{')).map(l=>{try {return JSON.parse(l);} catch {return {};}})}));child.on('error',reject);
 });
 let r=await withToken(['library','add',LIB,'--yes','--json','--verbose'],['state.read','objects.control']);
 assert.equal(r.code,0,r.err);assert.match(r.err,/libraries through core/);
 assert.equal(done(r.lines).action,'install');
 assert.ok(!existsSync(join(c.libraries,`${LIB}@1.0.0`)),'core installed it (the mock keeps it in memory)');
 r=await withToken(['library','list','--json'],['state.read']);
 assert.ok(JSON.parse(r.out).libraries.some(l=>l.id===LIB && l.version==='1.0.0'));
 assert.equal((await c.content())[0].tag,'v1.0.0','the CLI records the install');
 // Remove through core.
 r=await withToken(['library','remove',LIB,'--json'],['state.read','objects.control']);
 assert.equal(r.code,0,r.err);
 r=await withToken(['library','list','--json'],['state.read']);
 assert.ok(!JSON.parse(r.out).libraries.some(l=>l.id===LIB));
 // Without objects.control the CLI commits into the user library root itself.
 r=await withToken(['library','add',LIB,'--yes','--json','--verbose'],['state.read']);
 assert.equal(r.code,0,r.err);assert.match(r.err,/committed by the CLI/);
 assert.ok(existsSync(join(c.libraries,`${LIB}@1.0.0`,'library.json')));
});

test('world.active: the loaded world is never updated, rolled back or removed',async t=>{
 const c=await context(t);
 const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];
 const daemon=new MockDaemon({socket:join(c.root,'control.sock'),scenario,protocol:'0.22',objectDir:join(c.root,'objects')});await daemon.start();t.after(()=>daemon.stop());
 const loaded='com.hyprune.observatory';
 await mkdir(c.worlds,{recursive:true});
 await writeWorld(join(c.worlds,loaded),{id:loaded,version:'0.1.0'});
 const token=daemon.issueToken('org.example.cli',['state.read']);
 const r=await new Promise(resolve=>{
  const child=spawn(process.execPath,['dist/src/cli.js','world','remove',loaded,'--json'],{stdio:['ignore','pipe','pipe','pipe'],env:{...c.env,HYPRUNE_SOCKET:daemon.path,HYPRUNE_CLIENT_ID:'org.example.cli',HYPRUNE_TOKEN_FD:'3'}});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(token+'\n');let out='';child.stdout.on('data',b=>out+=b);child.on('close',code=>resolve({code,out}));
 });
 assert.equal(r.code,3);assert.equal(JSON.parse(r.out.trim()).error.rule,'world.active');
 assert.ok(existsSync(join(c.worlds,loaded,'world.json')));
});

// `hyprune builder` (RFC-0014 phase 1 as amended): world folders as git repositories, the
// Flat land starter, Make world on Save, Release as a tag (and push plus RFC-0015 assets with a
// remote), the sky, and the CLI's JSON lines. Core's part (placements and copies) is simulated
// by writing builder/project.json and objects/<id>/ the way editor mode does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {BuilderError,changeSummary,compareVersions,createProject,listProjects,parseRemote,projectFolder,publishedId,readProject,release,save,setRemote,setSky,slugify,status}
 from '../dist/src/builder.js';
import {validateWorld} from '../dist/src/world.js';
import {encodePng} from '../dist/src/pixels.js';
import {equirectDirection} from '../dist/src/starter.js';

const FIXTURES=new URL('./fixtures/builder/',import.meta.url).pathname;
const CLI=new URL('../dist/src/cli.js',import.meta.url).pathname;
const ME={name:'Test Builder',email:'builder@example.com'};
// No global or system git configuration: identity comes only from the folder.
const empty=mkdtempSync(join(tmpdir(),'hyprune-gitcfg-'));writeFileSync(join(empty,'config'),'');
Object.assign(process.env,{GIT_CONFIG_GLOBAL:join(empty,'config'),GIT_CONFIG_NOSYSTEM:'1'});
const gitIn=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
const code=c=>e=>e instanceof BuilderError && e.code===c;
function root(t) {const dir=mkdtempSync(join(tmpdir(),'hyprune-projects-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
// What core does on objects.place in editor mode: copy the directory once, record the placement.
function place(folder,asset,placement) {
 if(!existsSync(join(folder,'objects',asset))) cpSync(join(FIXTURES,asset),join(folder,'objects',asset),{recursive:true});
 const project=JSON.parse(readFileSync(join(folder,'builder/project.json'),'utf8'));
 project.placements.push({ref:`world/${asset}`,scale:1,...placement});
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(project,null,2)+'\n');
}

test('slugs, remotes, published ids and versions',()=>{
 assert.equal(slugify('Harbour Plaza!'),'harbour-plaza');
 assert.equal(slugify('  Café  Été '),'cafe-ete');
 assert.equal(slugify('42 rooms'),'world-42-rooms');
 assert.equal(slugify('!!!'),'world');
 assert.deepEqual(parseRemote('git@github.com:Ada/hyprune-world-tidepool.git'),{url:'git@github.com:Ada/hyprune-world-tidepool.git',kind:'github',owner:'Ada',repo:'Ada/hyprune-world-tidepool'});
 assert.equal(parseRemote('https://github.com/ada/tidepool').kind,'github');
 assert.equal(parseRemote('ssh://git@git.example.org:2222/me/world.git').kind,'other');
 for(const bad of ['/srv/git/world.git','file:///tmp/x','--upload-pack=evil','https://github.com/a b','ext::sh -c id'])
  assert.throws(()=>parseRemote(bad),code('remote.invalid'),bad);
 assert.equal(publishedId('Ada/hyprune-world-tidepool'),'io.github.ada.tidepool');
 assert.equal(publishedId('ada/Harbour_Plaza'),'io.github.ada.harbour-plaza');
 assert.ok(compareVersions('0.2.0','0.1.9')>0 && compareVersions('1.0.0-rc.1','1.0.0')<0 && compareVersions('1.0.0-rc.2','1.0.0-rc.10')<0);
 assert.equal(changeSummary(null,{placements:[{id:'u-000001'}],sky:{}}),'placed 1 object');
 // Core rewrites the project file with sorted keys and float formatting: not a change.
 const pose={position:[1,0,2],rotation:[0,0,0,1]};
 assert.equal(changeSummary({name:'a',placements:[{id:'u-000001',pose,scale:1}],sky:{image:'s',license:'CC0-1.0',author:'a',source:'b'}},
  {name:'a',placements:[{id:'u-000001',pose:{rotation:[0,0,0,1],position:[1,0,2]},scale:1.0}],sky:{author:'a',image:'s',license:'CC0-1.0',source:'b'}}),'');
});

test('create: a git repository with the Flat land starter, made and saved once',async t=>{
 const dir=root(t);
 await assert.rejects(createProject('No identity',{root:dir}),code('git.identity'));
 assert.ok(!existsSync(join(dir,'no-identity')),'a failed create leaves no folder');
 const c=await createProject('Harbour Plaza',{root:dir,identity:ME});
 assert.deepEqual([c.projectId,c.worldId,c.folder],['harbour-plaza','local.harbour-plaza',join(dir,'harbour-plaza')]);
 assert.equal(readProject(c.folder).id,'local.harbour-plaza');
 assert.equal((await createProject('Harbour plaza',{root:dir,identity:ME})).projectId,'harbour-plaza-2');
 assert.equal(gitIn(c.folder,'log','--format=%s'),'Create Harbour Plaza from the Flat land starter');
 assert.equal(gitIn(c.folder,'status','--porcelain'),'');
 const files=gitIn(c.folder,'ls-files').split('\n').sort();
 assert.deepEqual(files,['.gitattributes','.gitignore','ATTRIBUTION.md','LICENSE','builder/base.json','builder/project.json','sky/panorama.jpg','starter/land.glb','world.json']);
 const world=JSON.parse(readFileSync(join(c.folder,'world.json'),'utf8'));
 assert.equal(world.formatVersion,'0.11');assert.equal(world.license,'CC0-1.0');
 assert.deepEqual(world.playable.volumes[0],{type:'box',min:[-1000,-50,-1000],max:[1000,500,1000]});
 assert.equal(world.atmosphere.panorama.image,'sky/panorama.jpg');
 assert.equal(world.attribution[0].author,'unknown','no git user.name: never the project name');
 // The git directory isn't part of the package; a copy of the tracked files validates.
 const pkg=mkdtempSync(join(tmpdir(),'hyprune-pkg-'));t.after(()=>rmSync(pkg,{recursive:true,force:true}));
 execFileSync('sh',['-c','git -C "$1" archive HEAD | tar -x -C "$2"','sh',c.folder,pkg]);
 assert.ok(!existsSync(join(pkg,'.gitignore')) && !existsSync(join(pkg,'.gitattributes')),'export-ignore');
 const checked=await validateWorld(pkg);
 assert.equal(checked.manifest.id,'local.harbour-plaza');
 const s=status(c.folder);
 assert.deepEqual([s.pending.total,s.lastVersion,s.suggestedVersion,s.remote,s.identity],[0,null,'0.1.0',null,ME]);
 assert.deepEqual(listProjects(dir).map(p=>p.projectId),['harbour-plaza','harbour-plaza-2']);
 assert.equal(projectFolder('local.harbour-plaza',dir),c.folder);
 assert.equal(projectFolder('harbour-plaza',dir),c.folder);
 assert.throws(()=>projectFolder('local.nowhere',dir),code('project.unknown'));
});

test('save: Make world (objects, screens as homes, provenance) and one commit per save',async t=>{
 const dir=root(t),{folder}=await createProject('Quay',{root:dir,identity:ME});
 await assert.rejects(save(folder),code('save.nothing'));
 place(folder,'barrel',{id:'u-0000a1',pose:{position:[2,0,-3],rotation:[0,0,0,1]}});
 // A wall screen 4 m ahead, turned to face +X, bound to workspace 21 (slot 01).
 const q=[0,Math.SQRT1_2,0,Math.SQRT1_2];
 place(folder,'workspace-screen-wall-16x9',{id:'u-0000a2',pose:{position:[0,1.5,-4],rotation:q},workspace:21});
 // Per file: the two copied directories (4 + 3 files) and the project file; in words from the project.
 assert.deepEqual(status(folder).pending,{added:7,modified:1,deleted:0,total:8});
 assert.equal(status(folder).changes,'placed 2 objects');
 const first=await save(folder);
 assert.match(first.message,/^Save \d{4}-\d\d-\d\d \d\d:\d\d · placed 2 objects$/);
 assert.deepEqual(first.homes,[{slot:'01',workspace:21,placement:'u-0000a2'}]);
 assert.equal(status(folder).pending.total,0);
 const world=JSON.parse(readFileSync(join(folder,'world.json'),'utf8'));
 assert.deepEqual(world.objectAssets,[{id:'barrel',dir:'objects/barrel'},{id:'workspace-screen-wall-16x9',dir:'objects/workspace-screen-wall-16x9'}]);
 assert.deepEqual(world.objects.map(o=>[o.id,o.asset,o.locked]),[['u-0000a1','barrel',true],['u-0000a2','workspace-screen-wall-16x9',true]]);
 const anchor=world.anchors.find(a=>a.id==='screen-01');
 assert.deepEqual(anchor.pose.position,[0.06,1.5,-4],'the anchor offset turned with the screen');
 assert.deepEqual([anchor.size,anchor.screenType,anchor.mount],[[3.2,1.8],'com.hyprune.window',{type:'hanging-wall',role:'mounted-workspace',interaction:'focus-in'}]);
 assert.deepEqual(world.areas,[{id:'screen-01',workspaceSlot:'01',primaryAnchor:'screen-01',toolAnchors:[],dataAnchors:[],theme:'Wall screen 16:9',spawnId:'home-01'}]);
 const home=world.spawns.find(s=>s.id==='home-01');
 assert.deepEqual(home.pose.position,[2.844,0,-4],'2.5 m or 0.87 x width in front of the screen, on the land');
 // Facing -X, towards the screen: -Z turned +90 degrees about +Y.
 assert.deepEqual(home.pose.rotation,[0,0.7071,0,0.7071]);
 assert.equal(world.license,'CC0-1.0 AND CC-BY-4.0');
 assert.deepEqual(world.attribution.map(a=>a.path),['.','starter/land.glb','sky/panorama.jpg','objects/barrel/import.json','objects/barrel/object.glb','objects/barrel/object.json',
  'objects/barrel/thumbnail.png','objects/workspace-screen-wall-16x9/object.glb','objects/workspace-screen-wall-16x9/object.json','objects/workspace-screen-wall-16x9/thumbnail.png'],'per file, as core resolves them');
 assert.match(readFileSync(join(folder,'ATTRIBUTION.md'),'utf8'),/objects\/workspace-screen-wall-16x9` \| Hyprune contributors \| CC-BY-4.0/);
 // The second save: move the barrel, unbind nothing; a user message.
 const project=readProject(folder);project.placements[0].pose.position=[3,0,-3];
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(project,null,2)+'\n');
 const second=await save(folder,'Move the barrel');
 assert.equal(second.message,'Move the barrel');
 assert.deepEqual(gitIn(folder,'log','--format=%s').split('\n'),['Move the barrel',first.message,'Create Quay from the Flat land starter']);
 assert.deepEqual(JSON.parse(readFileSync(join(folder,'world.json'),'utf8')).objects[0].pose.position,[3,0,-3]);
 // A screen on a workspace at or under the room's can't be a home: a prop, with a warning.
 const p2=readProject(folder);p2.placements[1].workspace=20;
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(p2,null,2)+'\n');
 const third=await save(folder);
 assert.match(third.message,/changed 1 workspace$/);
 assert.ok(third.warnings.some(w=>/workspace 20 is not above 20/.test(w)));
 assert.equal(JSON.parse(readFileSync(join(folder,'world.json'),'utf8')).anchors,undefined);
 // A placement whose copy is missing refuses the save and commits nothing.
 const p3=readProject(folder);p3.placements.push({id:'u-0000a3',ref:'world/lost',pose:{position:[0,0,0],rotation:[0,0,0,1]},scale:1});
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(p3,null,2)+'\n');
 await assert.rejects(save(folder),code('make.invalid'));
 assert.equal(gitIn(folder,'rev-list','--count','HEAD'),'4');
});

test('release: a tag without a remote; push and RFC-0015 assets built from the tag with one',async t=>{
 const dir=root(t),{folder}=await createProject('Tide Pool',{root:dir,identity:ME});
 place(folder,'barrel',{id:'u-0000b1',pose:{position:[0,0,-5],rotation:[0,0,0,1]}});
 await assert.rejects(release(folder),code('release.unsaved'));
 await save(folder);
 const first=await release(folder,{notes:'First version'});
 assert.deepEqual([first.version,first.tag,first.pushed,first.assets],['0.1.0','v0.1.0',false,[]]);
 assert.equal(gitIn(folder,'tag','-l','-n1','v0.1.0').replace(/\s+/g,' '),'v0.1.0 First version');
 assert.equal(gitIn(folder,'cat-file','-t','v0.1.0'),'tag','annotated');
 await assert.rejects(release(folder,{version:'0.1.0'}),code('release.version'));
 await assert.rejects(release(folder,{version:'0.0.9'}),code('release.version'));
 await assert.rejects(release(folder,{version:'1.0'}),code('release.version'));
 const s=status(folder);
 assert.deepEqual([s.lastVersion.tag,s.suggestedVersion,s.pending.total],['v0.1.0','0.1.1',0]);
 // A remote that isn't GitHub needs a published id; local. ids are never published.
 const bare=mkdtempSync(join(tmpdir(),'hyprune-remote-'));t.after(()=>rmSync(bare,{recursive:true,force:true}));
 gitIn(bare,'init','-q','--bare');
 gitIn(folder,'remote','add','origin','https://example.org/ada/tide-pool.git');
 assert.deepEqual(status(folder).remote,{name:'origin',url:'https://example.org/ada/tide-pool.git',kind:'other',repo:null});
 await assert.rejects(release(folder),code('release.id'));
 await assert.rejects(release(folder,{id:'local.tide-pool'}),code('release.id'));
 // Push to a local bare repository (the record still names the https URL).
 gitIn(folder,'remote','set-url','--push','origin',bare);
 const stages=[];
 const r=await release(folder,{id:'org.example.tidepool',onStage:s=>stages.push(s)});
 assert.deepEqual(stages,['version','build','push']);
 assert.deepEqual([r.version,r.worldId,r.pushed,r.release],['0.1.1','org.example.tidepool',true,null]);
 assert.ok(r.warnings.some(w=>/not GitHub/.test(w)));
 assert.equal(gitIn(folder,'log','-1','--format=%s'),'Release v0.1.1');
 assert.equal(gitIn(bare,'rev-parse','v0.1.1^{commit}'),r.commit);
 assert.equal(gitIn(bare,'rev-parse','main'),r.commit);
 const names=r.assets.map(a=>a.slice(a.lastIndexOf('/')+1));
 assert.deepEqual(names,['org.example.tidepool-0.1.1.tar.zst','org.example.tidepool-0.1.1.tar.zst.sha256','org.example.tidepool-0.1.1.release.json']);
 const record=JSON.parse(readFileSync(r.assets[2],'utf8'));
 assert.deepEqual(record.source,{repo:'https://example.org/ada/tide-pool',tag:'v0.1.1',commit:r.commit});
 assert.equal(record.license,'CC0-1.0');
 const listing=execFileSync('tar',['--zstd','-tf',r.assets[0]],{encoding:'utf8'}).split('\n').filter(Boolean);
 assert.ok(listing.includes('org.example.tidepool/builder/project.json'),'a released world can be built on again');
 assert.ok(!listing.some(f=>/\.git(ignore|attributes)?(\/|$)|releases\//.test(f)),listing.join(' '));
 assert.equal(status(folder).pending.total,0,'releases/ is ignored');
 assert.equal(JSON.parse(readFileSync(join(folder,'builder/base.json'),'utf8')).id,'org.example.tidepool');
 // Rejected push: the remote has a commit the folder lacks. The local tag stays, and the
 // push is atomic, so the tag doesn't reach the remote either.
 const other=mkdtempSync(join(tmpdir(),'hyprune-other-'));t.after(()=>rmSync(other,{recursive:true,force:true}));
 gitIn(other,'clone','-q','-b','main',bare,'.');gitIn(other,'-c','user.name=x','-c','user.email=x@example.com','commit','-q','--allow-empty','-m','elsewhere');gitIn(other,'push','-q','origin','main');
 await assert.rejects(release(folder,{id:'org.example.tidepool'}),code('remote.rejected'));
 assert.equal(gitIn(folder,'tag','-l','v0.1.2'),'v0.1.2');
 assert.equal(spawnSync('git',['-C',bare,'rev-parse','-q','--verify','v0.1.2']).status,1);
 // setRemote validates; clear removes it.
 assert.throws(()=>setRemote(folder,'file:///tmp/x'),code('remote.invalid'));
 assert.equal(setRemote(folder,'git@github.com:ada/hyprune-world-tide-pool.git').kind,'github');
 assert.equal(setRemote(folder,null),null);
});

test('sky: a 2:1 image becomes sky/panorama.jpg with its provenance and sun',async t=>{
 const dir=root(t),{folder}=await createProject('Dusk',{root:dir,identity:ME});
 const w=1024,h=512,data=new Uint8Array(w*h*4).fill(90);
 // A sun at u 0.75 (towards +X), 30 degrees up.
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=(y*w+x)*4;data[o+3]=255;if(Math.hypot(x-768,y-(h/2-h/6))<5)data.fill(255,o,o+3);}
 const image=join(dir,'sky.png');writeFileSync(image,encodePng({width:w,height:h,data}));
 await assert.rejects(setSky(folder,image,{license:'CC0-1.0',author:'',source:'mine'}),code('sky.invalid'));
 await assert.rejects(setSky(folder,image,{license:'not a licence',author:'Me',source:'mine'}),code('sky.invalid'));
 writeFileSync(join(dir,'square.png'),encodePng({width:1024,height:1024,data:new Uint8Array(1024*1024*4)}));
 await assert.rejects(setSky(folder,join(dir,'square.png'),{license:'CC0-1.0',author:'Me',source:'mine'}),code('sky.invalid'));
 const r=await setSky(folder,image,{license:'CC-BY-4.0',author:'Me',source:'https://example.com/dusk'});
 const want=equirectDirection(768.5/w,(h/2-h/6+0.5)/h);
 assert.ok(r.sun.every((v,i)=>Math.abs(v-want[i])<0.03),JSON.stringify([r.sun,want]));
 assert.equal(readFileSync(join(folder,'sky/panorama.jpg'))[0],0xff,'normalised to JPEG');
 assert.deepEqual(readProject(folder).sky,{image:'sky/panorama.jpg',license:'CC-BY-4.0',author:'Me',source:'https://example.com/dusk'});
 const saved=await save(folder);
 assert.match(saved.message,/changed the sky/);
 const world=JSON.parse(readFileSync(join(folder,'world.json'),'utf8'));
 assert.deepEqual(world.atmosphere.sky.sun.direction,r.sun);
 assert.deepEqual(world.attribution.find(a=>a.path==='sky/panorama.jpg'),{path:'sky/panorama.jpg',author:'Me',license:'CC-BY-4.0',source:'https://example.com/dusk'});
});

test('CLI: JSON lines for the Director',async t=>{
 const dir=root(t),env={...process.env,HYPRUNE_PROJECTS_DIR:dir};
 const cli=(...args)=>spawnSync(process.execPath,[CLI,'builder',...args,'--json'],{env,encoding:'utf8'});
 const lines=r=>r.stdout.trim().split('\n').map(l=>JSON.parse(l));
 const created=lines(cli('create','Market Square','--git-name','Ada','--git-email','ada@example.com'));
 assert.equal(created.at(-1).event,'done');
 assert.equal(created.at(-1).result.status.identity.name,'Ada');
 assert.deepEqual(lines(cli('save','local.market-square')).at(-1),{event:'error',error:{message:'Nothing to save: there are no changes since the last save',code:'save.nothing'}});
 const list=lines(cli('list')).at(-1).result.projects;
 assert.deepEqual(list.map(p=>[p.projectId,p.worldId,p.name,p.version]),[['market-square','local.market-square','Market Square','0.1.0']]);
 const rel=lines(cli('release','market-square','--notes','hello'));
 assert.deepEqual(rel.map(l=>l.event),['stage','done']);
 assert.equal(rel.at(-1).result.status.lastVersion.tag,'v0.1.0');
 const bad=cli('status','local.nowhere');
 assert.equal(bad.status,1);assert.equal(lines(bad)[0].error.code,'project.unknown');
});

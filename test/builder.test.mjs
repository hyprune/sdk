// `hyprune builder` (RFC-0014 phase 1 as amended): world folders as git repositories, the
// Open Plain starter (the world wizard: sky, floor, spawn), Make world on Save, Release as a tag (and push plus RFC-0015 assets with a
// remote), the sky, and the CLI's JSON lines. Core's part (placements and copies) is simulated
// by writing builder/project.json and objects/<id>/ the way editor mode does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {BuilderError,applyFloor,applySky,applySpawn,changeSummary,compareVersions,createProject,listFloors,listProjects,listSkies,listStarters,parseRemote,projectFolder,publishedId,
 readProject,release,save,setRemote,setSky,slugify,status} from '../dist/src/builder.js';
import {decodeHdr,hdrSun,toneMap} from '../dist/src/hdr.js';
import {SKY_PRESETS,FLOOR_PRESETS,skyPanorama} from '../dist/src/presets.js';
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

test('create: a git repository with the Open Plain starter, made and saved once',async t=>{
 const dir=root(t);
 await assert.rejects(createProject('No identity',{root:dir}),code('git.identity'));
 assert.ok(!existsSync(join(dir,'no-identity')),'a failed create leaves no folder');
 const c=await createProject('Harbour Plaza',{root:dir,identity:ME});
 assert.deepEqual([c.projectId,c.worldId,c.folder],['harbour-plaza','local.harbour-plaza',join(dir,'harbour-plaza')]);
 assert.equal(readProject(c.folder).id,'local.harbour-plaza');
 assert.equal((await createProject('Harbour plaza',{root:dir,identity:ME})).projectId,'harbour-plaza-2');
 assert.equal(gitIn(c.folder,'log','--format=%s'),'Create Harbour Plaza from the Open Plain starter');
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
 assert.deepEqual(world.areas,[{id:'screen-01',workspaceSlot:'01',primaryAnchor:'screen-01',toolAnchors:[],dataAnchors:[],theme:'Wall screen 16:9',spawnId:'home-01',freePlacementZones:['zone-01']}],'with the window zone beyond the standback');
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
 assert.deepEqual(gitIn(folder,'log','--format=%s').split('\n'),['Move the barrel',first.message,'Create Quay from the Open Plain starter']);
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
 assert.deepEqual(stages,['check','version','build','push']);
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
 assert.deepEqual(readProject(folder).sky,{image:'sky/panorama.jpg',preset:null,license:'CC-BY-4.0',author:'Me',source:'https://example.com/dusk'});
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
 assert.deepEqual(rel.map(l=>l.event),['stage','stage','done'],'check, then version');
 assert.equal(rel.at(-1).result.status.lastVersion.tag,'v0.1.0');
 const bad=cli('status','local.nowhere');
 assert.equal(bad.status,1);assert.equal(lines(bad)[0].error.code,'project.unknown');
});

// ---- the world wizard (RFC-0014 amendment): Open Plain, preset skies and floors, spawn ----
const glbImageMime=folder=>{
 const b=readFileSync(join(folder,'starter/land.glb')),len=b.readUInt32LE(12),json=JSON.parse(b.subarray(20,20+len).toString());
 return json.images[0].mimeType;
};
test('wizard: presets, a spawn facing the sun, dry run, if-exists and clear errors',async t=>{
 const dir=root(t);
 assert.deepEqual(listStarters().map(s=>s.id),['open-plain@0.2']);
 const plan=await createProject('Rooftop',{root:dir,identity:ME,sky:{preset:'sunset'},floor:{preset:'grass'},spawn:{facing:'sun'},dryRun:true});
 assert.equal(plan.dryRun,true);assert.equal(plan.projectId,'rooftop');assert.equal(plan.sky.preset,'sunset');assert.equal(plan.floor.tile,4);
 assert.ok(!existsSync(join(dir,'rooftop')),'a dry run writes nothing');
 const c=await createProject('Rooftop',{root:dir,identity:ME,sky:{preset:'sunset'},floor:{preset:'grass',tile:3},spawn:{position:[2,0,-3],facing:'sun'}});
 const project=readProject(c.folder),base=JSON.parse(readFileSync(join(c.folder,'builder/base.json'),'utf8'));
 assert.deepEqual([project.projectVersion,project.starter,project.sky.preset,project.floor.preset,project.floor.tile,project.floor.image],['0.2','open-plain@0.2','sunset','grass',3,null]);
 const sunset=SKY_PRESETS.find(p=>p.id==='sunset');
 assert.deepEqual(base.atmosphere.sky.horizon,sunset.horizon);assert.equal(base.atmosphere.exposure,sunset.exposure);
 assert.equal(glbImageMime(c.folder),'image/jpeg');
 // Facing the sun: the heading (0 faces -Z, +yaw turns right, as core's camera) points at the sun across the ground.
 const s=status(c.folder),yaw=s.spawn.yaw*Math.PI/180,view=[Math.sin(yaw),-Math.cos(yaw)],sun=sunset.sun.direction,l=Math.hypot(sun[0],sun[2]);
 assert.ok(Math.abs(view[0]-sun[0]/l)<1e-3 && Math.abs(view[1]-sun[2]/l)<1e-3,JSON.stringify([view,sun]));
 assert.deepEqual(s.spawn.position,[2,0,-3]);assert.equal(s.starter,'open-plain@0.2');assert.equal(s.floor.preset,'grass');
 const world=JSON.parse(readFileSync(join(c.folder,'world.json'),'utf8'));
 assert.ok(world.attribution.some(a=>a.path==='starter/land.glb' && a.license==='CC0-1.0'));
 await assert.rejects(createProject('Rooftop',{root:dir,identity:ME,ifExists:'error'}),e=>code('project.exists')(e) && e.data.projectId==='rooftop');
 await assert.rejects(createProject('Nope',{root:dir,identity:ME,sky:{preset:'mars'}}),e=>code('sky.invalid')(e) && /clear-day/.test(e.hint));
 await assert.rejects(createProject('Nope',{root:dir,identity:ME,floor:{preset:'lava'}}),e=>code('floor.invalid')(e) && /grass/.test(e.hint));
 await assert.rejects(createProject('Nope',{root:dir,identity:ME,floor:{preset:'grass',tile:0.1}}),code('floor.invalid'));
 await assert.rejects(createProject('Nope',{root:dir,identity:ME,spawn:{position:[5000,0,0]}}),code('spawn.invalid'));
 await assert.rejects(createProject('Nope',{root:dir,identity:ME,starter:'desert'}),code('starter.unknown'));
 assert.ok(!existsSync(join(dir,'nope')),'refused input leaves no folder');
});

test('floor: the user\'s texture with provenance, re-tiling, back to a preset',async t=>{
 const dir=root(t),{folder}=await createProject('Yard',{root:dir,identity:ME});
 const w=256,data=new Uint8Array(w*w*4);for(let i=0;i<w*w;i++){data[i*4]=(i*7)&255;data[i*4+1]=120;data[i*4+2]=60;data[i*4+3]=255;}
 const image=join(dir,'tiles.png');writeFileSync(image,encodePng({width:w,height:w,data}));
 await assert.rejects(applyFloor(folder,{image,license:'CC0-1.0',author:'',source:'mine'}),code('floor.invalid'));
 const dry=await applyFloor(folder,{image,license:'CC-BY-4.0',author:'Ada',source:'https://example.com/tiles',tile:1.5},{dryRun:true});
 assert.equal(dry.dryRun,true);assert.ok(!existsSync(join(folder,'floor')));
 const r=await applyFloor(folder,{image,license:'CC-BY-4.0',author:'Ada',source:'https://example.com/tiles',tile:1.5});
 assert.deepEqual(r.floor,{preset:null,image:'floor/texture.jpg',tile:1.5,license:'CC-BY-4.0',author:'Ada',source:'https://example.com/tiles'});
 assert.equal(readFileSync(join(folder,'floor/texture.jpg'))[0],0xff);
 assert.equal((await applyFloor(folder,{tile:3})).floor.tile,3);
 assert.equal(readProject(folder).floor.image,'floor/texture.jpg','re-tiling keeps the image');
 const saved=await save(folder);assert.match(saved.message,/changed the floor/);
 const world=JSON.parse(readFileSync(join(folder,'world.json'),'utf8'));
 for(const path of ['starter/land.glb','floor/texture.jpg'])
  assert.deepEqual(world.attribution.find(a=>a.path===path),{path,author:'Ada',license:'CC-BY-4.0',source:'https://example.com/tiles'},path);
 assert.match(world.license,/CC-BY-4.0/);
 await applyFloor(folder,{preset:'paving'});
 assert.ok(!existsSync(join(folder,'floor')),'a preset again removes the old image');
 assert.equal(readProject(folder).floor.tile,4);
});

test('sky presets and spawn edits; a 0.1 folder upgrades to 0.2 when it needs to',async t=>{
 const dir=root(t),{folder}=await createProject('Night',{root:dir,identity:ME});
 // Write the folder back as projectVersion 0.1 (made before the wizard).
 const old=readProject(folder);delete old.floor;delete old.sky.preset;
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify({...old,projectVersion:'0.1',starter:'flat-land@0.1'},null,2));
 assert.equal(readProject(folder).projectVersion,'0.1');
 const dry=await applySky(folder,{preset:'night'},{dryRun:true});
 assert.equal(dry.dryRun,true);assert.equal(readProject(folder).projectVersion,'0.1');
 await applySky(folder,{preset:'night'});
 const p=readProject(folder);
 assert.deepEqual([p.projectVersion,p.starter,p.sky.preset,p.sky.license],['0.2','flat-land@0.1','night','CC0-1.0']);
 const r=await applySpawn(folder,{position:[10,0,10],yaw:90});
 assert.deepEqual([r.position,r.yaw],[[10,0,10],90]);
 assert.deepEqual(status(folder).spawn,{position:[10,0,10],yaw:90});
 await assert.rejects(applySpawn(folder,{facing:'up'}),code('spawn.invalid'));
 // Every preset sky makes a valid world.
 for(const sky of SKY_PRESETS) {await applySky(folder,{preset:sky.id});await save(folder,'sky '+sky.id);}
 assert.equal(gitIn(folder,'log','-1','--format=%s'),'sky night');
});

// A minimal uncompressed OpenEXR (FLOAT B, G, R) and an RLE Radiance HDR, written for the tests.
function exrFile(w,h,pixel) {
 const parts=[],str=s=>Buffer.from(s+'\0','latin1'),i32=v=>{const b=Buffer.alloc(4);b.writeInt32LE(v);return b;},f32=v=>{const b=Buffer.alloc(4);b.writeFloatLE(v);return b;};
 const attr=(name,type,value)=>parts.push(str(name),str(type),i32(value.length),value);
 const chan=n=>Buffer.concat([str(n),i32(2),Buffer.from([0,0,0,0]),i32(1),i32(1)]);
 parts.push(Buffer.from([0x76,0x2f,0x31,0x01,2,0,0,0]));
 attr('channels','chlist',Buffer.concat([chan('B'),chan('G'),chan('R'),Buffer.from([0])]));
 attr('compression','compression',Buffer.from([0]));
 const box=Buffer.concat([i32(0),i32(0),i32(w-1),i32(h-1)]);
 attr('dataWindow','box2i',box);attr('displayWindow','box2i',box);attr('lineOrder','lineOrder',Buffer.from([0]));
 attr('pixelAspectRatio','float',f32(1));attr('screenWindowCenter','v2f',Buffer.concat([f32(0),f32(0)]));attr('screenWindowWidth','float',f32(1));
 parts.push(Buffer.from([0]));
 const header=Buffer.concat(parts),lineBytes=8+w*3*4,table=Buffer.alloc(8*h);
 for(let y=0;y<h;y++) table.writeBigUInt64LE(BigInt(header.length+8*h+y*lineBytes),y*8);
 const lines=[];
 for(let y=0;y<h;y++){const b=Buffer.alloc(lineBytes);b.writeInt32LE(y,0);b.writeInt32LE(w*12,4);
  for(let x=0;x<w;x++){const [r,g,bl]=pixel(x,y);b.writeFloatLE(bl,8+x*4);b.writeFloatLE(g,8+(w+x)*4);b.writeFloatLE(r,8+(2*w+x)*4);}lines.push(b);}
 return Buffer.concat([header,table,...lines]);
}
function hdrFile(w,h,pixel) {
 const out=[Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`,'latin1')];
 const rgbe=([r,g,b])=>{const v=Math.max(r,g,b);if(v<1e-32)return [0,0,0,0];const e=Math.ceil(Math.log2(v))+(v===2**Math.ceil(Math.log2(v))?1:0),s=256/2**e;return [r*s,g*s,b*s,e+128].map(Math.floor);};
 for(let y=0;y<h;y++){
  const px=Array.from({length:w},(_,x)=>rgbe(pixel(x,y))),bytes=[2,2,w>>8,w&255];
  for(let c=0;c<4;c++){
   const ch=px.map(p=>p[c]);
   for(let x=0;x<w;){let run=1;while(x+run<w && run<127 && ch[x+run]===ch[x])run++;
    if(run>=4){bytes.push(128+run,ch[x]);x+=run;continue;}
    const start=x;let n=0;while(x<w && n<128){let r2=1;while(x+r2<w && r2<4 && ch[x+r2]===ch[x])r2++;if(r2>=4)break;x++;n++;}
    bytes.push(n,...ch.slice(start,start+n));}
  }
  out.push(Buffer.from(bytes));
 }
 return Buffer.concat(out);
}
test('HDR skies: OpenEXR and Radiance HDR decode top-down, the sun comes from linear data, tone mapped to sRGB',async t=>{
 const w=1024,h=512,sunX=256,sunY=Math.round(h/2-h/6);
 const pixel=(x,y)=>Math.hypot(x-sunX,y-sunY)<3?[2000,1900,1700]:y<h/2?[0.4,0.6,1.2]:[0.15,0.12,0.1];
 const want=equirectDirection((sunX+0.5)/w,(sunY+0.5)/h);
 for(const [kind,bytes] of [['exr',exrFile(w,h,pixel)],['hdr',hdrFile(w,h,pixel)]]) {
  const img=decodeHdr(new Uint8Array(bytes));
  assert.deepEqual([img.width,img.height],[w,h],kind);
  assert.ok(Math.abs(img.data[0]-0.4)<0.02 && img.data[((h-1)*w)*3]<0.2,`${kind}: row 0 is the top (${img.data[0]}, ${img.data[((h-1)*w)*3]})`);
  const sun=hdrSun(img);assert.ok(sun.every((v,i)=>Math.abs(v-want[i])<0.03),`${kind} ${JSON.stringify([sun,want])}`);
  const ldr=toneMap(img);assert.ok(ldr.data[2]>ldr.data[((h-1)*w)*4+2],kind);
 }
 const dir=root(t),{folder}=await createProject('Studio',{root:dir,identity:ME});
 const file=join(dir,'studio.exr');writeFileSync(file,exrFile(w,h,pixel));
 const r=await applySky(folder,{image:file,license:'CC0-1.0',author:'Me',source:'my own photo'});
 assert.ok(r.sun.every((v,i)=>Math.abs(v-want[i])<0.03));
 assert.equal(readFileSync(join(folder,'sky/panorama.jpg'))[0],0xff);
 const base=JSON.parse(readFileSync(join(folder,'builder/base.json'),'utf8'));
 assert.ok(base.atmosphere.sky.zenith[2]>base.atmosphere.sky.zenith[0],'sky colours estimated from the image');
 const bad=join(dir,'bad.exr');writeFileSync(bad,Buffer.from([0x76,0x2f,0x31,0x01,2,0,0,0,1,2,3]));
 await assert.rejects(applySky(folder,{image:bad,license:'CC0-1.0',author:'Me',source:'x'}),code('sky.invalid'));
});

test('presets: tileable floors, thumbnails cached, the CLI lists them and reports hints',async t=>{
 for(const f of FLOOR_PRESETS) {
  const img=f.texture(256),row=y=>Array.from({length:256},(_,x)=>img.data[(y*256+x)*4+1]);
  const diff=(a,b)=>a.reduce((s,v,i)=>s+Math.abs(v-b[i]),0)/a.length;
  // Opposite edges meet: the last row continues into the first about as smoothly as neighbours do.
  assert.ok(diff(row(255),row(0))<=diff(row(127),row(128))*2.5+6,`${f.id} tiles`);
 }
 const thumbs=mkdtempSync(join(tmpdir(),'hyprune-thumbs-'));t.after(()=>rmSync(thumbs,{recursive:true,force:true}));
 const skies=listSkies(thumbs),floors=listFloors(thumbs);
 assert.deepEqual(skies.map(s=>s.id),['clear-day','sunset','overcast','night']);
 assert.deepEqual(floors.map(f=>f.id),['grid','grass','sand','paving','concrete']);
 for(const c of [...skies,...floors]) assert.equal(readFileSync(c.thumbnail)[1],0x50,c.id);
 const dir=root(t),env={...process.env,HYPRUNE_PROJECTS_DIR:dir,XDG_CACHE_HOME:thumbs};
 const cli=(...args)=>spawnSync(process.execPath,[CLI,'builder',...args,'--json'],{env,encoding:'utf8'});
 const last=r=>JSON.parse(r.stdout.trim().split('\n').at(-1));
 assert.equal(last(cli('skies')).result.skies[1].id,'sunset');
 assert.ok(last(cli('floors')).result.floors[0].thumbnail.startsWith(thumbs));
 const made=last(cli('create','Garden','--sky','sunset','--floor','grass','--tile','5','--facing','left','--git-name','Ada','--git-email','ada@example.com'));
 assert.equal(made.result.status.floor.tile,5);assert.equal(made.result.status.sky.preset,'sunset');
 assert.equal(last(cli('create','Garden','--if-exists','error')).error.data.projectId,'garden');
 const nope=last(cli('floor','garden','--preset','lava'));
 assert.equal(nope.error.code,'floor.invalid');assert.match(nope.error.hint,/Floors: grid/);
 assert.equal(last(cli('spawn','garden','--at','1,0,1','--yaw','45')).result.yaw,45);
 assert.equal(last(cli('sky','garden','--preset','overcast','--dry-run')).result.dryRun,true);
 assert.equal(readProject(join(dir,'garden')).sky.preset,'sunset');
});

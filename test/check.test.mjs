// The builder's checklist (RFC-0014 Checklist and Approach checks): screen approaches, the
// walk grid flooded from the spawn, Make world's standbacks and window zones from it, Release
// refusing open blocking items (and --skip-check), the official-publishing check and the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createProject,make,release,save} from '../dist/src/builder.js';
import {checkProject} from '../dist/src/check.js';
import {plainMaterial,writePrimitive} from '../dist/src/primitives.js';

const FIXTURES=new URL('./fixtures/builder/',import.meta.url).pathname;
const CLI=new URL('../dist/src/cli.js',import.meta.url).pathname;
const ME={name:'Test Builder',email:'builder@example.com'};
const empty=mkdtempSync(join(tmpdir(),'hyprune-gitcfg-'));writeFileSync(join(empty,'config'),'');
Object.assign(process.env,{GIT_CONFIG_GLOBAL:join(empty,'config'),GIT_CONFIG_NOSYSTEM:'1'});
async function project(t,name) {
 const root=mkdtempSync(join(tmpdir(),'hyprune-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 process.env.HYPRUNE_PROJECTS_DIR=root;
 return (await createProject(name,{identity:ME})).folder;
}
function place(folder,asset,placement) {
 if(!existsSync(join(folder,'objects',asset))) cpSync(join(FIXTURES,asset),join(folder,'objects',asset),{recursive:true});
 const p=JSON.parse(readFileSync(join(folder,'builder/project.json'),'utf8'));
 p.placements.push({ref:`world/${asset}`,scale:1,...placement});
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(p,null,2)+'\n');
}
const prim=async(folder,spec)=>(await writePrimitive(join(folder,'objects'),'world',spec,plainMaterial({colour:'#808080'}))).id;
const item=(r,id,target)=>r.items.find(i=>i.id===id && (!target || i.target===target));
const SCREEN='workspace-screen-wall-16x9',FACING_SPAWN=[0,0,0,1];

test('approach: a clear screen passes; a wall in front blocks and is named; a lone screen warns',async t=>{
 const folder=await project(t,'Approach');
 place(folder,SCREEN,{id:'u-000001',key:'main',pose:{position:[0,1.5,-6],rotation:FACING_SPAWN},workspace:21});
 let r=await checkProject(folder);
 assert.equal(item(r,'screen.approach','u-000001').done,true,item(r,'screen.approach','u-000001').message);
 assert.equal(item(r,'spawn.floor').done,true);
 assert.equal(item(r,'walk.area').done,true);
 assert.equal(item(r,'screens.count').done,false);assert.equal(item(r,'screens.count').blocks,false);
 assert.equal(r.ready,true,'only non-blocking items open');
 const h=r.homes[0];
 assert.deepEqual([h.slot,h.workspace,h.standback,h.yaw,h.reachable],['01',21,[0,0,-3.156],0,true],'2.78 m in front, facing -Z (the screen)');
 const wall=await prim(folder,{shape:'box',size:[6,3,0.2]});
 place(folder,wall,{id:'u-000002',key:'wall',pose:{position:[0,0,-4.5],rotation:[0,0,0,1]}});
 r=await checkProject(folder);
 const a=item(r,'screen.approach','u-000001');
 assert.equal(a.done,false);assert.equal(a.blocks,true);
 assert.match(a.message,/\(wall\) stands in the space in front of it/);
 assert.doesNotMatch(a.message,/hides/,'a blocker is named once');
 assert.ok(a.hint && a.show.position.length===3);
 assert.equal(r.ready,false);
});

test('walk: a screen on a plinth is unreachable until a ramp joins it; a screen inside a wall is caught',async t=>{
 const folder=await project(t,'Plinth');
 const plinth=await prim(folder,{shape:'box',size:[6,2,6]});
 place(folder,plinth,{id:'u-000001',pose:{position:[15,0,0],rotation:[0,0,0,1]}});
 place(folder,SCREEN,{id:'u-000002',key:'high',pose:{position:[15,3.5,-2.9],rotation:FACING_SPAWN},workspace:22});
 let r=await checkProject(folder);
 assert.deepEqual(r.homes[0].standback,[15,2,-0.056],'the standback drops to the plinth top');
 assert.equal(r.homes[0].reachable,false);
 assert.equal(item(r,'walk.area').done,false);
 assert.match(item(r,'screen.approach','u-000002').message,/can't be reached from the spawn/);
 const ramp=await prim(folder,{shape:'ramp',size:[2,2,6]});
 place(folder,ramp,{id:'u-000003',pose:{position:[15,0,6],rotation:[0,0,0,1]}});
 r=await checkProject(folder);
 assert.equal(r.homes[0].reachable,true,'up the ramp');
 assert.equal(item(r,'walk.area').done,true);
 // Make world: the home spawn stands on the plinth, a window zone lies beyond it.
 const m=await make(folder);
 const spawn=m.manifest.spawns.find(s=>s.id==='home-02');
 assert.equal(spawn.pose.position[1],2);
 assert.deepEqual(m.manifest.areas[0].freePlacementZones,['zone-02']);
 const zone=m.manifest.placementZones[0];
 assert.equal(zone.id,'zone-02');assert.equal(zone.bounds.min[1],2.5);assert.ok(zone.bounds.min[2]>-0.06+0.4);
 // A second screen sunk into a wall.
 const wall=await prim(folder,{shape:'box',size:[8,4,0.4]});
 place(folder,wall,{id:'u-000004',key:'back-wall',pose:{position:[-10,0,-8],rotation:[0,0,0,1]}});
 place(folder,SCREEN,{id:'u-000005',key:'sunk',pose:{position:[-10,2,-8],rotation:FACING_SPAWN},workspace:23});
 r=await checkProject(folder);
 assert.match(item(r,'screen.approach','u-000005').message,/partly inside .*back-wall/);
});

test('release: refused with open blocking items, allowed with skipCheck; publishing and rights reported',async t=>{
 const folder=await project(t,'Release Check');
 place(folder,'barrel',{id:'u-000001',pose:{position:[0,0,0],rotation:[0,0,0,1]}}); // on the spawn
 await save(folder,'barrel on the spawn');
 let r=await checkProject(folder);
 assert.equal(item(r,'spawn.floor').done,false);
 assert.match(item(r,'spawn.floor').message,/blocks the space around the spawn/);
 await assert.rejects(release(folder),e=>e.code==='release.check' && e.data.items.some(i=>i.id==='spawn.floor') && /--skip-check/.test(e.hint));
 const done=await release(folder,{skipCheck:true});
 assert.equal(done.tag,'v0.1.0');
 assert.ok(done.warnings.some(w=>/open checklist item/.test(w)));
 const barrel=r.publishing.parts.find(p=>p.path==='objects/barrel');
 assert.ok(barrel,'the imported object is a part');
 assert.equal(done.publishing.officialEligible,r.publishing.officialEligible);
 assert.equal(item(r,'publish.official').blocks,false);assert.equal(item(r,'rights').blocks,false);
 assert.equal(item(r,'save').done,true,'saved');
 // The cache: same digest, same result; a change recomputes.
 const again=await checkProject(folder);
 assert.equal(again.checkedAt,r.checkedAt);
 const p=JSON.parse(readFileSync(join(folder,'builder/project.json'),'utf8'));p.placements[0].pose.position=[5,0,5];
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(p,null,2)+'\n');
 const moved=await checkProject(folder);
 assert.notEqual(moved.digest,r.digest);assert.equal(item(moved,'spawn.floor').done,true);assert.equal(item(moved,'save').done,false);
});

test('CLI: builder check --json gives the items; release --json reports release.check with the items',async t=>{
 const folder=await project(t,'Cli Check');
 place(folder,'barrel',{id:'u-000001',pose:{position:[0,0,0],rotation:[0,0,0,1]}});
 await save(folder,'');
 const cli=(...args)=>spawnSync(process.execPath,[CLI,'builder',...args,'--json'],{env:process.env,encoding:'utf8'});
 const last=r=>JSON.parse(r.stdout.trim().split('\n').at(-1));
 const c=last(cli('check',folder));
 assert.equal(c.event,'done');assert.equal(c.result.ready,false);
 assert.ok(c.result.items.every(i=>typeof i.id==='string' && typeof i.done==='boolean' && typeof i.message==='string'));
 const rel=last(cli('release',folder));
 assert.equal(rel.event,'error');assert.equal(rel.error.code,'release.check');assert.ok(rel.error.data.items.length>=1);
 assert.equal(last(cli('release',folder,'--skip-check')).event,'done');
});

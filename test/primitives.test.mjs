// Primitives and materials (RFC-0014 amendment): generated object directories (shape, size,
// box-mapped UVs in metres, a matching proxy, thumbnail, primitive.json), content-addressed ids,
// the material library (built-in textures, the user's textures with provenance, absolute
// patches), rebuilds after a material change, pruning on Save and the CLI's JSON lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PrimitiveError,SHAPES,DEFAULT_SIZES,checkSpec,listMaterials,plainMaterial,primitiveGeometry,primitiveId,readMaterial,resolveMaterial,setMaterial,
 stalePrimitives,writePrimitive} from '../dist/src/primitives.js';
import {createProject,readProject,save,prunePrimitives} from '../dist/src/builder.js';
import {validateObject} from '../dist/src/object.js';
import {validateManifest} from '../dist/src/validation.js';
import {encodePng} from '../dist/src/pixels.js';

const CLI=new URL('../dist/src/cli.js',import.meta.url).pathname;
const ME={name:'Test Builder',email:'builder@example.com'};
const empty=mkdtempSync(join(tmpdir(),'hyprune-gitcfg-'));writeFileSync(join(empty,'config'),'');
Object.assign(process.env,{GIT_CONFIG_GLOBAL:join(empty,'config'),GIT_CONFIG_NOSYSTEM:'1'});
const code=c=>e=>e instanceof PrimitiveError && e.code===c;
function tmp(t,prefix='hyprune-prims-') {const d=mkdtempSync(join(tmpdir(),prefix));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

test('geometry: each shape stands on y = 0 at its size, faces wound outwards, proxy around it',()=>{
 for(const shape of SHAPES) {
  const size=DEFAULT_SIZES[shape],{render,proxy}=primitiveGeometry(shape,size,shape==='stairs'?10:undefined);
  const xs=[],ys=[],zs=[];for(let i=0;i<render.pos.length;i+=3){xs.push(render.pos[i]);ys.push(render.pos[i+1]);zs.push(render.pos[i+2]);}
  const near=(a,b)=>Math.abs(a-b)<1e-6;
  assert.ok(near(Math.min(...ys),0) && near(Math.max(...ys),size[1]),`${shape} height`);
  assert.ok(near(Math.max(...xs)-Math.min(...xs),size[0]) && near(Math.max(...zs)-Math.min(...zs),size[2]),`${shape} footprint`);
  // Outward winding: each triangle's geometric normal agrees with its vertex normals.
  for(let i=0;i<render.idx.length;i+=3) {
   const p=[0,1,2].map(k=>render.pos.slice(render.idx[i+k]*3,render.idx[i+k]*3+3)),n=render.nrm.slice(render.idx[i]*3,render.idx[i]*3+3);
   const g=cross(sub(p[1],p[0]),sub(p[2],p[0]));
   if(Math.hypot(...g)>1e-9) assert.ok(dot(g,n)>0,`${shape} triangle ${i/3} faces inwards`);
  }
  const pts=proxy.flat();
  assert.ok(pts.every(q=>q[1]>=-1e-6 && q[1]<=size[1]+0.011) && proxy.length<=2000,`${shape} proxy`);
 }
 const stairs=primitiveGeometry('stairs',[1,1.8,3],10);
 assert.equal(stairs.proxy.length,10*12,'one box per step: walkable treads');
 // UVs are metres on each face: a 2 m wide box face spans 2 in u.
 const box=primitiveGeometry('box',[2,1,1]).render,us=[];
 for(let i=0;i<4;i++) us.push(box.uv[i*2]);
 assert.ok(Math.abs(Math.max(...us)-Math.min(...us)-1)<1e-6 || Math.abs(Math.max(...us)-Math.min(...us)-2)<1e-6);
});

test('specs and ids: sizes checked with hints, a cube is a cube, same request same id, another material another id',()=>{
 assert.deepEqual(checkSpec({shape:'cube',size:[2]}).size,[2,2,2]);
 assert.equal(checkSpec({shape:'stairs',size:[1,1.8,3]}).steps,10);
 for(const bad of [{shape:'torus'},{shape:'box',size:[0,1,1]},{shape:'box',size:[1,1]},{shape:'cube',size:[1,2,1]},{shape:'box',steps:3},{shape:'stairs',size:[1,1,1],steps:99}])
  assert.throws(()=>checkSpec(bad),code('primitive.invalid'),JSON.stringify(bad));
 assert.throws(()=>checkSpec({shape:'torus'}),e=>/Shapes: cube/.test(e.hint));
 const red=plainMaterial({colour:'#c03030'}),blue=plainMaterial({colour:'#3030c0'});
 assert.equal(primitiveId({shape:'box',size:[2,1,1]},red),primitiveId({shape:'box',size:[2,1,1]},red));
 assert.notEqual(primitiveId({shape:'box',size:[2,1,1]},red),primitiveId({shape:'box',size:[2,1,1]},blue));
 assert.notEqual(primitiveId({shape:'box',size:[2,1,1]},red),primitiveId({shape:'box',size:[2,1,1.5]},red));
 assert.match(primitiveId({shape:'ramp',size:[2,1,4]},red),/^ramp-[0-9a-f]{10}$/);
 assert.throws(()=>plainMaterial({colour:'red'}),code('material.invalid'));
 assert.equal(plainMaterial({colour:'#ABC'}).record.colour,'#aabbcc');
});

test('materials: built-in textures, the user\'s texture with provenance, absolute patches, dry runs',async t=>{
 const dir=tmp(t);
 const paving=await resolveMaterial(dir,'paving');
 assert.equal(paving.record.texture.image,'texture.ktx2');assert.equal(paving.record.texture.tile,4);
 assert.ok(existsSync(join(dir,'paving/swatch.png')));
 await assert.rejects(resolveMaterial(dir,'lava'),e=>code('material.unknown')(e) && /paving/.test(e.hint) && /grass/.test(e.hint));
 const w=64,data=new Uint8Array(w*w*4).map((_,i)=>i%4===3?255:(i*13)&255);
 const file=join(dir,'..',`tex-${process.pid}.png`);writeFileSync(file,encodePng({width:w,height:w,data}));t.after(()=>rmSync(file,{force:true}));
 await assert.rejects(setMaterial(dir,'oak',{texture:{path:file,license:'CC0-1.0',author:'',source:'x'}}),code('material.invalid'));
 const dry=await setMaterial(dir,'oak',{texture:{path:file,license:'CC-BY-4.0',author:'Ada',source:'https://example.com/oak'},tile:1.5},{dryRun:true});
 assert.equal(dry.dryRun,true);assert.ok(!existsSync(join(dir,'oak')));
 const made=await setMaterial(dir,'oak',{texture:{path:file,license:'CC-BY-4.0',author:'Ada',source:'https://example.com/oak'},tile:1.5,colour:'#ffeedd'});
 assert.equal(made.created,true);
 const oak=readMaterial(dir,'oak');
 assert.deepEqual([oak.record.texture.tile,oak.record.license,oak.record.author,oak.record.colour],[1.5,'CC-BY-4.0','Ada','#ffeedd']);
 assert.deepEqual(validateManifest('material',oak.record).errors,[]);
 // Absolute patches: the same patch twice changes nothing the second time.
 assert.equal((await setMaterial(dir,'oak',{roughness:0.4})).changed,true);
 assert.equal((await setMaterial(dir,'oak',{roughness:0.4})).changed,false);
 assert.equal((await setMaterial(dir,'oak',{texture:null})).material.textured,false);
 await assert.rejects(setMaterial(dir,'oak',{tile:2}),e=>code('material.invalid')(e) && /texture first/.test(e.hint));
 await assert.rejects(setMaterial(dir,'Oak',{}),code('material.invalid'));
 assert.deepEqual(listMaterials(dir).map(m=>m.key),['oak','paving']);
});

test('object directories: valid, idempotent, rebuilt and swapped after a material change',async t=>{
 const root=tmp(t),objects=join(root,'objects'),mats=join(root,'materials');
 await setMaterial(mats,'brick',{texture:{preset:'paving'},colour:'#d08060'});
 let brick=readMaterial(mats,'brick');
 const a=await writePrimitive(objects,'world',{shape:'box',size:[2,1,0.3]},brick,{validate:d=>validateObject(d)});
 assert.equal(a.created,true);assert.match(a.ref,/^world\/box-/);
 const check=await validateObject(a.path);
 assert.equal(check.manifest.traits.collidable.node,'proxy');
 const rec=JSON.parse(readFileSync(join(a.path,'primitive.json'),'utf8'));
 assert.deepEqual(validateManifest('primitive',rec).errors,[]);
 assert.deepEqual([rec.shape,rec.size,rec.material.key,rec.material.textured],['box',[2,1,0.3],'brick',true]);
 const glowing=await writePrimitive(objects,'world',{shape:'box',size:[0.5,2,0.5]},plainMaterial({colour:'#202020',emissive:{colour:'#30e0ff',strength:4}}));
 assert.deepEqual(JSON.parse(readFileSync(join(glowing.path,'primitive.json'),'utf8')).material.emissive,{colour:'#30e0ff',strength:4});
 assert.equal((await writePrimitive(objects,'world',{shape:'box',size:[2,1,0.3]},brick)).created,false,'same request, same directory');
 assert.equal((await writePrimitive(objects,'world',{shape:'box',size:[2,1,0.4]},brick,{dryRun:true})).dryRun,true);
 assert.equal(readdirSync(objects).length,2,'a dry run writes nothing');
 await setMaterial(mats,'brick',{colour:'#a04030'});
 brick=readMaterial(mats,'brick');
 const stale=stalePrimitives(objects,'brick',brick);
 assert.deepEqual(stale.map(s=>s.id),[a.id]);
 const b=await writePrimitive(objects,'world',stale[0],brick);
 assert.notEqual(b.id,a.id);assert.equal(stalePrimitives(objects,'brick',brick).length,1,'the old one stays until a save prunes it');
});

test('builder CLI: primitives and materials in a world folder; Save prunes the unplaced and credits textures',async t=>{
 const dir=tmp(t,'hyprune-projects-'),env={...process.env,HYPRUNE_PROJECTS_DIR:dir};
 const cli=(...args)=>spawnSync(process.execPath,[CLI,...args,'--json'],{env,encoding:'utf8'});
 const last=r=>JSON.parse(r.stdout.trim().split('\n').at(-1));
 const {folder}=await createProject('Yard',{root:dir,identity:ME});
 const m=last(cli('builder','material','yard','glow','--colour','#101010','--emissive','#30e0ff','--emissive-strength','4'));
 assert.equal(m.result.created,true);
 const box=last(cli('builder','primitive','yard','--shape','box','--size','0.5,2,0.5','--material','glow'));
 const again=last(cli('builder','primitive','yard','--shape','box','--size','0.5,2,0.5','--material','glow'));
 assert.equal(box.result.ref,again.result.ref);assert.equal(again.result.created,false);
 const floor=last(cli('builder','primitive','yard','--shape','plane','--size','4,0.02,4','--material','grass'));
 assert.equal(floor.result.primitive.material.key,'grass');
 assert.ok(existsSync(join(folder,'materials/grass/material.json')),'a built-in texture is copied into the folder');
 const bad=last(cli('builder','primitive','yard','--shape','torus'));
 assert.equal(bad.error.code,'primitive.invalid');assert.match(bad.error.hint,/Shapes:/);
 assert.equal(last(cli('builder','primitive','nowhere','--shape','box')).error.code,'project.unknown');
 // Place the glowing box the way core does; the plane stays unplaced.
 const project=readProject(folder);
 project.placements.push({id:'u-00a001',ref:box.result.ref,pose:{position:[0,0,-3],rotation:[0,0,0,1]},scale:1,key:'beacon'});
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(project,null,2));
 const changed=last(cli('builder','material','yard','glow','--emissive','#ff8030','--emissive-strength','6'));
 assert.deepEqual(changed.result.stale,[box.result.id]);
 const rebuilt=last(cli('builder','rebuild','yard'));
 assert.equal(rebuilt.result.swaps.length,1);assert.equal(rebuilt.result.swaps[0].from,box.result.ref);
 project.placements[0].ref=rebuilt.result.swaps[0].to;
 writeFileSync(join(folder,'builder/project.json'),JSON.stringify(project,null,2));
 const saved=await save(folder,'A glowing beacon');
 assert.ok(saved.warnings.some(w=>/removed 2 unplaced primitives/.test(w)),JSON.stringify(saved.warnings));
 assert.deepEqual(readdirSync(join(folder,'objects')),[rebuilt.result.swaps[0].to.slice(6)]);
 const world=JSON.parse(readFileSync(join(folder,'world.json'),'utf8'));
 assert.ok(world.attribution.some(a=>a.path.startsWith('materials/glow/')),'materials are credited');
 assert.equal(world.objects.length,1);
 assert.deepEqual(prunePrimitives(folder),[]);
 assert.equal(last(cli('builder','materials','yard')).result.materials.length,2);
});

test('object CLI: primitives and materials in the user\'s folders',t=>{
 const data=tmp(t,'hyprune-data-'),env={...process.env,XDG_DATA_HOME:data};
 const cli=(...args)=>spawnSync(process.execPath,[CLI,...args,'--json'],{env,encoding:'utf8'});
 const last=r=>JSON.parse(r.stdout.trim().split('\n').at(-1));
 const r=last(cli('object','primitive','--shape','cylinder','--size','0.6,1,0.6','--colour','#ffaa00'));
 assert.match(r.result.ref,/^user\/cylinder-/);
 assert.ok(existsSync(join(data,'hyprune/objects',r.result.id,'primitive.json')));
 assert.equal(last(cli('object','material','steel','--colour','#8090a0','--metallic','1','--roughness','0.3')).result.created,true);
 assert.ok(existsSync(join(data,'hyprune/materials/steel/material.json')));
});

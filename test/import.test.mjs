// `hyprune object import` (RFC-0014 P1 as amended): the fixtures in test/fixtures/import (original,
// CC0-1.0) through inspect and import into a temporary user folder, checked with the shared validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectImport,guessUnits,convexHull,collisionProxy,importSlug,nameFromFile} from '../dist/src/import.js';
import {importObject,importOptions} from '../dist/src/object-cli.js';
import {validateObject} from '../dist/src/object.js';
import {validateManifest} from '../dist/src/validation.js';

const fixtures=fileURLToPath(new URL('./fixtures/import/',import.meta.url));
const BARREL=join(fixtures,'barrel/barrel.gltf'),CRATE=join(fixtures,'crate/crate.obj');
const CLI=fileURLToPath(new URL('../dist/src/cli.js',import.meta.url));
const temp=t=>{const d=mkdtempSync(join(tmpdir(),'hyprune-import-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
// The GLB's JSON chunk.
const glbJson=path=>{const b=readFileSync(path);return JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString('utf8'));};

test('helpers: units from size, slugs and names, hull and proxy',()=>{
 assert.equal(guessUnits([1.2,0.8,0.5]),'m');assert.equal(guessUnits([82,120,82]),'cm');assert.equal(guessUnits([1800,900,600]),'cm');assert.equal(guessUnits([12000,900,600]),'mm');
 assert.equal(importSlug('Old Oak Barrel!'),'old-oak-barrel');assert.equal(importSlug('3d crate'),'object-3d-crate');
 assert.equal(nameFromFile('/x/old_oak-barrel.glb'),'Old oak barrel');
 const cube=[];for(const x of [0,1])for(const y of [0,1])for(const z of [0,1])cube.push([x,y,z]);
 const hull=convexHull([...cube,[0.5,0.5,0.5],[0.2,0.7,0.4]]);
 assert.equal(hull.length,12,'a cube hull has 12 triangles; inner points add none');
 for(const tri of hull){const [a,b,c]=tri;const n=[(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])];
  const m=[(a[0]+b[0]+c[0])/3-.5,(a[1]+b[1]+c[1])/3-.5,(a[2]+b[2]+c[2])/3-.5];assert.ok(n[0]*m[0]+n[1]*m[1]+n[2]*m[2]>0,'outward faces');}
 assert.equal(convexHull([[0,0,0],[1,0,0],[0,1,0],[1,1,0]]),null,'flat points have no hull');
 const flat=collisionProxy([[[0,0,0],[1,0,0],[0,0,1]]],'convex');
 assert.equal(flat.kind,'box');assert.equal(flat.triangles.length,12);
});

test('inspect: measures without writing; centimetres guessed from the size',async()=>{
 const r=await inspectImport(BARREL);
 assert.equal(r.format,'gltf');assert.equal(r.backend,'gltf');assert.equal(r.triangles,12544);assert.equal(r.maxTexture,2048);
 assert.deepEqual(r.extent,[82,82,120]);assert.equal(r.unitsGuess,'cm');assert.deepEqual(r.extentMetres,[0.82,0.82,1.2]);
 assert.equal(r.name,'Barrel');assert.equal(r.id,'barrel');assert.match(r.sha256,/^[0-9a-f]{64}$/);
 assert.equal(typeof r.author,'string');assert.notEqual(r.author,'Hyprune contributors','the suggestion is the user\'s git name or empty');
});

test('import a centimetre, Z-up glTF: upright, metres, decimated, KTX2, convex proxy, import.json',async t=>{
 const root=temp(t);
 const r=await importObject(BARREL,{...importOptions({up:'z','max-triangles':'5000','max-texture':'1024',license:'CC0-1.0',author:'Hyprune contributors',
  source:'https://github.com/hyprune/sdk',category:'furniture',tags:'barrel,storage'}),root});
 assert.equal(r.id,'barrel');assert.equal(r.ref,'user/barrel');
 const dir=join(root,'barrel'),manifest=JSON.parse(readFileSync(join(dir,'object.json'),'utf8')),record=JSON.parse(readFileSync(join(dir,'import.json'),'utf8'));
 assert.equal(manifest.formatVersion,'0.11');assert.equal(manifest.category,'furniture');assert.deepEqual(manifest.tags,['imported','barrel','storage']);
 assert.deepEqual(manifest.attribution,[{path:'.',author:'Hyprune contributors',license:'CC0-1.0',source:'https://github.com/hyprune/sdk'}]);
 assert.ok(Math.abs(manifest.bounds.min[1])<0.01 && Math.abs(manifest.bounds.max[1]-1.2)<0.01,'1.2 m tall, base at the origin: '+JSON.stringify(manifest.bounds));
 assert.ok(Math.abs(manifest.bounds.max[0]-0.41)<0.01 && Math.abs(manifest.bounds.min[0]+0.41)<0.01,'centred');
 assert.deepEqual(manifest.traits.movable,{surfaces:['floor'],upright:true,scale:[0.25,4]});
 assert.deepEqual(manifest.traits.collidable,{node:'proxy'});
 assert.ok(r.after.triangles<=5000 && r.before.triangles===12544,JSON.stringify(r.after));
 assert.equal(r.after.maxTexture,1024);
 const gltf=glbJson(join(dir,'object.glb'));
 for(const e of ['KHR_texture_basisu','EXT_meshopt_compression','KHR_mesh_quantization'])assert.ok(gltf.extensionsRequired.includes(e),e);
 assert.equal(gltf.images.length,1);assert.equal(gltf.images[0].mimeType,'image/ktx2');
 const proxy=gltf.nodes.findIndex(n=>n.name==='proxy');
 assert.ok(proxy>=0 && !gltf.scenes[gltf.scene].nodes.includes(proxy),'the proxy node is outside the scene');
 assert.ok(r.after.collisionTriangles>12 && r.after.collisionTriangles<=1000,'a convex hull, not a box');
 assert.deepEqual(validateManifest('import',record).errors,[]);
 assert.equal(record.options.units,'cm');assert.equal(record.options.up,'z');assert.equal(record.source.name,'barrel.gltf');
 assert.deepEqual(record.license,{spdx:'CC0-1.0',author:'Hyprune contributors',source:'https://github.com/hyprune/sdk'});
 assert.ok(record.steps.some(s=>s.startsWith('decimated 12544 -> ')));
 const check=await validateObject(dir);assert.equal(check.manifest.id,'barrel');
 const png=readFileSync(join(dir,'thumbnail.png'));assert.equal(png.readUInt32BE(16),256);assert.equal(png.readUInt32BE(20),256);
 // The same name again gets a new id; --replace takes the old one.
 assert.equal((await importObject(BARREL,{up:'z',root})).id,'barrel-2');
 assert.equal((await importObject(BARREL,{up:'z',root,replace:true})).replaced,true);
});

test('import OBJ through Assimp; box proxy, unlit, wall pivot, no KTX2; unknown provenance',async t=>{
 const root=temp(t);
 const r=await importObject(CRATE,{root,surface:'wall',collision:'box',lighting:'unlit',ktx2:'off',name:'Pine crate'});
 assert.equal(r.id,'pine-crate');
 const dir=join(root,'pine-crate'),m=JSON.parse(readFileSync(join(dir,'object.json'),'utf8')),record=JSON.parse(readFileSync(join(dir,'import.json'),'utf8'));
 assert.equal(record.converter.backend,'assimp');assert.equal(record.source.format,'obj');
 assert.ok(Math.abs(m.bounds.min[2])<0.01 && Math.abs(m.bounds.max[2]-0.6)<0.01,'back at the origin: '+JSON.stringify(m.bounds));
 assert.equal(m.license,'LicenseRef-unknown');assert.deepEqual(m.attribution,[{path:'.',author:'unknown',license:'LicenseRef-unknown'}]);
 assert.deepEqual(record.license,{spdx:'LicenseRef-unknown',author:'unknown',source:'unknown'});
 assert.equal(m.lighting.mode,'unlit');assert.equal(r.after.collisionTriangles,12);
 const gltf=glbJson(join(dir,'object.glb'));
 assert.ok(gltf.materials.every(x=>x.extensions?.KHR_materials_unlit));
 assert.ok(!(gltf.extensionsRequired || []).includes('KHR_texture_basisu'));
});

test('refusals: unsupported, remote and Draco sources; nothing written',async t=>{
 const root=temp(t),dir=temp(t);
 writeFileSync(join(dir,'model.blend'),'BLENDER');
 await assert.rejects(importObject(join(dir,'model.blend'),{root}),e=>e.rule==='import.unsupported');
 const remote={asset:{version:'2.0'},buffers:[{uri:'https://example.com/x.bin',byteLength:4}]};
 writeFileSync(join(dir,'remote.gltf'),JSON.stringify(remote));
 await assert.rejects(importObject(join(dir,'remote.gltf'),{root}),e=>e.rule==='import.remote');
 writeFileSync(join(dir,'draco.gltf'),JSON.stringify({asset:{version:'2.0'},extensionsUsed:['KHR_draco_mesh_compression']}));
 await assert.rejects(importObject(join(dir,'draco.gltf'),{root}),e=>e.rule==='import.draco');
 assert.deepEqual(readdirSync(root).filter(n=>!n.startsWith('.')),[],'nothing written');
 assert.throws(()=>importOptions({yaw:'45'}),/--yaw/);assert.throws(()=>importOptions({'max-texture':'3000'}),/--max-texture/);
 assert.throws(()=>importOptions({surface:'roof'}),/--surface/);assert.throws(()=>importOptions({id:'Bad id'}),/--id/);
});

test('CLI --json: JSON lines with stages and a done result, or an error line',async t=>{
 const root=temp(t);
 const run=args=>spawnSync('node',[CLI,'object','import',...args,'--json'],{env:{...process.env,HYPRUNE_OBJECT_DIR:root},encoding:'utf8'});
 const ok=run([CRATE]),lines=ok.stdout.trim().split('\n').map(l=>JSON.parse(l));
 assert.equal(ok.status,0,ok.stderr);
 assert.deepEqual(lines.filter(l=>l.event==='stage').map(l=>l.stage).slice(0,3),['read','clean','fit']);
 assert.equal(lines.at(-1).event,'done');assert.equal(lines.at(-1).result.ref,'user/crate');
 const inspect=run([BARREL,'--inspect']),doc=JSON.parse(inspect.stdout.trim());
 assert.equal(doc.event,'done');assert.equal(doc.result.unitsGuess,'cm');
 const bad=run([join(fixtures,'PROVENANCE.md')]),err=JSON.parse(bad.stdout.trim().split('\n').at(-1));
 assert.equal(bad.status,1);assert.deepEqual(Object.keys(err),['event','error']);assert.equal(err.error.rule,'import.unsupported');
});

test('no native image code: the import never loads sharp (textures resize, KTX2 and thumbnails in JavaScript)',async t=>{
 const root=temp(t);
 // A child process where resolving sharp fails: the import must still resize, encode and render.
 const hook='data:text/javascript,'+encodeURIComponent("export async function resolve(s,c,n){if(s==='sharp'||s.startsWith('@img/'))throw new Error('sharp loaded');return n(s,c);}");
 const script=`import {register} from 'node:module';register(${JSON.stringify(hook)});
  const {importObject}=await import(${JSON.stringify(new URL('../dist/src/object-cli.js',import.meta.url).href)});
  const r=await importObject(${JSON.stringify(BARREL)},{root:${JSON.stringify(root)},up:'z',maxTexture:512,ktx2:'all'});
  console.log(JSON.stringify({maxTexture:r.after.maxTexture,warnings:r.warnings,steps:r.steps}));`;
 const run=spawnSync('node',['--input-type=module','-e',script],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const r=JSON.parse(run.stdout.trim().split('\n').at(-1));
 assert.equal(r.maxTexture,512);assert.deepEqual(r.warnings,[]);
 assert.ok(r.steps.some(s=>s.startsWith('KTX2')),JSON.stringify(r.steps));
 assert.ok(readFileSync(join(root,'barrel/thumbnail.png')).length>1000);
});

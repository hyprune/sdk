// Imports from a .zip (strict names and sizes), and editing entries after the fact (RFC-0014 as
// amended): adjust re-fits units, axes and surface with absolute values, simplify decimates again
// with the numbers before and after, repair fixes what the validator refuses; each keeps a backup
// that restore puts back, and --dry-run writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {deflateRawSync,crc32} from 'node:zlib';
import {importObject} from '../dist/src/object-cli.js';
import {inspectImport} from '../dist/src/import.js';
import {zipEntries,zipName} from '../dist/src/zip.js';
import {adjustObject,backupsDir,repairObject,resolveEntry,restoreBackup,simplifyObject} from '../dist/src/object-edit.js';
import {validateObject} from '../dist/src/object.js';

const fixtures=fileURLToPath(new URL('./fixtures/import/',import.meta.url));
const CLI=fileURLToPath(new URL('../dist/src/cli.js',import.meta.url));
const temp=t=>{const d=mkdtempSync(join(tmpdir(),'hyprune-edit-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
/** A zip from [{name, data, method?, mode?, size?}] (method 8 deflates; size overrides the declared size). */
function zip(entries) {
 const locals=[],central=[];let offset=0;
 for(const e of entries) {
  const name=Buffer.from(e.name),data=Buffer.from(e.data ?? ''),method=e.method ?? 8,body=method===8?deflateRawSync(data):data,size=e.size ?? data.length;
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(method,8);h.writeUInt32LE(crc32(data),14);
  h.writeUInt32LE(body.length,18);h.writeUInt32LE(size,22);h.writeUInt16LE(name.length,26);
  locals.push(h,name,body);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(0x031e,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(method,10);
  c.writeUInt32LE(crc32(data),16);c.writeUInt32LE(body.length,20);c.writeUInt32LE(size,24);c.writeUInt16LE(name.length,28);
  c.writeUInt32LE(((e.mode ?? 0o100644)<<16)>>>0,38);c.writeUInt32LE(offset,42);
  central.push(c,name);offset+=30+name.length+body.length;
 }
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,cd,end]);
}
const barrelFiles=()=>['barrel.gltf','barrel.bin','staves.png'].map(f=>({name:`Barrel Pack/${f}`,data:readFileSync(join(fixtures,'barrel',f))}));
const code=c=>e=>(e.code ?? e.rule)===c;

test('zip: names and sizes are checked before anything is written',t=>{
 const d=temp(t);
 assert.equal(zipName('a/b.gltf'),'a/b.gltf');
 for(const bad of ['../x.gltf','/etc/x','C:/x','a/../../x','a//b','a\u0001b']) assert.throws(()=>zipName(bad),/refused|control|empty/,bad);
 const write=(name,entries)=>{const p=join(d,name);writeFileSync(p,zip(entries));return p;};
 assert.throws(()=>zipEntries(write('trav.zip',[{name:'../evil.gltf',data:'{}'}])),/refused/);
 assert.throws(()=>zipEntries(write('link.zip',[{name:'link.gltf',data:'/etc/passwd',method:0,mode:0o120777}])),/symbolic links/);
 assert.throws(()=>zipEntries(write('bomb.zip',[{name:'big.bin',data:Buffer.alloc(4*1048576)}])),/zip bomb/);
 assert.throws(()=>zipEntries(write('dup.zip',[{name:'a.gltf',data:'{}'},{name:'A.gltf',data:'{}'}])),/twice/);
 assert.throws(()=>zipEntries(join(fixtures,'barrel','barrel.gltf')),/not a zip/);
});

test('zip import: the model inside, provenance of the archive, licence files as suggestions, --entry among several',async t=>{
 const d=temp(t),root=join(d,'objects');
 const pack=join(d,'barrel-pack.zip');
 writeFileSync(pack,zip([...barrelFiles(),{name:'Barrel Pack/LICENSE.txt',data:'CC0 1.0 Universal'},{name:'__MACOSX/._barrel.gltf',data:'junk'}]));
 const seen=await inspectImport(pack);
 assert.equal(seen.archive.entry,'Barrel Pack/barrel.gltf');assert.deepEqual(seen.archive.models,['Barrel Pack/barrel.gltf']);
 assert.equal(seen.archive.licenseFiles[0].path,'Barrel Pack/LICENSE.txt');assert.match(seen.archive.licenseFiles[0].text,/CC0/);
 assert.equal(seen.name,'Barrel pack');assert.ok(seen.triangles>0);
 const r=await importObject(pack,{root,license:'CC0-1.0',author:'Ada',source:'https://example.com/barrel'});
 assert.equal(r.ref,'user/barrel-pack');
 const record=JSON.parse(readFileSync(join(root,'barrel-pack','import.json'),'utf8'));
 assert.equal(record.source.name,'barrel-pack.zip!/Barrel Pack/barrel.gltf');assert.equal(record.source.format,'gltf');
 assert.equal(record.source.bytes,readFileSync(pack).length);
 assert.match(record.steps[0],/^unpacked barrel-pack.zip \(4 files\)/);
 const two=join(d,'two.zip');
 writeFileSync(two,zip([...barrelFiles(),{name:'other/crate.gltf',data:readFileSync(join(fixtures,'barrel','barrel.gltf'))},{name:'other/barrel.bin',data:readFileSync(join(fixtures,'barrel','barrel.bin'))},{name:'other/staves.png',data:readFileSync(join(fixtures,'barrel','staves.png'))}]));
 await assert.rejects(inspectImport(two),e=>e.rule==='import.entry' && e.models.length===2);
 assert.equal((await inspectImport(two,'other/crate.gltf')).archive.entry,'other/crate.gltf');
 // CLI: the error carries the models for the Director's chooser.
 const out=spawnSync(process.execPath,[CLI,'object','import',two,'--json'],{env:{...process.env,HYPRUNE_OBJECT_DIR:root},encoding:'utf8'});
 const err=JSON.parse(out.stdout.trim().split('\n').at(-1));
 assert.equal(err.error.rule,'import.entry');assert.equal(err.error.models.length,2);
});

test('adjust: absolute units, turn and surface from the converted model; dry run; backup and restore',async t=>{
 const d=temp(t),root=join(d,'objects');process.env.HYPRUNE_OBJECT_DIR=root;process.env.XDG_STATE_HOME=join(d,'state');
 await importObject(join(fixtures,'barrel','barrel.gltf'),{root,units:'m'});
 const e=resolveEntry('user/barrel');
 const before=JSON.parse(readFileSync(join(e.dir,'object.json'),'utf8')),extent=i=>before.bounds.max[i]-before.bounds.min[i];
 const dry=await adjustObject(e,{units:'cm'},{dryRun:true});
 assert.equal(dry.dryRun,true);assert.deepEqual(JSON.parse(readFileSync(join(e.dir,'object.json'),'utf8')),before,'dry run writes nothing');
 assert.equal(dry.fit.from.units,'m');assert.equal(dry.fit.to.units,'cm');
 const r=await adjustObject(e,{units:'cm'});
 const after=JSON.parse(readFileSync(join(e.dir,'object.json'),'utf8'));
 for(const i of [0,1,2]) assert.ok(Math.abs((after.bounds.max[i]-after.bounds.min[i])-extent(i)/100)<2e-3,`axis ${i} scaled by 0.01`);
 assert.equal(after.bounds.min[1],0,'still standing on its base');
 const record=JSON.parse(readFileSync(join(e.dir,'import.json'),'utf8'));
 assert.deepEqual([record.options.units,record.options.scale],['cm',0.01]);assert.match(record.steps.at(-1),/^adjusted: scale x0.01/);
 assert.ok(r.backup && existsSync(join(backupsDir(),r.backup,'backup.json')));
 await validateObject(e.dir,{directoryName:false});
 await assert.rejects(adjustObject(e,{units:'cm'}),code('adjust.nothing'));
 // Back to metres, turned a quarter and hung on a wall: absolute values, not steps.
 await adjustObject(e,{units:'m',yaw:90,surface:'wall'});
 const turned=JSON.parse(readFileSync(join(e.dir,'object.json'),'utf8'));
 assert.ok(Math.abs((turned.bounds.max[0]-turned.bounds.min[0])-extent(2))<2e-3,'x is the old z');
 assert.equal(turned.bounds.min[2],0,'pivot at the back (wall)');assert.deepEqual(turned.traits.movable.surfaces,['wall']);
 const restored=await restoreBackup(r.backup);
 assert.deepEqual(JSON.parse(readFileSync(join(e.dir,'object.json'),'utf8')),before,'restore puts the first version back');
 assert.ok(restored.backup,'what it replaced is backed up too');
});

test('simplify and repair: fewer triangles with numbers; bounds and unknown traits fixed; a valid entry has nothing to repair',async t=>{
 const d=temp(t),root=join(d,'objects');process.env.HYPRUNE_OBJECT_DIR=root;process.env.XDG_STATE_HOME=join(d,'state');
 await importObject(join(fixtures,'barrel','barrel.gltf'),{root});
 const e=resolveEntry('user/barrel');
 const s=await simplifyObject(e,{maxTriangles:100});
 assert.ok(s.after.triangles<s.before.triangles,`${s.before.triangles} -> ${s.after.triangles}`);
 assert.match(JSON.parse(readFileSync(join(e.dir,'import.json'),'utf8')).steps.at(-1),/^simplified: \d+ -> \d+ triangles/);
 await validateObject(e.dir,{directoryName:false});
 await assert.rejects(repairObject(e),code('repair.nothing'));
 const m=JSON.parse(readFileSync(join(e.dir,'object.json'),'utf8'));
 m.traits.sparkle={};m.bounds={min:[0,0,0],max:[9,9,9]};
 writeFileSync(join(e.dir,'object.json'),JSON.stringify(m));
 await assert.rejects(validateObject(e.dir,{directoryName:false}));
 const dry=await repairObject(e,{dryRun:true});
 assert.equal(dry.dryRun,true);assert.ok(dry.fixed.some(f=>/unknown trait sparkle/.test(f)));
 const r=await repairObject(e);
 assert.ok(r.fixed.some(f=>/bounds/.test(f)));
 await validateObject(e.dir,{directoryName:false});
 // CLI JSON lines.
 const cli=(...a)=>JSON.parse(spawnSync(process.execPath,[CLI,'object',...a,'--json'],{env:process.env,encoding:'utf8'}).stdout.trim().split('\n').at(-1));
 assert.equal(cli('repair','user/barrel').error.code,'repair.nothing');
 assert.equal(cli('adjust','user/nothing','--scale','2').error.code,'object.unknown');
 assert.equal(cli('adjust','world/barrel','--scale','2').error.code,'object.unknown','world/ needs --project');
 const ok=cli('adjust','user/barrel','--scale','2','--dry-run');
 assert.equal(ok.event,'done');assert.equal(ok.result.dryRun,true);
});

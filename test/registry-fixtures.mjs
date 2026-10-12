// Shared registry test fixtures: hand-built ustar streams (the extractor fixtures: traversal,
// links, devices, oversize, executable bits and signatures, bad names, zstd window) and an
// isolated environment for CLI runs.
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,cp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** One ustar header + data. `type` '0' file, '5' directory, '1' hard link, '2' symlink, '3'/'4' devices, '6' FIFO. */
export function tarEntry(name,{type='0',mode=type==='5'?0o755:0o644,data=Buffer.alloc(0),linkname='',magic='ustar\x0000',size}={}) {
 const h=Buffer.alloc(512),body=Buffer.from(data);
 let prefix='',base=name;
 if(Buffer.byteLength(name)>100) {const cut=name.lastIndexOf('/',155);prefix=name.slice(0,cut);base=name.slice(cut+1);}
 h.write(base,0,100);h.write(mode.toString(8).padStart(7,'0'),100);h.write('0000000',108);h.write('0000000',116);
 h.write((size ?? (type==='0'?body.length:0)).toString(8).padStart(11,'0'),124);h.write('00000000000',136);
 h.write('        ',148);h.write(type,156);h.write(linkname,157,100);h.write(magic,257,8,'latin1');h.write(prefix,345,155);
 let sum=0;for(const b of h) sum+=b;h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'latin1');
 const pad=Buffer.alloc((512-body.length%512)%512);
 return Buffer.concat([h,type==='0'?body:Buffer.alloc(0),type==='0'?pad:Buffer.alloc(0)]);
}
export const tarEnd=()=>Buffer.alloc(1024);
export function tar(entries) {return Buffer.concat([...entries.map(e=>Array.isArray(e)?tarEntry(...e):e),tarEnd()]);}
export function zstd(bytes,args=[]) {return execFileSync('zstd',['-q','-c',...args],{input:bytes,maxBuffer:1<<30});}
/** A minimal valid library tree as tar entries under `id/` (library.json, LICENSE, ATTRIBUTION.md, no objects). */
export function libraryEntries(id='com.example.tiny',version='1.0.0',extra=[]) {
 const manifest={formatVersion:'0.9',id,version,name:'Tiny',license:'CC0-1.0',attribution:[{path:'.',author:'Example',license:'CC0-1.0'}],objects:[]};
 return [[`${id}/`,{type:'5'}],[`${id}/library.json`,{data:JSON.stringify(manifest)}],[`${id}/LICENSE`,{data:'CC0-1.0\n'}],[`${id}/ATTRIBUTION.md`,{data:'# Attribution\n'}],...extra];
}
export async function tempDir(t,prefix='hyprune-registry-') {
 const root=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
/** XDG directories, world root and library roots under `root`, no session and no system sources. */
export function isolatedEnv(root,extra={}) {
 return {...process.env,HOME:join(root,'home'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),
  XDG_CONFIG_HOME:join(root,'config'),XDG_RUNTIME_DIR:join(root,'run'),HYPRLAND_INSTANCE_SIGNATURE:'none',HYPRUNE_WORLD_DIR:'',HYPRUNE_LIBRARY_DIR:'',
  HYPRUNE_SOURCES_FILES:'',HYPRUNE_SOCKET:'',HYPRUNE_TOKEN_FD:'',HYPRUNE_PROTOCOL:'',GITHUB_TOKEN:'',...extra};
}
/** Run the built CLI; resolves {code, out, err, lines (parsed JSON lines when --json)}. */
export function cli(args,env,{input}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['dist/src/cli.js',...args],{env,stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
  child.stdin.end(input ?? '');
  child.on('close',code=>{
   let lines=[];
   if(args.includes('--json')) {try {lines=out.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));} catch {}}
   resolve({code,out,err,lines});
  });
 });
}
/** A copy of examples/world-minimal with id and version changed. */
export async function writeWorld(dir,{id='org.example.minimal',version='0.1.0'}={}) {
 await mkdir(dir,{recursive:true});await cp('examples/world-minimal',dir,{recursive:true});
 const w=JSON.parse(await readFile(join(dir,'world.json')));w.id=id;w.version=version;await writeFile(join(dir,'world.json'),JSON.stringify(w,null,2));
 return dir;
}

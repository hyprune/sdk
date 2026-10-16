// `hyprune mcp` (RFC-0016 phase E1), offline: the MCP lifecycle over stdio, the tool list, the
// world-folder tools (create, sky, material, spawn, look on the CPU, checklist, save, history,
// undo back to the last save), in-world tools answering assistant.offline, the prompt and the
// resources. The paired, in-world path is covered by the nested --assistant check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {decodeImage} from '../dist/src/pixels.js';

const CLI=new URL('../dist/src/cli.js',import.meta.url).pathname;
function server(t,env) {
 const child=spawn(process.execPath,[CLI,'mcp','--offline'],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill());
 const waiting=new Map();let next=1;
 createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);waiting.get(m.id)?.(m);waiting.delete(m.id);});
 let errors='';child.stderr.on('data',d=>errors+=d);
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=next++;waiting.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');setTimeout(()=>reject(new Error(`${method} timed out; stderr: ${errors}`)),60000).unref();});
 const call=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});assert.ok(r.result,JSON.stringify(r));return r.result;};
 return {rpc,call,child};
}
const json=r=>JSON.parse(r.content.find(c=>c.type==='text').text);

test('MCP offline: lifecycle, tools, a world built in the folder, look, checklist, save, undo to the last save',async t=>{
 const root=mkdtempSync(join(tmpdir(),'hyprune-mcp-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const cfg=join(root,'gitconfig');writeFileSync(cfg,'[user]\n name = Test Assistant\n email = assistant@example.com\n');
 const env={HYPRUNE_PROJECTS_DIR:join(root,'projects'),GIT_CONFIG_GLOBAL:cfg,GIT_CONFIG_NOSYSTEM:'1',XDG_RUNTIME_DIR:join(root,'run'),HYPRLAND_INSTANCE_SIGNATURE:'none',HYPRUNE_SOCKET:join(root,'none.sock')};
 const {rpc,call}=server(t,env);
 const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Test Client',version:'1.0'}});
 assert.equal(init.result.protocolVersion,'2025-06-18');assert.equal(init.result.serverInfo.name,'hyprune');
 assert.ok(init.result.capabilities.tools && init.result.capabilities.prompts && init.result.capabilities.resources);
 assert.equal((await rpc('initialize',{protocolVersion:'1999-01-01',capabilities:{},clientInfo:{name:'x'}})).result.protocolVersion,'2025-06-18','unknown revision: the newest');
 const tools=(await rpc('tools/list')).result.tools.map(x=>x.name);
 for(const n of ['world_create','world_describe','world_set_sky','place','edit','remove','material_set','source_set_http','behaviour_set','look','checklist','save','discard','history','undo'])
  assert.ok(tools.includes(n),n);
 assert.ok(!tools.some(n=>/surface|input|camera|window|publish|^release$/.test(n)),'end-user operations only (release_prepare only fills the form)');
 assert.equal((await rpc('tools/call',{name:'nope',arguments:{}})).error.code,-32602);
 // A world, created and saved once.
 const created=json(await call('world_create',{name:'Rooftop Test',sky:'sunset',floor:'paving',open:false}));
 assert.equal(created.projectId,'rooftop-test');assert.equal(created.opened,false);
 const again=await call('world_create',{name:'Rooftop Test'});
 assert.equal(again.isError,true);assert.equal(json(again).error.code,'project.exists');assert.match(json(again).error.hint,/local\.rooftop-test/);
 const folder=created.folder;
 // In-world tools need Hyprune.
 const offline=await call('place',{key:'roof',shape:'box',size:[4,0.4,4],position:[0,0,-6]});
 assert.equal(offline.isError,true);assert.equal(json(offline).error.code,'assistant.offline');assert.equal(json(offline).error.retryable,true);
 // Folder tools work: sky, a material, the spawn; each journaled.
 assert.equal(json(await call('world_set_sky',{preset:'night',dryRun:true})).dryRun,true);
 assert.equal(json(await call('world_set_sky',{preset:'clear-day'})).preset,'clear-day');
 assert.equal(json(await call('material_set',{key:'deck-wood',colour:'#8b5a3c',roughness:0.8})).material.key,'deck-wood');
 assert.deepEqual(json(await call('spawn_set',{position:[2,0,3],yaw:90})).position,[2,0,3]);
 const described=json(await call('world_describe'));
 assert.equal(described.sky.preset,'clear-day');assert.equal(described.materials[0].key,'deck-wood');assert.ok(described.pending.total>0);
 assert.ok(!JSON.stringify(described).includes('windowTitle'));
 // Look on the CPU: a PNG and the pose used.
 const look=await call('look',{from:'spawn',size:[320,180]});
 const image=look.content.find(c=>c.type==='image');
 assert.equal(image.mimeType,'image/png');
 const png=decodeImage(Buffer.from(image.data,'base64'));
 assert.deepEqual([png.width,png.height],[320,180]);
 assert.equal(look.structuredContent.renderer,'cpu');assert.deepEqual(look.structuredContent.pose.position,[2,1.7,3]);
 const over=await call('look',{from:'overview',size:[256,144]});assert.equal(over.structuredContent.renderer,'cpu');
 // The checklist.
 const check=json(await call('checklist'));
 assert.ok(check.items.some(i=>i.id==='spawn.floor' && i.done));
 // Undo everything since the save: the folder equals its last save again.
 const undone=json(await call('undo',{steps:10}));
 assert.deepEqual(undone.undone,['moved the spawn to 2, 0, 3','made the material deck-wood','set the sky to clear-day']);
 assert.deepEqual(undone.skipped,['created the world Rooftop Test']);
 assert.equal(execFileSync('git',['-C',folder,'status','--porcelain'],{encoding:'utf8'}).trim(),'','undo leaves the folder equal to its last save');
 // Save labels the assistant; history shows it.
 await call('world_set_sky',{preset:'overcast'});
 const saved=json(await call('save',{message:'Overcast for now'}));
 assert.equal(saved.message,'Assistant: Overcast for now');
 const h=json(await call('history'));
 assert.equal(h.history[0].assistant,true);assert.equal(h.history.at(-1).message,'Create Rooftop Test from the Open Plain starter');
 // Discard.
 await call('world_set_floor',{preset:'grass'});
 const discarded=json(await call('discard'));
 assert.ok(discarded.restored.length>0);
 assert.equal(execFileSync('git',['-C',folder,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
 // The prompt and the resources.
 const prompt=(await rpc('prompts/get',{name:'build_a_world',arguments:{description:'a quiet study'}})).result;
 assert.match(prompt.messages[0].content.text,/Plan first[\s\S]*a quiet study$/);
 const resources=(await rpc('resources/list')).result.resources.map(r=>r.uri);
 assert.deepEqual(resources,['hyprune://world/current','hyprune://catalog','hyprune://guide/building']);
 assert.equal(JSON.parse((await rpc('resources/read',{uri:'hyprune://world/current'})).result.contents[0].text).projectId,'rooftop-test');
});

test('hyprune mcp --install-skill copies the skill',t=>{
 const dir=mkdtempSync(join(tmpdir(),'hyprune-skill-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync(process.execPath,[CLI,'mcp','--install-skill',dir]);
 assert.ok(existsSync(join(dir,'hyprune-world-builder','SKILL.md')));
 assert.match(readFileSync(join(dir,'hyprune-world-builder','SKILL.md'),'utf8'),/^---\nname: hyprune-world-builder/);
 assert.ok(existsSync(join(dir,'hyprune-world-builder','examples','rooftop-garden.md')));
});

test('MCP E2 offline: command proposals wait (pending, never tested), HTTP clears them; asset_fetch only from the allowlist; make_world; in-world tools need Hyprune',async t=>{
 const root=mkdtempSync(join(tmpdir(),'hyprune-mcp2-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const cfg=join(root,'gitconfig');writeFileSync(cfg,'[user]\n name = Test Assistant\n email = assistant@example.com\n');
 const http=await import('node:http');
 const png=readFileSync(new URL('./fixtures/import/barrel/staves.png',import.meta.url));
 const srv=http.createServer((req,res)=>{
  if(req.url==='/tex.png'){res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length});res.end(png);}
  else if(req.url==='/away'){res.writeHead(302,{Location:'http://evil.invalid/x.png'});res.end();}
  else {res.writeHead(404);res.end();}
 });
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(()=>srv.close());
 const host=`127.0.0.1:${srv.address().port}`;
 const env={HYPRUNE_PROJECTS_DIR:join(root,'projects'),GIT_CONFIG_GLOBAL:cfg,GIT_CONFIG_NOSYSTEM:'1',XDG_RUNTIME_DIR:join(root,'run'),HYPRLAND_INSTANCE_SIGNATURE:'none',
  HYPRUNE_SOCKET:join(root,'none.sock'),HYPRUNE_SOURCES_CONFIG:join(root,'sources.json'),HYPRUNE_SOURCES_SOCKET:join(root,'none-sources.sock'),
  HYPRUNE_ASSET_HOSTS:`${host}=Test library`,XDG_CACHE_HOME:join(root,'cache')};
 const {rpc,call}=server(t,env);
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Test Client'}});
 const tools=(await rpc('tools/list')).result.tools.map(x=>x.name);
 for(const n of ['source_propose_command','companion_list','companion_choose','companion_name','companion_mode','quest_list','quest_create','registry_search','registry_install','make_world','release_prepare','asset_fetch'])
  assert.ok(tools.includes(n),n);
 // A proposal is written pending; the helper's test is refused; an HTTP definition replaces it without confirmation.
 const p=json(await call('source_propose_command',{id:'cpu-load',argv:['hyprune-system-gauges','cpu'],intervalS:5}));
 assert.equal(p.pending,true);
 const written=JSON.parse(readFileSync(join(root,'sources.json'),'utf8')).sources[0];
 assert.deepEqual([written.id,written.confirm,written.argv],['cpu-load','pending',['hyprune-system-gauges','cpu']]);
 const test=await call('source_test',{id:'cpu-load'});
 assert.equal(test.isError,true);assert.match(json(test).error.message,/after you allow it/);
 await call('source_set_http',{id:'cpu-load',url:'https://example.org/cpu',map:{value:{path:'$.cpu'}}});
 const http2=JSON.parse(readFileSync(join(root,'sources.json'),'utf8')).sources[0];
 assert.equal(http2.kind,'http');assert.ok(!('confirm' in http2) && !('argv' in http2));
 // asset_fetch: the allowlist, redirects checked, provenance recorded.
 const got=json(await call('asset_fetch',{url:`http://${host}/tex.png`,name:'staves'}));
 assert.equal(got.license,'CC0-1.0');assert.equal(got.author,'Test library');assert.equal(got.source,`http://${host}/tex.png`);
 assert.deepEqual(readFileSync(got.path),png);
 assert.equal(json(await call('asset_fetch',{url:'https://example.com/x.png'})).error.code,'asset.host');
 assert.equal(json(await call('asset_fetch',{url:`http://${host}/away`})).error.code,'asset.host','a redirect off the allowlist');
 // make_world on a folder; in-world tools offline.
 await call('world_create',{name:'Make Test',open:false});
 const made=json(await call('make_world'));
 assert.deepEqual(made.homes,[]);assert.equal(typeof made.ready,'boolean');
 for(const [name,args] of [['companion_list',{}],['quest_list',{}],['release_prepare',{version:'0.2.0'}]])
  assert.equal(json(await call(name,args)).error.code,'assistant.offline',name);
 const reg=json(await call('registry_search',{query:'garden'}));
 assert.deepEqual(reg.entries,[]);assert.match(reg.note,/refresh/);
});

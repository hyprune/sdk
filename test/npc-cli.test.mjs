// hyprune npc list|spawn|disable|enable|remove and hyprune path list (IPC 0.23).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {MockDaemon,DEFAULT_SCENARIO} from '../dist/src/mock.js';
import {spawnParams,npcTable,pathTable,NPCS_SINCE} from '../dist/src/npc-cli.js';
const guide='library/com.hyprune.starter@0.1.0/guide';

test('npc spawn flags, tables',()=>{
 assert.deepEqual(spawnParams(guide,{path:'gallery-loop',phase:'0.5',speed:'1.5',accent:'1,0.5,0',reverse:true}),{ref:guide,path:'gallery-loop',phase:0.5,speed:1.5,accent:[1,0.5,0],reverse:true});
 assert.deepEqual(spawnParams(guide,{}),{ref:guide});
 assert.throws(()=>spawnParams(undefined,{}),/needs a character ref/);
 assert.throws(()=>spawnParams(guide,{reverse:true}),/--reverse needs --path/);
 assert.throws(()=>spawnParams(guide,{phase:'1'}),/--phase must be 0\.\.1 \(exclusive\)/);
 assert.throws(()=>spawnParams(guide,{speed:'3'}),/--speed must be 0\.25\.\.2/);
 assert.throws(()=>spawnParams(guide,{accent:'1,2'}),/--accent takes three numbers/);
 const i=(id,over)=>({id,source:'authored',ref:'package/keeper',name:'Keeper',areaId:'',pose:{position:[1,0,2.555],rotation:[0,0,0,1]},scale:1,state:'active',movable:false,locked:false,
  rule:null,path:null,activity:'idle',seat:null,character:true,accent:null,...over});
 assert.equal(npcTable([i('chair',{character:false})]),'no characters');
 assert.equal(npcTable([i('keeper',{path:'package/loop',activity:'walking'}),i('u-1',{source:'user',activity:null,state:'hidden'})]),
  'keeper  authored  active     walking      Keeper  on package/loop\nu-1     user      hidden     -            Keeper  standing at 1,0,2.56');
 const p=(ref,over)=>({ref,source:'user',id:'x',name:null,use:'route',closed:false,points:[],speed:null,stops:[],walkable:true,problems:[],bound:[],...over});
 assert.equal(pathTable([]),'no paths');
 assert.equal(pathTable([p('package/loop',{name:'Loop',bound:['keeper'],points:[{},{}]}),p('user/path-1',{use:'generic',walkable:null}),p('user/path-2',{walkable:false,problems:['no walkable floor at (0.00, 1.00, 0.00)']})]),
  'package/loop  route    walkable      2 points  Loop  [keeper]\nuser/path-1   generic  -             0 points  \nuser/path-2   route    unwalkable    0 points    (no walkable floor at (0.00, 1.00, 0.00))');
 assert.equal(NPCS_SINCE,'0.23');
});

test('hyprune npc and path commands end to end against the 0.23 mock',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hyprune-npccli-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];
 const daemon=new MockDaemon({socket:join(root,'control.sock'),scenario,protocol:'0.23'});await daemon.start();t.after(()=>daemon.stop());
 const run=(args,caps=['state.read','objects.control'])=>new Promise((resolve,reject)=>{
  const token=daemon.issueToken('org.example.cli',caps);
  const child=spawn(process.execPath,['dist/src/cli.js',...args],{stdio:['ignore','pipe','pipe','pipe'],
   env:{...process.env,HYPRUNE_SOCKET:daemon.path,HYPRUNE_CLIENT_ID:'org.example.cli',HYPRUNE_TOKEN_FD:'3',HYPRUNE_PROTOCOL:''}});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(token+'\n');let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(`${code}: ${err}`)));
 });
 assert.match(await run(['npc','list'],['state.read']),/^keeper\s+authored\s+active\s+walking\s+Keeper\s+on package\/gallery-loop$/m);
 assert.match(await run(['path','list'],['state.read']),/^package\/gallery-loop\s+route\s+walkable\s+4 points\s+Gallery loop\s+\[keeper\]$/m);
 const spawned=await run(['npc','spawn',guide,'--path','gallery-loop','--phase','0.5']);assert.match(spawned,/^spawned u-[0-9a-f]{6}$/);
 const id=spawned.slice(8);
 assert.match(await run(['npc','list'],['state.read']),new RegExp(`^${id}\\s+user\\s+active\\s+walking\\s+Guide\\s+on package/gallery-loop$`,'m'));
 assert.equal(await run(['npc','disable','keeper']),'disabled keeper');
 assert.match(await run(['npc','list'],['state.read']),/^keeper\s+authored\s+hidden\s+-/m);
 assert.equal(await run(['npc','enable','keeper']),'enabled keeper');
 await assert.rejects(run(['npc','remove','keeper']),/authored/);
 assert.equal(await run(['npc','remove',id]),`removed ${id}`);
 await run(['npc','spawn',guide]);assert.equal(await run(['npc','remove','--all']),'removed every user character');
 assert.equal(JSON.parse(await run(['npc','list','--json'],['state.read'])).npcs.usage.user,0);
 await assert.rejects(run(['npc','spawn',guide],['state.read']),/Method not advertised: npcs\.spawn/);
 await assert.rejects(run(['npc','list','--protocol','0.22'],['state.read']),/need IPC 0\.23 or newer/);
 await assert.rejects(run(['npc','remove']),/needs a character id or --all/);
 await assert.rejects(run(['npc','dance']),/Unknown command: npc dance/);
 assert.match(await run(['--help']),/hyprune npc spawn <ref>/);
});

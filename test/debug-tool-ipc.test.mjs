// IPC 0.26 on the mock and the validator: tool 9 (the debug tool) on the wire, the companion's
// pace, the 128-item pocket list and mount instances, and what 0.25 peers of a 0.26 listener see.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HypruneClient,validateState} from '../dist/src/index.js';
import {validateWire,PROTOCOLS} from '../dist/src/validation.js';
import {MockDaemon,DEFAULT_SCENARIO,MOCK_PROTOCOLS,DEBUG_TOOL_PROTOCOL,DEBUG_TOOL_GRANTS,COMPANION_GRANTS,DEBUG_TOOL_DEFINITION} from '../dist/src/mock.js';

const CAPS=['state.read','world.control','movement.control','objects.control'];
const guide='library/com.hyprune.starter@0.1.0/guide';
const delta=changes=>({jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:'sub',sessionId:'s',baseRevision:1,revision:2,changes}});

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-debug-tool-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;scenario.notices=[];
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol:'0.26'});await daemon.start();const clients=[];
 async function connect(caps=CAPS,version='0.26',id='org.example.debug') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'0.26 test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};

test('0.26 constants: protocol list, no new grant',()=>{
 assert.ok(PROTOCOLS.includes('0.26'));
 assert.equal(DEBUG_TOOL_PROTOCOL,'0.26');assert.ok(MOCK_PROTOCOLS.includes('0.26'));
 assert.deepEqual(DEBUG_TOOL_GRANTS,COMPANION_GRANTS);
 assert.equal(DEBUG_TOOL_DEFINITION.slot,9);
});

test('0.26 wire: tool 9, editor.debugTool, pace and 128 pocketed windows validate; 0.25 refuses them',()=>{
 const pose={subscriptionId:'hud',sessionId:'s',revision:2,monotonicMs:5,outputId:'output-1',worldId:'w',worldName:'W',position:[0,0,0],heading:0,pitch:0,zone:null,tool:9,subtype:'paths'};
 validateWire({jsonrpc:'2.0',method:'hud.pose',params:pose},'0.26');
 assert.throws(()=>validateWire({jsonrpc:'2.0',method:'hud.pose',params:pose},'0.25'));
 const changed={subscriptionId:'hud',sessionId:'s',revision:2,monotonicMs:5,slot:9,name:'debug',subtype:'collision'};
 validateWire({jsonrpc:'2.0',method:'tool.changed',params:changed},'0.26');
 assert.throws(()=>validateWire({jsonrpc:'2.0',method:'tool.changed',params:changed},'0.25'));
 validateWire({jsonrpc:'2.0',id:'m',method:'companion.mode',params:{mode:'follow',pace:'run'}},'0.26');
 assert.throws(()=>validateWire({jsonrpc:'2.0',id:'m',method:'companion.mode',params:{mode:'follow',pace:'run'}},'0.25'));
 const instance=i=>({surfaceId:`surface-${i}`,workspaceId:20,areaId:'room',anchorId:'',status:'placed'});
 const mounts=n=>({areas:[],anchors:[],bindings:[],placements:[],objects:[],placementZones:[],instances:Array.from({length:n},(_,i)=>instance(i)),carriedSurfaceId:null,desktopWorkspaceId:null});
 validateWire(delta({mounts:mounts(128)}),'0.26');
 assert.throws(()=>validateWire(delta({mounts:mounts(17)}),'0.25'));
});

test('0.26 mock: slot-9 definition, tool9 action, debugTool null, pace through companion.mode and interaction.choose',async t=>{
 const {connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.26');
 await client.subscribe();validateState(client.snapshot,'0.26');
 const s=client.snapshot.state;
 assert.equal(s.editor.debugTool,null);
 assert.deepEqual(s.editor.toolDefinitions.map(d=>d.slot),[1,2,3,4,5,9]);
 assert.deepEqual(s.keymap.config.modes.world.tool9,['9']);
 assert.equal(s.companion.pace,'walk');
 await client.call('companion.set',{ref:guide});
 await client.call('companion.mode',{mode:'follow',pace:'run'});
 await until(()=>client.snapshot.state.companion.pace==='run');
 validateState(client.snapshot,'0.26');
 await client.call('companion.mode',{mode:'stay'});
 await until(()=>client.snapshot.state.companion.mode==='stay');
 assert.equal(client.snapshot.state.companion.pace,'run','the pace stays when only the mode changes');
 await client.call('interaction.choose',{objectId:'companion',interactionId:'walk'});
 await until(()=>client.snapshot.state.companion.pace==='walk');
 await client.call('companion.clear',{});
 await until(()=>client.snapshot.state.companion.state==='none');
 assert.equal(client.snapshot.state.companion.pace,'walk');
 validateState(client.snapshot,'0.26');
});

test('0.25 peers of a 0.26 listener keep the 0.25 shapes',async t=>{
 const {connect}=await fixture(t);
 const old=await connect(CAPS,'0.25','org.example.older');
 assert.equal(old.hello.protocol,'0.25');
 await old.subscribe();validateState(old.snapshot,'0.25');
 const s=old.snapshot.state;
 assert.ok(!('debugTool' in s.editor));
 assert.equal(s.editor.toolDefinitions.length,5);
 assert.ok(!('tool9' in s.keymap.config.modes.world));
 assert.ok(!('pace' in s.companion));
 await assert.rejects(old.call('companion.mode',{mode:'follow',pace:'run'}));
});

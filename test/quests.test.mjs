import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {HypruneClient,validateWire,validateState,PROTOCOLS,atLeast} from '../dist/src/index.js';
import {MockDaemon,DEFAULT_SCENARIO,GRANTS,QUEST_GRANTS,QuestEngine,slugify} from '../dist/src/mock.js';
import {buildQuest,focusParams,questRef,focusLine,QUESTS_SINCE} from '../dist/src/quest-cli.js';
import {parseArgs} from 'node:util';

const req=(method,params)=>({jsonrpc:'2.0',id:'q1',method,params});
const res=result=>({jsonrpc:'2.0',id:'q1',result});
const ref={source:'personal',id:'release-notes'};
const QUEST_CAPS=['state.read','shell.control','quest.control'];

async function fixture(t,protocol='0.21') {
 const dir=await mkdtemp(join(tmpdir(),'hyprune-quests-'));const scenario=structuredClone(DEFAULT_SCENARIO);scenario.path=[];scenario.tickMs=34;
 const daemon=new MockDaemon({socket:join(dir,'control.sock'),scenario,protocol});await daemon.start();const clients=[];
 async function connect(caps=QUEST_CAPS,version='0.21',id='org.example.quests') {
  const client=new HypruneClient({socket:daemon.path,protocol:version,client:{id,name:'quests test'},capabilities:caps,tokenProvider:()=>daemon.issueToken(id,caps),reconnect:false});
  clients.push(client);await client.connect();return client;
 }
 t.after(async()=>{for(const c of clients)c.close();await daemon.stop();await rm(dir,{recursive:true,force:true});});
 return {daemon,connect,dir};
}
const until=async(fn,ms=2000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,15));}};

test('IPC 0.21 is a vendored pin; quest methods validate only at 0.21',()=>{
 assert.ok(PROTOCOLS.includes('0.21'));
 assert.ok(atLeast('0.21',QUESTS_SINCE) && !atLeast('0.20',QUESTS_SINCE) && atLeast('0.30',QUESTS_SINCE));
 const calls=[['markers.reveal',{durationMs:2000}],['guidance.get',{}],['guidance.set',{patch:{'focus.work_min':50}}],['quests.list',{states:['active']}],
  ['quests.get',{questRef:ref}],['quests.track',{questRef:null}],['quests.create',{quest:{title:'Notes',steps:[{title:'Draft'}]}}],
  ['quests.mark',{questRef:ref,stepId:'draft',objectiveId:'done'}],['focus.start',{target:{kind:'workspace',workspaceId:21},overrides:{work_min:50}}],
  ['focus.stop',{}],['focus.history',{days:7}]];
 for(const [m,params] of calls){validateWire(req(m,params),'0.21');assert.throws(()=>validateWire(req(m,params),'0.20'),undefined,m);}
 assert.throws(()=>validateWire(req('markers.reveal',{durationMs:20000}),'0.21'));
 validateWire(res({revision:3,questRef:ref}),'0.21','quests.create');
 validateWire(res({revision:3,sessionId:'focus-ab12'}),'0.21','focus.start');
 assert.throws(()=>validateWire(res({revision:3}),'0.21','focus.start'));
 validateWire({jsonrpc:'2.0',method:'focus.phase',params:{focusSessionId:'focus-ab12',phase:'break',cycle:1,cycles:4,creditedMs:1000,breakKind:'short',sessionId:'s',revision:2}},'0.21');
 assert.throws(()=>validateWire({jsonrpc:'2.0',method:'focus.phase',params:{focusSessionId:'focus-ab12',phase:'break',cycle:1,cycles:4,creditedMs:1000,sessionId:'s',revision:2}},'0.20'));
});

test('0.21 mock: negotiation, state keys, grants and 0.2 isolation',async t=>{
 const {daemon,connect}=await fixture(t);
 const client=await connect();assert.equal(client.hello.protocol,'0.21');
 for(const m of ['markers.reveal','quests.create','focus.start','guidance.set'])assert.ok(client.hello.methods.includes(m),m);
 assert.ok(client.hello.events.includes('quest.progress') && client.hello.events.includes('focus.phase'));
 const snapshot=await client.subscribe();
 for(const k of ['markers','quests','focus'])assert.ok(k in snapshot.state,k);
 assert.equal(snapshot.state.focus.state,'idle');assert.equal(snapshot.state.markers.reveal,null);assert.deepEqual(snapshot.state.quests.active,[]);
 assert.ok(snapshot.state.markers.list.some(m=>m.kind==='waypoint' && m.tier===1));
 assert.deepEqual(snapshot.state.keymap.config.modes.world['markers.reveal'],['Tab']);
 validateState(daemon.questView(daemon.snapshot()),'0.21');
 const reader=await connect(['state.read'],'0.21','org.example.reader');
 assert.ok(reader.hello.methods.includes('quests.list') && !reader.hello.methods.includes('quests.create'));
 await assert.rejects(reader.call('quests.create',{quest:{title:'x',steps:[{title:'y'}]}}),e=>e.code===-32601);
 const legacy=await connect(GRANTS,'0.2','org.example.legacy');assert.equal(legacy.hello.protocol,'0.2');
 assert.ok(!legacy.hello.methods.some(m=>/^(quests|focus|markers|guidance)\./.test(m)));assert.ok(!legacy.hello.events.includes('focus.phase'));
 const old=await legacy.subscribe();for(const k of ['markers','quests','focus','keymap'])assert.equal(k in old.state,false,k);
 // 0.2 peers never see quest events.
 let leaked=false;legacy.on('notification',m=>{if(m.method==='focus.phase')leaked=true;});
 const phase=once(client,'focus.phase');await client.call('focus.start',{});await phase;await client.call('focus.stop',{});
 await new Promise(r=>setTimeout(r,100));assert.equal(leaked,false);
 assert.throws(()=>new MockDaemon({socket:join(tmpdir(),'x.sock'),protocol:'0.20'}),/Unsupported protocol/);
});

test('0.21 mock: personal quest lifecycle, tracking, marking and errors',async t=>{
 const {connect}=await fixture(t);const client=await connect();await client.subscribe();
 const progress=[];client.on('quest.progress',e=>progress.push(e));
 const created=await client.call('quests.create',{quest:{title:'Write the release notes',steps:[{title:'Draft'},{id:'review',title:'Review',target:{zoneId:'gallery'}}]}});
 assert.deepEqual(created.questRef,{source:'personal',id:'write-the-release-notes'});assert.ok(created.revision>0);
 const second=await client.call('quests.create',{quest:{title:'Write the release notes',sequential:false,steps:[{title:'A'},{title:'B',optional:true}]}});
 assert.equal(second.questRef.id,'write-the-release-notes-2');
 await until(()=>client.snapshot.revision>=second.revision);
 assert.deepEqual(client.snapshot.state.quests.tracked,created.questRef,'the first quest is tracked automatically');
 assert.equal(client.snapshot.state.quests.active[0].id,'write-the-release-notes','tracked first');
 assert.deepEqual(client.snapshot.state.quests.counts,{available:0,active:2,completed:0});
 const detail=(await client.call('quests.get',{questRef:created.questRef})).quest;
 assert.deepEqual(detail.steps.map(s=>[s.id,s.state]),[['step-1','current'],['review','pending']]);
 assert.deepEqual(detail.steps[0].objectives,[{id:'done',type:'manual',label:'Done',count:1,done:0}]);
 await assert.rejects(client.call('quests.mark',{questRef:created.questRef,stepId:'review',objectiveId:'done'}),e=>e.code===-32004,'non-current step');
 await assert.rejects(client.call('quests.mark',{questRef:created.questRef,stepId:'nope',objectiveId:'done'}),e=>e.code===-32003);
 await client.call('quests.mark',{questRef:created.questRef,stepId:'step-1',objectiveId:'done'});
 await until(()=>progress.length===1);assert.equal(progress[0].kind,'step');assert.equal(progress[0].nextStepTitle,'Review');assert.equal(progress[0].sessionId,client.hello.sessionId);
 await until(()=>client.snapshot.state.markers.list.some(m=>m.kind==='quest'));
 const marker=client.snapshot.state.markers.list.find(m=>m.kind==='quest');
 assert.equal(marker.tier,1);assert.equal(marker.tracked,true);assert.deepEqual(marker.position,[8,1.7,-2]);assert.equal(marker.source.questId,'personal/write-the-release-notes');
 // Update keeps progress for ids that still exist.
 await client.call('quests.update',{questRef:created.questRef,quest:{title:'Release notes',steps:[{title:'Draft'},{id:'review',title:'Review'},{id:'publish',title:'Publish'}]}});
 const updated=(await client.call('quests.get',{questRef:created.questRef})).quest;
 assert.equal(updated.title,'Release notes');assert.deepEqual(updated.steps.map(s=>s.state),['done','current','pending']);
 await client.call('quests.track',{questRef:null});await client.call('quests.track',{questRef:second.questRef});
 await client.call('quests.abandon',{questRef:second.questRef});
 await assert.rejects(client.call('quests.abandon',{questRef:second.questRef}),e=>e.code===-32004);
 await assert.rejects(client.call('quests.track',{questRef:second.questRef}),e=>e.code===-32004);
 await assert.rejects(client.call('quests.accept',{questRef:created.questRef}),e=>e.code===-32004);
 await client.call('quests.resume',{questRef:second.questRef});
 await assert.rejects(client.call('quests.resume',{questRef:second.questRef}),e=>e.code===-32004,'resume of an active quest');
 // Non-sequential: A is required, B optional; marking A completes the quest.
 await client.call('quests.mark',{questRef:second.questRef,stepId:'step-1',objectiveId:'done'});
 await until(()=>progress.some(e=>e.kind==='completed'));
 const listed=(await client.call('quests.list',{})).quests;assert.deepEqual(listed.map(q=>q.state),['active','completed']);
 assert.deepEqual((await client.call('quests.list',{states:['completed']})).quests.map(q=>q.questRef.id),['write-the-release-notes-2']);
 assert.equal(listed[0].offWorld,false);
 await assert.rejects(client.call('quests.update',{questRef:{source:'com.example.world',id:'x'},quest:{title:'x',steps:[{title:'y'}]}}),e=>e.code===-32007);
 await assert.rejects(client.call('quests.delete',{questRef:{source:'personal',id:'missing'}}),e=>e.code===-32003);
 await assert.rejects(client.call('quests.create',{quest:{title:'Bad',steps:[{title:'a',objectives:[{id:'go',type:'reach'}]}]}}),e=>e.code===-32602);
 await assert.rejects(client.call('quests.create',{quest:{title:'Bad',steps:[{id:'a',title:'a'},{id:'a',title:'b'}]}}),e=>e.code===-32602);
 await client.call('quests.delete',{questRef:second.questRef});
 for(let i=0;i<63;i++)await client.call('quests.create',{quest:{title:`Quest ${i}`,steps:[{title:'Do it'}]}});
 await assert.rejects(client.call('quests.create',{quest:{title:'One too many',steps:[{title:'x'}]}}),e=>e.code===-32008);
 await until(()=>client.snapshot.state.quests.counts.active===64);
 assert.equal(client.snapshot.state.quests.active.length,16);
});

test('0.21 mock: guidance settings and markers.reveal',async t=>{
 const {connect}=await fixture(t);const client=await connect();await client.subscribe();
 const settings=await client.call('guidance.get',{});
 assert.equal(settings.config['markers.reveal_ms'],4000);assert.deepEqual(settings.overrides,{});assert.deepEqual(settings.ranges['focus.work_min'],[5,120]);
 const set=await client.call('guidance.set',{patch:{'markers.persistent':'always','focus.work_min':50}});
 assert.equal(set.config['focus.work_min'],50);assert.deepEqual(set.overrides,{'markers.persistent':'always','focus.work_min':50});
 assert.deepEqual((await client.call('guidance.set',{patch:{'focus.work_min':null}})).overrides,{'markers.persistent':'always'});
 await until(()=>client.snapshot.state.markers.persistent==='always');
 const r=await client.call('markers.reveal',{durationMs:1000});
 await until(()=>client.snapshot.revision>=r.revision);
 assert.deepEqual({...client.snapshot.state.markers.reveal,startedAtMs:0},{startedAtMs:0,holdMs:1000,fadeMs:600,reason:'request'});
 await until(()=>client.snapshot.state.markers.reveal===null,3000);
 await client.call('guidance.set',{patch:{'markers.reveal_mode':'toggle'}});
 await client.call('markers.reveal',{});await until(()=>client.snapshot.state.markers.reveal?.holdMs===0);
 await client.call('markers.reveal',{});await until(()=>client.snapshot.state.markers.reveal===null);
});

test('0.21 mock: focus session pause, resume, skip, stop and history',async t=>{
 const {connect}=await fixture(t);const client=await connect();await client.subscribe();
 const phases=[];client.on('focus.phase',e=>phases.push(e));
 await assert.rejects(client.call('focus.pause',{}),e=>e.code===-32004,'pause when idle');
 const started=await client.call('focus.start',{target:{kind:'workspace',workspaceId:21},overrides:{work_min:30,short_break_min:3,cycles:2}});
 assert.match(started.sessionId,/^focus-[0-9a-f]+$/);
 await assert.rejects(client.call('focus.start',{}),e=>e.code===-32004,'start while running');
 await until(()=>client.snapshot.state.focus.state==='work');
 const work=client.snapshot.state.focus;
 assert.equal(work.phaseMs,1_800_000);assert.equal(work.phaseEndsAtMs-work.phaseStartedAtMs,1_800_000);assert.equal(work.cycle,1);assert.equal(work.cycles,2);
 assert.deepEqual(work.target,{kind:'workspace',label:'Workspace 21',workspaceId:21});assert.equal(work.calm,true);assert.equal(client.snapshot.state.markers.calm,true);
 assert.ok(client.snapshot.state.markers.list.some(m=>m.kind==='focus' && m.target.workspaceId===21));
 await client.call('focus.pause',{});await until(()=>client.snapshot.state.focus.state==='paused');
 assert.equal(client.snapshot.state.focus.pausedState,'work');assert.equal(client.snapshot.state.focus.phaseEndsAtMs,null);assert.equal(client.snapshot.state.markers.calm,false);
 await client.call('focus.resume',{});await until(()=>client.snapshot.state.focus.state==='work');
 await client.call('focus.skip',{});await until(()=>client.snapshot.state.focus.state==='break');
 assert.equal(client.snapshot.state.focus.breakKind,'short');assert.equal(client.snapshot.state.focus.phaseMs,180_000);
 await client.call('focus.skip',{});await until(()=>client.snapshot.state.focus.cycle===2);
 await client.call('focus.stop',{});await until(()=>client.snapshot.state.focus.state==='idle');
 assert.deepEqual(phases.map(p=>p.phase),['work','paused','work','break','work','ended']);
 assert.equal(phases[3].outcome,'skipped');assert.equal(phases[3].counted,false);assert.equal(phases.at(-1).outcome,'stopped');
 assert.ok(phases.every(p=>p.focusSessionId===started.sessionId && p.sessionId===client.hello.sessionId));
 const {intervals}=await client.call('focus.history',{});
 assert.deepEqual(intervals.map(i=>[i.phase,i.outcome]),[['work','stopped'],['break','skipped'],['work','skipped']]);
 assert.ok(intervals.every(i=>i.targetKind==='workspace' && i.workspaceId===21 && !('title' in i)));
});

test('quest engine: a completed work interval credits focus objectives',()=>{
 let now=1000;const engine=new QuestEngine(()=>({zones:[],waypoint:null,loaded:true}),()=>now);
 const {result}=engine.execute('quests.create',{quest:{title:'Deep work',steps:[{title:'Two sessions',objectives:[{id:'sessions',type:'focus',sessions:2,minutes:20}]},{title:'Ship'}]}});
 const questRef=result.questRef;
 engine.execute('focus.start',{questRef,objectiveId:'sessions',overrides:{work_min:25,cycles:2,auto_start_work:true}});
 now+=25*60_000;let hints=engine.tick();
 assert.deepEqual(hints.map(h=>h.params.phase || h.params.kind),['break','objective']);
 assert.equal(hints[0].params.counted,true);assert.deepEqual(hints[1].params.progress,[1,2]);
 now+=5*60_000;hints=engine.tick();assert.deepEqual(hints.map(h=>h.params.phase),['work']);
 now+=10*60_000;engine.execute('focus.pause',{});now+=60*60_000;engine.execute('focus.resume',{});
 assert.equal(engine.state().focus.creditedMs,10*60_000);assert.equal(engine.state().focus.remainingMs,15*60_000);
 now+=15*60_000;hints=engine.tick();
 assert.deepEqual(hints.map(h=>h.params.phase || h.params.kind),['ended','step']);assert.equal(hints[0].params.outcome,'completed');
 const step=engine.execute('quests.get',{questRef}).result.quest.steps[0];
 assert.equal(step.state,'done');assert.equal(step.objectives[0].done,2);assert.equal(step.objectives[0].creditedMinutes,50);
 assert.equal(engine.state().focus.state,'idle');
 // An "any" objective counts sessions not started from the quest; minutes below the bar do not count.
 engine.execute('quests.create',{quest:{title:'Any work',steps:[{title:'One',objectives:[{id:'s',type:'focus',sessions:1,focusTarget:'any'}]}]}});
 engine.execute('focus.start',{overrides:{work_min:10,cycles:1}});now+=10*60_000;hints=engine.tick();
 assert.equal(hints[0].params.counted,false,'10 credited minutes < 0.8 x 25');
 engine.execute('focus.start',{overrides:{work_min:25,cycles:1}});now+=25*60_000;hints=engine.tick();
 assert.equal(hints[0].params.counted,true);assert.equal(hints[1].params.kind,'completed');
 // Expiry fails an active quest (resume allowed).
 engine.execute('quests.create',{quest:{title:'Late',expires:'2000-01-01T00:00',steps:[{title:'x'}]}});hints=engine.tick();
 assert.equal(hints[0].params.kind,'failed');engine.execute('quests.resume',{questRef:{source:'personal',id:'late'}});
 assert.equal(slugify('  Write the Release Notes!  '),'write-the-release-notes');assert.equal(slugify('???'),'quest');
});

test('quest CLI argument building',()=>{
 const parse=args=>parseArgs({args,allowPositionals:true,tokens:true,options:{step:{type:'string',multiple:true},focus:{type:'string',multiple:true}}}).tokens;
 assert.deepEqual(buildQuest('Write the release notes',parse(['--step','Draft','--focus','2'])),
  {title:'Write the release notes',steps:[{title:'Draft',objectives:[{id:'focus',type:'focus',sessions:2}]}]});
 assert.deepEqual(buildQuest('Notes',parse(['--step','Draft','--focus','2','--step','Review'])).steps,
  [{title:'Draft',objectives:[{id:'focus',type:'focus',sessions:2}]},{title:'Review'}]);
 assert.deepEqual(buildQuest('Read the paper',parse(['--focus','3'])).steps,[{title:'Read the paper',objectives:[{id:'focus',type:'focus',sessions:3}]}]);
 assert.deepEqual(buildQuest('Plain',[],{summary:'s',expires:'2026-10-20T18:00',sequential:false}),{title:'Plain',steps:[{title:'Plain'}],summary:'s',expires:'2026-10-20T18:00',sequential:false});
 assert.throws(()=>buildQuest('x',parse(['--focus','2','--step','A'])),/after the --step/);
 assert.throws(()=>buildQuest('x',parse(['--step','A','--focus','13'])),/1\.\.12/);
 assert.deepEqual(questRef('notes'),{source:'personal',id:'notes'});assert.deepEqual(questRef('com.example.world/lantern'),{source:'com.example.world',id:'lantern'});
 assert.deepEqual(focusParams({work:'50',break:'10',cycles:'2',workspace:'21'}),{target:{kind:'workspace',workspaceId:21},overrides:{work_min:50,short_break_min:10,cycles:2}});
 assert.deepEqual(focusParams({app:'org.example.Editor',workspace:'3',quest:'notes',objective:'focus'}),
  {target:{kind:'window',appClass:'org.example.Editor',workspaceId:3},questRef:{source:'personal',id:'notes'},objectiveId:'focus'});
 assert.deepEqual(focusParams({}),{});
 assert.throws(()=>focusParams({work:'0'}));assert.throws(()=>focusParams({objective:'x'}),/needs --quest/);
 assert.equal(focusLine({state:'work',pausedState:null,sessionId:'focus-1',phaseStartedAtMs:0,phaseEndsAtMs:1_500_000,phaseMs:1_500_000,remainingMs:1_500_000,
  creditedMs:65_000,crediting:true,cycle:1,cycles:4,breakKind:null,countMode:'focus',target:{kind:'any',label:'Any window'},calm:true},1_380_000),
  'focus: work 02:00 left · cycle 1/4 · credited 01:05 · Any window');
});

test('hyprune quest/focus commands against the 0.21 mock',async t=>{
 const {daemon}=await fixture(t);
 const run=args=>new Promise((resolve,reject)=>{
  const token=daemon.issueToken('org.example.cli',['state.read','quest.control']);
  const child=spawn(process.execPath,['dist/src/cli.js',...args],{stdio:['ignore','pipe','pipe','pipe'],
   env:{...process.env,HYPRUNE_SOCKET:daemon.path,HYPRUNE_CLIENT_ID:'org.example.cli',HYPRUNE_TOKEN_FD:'3',HYPRUNE_PROTOCOL:''}});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(token+'\n');let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(`${code}: ${err}`)));
 });
 assert.equal(await run(['quest','add','Write the release notes','--step','Draft','--step','Review','--focus','2']),'added write-the-release-notes');
 assert.match(await run(['quest','list']),/^\* write-the-release-notes\s+active\s+0\/2\s+Write the release notes\s+→ Draft \(0\/1\)$/);
 assert.equal(await run(['quest','done','write-the-release-notes','step-1']),'marked step-1/done');
 const shown=JSON.parse(await run(['quest','show','write-the-release-notes']));
 assert.deepEqual(shown.steps.map(s=>s.state),['done','current']);assert.equal(shown.steps[1].objectives[0].label,'2 focus sessions');
 assert.equal(await run(['quest','untrack']),'tracking nothing');assert.equal(await run(['quest','track','write-the-release-notes']),'tracking write-the-release-notes');
 assert.match(await run(['focus','start','--work','50','--break','10','--cycles','2','--workspace','21']),/^focus session focus-[0-9a-f]+ started$/);
 assert.match(await run(['focus','status']),/^focus: work (49:5\d|50:00) left · cycle 1\/2 · credited 00:0\d · Workspace 21$/);
 assert.equal(await run(['focus','pause']),'focus pause');
 assert.equal(JSON.parse(await run(['focus','status','--json'])).pausedState,'work');
 assert.equal(await run(['focus','stop']),'focus stop');assert.equal(await run(['focus','status']),'focus: idle');
 assert.equal(await run(['quest','rm','write-the-release-notes']),'removed write-the-release-notes');
 assert.equal(await run(['quest','list']),'no quests');
 await assert.rejects(run(['quest','list','--protocol','0.20']),/need IPC 0\.21 or newer/);
});

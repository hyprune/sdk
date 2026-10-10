// Compile-only checks: public method and event types follow generated contracts.
import {HypruneClient,clientFromEnvironment,type State} from '../src/index.js';
function check(client:HypruneClient,state:State) {
 client.call('world.load',{worldId:'org.example.world'}).then(result=>{const revision:number=result.revision;void revision;});
 client.on('runtime.notice',notice=>{const level:'info'|'warning'|'error'=notice.level;void level;});
 client.on('state',snapshot=>{const same:State=snapshot.state;void same;});
 // @ts-expect-error missing required subscription ID
 client.call('state.snapshot',{});
 // @ts-expect-error unknown method
 client.call('world.execute',{});
 // @ts-expect-error parameters of another method
 client.call('session.ping',{worldId:'org.example.world'});
 // @ts-expect-error unknown event
 client.on('state.patch',()=>{});
 client.on('runtime.notice',notice=>{
  // @ts-expect-error notices never carry a window title
  console.log(notice.title);
 });
 // @ts-expect-error position is exactly three numbers
 client.call('camera.set',{position:[0,1],orientation:[0,0,0,1]});
 // @ts-expect-error orientation is exactly four numbers
 state.movement.orientation=[0,0,0];
}
void check;

function m1(client:HypruneClient,legacy:HypruneClient<'0.1'>) {
 client.call('data.publish',{sourceId:'org.example.metrics',sequence:1,values:{cpu:2,ok:true,label:'CPU'}});
 client.call('travel.start',{to:{zoneId:'desk'},durationMs:600});
 client.on('location.transition',event=>{const progress:number|null=event.progress;void progress;});
 client.on('state',s=>console.log(s.state.location.transition,s.state.integrations.sources));
 // @ts-expect-error legacy wire has no camera method
 legacy.call('camera.get',{});
 // @ts-expect-error legacy snapshot has exactly the original state keys
 legacy.on('state',s=>console.log(s.state.location));
 // @ts-expect-error sequence is required by real publishing
 client.call('data.publish',{sourceId:'org.example.metrics',values:{cpu:2}});
 // @ts-expect-error nested data values are forbidden
 client.call('data.publish',{sourceId:'org.example.metrics',sequence:1,values:{cpu:{nested:2}}});
 // @ts-expect-error target cannot be an arbitrary package path
 client.call('travel.start',{to:{path:'/tmp/world'}});
}
void m1;

const publisher=clientFromEnvironment({protocol:'0.2',capabilities:['data.publish']});
publisher.call('data.publish',{sourceId:'org.example.metrics',sequence:1,values:{cpu:2}});
const envClient=clientFromEnvironment();
envClient.call('camera.get',{}); // dynamic protocol: unavailable methods reject at runtime
// @ts-expect-error environment-driven clients may be legacy, so location requires narrowing
console.log(envClient.snapshot?.state.location);

function hands(client:HypruneClient<'0.5'>, old:HypruneClient<'0.4'>) {
 client.call('surface.pull',{surfaceId:'terminal'});
 client.on('state',s=>{const slot:number=s.state.interaction.tool;const mode:'movement'|'typing'|'workspace'|'fullscreen'=s.state.interaction.mode;console.log(slot,mode,s.state.apps[0]?.appClass);});
 // @ts-expect-error the frozen 0.4 state has no hands-on mode or app list
 old.on('state',s=>console.log(s.state.interaction));
}
void hands;

function hud(client:HypruneClient<'0.9'>, old:HypruneClient<'0.8'>) {
 client.call('hud.subscribe',{topics:['hud.pose','hud.frame']});
 // @ts-expect-error frozen 0.8 has no opt-in HUD streams
 old.call('hud.subscribe',{topics:['hud.pose']});
 // @ts-expect-error notifications are not callable RPC methods
 client.call('hud.pose',{});
}
void hud;

function performance(client:HypruneClient<'0.10'>, old:HypruneClient<'0.9'>) {
 client.call('graphics.set',{patch:{offload:'on',scale_min:.5,offload_power_cap_w:45}}).then(r=>console.log(r.performance.activeRenderer));
 // @ts-expect-error 0.9 has no offload mutation
 old.call('graphics.set',{patch:{offload:'on'}});
}
void performance;

function recording(client:HypruneClient<'0.12'>, old:HypruneClient<'0.11'>) {
 client.call('recording.start',{includeAppKeys:false});
 client.call('replay.start',{path:'/tmp/session.jsonl',mode:'camera',smoothingMs:100,assertions:{marks:{end:{tool:2}}}}).then(s=>console.log(s.playing));
 // @ts-expect-error 0.11 climbing does not expose input recording
 old.call('recording.start',{});
 // @ts-expect-error camera replay cannot request a native-input injection mode
 client.call('replay.start',{path:'/tmp/session.jsonl',mode:'inject'});
}
void recording;

const photoClient = new HypruneClient({protocol:'0.13',capabilities:['camera.author','state.read']});
void photoClient.call('camera.photo',{position:[0,2,4],orientation:[0,0,0,1],fov:15,lensShift:[.2,0],renderScale:1});
void photoClient.call('camera.release',{});
void photoClient.call('graphics.set',{patch:{outline:true,visibility_culling:false}});

// IPC 0.14 inherits photo controls and exposes a typed nullable ink tier.
declare const inkClient: import('../src/client.js').HypruneClient<'0.14'>;
inkClient.call('graphics.set', {patch:{outline_quality:'smooth'}});
inkClient.call('graphics.set', {patch:{outline_quality:null}});
// @ts-expect-error unsupported tier
inkClient.call('graphics.set', {patch:{outline_quality:'ultra'}});

inkClient.call('graphics.set', {patch:{outline_width_px:3.5,outline_colour:[.2,.4,.6]}});
inkClient.call('graphics.set', {patch:{outline_width_px:null,outline_colour:null}});

// World 0.6 preserves property types alongside its at-least-one-field union.
import type {World06_Document} from '../src/generated.js';
const playable:World06_Document['playable']={volumes:[{type:'convex',points:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]]}],maxFlyHeight:7};
void playable;
// @ts-expect-error height is numeric, even with the anyOf branch
const invalidPlayable:World06_Document['playable']={maxFlyHeight:'high'};
// @ts-expect-error a declaration cannot be empty
const emptyPlayable:World06_Document['playable']={};

// World 0.7 keeps the 0.6 manifest shape under its own format identifier.
import type {World07_Document} from '../src/generated.js';
const format07:World07_Document['formatVersion']='0.7';
void format07;
// @ts-expect-error a 0.7 document is not labelled 0.6
const format06as07:World07_Document['formatVersion']='0.6';

// IPC 0.16 adds a typed nullable upscaler choice and inherits 0.14 ink tiers.
declare const upscalerClient: import('../src/client.js').HypruneClient<'0.16'>;
upscalerClient.call('graphics.set', {patch:{upscaler:'fsr1',outline_quality:'fast'}});
upscalerClient.call('graphics.set', {patch:{upscaler:null}});
// @ts-expect-error unsupported upscaler
upscalerClient.call('graphics.set', {patch:{upscaler:'fsr2'}});
// @ts-expect-error 0.15 sessions cannot write the upscaler
inkClient.call('graphics.set', {patch:{upscaler:'bilinear'}});

// IPC 0.18 makes the offload cap nullable (automatic) up to 1000 W, adds the
// offload device choice and reports the cap source and chosen GPU.
declare const offloadClient: import('../src/client.js').HypruneClient<'0.18'>;
declare const captureClient: import('../src/client.js').HypruneClient<'0.17'>;
offloadClient.call('graphics.set', {patch:{offload_power_cap_w:null,offload_device:'auto',upscaler:'fsr1'}});
offloadClient.call('graphics.set', {patch:{offload_power_cap_w:350,offload_device:'0000:65:00.0'}});
// @ts-expect-error the device is a string, not a render node index
offloadClient.call('graphics.set', {patch:{offload_device:128}});
// @ts-expect-error 0.17 sessions cannot choose the offload device
captureClient.call('graphics.set', {patch:{offload_device:'auto'}});
// @ts-expect-error 0.17 sessions cannot request the automatic cap
captureClient.call('graphics.set', {patch:{offload_power_cap_w:null}});
offloadClient.call('graphics.get', {}).then(({performance})=>{
 const source:'profile'|'device'|'configured'|'fallback'=performance.capSource;void source;
 // @ts-expect-error the device is null until one is chosen
 const pci:string=performance.device.pci;void pci;
 if(performance.device){
  const limit:number|null=performance.device.enforcedLimitW;const own:boolean=performance.device.drivesCompositor;
  const selection:'auto'|'explicit'=performance.device.selection;void limit;void own;void selection;
 }
 const cap:number|null=performance.effective.offload_power_cap_w;void cap;
});
captureClient.call('graphics.get', {}).then(({performance})=>{
 // @ts-expect-error 0.17 Performance records have no cap source
 void performance.capSource;
});

// IPC 0.19 adds typed player settings and the interaction reticle.
declare const playerClient: import('../src/client.js').HypruneClient<'0.19'>;
playerClient.call('player.get', {}).then(r=>{const reach:number=r.config.reach_grab;const bob:'off'|'subtle'|'normal'=r.defaults.view_bob;void reach;void bob;});
playerClient.call('player.set', {patch:{walk_speed:5,reticle_colour:[1,0.5,0],view_bob:null}});
playerClient.call('player.set', {patch:{reticle_colour:'theme',reticle_style:'chevron'}});
playerClient.call('graphics.set', {patch:{offload_device:'auto',fov:120}});
playerClient.on('state', s=>{const state:'hidden'|'neutral'|'typing'|'target'|'valid'|'out_of_range'|'invalid'|'holding'=s.state.interaction.reticle.state;void state;});
// @ts-expect-error unknown reticle style
playerClient.call('player.set', {patch:{reticle_style:'square'}});
// @ts-expect-error run_multiplier is not part of the wire contract
playerClient.call('player.set', {patch:{run_multiplier:2}});
// @ts-expect-error 0.18 sessions have no player settings
offloadClient.call('player.get', {});

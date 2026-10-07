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

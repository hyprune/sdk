// Compile-only checks: public method and event types follow generated contracts.
import {HypruneClient,type State} from '../src/index.js';
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
 client.mockCall('camera.set',{position:[0,1],orientation:[0,0,0,1]});
 // @ts-expect-error orientation is exactly four numbers
 state.movement.orientation=[0,0,0];
}
void check;

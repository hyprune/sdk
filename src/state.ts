import type {Ipc_Snapshot,Ipc_StateDeltaNotification,Ipc02_Snapshot,Ipc02_StateDeltaNotification,Ipc03_Snapshot,Ipc03_StateDeltaNotification,Ipc04_Snapshot,Ipc04_StateDeltaNotification,Ipc05_Snapshot,Ipc05_StateDeltaNotification,Ipc06_Snapshot,Ipc07_Snapshot,Ipc08_Snapshot,Ipc09_Snapshot,Ipc10_Snapshot,Ipc06_StateDeltaNotification,Ipc07_StateDeltaNotification,Ipc08_StateDeltaNotification,Ipc09_StateDeltaNotification,Ipc10_StateDeltaNotification} from './generated.js';
import {validateState,validateWire,type Protocol} from './validation.js';
export type Snapshot<P extends Protocol='0.2'>=P extends '0.1'?Ipc_Snapshot:P extends '0.10'?Ipc10_Snapshot:P extends '0.9'?Ipc09_Snapshot:P extends '0.8'?Ipc08_Snapshot:P extends '0.7'?Ipc07_Snapshot:P extends '0.6'?Ipc06_Snapshot:P extends '0.5'?Ipc05_Snapshot:P extends '0.4'?Ipc04_Snapshot:P extends '0.3'?Ipc03_Snapshot:Ipc02_Snapshot;
export type State<P extends Protocol='0.2'>=Snapshot<P>['state'];
export type Delta<P extends Protocol='0.2'>=P extends '0.1'?Ipc_StateDeltaNotification['params']:P extends '0.10'?Ipc10_StateDeltaNotification['params']:P extends '0.9'?Ipc09_StateDeltaNotification['params']:P extends '0.8'?Ipc08_StateDeltaNotification['params']:P extends '0.7'?Ipc07_StateDeltaNotification['params']:P extends '0.6'?Ipc06_StateDeltaNotification['params']:P extends '0.5'?Ipc05_StateDeltaNotification['params']:P extends '0.4'?Ipc04_StateDeltaNotification['params']:P extends '0.3'?Ipc03_StateDeltaNotification['params']:Ipc02_StateDeltaNotification['params'];
export class StateStore<P extends Protocol='0.2'> {
  snapshot?:Snapshot<P>;
  subscriptionId?:string;
  constructor(readonly protocol:P='0.2' as P) {}
  install(snapshot:Snapshot<P>,subscriptionId:string):void {
    validateState(snapshot,this.protocol);this.snapshot=structuredClone(snapshot);this.subscriptionId=subscriptionId;
  }
  apply(delta:Delta<P>):boolean {
    validateWire({jsonrpc:'2.0',method:'state.delta',params:delta},this.protocol);
    const snapshot=this.snapshot;
    if(!snapshot || delta.subscriptionId!==this.subscriptionId || delta.sessionId!==snapshot.sessionId || delta.baseRevision!==snapshot.revision) return false;
    const next={sessionId:snapshot.sessionId,revision:delta.revision,state:{...snapshot.state,...structuredClone(delta.changes)}} as Snapshot<P>;
    validateState(next,this.protocol);this.snapshot=next;return true;
  }
  reset():void {this.snapshot=undefined;this.subscriptionId=undefined;}
}

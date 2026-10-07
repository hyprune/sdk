import type {Ipc_Snapshot, Ipc_StateDeltaNotification} from './generated.js';
import {validateState, validateWire} from './validation.js';
export type Snapshot=Ipc_Snapshot;
export type State=Snapshot['state'];
export type Delta=Ipc_StateDeltaNotification['params'];
export class StateStore {
  snapshot?: Snapshot;
  subscriptionId?: string;
  install(snapshot: Snapshot, subscriptionId: string): void {
    validateState(snapshot); this.snapshot=structuredClone(snapshot); this.subscriptionId=subscriptionId;
  }
  apply(delta: Delta): boolean {
    validateWire({jsonrpc:'2.0',method:'state.delta',params:delta});
    const s=this.snapshot;
    if(!s || delta.subscriptionId!==this.subscriptionId || delta.sessionId!==s.sessionId || delta.baseRevision!==s.revision) return false;
    const next={sessionId:s.sessionId,revision:delta.revision,state:{...s.state,...structuredClone(delta.changes)}};
    validateState(next); this.snapshot=next; return true;
  }
  reset(): void { this.snapshot=undefined; this.subscriptionId=undefined; }
}

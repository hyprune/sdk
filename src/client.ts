import {EventEmitter} from 'node:events';
import {createConnection, type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {FrameDecoder,encodeFrame} from './codec.js';
import {StateStore,type Snapshot} from './state.js';
import {socketPath} from './paths.js';
import {validateWire,type Protocol} from './validation.js';
import type {Ipc11_Notification, Ipc12_Notification, ProtocolMethods,Ipc_Notification,Ipc02_Notification,Ipc03_Notification,Ipc04_Notification,Ipc05_Notification,Ipc06_Notification,Ipc07_Notification,Ipc08_Notification,Ipc09_Notification,Ipc10_Notification} from './generated.js';
export class RpcError extends Error { constructor(public code:number,message:string,public data?:{retryable:boolean}) { super(message); } }
export interface ClientOptions<P extends Protocol=Protocol> {
  socket?:string; protocol?:P; client?:{id:string;name:string};
  capabilities?:ProtocolMethods[P]['session.hello']['params']['capabilities'];
  /** Called for EVERY connection. Supervisor must return a fresh one-use token. */
  tokenProvider?:()=>Promise<string|undefined>|string|undefined;
  reconnect?:boolean; callTimeoutMs?:number;
}
export type Notification<P extends Protocol='0.2'>=P extends '0.1'?Ipc_Notification:P extends '0.12'?Ipc12_Notification:P extends '0.11'?Ipc11_Notification:P extends '0.10'?Ipc10_Notification:P extends '0.9'?Ipc09_Notification:P extends '0.8'?Ipc08_Notification:P extends '0.7'?Ipc07_Notification:P extends '0.6'?Ipc06_Notification:P extends '0.5'?Ipc05_Notification:P extends '0.4'?Ipc04_Notification:P extends '0.3'?Ipc03_Notification:Ipc02_Notification;
type EventMap<P extends Protocol>={ [N in Notification<P> as N['method']]:N['params'] } & {
  state:Snapshot<P>; notification:Notification<P>; ready:ProtocolMethods[P]['session.hello']['result'];
  fault:Error; disconnect:undefined; reconnecting:number;
};
type MethodsFor<P extends Protocol>=P extends Protocol?keyof ProtocolMethods[P] & string:never;
type CallFor<P extends Protocol,M extends string>=P extends Protocol?M extends keyof ProtocolMethods[P]?ProtocolMethods[P][M]:never:never;
type Pending={method:string;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;apply?:(v:any)=>void};
export class HypruneClient<P extends Protocol='0.2'> extends EventEmitter {
  readonly store:StateStore<P>;
  hello?:ProtocolMethods[P]['session.hello']['result'];
  private socket?:Socket; private pending=new Map<string,Pending>();
  private counter=0; private prefix=''; private stopped=false; private subscribed=false;
  private connecting?:Promise<void>; private retry?:NodeJS.Timeout; private heartbeat?:NodeJS.Timeout;
  private attempts=0; private resyncing=false;private hintRevision=0;
  constructor(readonly options:ClientOptions<P>={} as ClientOptions<P>) { super();this.store=new StateStore(this.protocol); }
  override on<E extends keyof EventMap<P> & string>(event:E,listener:(value:EventMap<P>[E])=>void):this { return super.on(event,listener); }
  get snapshot():Snapshot<P>|undefined { return this.store.snapshot; }
  get protocol():P { return (this.options.protocol || '0.2') as P; }
  async connect():Promise<void> {
    if(this.hello) return;
    if(this.connecting) return this.connecting;
    this.stopped=false;
    this.connecting=this.open().finally(()=>{ this.connecting=undefined; });
    return this.connecting;
  }
  private async open():Promise<void> {
    const token=await this.options.tokenProvider?.();
    if(this.stopped) throw new Error('Client closed');
    const socket=createConnection(this.options.socket || socketPath()); this.socket=socket;
    this.prefix=randomUUID(); this.counter=0; const decoder=new FrameDecoder();
    socket.on('data',chunk=>{ try { decoder.feed(chunk,m=>this.receive(m)); } catch(e) { this.emit('fault',e); socket.destroy(); } });
    socket.on('error',e=>this.emit('fault',e));
    socket.on('close',()=>{
      if(socket!==this.socket) return;
      clearInterval(this.heartbeat); this.hello=undefined; this.store.reset(); this.resyncing=false;this.hintRevision=0;
      for(const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection lost; inspect state before retrying a mutation')); }
      this.pending.clear(); this.emit('disconnect'); this.scheduleReconnect();
    });
    const deadline=setInterval(()=>{ try { decoder.checkDeadline(); } catch(e) { this.emit('fault',e); socket.destroy(); } },1000); deadline.unref(); socket.once('close',()=>clearInterval(deadline));
    await new Promise<void>((resolve,reject)=>{ socket.once('connect',resolve); socket.once('error',reject); socket.once('close',()=>reject(new Error('Connection closed before connect'))); });
    try {
      this.hello=await this.request('session.hello',{protocols:[this.protocol],client:this.options.client || {id:'com.hyprune.sdk',name:'Hyprune SDK'},capabilities:this.options.capabilities || [],...(token?{token}:{})});
      if(this.hello?.protocol!==this.protocol) throw new Error('Protocol mismatch');
      if(this.subscribed) await this.subscribe();
      this.attempts=0; clearTimeout(this.retry);
      this.heartbeat=setInterval(()=>{ this.request('session.ping',{}).catch(e=>{ this.emit('fault',e); socket.destroy(); }); },10_000); this.heartbeat.unref();
      this.emit('ready',this.hello);
    } catch(e) { socket.destroy(); throw e; }
  }
  private scheduleReconnect():void {
    if(this.stopped || this.options.reconnect===false || this.retry) return;
    const delay=Math.min(10_000,250*2**Math.min(this.attempts++,6)*(0.75+Math.random()*0.5));
    this.retry=setTimeout(()=>{ this.retry=undefined; this.connect().catch(e=>{this.emit('fault',e); this.scheduleReconnect();}); },delay);
    this.emit('reconnecting',delay);
  }
  call<M extends MethodsFor<P>>(method:M,params:CallFor<P,M> extends {params:infer T}?T:never):Promise<CallFor<P,M> extends {result:infer T}?T:never> {
    return this.request(method,params);
  }
  private request(method:string,params:unknown,apply?:(v:any)=>void):Promise<any> {
    const socket=this.socket;
    if(!socket || socket.destroyed) return Promise.reject(new Error('Not connected'));
    if(method!=='session.hello' && !this.hello?.methods.includes(method as never)) return Promise.reject(new RpcError(-32601,'Method not advertised: '+method));
    if(this.pending.size>=64) return Promise.reject(new Error('64 outstanding calls exceeded'));
    const id=this.prefix+':'+(++this.counter), message={jsonrpc:'2.0',id,method,params};
    try { validateWire(message,this.protocol); } catch(e) { return Promise.reject(e); }
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ socket.destroy(); reject(new Error('Call deadline; result is uncertain, inspect state before retrying')); },this.options.callTimeoutMs || 30_000);
      this.pending.set(id,{method,resolve,reject,timer,apply});
      try {
        const frame=encodeFrame(message);
        if(socket.writableLength+frame.length>4*1024*1024) throw new Error('Output queue exceeds 4 MiB');
        socket.write(frame);
      } catch(e:any) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private receive(message:unknown):void {
    const m:any=message;
    if(m && Object.hasOwn(m,'id')) {
      const p=this.pending.get(m.id); if(!p) throw new Error('Uncorrelated response ID');
      validateWire(m,this.protocol,m.error?undefined:p.method);
      clearTimeout(p.timer); this.pending.delete(m.id);
      if(m.error) p.reject(new RpcError(m.error.code,m.error.message,m.error.data));
      else { try { p.apply?.(m.result); p.resolve(m.result); } catch(e:any) { p.reject(e); throw e; } }
      return;
    }
    validateWire(m,this.protocol);
    if(!this.hello || !this.hello.events.includes(m.method as never)) throw new Error('Unadvertised event');
    if(m.method!=='state.delta' && m.params && Object.hasOwn(m.params,'sessionId')) {
      if(m.params.sessionId!==this.hello.sessionId || this.resyncing || m.params.revision<Math.max(this.snapshot?.revision || 0,this.hintRevision)) return;
      this.hintRevision=m.params.revision;
    }
    if(m.method==='state.delta') {
      if(this.resyncing) return;
      if(!this.store.apply(m.params)) {
        this.resyncing=true;
        this.resync().catch(e=>{ this.emit('fault',e); this.socket?.destroy(); });
      } else this.emit('state',this.snapshot);
    }
    if(m.method==='session.revoked') { this.stopped=true; this.socket?.destroy(); }
    this.emit('notification',m); this.emit(m.method,m.params);
  }
  async subscribe():Promise<Snapshot<P>> {
    this.subscribed=true;
    const result=await this.request('state.subscribe',{topics:['state']},r=>{
      if(r.snapshot.sessionId!==this.hello?.sessionId) throw new Error('Snapshot session mismatch');
      this.store.install(r.snapshot,r.subscriptionId);this.hintRevision=r.snapshot.revision; this.emit('state',this.snapshot);
    });
    return result.snapshot;
  }
  async resync():Promise<Snapshot<P>> {
    this.resyncing=true;
    let result;
    try { result=await this.request('state.snapshot',{subscriptionId:this.store.subscriptionId},r=>{
      if(r.snapshot.sessionId!==this.hello?.sessionId) throw new Error('Snapshot session mismatch');
      this.store.install(r.snapshot,this.store.subscriptionId!);this.hintRevision=r.snapshot.revision; this.resyncing=false; this.emit('state',this.snapshot);
    }); } catch(e) { this.socket?.destroy(); throw e; }
    return result.snapshot;
  }
  async unsubscribe():Promise<void> {
    await this.request('state.unsubscribe',{subscriptionId:this.store.subscriptionId!}); this.subscribed=false; this.store.reset();
  }
  close():void { this.stopped=true; clearTimeout(this.retry); this.retry=undefined; clearInterval(this.heartbeat); this.socket?.destroy(); }
}

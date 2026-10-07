import {createServer,createConnection,type Server,type Socket} from 'node:net';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {chmodSync,lstatSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {FrameDecoder,FrameError,encodeFrame,MAX_FRAME} from './codec.js';
import {secureDirectory,socketPath} from './paths.js';
import {validateWire,validateState,type Protocol} from './validation.js';
import {RpcError} from './client.js';
import type {State,Snapshot} from './state.js';
import type {Common_Capability,Mock_WaypointSetParams,Mock_WorldMetadataNotification} from './generated.js';
export const GRANTS:Common_Capability[]=['state.read','world.control','surface.control','movement.control','shell.control','runtime.control'];
const requirements:Record<string,Common_Capability|undefined>={
 'session.hello':undefined,'session.ping':undefined,'state.subscribe':'state.read','state.snapshot':'state.read','state.unsubscribe':'state.read',
 'world.load':'world.control','surface.focus':'surface.control','movement.set':'movement.control',
 'shell.claim':'shell.control','shell.release':'shell.control','shell.overlay':'shell.control','runtime.exit':'runtime.control',
 'camera.set':'movement.control','waypoint.set':'world.control','ui.open':'shell.control','data.publish':'state.read'
};
export interface Scenario {
 state:State;
 path:Array<[number,number,number]>;
 worlds:Array<{id:string;spawns:string[]}>;
 zones:Mock_WorldMetadataNotification['params']['zones'];
 waypoint:Mock_WaypointSetParams;
 notices:Array<{atMs:number;level:'info'|'warning'|'error';code:string;message:string}>;
 transactions?:Array<{atMs:number;changes:Partial<State>}>;
 tickMs?:number;
}
export const DEFAULT_SCENARIO:Scenario={
 state:{runtime:{active:true,outputs:['output-main']},world:{id:'com.hyprune.observatory',spawnId:'arrival'},surfaces:[
 {id:'surface-terminal',kind:'window',title:'Terminal · sdk',logicalSize:[1000,700],focused:true},
 {id:'surface-browser',kind:'window',title:'Hyprune documentation',logicalSize:[1280,900],focused:false},
 {id:'surface-music',kind:'window',title:'Music · ambient',logicalSize:[600,400],focused:false}],
 movement:{modeId:'com.hyprune.fly',position:[0,1.7,0],orientation:[0,0,0,1]},shell:{leases:[]}},
 path:[[0,1.7,0],[3,1.7,-2],[2,2,-5],[-3,1.7,-3],[0,1.7,0]],
 worlds:[{id:'com.hyprune.observatory',spawns:['arrival','desk']},{id:'com.hyprune.garden',spawns:['arrival']}],
 zones:[{id:'work',name:'Work nook',bounds:{min:[-4,0,-6],max:[4,4,1]}},{id:'gallery',name:'Gallery',bounds:{min:[4,0,-6],max:[12,4,2]}}],
 waypoint:{id:'desk',position:[2,1.7,-4],label:'Work desk'},
 notices:[{atMs:500,level:'info',code:'mock.ready',message:'Observatory ready. Follow the path to the work nook.'},{atMs:5000,level:'warning',code:'mock.demo',message:'This is a synthetic development session.'}],tickMs:100
};
type Grant={token:string;clientId:string;capabilities:Common_Capability[];expires:number};
type Peer={socket:Socket;decoder:FrameDecoder;hello:boolean;grants:Common_Capability[];methods:string[];ids:Set<string>;subscription?:string;baseline:number;leases:Set<string>;timer:NodeJS.Timeout;closing:boolean};
export class MockDaemon {
 readonly sessionId=randomUUID(); revision=0; state:State; readonly scenario:Scenario;
 readonly protocol:Protocol; readonly path:string;
 private server?:Server; private peers=new Set<Peer>(); private tokens:Grant[]=[];
 private tick?:NodeJS.Timeout; private flush?:NodeJS.Timeout; private scripted:NodeJS.Timeout[]=[];
 private started=0; private lastPose=0; private data=new Map<string,unknown>();
 constructor(options:{socket?:string;protocol?:Protocol;scenario?:Scenario}={}) {
  this.path=options.socket || socketPath(); this.protocol=options.protocol || '0.1';
  this.scenario=structuredClone(options.scenario || DEFAULT_SCENARIO); this.state=structuredClone(this.scenario.state);
  validateState(this.snapshot());
  if(!Array.isArray(this.scenario.path) || this.scenario.path.some(p=>p.length!==3 || p.some(n=>!Number.isFinite(n)))) throw new Error('Scenario path requires finite vec3 points');
  if(this.scenario.tickMs!==undefined && (!Number.isFinite(this.scenario.tickMs) || this.scenario.tickMs<34)) throw new Error('tickMs must be >=34');
  validateWire({jsonrpc:'2.0',method:'world.metadata',params:this.metadata()},'0.1-mock.1');
  for(const world of this.scenario.worlds) {
    if(!world.spawns.length || new Set(world.spawns).size!==world.spawns.length) throw new Error('Scenario world requires unique spawns');
    for(const spawnId of world.spawns) validateState({...this.snapshot(),state:{...this.state,world:{id:world.id,spawnId}}});
  }
  if(this.scenario.zones.some(z=>z.bounds.min.some((n,i)=>n>=z.bounds.max[i]))) throw new Error('Scenario zone bounds must be ordered');
  for(const t of this.scenario.transactions || []) {
    if(!Number.isFinite(t.atMs) || t.atMs<0) throw new Error('Invalid scenario time');
    validateState({...this.snapshot(),state:{...this.state,...t.changes}});
  }
  for(const n of this.scenario.notices) { const {atMs,...params}=n; if(!Number.isFinite(atMs) || atMs<0) throw new Error('Invalid notice time'); validateWire({jsonrpc:'2.0',method:'runtime.notice',params}); }
 }
 snapshot():Snapshot { return {sessionId:this.sessionId,revision:this.revision,state:structuredClone(this.state)}; }
 /** Test/developer supervisor API. Never exposed on the public wire. */
 issueToken(clientId:string,capabilities:Common_Capability[],ttlMs=60_000):string {
  validateWire({jsonrpc:'2.0',id:'grant',method:'session.hello',params:{protocols:[this.protocol],client:{id:clientId,name:'supervised'},capabilities}});
  const token=randomBytes(32).toString('hex'); this.tokens=this.tokens.filter(t=>t.expires>Date.now());
  this.tokens.push({token,clientId,capabilities:[...capabilities],expires:Date.now()+ttlMs}); return token;
 }
 async start():Promise<void> {
  secureDirectory(dirname(this.path));
  try {
    const st=lstatSync(this.path);
    if(!st.isSocket() || st.isSymbolicLink() || st.uid!==process.getuid?.()) throw new Error('Refusing to replace unsafe socket');
    const alive=await new Promise<boolean>((resolve,reject)=>{const s=createConnection(this.path); s.once('connect',()=>{s.destroy();resolve(true);}); s.once('error',(e:any)=>{s.destroy();if(e.code==='ECONNREFUSED') resolve(false); else reject(e);});});
    if(alive) throw new Error('Socket already has a live listener'); unlinkSync(this.path);
  } catch(e:any) { if(e.code!=='ENOENT') throw e; }
  this.server=createServer(s=>this.accept(s));
  await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.path,resolve);});
  chmodSync(this.path,0o600); this.started=Date.now();
  this.flush=setInterval(()=>this.flushDeltas(),34);
  this.tick=setInterval(()=>this.advance(),this.scenario.tickMs || 100);
  for(const n of this.scenario.notices) this.scripted.push(setTimeout(()=>{ const {atMs,...params}=n; this.broadcast('runtime.notice',params); },n.atMs));
  for(const t of this.scenario.transactions || []) this.scripted.push(setTimeout(()=>this.commit(t.changes),t.atMs));
 }
 async stop():Promise<void> {
  clearInterval(this.tick); clearInterval(this.flush); for(const t of this.scripted) clearTimeout(t);
  for(const p of this.peers) p.socket.destroy();
  if(this.server) await new Promise<void>((resolve,reject)=>this.server!.close(e=>e?reject(e):resolve()));
 }
 /** Fault/revocation hooks for conformance harnesses. */
 disconnectClients():void { for(const p of this.peers) p.socket.destroy(); }
 revokeClients(reason='Mock approval revoked'):void { for(const p of this.peers) { if(p.hello) this.send(p,{jsonrpc:'2.0',method:'session.revoked',params:{reason}}); p.closing=true; p.socket.end(); } }
 private accept(socket:Socket):void {
  // Node does not expose SO_PEERCRED portably. This mock is trusted local tooling,
  // not a production authorization boundary; see NOTES-rfc-gaps.md.
  const p:Peer={socket,decoder:new FrameDecoder(),hello:false,grants:[],methods:[],ids:new Set(),baseline:0,leases:new Set(),timer:setTimeout(()=>socket.destroy(),5000),closing:false};
  this.peers.add(p);
  const deadline=setInterval(()=>{try{p.decoder.checkDeadline();}catch{socket.destroy();}},1000);
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
    if(p.closing) return;
    try { p.decoder.feed(chunk,m=>{if(!p.closing) this.handle(p,m);}); }
    catch(e) { p.closing=true; if(e instanceof FrameError && e.parseError) {this.error(p,null,-32700,'Parse error');socket.end();} else socket.destroy(); }
  });
  socket.on('close',()=>{
    clearTimeout(p.timer);clearInterval(deadline);this.peers.delete(p);
    if(p.leases.size) this.commit({shell:{leases:this.state.shell.leases.filter(l=>!p.leases.has(l.id))}});
  });
 }
 private send(p:Peer,m:unknown):void {
  validateWire(m,this.protocol); const frame=encodeFrame(m);
  if(p.socket.writableLength+frame.length>4*1024*1024) {p.socket.destroy();return;}
  p.socket.write(frame);
 }
 private error(p:Peer,id:string|null,code:number,message:string):void { this.send(p,{jsonrpc:'2.0',id,error:{code,message}}); }
 private handle(p:Peer,message:unknown):void {
  const m:any=message; let id:string|null=m && typeof m.id==='string' && m.id.length>0 && m.id.length<=128?m.id:null;
  try {
    if(!m || Array.isArray(m) || typeof m!=='object' || m.jsonrpc!=='2.0' || typeof m.id!=='string' || !m.id.length || m.id.length>128 || typeof m.method!=='string' || !Object.hasOwn(m,'params') || Object.keys(m).some(k=>!['jsonrpc','id','method','params'].includes(k))) throw new RpcError(-32600,'Invalid request profile');
    id=m.id;
    if(p.ids.has(m.id)) throw new RpcError(-32600,'Request ID reused');
    // Bound bookkeeping: close instead of forgetting IDs and allowing reuse.
    if(p.ids.size>=100_000) throw new RpcError(-32008,'Connection request limit; reconnect');
    p.ids.add(m.id);
    if(!p.hello && m.method!=='session.hello') throw new RpcError(-32600,'First request must be session.hello');
    if(p.hello && m.method==='session.hello') throw new RpcError(-32600,'Hello already complete');
    if(p.hello && !p.methods.includes(m.method)) throw new RpcError(-32601,'Method not advertised');
    try { validateWire(m,this.protocol); } catch { throw new RpcError(-32602,'Invalid params'); }
    if(m.method==='session.hello') {
      if(!m.params.protocols.includes(this.protocol)) {this.error(p,id,-32001,'Incompatible protocol');p.closing=true;p.socket.end();return;}
      if(m.params.token) {
        const index=this.tokens.findIndex(t=>t.clientId===m.params.client.id && t.expires>Date.now() && timingSafeEqual(Buffer.from(t.token),Buffer.from(m.params.token)));
        if(index<0) throw new RpcError(-32002,'Invalid launch token');
        const [grant]=this.tokens.splice(index,1);
        p.grants=m.params.capabilities.filter((c:Common_Capability)=>grant.capabilities.includes(c));
      }
      p.methods=Object.keys(requirements).filter(k=>(!requirements[k] || p.grants.includes(requirements[k]!)) && (this.protocol==='0.1-mock.1' || !['camera.set','waypoint.set','ui.open','data.publish'].includes(k)));
      p.hello=true;clearTimeout(p.timer);
      this.send(p,{jsonrpc:'2.0',id,result:{protocol:this.protocol,sessionId:this.sessionId,capabilities:p.grants,methods:p.methods,events:p.grants.includes('state.read')?['state.delta','runtime.notice','session.revoked',...(this.protocol==='0.1-mock.1'?['world.metadata','data.updated','ui.opened']:[])]:['session.revoked']}});
      return;
    }
    const params=m.params; let result:any;
    switch(m.method) {
      case 'session.ping': result={monotonicMs:Math.floor(performance.now())};break;
      case 'state.subscribe':
        if(p.subscription) throw new RpcError(-32004,'Already subscribed');
        p.subscription=randomUUID();p.baseline=this.revision;result={subscriptionId:p.subscription,snapshot:this.snapshot()};break;
      case 'state.snapshot': this.subscription(p,params.subscriptionId);p.baseline=this.revision;result={snapshot:this.snapshot()};break;
      case 'state.unsubscribe': this.subscription(p,params.subscriptionId);p.subscription=undefined;result={ok:true};break;
      case 'world.load': {
        const world=this.scenario.worlds.find(w=>w.id===params.worldId); if(!world) throw new RpcError(-32003,'World is not installed');
        const spawn=params.spawnId || world.spawns[0]; if(!world.spawns.includes(spawn)) throw new RpcError(-32003,'Unknown spawn');
        this.lastPose=Date.now();this.commit({world:{id:world.id,spawnId:spawn},runtime:{...this.state.runtime,active:true},movement:{...this.state.movement,position:[0,1.7,0],modeId:'com.hyprune.fly'}});result={revision:this.revision};break;
      }
      case 'surface.focus':
        if(!this.state.surfaces.some(s=>s.id===params.surfaceId)) throw new RpcError(-32003,'Unknown surface');
        if(params.intent==='keyboard') this.commit({surfaces:this.state.surfaces.map(s=>({...s,focused:s.id===params.surfaceId}))});
        result={revision:this.revision};break;
      case 'movement.set':
        if(params.modeId!=='com.hyprune.fly') throw new RpcError(-32007,'Mock only implements free flight');
        this.commit({movement:{...this.state.movement,modeId:params.modeId}});result={revision:this.revision};break;
      case 'shell.claim': {
        if(params.outputs.some((o:string)=>!this.state.runtime.outputs.includes(o))) throw new RpcError(-32003,'Unknown output');
        if(this.state.shell.leases.some(l=>l.outputs.some(o=>params.outputs.includes(o)))) throw new RpcError(-32004,'Output already claimed');
        const leaseId=randomUUID();p.leases.add(leaseId);this.commit({shell:{leases:[...this.state.shell.leases,{id:leaseId,outputs:params.outputs,overlays:[]}]}});result={leaseId,revision:this.revision};break;
      }
      case 'shell.release': this.lease(p,params.leaseId);p.leases.delete(params.leaseId);this.commit({shell:{leases:this.state.shell.leases.filter(l=>l.id!==params.leaseId)}});result={revision:this.revision};break;
      case 'shell.overlay': case 'ui.open': {
        const lease=this.lease(p,params.leaseId); if(!lease.outputs.includes(params.outputId)) throw new RpcError(-32003,'Output outside lease');
        const overlay={outputId:params.outputId,visible:m.method==='ui.open'?true:params.visible,exclusiveInput:m.method==='ui.open'?false:params.exclusiveInput};
        this.commit({shell:{leases:this.state.shell.leases.map(l=>l.id===lease.id?{...l,overlays:[...l.overlays.filter(o=>o.outputId!==params.outputId),overlay]}:l)}});result={revision:this.revision};break;
      }
      case 'runtime.exit': this.commit({runtime:{...this.state.runtime,active:false},shell:{leases:[]}});for(const peer of this.peers) peer.leases.clear(); result={revision:this.revision};break;
      case 'camera.set': this.lastPose=Date.now();this.commit({movement:{...this.state.movement,position:params.position,orientation:params.orientation}});result={revision:this.revision};break;
      case 'waypoint.set': this.scenario.waypoint=structuredClone(params);this.broadcast('world.metadata',this.metadata());result={revision:this.revision};break;
      case 'data.publish': this.data.set(params.sourceId,structuredClone(params));this.broadcast('data.updated',params);result={revision:this.revision};break;
      default: throw new RpcError(-32601,'Unimplemented');
    }
    this.send(p,{jsonrpc:'2.0',id,result});
    if(m.method==='ui.open') this.broadcast('ui.opened',params);
    if(['state.subscribe','state.snapshot','world.load'].includes(m.method) && this.protocol==='0.1-mock.1') {this.send(p,{jsonrpc:'2.0',method:'world.metadata',params:this.metadata()});for(const values of this.data.values()) this.send(p,{jsonrpc:'2.0',method:'data.updated',params:values});}
  } catch(e) {
    const error=e instanceof RpcError?e:new RpcError(-32603,'Internal error');this.error(p,id,error.code,error.message);
    if(!p.hello || id===null || error.code===-32008) {p.closing=true;p.socket.end();}
  }
 }
 private subscription(p:Peer,id:string):void { if(!p.subscription || p.subscription!==id) throw new RpcError(-32003,'Unknown subscription'); }
 private lease(p:Peer,id:string) {const l=this.state.shell.leases.find(l=>l.id===id);if(!l || !p.leases.has(id)) throw new RpcError(-32004,'Stale or foreign lease');return l;}
 private metadata() {return {worldId:this.state.world?.id || this.scenario.worlds[0].id,zones:this.scenario.zones,waypoint:this.scenario.waypoint};}
 commit(changes:Partial<State>):void {
  const next={...this.state,...structuredClone(changes)};
  if(this.revision>=Number.MAX_SAFE_INTEGER) throw new RpcError(-32008,'Session revision exhausted');
  const snapshot={sessionId:this.sessionId,revision:this.revision+1,state:next};validateState(snapshot);
  if(encodeFrame({jsonrpc:'2.0',id:'x',result:{subscriptionId:randomUUID(),snapshot}}).length>MAX_FRAME-4096) throw new RpcError(-32008,'State exceeds frame budget');
  this.state=next;this.revision++;
 }
 private flushDeltas():void {
  for(const p of this.peers) if(p.subscription && p.baseline!==this.revision) {
    // Whole-key replacements allow coalescing without per-peer patch journals.
    this.send(p,{jsonrpc:'2.0',method:'state.delta',params:{subscriptionId:p.subscription,sessionId:this.sessionId,baseRevision:p.baseline,revision:this.revision,changes:this.state}});p.baseline=this.revision;
  }
 }
 private broadcast(method:string,params:unknown):void {for(const p of this.peers) if(p.hello && p.grants.includes('state.read')) this.send(p,{jsonrpc:'2.0',method,params});}
 private advance():void {
  const path=this.scenario.path;if(path.length<2 || !this.state.runtime.active || Date.now()-this.lastPose<1000) return;
  const t=((Date.now()-this.started)/2500)%(path.length-1),i=Math.floor(t),f=t-i;
  const position=path[i].map((n,j)=>n+(path[i+1][j]-n)*f) as [number,number,number];
  this.commit({movement:{...this.state.movement,position}});
 }
}

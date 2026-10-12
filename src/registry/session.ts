// A running session, when one is reachable (DESIGN phase-1 shape): the loaded world (for the
// world.active rule) and, with the objects.control grant, core's libraries.install/remove.
// Without a session the CLI commits everything itself.
import {existsSync,readFileSync,closeSync} from 'node:fs';
import {HypruneClient} from '../client.js';
import {socketPath} from '../paths.js';
import {PROTOCOLS,atLeast,type Protocol} from '../validation.js';
import {RpcError} from '../client.js';
import {RegistryError} from './errors.js';

type Env=Record<string,string|undefined>;
export interface Session {
 /** The world loaded in the session, or null. */
 loadedWorld:string|null;
 /** True when core advertises libraries.install to this client (objects.control granted). */
 canInstallLibraries:boolean;
 installLibrary(archive:string,sha256:string):Promise<{id:string;version:string}>;
 removeLibrary(id:string,version:string):Promise<void>;
 close():void;
}
export const LIBRARIES_SINCE='0.22';
/** The launch token from HYPRUNE_TOKEN_FD, read once (the FD is closed). */
function launchToken(env:Env):string|undefined {
 const raw=env.HYPRUNE_TOKEN_FD;if(raw===undefined) return undefined;
 delete env.HYPRUNE_TOKEN_FD;
 if(!/^\d+$/.test(raw) || Number(raw)<3) throw new Error('HYPRUNE_TOKEN_FD must name an inherited FD >=3');
 const fd=Number(raw);let token:string;try {token=readFileSync(fd,'utf8');} finally {closeSync(fd);}
 if(!/^[a-f0-9]{64}\n$/.test(token)) throw new Error('Invalid inherited token');
 return token.slice(0,64);
}
const mapRpc=(e:unknown)=>{
 if(e instanceof RpcError) {
  const rule=(e.data as any)?.rule;
  if(/conflict/.test(e.message) || rule==='library.conflict') return new RegistryError('content.conflict',e.message);
  if(/system librar/i.test(e.message)) return new RegistryError('managed.system',e.message);
  if(/sha256/i.test(e.message)) return new RegistryError('hash.mismatch',e.message);
  return new RegistryError('package.invalid',`core: ${e.message}`);
 }
 return e;
};
/**
 * Connect to the session named by HYPRUNE_SOCKET (else the instance socket) when it exists.
 * Returns null when no session is reachable; `reason` explains why (for --verbose output).
 */
export async function openSession(env:Env=process.env,{timeoutMs=5000}:{timeoutMs?:number}={}):Promise<{session:Session|null;reason:string}> {
 let path:string;
 try {path=env.HYPRUNE_SOCKET || socketPath(env);} catch {return {session:null,reason:'no session environment'};}
 if(!existsSync(path)) return {session:null,reason:`no session socket at ${path}`};
 const wanted=env.HYPRUNE_PROTOCOL || LIBRARIES_SINCE;
 if(!(PROTOCOLS as readonly string[]).includes(wanted) || !atLeast(wanted,LIBRARIES_SINCE)) return {session:null,reason:`IPC ${wanted} is older than ${LIBRARIES_SINCE}`};
 let token:string|undefined;
 try {token=launchToken(env);} catch(e:any) {return {session:null,reason:e.message};}
 const client=new HypruneClient({socket:path,protocol:wanted as Protocol,client:{id:env.HYPRUNE_CLIENT_ID || 'com.hyprune.sdk',name:'Hyprune content'},
  capabilities:['state.read','objects.control'] as any,reconnect:false,tokenProvider:()=>token});
 client.on('fault',()=>{});
 try {
  await Promise.race([client.connect(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('session connect timeout')),timeoutMs).unref())]);
 } catch(e:any) {client.close();return {session:null,reason:`session not reachable: ${e.message}`};}
 const methods=(client.hello?.methods ?? []) as string[];
 let loadedWorld:string|null=null;
 if(methods.includes('state.subscribe')) {
  try {const snapshot:any=await client.subscribe();loadedWorld=snapshot?.state?.world?.id ?? null;} catch {}
 }
 const session:Session={
  loadedWorld,
  canInstallLibraries:methods.includes('libraries.install'),
  async installLibrary(archive,sha256) {
   try {const r:any=await (client as any).call('libraries.install',{archive,sha256});return {id:r.id,version:r.version};} catch(e) {throw mapRpc(e);}
  },
  async removeLibrary(id,version) {
   try {await (client as any).call('libraries.remove',{id,version});} catch(e) {throw mapRpc(e);}
  },
  close:()=>client.close(),
 };
 return {session,reason:'connected'};
}

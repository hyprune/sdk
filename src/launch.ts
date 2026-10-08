import {readFileSync,closeSync} from 'node:fs';
import {HypruneClient,type ClientOptions} from './client.js';
import type {Protocol} from './validation.js';
/** Developer launch convention; tokens never appear in argv/logs or files. */
export function clientFromEnvironment<P extends Protocol=Protocol>(options:ClientOptions<P>={} as ClientOptions<P>):HypruneClient<P> {
 const protocol=options.protocol || process.env.HYPRUNE_PROTOCOL || '0.2';if(!['0.1','0.2','0.3','0.4','0.5'].includes(protocol)) throw new Error('Unsupported HYPRUNE_PROTOCOL');
 let consumed=false;
 return new HypruneClient({socket:process.env.HYPRUNE_SOCKET,protocol:protocol as P,
 client:{id:process.env.HYPRUNE_CLIENT_ID || 'com.hyprune.sdk',name:'Hyprune SDK tool'},
 capabilities:['state.read'],reconnect:false,...options,tokenProvider:options.tokenProvider || (()=>{
  if(consumed) throw new Error('Reconnect needs a fresh supervisor tokenProvider');consumed=true;
  const raw=process.env.HYPRUNE_TOKEN_FD;delete process.env.HYPRUNE_TOKEN_FD;
  if(raw===undefined) return undefined;
  if(!/^\d+$/.test(raw) || Number(raw)<3) throw new Error('HYPRUNE_TOKEN_FD must name an inherited FD >=3');
  const fd=Number(raw);let token:string;try{token=readFileSync(fd,'utf8');}finally{closeSync(fd);}
  if(!/^[a-f0-9]{64}\n$/.test(token)) throw new Error('Invalid inherited token');return token.slice(0,64);
 })});
}

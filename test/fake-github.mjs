// A fake GitHub (REST API subset, release downloads with Range) and index host on 127.0.0.1,
// for registry tests without network. Shared with the registry repository's CI tests.
// Clients reach it with HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP=1,
// HYPRUNE_GITHUB_API=<url>/api and HYPRUNE_GITHUB_DOWNLOAD=<url>/dl.
import http from 'node:http';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/**
 * Start the server. State is plain data the test can change at any time:
 * - repos: Map "owner/repo" → {topics, collaborators: {login: permission}, tags: {tag: {commit, annotated}},
 *   releases: [{tag_name, draft, prerelease, published_at, assets: [{name, bytes: Buffer}]}]}
 * - indexes: Map name → Buffer|object served at /index/<name>.json
 * Every request is logged in `requests` ({method, path, headers}).
 */
export async function startFakeGithub() {
 const repos=new Map(),indexes=new Map(),requests=[];let uploads=0;
 let base='';
 const repo=(o,r)=>repos.get(`${o}/${r}`.toLowerCase());
 const send=(res,status,body,headers={})=>{
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  res.writeHead(status,{'content-length':bytes.length,'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json',...headers});res.end(bytes);
 };
 const assetJson=(o,r,tag,a)=>({name:a.name,size:a.bytes.length,updated_at:a.updated ?? '2026-10-12T10:00:00Z',browser_download_url:`${base}/dl/${o}/${r}/releases/download/${encodeURIComponent(tag)}/${a.name}`});
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,base),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  requests.push({method:req.method,path:url.pathname+url.search,headers:{...req.headers}});
  if(parts[0]==='redirect') {res.writeHead(302,{location:url.searchParams.get('to')});res.end();return;}
  if(parts[0]==='index' && parts.length===2) {
   const doc=indexes.get(parts[1].replace(/\.json$/,''));
   return doc===undefined?send(res,404,{message:'Not Found'}):send(res,200,Buffer.isBuffer(doc)?doc:Buffer.from(JSON.stringify(doc)));
  }
  if(parts[0]==='api' && parts[1]==='repos') {
   const [,,o,r,kind,...rest]=parts,state=repo(o,r);
   if(!state) return send(res,404,{message:'Not Found'});
   if(!kind) return send(res,200,{owner:{login:state.owner},full_name:`${state.owner}/${state.name}`,topics:state.topics ?? []});
   if(kind==='releases') {
    const per=Number(url.searchParams.get('per_page') || 30),page=Number(url.searchParams.get('page') || 1);
    const list=state.releases.slice((page-1)*per,page*per).map(rel=>({tag_name:rel.tag_name,draft:!!rel.draft,prerelease:!!rel.prerelease,published_at:rel.published_at ?? '2026-10-12T10:00:00Z',
     assets:rel.assets.map(a=>assetJson(state.owner,state.name,rel.tag_name,a))}));
    return send(res,200,list);
   }
   if(kind==='git' && rest[0]==='ref' && rest[1]==='tags') {
    const t=state.tags?.[rest.slice(2).join('/')];
    if(!t) return send(res,404,{message:'Not Found'});
    return send(res,200,t.annotated?{object:{type:'tag',sha:`a${t.commit.slice(1)}`}}:{object:{type:'commit',sha:t.commit}});
   }
   if(kind==='git' && rest[0]==='tags') {
    const t=Object.values(state.tags ?? {}).find(t=>t.annotated && `a${t.commit.slice(1)}`===rest[1]);
    return t?send(res,200,{object:{type:'commit',sha:t.commit}}):send(res,404,{message:'Not Found'});
   }
   if(kind==='collaborators' && rest[1]==='permission') {
    const p=state.collaborators?.[rest[0]];
    return p?send(res,200,{permission:p==='maintain'?'write':p,role_name:p}):send(res,404,{message:'Not Found'});
   }
   return send(res,404,{message:'Not Found'});
  }
  if(parts[0]==='dl' && parts[3]==='releases' && parts[4]==='download') {
   const state=repo(parts[1],parts[2]),rel=state?.releases.find(x=>x.tag_name===parts[5]),asset=rel?.assets.find(a=>a.name===parts[6]);
   if(!asset) return send(res,404,'Not Found');
   const range=/^bytes=(\d+)-$/.exec(req.headers.range || '');
   if(range && Number(range[1])<asset.bytes.length) {
    const start=Number(range[1]);
    return send(res,206,asset.bytes.subarray(start),{'content-range':`bytes ${start}-${asset.bytes.length-1}/${asset.bytes.length}`});
   }
   return send(res,200,asset.bytes);
  }
  send(res,404,'Not Found');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 base=`http://127.0.0.1:${server.address().port}`;
 return {
  base,repos,indexes,requests,
  env:{HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP:'1',HYPRUNE_GITHUB_API:`${base}/api`,HYPRUNE_GITHUB_DOWNLOAD:`${base}/dl`},
  /** Create (or return) a repository. */
  repo(owner,name,{topics=[],collaborators={}}={}) {
   const key=`${owner}/${name}`.toLowerCase();
   if(!repos.has(key)) repos.set(key,{owner,name,topics,collaborators,tags:{},releases:[]});
   return repos.get(key);
  },
  /** Publish the files of a `pack --release` output directory as the release of `tag` (newest first). */
  publish(owner,name,tag,dir,{prerelease=false,draft=false,commit,annotated=false,only}={}) {
   const state=this.repo(owner,name);
   const files=readdirSync(dir).filter(f=>!only || only(f));
   const assets=files.map(f=>({name:f,bytes:readFileSync(join(dir,f)),updated:new Date(Date.now()+(++uploads)).toISOString()}));
   const record=assets.find(a=>a.name.endsWith('.release.json'));
   const sha=commit ?? (record?JSON.parse(record.bytes).source.commit:createHash('sha1').update(tag).digest('hex'));
   state.tags[tag]={commit:sha,annotated};
   state.releases=[{tag_name:tag,draft,prerelease,published_at:'2026-10-12T10:00:00Z',assets},...state.releases.filter(r=>r.tag_name!==tag)];
   return state.releases[0];
  },
  /** Replace an asset's bytes (a creator re-uploading a published asset). */
  replaceAsset(owner,name,tag,assetName,bytes) {
   const asset=this.repo(owner,name).releases.find(r=>r.tag_name===tag).assets.find(a=>a.name===assetName);
   asset.bytes=bytes;asset.updated=new Date(Date.now()+(++uploads)).toISOString();
  },
  /** The URL of an asset as GitHub lists it. */
  assetUrl(owner,name,tag,assetName) {return `${base}/dl/${owner}/${name}/releases/download/${encodeURIComponent(tag)}/${assetName}`;},
  close:()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}),
 };
}

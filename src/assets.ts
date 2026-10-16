// RFC-0016 `asset_fetch` (resolved question 2): downloads from an allowlist of CC0 libraries
// only, size-capped, into Hyprune's cache, with the source URL, licence and author recorded so
// import, material_set and world_set_sky carry them. Any other host (also after a redirect) is
// refused. The allowlist: Poly Haven, ambientCG and Kenney, whose assets are CC0.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {extname,join} from 'node:path';

export const ASSET_HOSTS: Record<string, {library: string; license: 'CC0-1.0'; author: string}> = {
 'polyhaven.com': {library: 'Poly Haven', license: 'CC0-1.0', author: 'Poly Haven'},
 'dl.polyhaven.org': {library: 'Poly Haven', license: 'CC0-1.0', author: 'Poly Haven'},
 'ambientcg.com': {library: 'ambientCG', license: 'CC0-1.0', author: 'ambientCG'},
 'kenney.nl': {library: 'Kenney', license: 'CC0-1.0', author: 'Kenney'},
};
export const ASSET_MAX_BYTES = 256 * 1024 * 1024;
const TYPES = ['.jpg', '.jpeg', '.png', '.exr', '.hdr', '.glb', '.gltf', '.zip', '.obj', '.fbx'];
export class AssetError extends Error {constructor(public code: 'asset.host' | 'asset.type' | 'asset.size' | 'asset.fetch', message: string, public hint?: string) {super(message);}}

/** The allowlist entry for a URL (https only), or null. Tests may add hosts with HYPRUNE_ASSET_HOSTS (host=Library,...). */
export function assetHost(url: string, env = process.env): {library: string; license: 'CC0-1.0'; author: string} | null {
 let u: URL;
 try {u = new URL(url);} catch {return null;}
 const extra = Object.fromEntries((env.HYPRUNE_ASSET_HOSTS ?? '').split(',').filter(Boolean).map(p => {const [h, lib] = p.split('='); return [h, {library: lib ?? h, license: 'CC0-1.0' as const, author: lib ?? h}];}));
 const hosts = {...ASSET_HOSTS, ...extra};
 if (u.protocol !== 'https:' && !(extra[u.host] && u.protocol === 'http:')) return null;
 for (const [host, info] of Object.entries(hosts)) if (u.host === host || u.host.endsWith('.' + host)) return info;
 return null;
}
export function assetsDir(env = process.env): string {
 const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.startsWith('/') ? env.XDG_CACHE_HOME : join(env.HOME || homedir(), '.cache');
 return join(base, 'hyprune', 'assets');
}
export interface FetchedAsset {path: string; bytes: number; sha256: string; license: string; author: string; source: string; library: string; name: string}
/** Downloads one asset (redirects only within the allowlist) and records where it came from. */
export async function fetchAsset(url: string, o: {author?: string; name?: string; maxBytes?: number} = {}): Promise<FetchedAsset> {
 const info = assetHost(url);
 if (!info) throw new AssetError('asset.host', 'Only Poly Haven, ambientCG and Kenney downloads are fetched', 'Give a direct https link on one of them, or ask the user for the file');
 let current = url;
 let response: Response | null = null;
 for (let hop = 0; hop < 5; hop++) {
  response = await fetch(current, {redirect: 'manual', headers: {'User-Agent': 'hyprune-mcp'}});
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
   const next = new URL(response.headers.get('location')!, current).toString();
   if (!assetHost(next)) throw new AssetError('asset.host', `The download redirects off the allowlist (${new URL(next).host})`);
   current = next; continue;
  }
  break;
 }
 if (!response || !response.ok || !response.body) throw new AssetError('asset.fetch', `The download failed (HTTP ${response?.status ?? 'no answer'})`);
 const max = o.maxBytes ?? ASSET_MAX_BYTES, declared = Number(response.headers.get('content-length') ?? 0);
 if (declared > max) throw new AssetError('asset.size', `The file is ${Math.round(declared / 1048576)} MiB (at most ${max / 1048576} MiB)`);
 const ext = extname(new URL(current).pathname).toLowerCase();
 if (!TYPES.includes(ext)) throw new AssetError('asset.type', `${ext || 'That file'} is not an image, model, sky or zip`, `Types: ${TYPES.join(', ')}`);
 const chunks: Buffer[] = [];
 let size = 0;
 for await (const chunk of response.body as any) {
  size += chunk.length;
  if (size > max) throw new AssetError('asset.size', `The file is over ${max / 1048576} MiB`);
  chunks.push(Buffer.from(chunk));
 }
 const bytes = Buffer.concat(chunks), sha256 = createHash('sha256').update(bytes).digest('hex');
 const name = (o.name ?? new URL(current).pathname.split('/').pop() ?? 'asset').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
 const dir = join(assetsDir(), sha256.slice(0, 16));
 mkdirSync(dir, {recursive: true});
 const path = join(dir, name.endsWith(ext) ? name : name + ext);
 if (!existsSync(path)) writeFileSync(path, bytes, {mode: 0o600});
 writeFileSync(join(dir, 'provenance.json'), JSON.stringify({source: url, fetched: current, license: info.license, author: o.author || info.author, library: info.library, sha256}, null, 1) + '\n');
 return {path, bytes: bytes.length, sha256, license: info.license, author: o.author || info.author, source: url, library: info.library, name};
}

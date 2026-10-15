// Where registry state lives (RFC-0015 "Where state lives", DESIGN "State and environment").
import {join,resolve} from 'node:path';
import {dataHome} from '../paths.js';
type Env=Record<string,string|undefined>;
const home=(env:Env)=>{if(!env.HOME || !env.HOME.startsWith('/')) throw new Error('Set an absolute HOME (or the XDG directories)');return env.HOME;};
const xdg=(env:Env,name:string,fallback:string)=>{const v=env[name];return v && v.startsWith('/')?v:join(home(env),fallback);};
export const stateHome=(env:Env=process.env)=>xdg(env,'XDG_STATE_HOME','.local/state');
export const configHome=(env:Env=process.env)=>xdg(env,'XDG_CONFIG_HOME','.config');
export const cacheHome=(env:Env=process.env)=>xdg(env,'XDG_CACHE_HOME','.cache');
export interface ContentRoots {
 /** $HYPRUNE_WORLD_DIR, else $XDG_DATA_HOME/hyprune/worlds. */
 worlds:string;
 /** $XDG_DATA_HOME/hyprune/libraries (RFC-0011 <id>@<version> directories). */
 libraries:string;
 /** $HYPRUNE_LIBRARY_DIR entries (absolute, read-only: managed "system"). */
 systemLibraries:string[];
 /** $XDG_STATE_HOME/hyprune: content.json and content.lock. */
 state:string;
 /** $XDG_CONFIG_HOME/hyprune/content-sources.json (sources.json belongs to the RFC-0013 data-source helper). */
 sourcesFile:string;
 /** $XDG_CONFIG_HOME/hyprune/sources.json: where content sources lived before; migrated once. */
 legacySourcesFile:string;
 /** $HYPRUNE_SOURCES_FILES entries (absolute, read-only). */
 systemSourcesFiles:string[];
 /** $XDG_CACHE_HOME/hyprune: sources/, downloads/, thumbnails/. */
 cache:string;
}
const list=(text:string|undefined)=>(text || '').split(':').filter(p=>p.startsWith('/'));
export function contentRoots(env:Env=process.env):ContentRoots {
 const data=dataHome(env),libraries=join(data,'hyprune','libraries');
 return {worlds:env.HYPRUNE_WORLD_DIR?resolve(env.HYPRUNE_WORLD_DIR):join(data,'hyprune','worlds'),libraries,
  systemLibraries:list(env.HYPRUNE_LIBRARY_DIR).filter(p=>resolve(p)!==libraries),state:join(stateHome(env),'hyprune'),
  sourcesFile:join(configHome(env),'hyprune','content-sources.json'),legacySourcesFile:join(configHome(env),'hyprune','sources.json'),systemSourcesFiles:list(env.HYPRUNE_SOURCES_FILES),cache:join(cacheHome(env),'hyprune')};
}

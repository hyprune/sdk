import {lstatSync,mkdirSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
export function socketPath(env=process.env): string {
  const runtime=env.XDG_RUNTIME_DIR, instance=env.HYPRLAND_INSTANCE_SIGNATURE;
  if(!runtime || !runtime.startsWith('/') || !instance || !/^[A-Za-z0-9_.-]+$/.test(instance) || ['.','..'].includes(instance)) throw new Error('Set absolute XDG_RUNTIME_DIR and safe HYPRLAND_INSTANCE_SIGNATURE; no /tmp fallback');
  return join(runtime,'hyprune',instance,'control.sock');
}
export function secureDirectory(path: string): void {
  const absolute=resolve(path); let current='/';
  for(const part of absolute.split('/').filter(Boolean)) {
    current=join(current,part);
    try { const st=lstatSync(current); if(!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe directory: '+current); }
    catch(e:any) { if(e.code!=='ENOENT') throw e; mkdirSync(current,{mode:0o700}); }
  }
  const st=lstatSync(absolute);
  if(st.uid!==process.getuid?.()) throw new Error('Socket directory must belong to this UID');
  chmodSync(absolute,0o700);
}
/** $XDG_DATA_HOME (absolute per the XDG spec), else ~/.local/share. */
export function dataHome(env=process.env): string {
  if(env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/')) return env.XDG_DATA_HOME;
  if(!env.HOME || !env.HOME.startsWith('/')) throw new Error('Set an absolute XDG_DATA_HOME or HOME');
  return join(env.HOME,'.local','share');
}
/** The RFC-0011 user object folder: $HYPRUNE_OBJECT_DIR, else $XDG_DATA_HOME/hyprune/objects. */
export function objectDir(env=process.env): string {
  return env.HYPRUNE_OBJECT_DIR?resolve(env.HYPRUNE_OBJECT_DIR):join(dataHome(env),'hyprune','objects');
}

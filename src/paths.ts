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

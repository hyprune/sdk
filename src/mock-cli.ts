#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {spawn,type ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import type {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {MockDaemon,GRANTS,type Scenario} from './mock.js';
import {parseJson} from './codec.js';
const help=`hyprune-mock [--socket path] [--scenario file.json] [--experimental]\nhyprune-mock [options] --launch <command> [args...]\nhyprune-mock --demo [--duration seconds]\n\n--client-id org.example.id   Approved developer client (default com.hyprune.sdk)\n--capabilities state.read,... Developer grants (default state.read)\n--experimental              Opt in to mock-only 0.1-mock.1\n\nDefault socket: $XDG_RUNTIME_DIR/hyprune/$HYPRLAND_INSTANCE_SIGNATURE/control.sock.\n--demo chooses instance mock and launches trusted system-pulse + terminal widget.\nLaunch tokens are one-use, expiring and passed through inherited FD 3.`;
async function main():Promise<void> {
 const argv=process.argv.slice(2),idx=argv.indexOf('--launch'),launch=idx<0?[]:argv.slice(idx+1);
 const {values:v}=parseArgs({args:idx<0?argv:argv.slice(0,idx),options:{help:{type:'boolean',short:'h'},socket:{type:'string'},scenario:{type:'string'},experimental:{type:'boolean'},demo:{type:'boolean'},duration:{type:'string'},'client-id':{type:'string'},capabilities:{type:'string'}}});
 if(v.help){console.log(help);return;}if(idx>=0 && !launch.length) throw new Error('--launch needs a command');
 if(v.demo && launch.length) throw new Error('Choose --demo or --launch');
 if(v.demo && !process.env.HYPRLAND_INSTANCE_SIGNATURE) process.env.HYPRLAND_INSTANCE_SIGNATURE='mock';
 const scenario=v.scenario?parseJson(readFileSync(v.scenario,'utf8')) as Scenario:undefined;
 const daemon=new MockDaemon({socket:v.socket,scenario,protocol:v.experimental || v.demo?'0.1-mock.1':'0.1'});
 await daemon.start();console.error(`hyprune-mock: ${daemon.protocol} listening at ${daemon.path}`);
 const children:ChildProcess[]=[];let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;for(const c of children) c.kill('SIGTERM');await daemon.stop();};
 process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
 function start(command:string,args:string[],clientId:string,caps:typeof GRANTS) {
  const token=daemon.issueToken(clientId,caps),child=spawn(command,args,{stdio:['inherit','inherit','inherit','pipe'],env:{...process.env,HYPRUNE_SOCKET:daemon.path,HYPRUNE_PROTOCOL:daemon.protocol,HYPRUNE_CLIENT_ID:clientId,HYPRUNE_TOKEN_FD:'3'}});
  children.push(child);(child.stdio[3] as Writable).end(token+'\n');
  child.on('error',e=>{console.error(e.message);process.exitCode=1;void stop();});return child;
 }
 if(v.demo) {
  const dir=new URL('../../examples/',import.meta.url);
  start(process.execPath,[fileURLToPath(new URL('system-pulse/main.mjs',dir))],'org.example.systempulse',['state.read']);
  start(process.execPath,[fileURLToPath(new URL('pulse-widget/main.mjs',dir))],'org.example.pulsewidget',['state.read']);
 }else if(launch.length) {
  const caps=(v.capabilities || 'state.read').split(',').filter(Boolean);
  if(caps.some(c=>!GRANTS.includes(c as any))) {await stop();throw new Error('Unknown capability');}
  const child=start(launch[0],launch.slice(1),v['client-id'] || 'com.hyprune.sdk',caps as typeof GRANTS);
  child.once('exit',code=>{if(!stopping){process.exitCode=code || 0;void stop();}});
 }
 if(v.duration) {const seconds=Number(v.duration);if(!Number.isFinite(seconds) || seconds<=0){await stop();throw new Error('duration must be >0');}setTimeout(()=>void stop(),seconds*1000).unref();}
}
main().catch(e=>{console.error('hyprune-mock: '+e.message);process.exitCode=1;});

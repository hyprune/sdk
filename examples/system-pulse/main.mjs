#!/usr/bin/env node
import {clientFromEnvironment} from '../../dist/src/index.js';
import {readPulse} from './metrics.mjs';
const client=clientFromEnvironment({client:{id:'org.example.systempulse',name:'System pulse'},capabilities:['data.publish']});
client.on('fault',e=>console.error('system-pulse: '+e.message));
await client.connect();
if(client.hello.protocol!=='0.2' || !client.hello.methods.includes('data.publish')) {client.close();throw new Error('System pulse requires IPC 0.2 and approved data.publish grant.');}
const sourceId='org.example.systempulse.data';let previous=readPulse().cpu,sequence=0,running=true,pending=Promise.resolve();
async function publish() {
 if(!running)return;
 const sample=readPulse(previous);previous=sample.cpu;
 await client.call('data.publish',{sourceId,sequence:++sequence,values:sample.values,ttlMs:5000});
}
const timer=setInterval(()=>{pending=publish().catch(e=>{console.error('system-pulse: '+e.message);process.exitCode=1;void stop();});},1000);
async function stop(){if(!running)return;running=false;clearInterval(timer);await pending;if(client.hello){try{await client.call('data.remove',{sourceId});}catch{}}client.close();}
client.on('disconnect',()=>{running=false;clearInterval(timer);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
try{await publish();}catch(e){console.error('system-pulse: '+e.message);process.exitCode=1;await stop();}

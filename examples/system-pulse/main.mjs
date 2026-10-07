#!/usr/bin/env node
import {clientFromEnvironment} from '../../dist/src/index.js';
import {readPulse} from './metrics.mjs';
const client=clientFromEnvironment({client:{id:'org.example.systempulse',name:'System pulse'}});
if(client.protocol!=='0.1-mock.1') throw new Error('System pulse publishing requires explicit mock-only protocol; core IPC 0.1 has no data host.');
client.on('fault',e=>console.error('system-pulse: '+e.message));
await client.connect();await client.subscribe();
let previous=readPulse().cpu,running=true;
async function publish() {
 if(!running) return;
 try {const sample=readPulse(previous);previous=sample.cpu;await client.mockCall('data.publish',{sourceId:'org.example.systempulse.data',values:sample.values});}
 catch(e){console.error('system-pulse: '+e.message);stop();process.exitCode=1;}
}
const timer=setInterval(()=>void publish(),1000);
function stop(){running=false;clearInterval(timer);client.close();}
client.on('disconnect',stop);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,stop);
await publish();

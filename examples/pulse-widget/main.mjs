#!/usr/bin/env node
import {clientFromEnvironment} from '../../dist/src/index.js';
const client=clientFromEnvironment({client:{id:'org.example.pulsewidget',name:'Pulse widget'}});
client.on('fault',e=>console.error('pulse-widget: '+e.message));
let values;
client.on('data.updated',p=>{if(p.sourceId==='org.example.systempulse.data') values=p.values;});
await client.connect();await client.subscribe();
const gib=b=>(b/1024**3).toFixed(2);
const timer=setInterval(()=>{
 const s=client.snapshot;if(!s) return;
 const pose=s.state.movement.position.map(n=>n.toFixed(1)).join(', ');
 const text=values?`CPU ${values.cpuPercent.toFixed(1)}% · RAM ${gib(values.ramUsedBytes)}/${gib(values.ramTotalBytes)} GiB · net RX ${gib(values.netRxBytes)} / TX ${gib(values.netTxBytes)} GiB`:'Waiting for system-pulse data';
 console.log(`[${s.state.world?.id || 'desktop'} @ ${pose}] ${text}`);
},1000);
function stop(){clearInterval(timer);client.close();}
client.on('disconnect',stop);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,stop);

#!/usr/bin/env node
import {clientFromEnvironment} from '../../dist/src/index.js';
const client=clientFromEnvironment({client:{id:'org.example.pulsewidget',name:'Pulse widget'}});
client.on('fault',e=>console.error('pulse-widget: '+e.message));
await client.connect();await client.subscribe();
const gib=b=>(Number(b)/1024**3).toFixed(2);
const timer=setInterval(()=>{
 const snapshot=client.snapshot;if(!snapshot)return;
 // Revisioned sources are authoritative, including expiry/remove/reconnect.
 const values=snapshot.state.integrations?.sources.find(s=>s.sourceId==='org.example.systempulse.data')?.values;
 const pose=snapshot.state.movement.position.map(n=>n.toFixed(1)).join(', ');
 const text=values?`CPU ${Number(values.cpuPercent).toFixed(1)}% · RAM ${gib(values.ramUsedBytes)}/${gib(values.ramTotalBytes)} GiB · net RX ${gib(values.netRxBytes)} / TX ${gib(values.netTxBytes)} GiB`:'Waiting for system-pulse data';
 const warp=snapshot.state.location?.transition;
 console.log(`[${snapshot.state.world?.id || 'desktop'} @ ${pose}] ${text}${warp?` · warp ${warp.phase} ${warp.progress===null?'…':Math.round(warp.progress*100)+'%'}`:''}`);
},1000);
function stop(){clearInterval(timer);client.close();}
client.on('disconnect',stop);for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);

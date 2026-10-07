import {readFileSync} from 'node:fs';
export function readPulse(previous,read=path=>readFileSync(path,'utf8')) {
 const numbers=read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
 if(numbers.length<4 || numbers.some(n=>!Number.isFinite(n))) throw new Error('Invalid /proc/stat');
 const cpu={total:numbers.reduce((n,v)=>n+v,0),idle:numbers[3]+(numbers[4] || 0)};
 const memory=Object.fromEntries([...read('/proc/meminfo').matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map(m=>[m[1],Number(m[2])*1024]));
 if(!(memory.MemTotal>0)) throw new Error('Invalid /proc/meminfo');
 let netRxBytes=0,netTxBytes=0;
 for(const line of read('/proc/net/dev').split('\n').slice(2)) {
  const [name,rest]=line.split(':');if(!rest || name.trim()==='lo') continue;
  const values=rest.trim().split(/\s+/).map(Number);if(values.length<16 || values.some(n=>!Number.isFinite(n))) throw new Error('Invalid /proc/net/dev');
  netRxBytes+=values[0];netTxBytes+=values[8];
 }
 const delta=previous?cpu.total-previous.total:0;
 const cpuPercent=delta>0?Math.max(0,Math.min(100,100*(1-(cpu.idle-previous.idle)/delta))):0;
 return {cpu,values:{cpuPercent,ramUsedBytes:Math.max(0,memory.MemTotal-(memory.MemAvailable ?? memory.MemFree ?? 0)),ramTotalBytes:memory.MemTotal,netRxBytes,netTxBytes}};
}

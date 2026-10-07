import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {validate as upstream} from '../vendor/schema/lib/validate.mjs';
export {upstream as validateManifest};
export type Protocol = '0.1' | '0.1-mock.1';
const ajv = new Ajv2020.default({strict:true,allErrors:true});
for(const name of ['common','ipc']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../vendor/schema/v0/${name}.schema.json`,import.meta.url),'utf8')));
const mock=JSON.parse(readFileSync(new URL('../contracts/mock.schema.json',import.meta.url),'utf8'));
ajv.addSchema(mock);
export function validateWire(value: unknown, protocol: Protocol='0.1', method?: string): void {
  if(protocol==='0.1') {
    const r=upstream('ipc',value,method); if(!r.valid) throw new Error('Invalid IPC: '+r.errors.join('; '));
  } else {
    const id=mock.$id+(method?`#/$defs/${method}.response`:'');
    const check=ajv.getSchema(id); if(!check || !check(value)) throw new Error('Invalid mock IPC: '+ajv.errorsText(check?.errors));
    // Apply upstream semantics after mapping the mock-only hello/notifications.
    const v:any=structuredClone(value);
    if(v.result?.protocol) { v.result.protocol='0.1'; v.result.methods=v.result.methods.filter((x:string)=>!['camera.set','waypoint.set','ui.open','data.publish'].includes(x)); v.result.events=v.result.events.filter((x:string)=>!['world.metadata','data.updated'].includes(x)); }
    if(!['world.metadata','data.updated','camera.set','waypoint.set','ui.open','data.publish'].includes(v.method) && (!method || !['camera.set','waypoint.set','ui.open','data.publish'].includes(method))) {
      const r=upstream('ipc',v,method); if(!r.valid) throw new Error(r.errors.join('; '));
    }
    if(v.method==='camera.set' && Math.abs(Math.hypot(...v.params.orientation)-1)>.001) throw new Error('Camera quaternion must be normalized');
  }
}
export function validateState(snapshot: unknown): void {
  validateWire({jsonrpc:'2.0',id:'validation',result:{snapshot}},'0.1','state.snapshot');
}

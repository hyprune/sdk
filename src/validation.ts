import {validate as upstream} from '../vendor/schema/lib/validate.mjs';
export {upstream as validateManifest};
export type Protocol = '0.1' | '0.2' | '0.3' | '0.4' | '0.5' | '0.6' | '0.7' | '0.8' | '0.9' | '0.10';
export function validateWire(value: unknown, protocol:Protocol='0.2', method?:string):void {
  const result=upstream('ipc',value,method,protocol);
  if(!result.valid) throw new Error('Invalid IPC: '+result.errors.join('; '));
}
export function validateState(snapshot:unknown, protocol:Protocol='0.2'):void {
  validateWire({jsonrpc:'2.0',id:'validation',result:{snapshot}},protocol,'state.snapshot');
}

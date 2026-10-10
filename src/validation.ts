import {validate as upstream} from '../vendor/schema/lib/validate.mjs';
export {upstream as validateManifest};
// The only runtime list of negotiable protocols, generated from the vendored IPC
// pins and their method maps (scripts/generate.mjs); the type follows from it.
import {PROTOCOLS} from './generated.js';
export {PROTOCOLS};
export type Protocol = typeof PROTOCOLS[number];
export function validateWire(value: unknown, protocol:Protocol='0.2', method?:string):void {
  const result=upstream('ipc',value,method,protocol);
  if(!result.valid) throw new Error('Invalid IPC: '+result.errors.join('; '));
}
export function validateState(snapshot:unknown, protocol:Protocol='0.2'):void {
  validateWire({jsonrpc:'2.0',id:'validation',result:{snapshot}},protocol,'state.snapshot');
}

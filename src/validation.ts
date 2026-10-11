import {validate as upstream,objectFormats,objectLimits,atLeast} from '../vendor/schema/lib/validate.mjs';
// objectFormats and objectLimits (RFC-0011) come from the vendored validator's directories and constants.
export {upstream as validateManifest,objectFormats,objectLimits};
/** The shared contract-version comparison (numeric, never a hand-kept list). */
export {atLeast};
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

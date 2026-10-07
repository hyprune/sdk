import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import parseSpdx from 'spdx-expression-parse';

const names = ['common', 'world', 'extension', 'screen-type', 'ipc'];
const ajv = new Ajv2020({ allErrors: true, strict: true });
const base = 'https://hyprune.com/schema/v0/';
for (const name of names) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0/${name}.schema.json`, import.meta.url))));
}
for (const name of ['common','world','ipc']) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0.2/${name}.schema.json`, import.meta.url))));
}
const validators = new Map();

// The optional method binds a response to the caller's outstanding request.
// An envelope alone cannot know whether a valid result belongs to that method.
export function validate(kind, value, method, version = '0.1') {
  if (!names.includes(kind) || kind === 'common') throw new Error(`Unknown schema: ${kind}`);
  if (!['0.1','0.2'].includes(version)) throw new Error(`Unknown contract: ${version}`);
  const key = `${version}:${kind}:${method || ''}`;
  if (method && kind !== 'ipc') throw new Error('Method context is only valid for IPC');
  if (!validators.has(key)) {
    let schema = `${version === '0.2' && ['world','ipc'].includes(kind) ? base.replace('/v0/','/v0.2/') : base}${kind}.schema.json`;
    if (method) {
      if (!ajv.getSchema(`${schema}#/$defs/${method}.result`)) throw new Error(`Unknown method: ${method}`);
      schema += `#/$defs/${method}.response`;
    }
    validators.set(key, ajv.getSchema(schema));
  }
  const check = validators.get(key);
  if (!check(value)) return { valid: false, errors: check.errors.map(e => `${e.instancePath || '/'} ${e.message}`) };
  const errors = [];
  const fail = message => errors.push(message);
  const unique = (items, field, label) => {
    const ids = items.map(v => v[field]);
    if (new Set(ids).size !== ids.length) fail(`${label}: duplicate ${field}`);
  };
  const quat = (q, label) => {
    if (Math.abs(Math.hypot(...q) - 1) > 0.001) fail(`${label}: quaternion must be normalized`);
  };
  const license = (text, label) => {
    try { parseSpdx(text); } catch { fail(`${label}: invalid SPDX expression`); }
  };
  if (value.version) {
    const prerelease = value.version.split('+')[0].split('-').slice(1).join('-');
    if (prerelease.split('.').some(p => /^0\d+$/.test(p))) fail('version: numeric prerelease identifiers cannot have leading zeros');
  }
  if (value.license) license(value.license, 'license');
  if (value.requiredExtensions) for (const id of value.requiredExtensions) {
    if (!Object.hasOwn(value.extensions || {}, id)) fail(`requiredExtensions: missing ${id}`);
  }
  if (kind === 'world') {
    for (const name of ['spawns', 'zones', 'anchors', 'audio']) unique(value[name] || [], 'id', name);
    if (!value.spawns.some(s => s.id === value.defaultSpawn)) fail('defaultSpawn: unknown spawn');
    for (const entry of [...value.spawns, ...(value.anchors || [])]) quat(entry.pose.rotation, entry.id);
    for (const zone of value.zones || []) if (zone.bounds.min.some((n, i) => n >= zone.bounds.max[i])) fail(`${zone.id}: bounds min must be below max`);
    unique(value.lightmaps || [], 'material', 'lightmaps');
    unique(value.attribution, 'path', 'attribution');
    for (const a of value.attribution) license(a.license, `attribution ${a.path}`);
  }
  if (kind === 'extension') {
    for (const [kind, ids] of Object.entries(value.contributes)) {
      if (kind !== 'screenTypes' && ids.some(id => !id.startsWith(value.id + '.'))) fail(`${kind}: contribution IDs must be beneath extension ID`);
    }
  }
  if (kind === 'ipc') {
    const transition = value.method === 'location.transition' ? value.params : value.result?.snapshot?.state?.location?.transition;
    if (transition) {
      if ((transition.phase === 'loading') !== (transition.progress === null)) fail('only loading uses indeterminate progress');
      if (transition.phase === 'arrived' && transition.progress !== 1) fail('arrival progress must be 1');
    }
    if (value.method === 'camera.set') quat(value.params.orientation, 'camera');
    if (method === 'camera.get' && value.result) quat(value.result.orientation, 'camera');
    if (value.method === 'state.delta' && value.params.revision <= value.params.baseRevision) fail('delta revision must advance');
    if (value.method === 'shell.overlay' && !value.params.visible && value.params.exclusiveInput) fail('hidden overlays cannot claim exclusive input');
    if (value.error && value.id === null && ![-32700, -32600].includes(value.error.code)) fail('null error ID is only allowed for malformed requests');
    const state = value.result?.snapshot?.state;
    const changes = value.method === 'state.delta' ? value.params.changes : undefined;
    for (const s of [state, changes].filter(Boolean)) {
      if (s.movement) quat(s.movement.orientation, 'movement');
      if (s.surfaces) unique(s.surfaces, 'id', 'surfaces');
      if (s.shell) {
        unique(s.shell.leases, 'id', 'leases');
        const claimed = new Set();
        for (const lease of s.shell.leases) {
          for (const output of lease.outputs) {
            if (claimed.has(output)) fail('output claimed by multiple leases');
            claimed.add(output);
            if (s.runtime && !s.runtime.outputs.includes(output)) fail('lease refers to unknown output');
          }
          unique(lease.overlays, 'outputId', 'overlays');
          for (const overlay of lease.overlays) {
            if (!lease.outputs.includes(overlay.outputId)) fail('overlay output is outside its lease');
            if (!overlay.visible && overlay.exclusiveInput) fail('hidden overlays cannot claim exclusive input');
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

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
for (const name of ['common','world','ipc']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0.3/${name}.schema.json`, import.meta.url))));
for (const name of ['common','world','ipc']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0.4/${name}.schema.json`, import.meta.url))));
for (const name of ['common','world','ipc']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0.5/${name}.schema.json`, import.meta.url))));
for (const name of ['common','world','ipc']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0.6/${name}.schema.json`, import.meta.url))));
for (const v of ['0.7','0.8','0.9','0.10','0.11','0.12','0.13','0.14','0.15']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../v${v}/ipc.schema.json`, import.meta.url))));
const validators = new Map();

// The optional method binds a response to the caller's outstanding request.
// An envelope alone cannot know whether a valid result belongs to that method.
export function validate(kind, value, method, version = '0.1') {
  if (!names.includes(kind) || kind === 'common') throw new Error(`Unknown schema: ${kind}`);
  if (!['0.1','0.2','0.3','0.4','0.5','0.6','0.7','0.8','0.9','0.10','0.11','0.12','0.13','0.14','0.15'].includes(version)) throw new Error(`Unknown contract: ${version}`);
  const key = `${version}:${kind}:${method || ''}`;
  if (method && kind !== 'ipc') throw new Error('Method context is only valid for IPC');
  if (!validators.has(key)) {
    const directory = kind === 'ipc' && version !== '0.1' ? `v${version}` : kind === 'world' && ['0.2','0.3','0.4','0.5','0.6'].includes(version) ? `v${version}` : 'v0';
    let schema = `https://hyprune.com/schema/${directory}/${kind}.schema.json`;
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
    const declarations = [value.playable, ...(value.areas || []).map(a=>a.playable)].filter(Boolean);
    if ((value.areas || []).reduce((n,a)=>n+(a.playable?.volumes?.length || (a.playable ? 1 : 0)),0)>64) fail('too many area playable volumes');
    const sub=(a,b)=>a.map((v,i)=>v-b[i]), dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    for(const d of declarations) for(const v of d.volumes || []) {
      if(v.type==='box' && v.min.some((x,i)=>x>=v.max[i])) fail('playable box bounds inverted');
      if(v.type==='convex') {
        const p=v.points; let solid=false;
        for(let i=1;i<p.length;i++)for(let j=i+1;j<p.length;j++)for(let k=j+1;k<p.length;k++)
          if(Math.abs(dot(sub(p[i],p[0]),cross(sub(p[j],p[0]),sub(p[k],p[0]))))>1e-5)solid=true;
        if(!solid)fail('playable convex hull must have nonzero volume');
      }
    }
    const areas=value.visibility?.areas || [];
    unique(areas,'id','visibility areas');
    const areaIds=new Set(areas.map(a=>a.id)), nodes=new Set();
    for(const area of areas){
      if(area.bounds.min.some((v,i)=>v>=area.bounds.max[i]))fail('visibility bounds inverted');
      for(const id of area.visibleFrom)if(!areaIds.has(id))fail('unknown visibility area');
      for(const id of area.nodes){if(nodes.has(id))fail('duplicate visibility node');nodes.add(id);}
    }

    for (const name of ['spawns', 'zones', 'anchors', 'audio']) unique(value[name] || [], 'id', name);
    if (!value.spawns.some(s => s.id === value.defaultSpawn)) fail('defaultSpawn: unknown spawn');
    for (const entry of [...value.spawns, ...(value.anchors || [])]) quat(entry.pose.rotation, entry.id);
    for (const zone of value.zones || []) if (zone.bounds.min.some((n, i) => n >= zone.bounds.max[i])) fail(`${zone.id}: bounds min must be below max`);
    unique(value.lightmaps || [], 'material', 'lightmaps');
    if (['0.3','0.4','0.5','0.6'].includes(value.formatVersion)) {
      unique(value.areas || [], 'id', 'areas'); unique(value.areas || [], 'workspaceSlot', 'areas');
      const anchors = new Map((value.anchors || []).map(a => [a.id, a]));
      unique(value.dataObjects || [], 'id', 'dataObjects');
      for(const o of value.dataObjects || []) if(o.mount.role !== 'data-object' || o.mount.interaction !== 'none') fail(`object ${o.id}: role/interaction mismatch`);
      const objects = new Map((value.dataObjects || []).map(a => [a.id, a]));
      const zones = new Map((value.placementZones || []).map(a => [a.id, a]));
      const owned = new Set();
      for (const area of value.areas || []) {
        for (const [role, ids] of [['mounted-workspace', [area.primaryAnchor]], ['tool-mount', area.toolAnchors], ['data-object', area.dataAnchors]]) {
          for (const id of ids) {
            if (owned.has(id)) fail(`anchor ${id}: multiple area owners`); owned.add(id);
            if (role === 'data-object' && objects.has(id)) {
              if (objects.get(id).areaId !== area.id) fail(`object ${id}: area mismatch`);
            } else if (anchors.get(id)?.mount?.role !== role) fail(`anchor ${id}: missing or wrong role`);
          }
        }
        for (const id of area.freePlacementZones || []) if (!zones.has(id)) fail(`zone ${id}: unknown placement volume`);
        if (area.spawnId && !value.spawns.some(s => s.id === area.spawnId)) fail(`area ${area.id}: unknown spawn`);
      }
      for (const a of value.anchors || []) if (a.mount) {
        if (!owned.has(a.id)) fail(`anchor ${a.id}: no area owner`);
        const expected = {'mounted-workspace':'focus-in','tool-mount':'in-place','data-object':'none'}[a.mount.role];
        if (a.mount.interaction !== expected) fail(`anchor ${a.id}: incompatible interaction`);
        const l=a.mount.limits;
        if (l && (l.minAspect>l.maxAspect || l.minSize.some((v,i)=>v>l.maxSize[i]))) fail(`anchor ${a.id}: inverted limits`);
      }
      for (const zone of zones.values()) if (zone.bounds.min.some((v,i)=>v>=zone.bounds.max[i])) fail(`zone ${zone.id}: inverted bounds`);
    }
    unique(value.climbables || [], 'id', 'climbables');
    for (const c of value.climbables || []) {
      const axis = c.top.map((v,i) => v-c.bottom[i]);
      const length = Math.hypot(...axis);
      if (length < .5 || length > 100 || axis[1]/length < .25) fail(`${c.id}: invalid ascending segment`);
      if (Math.abs(Math.hypot(...c.facing)-1) > .001 || Math.abs(axis.reduce((v,n,i)=>v+n*c.facing[i],0)/length) > .001) fail(`${c.id}: facing must be unit and perpendicular to segment`);
      for (const end of ['top','bottom']) if (Math.hypot(...c.exits[end].map((v,i)=>v-c[end][i])) > 3) fail(`${c.id}: exit too far from segment`);
    }
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
    if ((value.method === 'camera.set' || value.method === 'camera.photo')) quat(value.params.orientation, 'camera');
    if (method === 'camera.get' && value.result) quat(value.result.orientation, 'camera');
    if (value.method === 'state.delta' && value.params.revision <= value.params.baseRevision) fail('delta revision must advance');
    if (value.method === 'shell.overlay' && !value.params.visible && value.params.exclusiveInput) fail('hidden overlays cannot claim exclusive input');
    if (value.error && value.id === null && ![-32700, -32600].includes(value.error.code)) fail('null error ID is only allowed for malformed requests');
    const state = value.result?.snapshot?.state;
    const changes = value.method === 'state.delta' ? value.params.changes : undefined;
    for (const s of [state, changes].filter(Boolean)) {
      if (s.movement) {
        quat(s.movement.orientation, 'movement');
        if (version === '0.11' && ((s.movement.state === 'climbing') !== (typeof s.movement.ladderId === 'string'))) fail('climbing requires ladderId; other states require null');
      }
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

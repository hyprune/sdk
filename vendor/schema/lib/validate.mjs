import { existsSync, readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import parseSpdx from 'spdx-expression-parse';

const names = ['common', 'world', 'extension', 'screen-type', 'ipc'];
// Object, library and library release record schemas (RFC-0011) live in v0.N directories only.
const manifestKinds = ['object', 'library', 'library-releases'];
const ajv = new Ajv2020({ allErrors: true, strict: true });
const base = 'https://hyprune.com/schema/v0/';
for (const name of names) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../v0/${name}.schema.json`, import.meta.url))));
}
// Versioned directories (v0.N) hold a world format and/or an IPC version; discover
// them rather than keeping a hand list, so a new pinned schema can't be forgotten.
const root = new URL('../', import.meta.url);
const byVersion = (a, b) => { const [x, y] = [a, b].map(v => v.split('.').map(Number)); return x[0] - y[0] || x[1] - y[1]; };
const versions = readdirSync(root).filter(d => /^v0\.\d+$/.test(d)).map(d => d.slice(1)).sort(byVersion);
const has = (version, name) => existsSync(new URL(`v${version}/${name}.schema.json`, root));
for (const v of versions) for (const name of ['common', 'world', 'ipc', ...manifestKinds])
  if (has(v, name)) ajv.addSchema(JSON.parse(readFileSync(new URL(`v${v}/${name}.schema.json`, root))));
const validators = new Map();

// Contract versions are dotted numbers; compare numerically, never by list.
export function atLeast(version, minimum) {
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
// World formats: every v0.N directory with a world schema (0.1 uses v0).
export const worldFormats = ['0.1', ...versions.filter(v => has(v, 'world'))];
// IPC protocols: every v0.N directory with an IPC schema (0.1 uses v0). Contract
// versions are all of them (AGENTS rule 6: no hand-kept version lists).
export const ipcProtocols = ['0.1', ...versions.filter(v => has(v, 'ipc'))];
export const contractVersions = ['0.1', ...versions];
// Object manifest formats (RFC-0011): every v0.N directory with an object schema.
// They share the world format numbering and start at 0.9.
export const objectFormats = versions.filter(v => has(v, 'object'));
// glTF extensions a package may require, by world format (RFC-0004).
export function sceneExtensions(version) {
  const base = ['KHR_materials_unlit','KHR_texture_transform','KHR_materials_emissive_strength'];
  return atLeast(version, '0.7') ? [...base,'KHR_texture_basisu','EXT_meshopt_compression','KHR_mesh_quantization'] : base;
}
// World 0.8 object asset rules that need the asset's glTF (RFC-0004 "world 0.8"):
// referenced node names exist once, animated subtrees do not nest, and the
// collision proxy has a mesh and lies outside every animated subtree.
function validateObjectAsset(gltf, asset, fail, label = `objectAssets ${asset.id}`) {
  const nodes = gltf.nodes || [], parents = new Map();
  nodes.forEach((n, i) => { for (const c of n.children || []) parents.set(c, i); });
  const find = name => {
    const hits = nodes.flatMap((n, i) => n.name === name ? [i] : []);
    if (hits.length !== 1) fail(`${label}: node "${name}" ${hits.length ? 'is not unique' : 'not found'} in the asset`);
    return hits.length === 1 ? hits[0] : undefined;
  };
  const ancestors = node => { const out = []; for (let p = parents.get(node), n = 0; p !== undefined && n <= nodes.length; p = parents.get(p), n++) out.push(p); return out; };
  const targets = new Map();
  for (const a of asset.animations || []) { const i = find(a.node); if (i !== undefined) targets.set(i, a.node); }
  for (const [node, name] of targets) for (const p of ancestors(node))
    if (targets.has(p)) fail(`${label}: animation "${name}" is inside animated node "${targets.get(p)}"`);
  if (asset.collision) {
    const i = find(asset.collision.node);
    if (i !== undefined) {
      if (nodes[i].mesh === undefined) fail(`${label}: collision node "${asset.collision.node}" has no mesh`);
      for (const p of [i, ...ancestors(i)]) if (targets.has(p)) fail(`${label}: collision node "${asset.collision.node}" is inside animated node "${targets.get(p)}"`);
    }
  }
}
// glTF extension rules shared by scene.gltf, 0.8 object assets and object manifests:
// extensionsRequired within the format's list, KTX2 and meshopt listed when used.
function sceneExtensionRules(gltf, version, fail) {
  const allowed = new Set(sceneExtensions(version)), required = new Set(gltf.extensionsRequired || []);
  for (const id of required) if (!allowed.has(id)) fail(`extensionsRequired: ${id} is not allowed in world ${version}`);
  const textures = gltf.textures || [], images = gltf.images || [];
  textures.forEach((texture, i) => {
    if (!texture.extensions?.KHR_texture_basisu) return;
    if (!allowed.has('KHR_texture_basisu')) fail(`textures/${i}: KHR_texture_basisu needs world 0.7`);
    else if (!required.has('KHR_texture_basisu')) fail('extensionsRequired: KHR_texture_basisu must be listed when textures use it');
    const image = images[texture.extensions.KHR_texture_basisu.source];
    if (!image || (image.mimeType && image.mimeType !== 'image/ktx2') || (image.uri && !/\.ktx2$/i.test(image.uri)))
      fail(`textures/${i}: KHR_texture_basisu source must be a KTX2 image`);
  });
  if ((gltf.bufferViews || []).some(v => v.extensions?.EXT_meshopt_compression) && !required.has('EXT_meshopt_compression'))
    fail(allowed.has('EXT_meshopt_compression') ? 'extensionsRequired: EXT_meshopt_compression must be listed when buffer views use it'
                                                : 'bufferViews: EXT_meshopt_compression needs world 0.7');
}
// scene.gltf rules that depend on the world format: extensionsRequired, and
// lightmap textures (world.lightmaps[].texture) stay PNG in every v0 format.
// With options.asset, `gltf` is that world 0.8 object asset's glTF instead: the
// same extension rules, the asset rules above, and no lightmaps (assets are never baked).
// World 0.9 inline assets may give the animations and proxy as traits, and a
// character trait needs a skin and its clips; dir and library assets are checked
// through their object.json (kind object).
function validateScene(gltf, version, world, assetId) {
  const errors = [], fail = m => errors.push(m);
  if (!worldFormats.includes(version)) throw new Error(`Unknown world format: ${version}`);
  sceneExtensionRules(gltf, version, fail);
  const textures = gltf.textures || [], images = gltf.images || [];
  if (assetId !== undefined) {
    const asset = atLeast(version, '0.8') ? (world?.objectAssets || []).find(a => a.id === assetId) : undefined;
    const label = `objectAssets ${assetId}`, character = asset?.traits?.character;
    if (!asset) fail(`objectAssets: unknown asset ${assetId} for world ${version}`);
    else if (asset.scene === undefined) fail(`${label}: not an inline glTF asset; check its object.json with kind object`);
    else validateObjectAsset(gltf, { id: asset.id, animations: asset.animations ?? asset.traits?.decorative?.animations, collision: asset.collision ?? asset.traits?.collidable }, fail);
    if (asset?.scene !== undefined && character) {
      if (!(gltf.skins || []).length) fail(`${label}: traits.character: the glTF has no skin`);
      const clips = new Set((gltf.animations || []).map(a => a.name));
      for (const name of Object.keys(character.clips)) if (!clips.has(name)) fail(`${label}: traits.character: clip "${name}" not found in the glTF`);
    }
    return { valid: errors.length === 0, errors };
  }
  for (const lightmap of world?.lightmaps || []) {
    const texture = textures[lightmap.texture];
    if (!texture) { fail(`lightmaps: texture ${lightmap.texture} missing from scene`); continue; }
    const image = images[texture.source];
    if (texture.extensions?.KHR_texture_basisu || !image || (image.mimeType && image.mimeType !== 'image/png') || (image.uri && !/\.png$/i.test(image.uri)))
      fail(`lightmaps: texture ${lightmap.texture} must be a PNG image (KTX2 lightmaps are not allowed in v0)`);
  }
  return { valid: errors.length === 0, errors };
}

// Object manifests, libraries and library release records (RFC-0011). Origin
// conventions: floor, wall and ceiling objects within 1 cm, a character's
// rest-pose feet within 5 cm. The manifest-only rules always run; options add the rules that need more than
// object.json: `gltf` (the parsed scene glTF, or a GLB's JSON chunk),
// `directory` (its directory name), `files` ([{path, size}] of the directory),
// `thumbnail` ({width, height, bytes}) and `measured` (values only a geometry
// decoder knows: exact rest `bounds`, `maxTextureSize`, `gpuBytes`).
// Directory and asset limits (RFC-0011 "Budgets and limits", provisional).
export const objectLimits = Object.freeze({
  files: 64, directoryBytes: 64 * 1048576, fileBytes: 32 * 1048576,
  triangles: 50000, characterTriangles: 16000, itemTriangles: 2000,
  textureSize: 2048, characterTextureSize: 1024, gpuBytes: 48 * 1048576, itemGpuBytes: 1048576,
  collisionTriangles: 2000, thumbnailSize: 256, thumbnailBytes: 262144,
  libraryFiles: 4000, libraryBytes: 512 * 1048576, boundsTolerance: 0.01, characterOriginTolerance: 0.05, slotMargin: 0.5,
});
// Which traits may share an asset (RFC-0011 "Allowed combinations"; machine per RFC-0013).
const traitPairs = {
  decorative: ['collidable', 'movable', 'seat', 'mover', 'machine'], collidable: ['decorative', 'movable', 'seat', 'machine'],
  movable: ['decorative', 'collidable', 'seat', 'machine'], character: [], mover: ['decorative'],
  seat: ['decorative', 'collidable', 'movable'], machine: ['decorative', 'collidable', 'movable'],
};
function reservedTraits(version) {
  const reserved = { mount: 'reserved for props that hold a window (RFC-0011 P4)', interactive: 'reserved for use actions (RFC-0011 P4)' };
  if (!atLeast(version, '0.10')) Object.assign(reserved, { mover: 'needs object format 0.10', machine: 'reserved for RFC-0013 live objects (object format 0.10)' });
  return reserved;
}
const componentMax = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, t[0], t[1], t[2], 1];
}
const mul = (a, b) => Array.from({ length: 16 }, (_, i) => { const c = i >> 2, r = i & 3; return a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; });
const apply = (m, p) => [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
function primitiveTriangles(gltf, p) {
  const count = gltf.accessors?.[p.indices ?? p.attributes?.POSITION]?.count || 0, mode = p.mode ?? 4;
  return mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
}
// The drawn scene graph: world matrix per reachable node (first visit wins; cycles stop).
function sceneNodes(gltf) {
  const nodes = gltf.nodes || [], scene = gltf.scenes?.[gltf.scene ?? 0], out = new Map();
  const visit = (i, parent, depth) => {
    if (out.has(i) || !nodes[i] || depth > 64) return;
    const m = mul(parent, nodeMatrix(nodes[i])); out.set(i, m);
    for (const c of nodes[i].children || []) visit(c, m, depth + 1);
  };
  for (const i of scene?.nodes || []) visit(i, nodeMatrix({}), 0);
  return { scene, out };
}
// Rest-pose bounds from accessor min/max: exact when every mesh's world matrix is
// axis-aligned, else a box that contains the true bounds. Skinned meshes: unknown.
function accessorBounds(gltf, drawn) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let exact = true, skinned = false;
  for (const [i, m] of drawn) {
    const node = gltf.nodes[i], mesh = gltf.meshes?.[node.mesh];
    if (!mesh) continue;
    if (node.skin !== undefined) { skinned = true; continue; }
    for (let c = 0; c < 3; c++) if ([0, 1, 2].filter(r => Math.abs(m[c * 4 + r]) > 1e-6).length > 1) exact = false;
    for (const p of mesh.primitives || []) {
      const a = gltf.accessors?.[p.attributes?.POSITION];
      if (!a?.min || !a?.max) { skinned = true; continue; }
      const scale = a.normalized && [...a.min, ...a.max].some(v => Math.abs(v) > 1) ? componentMax[a.componentType] || 1 : 1;
      const [mn, mx] = [a.min, a.max].map(v => v.map(x => Math.max(x / scale, a.normalized ? -1 : -Infinity)));
      for (let k = 0; k < 8; k++) {
        const w = apply(m, [k & 1 ? mx[0] : mn[0], k & 2 ? mx[1] : mn[1], k & 4 ? mx[2] : mn[2]]);
        for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], w[j]); hi[j] = Math.max(hi[j], w[j]); }
      }
    }
  }
  return skinned || lo[0] === Infinity ? undefined : { min: lo, max: hi, exact };
}
function validateObjectGltf(value, version, gltf, options, fail, warn) {
  const traits = value.traits, slots = value.slots || {}, nodes = gltf.nodes || [], materials = gltf.materials || [];
  sceneExtensionRules(gltf, version, fail);
  const { scene, out: drawn } = sceneNodes(gltf);
  if (!scene) { fail('scene: the glTF has no scene'); return; }
  const byName = new Map();
  nodes.forEach((n, i) => { if (n.name !== undefined) byName.set(n.name, [...(byName.get(n.name) || []), i]); });
  const node = (name, label, { inScene = true } = {}) => {
    const hits = byName.get(name) || [];
    if (hits.length !== 1) { fail(`${label}: node "${name}" ${hits.length ? 'is not unique' : 'not found'} in the glTF`); return undefined; }
    if (inScene && !drawn.has(hits[0])) fail(`${label}: node "${name}" is not in the scene`);
    return hits[0];
  };
  // The 0.8 asset rules: animation and collision node names, nesting, a static proxy mesh.
  validateObjectAsset(gltf, { animations: traits.decorative?.animations, collision: traits.collidable }, fail, 'traits');
  for (const a of traits.decorative?.animations || []) if ((byName.get(a.node) || []).length === 1 && !drawn.has(byName.get(a.node)[0])) fail(`traits.decorative: node "${a.node}" is not in the scene`);
  // Slots: names exist once; a material or node belongs to one states slot; variants map to palette ids.
  const materialIndex = name => {
    const hits = materials.flatMap((m, i) => m.name === name ? [i] : []);
    return hits.length === 1 ? hits[0] : undefined;
  };
  const owner = new Map(), slotPrimitives = new Map();
  const subtree = i => { const seen = new Set(), stack = [i]; while (stack.length) { const n = stack.pop(); if (seen.has(n) || !nodes[n]) continue; seen.add(n); stack.push(...(nodes[n].children || [])); } return [...seen]; };
  for (const slot of slots.states || []) {
    const label = `slots.states ${slot.id}`, prims = [];
    for (const name of slot.materials || []) {
      const hits = materials.filter(m => m.name === name).length;
      if (hits !== 1) { fail(`${label}: material "${name}" ${hits ? 'is not unique' : 'not found'} in the glTF`); continue; }
      const i = materialIndex(name);
      if (owner.has('m' + i)) fail(`${label}: material "${name}" is also in states slot ${owner.get('m' + i)}`); owner.set('m' + i, slot.id);
      for (const [n] of drawn) for (const p of gltf.meshes?.[nodes[n].mesh]?.primitives || []) if (p.material === i) prims.push(p);
      if (!prims.length) warn(`${label}: material "${name}" is not used by the scene`);
    }
    for (const name of slot.nodes || []) {
      const i = node(name, label);
      if (i === undefined) continue;
      if (owner.has('n' + i)) fail(`${label}: node "${name}" is also in states slot ${owner.get('n' + i)}`); owner.set('n' + i, slot.id);
      const meshes = subtree(i).filter(n => nodes[n].mesh !== undefined);
      if (!meshes.length) fail(`${label}: node "${name}" has no mesh in its subtree`);
      for (const n of meshes) prims.push(...(gltf.meshes?.[nodes[n].mesh]?.primitives || []));
    }
    slotPrimitives.set(slot.id, prims);
  }
  const variants = gltf.extensions?.KHR_materials_variants?.variants;
  if (variants) {
    const names = variants.map(v => v.name);
    if (new Set(names).size !== names.length) fail('KHR_materials_variants: duplicate variant names');
    (gltf.meshes || []).forEach((mesh, m) => (mesh.primitives || []).forEach((p, k) => {
      const seen = new Set();
      for (const mapping of p.extensions?.KHR_materials_variants?.mappings || []) {
        if (!materials[mapping.material]) fail(`meshes/${m}/primitives/${k}: variant mapping to unknown material ${mapping.material}`);
        for (const v of mapping.variants || []) {
          if (!variants[v]) fail(`meshes/${m}/primitives/${k}: unknown variant ${v}`);
          if (seen.has(v)) fail(`meshes/${m}/primitives/${k}: variant ${v} is mapped twice`); seen.add(v);
        }
      }
    }));
    for (const slot of slots.states || []) {
      const palette = new Set(slot.palette.map(e => e.id));
      for (const p of slotPrimitives.get(slot.id) || []) for (const mapping of p.extensions?.KHR_materials_variants?.mappings || [])
        for (const v of mapping.variants || []) if (variants[v] && !palette.has(variants[v].name))
          fail(`slots.states ${slot.id}: variant "${variants[v].name}" is not a palette id of the slot`);
    }
  }
  for (const s of slots.stacks || []) node(s.node, `slots.stacks ${s.id}`);
  const levelNodes = new Map();
  for (const l of slots.levels || []) {
    const where = `slots.levels ${l.id}`;
    for (const name of [l.node, l.surface]) {
      if (name === undefined) continue;
      if (name === traits.collidable?.node) { fail(`${where}: the collision proxy can't be moved`); continue; }
      if (levelNodes.has(name)) fail(`${where}: node "${name}" is also moved by levels slot ${levelNodes.get(name)}`); else levelNodes.set(name, l.id);
    }
    const i = node(l.node, where), j = l.surface === undefined ? undefined : node(l.surface, where);
    if (i !== undefined && j !== undefined && subtree(i).includes(j)) fail(`${where}: surface "${l.surface}" must not be inside the fill node's subtree`);
  }
  for (const t of slots.toggles || []) for (const name of t.nodes) {
    if (name === traits.collidable?.node) fail(`slots.toggles ${t.id}: the collision proxy can't be toggled`);
    node(name, `slots.toggles ${t.id}`);
  }
  // Characters are skinned and carry their clips; other objects animate declaratively.
  const clips = new Map((gltf.animations || []).map(a => [a.name, a]));
  if (traits.character) {
    if (!(gltf.skins || []).length) fail('traits.character: the glTF has no skin');
    for (const [name, measured] of Object.entries(traits.character.clips)) {
      const clip = clips.get(name);
      if (!clip) { fail(`traits.character: clip "${name}" not found in the glTF`); continue; }
      if (measured.speed !== undefined) {
        const speed = clip.extras?.speed;
        if (typeof speed !== 'number') fail(`traits.character: clip "${name}" has no extras.speed`);
        else if (Math.abs(measured.speed - speed) > 0.02 * speed) fail(`traits.character: clip "${name}" speed ${measured.speed} differs from extras.speed ${speed} by more than 2%`);
      }
    }
  } else {
    if ((gltf.skins || []).length) fail('skins: only characters may be skinned');
    if ((gltf.animations || []).length) warn('animations: glTF animations are ignored outside characters; use traits.decorative');
  }
  // Triangle budgets (drawn scene; proxy separately) and bounds.
  let triangles = 0;
  for (const [i] of drawn) for (const p of gltf.meshes?.[nodes[i].mesh]?.primitives || []) triangles += primitiveTriangles(gltf, p);
  const item = traits.mover?.item === true;
  const cap = traits.character ? objectLimits.characterTriangles : item ? objectLimits.itemTriangles : objectLimits.triangles;
  if (triangles > cap) fail(`triangles: ${triangles} exceeds ${cap}`);
  const proxy = traits.collidable && (byName.get(traits.collidable.node) || [])[0];
  if (proxy !== undefined) {
    const n = (gltf.meshes?.[nodes[proxy].mesh]?.primitives || []).reduce((s, p) => s + primitiveTriangles(gltf, p), 0);
    if (n > objectLimits.collisionTriangles) fail(`traits.collidable: proxy has ${n} triangles, more than ${objectLimits.collisionTriangles}`);
  }
  if (!options.measured?.bounds) {
    const b = accessorBounds(gltf, drawn), t = objectLimits.boundsTolerance;
    if (!b) warn('bounds: not checked (skinned or unbounded geometry needs measured bounds)');
    else for (let j = 0; j < 3; j++) {
      const axis = 'xyz'[j];
      if (b.exact ? Math.abs(value.bounds.min[j] - b.min[j]) > t : value.bounds.min[j] < b.min[j] - t) fail(`bounds: min ${axis} ${value.bounds.min[j]} does not match the scene (${+b.min[j].toFixed(4)})`);
      if (b.exact ? Math.abs(value.bounds.max[j] - b.max[j]) > t : value.bounds.max[j] > b.max[j] + t) fail(`bounds: max ${axis} ${value.bounds.max[j]} does not match the scene (${+b.max[j].toFixed(4)})`);
    }
    if (b && !b.exact) warn('bounds: checked against a containing box only (rotated meshes); pass measured bounds for the 1 cm check');
  }
  return { triangles };
}
// Typed machine inputs, drives and recipes (RFC-0013, object format 0.10 draft).
function validateMachine(value, fail) {
  const machine = value.traits.machine, slots = value.slots || {}, label = 'traits.machine';
  const inputs = new Map();
  for (const input of machine.inputs) {
    if (inputs.has(input.id)) fail(`${label}: duplicate input ${input.id}`); inputs.set(input.id, input);
    const d = input.default, il = `${label} input ${input.id}`;
    if (['int', 'number'].includes(input.type)) {
      if (input.min >= input.max) fail(`${il}: min must be below max`);
      if (input.type === 'int' && ![input.min, input.max].every(Number.isInteger)) fail(`${il}: int bounds must be integers`);
    }
    if (d === undefined) continue;
    const ok = { enum: () => input.values.includes(d), int: () => Number.isInteger(d) && d >= input.min && d <= input.max,
      number: () => typeof d === 'number' && d >= input.min && d <= input.max, bool: () => typeof d === 'boolean',
      text: () => typeof d === 'string' && d.length <= (input.maxLength ?? 64), event: () => false, items: () => false }[input.type];
    if (!ok()) fail(`${il}: default ${JSON.stringify(d)} is not a valid ${input.type} value`);
  }
  const count = machine.inputs.reduce((n, i) => n + (i.repeat || 1), 0);
  if (count > 16) fail(`${label}: ${count} inputs counting repeats, more than 16`);
  if (machine.primary !== undefined && !inputs.has(machine.primary)) fail(`${label}: primary names unknown input ${machine.primary}`);
  const resolve = (ref, where) => {
    const [id, n] = ref.split('.'), input = inputs.get(id);
    if (!input) { fail(`${where}: unknown input ${ref}`); return undefined; }
    if (input.repeat ? n === undefined || Number(n) > input.repeat : n !== undefined) { fail(`${where}: ${ref} ${input.repeat ? `needs an index 1-${input.repeat}` : 'takes no index'}`); return undefined; }
    return input;
  };
  // What a mapping can produce from an input: a set of scalars, a numeric range, or a kind.
  const numeric = input => input?.type === 'int' || input?.type === 'number';
  const outputs = (map, input) => {
    if (map?.average) {
      // The form applies to the running average (or the override's value): an int input's
      // average is fractional, and an override widens a direct range.
      const {average, ...form} = map, o = outputs(form, input);
      if (Object.keys(form).length) return o;
      const over = average.override === undefined ? undefined : inputs.get(average.override.split('.')[0]);
      if (o.range && numeric(over)) o.range = [Math.min(o.range[0], over.min), Math.max(o.range[1], over.max)];
      else if (over && !numeric(over)) return { kind: over.type };
      return o.range ? { ...o, integer: false } : o;
    }
    if (!map || !Object.keys(map).length) {
      if (input.type === 'enum') return { values: input.values };
      if (input.type === 'bool') return { values: [true, false] };
      if (input.type === 'int' || input.type === 'number') return { range: [input.min, input.max], integer: input.type === 'int' };
      return { kind: input.type };
    }
    if (map.cases || map.thresholds) return { values: [...(map.cases || map.thresholds).map(c => c.to), ...('else' in map ? [map.else] : [])] };
    if (map.scale) return map.clamp === false ? { kind: 'unbounded' } : { range: [Math.min(...map.scale.to), Math.max(...map.scale.to)], integer: !!map.round };
    if ('becomes' in map || map.counter) return { kind: 'event' };
    if (map.format) return { kind: 'text' };
    return { kind: 'unknown' };
  };
  const animated = new Set((value.traits.decorative?.animations || []).map(a => a.node));
  const positions = new Set((machine.positions || []).map(p => p.node));
  const slotIds = kind => new Set((slots[kind] || []).map(s => s.id));
  const palettes = new Map((slots.states || []).map(s => [s.id, new Set(s.palette.map(e => e.id))]));
  const within = (o, lo, hi, where) => {
    if (o.values) { if (o.values.some(v => typeof v !== 'number' || v < lo || v > hi)) fail(`${where}: outputs must be numbers ${lo}-${hi}`); }
    else if (o.range) { if (o.range[0] < lo || o.range[1] > hi) fail(`${where}: range ${o.range.join('-')} exceeds ${lo}-${hi}`); }
    else fail(`${where}: needs a numeric mapping`);
  };
  for (const drive of machine.drives) {
    const where = `${label} drive ${drive.input} -> ${drive.target}`, input = resolve(drive.input, where);
    const [kind, name] = [drive.target.slice(0, drive.target.indexOf(':')), drive.target.slice(drive.target.indexOf(':') + 1)];
    const known = { animation: () => animated.has(name), position: () => positions.has(name), state: () => palettes.has(name), emission: () => palettes.has(name),
      label: () => slotIds('labels').has(name), visible: () => slotIds('toggles').has(name), count: () => slotIds('stacks').has(name),
      spawn: () => slotIds('spawns').has(name), effect: () => slotIds('effects').has(name), level: () => slotIds('levels').has(name) }[kind];
    if (!known()) { fail(`${where}: unknown ${kind} target "${name}"`); continue; }
    if (!input) continue;
    if (drive.map?.average) {
      const ref = drive.map.average.override;
      if (!numeric(input)) { fail(`${where}: average needs an int or number input`); continue; }
      if (ref !== undefined) {
        const over = resolve(ref, `${where} average override`);
        if (ref === drive.input) fail(`${where}: average override must name another input`);
        else if (over && (over.type === 'event' || over.type === 'items')) fail(`${where}: average override ${ref} must be a value input, not ${over.type}`);
      }
    }
    const o = outputs(drive.map, input), event = o.kind === 'event' || (input.type === 'event' && !drive.map);
    if (kind === 'state') {
      if (!o.values) fail(`${where}: needs palette ids (an enum input or cases)`);
      else for (const v of o.values) if (!palettes.get(name).has(v)) fail(`${where}: "${v}" is not a palette id of ${name}`);
    } else if (kind === 'animation') within(o, 0, 10, where);
    else if (kind === 'emission') within(o, 0, 16, where);
    else if (kind === 'position' || kind === 'level') within(o, 0, 1, where);
    else if (kind === 'count') { within(o, 0, Infinity, where); if (o.range && !o.integer) fail(`${where}: counts need an int input or a rounded scale`); }
    else if (kind === 'visible') { if (!o.values || o.values.some(v => typeof v !== 'boolean')) fail(`${where}: needs boolean outputs`); }
    else if (kind === 'spawn' || kind === 'effect') { if (!event) fail(`${where}: needs an event (an event input, counter or becomes)`); }
    else if (kind === 'label' && event) fail(`${where}: events can't be shown as text`);
  }
  for (const p of machine.positions || []) {
    if (!animated.has(p.node)) fail(`${label}: position "${p.node}" is not a decorative animation`);
    if (p.range[0] >= p.range[1]) fail(`${label}: position "${p.node}" range must increase`);
  }
  for (const recipe of machine.recipes || []) {
    for (const ref of Object.keys(recipe.fields)) resolve(ref, `${label} recipe ${recipe.name}`);
    for (const [ref, map] of Object.entries(recipe.maps || {})) {
      const input = resolve(ref, `${label} recipe ${recipe.name}`);
      if (map.average && input && !numeric(input)) fail(`${label} recipe ${recipe.name}: ${ref} average needs an int or number input`);
      if (map.average?.override !== undefined) fail(`${label} recipe ${recipe.name}: ${ref} average override is for drives only`);
      if (input?.type === 'enum') for (const v of outputs(map, { type: 'text' }).values || [])
        if (!input.values.includes(v)) fail(`${label} recipe ${recipe.name}: ${ref} maps to "${v}", not a value of the input`);
    }
  }
}
// The trait and slot rules that need no geometry: combinations, animation fields,
// a static proxy, movable scale, unique ids, anchor capacity, slot poses and palettes.
// Object manifests pass `inside` (poses within the grown bounds); world 0.9 inline
// assets have no bounds. Messages are relative to the manifest (traits..., slots...).
function traitCombinations(names, fail) {
  for (const a of names) for (const c of names) if (a < c && !(traitPairs[a] || []).includes(c)) fail(`traits: ${a} and ${c} can't be combined`);
}
function objectTraitRules(traits, slots, fail, inside = () => {}) {
  const quat = (q, where) => { if (Math.abs(Math.hypot(...q) - 1) > 0.002) fail(`${where}: quaternion must be normalized`); };
  const unique = (items, field, label) => { const ids = items.map(v => v[field]); if (new Set(ids).size !== ids.length) fail(`${label}: duplicate ${field}`); };
  // Traits.
  const animations = traits.decorative?.animations || [];
  unique(animations, 'node', 'traits.decorative animations');
  for (const n of animations) {
    if (Math.abs(Math.hypot(...n.axis) - 1) > 0.001) fail(`traits.decorative: animation "${n.node}" axis must be a unit vector`);
    if (n.type === 'bob' ? n.amplitude === undefined : n.pivot === undefined) fail(`traits.decorative: ${n.type} animation "${n.node}" needs ${n.type === 'bob' ? 'an amplitude' : 'a pivot'}`);
    if (n.type === 'bob' ? n.pivot !== undefined : n.amplitude !== undefined) fail(`traits.decorative: ${n.type} animation "${n.node}" takes no ${n.type === 'bob' ? 'pivot' : 'amplitude'}`);
  }
  if (traits.collidable && animations.some(n => n.node === traits.collidable.node)) fail(`traits.collidable: node "${traits.collidable.node}" is animated`);
  const scale = traits.movable?.scale;
  if (scale && !(scale[0] <= 1 && 1 <= scale[1])) fail('traits.movable: scale must be [min, max] with min <= 1 <= max');
  if (traits.character) unique(traits.character.interactions || [], 'id', 'traits.character interactions');
  if (traits.seat) {
    unique(traits.seat.anchors, 'id', 'traits.seat anchors');
    if ((traits.seat.capacity ?? 0) > traits.seat.anchors.length) fail('traits.seat: capacity exceeds the number of anchors');
    for (const a of traits.seat.anchors) inside(a.position, `traits.seat anchor ${a.id}`);
  }
  if (traits.mover?.offset) inside(traits.mover.offset, 'traits.mover offset');
  // Slots: ids unique per kind, poses inside the grown bounds, palettes with unique ids.
  for (const [kind, list] of Object.entries(slots)) {
    unique(list, 'id', `slots.${kind}`);
    for (const s of list) {
      if (s.pose) { quat(s.pose.rotation, `slots.${kind} ${s.id}`); inside(s.pose.position, `slots.${kind} ${s.id}`); }
      if (s.palette) unique(s.palette, 'id', `slots.${kind} ${s.id} palette`);
    }
  }
  const tracks = new Map((slots.tracks || []).map(tr => [tr.id, tr]));
  for (const tr of slots.tracks || []) tr.points.forEach((p, i) => {
    inside(p.position, `slots.tracks ${tr.id} point ${i}`);
    const prev = tr.points[i - 1]?.position;
    if (p.type === 'arc' && prev && Math.hypot(p.position[0] - prev[0], p.position[2] - prev[2]) < 0.1) fail(`slots.tracks ${tr.id} point ${i}: an arc needs a horizontal chord of at least 0.1 m`);
  });
  for (const s of slots.spawns || []) if (s.track !== undefined && s.track !== 'port') {
    const tr = tracks.get(s.track);
    if (!tr) fail(`slots.spawns ${s.id}: unknown track ${s.track}`);
    else for (const a of s.items || []) if (tr.items && !tr.items.assets.includes(a)) fail(`slots.spawns ${s.id}: item ${a} is not in track ${tr.id}'s items`);
  }
  for (const l of slots.levels || []) if (l.axis && Math.abs(Math.hypot(...l.axis) - 1) > 0.001) fail(`slots.levels ${l.id}: axis must be a unit vector`);
  for (const s of slots.stacks || []) {
    if (s.cap > s.layout.grid.reduce((x, y) => x * y, 1)) fail(`slots.stacks ${s.id}: cap exceeds the layout grid`);
    s.layout.grid.forEach((n, j) => { if (n > 1 && !(s.layout.spacing[j] > 0)) fail(`slots.stacks ${s.id}: spacing ${'xyz'[j]} must be positive for ${n} cells`); });
  }
}
function validateObjectManifest(value, version, options, fail, warn) {
  const traits = value.traits, slots = value.slots || {}, names = Object.keys(traits), b = value.bounds;
  if (options.directory !== undefined && options.directory !== value.id) fail(`id: "${value.id}" differs from its directory "${options.directory}"`);
  traitCombinations(names, fail);
  for (let j = 0; j < 3; j++) if (b.min[j] >= b.max[j]) fail(`bounds: min ${'xyz'[j]} must be below max`);
  const t = objectLimits.boundsTolerance, surfaces = new Set(traits.movable ? traits.movable.surfaces || ['floor'] : []);
  const one = surfaces.size === 1 ? [...surfaces][0] : undefined;
  if (one === 'floor' && Math.abs(b.min[1]) > t) fail(`bounds: min y must be 0 (the base at the origin), is ${b.min[1]}`);
  // A character's rest (bind) pose is not the pose it stands in, so its feet get a looser check.
  if (traits.character && Math.abs(b.min[1]) > objectLimits.characterOriginTolerance) fail(`bounds: min y must be within ${objectLimits.characterOriginTolerance} m of 0 (the feet at the origin), is ${b.min[1]}`);
  if (one === 'wall' && Math.abs(b.min[2]) > t) fail(`bounds: min z must be 0 (the back against the wall), is ${b.min[2]}`);
  if (one === 'ceiling' && Math.abs(b.max[1]) > t) fail(`bounds: max y must be 0 (the top at the origin), is ${b.max[1]}`);
  const m = objectLimits.slotMargin, inside = (p, where, grow = m) => {
    if (p.some((v, j) => v < b.min[j] - grow || v > b.max[j] + grow)) fail(`${where}: lies outside the bounds grown by ${grow} m`);
  };
  objectTraitRules(traits, slots, fail, inside);
  if (traits.machine) validateMachine(value, fail);
  // Directory contents, thumbnail and measured values.
  const files = options.files;
  if (files) {
    const total = files.reduce((n, f) => n + f.size, 0), paths = new Set(files.map(f => f.path));
    if (files.length > objectLimits.files) fail(`directory: ${files.length} files, more than ${objectLimits.files}`);
    if (total > objectLimits.directoryBytes) fail(`directory: ${total} bytes, more than ${objectLimits.directoryBytes}`);
    for (const f of files) {
      if (f.size > objectLimits.fileBytes) fail(`directory: ${f.path} exceeds ${objectLimits.fileBytes} bytes`);
      if (!value.attribution.some(a => a.path === '.' || a.path === f.path || f.path.startsWith(a.path + '/'))) fail(`attribution: ${f.path} is not covered`);
    }
    for (const [field, path] of [['scene', value.scene], ['thumbnail', value.thumbnail]]) if (path !== undefined && !paths.has(path)) fail(`${field}: ${path} not found in the directory`);
  }
  if (options.thumbnail) {
    const { width, height, bytes } = options.thumbnail, s = objectLimits.thumbnailSize;
    if (width !== s || height !== s) fail(`thumbnail: ${width} x ${height}, must be ${s} x ${s}`);
    if (bytes > objectLimits.thumbnailBytes) fail(`thumbnail: ${bytes} bytes, more than ${objectLimits.thumbnailBytes}`);
  }
  const measured = options.measured || {};
  if (measured.bounds) for (const end of ['min', 'max']) for (let j = 0; j < 3; j++)
    if (Math.abs(b[end][j] - measured.bounds[end][j]) > t) fail(`bounds: ${end} ${'xyz'[j]} ${b[end][j]} is more than 1 cm from the scene's ${+measured.bounds[end][j].toFixed(4)}`);
  const texture = traits.character ? objectLimits.characterTextureSize : objectLimits.textureSize;
  if (measured.maxTextureSize > texture) fail(`textures: ${measured.maxTextureSize} px exceeds ${texture} px`);
  const gpu = traits.mover?.item ? objectLimits.itemGpuBytes : objectLimits.gpuBytes;
  if (measured.gpuBytes > gpu) fail(`gpu: ${measured.gpuBytes} bytes exceeds ${gpu}`);
  if (options.gltf) return validateObjectGltf(value, version, options.gltf, options, fail, warn);
  return {};
}
// library.json: listed object directories, their formats and the library's own files.
function validateLibraryManifest(value, options, fail) {
  const objects = options.objects;
  if (objects) {
    for (const id of value.objects) {
      const o = objects[id];
      if (!o) { fail(`objects: ${id} has no objects/${id}/object.json`); continue; }
      if (o.id !== id) fail(`objects: objects/${id}/object.json has id ${o.id}`);
      if (typeof o.formatVersion !== 'string' || !objectFormats.includes(o.formatVersion)) fail(`objects: ${id} has no known object formatVersion (${JSON.stringify(o.formatVersion)})`);
      else if (!atLeast(value.formatVersion, o.formatVersion)) fail(`objects: ${id} uses object format ${o.formatVersion}, newer than the library's ${value.formatVersion}`);
    }
    for (const id of Object.keys(objects)) if (!value.objects.includes(id)) fail(`objects: objects/${id} is not listed`);
  }
  const files = options.files;
  if (files) {
    const total = files.reduce((n, f) => n + f.size, 0);
    if (files.length > objectLimits.libraryFiles) fail(`library: ${files.length} files, more than ${objectLimits.libraryFiles}`);
    if (total > objectLimits.libraryBytes) fail(`library: ${total} bytes, more than ${objectLimits.libraryBytes}`);
    for (const required of ['library.json', 'LICENSE', 'ATTRIBUTION.md']) if (!files.some(f => f.path === required)) fail(`library: missing ${required}`);
    for (const f of files) if (!f.path.startsWith('objects/') && !value.attribution.some(a => a.path === '.' || a.path === f.path || f.path.startsWith(a.path + '/'))) fail(`attribution: ${f.path} is not covered`);
  }
}
// libraries/releases.json: one pinned archive per id@version.
function validateLibraryReleases(value, fail) {
  for (const [key, r] of Object.entries(value)) {
    if (key !== `${r.id}@${r.version}`) fail(`${key}: key must be id@version (${r.id}@${r.version})`);
    if (!objectFormats.includes(r.formatVersion)) fail(`${key}: formatVersion ${r.formatVersion} is not a known object format`);
    if (!r.url.endsWith(`/${r.id}-${r.version}.tar.zst`)) fail(`${key}: url must end with /${r.id}-${r.version}.tar.zst`);
    if (btoa(String.fromCharCode(...r.sha256.match(/../g).map(h => parseInt(h, 16)))) !== r.nixHash.slice(7)) fail(`${key}: nixHash does not encode sha256`);
  }
}

// Object and library manifests default to their own formatVersion; the release
// record to the newest directory that defines it. Results add `warnings`.
function validateManifestKind(kind, value, method, version, options) {
  if (method) throw new Error('Method context is only valid for IPC');
  const formats = kind === 'library-releases' ? versions.filter(v => has(v, kind)) : objectFormats;
  version ??= kind === 'library-releases' ? formats.at(-1) : formats.includes(value?.formatVersion) ? value.formatVersion : formats.at(-1);
  if (!formats.includes(version)) throw new Error(`Unknown ${kind} format: ${version}`);
  const key = `${version}:${kind}:`;
  if (!validators.has(key)) validators.set(key, ajv.getSchema(`https://hyprune.com/schema/v${version}/${kind}.schema.json`));
  const check = validators.get(key), errors = [], warnings = [], fail = m => errors.push(m), warn = m => warnings.push(m);
  // Name reserved traits and unknown formats plainly; the schema alone would only say
  // "must NOT be valid" or "must be equal to constant".
  const reserved = kind === 'object' && value?.traits && typeof value.traits === 'object'
    ? Object.entries(reservedTraits(version)).filter(([name]) => Object.hasOwn(value.traits, name)) : [];
  for (const [name, why] of reserved) fail(`traits.${name}: ${why}; rejected in object format ${version}`);
  if (kind !== 'library-releases' && value?.formatVersion !== version)
    fail(`formatVersion: ${JSON.stringify(value?.formatVersion)} is not ${formats.includes(value?.formatVersion) ? `the requested ${version}` : `an object format (${formats.join(', ')})`}`);
  if (!check(value)) {
    const said = new Set(reserved.map(([name]) => `/traits/${name}`));
    const schemaErrors = check.errors.filter(e => !(e.keyword === 'not' && said.has(e.instancePath)) && !(e.keyword === 'const' && e.instancePath === '/formatVersion'));
    return { valid: false, errors: [...errors, ...schemaErrors.map(e => `${e.instancePath || '/'} ${e.message}`)], warnings };
  }
  if (errors.length) return { valid: false, errors, warnings };
  const spdx = (text, label) => { try { parseSpdx(text); } catch { fail(`${label}: invalid SPDX expression`); } };
  if (kind !== 'library-releases') {
    const prerelease = value.version.split('+')[0].split('-').slice(1).join('-');
    if (prerelease.split('.').some(p => /^0\d+$/.test(p))) fail('version: numeric prerelease identifiers cannot have leading zeros');
    spdx(value.license, 'license');
    const paths = value.attribution.map(a => a.path);
    if (new Set(paths).size !== paths.length) fail('attribution: duplicate path');
    for (const a of value.attribution) spdx(a.license, `attribution ${a.path}`);
  }
  let stats = {};
  if (kind === 'object') stats = validateObjectManifest(value, version, options, fail, warn) || {};
  if (kind === 'library') validateLibraryManifest(value, options, fail);
  if (kind === 'library-releases') validateLibraryReleases(value, fail);
  return { valid: errors.length === 0, errors, warnings, ...stats };
}
// World 0.9 (RFC-0011 P2): object asset sources, characters, paths, seats and
// keepClear. `supplied` maps a dir or library asset id to its object.json, so its
// traits (character, seat, movable) can be checked like an inline asset's.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const REVERSE_DOMAIN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const worldLimits = Object.freeze({ characters: 16, charactersPerPath: 8, pathPoints: 1024, arcChord: 0.1 });
function validateWorldObjects(value, supplied, fail, unique, quat) {
  const format = value.formatVersion, assets = value.objectAssets || [], objects = value.objects || [];
  const paths = value.paths || [], seats = value.seats || [], keepClear = value.keepClear || [];
  unique(paths, 'id', 'paths'); unique(seats, 'id', 'seats'); unique(keepClear, 'id', 'keepClear');
  // Traits per asset id, when known: inline traits (with the 0.8 shorthand), or a supplied object.json.
  const known = new Map();
  for (const a of assets) {
    const label = `objectAssets ${a.id}`, f = m => fail(`${label}: ${m}`);
    if (a.scene !== undefined) {
      const traits = { ...(a.traits || {}) };
      if (a.animations && a.traits?.decorative) f('animations is shorthand for traits.decorative; give one form');
      if (a.collision && a.traits?.collidable) f('collision is shorthand for traits.collidable; give one form');
      if (a.animations) traits.decorative = { animations: a.animations };
      if (a.collision) traits.collidable = a.collision;
      traitCombinations(Object.keys(traits), f);
      objectTraitRules(a.traits || {}, a.slots || {}, f);
      // The proxy from one form, the animations from the other.
      const crossed = (a.collision && a.traits?.decorative) || (a.traits?.collidable && a.animations);
      if (crossed && traits.decorative.animations.some(n => n.node === traits.collidable.node)) f(`collision node "${traits.collidable.node}" is animated`);
      known.set(a.id, traits);
      continue;
    }
    if (a.library !== undefined) {
      const [id, version] = a.library.split('@');
      if (!REVERSE_DOMAIN.test(id) || !SEMVER.test(version)) f(`library must be <reverse-domain id>@<semver>, is ${a.library}`);
    }
    const manifest = Object.hasOwn(supplied, a.id) ? supplied[a.id] : undefined;
    if (manifest === undefined) continue;
    if (!manifest || typeof manifest.traits !== 'object' || manifest.traits === null) { f('the supplied object.json has no traits'); continue; }
    if (typeof manifest.formatVersion === 'string' && /^\d+\.\d+$/.test(manifest.formatVersion) && !atLeast(format, manifest.formatVersion))
      f(`object format ${manifest.formatVersion} is newer than the world's ${format}`);
    if (a.library !== undefined && manifest.id !== undefined && manifest.id !== a.object) f(`the supplied object.json is ${manifest.id}, not ${a.object}`);
    known.set(a.id, manifest.traits);
  }
  const objectsById = new Map(objects.map(o => [o.id, o])), pathsById = new Map(paths.map(p => [p.id, p]));
  const seatIds = new Set(seats.map(s => s.id)), zoneIds = new Set((value.zones || []).map(z => z.id)), anchorIds = new Set((value.anchors || []).map(a => a.id));
  // A world seat id, else <objectId>[/<anchorId>]; anchors are checkable when the seat's asset is known.
  const seatRef = (ref, where) => {
    const [objectId, anchor] = ref.split('/');
    if (anchor === undefined && seatIds.has(objectId)) return;
    const target = objectsById.get(objectId);
    if (!target) { fail(`${where}: unknown seat ${ref} (not a seats[] id or an object)`); return; }
    const traits = known.get(target.asset);
    if (!traits) return;
    if (!traits.seat) fail(`${where}: object ${objectId} is not a seat`);
    else if (anchor !== undefined && !traits.seat.anchors.some(x => x.id === anchor)) fail(`${where}: seat ${objectId} has no anchor ${anchor}`);
  };
  const objectTarget = (target, where) => {
    if (target.anchor !== undefined && !anchorIds.has(target.anchor)) fail(`${where}: unknown anchor ${target.anchor}`);
    if (target.object !== undefined && !objectsById.has(target.object)) fail(`${where}: unknown object ${target.object}`);
    if (target.zoneId !== undefined && !zoneIds.has(target.zoneId)) fail(`${where}: unknown zone ${target.zoneId}`);
  };
  const route = (id, where) => {
    const p = pathsById.get(id);
    if (!p) fail(`${where}: unknown path ${id}`);
    else if ((p.use ?? 'generic') !== 'route') fail(`${where}: path ${id} is not a route (use ${p.use ?? 'generic'})`);
  };
  let characters = 0;
  const perPath = new Map();
  for (const o of objects) {
    const label = `objects ${o.id}`, traits = known.get(o.asset), character = traits ? !!traits.character : undefined;
    if (o.path === undefined && o.pose === undefined) fail(`${label}: pose is required unless path is set`);
    if (o.path !== undefined && o.pose !== undefined) fail(`${label}: pose and path are exclusive (a bound character starts at its phase along the route)`);
    if (o.reverse !== undefined && o.path === undefined) fail(`${label}: reverse needs a path`);
    if (o.seat !== undefined && o.path !== undefined) fail(`${label}: seat is for characters without a path (routes sit at their stops)`);
    if (character === false) for (const field of ['path', 'seat', 'accent', 'interactions'])
      if (o[field] !== undefined) fail(`${label}: ${field} is for characters; asset ${o.asset} is not a character`);
    if (character && o.scale !== undefined && o.scale !== 1) fail(`${label}: a character's scale must be 1`);
    if (o.locked !== undefined && traits && !traits.movable) fail(`${label}: locked is for movable assets; asset ${o.asset} is not movable`);
    if (character || (character === undefined && o.path !== undefined)) characters++;
    if (o.path !== undefined) { route(o.path, label); perPath.set(o.path, (perPath.get(o.path) || 0) + 1); }
    if (o.seat !== undefined) seatRef(o.seat, `${label} seat`);
    unique(o.interactions || [], 'id', `${label} interactions`);
    for (const i of o.interactions || []) {
      const where = `${label} interaction ${i.id}`;
      if (i.action.type === 'guide') route(i.action.path, where);
      if (i.action.type === 'waypoint') objectTarget(i.action.target, where);
    }
  }
  if (characters > worldLimits.characters) fail(`objects: ${characters} character instances, more than ${worldLimits.characters}`);
  for (const [id, n] of perPath) if (n > worldLimits.charactersPerPath) fail(`paths ${id}: ${n} characters, more than ${worldLimits.charactersPerPath}`);
  let total = 0;
  for (const p of paths) {
    const label = `paths ${p.id}`, n = p.points.length;
    total += n;
    // The point's type is the arriving segment; an open path ignores the first point's.
    p.points.forEach((point, i) => {
      if (point.type !== 'arc' || (i === 0 && !p.closed)) return;
      const prev = p.points[i === 0 ? n - 1 : i - 1].position;
      if (Math.hypot(point.position[0] - prev[0], point.position[2] - prev[2]) < worldLimits.arcChord) fail(`${label} point ${i}: an arc needs a horizontal chord of at least ${worldLimits.arcChord} m`);
    });
    const stopped = new Set();
    for (const stop of p.stops || []) {
      const where = `${label} stop ${stop.point}`;
      if (stop.point >= n) fail(`${where}: the path has ${n} points`);
      if (stopped.has(stop.point)) fail(`${label}: more than one stop at point ${stop.point}`);
      stopped.add(stop.point);
      if (stop.seat !== undefined) seatRef(stop.seat, where);
      if (stop.face) objectTarget(stop.face, where);
    }
  }
  if (total > worldLimits.pathPoints) fail(`paths: ${total} points in total, more than ${worldLimits.pathPoints}`);
  for (const seat of seats) quat(seat.pose.rotation, `seats ${seat.id}`);
  for (const box of keepClear) if (box.min.some((v, i) => v >= box.max[i])) fail(`keepClear ${box.id}: min must be below max on every axis`);
}
// Plain reasons for names world 0.9 reserves; the schema alone reports them as
// unmatched alternatives. Schema errors under each path are replaced by the reason.
function worldReserved(value, version) {
  if (!atLeast(version, '0.9') || !value || typeof value !== 'object') return [];
  const out = [], list = v => Array.isArray(v) ? v : [];
  const traitWhy = { mount: 'reserved for props that hold a window (RFC-0011 P4)', interactive: 'reserved for use actions (RFC-0011 P4)',
    mover: 'needs world format 0.10', machine: 'reserved for RFC-0013 live objects' };
  list(value.objectAssets).forEach((a, i) => {
    if (a?.traits && typeof a.traits === 'object') for (const [name, why] of Object.entries(traitWhy))
      if (Object.hasOwn(a.traits, name)) out.push([`/objectAssets/${i}`, `objectAssets ${a.id}: traits.${name}: ${why}; rejected in world ${version}`]);
  });
  list(value.objects).forEach((o, i) => list(o?.interactions).forEach((x, j) => {
    const type = x?.action?.type;
    if (type === 'travel' || type === 'quest') out.push([`/objects/${i}/interactions/${j}/action`,
      `objects ${o.id} interaction ${x.id}: ${type} is reserved (${type === 'quest' ? 'RFC-0012 quests' : 'player travel'}); rejected in world ${version}`]);
  }));
  return out;
}
// The optional method binds a response to the caller's outstanding request.
// An envelope alone cannot know whether a valid result belongs to that method.
export function validate(kind, value, method, version, options = {}) {
  if (kind === 'scene') {
    if (method) throw new Error('Method context is only valid for IPC');
    return validateScene(value, version ?? '0.1', options.world, options.asset);
  }
  if (manifestKinds.includes(kind)) return validateManifestKind(kind, value, method, version, options);
  version ??= '0.1';
  if (!names.includes(kind) || kind === 'common') throw new Error(`Unknown schema: ${kind}`);
  if (!contractVersions.includes(version)) throw new Error(`Unknown contract: ${version}`);
  const key = `${version}:${kind}:${method || ''}`;
  if (method && kind !== 'ipc') throw new Error('Method context is only valid for IPC');
  if (!validators.has(key)) {
    const directory = kind === 'ipc' && version !== '0.1' ? `v${version}` : kind === 'world' && worldFormats.includes(version) && version !== '0.1' ? `v${version}` : 'v0';
    let schema = `https://hyprune.com/schema/${directory}/${kind}.schema.json`;
    if (method) {
      if (!ajv.getSchema(`${schema}#/$defs/${method}.result`)) throw new Error(`Unknown method: ${method}`);
      schema += `#/$defs/${method}.response`;
    }
    validators.set(key, ajv.getSchema(schema));
  }
  const check = validators.get(key);
  if (!check(value)) {
    const reserved = kind === 'world' && version !== '0.1' ? worldReserved(value, version) : [];
    const said = e => reserved.some(([path]) => e.instancePath === path || e.instancePath.startsWith(path + '/'));
    return { valid: false, errors: [...reserved.map(([, message]) => message), ...check.errors.filter(e => !said(e)).map(e => `${e.instancePath || '/'} ${e.message}`)] };
  }
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
    if (atLeast(value.formatVersion, '0.3')) {
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
    if (atLeast(value.formatVersion, '0.8')) {
      const assets = value.objectAssets || [], objects = value.objects || [];
      unique(assets, 'id', 'objectAssets'); unique(objects, 'id', 'objects');
      const ids = new Set(assets.map(a => a.id));
      for (const a of assets) {
        const label = `objectAssets ${a.id}`, animations = a.animations || [];
        if (a.library !== undefined && !atLeast(value.formatVersion, '0.9')) fail(`${label}: library references are reserved for a later world format; use a package scene`);
        unique(animations, 'node', `${label} animations`);
        for (const n of animations) {
          if (Math.abs(Math.hypot(...n.axis) - 1) > 0.001) fail(`${label}: animation "${n.node}" axis must be a unit vector`);
          if (n.type === 'bob' ? n.amplitude === undefined : n.pivot === undefined) fail(`${label}: ${n.type} animation "${n.node}" needs ${n.type === 'bob' ? 'an amplitude' : 'a pivot'}`);
          if (n.type === 'bob' ? n.pivot !== undefined : n.amplitude !== undefined) fail(`${label}: ${n.type} animation "${n.node}" takes no ${n.type === 'bob' ? 'pivot' : 'amplitude'}`);
        }
        if (a.collision && animations.some(n => n.node === a.collision.node)) fail(`${label}: collision node "${a.collision.node}" is animated`);
      }
      for (const o of objects) {
        if (!ids.has(o.asset)) fail(`objects ${o.id}: unknown asset ${o.asset}`);
        if (o.pose) quat(o.pose.rotation, `objects ${o.id}`);
      }
    }
    if (atLeast(value.formatVersion, '0.9')) validateWorldObjects(value, options.assets || {}, fail, unique, quat);
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

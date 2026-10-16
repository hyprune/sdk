// The MCP tools of RFC-0016, phase E1: worlds, building, machines and checking. Each validates
// its arguments, calls one operation (an SDK function or a core method with the assistant
// profile) and returns its result or its error unchanged; every change is journaled with its
// inverse for `undo`. Metres, degrees (a yaw is a heading: 0 faces -Z, 90 faces +X), world axes.
import {existsSync,readFileSync,readdirSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {BuilderError,applyFloor,applySky,applySpawn,createProject,discard,history,listFloors,listProjects,listSkies,projectFolder,readProject,save,status,
 type Placement} from '../builder.js';
import {checkProject} from '../check.js';
import {lookFolder,lookPose,type LookFrom} from '../look.js';
import {DEFAULT_SIZES,SHAPES,listMaterials,materialsDirOf,plainMaterial,resolveMaterial,setMaterial,stalePrimitives,writePrimitive,
 type MaterialPatch,type Shape} from '../primitives.js';
import {listSources,putSource,removeSource,testSource,type SourceEntry} from '../sources.js';
import {importObject} from '../object-cli.js';
import {validateObject} from '../object.js';
import {rotate} from '../check.js';
import {Session,ToolError} from './session.js';
import type {McpTool,McpToolResult} from './stdio.js';

type Args = Record<string, any>;
type V3 = [number, number, number];
interface Tool extends McpTool {run: (a: Args, s: Session) => Promise<unknown>}
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const r2 = (v: number) => Math.round(v * 100) / 100 + 0;
export const yawQuat = (deg: number): number[] => {const h = deg * Math.PI / 360; return [0, r4(-Math.sin(h)), 0, r4(Math.cos(h))];};
export const quatYaw = (q: number[]): number => r2(-2 * Math.atan2(q[1], q[3]) * 180 / Math.PI);

// ---- schema helpers ----
const num = (description: string, extra: Record<string, unknown> = {}) => ({type: 'number', description, ...extra});
const str = (description: string, extra: Record<string, unknown> = {}) => ({type: 'string', description, ...extra});
const bool = (description: string) => ({type: 'boolean', description});
const vec3 = (description: string) => ({type: 'array', items: {type: 'number'}, minItems: 3, maxItems: 3, description});
const KEY = str('A stable name you choose for it (a slug: a-z, 0-9, -; 1 to 48 characters). Calls with the same key act on the same thing.', {pattern: '^[a-z][a-z0-9-]{0,47}$'});
const DRY = bool('Check everything and answer what would change; change nothing.');
const PROJECT = str('A world folder (its slug, local.<slug> id or path). Default: the one in focus.');
const PROVENANCE = {license: str('SPDX licence of the file (CC0-1.0, CC-BY-4.0, ...)'), author: str('Its author'), source: str('Where it came from (a link)')};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({type: 'object', properties, required, additionalProperties: false});
const WHERE = {
 position: vec3('Absolute position [x, y, z] in metres (y up; objects stand on their base).'),
 on: obj({key: str('The placement it stands on'), face: {enum: ['top', 'front', 'back', 'left', 'right'], description: 'Default top'}}, ['key']),
 relativeTo: obj({key: str('A placement'), offset: vec3('Metres from that placement\'s position, world axes')}, ['key', 'offset']),
};

// ---- geometry of the folder ----
function objectBounds(folder: string, ref: string): {min: V3; max: V3} {
 try {const o = JSON.parse(readFileSync(join(folder, 'objects', ref.replace(/^world\//, ''), 'object.json'), 'utf8')); if (o.bounds) return o.bounds;} catch {/* unknown */}
 return {min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5]};
}
function worldBox(folder: string, p: {ref: string; pose: {position: number[]; rotation: number[]}; scale?: number}): {min: V3; max: V3} {
 const b = objectBounds(folder, p.ref), s = p.scale ?? 1, min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
 for (let i = 0; i < 8; i++) {
  const c = rotate(p.pose.rotation, [(i & 1 ? b.max[0] : b.min[0]) * s, (i & 2 ? b.max[1] : b.min[1]) * s, (i & 4 ? b.max[2] : b.min[2]) * s]);
  for (let k = 0; k < 3; k++) {min[k] = Math.min(min[k], c[k] + p.pose.position[k]); max[k] = Math.max(max[k], c[k] + p.pose.position[k]);}
 }
 return {min: min.map(r4) as V3, max: max.map(r4) as V3};
}
function findPlacement(s: Session, folder: string, key: string): Placement & {behaviours?: unknown[]} {
 const live = s.instance(key);
 const p = s.placements(folder).find(x => x.key === key || x.id === key) as any;
 if (!p && !live) throw new ToolError('object.unknown', `No placement called ${key}`, 'world_describe lists the placements and their keys');
 return live ? {...p, id: live.id, ref: live.ref, key: live.key, pose: live.pose, scale: live.scale ?? 1, behaviours: (live.behaviours ?? []).map((b: any) => b.behaviour)} : p;
}
function resolvePosition(s: Session, folder: string, a: Args): number[] | undefined {
 if (Array.isArray(a.position)) {
  if (a.position.length !== 3 || a.position.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) throw new ToolError('pose.invalid', 'position is [x, y, z] in metres');
  return a.position;
 }
 if (a.on) {
  const t = findPlacement(s, folder, a.on.key), b = worldBox(folder, t), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const face = a.on.face ?? 'top';
  return ({top: [c[0], b.max[1], c[2]], front: [c[0], b.min[1], b.max[2]], back: [c[0], b.min[1], b.min[2]], left: [b.min[0], b.min[1], c[2]], right: [b.max[0], b.min[1], c[2]]} as any)[face].map(r4);
 }
 if (a.relativeTo) {
  const t = findPlacement(s, folder, a.relativeTo.key), o = a.relativeTo.offset;
  return t.pose.position.map((v, i) => r4(v + o[i]));
 }
 return undefined;
}
const poseOut = (i: any) => ({id: i.id, key: i.key ?? null, ref: i.ref, position: i.pose.position.map(r4), yaw: quatYaw(i.pose.rotation), rotation: i.pose.rotation.map(r4), scale: i.scale ?? 1,
 ...(i.screen ? {workspace: i.screen.workspace ?? null} : {}), state: i.state});
/** Generated object directories and copies nobody places any more and the last save doesn't have. */
function pruneOrphans(folder: string): string[] {
 const used = new Set(readProject(folder).placements.map(p => p.ref.replace(/^world\//, '')));
 let tracked = new Set<string>();
 try {tracked = new Set(execFileSync('git', ['-C', folder, 'ls-files', 'objects'], {encoding: 'utf8'}).split('\n').map(f => f.split('/')[1]).filter(Boolean));} catch {/* no git */}
 const removed: string[] = [];
 const dir = join(folder, 'objects');
 if (!existsSync(dir)) return removed;
 for (const id of readdirSync(dir).filter(d => !d.startsWith('.')))
  if (!used.has(id) && !tracked.has(id)) {rmSync(join(dir, id), {recursive: true, force: true}); removed.push(id);}
 return removed;
}
/** The folder files a sky, floor or spawn change rewrites: kept for undo (restored byte for byte). */
const FOLDER_FILES = ['builder/base.json', 'builder/project.json', 'sky/panorama.jpg', 'starter/land.glb', 'floor/texture.jpg'];
function snapshotFiles(folder: string): Map<string, Buffer | null> {
 return new Map(FOLDER_FILES.map(f => [f, existsSync(join(folder, f)) ? readFileSync(join(folder, f)) : null]));
}
function restoreFiles(folder: string, files: Map<string, Buffer | null>): void {
 for (const [f, bytes] of files) {
  if (bytes === null) rmSync(join(folder, f), {force: true});
  else {mkdirSync(dirname(join(folder, f)), {recursive: true}); writeFileSync(join(folder, f), bytes);}
 }
}
/** Hyprune shows a folder's new sky, floor or files after it loads the folder again (if it has it open). */
async function reloadIfOpen(s: Session, folder: string): Promise<boolean> {
 const c = await s.core();
 if (!c) return false;
 const slug = status(folder).projectId;
 if (s.state()?.builder?.projectId !== slug) return false;
 await s.call('world.load', {worldId: `local.${slug}`});
 for (let i = 0; i < 120 && s.state()?.builder?.projectId !== slug; i++) await new Promise(r => setTimeout(r, 250));
 return true;
}
async function waitInstance(s: Session, test: () => boolean, ms = 8000): Promise<void> {
 for (let t = 0; t < ms && !test(); t += 100) await new Promise(r => setTimeout(r, 100));
}

// ---- world summary (RFC-0016 rule 7) ----
export function describeWorld(s: Session, folder: string): Record<string, unknown> {
 const st = status(folder), project = readProject(folder) as any, live = s.state();
 const open = live?.builder?.projectId === st.projectId;
 const instances = open ? new Map<string, any>((live?.objects?.instances ?? []).map((i: any) => [i.id, i])) : new Map();
 const placements = project.placements.map((p: any) => {
  const i = instances.get(p.id), pose = i?.pose ?? p.pose, scale = i?.scale ?? p.scale ?? 1;
  let primitive: any = null, name = p.ref;
  try {
   const dir = join(folder, 'objects', p.ref.replace(/^world\//, ''));
   name = JSON.parse(readFileSync(join(dir, 'object.json'), 'utf8')).name;
   if (existsSync(join(dir, 'primitive.json'))) {const r = JSON.parse(readFileSync(join(dir, 'primitive.json'), 'utf8')); primitive = {shape: r.shape, size: r.size, material: r.material?.key ?? r.material?.name ?? null};}
  } catch {/* listed by ref */}
  const box = worldBox(folder, {ref: p.ref, pose, scale});
  return {id: p.id, key: p.key ?? null, ref: p.ref, name, position: pose.position.map(r4), yaw: quatYaw(pose.rotation), scale,
   size: box.max.map((v, k) => r2(v - box.min[k])), top: box.max[1], ...(primitive ? {primitive} : {}), ...(p.workspace ? {workspace: p.workspace} : {}),
   ...(p.behaviours?.length ? {behaviours: p.behaviours.map((b: any) => ({key: b.key, property: b.property, source: b.input?.source ?? null}))} : {}),
   ...(i ? {state: i.state} : {})};
 });
 const ids = new Set(project.placements.map((p: any) => p.id));
 const sources = listSourcesSafe().filter(e => ids.has(e.id) || e.id.startsWith('assistant-')).map(sourceSummary);
 let checklist: unknown = null;
 try {const c = JSON.parse(readFileSync(join(folder, 'builder/cache/check.json'), 'utf8')); checklist = {ready: c.ready, open: c.items.filter((x: any) => !x.done).map((x: any) => ({id: x.id, target: x.target ?? null, message: x.message}))};} catch {/* run checklist */}
 const out = {projectId: st.projectId, worldId: st.worldId, name: st.name, folder, openInHyprune: open, starter: st.starter,
  sky: st.sky.preset ? {preset: st.sky.preset} : {image: st.sky.image, license: st.sky.license}, floor: st.floor ? {preset: st.floor.preset, image: st.floor.image, tile: st.floor.tile} : null,
  spawn: st.spawn, placements, materials: listMaterials(materialsDirOf(folder)).map(m => ({key: m.key, name: m.name, colour: m.colour, textured: m.textured, tile: m.tile})),
  sources, checklist, pending: {...st.pending, changes: st.changes}, lastSave: st.lastSave?.message ?? null, version: st.lastVersion?.version ?? null};
 // At most 64 KiB: long placement lists lose their detail first.
 let text = JSON.stringify(out);
 if (text.length > 65536) {(out as any).placements = placements.map((p: any) => ({id: p.id, key: p.key, ref: p.ref, position: p.position})); (out as any).truncated = true;}
 return out;
}
function listSourcesSafe(): SourceEntry[] {try {return listSources();} catch {return [];}}
/** A source without secrets (header values that are secrets show their names only). */
function sourceSummary(e: SourceEntry): Record<string, unknown> {
 return {id: e.id, kind: e.kind ?? 'command', ...(e.url ? {url: e.url} : {}), ...(e.argv ? {argv: e.argv} : {}), ...(e.map ? {map: e.map} : {}),
  ...(e.headers ? {headers: Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k, typeof v === 'object' ? {secret: v.secret} : '(set)']))} : {}),
  ...(e.confirm ? {confirm: e.confirm} : {}), ...(e.intervalS ? {intervalS: e.intervalS} : {})};
}

// ---- the tools ----
export const TOOLS: Tool[] = [
 {name: 'world_list', description: 'List the world folders on this computer (with unsaved changes and versions) and which one Hyprune has open.', inputSchema: obj({}),
  run: async (_a, s) => {const open = s.state()?.builder?.projectId; return {worlds: listProjects().map(p => ({projectId: p.projectId, name: p.name, placements: p.placements, unsaved: p.pending.total, version: p.lastVersion?.version ?? null, open: p.projectId === open})), focus: s.folder ? status(s.folder).projectId : null};}},
 {name: 'world_create', description: 'Make a new world folder from the Open Plain starter (a big flat plain) with a sky, a floor and a spawn, save it once, focus it and open it in Hyprune when running. Skies: clear-day, sunset, overcast, night (or an equirectangular image). Floors: grid, grass, sand, paving, concrete (or a tileable image).',
  inputSchema: obj({name: str('The world\'s name (1 to 64 characters)'), sky: str('A built-in sky'), skyImage: obj({path: str('An equirectangular PNG, JPEG, EXR or HDR, 2:1'), ...PROVENANCE}, ['path', 'license', 'author', 'source']),
   floor: str('A built-in floor'), floorImage: obj({path: str('A tileable PNG or JPEG'), ...PROVENANCE}, ['path', 'license', 'author', 'source']), tile: num('Metres one copy of the floor covers (0.25 to 100)'),
   spawn: obj({position: vec3('Where you start, on the plain'), yaw: num('Heading in degrees'), facing: {enum: ['sun', 'away', 'left', 'right']}}),
   ifExists: {enum: ['error', 'open'], description: 'A folder of that name exists: error (default) or open it'}, open: bool('Open it in Hyprune (default true)'), dryRun: DRY}, ['name']),
  run: async (a, s) => {
   await s.checkPaused();
   const sky = a.sky ? {preset: a.sky} : a.skyImage ? {image: a.skyImage.path, license: a.skyImage.license, author: a.skyImage.author, source: a.skyImage.source} : undefined;
   const floor = a.floor ? {preset: a.floor, ...(a.tile ? {tile: a.tile} : {})} : a.floorImage ? {image: a.floorImage.path, license: a.floorImage.license, author: a.floorImage.author, source: a.floorImage.source, ...(a.tile ? {tile: a.tile} : {})} : undefined;
   const o = {sky, floor, spawn: a.spawn, ifExists: 'error' as const};
   let created: any;
   try {created = a.dryRun ? await createProject(a.name, {...o, dryRun: true}) : await createProject(a.name, o);}
   catch (e: any) {
    if (e instanceof BuilderError && e.code === 'project.exists' && a.ifExists === 'open') created = {projectId: String(e.data?.projectId ?? ''), existing: true, folder: projectFolder(String(e.data?.projectId ?? a.name))};
    else throw e;
   }
   if (a.dryRun) return created;
   s.folder = created.folder;
   let opened = false;
   if (a.open !== false && await s.core()) {await s.call('world.load', {worldId: `local.${status(created.folder).projectId}`}); opened = true;}
   if (!created.existing) await s.record({action: `created the world ${a.name}`, tool: 'world_create', undo: null});
   return {...created, opened};
  }},
 {name: 'world_open', description: 'Focus a world folder for the other tools and open it in Hyprune (editor mode) when running.', inputSchema: obj({project: PROJECT, open: bool('Open it in Hyprune (default true)')}, ['project']),
  run: async (a, s) => {
   s.folder = s.folderOf(a.project);
   let opened = false;
   if (a.open !== false && await s.core()) {await s.call('world.load', {worldId: `local.${status(s.folder).projectId}`}); opened = true;
    await waitInstance(s, () => s.state()?.builder?.projectId === status(s.folder!).projectId, 30000);}
   return {...describeWorld(s, s.folder), opened};
  }},
 {name: 'world_describe', description: 'The world in focus in one read: placements (keys, refs, positions, sizes, tops), sky, floor, spawn, materials, data sources (no secrets), the checklist and unsaved changes. Never any window data.', inputSchema: obj({project: PROJECT}),
  run: async (a, s) => describeWorld(s, s.folderOf(a.project))},
 {name: 'world_set_sky', description: 'Change the sky: a built-in preset or an equirectangular image with its licence, author and source. Hyprune reloads the world to show it.',
  inputSchema: obj({preset: str('clear-day, sunset, overcast or night'), image: obj({path: str('The image file'), ...PROVENANCE}, ['path', 'license', 'author', 'source']), project: PROJECT, dryRun: DRY}),
  run: async (a, s) => {
   const folder = s.folderOf(a.project);
   if (!a.preset === !a.image) throw new ToolError('sky.invalid', 'Give a preset or an image', `Presets: ${listSkies().map(x => x.id).join(', ')}`);
   if (!a.dryRun) await s.checkPaused();
   const before = a.dryRun ? null : snapshotFiles(folder);
   const r = await applySky(folder, a.preset ? {preset: a.preset} : {image: a.image.path, license: a.image.license, author: a.image.author, source: a.image.source}, {dryRun: !!a.dryRun});
   if (a.dryRun) return r;
   const reloaded = await reloadIfOpen(s, folder);
   await s.record({action: `set the sky to ${a.preset ?? 'an image'}`, tool: 'world_set_sky', undo: async () => {restoreFiles(folder, before!); await reloadIfOpen(s, folder);}});
   return {...r, reloaded};
  }},
 {name: 'world_set_floor', description: 'Change the floor of the plain: a built-in floor or a tileable image (with provenance), and how many metres one copy covers. Hyprune reloads the world to show it.',
  inputSchema: obj({preset: str('grid, grass, sand, paving or concrete'), image: obj({path: str('A tileable PNG or JPEG'), ...PROVENANCE}, ['path', 'license', 'author', 'source']), tile: num('Metres per copy (0.25 to 100)'), project: PROJECT, dryRun: DRY}),
  run: async (a, s) => {
   const folder = s.folderOf(a.project);
   const choice: any = a.preset ? {preset: a.preset} : a.image ? {image: a.image.path, license: a.image.license, author: a.image.author, source: a.image.source} : {};
   if (a.tile !== undefined) choice.tile = a.tile;
   if (!Object.keys(choice).length) throw new ToolError('floor.invalid', 'Give a preset, an image or a tile', `Floors: ${listFloors().map(x => x.id).join(', ')}`);
   if (!a.dryRun) await s.checkPaused();
   const before = a.dryRun ? null : snapshotFiles(folder);
   const r = await applyFloor(folder, choice, {dryRun: !!a.dryRun});
   if (a.dryRun) return r;
   const reloaded = await reloadIfOpen(s, folder);
   await s.record({action: `set the floor to ${a.preset ?? 'an image'}`, tool: 'world_set_floor', undo: async () => {restoreFiles(folder, before!); await reloadIfOpen(s, folder);}});
   return {...r, reloaded};
  }},
 {name: 'spawn_set', description: 'Where the player starts: a position on the floor and a heading (or facing the sun).', inputSchema: obj({position: vec3('On the floor'), yaw: num('Heading in degrees: 0 faces -Z, 90 faces +X'), facing: {enum: ['sun', 'away', 'left', 'right']}, project: PROJECT, dryRun: DRY}),
  run: async (a, s) => {
   const folder = s.folderOf(a.project);
   if (!a.dryRun) await s.checkPaused();
   const before = a.dryRun ? null : snapshotFiles(folder);
   const r = await applySpawn(folder, {...(a.position ? {position: a.position} : {}), ...(a.yaw !== undefined ? {yaw: a.yaw} : {}), ...(a.facing ? {facing: a.facing} : {})}, {dryRun: !!a.dryRun});
   if (!a.dryRun) await s.record({action: `moved the spawn to ${r.position.join(', ')}`, tool: 'spawn_set', undo: async () => restoreFiles(folder, before!)});
   return r;
  }},
 {name: 'catalog_search', description: 'What can be placed: shapes (cube, box, cylinder, sphere, plane, ramp, stairs) with their default sizes, the folder\'s materials, and objects from the catalog (libraries, your imports, workspace screens) matching a query.',
  inputSchema: obj({query: str('Words to match in names, categories and tags'), limit: num('At most this many objects (default 30)')}),
  run: async (a, s) => {
   const shapes = SHAPES.map(sh => ({shape: sh, defaultSize: DEFAULT_SIZES[sh]}));
   let materials: unknown[] = [];
   try {materials = listMaterials(materialsDirOf(s.folderOf())).map(m => ({key: m.key, name: m.name, colour: m.colour, textured: m.textured}));} catch {/* no folder */}
   const q = String(a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean), limit = Math.max(1, Math.min(100, a.limit ?? 30));
   let objects: unknown[] = [], note: string | undefined;
   if (await s.core()) {
    const r = await s.call('objects.catalog', {});
    objects = (r.entries ?? []).filter((e: any) => e.placeable && !e.primitive).filter((e: any) => !q.length || q.every(w => `${e.name} ${e.category ?? ''} ${(e.tags ?? []).join(' ')} ${e.ref}`.toLowerCase().includes(w)))
     .slice(0, limit).map((e: any) => ({ref: e.ref, name: e.name, category: e.category ?? null, size: e.bounds ? e.bounds.max.map((v: number, k: number) => r2(v - e.bounds.min[k])) : null,
      screen: (e.traits ?? []).includes('mount') || /screen/.test(e.ref), license: e.provenance?.license ?? null}));
   } else note = 'Hyprune is not running: only shapes and materials are listed';
   return {shapes, materials, objects, ...(note ? {note} : {})};
  }},
 {name: 'place', description: 'Place a shape (with a size and a material or colour) or a catalog object in the open world folder, under a key. Give the position, or put it on another placement (on: {key, face}) or relative to one. With ifExists "update" a placement with that key moves to the new pose instead (retrying a build never makes copies). Workspace screens take a workspace number (21 and up).',
  inputSchema: obj({key: KEY, shape: {enum: [...SHAPES]}, size: {type: 'array', items: {type: 'number'}, minItems: 1, maxItems: 3, description: 'Metres [x, y, z] (a cube takes one number)'}, steps: num('Stairs only'),
   material: str('A material key (material_set makes one)'), colour: str('#rrggbb, when no material'), glow: obj({colour: str('#rrggbb'), strength: num('0 to 16')}, ['colour', 'strength']),
   ref: str('A catalog object instead of a shape (catalog_search lists them)'), ...WHERE, yaw: num('Heading in degrees (default 0: its front faces +Z)'), scale: num('Uniform scale of a catalog object (0.25 to 4)'),
   workspace: num('Workspace screens: the workspace it shows (21 and up)'), ifExists: {enum: ['error', 'update'], description: 'Default error'}, dryRun: DRY}, ['key']),
  run: async (a, s) => {
   const {folder} = await s.loadedFolder();
   if (!a.dryRun) await s.checkPaused();
   if (!a.shape === !a.ref) throw new ToolError('place.invalid', 'Give a shape or a ref', 'catalog_search lists both');
   const position = resolvePosition(s, folder, a);
   if (!position) throw new ToolError('pose.invalid', 'Give a position, on or relativeTo');
   let ref = a.ref, made: any = null;
   if (a.shape) {
    const material = a.material ? await resolveMaterial(materialsDirOf(folder), a.material)
     : plainMaterial({colour: a.colour ?? '#d8d8d8', emissive: a.glow ?? null});
    made = await writePrimitive(join(folder, 'objects'), 'world', {shape: a.shape as Shape, size: a.size ?? DEFAULT_SIZES[a.shape as Shape], ...(a.steps ? {steps: a.steps} : {})}, material,
     {dryRun: !!a.dryRun, validate: dir => validateObject(dir)});
    ref = made.ref;
    if (a.dryRun && made.created) return {dryRun: true, ref, made: made.primitive, position, note: 'the shape would be generated, then placed'};
   }
   const previous = s.instance(a.key);
   const params: Args = {ref, pose: {position, rotation: yawQuat(a.yaw ?? 0)}, key: a.key, ...(a.scale !== undefined ? {scale: a.scale} : {}),
    ...(a.workspace !== undefined ? {workspace: a.workspace} : {}), ...(a.ifExists ? {ifExists: a.ifExists} : {}), ...(a.dryRun ? {dryRun: true} : {})};
   const r = await s.call('objects.place', params);
   if (a.dryRun) return {dryRun: true, ...r};
   await waitInstance(s, () => s.instance(a.key)?.ref === ref);
   const now = s.instance(a.key);
   const undo = previous && previous.id === r.id
    ? async () => {
       if (previous.ref !== ref) await s.call('objects.configure', {key: a.key, patch: {ref: previous.ref}});
       await s.call('objects.transform', {key: a.key, pose: previous.pose, ...(previous.scale !== undefined ? {scale: previous.scale} : {})});
       pruneOrphans(folder);
      }
    : async () => {await s.call('objects.remove', {key: a.key}); await waitInstance(s, () => !s.instance(a.key)); pruneOrphans(folder);};
   await s.record({action: `${previous ? 'moved' : 'placed'} ${a.key}`, tool: 'place', undo});
   return {...(now ? poseOut(now) : {id: r.id, key: a.key, ref, position}), created: !previous, ...(made ? {shape: made.primitive} : {})};
  }},
 {name: 'edit', description: 'Change a placement by key with absolute values: position (or on/relativeTo), yaw, scale, a shape\'s size or material, a screen\'s workspace, or its key. Unnamed fields keep their value.',
  inputSchema: obj({key: str('The placement'), ...WHERE, yaw: num('Heading in degrees'), scale: num('Uniform scale (catalog objects)'), size: {type: 'array', items: {type: 'number'}, minItems: 1, maxItems: 3, description: 'Shapes: new size in metres'},
   material: str('Shapes: a material key'), colour: str('Shapes: #rrggbb instead of a material'), workspace: {type: ['number', 'null'], description: 'Screens: the workspace (null for none)'}, newKey: KEY, dryRun: DRY}, ['key']),
  run: async (a, s) => {
   const {folder} = await s.loadedFolder();
   if (!a.dryRun) await s.checkPaused();
   const cur = s.instance(a.key);
   if (!cur) throw new ToolError('object.unknown', `No placement called ${a.key}`, 'world_describe lists the placements');
   const position = resolvePosition(s, folder, a), dry = a.dryRun ? {dryRun: true} : {}, steps: string[] = [];
   const undo: Array<() => Promise<void>> = [];
   if (position || a.yaw !== undefined || a.scale !== undefined) {
    const pose = {position: position ?? cur.pose.position, rotation: a.yaw !== undefined ? yawQuat(a.yaw) : cur.pose.rotation};
    await s.call('objects.transform', {id: cur.id, pose, ...(a.scale !== undefined ? {scale: a.scale} : {}), ...dry});
    steps.push('moved');
    undo.push(async () => {await s.call('objects.transform', {id: cur.id, pose: cur.pose, scale: cur.scale ?? 1});});
   }
   const patch: Args = {};
   if (a.size || a.material || a.colour) {
    const dir = join(folder, 'objects', cur.ref.replace(/^world\//, ''));
    const prim = existsSync(join(dir, 'primitive.json')) ? JSON.parse(readFileSync(join(dir, 'primitive.json'), 'utf8')) : null;
    if (!prim) throw new ToolError('edit.invalid', `${a.key} is not a shape`, 'Only shapes take a size or a material; scale catalog objects');
    const material = a.material ? await resolveMaterial(materialsDirOf(folder), a.material) : a.colour ? plainMaterial({colour: a.colour})
     : prim.material?.key ? await resolveMaterial(materialsDirOf(folder), prim.material.key) : plainMaterial({colour: prim.material?.colour ?? '#d8d8d8', emissive: prim.material?.emissive ?? null});
    const made = await writePrimitive(join(folder, 'objects'), 'world', {shape: prim.shape, size: a.size ?? prim.size, ...(prim.steps ? {steps: prim.steps} : {})}, material, {dryRun: !!a.dryRun, validate: d => validateObject(d)});
    if (made.ref !== cur.ref) {patch.ref = made.ref; steps.push('reshaped');}
   }
   if (a.workspace !== undefined) {patch.workspace = a.workspace; steps.push('rebound');}
   if (a.newKey) {patch.key = a.newKey; steps.push('renamed');}
   if (Object.keys(patch).length) {
    if (!(a.dryRun && patch.ref && !existsSync(join(folder, 'objects', patch.ref.replace(/^world\//, ''))))) await s.call('objects.configure', {id: cur.id, patch, ...dry});
    undo.push(async () => {
     const back: Args = {};
     if (patch.ref) back.ref = cur.ref;
     if (patch.workspace !== undefined) back.workspace = cur.screen?.workspace ?? null;
     if (patch.key) back.key = cur.key ?? null;
     await s.call('objects.configure', {id: cur.id, patch: back});
     pruneOrphans(folder);
    });
   }
   if (a.dryRun) return {dryRun: true, would: steps};
   const key = a.newKey ?? a.key;
   await waitInstance(s, () => !!s.instance(key) && (!patch.ref || s.instance(key).ref === patch.ref));
   await s.record({action: `${steps.join(', ') || 'kept'} ${a.key}`, tool: 'edit', undo: async () => {for (const u of undo.reverse()) await u();}});
   return s.instance(key) ? poseOut(s.instance(key)) : {key};
  }},
 {name: 'remove', description: 'Remove a placement by key. Removing one that is not there succeeds with removed: false.', inputSchema: obj({key: str('The placement'), dryRun: DRY}, ['key']),
  run: async (a, s) => {
   const {folder} = await s.loadedFolder();
   if (!a.dryRun) await s.checkPaused();
   const cur = s.instance(a.key);
   const behaviours = cur?.behaviours?.map((b: any) => b.behaviour) ?? [];
   const r = await s.call('objects.remove', {key: a.key, ...(a.dryRun ? {dryRun: true} : {})});
   if (a.dryRun || !cur || r.removed === false) return r;
   await s.record({action: `removed ${a.key}`, tool: 'remove', undo: async () => {
    await s.call('objects.place', {ref: cur.ref, pose: cur.pose, key: a.key, ...(cur.scale !== undefined ? {scale: cur.scale} : {}), ...(cur.screen?.workspace ? {workspace: cur.screen.workspace} : {})});
    await waitInstance(s, () => !!s.instance(a.key));
    if (behaviours.length) await s.call('objects.configure', {key: a.key, patch: {behaviours}});
   }});
   pruneOrphans(folder);
   return {...r, removed: true};
  }},
 {name: 'material_set', description: 'Make or change a material in the world folder: colour, a texture image (with provenance) or a built-in texture (grid, grass, sand, paving, concrete) repeated every `tile` metres, glow, roughness, metalness. Shapes made with it are rebuilt and swapped in place.',
  inputSchema: obj({key: KEY, name: str('Shown in the Director'), colour: str('#rrggbb'), texture: {oneOf: [obj({path: str('A PNG or JPEG'), ...PROVENANCE}, ['path', 'license', 'author', 'source']), obj({preset: str('A built-in texture')}, ['preset']), {type: 'null'}]},
   tile: num('Metres per texture copy'), glow: {oneOf: [obj({colour: str('#rrggbb'), strength: num('0 to 16')}, ['colour', 'strength']), {type: 'null'}]}, roughness: num('0 to 1'), metallic: num('0 to 1'), project: PROJECT, dryRun: DRY}, ['key']),
  run: async (a, s) => {
   const folder = s.folderOf(a.project), dir = materialsDirOf(folder);
   if (!a.dryRun) await s.checkPaused();
   const patch: MaterialPatch = {};
   for (const k of ['name', 'colour', 'roughness', 'metallic', 'tile'] as const) if (a[k] !== undefined) (patch as any)[k] = a[k];
   if (a.glow !== undefined) patch.emissive = a.glow;
   if (a.texture !== undefined) patch.texture = a.texture;
   const existed = existsSync(join(dir, a.key, 'material.json'));
   // Kept for undo: the material's files, byte for byte.
   const before = existed ? new Map(readdirSync(join(dir, a.key)).map(f => [f, readFileSync(join(dir, a.key, f))])) : null;
   const r = await setMaterial(dir, a.key, patch, {dryRun: !!a.dryRun});
   if (a.dryRun) return r;
   // Shapes made with the old content: rebuilt, and their placements swapped (same id and key).
   const swaps = await swapStale(s, folder, a.key);
   await s.record({action: `${existed ? 'changed' : 'made'} the material ${a.key}`, tool: 'material_set', undo: async () => {
    rmSync(join(dir, a.key), {recursive: true, force: true});
    if (before) {
     mkdirSync(join(dir, a.key), {recursive: true});
     for (const [f, bytes] of before) writeFileSync(join(dir, a.key, f), bytes);
     await swapStale(s, folder, a.key);
    }
    pruneOrphans(folder);
   }});
   return {...r, swaps};
  }},
 {name: 'import', description: 'Import a model file (glTF, GLB, OBJ, FBX, DAE, 3DS, PLY, STL, or a .zip of one) into your objects, with its licence, author and source. Returns its ref for place. Only CC0 or CC-BY files should be used in worlds you share.',
  inputSchema: obj({path: str('The local file'), name: str('A name'), units: {enum: ['auto', 'm', 'cm', 'mm', 'in', 'ft']}, up: {enum: ['y', 'z']}, yaw: {enum: [0, 90, 180, 270]}, surface: {enum: ['floor', 'wall', 'ceiling', 'any']},
   entry: str('In a .zip with several models: which one'), ...PROVENANCE}, ['path', 'license', 'author', 'source']),
  run: async (a, s) => {
   await s.checkPaused();
   const path = String(a.path);
   if (!path.startsWith('/') || path.split('/').some(p => p.startsWith('.') && p.length > 1)) throw new ToolError('import.source', 'Give an absolute path outside hidden directories');
   const r = await importObject(path, {name: a.name, units: a.units, up: a.up, yaw: a.yaw, surface: a.surface, entry: a.entry, license: a.license, author: a.author, source: a.source});
   await s.record({action: `imported ${r.manifest.name}`, tool: 'import', undo: null});
   return {ref: r.ref, name: r.manifest.name, size: r.after.extent, triangles: r.after.triangles, warnings: r.warnings};
  }},
 {name: 'source_list', description: 'The data sources Hyprune reads (sources.json), without secret values. A placement reads the source whose id is its placement id unless a behaviour names another.', inputSchema: obj({}),
  run: async () => ({sources: listSources().map(sourceSummary)})},
 {name: 'source_set_http', description: 'Make or change an HTTP data source (no confirmation needed: it only fetches). `for` names the placement whose behaviours read it (the source id becomes that placement\'s id). map turns the JSON reply into values: {"value": {"path": "$.queue.depth", "min": 0, "max": 50}, "display": "{raw:.0f} queued"} (value is scaled from min..max to 0..100, what behaviours read; display is a text template). The source helper checks the definition; a refused one is not kept.',
  inputSchema: obj({for: str('The placement key that reads it'), id: str('Or an explicit source id'), url: str('https:// (or http:// on this machine or the local network)'), method: {enum: ['GET', 'POST', 'PUT', 'PATCH']},
   headers: {type: 'object', additionalProperties: {oneOf: [{type: 'string'}, obj({secret: str('A secret\'s name (set by the user in Hyprune)'), prefix: str('Like "Bearer "')}, ['secret'])]}},
   map: {type: 'object', description: '{"value": {"path": "$.a.b", "min": 0, "max": 100}, "display": "{raw:.0f} %", "label": "text"}'}, intervalS: num('Seconds between fetches'), output: {enum: ['json', 'number', 'text', 'lines']}, dryRun: DRY}, ['url']),
  run: async (a, s) => {
   let id = a.id;
   if (a.for) {const {folder} = await s.loadedFolder(); id = findPlacement(s, folder, a.for).id;}
   if (!id) throw new ToolError('source.invalid', 'Give for (a placement key) or an id');
   if (!a.dryRun) await s.checkPaused();
   const previous = listSources().find(e => e.id === id) ?? null;
   const entry: SourceEntry = {id, kind: 'http', url: a.url, ...(a.method ? {method: a.method} : {}), ...(a.headers ? {headers: a.headers} : {}), ...(a.map ? {map: a.map} : {}),
    ...(a.intervalS ? {intervalS: a.intervalS} : {}), ...(a.output ? {output: a.output} : {})};
   const r = await putSource(entry, {dryRun: !!a.dryRun});
   if (!a.dryRun && r.changed) await s.record({action: `set the data source of ${a.for ?? id}`, tool: 'source_set_http', undo: async () => {
    if (!previous) {await removeSource(id); return;}
    const clear = Object.fromEntries(Object.keys(r.entry).filter(k => !(k in previous)).map(k => [k, null]));
    await putSource({...clear, ...previous} as SourceEntry);
   }});
   return {...r, entry: sourceSummary(r.entry)};
  }},
 {name: 'source_test', description: 'Run a data source once with the source helper\'s rules (nothing is published): its raw reply and the mapped values. Give an id or a definition.',
  inputSchema: obj({id: str('An existing source'), for: str('Or the placement key that reads it'), definition: {type: 'object', description: 'Or a source as source_set_http takes it, with kind "http"'}}),
  run: async (a, s) => {
   let entry: SourceEntry | undefined = a.definition ? {id: 'test', kind: 'http', ...a.definition} : undefined;
   if (!entry) {
    let id = a.id;
    if (a.for) {const {folder} = await s.loadedFolder(); id = findPlacement(s, folder, a.for).id;}
    entry = listSources().find(e => e.id === id);
    if (!entry) throw new ToolError('source.unknown', `No data source ${id}`, 'source_list lists them');
   }
   return testSource(entry);
  }},
 {name: 'behaviour_set', description: 'Make a placement follow data: scale (a bar growing up from its base: anchor bottom), move, rotate, colour, glow, visible or texture, from A to B as the value goes 0 to 100. Adds or replaces the behaviour with that key; display only (collision stays at rest). Example: {"key": "grow", "property": "scale", "from": [1, 0.05, 1], "to": [1, 1, 1], "anchor": "bottom"}.',
  inputSchema: obj({placement: str('The placement key'), behaviour: {type: 'object', description: 'key, property (scale|move|rotate|colour|glow|visible|texture), from, to, and optional input {source, key, min, max}, anchor, colour, mode, easing, smoothing'}, dryRun: DRY}, ['placement', 'behaviour']),
  run: async (a, s) => setBehaviours(a, s, list => {const b = a.behaviour; if (!b?.key) throw new ToolError('behaviour.invalid', 'A behaviour needs a key'); return [...list.filter(x => x.key !== b.key), b];}, `set the behaviour ${a.behaviour?.key} of ${a.placement}`)},
 {name: 'behaviour_remove', description: 'Remove a behaviour (by its key) from a placement.', inputSchema: obj({placement: str('The placement key'), behaviour: str('The behaviour key'), dryRun: DRY}, ['placement', 'behaviour']),
  run: async (a, s) => setBehaviours(a, s, list => list.filter(x => x.key !== a.behaviour), `removed the behaviour ${a.behaviour} of ${a.placement}`)},
 {name: 'look', description: 'Look at the world: a PNG from the spawn, an overview of the whole folder, a placement key (seen from its front) or an explicit pose {position, yaw, pitch} or {position, lookAt}. Drawn by Hyprune when it has the folder open (windows as empty screens), else by a simple CPU renderer. Look after each building pass.',
  inputSchema: obj({from: {oneOf: [str('spawn, overview or a placement key'), obj({position: vec3('Eye position'), yaw: num('Heading'), pitch: num('Up/down in degrees'), lookAt: vec3('Or a point to look at')}, ['position'])]},
   fov: num('Vertical field of view, degrees (default 70)'), size: {type: 'array', items: {type: 'integer'}, minItems: 2, maxItems: 2, description: '[width, height], at most 1024'}, renderer: {enum: ['auto', 'hyprune', 'cpu']}, project: PROJECT}),
  run: async (a, s) => {
   const folder = s.folderOf(a.project), size: [number, number] = a.size ?? [1024, 576], fov = a.fov ?? 70, from: LookFrom = a.from ?? 'spawn';
   const open = (await s.core()) && s.state()?.builder?.projectId === status(folder).projectId;
   if (open && a.renderer !== 'cpu') {
    const pose = lookPose(folder, from, overviewBounds(s, folder));
    const r = await s.call('preview.render', {pose: {position: pose.position, yaw: pose.yaw, pitch: pose.pitch}, fov, size});
    return {image: readFileSync(r.path), pose, fov, renderer: 'hyprune', ms: r.renderMs};
   }
   if (a.renderer === 'hyprune') throw new ToolError('look.offline', 'Hyprune does not have this folder open', 'world_open it, or use the cpu renderer');
   const r = await lookFolder(folder, {from, fov, size});
   return {image: r.png, pose: r.pose, fov, renderer: 'cpu', ms: r.ms};
  }},
 {name: 'checklist', description: 'The builder\'s checklist for the folder: spawn on the floor, each screen\'s approach (clear space in front, visible, at a good height, reachable on foot), the walkable area, budgets, recorded licences, official publishing and unsaved changes. Blocking items must be done before a release.',
  inputSchema: obj({project: PROJECT, fresh: bool('Check again even if nothing changed')}),
  run: async (a, s) => {const r = await checkProject(s.folderOf(a.project), {cache: !a.fresh}); return {ready: r.ready, items: r.items, homes: r.homes, walk: r.walk};}},
 {name: 'save', description: 'Save the folder: a local commit (labelled as the assistant\'s) that History and Revert can undo in Hyprune. Never publishes.', inputSchema: obj({message: str('What changed'), project: PROJECT}),
  run: async (a, s) => {await s.checkPaused(); const r = await save(s.folderOf(a.project), String(a.message ?? ''), {prefix: 'Assistant: '}); s.savedLength = s.journal.length; s.cleanAfterSave = true; await s.report(`saved: ${r.message}`); return {commit: r.commit, message: r.message, warnings: r.warnings};}},
 {name: 'discard', description: 'Put the folder back to its last save (all unsaved changes, or only some paths). Hyprune reloads the folder. Clears this session\'s undo list.', inputSchema: obj({paths: {type: 'array', items: {type: 'string'}}, project: PROJECT, dryRun: DRY}),
  run: async (a, s) => {
   const folder = s.folderOf(a.project);
   if (!a.dryRun) await s.checkPaused();
   const r = await discard(folder, {paths: a.paths, dryRun: !!a.dryRun});
   if (a.dryRun) return r;
   s.journal = []; s.savedLength = 0; s.cleanAfterSave = true;
   return {...r, reloaded: await reloadIfOpen(s, folder)};
  }},
 {name: 'history', description: 'The saves of the folder, newest first, with versions and which ones an assistant made.', inputSchema: obj({limit: num('Default 20'), project: PROJECT}),
  run: async (a, s) => ({history: history(s.folderOf(a.project), a.limit ?? 20)})},
 {name: 'undo', description: 'Undo this session\'s last changes (default 1), newest first, each with its inverse operation. Changes that can\'t be undone here (creating a world, imports, saves) are skipped and named.', inputSchema: obj({steps: num('How many (default 1)')}),
  run: async (a, s) => {
   const undone: string[] = [], skipped: string[] = [];
   for (let i = 0; i < Math.max(1, Math.min(256, a.steps ?? 1)) && s.journal.length; i++) {
    const e = s.journal.pop()!;
    if (!e.undo) {skipped.push(e.action); continue;}
    await e.undo();
    undone.push(e.action);
   }
   // Back to the last save in a folder that was saved then: the inverses restored every placement,
   // material and setting; Discard puts back what they can't (a re-placed placement's id and order).
   let normalized = false;
   if (undone.length && s.journal.length <= s.savedLength && s.cleanAfterSave && s.folder) {
    const d = await discard(s.folder);
    if (d.restored.length || d.removed.length) await reloadIfOpen(s, s.folder);
    normalized = true;
   }
   s.changes++;
   await s.report(undone.length ? `undid ${undone[0]}` : undefined);
   return {undone, skipped, left: s.journal.length, ...(normalized ? {backToLastSave: true} : {})};
  }},
];
function overviewBounds(s: Session, folder: string): {min: V3; max: V3} | undefined {
 const ps = s.placements(folder);
 if (!ps.length) return undefined;
 const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
 for (const p of ps) {const b = worldBox(folder, p); for (let k = 0; k < 3; k++) {min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]);}}
 return {min, max};
}
async function swapStale(s: Session, folder: string, key: string): Promise<Array<{from: string; to: string}>> {
 const material = await resolveMaterial(materialsDirOf(folder), key), swaps: Array<{from: string; to: string}> = [];
 for (const st of stalePrimitives(join(folder, 'objects'), key, material)) {
  const r = await writePrimitive(join(folder, 'objects'), 'world', {shape: st.shape, size: st.size, ...(st.steps ? {steps: st.steps} : {})}, material, {validate: d => validateObject(d)});
  const from = `world/${st.id}`;
  if (await s.core() && s.state()?.builder) for (const i of (s.state()?.objects?.instances ?? []).filter((x: any) => x.ref === from))
   await s.call('objects.configure', {id: i.id, patch: {ref: r.ref}});
  swaps.push({from, to: r.ref});
 }
 return swaps;
}
async function setBehaviours(a: Args, s: Session, change: (list: any[]) => any[], action: string): Promise<unknown> {
 await s.loadedFolder();
 if (!a.dryRun) await s.checkPaused();
 const cur = s.instance(a.placement);
 if (!cur) throw new ToolError('object.unknown', `No placement called ${a.placement}`, 'world_describe lists the placements');
 const before = (cur.behaviours ?? []).map((b: any) => b.behaviour), after = change(before);
 const r = await s.call('objects.configure', {id: cur.id, patch: {behaviours: after}, ...(a.dryRun ? {dryRun: true} : {})});
 if (a.dryRun) return {dryRun: true, ...r, behaviours: after};
 await s.record({action, tool: 'behaviour', undo: async () => {await s.call('objects.configure', {id: cur.id, patch: {behaviours: before}});}});
 return {placement: a.placement, behaviours: after};
}

/** Whether the folder had no unsaved changes (checked before a session's first change after a save). */
export function folderClean(s: Session): boolean {
 try {return s.journal.length <= s.savedLength && !!s.folder && status(s.folder).pending.total === 0;} catch {return false;}
}
/** Runs a tool: its result as JSON text (and an image for look), or its error as a tool error. */
export async function runTool(name: string, args: Args, s: Session): Promise<McpToolResult> {
 const tool = TOOLS.find(t => t.name === name)!;
 s.cleanBeforeCall = folderClean(s);
 try {
  const r: any = await tool.run(args, s);
  if (r && Buffer.isBuffer(r.image)) {
   const {image, ...rest} = r;
   return {content: [{type: 'image', data: image.toString('base64'), mimeType: 'image/png'}, {type: 'text', text: JSON.stringify(rest)}], structuredContent: rest};
  }
  const out = r && typeof r === 'object' && !Array.isArray(r) ? r : {result: r};
  return {content: [{type: 'text', text: JSON.stringify(out)}], structuredContent: out};
 } catch (e: any) {
  const error = {code: e.code ?? e.rule ?? 'failed', message: String(e.message ?? e).split('\n')[0], ...(e.hint ? {hint: e.hint} : {}), ...(e.data ? {data: e.data} : {}),
   retryable: !!e.retryable};
  return {content: [{type: 'text', text: JSON.stringify({error})}], structuredContent: {error}, isError: true};
 }
}

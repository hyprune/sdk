// Editing an object entry after it was added (RFC-0014 "Simplify", "Repair" and "Managing
// objects", as amended): `object adjust` re-fits an import's units, up axis, facing and
// surface; `object simplify` decimates it again and shrinks its textures, with the numbers
// before and after; `object repair` brings back an entry the validator refuses. Each works on a
// user-folder entry (user/<id>) or a world folder's copy (world/<id> with --project), keeps a
// backup under $XDG_STATE_HOME/hyprune/backups, swaps the directory atomically and takes
// --dry-run. Imports keep no original, so a re-fit starts from the converted object.glb.
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {objectDir} from './paths.js';
import {validateObject} from './object.js';
import {UNITS,buildImport,fitRotation,type ImportOptions,type Measure,type Surface,type Units} from './import.js';

export type EditCode = 'object.unknown' | 'object.unsupported' | 'object.invalid' | 'adjust.invalid' | 'adjust.nothing' | 'repair.nothing' | 'repair.failed';
export class EditError extends Error {
 constructor(public code: EditCode, message: string, public hint?: string) {super(message);}
}
const fail = (code: EditCode, message: string, hint?: string): never => {throw new EditError(code, message, hint);};
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

export interface Entry {ref: string; id: string; dir: string; source: 'user' | 'world'}
/** user/<id> in the user folder, or world/<id> in a world folder (project = its folder). */
export function resolveEntry(ref: string, project?: string): Entry {
 const m = /^(user|world)\/([a-z][a-z0-9-]{0,63})$/.exec(ref);
 if (!m || m[2].endsWith('-')) fail('object.unknown', `${ref} is not an object ref (user/<id>, or world/<id> with a project)`);
 const source = m![1] as 'user' | 'world', id = m![2];
 if (source === 'world' && !project) fail('object.unknown', `${ref} is a world folder's copy: name the folder (--project)`);
 const dir = source === 'user' ? join(objectDir(), id) : join(project!, 'objects', id);
 if (!existsSync(join(dir, 'object.json')) || lstatSync(dir).isSymbolicLink()) fail('object.unknown', `${ref} has no object directory (${dir})`);
 return {ref, id, dir, source};
}

// ---- backups (RFC-0014 Repair): newest 32 kept, none older than 30 days ----
export function backupsDir(env = process.env): string {
 const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith('/') ? env.XDG_STATE_HOME : join(env.HOME || homedir(), '.local', 'state');
 return join(state, 'hyprune', 'backups');
}
export function backup(e: Entry, reason: string): string {
 const root = backupsDir(), stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
 mkdirSync(root, {recursive: true, mode: 0o700});
 let id = `${stamp}-object-${e.id}`, n = 2;
 while (existsSync(join(root, id))) id = `${stamp}-object-${e.id}-${n++}`;
 const dir = join(root, id);
 cpSync(e.dir, join(dir, 'files'), {recursive: true});
 const files = readdirSync(join(dir, 'files'), {recursive: true}).map(String).sort();
 writeFileSync(join(dir, 'backup.json'), JSON.stringify({kind: 'object', target: e.dir, ref: e.ref, reason, createdAt: new Date().toISOString(), files}, null, 1) + '\n', {mode: 0o600});
 const all = readdirSync(root).filter(d => existsSync(join(root, d, 'backup.json'))).sort().reverse(), old = Date.now() - 30 * 86400_000;
 all.forEach((d, i) => {if (i >= 32 || statSync(join(root, d)).mtimeMs < old) rmSync(join(root, d), {recursive: true, force: true});});
 return id;
}
/** Puts a backup back (backing up what it replaces first). */
export async function restoreBackup(id: string): Promise<{ref: string; dir: string; backup: string}> {
 const dir = join(backupsDir(), id), meta = existsSync(join(dir, 'backup.json')) ? readJson(join(dir, 'backup.json')) : null;
 if (!meta || meta.kind !== 'object' || !/^[\w.-]+$/.test(id)) fail('object.unknown', `no object backup ${id}`);
 const e: Entry = {ref: meta.ref, id: meta.ref.split('/')[1], dir: meta.target, source: meta.ref.startsWith('world/') ? 'world' : 'user'};
 const saved = existsSync(e.dir) ? backup(e, `before restoring ${id}`) : '';
 await swap(e.dir, staged => cpSync(join(dir, 'files'), staged, {recursive: true}), false);
 return {ref: e.ref, dir: e.dir, backup: saved};
}

/** Builds the new directory beside the target, validates it, then swaps it in (the previous one is removed). */
async function swap(target: string, fill: (dir: string) => void, check = true): Promise<string[]> {
 const staging = mkdtempSync(join(dirname(target), '.hyprune-edit-'));
 try {
  const dir = join(staging, 'new');
  mkdirSync(dir); fill(dir);
  const warnings = check ? (await validateObject(dir, {directoryName: false})).warnings : [];
  if (existsSync(target)) {
   const old = join(staging, 'old'); renameSync(target, old);
   try {renameSync(dir, target);} catch (e) {renameSync(old, target); throw e;}
  } else renameSync(dir, target);
  return warnings;
 } finally {rmSync(staging, {recursive: true, force: true});}
}

// ---- re-fitting from the converted model ----
const SIMPLE_TRAITS = new Set(['collidable', 'movable']);
function refittable(e: Entry, manifest: any): void {
 const named = Object.keys(manifest.traits ?? {}).filter(t => !SIMPLE_TRAITS.has(t));
 if (named.length) fail('object.unsupported', `${e.ref} names its parts (${named.join(', ')}): re-fitting would merge them`, 'Change it in its source and import it again');
 if (existsSync(join(e.dir, 'primitive.json'))) fail('object.unsupported', `${e.ref} is a generated shape`, 'Change its size or material with the shape tools instead');
}
type M3 = number[];
const transpose = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const mul3 = (a: M3, b: M3): M3 => [0, 1, 2].flatMap(c => [0, 1, 2].map(r => a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]));
const identity = (m: M3) => m.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-9);

export interface Fit {units: Units | 'custom'; scale: number; up: 'y' | 'z'; yaw: 0 | 90 | 180 | 270; surface: Surface}
export interface EditResult {
 ref: string; dir: string; dryRun?: true; backup: string | null; before: Measure; after: Measure; steps: string[]; warnings: string[];
 fit?: {from: Fit; to: Fit};
}
function currentFit(dir: string, manifest: any): {fit: Fit; record: any | null} {
 const record = existsSync(join(dir, 'import.json')) ? readJson(join(dir, 'import.json')) : null, o = record?.options;
 const surface = (manifest.traits?.movable?.surfaces?.[0] ?? 'floor') as Surface;
 return {record, fit: o ? {units: o.units, scale: o.scale, up: o.up, yaw: o.yaw, surface: o.surface ?? surface} : {units: 'm', scale: 1, up: 'y', yaw: 0, surface}};
}
async function refit(e: Entry, o: ImportOptions & {thumbnail?: 'keep' | 'new'; dryRun?: boolean; reason: string; step: (b: Measure, a: Measure) => string; fit?: Fit}): Promise<EditResult> {
 const manifest = readJson(join(e.dir, 'object.json'));
 refittable(e, manifest);
 const {record, fit} = currentFit(e.dir, manifest);
 const build = await buildImport(join(e.dir, manifest.scene ?? 'object.glb'), {...o, id: manifest.id, name: manifest.name,
  lighting: manifest.lighting?.mode === 'unlit' ? 'unlit' : 'lit', collision: o.collision ?? (manifest.traits?.collidable ? record?.options?.collision ?? 'convex' : 'none')});
 const before: Measure = record?.measured?.after ?? build.before, after = build.after;
 const step = o.step(before, after);
 const next = structuredClone(manifest);
 next.bounds = (build.manifest as any).bounds;
 const traits = (build.manifest as any).traits;
 if (traits.collidable) next.traits = {...next.traits, collidable: traits.collidable}; else if (next.traits) delete next.traits.collidable;
 const surface = o.surface ?? fit.surface;
 if (surface !== fit.surface || !next.traits?.movable) next.traits = {...next.traits, movable: {...(next.traits?.movable ?? {}), ...traits.movable}};
 const steps = [...build.steps.filter(s => !/^read |^converted /.test(s))];
 const result: EditResult = {ref: e.ref, dir: e.dir, backup: null, before, after, steps: [step, ...steps], warnings: build.warnings,
  ...(o.fit ? {fit: {from: fit, to: o.fit}} : {})};
 if (o.dryRun) return {...result, dryRun: true};
 let nextRecord: any = null;
 if (record) {
  nextRecord = structuredClone(record);
  const b = build.record as any;
  if (o.fit) nextRecord.options = {...nextRecord.options, units: o.fit.units, scale: o.fit.scale, up: o.fit.up, yaw: o.fit.yaw, surface: o.fit.surface};
  nextRecord.options = {...nextRecord.options, maxTriangles: b.options.maxTriangles, maxTexture: b.options.maxTexture, collision: b.options.collision};
  nextRecord.measured = {before: record.measured?.before ?? before, after};
  nextRecord.steps = [...(record.steps ?? []), step].slice(-32).map((s: string) => s.slice(0, 256));
 }
 result.backup = backup(e, o.reason);
 const keepThumb = o.thumbnail === 'keep' && existsSync(join(e.dir, manifest.thumbnail ?? 'thumbnail.png'));
 result.warnings.push(...await swap(e.dir, dir => {
  for (const f of readdirSync(e.dir)) if (!['object.glb', 'object.json', 'import.json', manifest.thumbnail ?? 'thumbnail.png'].includes(f)) cpSync(join(e.dir, f), join(dir, f), {recursive: true});
  writeFileSync(join(dir, manifest.scene ?? 'object.glb'), build.glb);
  if (keepThumb) cpSync(join(e.dir, manifest.thumbnail ?? 'thumbnail.png'), join(dir, manifest.thumbnail ?? 'thumbnail.png'));
  else writeFileSync(join(dir, manifest.thumbnail ?? 'thumbnail.png'), build.thumbnail);
  writeFileSync(join(dir, 'object.json'), JSON.stringify(next, null, 1) + '\n');
  if (nextRecord) writeFileSync(join(dir, 'import.json'), JSON.stringify(nextRecord, null, 1) + '\n');
 }));
 return result;
}

export interface AdjustChange {units?: Units; scale?: number; up?: 'y' | 'z'; yaw?: 0 | 90 | 180 | 270; surface?: Surface}
/** Re-fits an import with absolute values: the units (or a scale), the up axis, the turn and the surface it sits on. */
export async function adjustObject(e: Entry, change: AdjustChange, o: {dryRun?: boolean} = {}): Promise<EditResult> {
 if (change.units !== undefined && change.scale !== undefined) fail('adjust.invalid', 'Give the units or a scale, not both');
 if (change.scale !== undefined && !(change.scale > 0 && change.scale <= 1000)) fail('adjust.invalid', 'The scale must be above 0 and at most 1000');
 if (change.units !== undefined && !(change.units in UNITS)) fail('adjust.invalid', `Units: ${Object.keys(UNITS).join(', ')}`);
 const manifest = readJson(join(e.dir, 'object.json'));
 const {fit} = currentFit(e.dir, manifest);
 const to: Fit = {units: change.units ?? (change.scale !== undefined ? 'custom' : fit.units), scale: change.units ? UNITS[change.units] : change.scale ?? fit.scale,
  up: change.up ?? fit.up, yaw: change.yaw ?? fit.yaw, surface: change.surface ?? fit.surface};
 const turn = mul3(fitRotation(to.up, to.yaw), transpose(fitRotation(fit.up, fit.yaw))), ratio = to.scale / fit.scale;
 if (identity(turn) && Math.abs(ratio - 1) < 1e-9 && to.surface === fit.surface) fail('adjust.nothing', `${e.ref} already has these units, axes and surface`);
 const what = [Math.abs(ratio - 1) > 1e-9 ? `scale x${r4(ratio)}` : '', !identity(turn) ? `${to.up === 'z' ? 'Z up' : 'Y up'}, turned ${to.yaw} degrees` : '', to.surface !== fit.surface ? `on the ${to.surface}` : ''].filter(Boolean).join(', ');
 return refit(e, {scale: ratio, rotation: turn, surface: to.surface, maxTriangles: 2_000_000, maxTexture: 8192, ktx2: 'off', thumbnail: identity(turn) ? 'keep' : 'new',
  dryRun: o.dryRun, reason: `adjust: ${what}`, fit: to, step: (b, a) => `adjusted: ${what} (${b.extent.join(' x ')} -> ${a.extent.join(' x ')} m)`});
}

export interface SimplifyOptions {maxTriangles?: number; maxTexture?: 256 | 512 | 1024 | 2048 | 4096 | 8192; collision?: 'convex' | 'box' | 'none'; dryRun?: boolean}
/** Decimates again (meshoptimizer), shrinks PNG/JPEG textures and rebuilds the collision proxy; the numbers before and after. */
export async function simplifyObject(e: Entry, o: SimplifyOptions = {}): Promise<EditResult> {
 const manifest = readJson(join(e.dir, 'object.json'));
 refittable(e, manifest);
 const {fit} = currentFit(e.dir, manifest);
 const r = await refit(e, {scale: 1, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], surface: fit.surface, maxTriangles: o.maxTriangles ?? 50_000, maxTexture: o.maxTexture ?? 2048,
  collision: o.collision, ktx2: 'auto', thumbnail: 'keep', dryRun: o.dryRun, reason: 'simplify',
  step: (b, a) => `simplified: ${b.triangles} -> ${a.triangles} triangles, textures ${b.maxTexture} -> ${a.maxTexture} px`});
 if (r.after.triangles >= r.before.triangles && r.after.maxTexture >= r.before.maxTexture) r.warnings.push('nothing got smaller: lower the triangle or texture target');
 return r;
}

// ---- repair ----
export interface RepairResult {ref: string; dir: string; dryRun?: true; backup: string | null; problems: string[]; fixed: string[]; valid: boolean}
/** RFC-0014 Repair for an object entry: recompute the bounds, drop traits that name missing parts or are unknown, then validate. */
export async function repairObject(e: Entry, o: {dryRun?: boolean} = {}): Promise<RepairResult> {
 const problems: string[] = [];
 try {await validateObject(e.dir, {directoryName: false}); fail('repair.nothing', `${e.ref} is valid: nothing to repair`);}
 catch (x: any) {if (x instanceof EditError) throw x; problems.push(...String(x.message).split('\n').filter(Boolean).slice(0, 8));}
 let manifest: any;
 try {manifest = readJson(join(e.dir, 'object.json'));} catch {return fail('repair.failed', `${e.ref}: object.json is not JSON`, 'Delete the entry, or restore a backup');}
 const fixed: string[] = [], next = structuredClone(manifest);
 const {libs, sceneTriangles} = await import('./import.js');
 const L = await libs();
 let doc: any = null;
 try {doc = await L.io.read(join(e.dir, manifest.scene ?? 'object.glb'));} catch {return fail('repair.failed', `${e.ref}: its model can't be read`, 'Delete the entry and import the model again');}
 const names = new Set(doc.getRoot().listNodes().map((n: any) => n.getName()));
 const tris = sceneTriangles(L, doc).tris;
 if (tris.length) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t) for (let i = 0; i < 3; i++) {lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]);}
  const bounds = {min: lo.map(r4), max: hi.map(r4)};
  if (JSON.stringify(bounds) !== JSON.stringify(manifest.bounds)) {next.bounds = bounds; fixed.push('recomputed the bounds from the model');}
 }
 const nodeOk = (n: unknown) => typeof n === 'number' ? n >= 0 && n < doc.getRoot().listNodes().length : names.has(n);
 if (next.traits?.collidable && !nodeOk(next.traits.collidable.node)) {delete next.traits.collidable; fixed.push(`dropped collidable (no node ${manifest.traits.collidable.node})`);}
 for (const a of next.traits?.mount?.anchors ?? []) if (a.frameNode && !nodeOk(a.frameNode)) {delete a.frameNode; fixed.push(`dropped the frame node of anchor ${a.id}`);}
 const schema = readJson(new URL(`../../vendor/schema/v${manifest.formatVersion === '0.9' || manifest.formatVersion === '0.10' ? manifest.formatVersion : '0.11'}/object.schema.json`, import.meta.url).pathname);
 const known = new Set(Object.keys(schema.properties?.traits?.properties ?? {}));
 for (const t of Object.keys(next.traits ?? {})) if (!known.has(t)) {delete next.traits[t]; fixed.push(`dropped the unknown trait ${t}`);}
 if (next.thumbnail && !existsSync(join(e.dir, next.thumbnail))) {delete next.thumbnail; fixed.push('dropped the missing thumbnail');}
 // Check the result in a scratch copy before touching the entry.
 const scratch = mkdtempSync(join(dirname(e.dir), '.hyprune-repair-'));
 let valid = false;
 try {
  cpSync(e.dir, join(scratch, 'x'), {recursive: true});
  writeFileSync(join(scratch, 'x', 'object.json'), JSON.stringify(next, null, 1) + '\n');
  try {await validateObject(join(scratch, 'x'), {directoryName: false}); valid = true;}
  catch (x: any) {if (!fixed.length) return fail('repair.failed', `${e.ref} can't be repaired automatically: ${String(x.message).split('\n')[0]}`, 'Delete the entry and import the model again, or restore a backup');}
 } finally {rmSync(scratch, {recursive: true, force: true});}
 if (!valid) return fail('repair.failed', `${e.ref} is still invalid after ${fixed.join(', ')}`, 'Delete the entry and import the model again, or restore a backup');
 if (o.dryRun) return {ref: e.ref, dir: e.dir, dryRun: true, backup: null, problems, fixed, valid};
 const id = backup(e, 'repair');
 await swap(e.dir, dir => {
  for (const f of readdirSync(e.dir)) if (f !== 'object.json') cpSync(join(e.dir, f), join(dir, f), {recursive: true});
  writeFileSync(join(dir, 'object.json'), JSON.stringify(next, null, 1) + '\n');
 });
 return {ref: e.ref, dir: e.dir, backup: id, problems, fixed, valid};
}
export const entryDir = (ref: string, project?: string) => resolve(resolveEntry(ref, project).dir);

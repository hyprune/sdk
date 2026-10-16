// `hyprune object import` (RFC-0014 P1 as amended): turn a model file into an RFC-0011 object
// directory in the user folder without Blender. glTF/GLB are read directly; OBJ, FBX, COLLADA,
// 3DS, PLY and STL go through Assimp compiled to WebAssembly. The import fits units, up axis,
// facing and the pivot, drops what objects don't use, decimates with meshoptimizer to a triangle
// target, shrinks textures and encodes them to KTX2 (Basis Universal in WebAssembly), builds a
// convex or box collision proxy, renders a CPU thumbnail, compresses the geometry (meshopt,
// quantised) and writes object.json and import.json. Sizes over the recommendations are
// warnings, never refusals (object format 0.11). The heavy dependencies load only here.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {basename,dirname,extname,join,relative} from 'node:path';
import {register} from 'node:module';
import type {Document,Node as GltfNode,Primitive,Texture} from '@gltf-transform/core';
import {decodeImage,encodePng,fitInside} from './pixels.js';

export const IMPORT_FORMATS = {gltf: 'gltf', glb: 'glb', obj: 'obj', fbx: 'fbx', dae: 'dae', '3ds': '3ds', ply: 'ply', stl: 'stl'} as const;
export type ImportFormat = keyof typeof IMPORT_FORMATS;
export const UNITS = {m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048} as const;
export type Units = keyof typeof UNITS;
export type Surface = 'floor' | 'wall' | 'ceiling' | 'any';
export const CATEGORIES = ['furniture', 'lighting', 'plants', 'signage', 'machines', 'decor', 'characters', 'vehicles', 'other'] as const;
/** RFC-0014 safety limits for an object import (not size judgements). */
export const IMPORT_LIMITS = Object.freeze({sourceBytes: 2 * 1024 ** 3, assimpFiles: 256, assimpBytes: 512 * 1024 ** 2, ktx2Seconds: 60});
/** The recommendations an import aims at by default (RFC-0011 per-asset budgets). */
export const IMPORT_DEFAULTS = Object.freeze({maxTriangles: 50000, maxTexture: 2048, collisionTriangles: 2000});

export interface ImportOptions {
 id?: string; name?: string; description?: string; category?: string; tags?: string[];
 surface?: Surface; units?: Units | 'auto'; scale?: number; up?: 'y' | 'z'; yaw?: 0 | 90 | 180 | 270;
 maxTriangles?: number; maxTexture?: 256 | 512 | 1024 | 2048 | 4096 | 8192; collision?: 'convex' | 'box' | 'none';
 ktx2?: 'auto' | 'all' | 'off'; lighting?: 'lit' | 'unlit';
 license?: string; author?: string; source?: string;
 progress?: (stage: string, message?: string) => void;
}
export interface Measure {triangles: number; maxTexture: number; gpuBytes: number; collisionTriangles: number | null; extent: [number, number, number]}
export interface Inspection {
 file: string; sourceName: string; format: ImportFormat; backend: 'gltf' | 'assimp'; bytes: number; sha256: string;
 name: string; id: string; triangles: number; nodes: number; meshes: number; materials: number;
 textures: Array<{name: string; width: number; height: number; mimeType: string}>; maxTexture: number; gpuBytes: number;
 extent: [number, number, number]; unitsGuess: Units; scaleGuess: number; extentMetres: [number, number, number]; up: 'y' | 'z';
 animations: number; skins: number; warnings: string[];
 /** A suggestion for the author field: the user's git user.name, else empty (never the project's name). */
 author: string;
 recommendations: {maxTriangles: number; maxTexture: number; overTriangles: boolean; overTexture: boolean};
}
export interface ImportBuild {
 manifest: Record<string, unknown>; record: Record<string, unknown>; glb: Uint8Array; thumbnail: Buffer;
 before: Measure; after: Omit<Measure, 'gpuBytes'> & {gpuBytes: number}; steps: string[]; warnings: string[];
}

type Mat3 = number[];
const errorWith = (message: string, rule: string) => Object.assign(new Error(message), {rule});
const round4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

// ---- loading ----
let hooked = false;
export async function libs() {
 // glTF-Transform's functions import ndarray-pixels, whose Node build loads sharp (native):
 // resolve it to the pure-JavaScript replacement first (pixels-hooks.ts).
 if (!hooked) {register(new URL('./pixels-hooks.js', import.meta.url)); hooked = true;}
 const core = await import('@gltf-transform/core');
 const ext = await import('@gltf-transform/extensions');
 const fn = await import('@gltf-transform/functions');
 const mo = await import('meshoptimizer');
 await Promise.all([mo.MeshoptDecoder.ready, mo.MeshoptEncoder.ready, mo.MeshoptSimplifier.ready]);
 const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS)
  .registerDependencies({'meshopt.decoder': mo.MeshoptDecoder, 'meshopt.encoder': mo.MeshoptEncoder});
 return {core, ext, fn, mo, io};
}
export type Libs = Awaited<ReturnType<typeof libs>>;

export function importFormat(file: string): ImportFormat {
 const e = extname(file).slice(1).toLowerCase();
 if (!(e in IMPORT_FORMATS)) throw errorWith(`${basename(file)}: unsupported format (glTF, GLB, OBJ, FBX, DAE, 3DS, PLY or STL; Blender users export glTF)`, 'import.unsupported');
 return e as ImportFormat;
}

/** A display name from a file name: "old_oak-barrel.glb" -> "Old oak barrel". */
export function nameFromFile(file: string): string {
 const stem = basename(file, extname(file)).replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
 return (stem.charAt(0).toUpperCase() + stem.slice(1)).slice(0, 64) || 'Imported object';
}
/** An object id: a lowercase slug starting with a letter, at most 64 characters. */
export function importSlug(text: string): string {
 let slug = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
 if (!/^[a-z]/.test(slug)) slug = 'object-' + slug;
 return slug.slice(0, 64).replace(/-+$/, '') || 'object';
}

function sourceFile(file: string) {
 const st = lstatSync(file);
 if (st.isSymbolicLink() || !st.isFile()) throw errorWith(`${file}: not a regular file`, 'import.source');
 if (st.size > IMPORT_LIMITS.sourceBytes) throw errorWith(`${basename(file)} is larger than 2 GiB`, 'import.limit');
 const bytes = readFileSync(file);
 return {bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
}

// glTF: refuse remote resources and Draco (no decoder bundled) before parsing the rest.
function checkGltfJson(json: any) {
 for (const r of [...(json.buffers || []), ...(json.images || [])])
  if (typeof r?.uri === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(r.uri) && !r.uri.startsWith('data:'))
   throw errorWith(`a resource is remote (${r.uri.slice(0, 80)}): download it next to the file first`, 'import.remote');
 if ((json.extensionsUsed || []).includes('KHR_draco_mesh_compression'))
  throw errorWith('the glTF is Draco-compressed, which the importer can\'t decode yet: export it without Draco', 'import.draco');
}

// Files next to an OBJ/FBX/... (its MTL, textures) for Assimp, at most two folders deep.
function siblings(file: string): Array<{path: string; data: Uint8Array}> {
 const root = dirname(file), out: Array<{path: string; data: Uint8Array}> = [];
 let total = 0;
 const walk = (dir: string, depth: number) => {
  for (const d of readdirSync(dir, {withFileTypes: true})) {
   const full = join(dir, d.name);
   if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
   if (d.isDirectory() && depth < 2) walk(full, depth + 1);
   else if (d.isFile() && full !== file) {
    const size = statSync(full).size;
    if (out.length >= IMPORT_LIMITS.assimpFiles || total + size > IMPORT_LIMITS.assimpBytes) continue;
    total += size; out.push({path: relative(root, full).split('\\').join('/'), data: readFileSync(full)});
   }
  }
 };
 walk(root, 0);
 return out;
}

// glTF-Transform logs to stdout, which carries the CLI's JSON lines: warnings and errors only, on stderr.
function quiet(L: Libs, doc: Document): Document {
 const log = (...a: unknown[]) => console.error(...a);
 return doc.setLogger({debug: () => {}, info: () => {}, warn: log, error: log} as any);
}
// The Basis encoder (WebAssembly) prints its progress with console.log: keep it off stdout.
export async function offStdout<T>(work: () => Promise<T>): Promise<T> {
 const log = console.log;
 console.log = () => {};
 try {return await work();} finally {console.log = log;}
}
async function load(L: Libs, file: string) {
 const format = importFormat(file), {bytes, sha256} = sourceFile(file);
 if (format === 'gltf' || format === 'glb') {
  if (format === 'gltf') checkGltfJson(JSON.parse(bytes.toString('utf8')));
  else if (bytes.readUInt32LE(0) === 0x46546c67) checkGltfJson(JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')));
  try {return {doc: quiet(L, await L.io.read(file)), format, backend: 'gltf' as const, bytes: bytes.length, sha256};}
  catch (e: any) {throw errorWith(`${basename(file)}: not a readable glTF (${String(e.message).split('\n')[0]})`, 'import.invalid');}
 }
 const assimp = await (await import('assimpjs')).default();
 const list = new assimp.FileList();
 list.AddFile(basename(file), new Uint8Array(bytes));
 for (const s of siblings(file)) list.AddFile(s.path, s.data);
 const result = assimp.ConvertFileList(list, 'glb2');
 if (!result.IsSuccess() || result.FileCount() < 1) throw errorWith(`${basename(file)}: Assimp could not read it (${result.GetErrorCode()})`, 'import.invalid');
 const glb = result.GetFile(0).GetContent();
 return {doc: quiet(L, await L.io.readBinary(glb)), format, backend: 'assimp' as const, bytes: bytes.length, sha256};
}

// ---- measuring ----
function primTriangles(p: Primitive): number {
 const n = p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0, mode = p.getMode();
 return mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
}
function sceneOf(doc: Document) {
 const root = doc.getRoot();
 return root.getDefaultScene() || root.listScenes()[0];
}
function drawnNodes(doc: Document): GltfNode[] {
 const out: GltfNode[] = [], scene = sceneOf(doc);
 scene?.traverse(n => {if (n.getMesh()) out.push(n);});
 return out;
}
export function triangles(doc: Document): number {
 return drawnNodes(doc).reduce((s, n) => s + n.getMesh()!.listPrimitives().reduce((t, p) => t + primTriangles(p), 0), 0);
}
export async function textureSizes(L: Libs, doc: Document) {
 return doc.getRoot().listTextures().map(t => {
  const size = t.getImage() ? L.core.ImageUtils.getSize(t.getImage()!, t.getMimeType()) : null;
  return {name: t.getName() || t.getURI() || 'texture', width: size?.[0] ?? 0, height: size?.[1] ?? 0, mimeType: t.getMimeType()};
 });
}
// The SDK's GPU estimate (PNG/JPEG 4 B/px, KTX2 1 B/px, x4/3 mips, plus vertex and index data).
export function gpuEstimate(doc: Document, textures: Array<{width: number; height: number; mimeType: string}>): number {
 let bytes = 0;
 for (const a of doc.getRoot().listAccessors()) bytes += a.getByteLength();
 for (const t of textures) bytes += Math.ceil(t.width * t.height * (t.mimeType === 'image/ktx2' ? 1 : 4) * 4 / 3);
 return bytes;
}
function extentOf(L: Libs, doc: Document): [number, number, number] {
 const scene = sceneOf(doc);
 if (!scene || !drawnNodes(doc).length) return [0, 0, 0];
 const b = L.fn.getBounds(scene);
 return [0, 1, 2].map(i => Math.max(0, b.max[i] - b.min[i])) as [number, number, number];
}
/** Units from the size of the model in file units: glTF says metres, but many exports are in centimetres or millimetres. */
export function guessUnits(extent: number[]): Units {
 const e = Math.max(...extent);
 return e > 5000 ? 'mm' : e > 50 ? 'cm' : 'm';
}

/** The user's own name for the author suggestion: git config user.name, else ''. */
export function userName(): string {
 try {
  return execFileSync('git', ['config', '--get', 'user.name'], {encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
   cwd: process.env.HOME || '/'}).trim().slice(0, 256);
 } catch {return '';}
}
export async function inspectImport(file: string): Promise<Inspection> {
 const L = await libs(), {doc, format, backend, bytes, sha256} = await load(L, file);
 const textures = await textureSizes(L, doc), warnings: string[] = [];
 const root = doc.getRoot(), tris = triangles(doc), extent = extentOf(L, doc), unitsGuess = guessUnits(extent);
 const maxTexture = Math.max(0, ...textures.map(t => Math.max(t.width, t.height)));
 if (root.listAnimations().length) warnings.push(`${root.listAnimations().length} animation(s) will be dropped (objects animate with traits.decorative)`);
 if (root.listSkins().length) warnings.push('skins will be dropped: characters use the character import (RFC-0010)');
 if (tris > IMPORT_DEFAULTS.maxTriangles) warnings.push(`${tris} triangles: it will be decimated to ${IMPORT_DEFAULTS.maxTriangles} unless you raise the target`);
 if (!tris) warnings.push('no triangles in the default scene');
 const name = nameFromFile(file);
 return {file, sourceName: basename(file), format, backend, bytes, sha256, name, id: importSlug(name), triangles: tris,
  nodes: root.listNodes().length, meshes: root.listMeshes().length, materials: root.listMaterials().length, textures, maxTexture,
  gpuBytes: gpuEstimate(doc, textures), extent: extent.map(round4) as [number, number, number], unitsGuess, scaleGuess: UNITS[unitsGuess],
  extentMetres: extent.map(v => round4(v * UNITS[unitsGuess])) as [number, number, number], up: 'y', animations: root.listAnimations().length,
  skins: root.listSkins().length, warnings, author: userName(),
  recommendations: {maxTriangles: IMPORT_DEFAULTS.maxTriangles, maxTexture: IMPORT_DEFAULTS.maxTexture,
   overTriangles: tris > IMPORT_DEFAULTS.maxTriangles, overTexture: maxTexture > IMPORT_DEFAULTS.maxTexture}};
}

// ---- geometry helpers ----
// 4x4 column-major matrices (glTF order).
function mat4(rotation: Mat3, scale: number, t: number[] = [0, 0, 0]): [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] {
 const r = rotation;
 return [r[0] * scale, r[1] * scale, r[2] * scale, 0, r[3] * scale, r[4] * scale, r[5] * scale, 0, r[6] * scale, r[7] * scale, r[8] * scale, 0, t[0], t[1], t[2], 1];
}
const mul3 = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].flatMap(c => [0, 1, 2].map(r => a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]));
// Z-up to Y-up: a turn of -90 degrees about X (+Z becomes +Y, +Y becomes -Z). Columns.
const Z_UP: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const yawMatrix = (deg: number): Mat3 => {const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c];};

/** Asset-space triangles of the drawn scene (node transforms applied) with each one's material index. */
export function sceneTriangles(L: Libs, doc: Document) {
 const tris: number[][][] = [], mats: number[] = [], uvs: Array<number[][] | null> = [], materials = doc.getRoot().listMaterials();
 for (const n of drawnNodes(doc)) {
  const m = n.getWorldMatrix();
  for (const p of n.getMesh()!.listPrimitives()) {
   if (p.getMode() !== 4) continue;
   const pos = p.getAttribute('POSITION');
   if (!pos) continue;
   const material = p.getMaterial(), set = material?.getBaseColorTextureInfo()?.getTexCoord() ?? 0;
   const uv = material?.getBaseColorTexture() ? p.getAttribute(`TEXCOORD_${set}`) : null;
   const idx = p.getIndices(), count = idx ? idx.getCount() : pos.getCount(), v = [0, 0, 0], w = [0, 0];
   const at = (i: number) => {pos.getElement(i, v); return [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);};
   const tc = (i: number) => {uv!.getElement(i, w); return [w[0], w[1]];};
   const mi = material ? materials.indexOf(material) : -1;
   for (let k = 0; k + 2 < count; k += 3) {
    const a = idx ? idx.getScalar(k) : k, b = idx ? idx.getScalar(k + 1) : k + 1, c = idx ? idx.getScalar(k + 2) : k + 2;
    tris.push([at(a), at(b), at(c)]); mats.push(mi); uvs.push(uv ? [tc(a), tc(b), tc(c)] : null);
   }
  }
 }
 return {tris, mats, uvs};
}

// ---- collision proxy ----
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function boxProxy(lo: V3, hi: V3): V3[][] {
 const p = (x: number, y: number, z: number): V3 => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
 const quads: V3[][] = [[p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)], [p(0, 0, 1), p(0, 1, 1), p(0, 1, 0), p(0, 0, 0)],
  [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)], [p(0, 0, 1), p(0, 0, 0), p(1, 0, 0), p(1, 0, 1)],
  [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], [p(1, 0, 0), p(0, 0, 0), p(0, 1, 0), p(1, 1, 0)]];
 return quads.flatMap(q => [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]);
}

/** The convex hull of points (incremental, outward counter-clockwise faces); null when they are flat. */
export function convexHull(points: V3[]): V3[][] | null {
 if (points.length < 4) return null;
 const lo = [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), hi = [0, 1, 2].map(i => Math.max(...points.map(p => p[i])));
 const eps = 1e-7 * Math.max(1e-6, ...hi.map((h, i) => h - lo[i])) * 10;
 // Initial tetrahedron: two far points, the farthest from their line, the farthest from that plane.
 let a = 0, b = 0;
 for (let i = 0; i < points.length; i++) {if (points[i][0] < points[a][0]) a = i; if (points[i][0] > points[b][0]) b = i;}
 if (a === b) for (let i = 0; i < points.length; i++) if (dot(sub(points[i], points[a]), sub(points[i], points[a])) > dot(sub(points[b], points[a]), sub(points[b], points[a]))) b = i;
 const ab = sub(points[b], points[a]);
 let c = -1, best = eps;
 for (let i = 0; i < points.length; i++) {const d = Math.hypot(...cross(ab, sub(points[i], points[a]))); if (d > best) {best = d; c = i;}}
 if (c < 0) return null;
 const n0 = cross(ab, sub(points[c], points[a]));
 let d = -1; best = eps;
 for (let i = 0; i < points.length; i++) {const h = Math.abs(dot(n0, sub(points[i], points[a]))) / Math.hypot(...n0); if (h > best) {best = h; d = i;}}
 if (d < 0) return null;
 type Face = {v: [number, number, number]; n: V3; o: number; alive: boolean};
 const faces: Face[] = [];
 const centre: V3 = [0, 1, 2].map(k => (points[a][k] + points[b][k] + points[c][k] + points[d][k]) / 4) as V3;
 const make = (i: number, j: number, k: number) => {
  let n = cross(sub(points[j], points[i]), sub(points[k], points[i]));
  if (dot(n, sub(centre, points[i])) > 0) {[j, k] = [k, j]; n = cross(sub(points[j], points[i]), sub(points[k], points[i]));}
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  faces.push({v: [i, j, k], n, o: dot(n, points[i]), alive: true});
 };
 make(a, b, c); make(a, b, d); make(a, c, d); make(b, c, d);
 for (let p = 0; p < points.length; p++) {
  if (p === a || p === b || p === c || p === d) continue;
  const visible = faces.filter(f => f.alive && dot(f.n, points[p]) - f.o > eps);
  if (!visible.length) continue;
  const edges = new Map<string, [number, number]>();
  for (const f of visible) for (let e = 0; e < 3; e++) {
   const u = f.v[e], w = f.v[(e + 1) % 3], back = `${w},${u}`;
   if (edges.has(back)) edges.delete(back); else edges.set(`${u},${w}`, [u, w]);
   f.alive = false;
  }
  for (const [u, w] of edges.values()) {
   let n = cross(sub(points[w], points[u]), sub(points[p], points[u]));
   const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
   faces.push({v: [u, w, p], n, o: dot(n, points[u]), alive: true});
  }
 }
 return faces.filter(f => f.alive).map(f => f.v.map(i => points[i]) as V3[]);
}

/** A proxy for these triangles: their convex hull of at most `budget` triangles (points merged on a grid), else the bounding box. */
export function collisionProxy(tris: number[][][], kind: 'convex' | 'box', budget = 1000): {triangles: V3[][]; kind: 'convex' | 'box'} {
 const pts = tris.flat() as V3[];
 const lo = [0, 1, 2].map(i => Math.min(...pts.map(p => p[i]))) as V3, hi = [0, 1, 2].map(i => Math.max(...pts.map(p => p[i]))) as V3;
 for (let k = 0; k < 3; k++) if (hi[k] - lo[k] < 0.01) {lo[k] -= 0.005; hi[k] += 0.005;}
 if (kind === 'convex') {
  const centre = lo.map((v, i) => (v + hi[i]) / 2) as V3;
  for (const cells of [24, 16, 12, 8, 6]) {
   // One point per grid cell: the one farthest from the centre, so the hull stays outside.
   const pick = new Map<string, V3>();
   for (const p of pts) {
    const key = [0, 1, 2].map(i => Math.min(cells - 1, Math.floor((p[i] - lo[i]) / Math.max(1e-9, hi[i] - lo[i]) * cells))).join(',');
    const q = pick.get(key);
    if (!q || dot(sub(p, centre), sub(p, centre)) > dot(sub(q, centre), sub(q, centre))) pick.set(key, p);
   }
   const hull = convexHull([...pick.values()]);
   if (!hull) break;
   if (hull.length <= budget) return {triangles: hull, kind: 'convex'};
  }
 }
 return {triangles: boxProxy(lo, hi), kind: 'box'};
}

// ---- thumbnail (CPU) ----
const srgbToLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c: number) => {c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;};

/** 256 x 256 RGBA PNG: flat-shaded, three-quarter front view from the left, 20 degrees up, transparent background. */
/** A decoded texture for the thumbnail: linear RGB at most 512 px, sampled nearest with wrapping. */
export interface ThumbTexture {width: number; height: number; rgb: Float32Array}
export async function renderThumbnail(tris: number[][][], colors: V3[], emissive: V3[], size = 256, ss = 3,
 uvs: Array<number[][] | null> = [], textures: Array<ThumbTexture | null> = []): Promise<Buffer> {
 const n = size * ss, rgb = new Float32Array(n * n * 3), alpha = new Float32Array(n * n), depth = new Float32Array(n * n).fill(-Infinity);
 if (tris.length) {
  const pts = tris.flat();
  const lo = [0, 1, 2].map(i => Math.min(...pts.map(p => p[i]))), hi = [0, 1, 2].map(i => Math.max(...pts.map(p => p[i])));
  const centre = lo.map((v, i) => (v + hi[i]) / 2);
  const yaw = -35 * Math.PI / 180, pitch = 20 * Math.PI / 180;
  const fwd: V3 = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)], eye: V3 = [-fwd[0], -fwd[1], -fwd[2]];
  let right = cross(fwd, [0, 1, 0]); const rl = Math.hypot(...right); right = [right[0] / rl, right[1] / rl, right[2] / rl];
  const up = cross(right, fwd);
  const proj = tris.map(t => t.map(p => {const v: V3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]; return [dot(v, right), dot(v, up), dot(v, eye)];}));
  const xs = proj.flat().map(p => p[0]), ys = proj.flat().map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const extent = Math.max(x1 - x0, y1 - y0, 1e-6) * 1.12;
  const key: V3 = [-0.4, 0.8, 0.45], fill: V3 = [0.6, 0.3, 0.7];
  const kl = Math.hypot(...key), fl = Math.hypot(...fill);
  proj.forEach((t, k) => {
   const w = tris[k];
   let nrm = cross(sub(w[1] as V3, w[0] as V3), sub(w[2] as V3, w[0] as V3)); const l = Math.hypot(...nrm); if (!l) return;
   nrm = [nrm[0] / l, nrm[1] / l, nrm[2] / l];
   const facing = dot(nrm, eye);
   // Imported meshes are often double-sided or wound inconsistently: light both sides.
   if (facing < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
   const shade = 0.22 + 0.7 * Math.max(0, dot(nrm, key) / kl) + 0.25 * Math.max(0, dot(nrm, fill) / fl) + 0.12 * Math.abs(facing);
   const col = colors[k].map((c, i) => c * shade + emissive[k][i]);
   const sx = t.map(p => (p[0] - (x0 + x1) / 2) / extent * n + n / 2), sy = t.map(p => n / 2 - (p[1] - (y0 + y1) / 2) / extent * n), sz = t.map(p => p[2]);
   const d = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2]);
   if (Math.abs(d) < 1e-12) return;
   const bx0 = Math.max(0, Math.floor(Math.min(...sx))), bx1 = Math.min(n - 1, Math.ceil(Math.max(...sx)));
   const by0 = Math.max(0, Math.floor(Math.min(...sy))), by1 = Math.min(n - 1, Math.ceil(Math.max(...sy)));
   for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const gx = x + 0.5, gy = y + 0.5;
    const a = ((sy[1] - sy[2]) * (gx - sx[2]) + (sx[2] - sx[1]) * (gy - sy[2])) / d;
    const b = ((sy[2] - sy[0]) * (gx - sx[2]) + (sx[0] - sx[2]) * (gy - sy[2])) / d, c = 1 - a - b;
    if (a < 0 || b < 0 || c < 0) continue;
    const z = a * sz[0] + b * sz[1] + c * sz[2], i = y * n + x;
    if (z <= depth[i]) continue;
    depth[i] = z; alpha[i] = 1;
    const tex = textures[k], uv = uvs[k];
    if (tex && uv) {
     const u = a * uv[0][0] + b * uv[1][0] + c * uv[2][0], v = a * uv[0][1] + b * uv[1][1] + c * uv[2][1];
     const tx = ((Math.floor(u * tex.width) % tex.width) + tex.width) % tex.width, ty = ((Math.floor(v * tex.height) % tex.height) + tex.height) % tex.height;
     const o = (ty * tex.width + tx) * 3;
     for (let q = 0; q < 3; q++) rgb[i * 3 + q] = tex.rgb[o + q] * colors[k][q] * shade + emissive[k][q];
    } else {rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];}
   }
  });
 }
 const out = Buffer.alloc(size * size * 4);
 for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
   const k = (y * ss + j) * n + x * ss + i;
   a += alpha[k]; r += linearToSrgb(rgb[k * 3]) * alpha[k]; g += linearToSrgb(rgb[k * 3 + 1]) * alpha[k]; b += linearToSrgb(rgb[k * 3 + 2]) * alpha[k];
  }
  const o = (y * size + x) * 4;
  out[o] = a ? Math.round(r / a * 255) : 0; out[o + 1] = a ? Math.round(g / a * 255) : 0; out[o + 2] = a ? Math.round(b / a * 255) : 0;
  out[o + 3] = Math.round(a / (ss * ss) * 255);
 }
 return Buffer.from(encodePng({width: size, height: size, data: new Uint8Array(out)}));
}

// ---- the import ----
/** Build the object (in memory): the GLB, object.json, import.json, the thumbnail and the measures. */
export async function buildImport(file: string, options: ImportOptions = {}, version = '0.0.0'): Promise<ImportBuild> {
 const say = options.progress || (() => {});
 const L = await libs(), steps: string[] = [], warnings: string[] = [];
 say('read');
 const {doc, format, backend, bytes, sha256} = await load(L, file);
 const root = doc.getRoot(), {fn, ext} = L;
 const before0 = await textureSizes(L, doc);
 const rawExtent = extentOf(L, doc);
 const before: Measure = {triangles: triangles(doc), maxTexture: Math.max(0, ...before0.map(t => Math.max(t.width, t.height))),
  gpuBytes: gpuEstimate(doc, before0), collisionTriangles: null, extent: rawExtent.map(round4) as V3};
 steps.push(backend === 'gltf' ? `read ${format.toUpperCase()}` : `converted ${format.toUpperCase()} with Assimp`);
 if (!before.triangles) throw errorWith('the model has no triangles in its default scene', 'import.empty');

 say('clean');
 const dropped: string[] = [];
 if (root.listAnimations().length) {dropped.push(`${root.listAnimations().length} animation(s)`); root.listAnimations().forEach(a => a.dispose());}
 if (root.listSkins().length) {dropped.push('skins'); root.listSkins().forEach(s => s.dispose());}
 if (root.listCameras().length) {dropped.push('cameras'); root.listCameras().forEach(c => c.dispose());}
 for (const e of root.listExtensionsUsed()) if (e.extensionName === 'KHR_lights_punctual') {dropped.push('lights'); e.dispose();}
 const scene = sceneOf(doc);
 for (const s of root.listScenes()) if (s !== scene) s.dispose();
 root.setDefaultScene(scene);
 for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  for (const name of p.listSemantics()) if (/^(JOINTS|WEIGHTS)_/.test(name)) p.setAttribute(name, null);
  if (p.listTargets().length) {p.listTargets().forEach(t => t.dispose()); if (!dropped.includes('morph targets')) dropped.push('morph targets');}
  if (p.getMode() === 5 || p.getMode() === 6) fn.convertPrimitiveToTriangles(p);
  else if (p.getMode() !== 4) {p.dispose(); if (!dropped.includes('points and lines')) dropped.push('points and lines');}
 }
 if (dropped.length) {steps.push('dropped ' + dropped.join(', ')); warnings.push(`dropped what objects don't use: ${dropped.join(', ')}`);}

 // Units, up axis, facing: bake every node's transform into its own mesh copy, then turn and scale.
 say('fit');
 const units = options.units && options.units !== 'auto' ? options.units : guessUnits(rawExtent);
 const scale = options.scale ?? UNITS[units];
 const up = options.up || 'y', yaw = options.yaw || 0, surface = options.surface || 'floor';
 await doc.transform(fn.flatten());
 const users = new Map<unknown, number>();
 for (const n of drawnNodes(doc)) users.set(n.getMesh(), (users.get(n.getMesh()) || 0) + 1);
 for (const n of drawnNodes(doc)) {
  if ((users.get(n.getMesh()) || 0) > 1) n.setMesh(n.getMesh()!.clone());
  fn.clearNodeTransform(n);
 }
 const rotation = mul3(yawMatrix(yaw), up === 'z' ? Z_UP : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
 for (const mesh of root.listMeshes()) fn.transformMesh(mesh, mat4(rotation, scale));
 // Pivot: base centre (floor), back centre (wall), top centre (ceiling), bounds centre (any).
 const b = fn.getBounds(scene), c = [0, 1, 2].map(i => (b.min[i] + b.max[i]) / 2);
 const pivot = surface === 'floor' ? [c[0], b.min[1], c[2]] : surface === 'wall' ? [c[0], c[1], b.min[2]] : surface === 'ceiling' ? [c[0], b.max[1], c[2]] : c;
 for (const mesh of root.listMeshes()) fn.transformMesh(mesh, mat4([1, 0, 0, 0, 1, 0, 0, 0, 1], 1, pivot.map(v => -v)));
 steps.push(`units ${units} (x${scale}), ${up === 'z' ? 'Z-up turned to Y-up' : 'Y up'}${yaw ? `, turned ${yaw} degrees` : ''}, pivot at the ${surface === 'floor' ? 'base' : surface === 'wall' ? 'back' : surface === 'ceiling' ? 'top' : 'centre'}`);
 await doc.transform(fn.join({keepNamed: false}), fn.weld(), fn.prune({keepLeaves: false}));

 // Decimate to the target: meshoptimizer, error first at 1 % of the size, then up to 5 %.
 const target = Math.max(100, Math.round(options.maxTriangles ?? IMPORT_DEFAULTS.maxTriangles));
 let tris = triangles(doc);
 if (tris > target) {
  say('simplify', `${tris} -> ${target} triangles`);
  const start = tris;
  for (const error of [0.01, 0.02, 0.05]) {
   if (tris <= target) break;
   await doc.transform(fn.simplify({simplifier: L.mo.MeshoptSimplifier, ratio: Math.min(1, target / tris), error, lockBorder: false}));
   tris = triangles(doc);
  }
  steps.push(`decimated ${start} -> ${tris} triangles`);
  if (tris > target) warnings.push(`kept ${tris} triangles, above the ${target} target (more would change its shape)`);
 }

 // Textures: shrink to the target side; KTX2 (Basis) for colour textures over 1024 px (auto) or all.
 say('textures');
 const maxSide = options.maxTexture ?? IMPORT_DEFAULTS.maxTexture;
 let resized = 0;
 for (const t of root.listTextures()) {
  const image = t.getImage(), mime = t.getMimeType();
  if (!image || mime === 'image/ktx2') continue;
  const size = L.core.ImageUtils.getSize(image, mime);
  if (!size || Math.max(...size) <= maxSide) continue;
  // glTF-Transform's texture resize (Lanczos 3) through the pure-JavaScript pixels.
  try {await fn.compressTexture(t, {resize: [maxSide, maxSide], resizeFilter: fn.TextureResizeFilter.LANCZOS3}); resized++;}
  catch (e: any) {warnings.push(`kept ${t.getName() || t.getURI() || 'a texture'} at ${Math.max(...size)} px (${String(e.message).split('\n')[0]})`);}
 }
 if (resized) steps.push(`shrank ${resized} texture(s) to ${maxSide} px`);
 if (options.lighting === 'unlit') {
  const unlit = doc.createExtension(ext.KHRMaterialsUnlit);
  for (const m of root.listMaterials()) m.setExtension('KHR_materials_unlit', unlit.createUnlit());
  steps.push('unlit materials (lighting baked into the textures)');
 }

 // Collision proxy and thumbnail from the final shape (before quantisation).
 say('collision');
 const {tris: shape, mats, uvs} = sceneTriangles(L, doc);
 const collision = options.collision || 'convex';
 const proxy = collision === 'none' ? null : collisionProxy(shape, collision);
 if (proxy) steps.push(`${proxy.kind === 'convex' ? 'convex hull' : 'box'} collision proxy, ${proxy.triangles.length} triangles${collision === 'convex' && proxy.kind === 'box' ? ' (the hull was too detailed or flat)' : ''}`);
 say('thumbnail');
 const materials = root.listMaterials(), colour: V3[] = [], glow: V3[] = [], textures: Array<ThumbTexture | null> = [];
 for (const m of materials) {
  const f = m.getBaseColorFactor(), e = m.getEmissiveFactor();
  let texture: ThumbTexture | null = null;
  const tex = m.getBaseColorTexture();
  if (tex?.getImage() && tex.getMimeType() !== 'image/ktx2') {
   try {
    const small = fitInside(decodeImage(tex.getImage()!, tex.getMimeType()), 512), lin = new Float32Array(small.width * small.height * 3);
    for (let i = 0, j = 0; i < lin.length; i += 3, j += 4) for (let c = 0; c < 3; c++) lin[i + c] = srgbToLinear(small.data[j + c] / 255);
    texture = {width: small.width, height: small.height, rgb: lin};
   } catch {/* the factor alone */}
  }
  textures.push(texture); colour.push([f[0], f[1], f[2]]); glow.push([e[0], e[1], e[2]]);
 }
 const thumbnail = await renderThumbnail(shape, mats.map(i => i >= 0 ? colour[i] : [0.7, 0.7, 0.7] as V3), mats.map(i => i >= 0 ? glow[i] : [0, 0, 0] as V3),
  256, 3, uvs, mats.map(i => i >= 0 ? textures[i] : null));

 const ktx2Mode = options.ktx2 || 'auto';
 if (ktx2Mode !== 'off') {
  say('ktx2');
  const {encodeToKTX2} = await import('ktx2-encoder');
  const imageDecoder = async (buffer: Uint8Array) => decodeImage(buffer);
  const started = Date.now();
  let encoded = 0, skipped = 0;
  for (const t of root.listTextures()) {
   const image = t.getImage(), mime = t.getMimeType();
   if (!image || mime === 'image/ktx2') continue;
   const size = L.core.ImageUtils.getSize(image, mime) || [0, 0];
   if (ktx2Mode === 'auto' && Math.max(...size) < 1024) continue; // auto: 1024 px and larger
   if ((Date.now() - started) / 1000 > IMPORT_LIMITS.ktx2Seconds) {skipped++; continue;}
   const slots = fn.listTextureSlots(t), colourSpace = fn.getTextureColorSpace(t) === 'srgb', normal = slots.includes('normalTexture');
   try {
    const data = await offStdout(() => encodeToKTX2(image, {enableDebug: false, isUASTC: !colourSpace, isNormalMap: normal, generateMipmap: true, needSupercompression: !colourSpace,
     qualityLevel: 128, isSetKTX2SRGBTransferFunc: colourSpace, isKTX2File: true, imageDecoder} as any));
    t.setImage(data).setMimeType('image/ktx2');
    if (t.getURI()) t.setURI(t.getURI().replace(/\.[a-z0-9]+$/i, '.ktx2'));
    encoded++;
   } catch (e: any) {skipped++; warnings.push(`KTX2 failed for ${t.getName() || t.getURI() || 'a texture'}: ${String(e.message).split('\n')[0]}`);}
  }
  if (encoded) {doc.createExtension(ext.KHRTextureBasisu).setRequired(true); steps.push(`KTX2 (Basis Universal): ${encoded} texture(s)`);}
  if (skipped) warnings.push(`${skipped} texture(s) stay PNG/JPEG (KTX2 time budget or encoder error)`);
 }

 // Geometry: meshopt + 16-bit quantisation (world format 0.7 rules), then the proxy outside the scene.
 say('compress');
 await doc.transform(fn.reorder({encoder: L.mo.MeshoptEncoder, target: 'size'}), fn.quantize());
 doc.createExtension(ext.EXTMeshoptCompression).setRequired(true).setEncoderOptions({method: ext.EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 steps.push('meshopt compression, quantised geometry');
 if (proxy) {
  const flat = proxy.triangles.flat().flat();
  const accessor = doc.createAccessor('proxy-position').setType('VEC3').setArray(new Float32Array(flat)).setBuffer(root.listBuffers()[0] || doc.createBuffer());
  const mesh = doc.createMesh('proxy').addPrimitive(doc.createPrimitive().setAttribute('POSITION', accessor));
  doc.createNode('proxy').setMesh(mesh); // in the document, outside the scene: never drawn
 }
 await doc.transform(fn.unpartition()); // one buffer: a GLB
 for (const t of root.listTextures()) if (!t.getURI()) t.setURI(t.getName() || 'texture');
 for (const buf of root.listBuffers()) buf.setURI('');

 const bounds = fn.getBounds(scene);
 const afterTextures = await textureSizes(L, doc);
 const after = {triangles: triangles(doc), maxTexture: Math.max(0, ...afterTextures.map(t => Math.max(t.width, t.height))),
  gpuBytes: gpuEstimate(doc, afterTextures), collisionTriangles: proxy ? proxy.triangles.length : null,
  extent: [0, 1, 2].map(i => round4(bounds.max[i] - bounds.min[i])) as V3};
 const glb = await L.io.writeBinary(doc);

 const name = (options.name || nameFromFile(file)).slice(0, 64), id = options.id || importSlug(name);
 const license = options.license?.trim() || 'LicenseRef-unknown', author = options.author?.trim() || 'unknown', source = options.source?.trim() || 'unknown';
 const category = options.category && (CATEGORIES as readonly string[]).includes(options.category) ? options.category : 'other';
 const tags = [...new Set(['imported', ...(options.tags || []).map(importSlug)])].slice(0, 8);
 const manifest: Record<string, unknown> = {
  formatVersion: '0.11', id, version: '1.0.0', name, ...(options.description ? {description: options.description.slice(0, 512)} : {}),
  category, tags, scene: 'object.glb', license,
  attribution: [{path: '.', author: author.slice(0, 256), license, ...(/^https:\/\//.test(source) ? {source: source.slice(0, 2048)} : {})}],
  bounds: {min: bounds.min.map(round4), max: bounds.max.map(round4)}, thumbnail: 'thumbnail.png',
  lighting: {mode: options.lighting === 'unlit' ? 'unlit' : 'probe'},
  traits: {...(proxy ? {collidable: {node: 'proxy'}} : {}),
   movable: {surfaces: [surface], ...(surface === 'floor' || surface === 'ceiling' ? {upright: true} : {}), scale: [0.25, 4]}},
 };
 const record = {
  importVersion: '0.1', source: {name: basename(file).slice(0, 256), format, bytes, sha256},
  converter: {name: 'hyprune object import', version, backend},
  options: {units: options.scale !== undefined ? 'custom' : units, scale, up, yaw, surface, maxTriangles: target, maxTexture: maxSide, collision, ktx2: ktx2Mode,
   lighting: options.lighting === 'unlit' ? 'unlit' : 'lit'},
  measured: {before, after}, steps: steps.map(s => s.slice(0, 256)).slice(0, 32),
  license: {spdx: license.slice(0, 512), author: author.slice(0, 256), source: source.slice(0, 1024)},
  importedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
 };
 return {manifest, record, glb, thumbnail, before, after, steps, warnings};
}

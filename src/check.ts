// The builder's checklist (RFC-0014 "Checklist" and "Approach checks", as amended for world
// folders): the spawn on a floor, each workspace screen's approach (upright, standback on a
// floor, a clear box in front, visible from the standback, at a usable height, reachable), a
// basic walkability check over the folder's collision (a layered height grid flooded from the
// spawn with the RFC-0004 capsule), the per-world budgets, recorded licences and the
// official-publishing check. It reads the folder only; Make world uses its standbacks, Release
// reports it, and the Director, the CLI and the MCP server all show the same items.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BASE,PROJECT,pending,readProject,type Placement,type Project} from './builder.js';

type V3 = [number, number, number];
type Tri = [V3, V3, V3];

/** The capsule and floor rules of RFC-0004 (the made world's navigation uses the same). */
export const WALK = Object.freeze({radius: 0.3, height: 1.8, climb: 0.35, slope: 0.65, margin: 4, maxCells: 3_000_000, cell: 0.15});
/** The per-world totals core refuses placements over (IPC 0.27; a world folder holds up to 512 placements of 256 assets). */
export const TOTALS = Object.freeze({placements: 512, assets: 256, triangles: 2_000_000, gpuBytes: 512 * 1048576, collisionTriangles: 100_000});
/** The per-object recommendations (object format 0.11): over them is a warning, never a refusal. */
export const RECOMMENDED = Object.freeze({triangles: 50_000, maxTexture: 2048});
/** Bumped when the checks change, so cached results of an older SDK are recomputed. */
const CHECK_VERSION = 'check-2';
const WORKSPACE_BASE = 20, OFFICIAL = new Set(['CC0-1.0', 'CC-BY-4.0']);

export type CheckLevel = 'done' | 'open' | 'warning';
export interface CheckItem {
 /** A stable id from RFC-0014's list (screen items repeat with `target`, the placement). */
 id: string; label: string; done: boolean; blocks: boolean; level: CheckLevel; message: string;
 hint?: string; target?: string; key?: string; show?: {position: number[]};
}
export interface Home {
 placement: string; key?: string; slot: string; workspace: number; anchor: {centre: V3; rotation: number[]; size: [number, number]};
 /** The standback point on its floor (null when there is no floor there) and the heading facing the screen. */
 standback: V3 | null; yaw: number; reachable: boolean;
}
export interface Part {path: string; what: string; license: string; author: string; source: string; official: boolean; missing: string[]}
export interface CheckResult {
 digest: string; checkedAt: string; folder: string;
 /** No blocking item is open: the world can be released. */
 ready: boolean; items: CheckItem[]; homes: Home[];
 walk: {cell: number; cells: number; islands: number; mainArea: number; reachesOutside: boolean; ms: number};
 totals: {placements: number; assets: number; triangles: number; gpuBytes: number; collisionTriangles: number};
 publishing: {officialEligible: boolean; parts: Part[]};
}

// ---- small vector maths ----
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l];};
export function rotate(q: number[], v: number[]): V3 {
 const [x, y, z, w] = q, [vx, vy, vz] = v;
 const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
 return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
export const qmul = (a: number[], b: number[]): number[] => [
 a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
 a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const r3 = (v: number) => Math.round(v * 1e3) / 1e3 + 0;
const qn = (q: number[]) => {const l = Math.hypot(...q) || 1; return q.map(v => v / l);};

interface Box {min: V3; max: V3}
const boxOf = (tris: Tri[]): Box => {
 const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
 for (const t of tris) for (const p of t) for (let i = 0; i < 3; i++) {if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i];}
 return {min, max};
};
const merge = (a: Box, b: Box): Box => ({min: [0, 1, 2].map(i => Math.min(a.min[i], b.min[i])) as V3, max: [0, 1, 2].map(i => Math.max(a.max[i], b.max[i])) as V3});

/** Ray from o along d (not normalised) against a triangle: the parameter t in (0, 1] or -1. */
function rayTri(o: V3, d: V3, t: Tri): number {
 const e1 = sub(t[1], t[0]), e2 = sub(t[2], t[0]), p = cross(d, e2), det = dot(e1, p);
 if (Math.abs(det) < 1e-12) return -1;
 const inv = 1 / det, s = sub(o, t[0]), u = dot(s, p) * inv;
 if (u < 0 || u > 1) return -1;
 const q = cross(s, e1), v = dot(d, q) * inv;
 if (v < 0 || u + v > 1) return -1;
 const k = dot(e2, q) * inv;
 return k > 1e-6 && k <= 1 ? k : -1;
}
function rayBox(o: V3, d: V3, b: Box): boolean {
 let lo = 0, hi = 1;
 for (let i = 0; i < 3; i++) {
  if (Math.abs(d[i]) < 1e-12) {if (o[i] < b.min[i] || o[i] > b.max[i]) return false; continue;}
  let a = (b.min[i] - o[i]) / d[i], c = (b.max[i] - o[i]) / d[i];
  if (a > c) [a, c] = [c, a];
  lo = Math.max(lo, a); hi = Math.min(hi, c);
  if (lo > hi) return false;
 }
 return true;
}

/** An oriented box: centre, three unit axes, half extents. */
interface Obb {c: V3; u: [V3, V3, V3]; e: V3}
const obbBox = (o: Obb): Box => {
 const r = [0, 1, 2].map(i => Math.abs(o.u[0][i]) * o.e[0] + Math.abs(o.u[1][i]) * o.e[1] + Math.abs(o.u[2][i]) * o.e[2]);
 return {min: [o.c[0] - r[0], o.c[1] - r[1], o.c[2] - r[2]], max: [o.c[0] + r[0], o.c[1] + r[1], o.c[2] + r[2]]};
};
const overlaps = (a: Box, b: Box) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
/** Triangle against an oriented box (separating axes: the box's three, the triangle's normal, the nine crosses). */
function triObb(t: Tri, o: Obb): boolean {
 const v = t.map(p => {const d = sub(p, o.c); return [dot(d, o.u[0]), dot(d, o.u[1]), dot(d, o.u[2])] as V3;});
 const e = o.e, f = [sub(v[1], v[0]), sub(v[2], v[1]), sub(v[0], v[2])];
 const sep = (a: V3) => {
  const p = v.map(x => dot(x, a)), r = e[0] * Math.abs(a[0]) + e[1] * Math.abs(a[1]) + e[2] * Math.abs(a[2]);
  return Math.min(...p) > r || Math.max(...p) < -r;
 };
 for (let i = 0; i < 3; i++) if (Math.min(v[0][i], v[1][i], v[2][i]) > e[i] || Math.max(v[0][i], v[1][i], v[2][i]) < -e[i]) return false;
 if (sep(cross(f[0], f[1]))) return false;
 const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
 for (const a of axes) for (const g of f) {const c = cross(a, g); if (Math.hypot(...c) > 1e-12 && sep(c)) return false;}
 return true;
}
function obbTris(o: Obb): Tri[] {
 const corner = (sx: number, sy: number, sz: number): V3 => add(add(add(o.c, mul(o.u[0], sx * o.e[0])), mul(o.u[1], sy * o.e[1])), mul(o.u[2], sz * o.e[2]));
 const c = [0, 1, 2, 3, 4, 5, 6, 7].map(i => corner(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1));
 const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
 return quads.flatMap(([a, b, d, e]) => [[c[a], c[b], c[d]], [c[a], c[d], c[e]]] as Tri[]);
}

// ---- reading the folder ----
interface Asset {object: any; render: Tri[]; proxy: Tri[]; triangles: number; gpuBytes: number; maxTexture: number; error?: string}
interface Piece {
 placement: Placement; id: string; key?: string; name: string; asset: string; object: any;
 render: Tri[]; proxy: Tri[]; renderBox: Box | null; proxyBox: Box | null;
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const nodeByName = (root: any, ref: unknown) => typeof ref === 'number' ? root.listNodes()[ref] : root.listNodes().find((n: any) => n.getName() === ref);
function nodeTris(node: any): Tri[] {
 const out: Tri[] = [], mesh = node?.getMesh();
 if (!mesh) return out;
 const m = node.getWorldMatrix(), v = [0, 0, 0];
 for (const p of mesh.listPrimitives()) {
  if (p.getMode() !== 4) continue;
  const pos = p.getAttribute('POSITION'), idx = p.getIndices();
  if (!pos) continue;
  const at = (i: number): V3 => {pos.getElement(i, v); return [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]) as V3;};
  const n = idx ? idx.getCount() : pos.getCount();
  for (let k = 0; k + 2 < n; k += 3) out.push([at(idx ? idx.getScalar(k) : k), at(idx ? idx.getScalar(k + 1) : k + 1), at(idx ? idx.getScalar(k + 2) : k + 2)]);
 }
 return out;
}
async function loadAsset(dir: string): Promise<Asset> {
 const {libs, sceneTriangles, gpuEstimate, textureSizes, triangles} = await import('./import.js');
 let object: any = null;
 try {
  object = readJson(join(dir, 'object.json'));
  const L = await libs(), doc = await L.io.read(join(dir, object.scene ?? 'object.glb'));
  const render = sceneTriangles(L, doc).tris as unknown as Tri[];
  const proxyRef = object.traits?.collidable?.node;
  const proxy = proxyRef === undefined ? [] : nodeTris(nodeByName(doc.getRoot(), proxyRef));
  const sizes = await textureSizes(L, doc);
  return {object, render, proxy, triangles: triangles(doc), gpuBytes: gpuEstimate(doc, sizes), maxTexture: Math.max(0, ...sizes.map(s => Math.max(s.width, s.height)))};
 } catch (e: any) {
  return {object, render: [], proxy: [], triangles: 0, gpuBytes: 0, maxTexture: 0, error: String(e?.message ?? e).split('\n')[0]};
 }
}
const place = (p: Placement, tris: Tri[]): Tri[] => {
 const q = p.pose.rotation, t = p.pose.position as V3, s = p.scale ?? 1;
 return tris.map(tri => tri.map(v => add(rotate(q, mul(v, s)), t)) as Tri);
};
async function landTris(folder: string, base: any): Promise<Tri[]> {
 const {libs} = await import('./import.js');
 const L = await libs(), out: Tri[] = [];
 for (const c of base.collision ?? []) {
  try {
   const doc = await L.io.read(join(folder, base.scene));
   out.push(...nodeTris(doc.getRoot().listNodes()[c.node]));
  } catch {/* reported as no floor under the spawn */}
 }
 return out;
}

/** A stable digest of what the checklist depends on: the project, the base and every placed object's files. */
export function checkDigest(folder: string): string {
 const h = createHash('sha256').update(CHECK_VERSION);
 for (const f of [PROJECT, BASE]) h.update(existsSync(join(folder, f)) ? readFileSync(join(folder, f)) : '');
 const objects = join(folder, 'objects'), materials = join(folder, 'materials');
 if (existsSync(materials)) for (const key of readdirSync(materials).sort()) {
  const p = join(materials, key, 'material.json');
  if (existsSync(p)) h.update(readFileSync(p));
 }
 if (existsSync(objects)) for (const id of readdirSync(objects).sort()) for (const f of ['object.json', 'object.glb']) {
  const p = join(objects, id, f);
  if (existsSync(p)) {const s = statSync(p); h.update(`${id}/${f}:${s.size}:${s.mtimeMs}`);}
 }
 return 'sha256:' + h.digest('hex');
}

// ---- the walk grid ----
const MAX_HITS = 12, MAX_LAYERS = 4;
interface Grid {
 x0: number; z0: number; cell: number; nx: number; nz: number;
 hits: Float32Array; kind: Int8Array; count: Uint8Array;
 floors: Float32Array; layers: Uint8Array; ok: Uint8Array; parent: Int32Array; outside: number;
}
/** Kind of a surface crossed by a vertical line: 2 a walkable floor, 1 another upward face, -1 a downward face. */
function buildGrid(tris: Tri[], box: Box, cellWanted: number): Grid {
 const w = box.max[0] - box.min[0], d = box.max[2] - box.min[2];
 const cell = Math.max(cellWanted, Math.sqrt(w * d / WALK.maxCells));
 const nx = Math.max(1, Math.ceil(w / cell)), nz = Math.max(1, Math.ceil(d / cell)), n = nx * nz;
 const g: Grid = {x0: box.min[0], z0: box.min[2], cell, nx, nz, hits: new Float32Array(n * MAX_HITS), kind: new Int8Array(n * MAX_HITS), count: new Uint8Array(n),
  floors: new Float32Array(n * MAX_LAYERS), layers: new Uint8Array(n), ok: new Uint8Array(n * MAX_LAYERS), parent: new Int32Array(n * MAX_LAYERS + 1), outside: n * MAX_LAYERS};
 for (const t of tris) {
  const nrm = cross(sub(t[1], t[0]), sub(t[2], t[0])), len = Math.hypot(...nrm);
  if (len < 1e-12) continue;
  const ny = nrm[1] / len;
  if (Math.abs(ny) < 1e-3) continue; // vertical: a vertical line never crosses it
  const kind = ny >= WALK.slope ? 2 : ny > 0 ? 1 : -1;
  const ix0 = Math.max(0, Math.floor((Math.min(t[0][0], t[1][0], t[2][0]) - g.x0) / cell - 0.5)), ix1 = Math.min(nx - 1, Math.ceil((Math.max(t[0][0], t[1][0], t[2][0]) - g.x0) / cell - 0.5));
  const iz0 = Math.max(0, Math.floor((Math.min(t[0][2], t[1][2], t[2][2]) - g.z0) / cell - 0.5)), iz1 = Math.min(nz - 1, Math.ceil((Math.max(t[0][2], t[1][2], t[2][2]) - g.z0) / cell - 0.5));
  // Barycentric in x-z: the line at (x, z) crosses the triangle at y.
  const ax = t[0][0], az = t[0][2], bx = t[1][0] - ax, bz = t[1][2] - az, cx = t[2][0] - ax, cz = t[2][2] - az, den = bx * cz - bz * cx;
  if (Math.abs(den) < 1e-12) continue;
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
   const px = g.x0 + (ix + 0.5) * cell - ax, pz = g.z0 + (iz + 0.5) * cell - az;
   const u = (px * cz - pz * cx) / den, v = (bx * pz - bz * px) / den;
   if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
   const c = iz * nx + ix, k = g.count[c];
   if (k >= MAX_HITS) continue;
   g.hits[c * MAX_HITS + k] = t[0][1] + u * (t[1][1] - t[0][1]) + v * (t[2][1] - t[0][1]);
   g.kind[c * MAX_HITS + k] = kind; g.count[c] = k + 1;
  }
 }
 // Floors per cell: walkable faces, merged within 5 cm, highest kept up to MAX_LAYERS.
 for (let c = 0; c < n; c++) {
  const ys: number[] = [];
  for (let k = 0; k < g.count[c]; k++) if (g.kind[c * MAX_HITS + k] === 2) ys.push(g.hits[c * MAX_HITS + k]);
  ys.sort((a, b) => b - a);
  let m = 0;
  for (const y of ys) {
   if (m && Math.abs(g.floors[c * MAX_LAYERS + m - 1] - y) < 0.05) continue;
   if (m >= MAX_LAYERS) break;
   g.floors[c * MAX_LAYERS + m++] = y;
  }
  g.layers[c] = m;
 }
 return g;
}
/** Is the vertical span (lo, hi) at cell c free: not inside a solid at lo and crossing no surface? */
function clear(g: Grid, c: number, lo: number, hi: number): boolean {
 let first = Infinity, kind = 0;
 for (let k = 0; k < g.count[c]; k++) {
  const y = g.hits[c * MAX_HITS + k];
  if (y > lo && y < first) {first = y; kind = g.kind[c * MAX_HITS + k];}
 }
 if (first === Infinity) return true;
 return kind < 0 && first >= hi; // the first face above is a ceiling (entered from below) beyond the span
}
function walk(g: Grid): void {
 const {nx, nz, cell} = g, r = Math.max(1, Math.round(WALK.radius / cell)), ring: number[][] = [];
 for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if ((dx || dz) && dx * dx + dz * dz <= r * r + r) ring.push([dx, dz]);
 for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
  const c = iz * nx + ix;
  for (let l = 0; l < g.layers[c]; l++) {
   const h = g.floors[c * MAX_LAYERS + l];
   let ok = clear(g, c, h + 0.05, h + WALK.height);
   for (const [dx, dz] of ring) {
    if (!ok) break;
    const x = ix + dx, z = iz + dz;
    if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
    ok = clear(g, z * nx + x, h + WALK.climb + 0.05, h + WALK.height);
   }
   g.ok[c * MAX_LAYERS + l] = ok ? 1 : 0;
  }
 }
 const parent = g.parent;
 for (let i = 0; i < parent.length; i++) parent[i] = i;
 const find = (a: number): number => {while (parent[a] !== a) {parent[a] = parent[parent[a]]; a = parent[a];} return a;};
 const join2 = (a: number, b: number) => {a = find(a); b = find(b); if (a !== b) parent[a] = b;};
 for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
  const c = iz * nx + ix;
  for (let l = 0; l < g.layers[c]; l++) {
   if (!g.ok[c * MAX_LAYERS + l]) continue;
   const h = g.floors[c * MAX_LAYERS + l], node = c * MAX_LAYERS + l;
   if (ix === 0 || iz === 0 || ix === nx - 1 || iz === nz - 1) join2(node, g.outside);
   for (const [x, z] of [[ix + 1, iz], [ix, iz + 1]]) {
    if (x >= nx || z >= nz) continue;
    const o = z * nx + x;
    let best = -1, gap = Infinity;
    for (let m = 0; m < g.layers[o]; m++) {
     const dh = Math.abs(g.floors[o * MAX_LAYERS + m] - h);
     if (g.ok[o * MAX_LAYERS + m] && dh <= WALK.climb && dh < gap) {gap = dh; best = m;}
    }
    if (best >= 0) join2(node, o * MAX_LAYERS + best);
   }
  }
 }
 for (let i = 0; i < parent.length; i++) parent[i] = find(i);
}
/** The floor node under a point: the highest walkable floor within `below` metres under y (and `above` over it). */
function floorAt(g: Grid, p: number[], below: number, above: number): {node: number; y: number; ok: boolean} | null {
 const ix = Math.floor((p[0] - g.x0) / g.cell), iz = Math.floor((p[2] - g.z0) / g.cell);
 if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return null;
 const c = iz * g.nx + ix;
 for (let l = 0; l < g.layers[c]; l++) {
  const y = g.floors[c * MAX_LAYERS + l];
  if (y <= p[1] + above && y >= p[1] - below) return {node: c * MAX_LAYERS + l, y, ok: !!g.ok[c * MAX_LAYERS + l]};
 }
 return null;
}

// ---- provenance ----
const known = (s: unknown) => typeof s === 'string' && s.trim() !== '' && s.trim().toLowerCase() !== 'unknown';
function officialLicense(spdx: string): boolean {
 const ids = spdx.replace(/[()]/g, ' ').split(/\s+(?:AND|OR)\s+|\s+/).filter(Boolean);
 return ids.length > 0 && ids.every(id => OFFICIAL.has(id));
}
function part(path: string, what: string, license: string, author: string, source: string): Part {
 const missing: string[] = [];
 if (!known(license) || license.startsWith('LicenseRef-unknown')) missing.push('license');
 if (!known(author)) missing.push('author');
 if (!known(source)) missing.push('source');
 return {path, what, license: license || 'LicenseRef-unknown', author: author || 'unknown', source: source || 'unknown', official: !missing.length && officialLicense(license), missing};
}
function provenanceParts(folder: string, project: Project, objects: Map<string, any>): Part[] {
 const parts: Part[] = [];
 const s = project.sky;
 if (s.image) parts.push(part(s.image, 'sky', s.license, s.author, s.source));
 const f = project.floor;
 if (f?.image) parts.push(part(f.image, 'floor', f.license, f.author, f.source));
 const mdir = join(folder, 'materials');
 if (existsSync(mdir)) for (const key of readdirSync(mdir).sort()) {
  const path = join(mdir, key, 'material.json');
  if (!existsSync(path)) continue;
  try {const r = readJson(path); if (r.texture) parts.push(part(`materials/${key}`, `material ${r.name ?? key}`, r.license, r.author, r.source));} catch {/* make reports it */}
 }
 for (const [id, o] of objects) {
  if (!o) continue;
  const a = (o.attribution ?? []).find((x: any) => x.path === '.') ?? {};
  let source = a.source ?? '';
  try {const imp = readJson(join(folder, 'objects', id, 'import.json')); source ||= imp.license?.source ?? '';} catch {/* not an import */}
  const generated = existsSync(join(folder, 'objects', id, 'primitive.json'));
  // Primitives are generated (CC0); a textured one carries its material's provenance, listed above.
  if (generated) continue;
  parts.push(part(`objects/${id}`, `object ${o.name ?? id}`, o.license ?? 'LicenseRef-unknown', a.author ?? 'unknown', source));
 }
 return parts;
}

// ---- the check ----
const label = (p: Piece) => p.key ? `${p.name} (${p.key})` : p.name;
function screenAnchor(object: any): any {
 return object?.traits?.mount?.anchors?.find((a: any) => a.role === 'mounted-workspace' && a.size && a.pose) ?? null;
}

/** Runs every checklist item on a world folder. Cached in builder/cache/check.json by the folder's digest. */
export async function checkProject(folder: string, o: {cache?: boolean; cell?: number} = {}): Promise<CheckResult> {
 const digest = checkDigest(folder), cachePath = join(folder, 'builder/cache/check.json');
 const saved = pending(folder);
 if (o.cache !== false && existsSync(cachePath)) {
  try {
   const c = readJson(cachePath) as CheckResult;
   if (c.digest === digest) return withSave(c, saved.total);
  } catch {/* recompute */}
 }
 const started = Date.now();
 const project = readProject(folder), base = readJson(join(folder, BASE));
 const items: CheckItem[] = [];
 const assets = new Map<string, Asset>();
 for (const id of new Set(project.placements.map(p => p.ref.slice('world/'.length)))) assets.set(id, await loadAsset(join(folder, 'objects', id)));
 const pieces: Piece[] = project.placements.map(p => {
  const id = p.ref.slice('world/'.length), a = assets.get(id)!;
  const render = place(p, a.render), proxy = place(p, a.proxy);
  return {placement: p, id: p.id, key: p.key, name: String(a.object?.name ?? id), asset: id, object: a.object, render, proxy,
   renderBox: render.length ? boxOf(render) : null, proxyBox: proxy.length ? boxOf(proxy) : null};
 });
 for (const [id, a] of assets) if (a.error) items.push({id: 'objects.readable', label: 'Objects load', done: false, blocks: true, level: 'open',
  message: `objects/${id} can't be read (${a.error})`, hint: 'Remove the placements of this object, or repair it from the Objects tab'});
 const land = await landTris(folder, base);
 const collision = [...land, ...pieces.flatMap(p => p.proxy)];

 // The spawn and the screens decide the region the grid covers.
 const spawnRec = base.spawns?.find((s: any) => s.id === base.defaultSpawn) ?? base.spawns?.[0];
 const spawn: V3 = spawnRec ? spawnRec.pose.position : [0, 0, 0];
 interface Screen {piece: Piece; slot: string; workspace: number; centre: V3; rotation: number[]; size: [number, number]; f: [number, number]; d: number; standXZ: V3}
 const screens: Screen[] = [], slots = new Set<string>();
 for (const p of pieces) {
  const ws = p.placement.workspace;
  if (ws === undefined) continue;
  const a = screenAnchor(p.object);
  if (!a || ws - WORKSPACE_BASE < 1) continue;
  const slot = String(ws - WORKSPACE_BASE).padStart(2, '0');
  if (slots.has(slot)) continue;
  slots.add(slot);
  const s = p.placement.scale ?? 1, q = p.placement.pose.rotation, rotation = qn(qmul(q, a.pose.rotation));
  const centre = add(p.placement.pose.position as V3, rotate(q, mul(a.pose.position, s)));
  const size: [number, number] = [a.size[0] * s, a.size[1] * s];
  const n = rotate(rotation, [0, 0, 1]), flat = Math.hypot(n[0], n[2]);
  const f: [number, number] = flat > 0.3 ? [n[0] / flat, n[2] / flat] : [0, 1], d = Math.max(2.5, 0.87 * size[0]);
  screens.push({piece: p, slot, workspace: ws, centre, rotation, size, f, d, standXZ: [centre[0] + f[0] * d, centre[1], centre[2] + f[1] * d]});
 }
 let region: Box = {min: [...spawn] as V3, max: [...spawn] as V3};
 for (const p of pieces) for (const b of [p.renderBox, p.proxyBox]) if (b) region = merge(region, b);
 for (const s of screens) region = merge(region, {min: s.standXZ, max: s.standXZ});
 region = {min: [region.min[0] - WALK.margin, region.min[1], region.min[2] - WALK.margin], max: [region.max[0] + WALK.margin, region.max[1], region.max[2] + WALK.margin]};
 const g = buildGrid(collision, region, o.cell ?? WALK.cell);
 walk(g);
 const at = (c: number): V3 => {const cc = Math.floor(c / MAX_LAYERS); return [r3(g.x0 + (cc % g.nx + 0.5) * g.cell), r3(g.floors[c]), r3(g.z0 + (Math.floor(cc / g.nx) + 0.5) * g.cell)];};

 // spawn.floor
 const playable: Box[] = (base.playable?.volumes ?? []).filter((v: any) => v.type === 'box').map((v: any) => ({min: v.min, max: v.max}));
 const inside = (p: number[]) => !playable.length || playable.some(b => p.every((v, i) => v >= b.min[i] - 1e-6 && v <= b.max[i] + 1e-6));
 const sf = floorAt(g, spawn, WALK.climb, 0.05);
 const spawnOk = !!sf && sf.ok && inside(spawn);
 items.push({id: 'spawn.floor', label: 'Spawn on the floor', done: spawnOk, blocks: true, level: spawnOk ? 'done' : 'open', show: {position: spawn},
  message: spawnOk ? 'The spawn stands on a floor with room around it.' : !sf ? 'There is no floor within 0.35 m under the spawn.' : !sf.ok ? 'Something blocks the space around the spawn (it needs 0.6 m across and 1.8 m up).' : 'The spawn is outside the playable area.',
  ...(spawnOk ? {} : {hint: 'Move the spawn with Set spawn here, or move what stands in the way'})});
 const main = sf?.ok ? g.parent[sf.node] : -1;

 // screens.count
 items.push({id: 'screens.count', label: 'Place at least 2 screens', done: screens.length >= 2, blocks: false, level: screens.length >= 2 ? 'done' : 'warning',
  message: `${screens.length} workspace screen${screens.length === 1 ? '' : 's'} with a home workspace.`, ...(screens.length >= 2 ? {} : {hint: 'Place workspace screens from Objects > Screens; each becomes the home of a workspace'})});

 // screen.approach, per screen
 const homes: Home[] = [];
 const boxes: Array<{s: Screen; obb: Obb | null}> = [];
 for (const s of screens) {
  const up = rotate(s.rotation, [0, 1, 0]), tilt = Math.acos(Math.max(-1, Math.min(1, up[1]))) * 180 / Math.PI;
  const bottom = s.centre[1] - s.size[1] / 2 * up[1], top = s.centre[1] + s.size[1] / 2 * up[1];
  const fl = floorAt(g, [s.standXZ[0], bottom, s.standXZ[2]], 4, 0.05);
  const standback: V3 | null = fl ? [r3(s.standXZ[0]), r3(fl.y), r3(s.standXZ[2])] : null;
  const yaw = Math.round(Math.atan2(-s.f[0], s.f[1]) * 180 / Math.PI * 100) / 100 + 0; // a heading facing the screen (0 faces -Z, 90 faces +X)
  const reachable = !!fl && fl.ok && main >= 0 && g.parent[fl.node] === main;
  homes.push({placement: s.piece.id, ...(s.piece.key ? {key: s.piece.key} : {}), slot: s.slot, workspace: s.workspace,
   anchor: {centre: s.centre.map(r3) as V3, rotation: s.rotation.map(v => Math.round(v * 1e6) / 1e6 + 0), size: [r3(s.size[0]), r3(s.size[1])]}, standback, yaw, reachable});
  const problems: string[] = [], hints: string[] = [];
  if (tilt > 10) {problems.push(`it leans ${Math.round(tilt)}° from upright`); hints.push('stand it upright');}
  let obb: Obb | null = null;
  if (!fl) {problems.push(`there is no floor ${s.d.toFixed(1)} m in front of it`); hints.push('put floor in front of the screen or turn it to face open floor');}
  else {
   if (!fl.ok) {problems.push('the standing spot in front of it is blocked'); hints.push(`clear the spot ${s.d.toFixed(1)} m in front of the screen`);}
   else if (!inside(standback!)) problems.push('the standing spot is outside the playable area');
   const above = bottom - fl.y;
   if (above < 0.2 || above > 3) {problems.push(`its bottom edge is ${above.toFixed(2)} m above the floor (0.2 to 3 m)`); hints.push(above < 0.2 ? 'raise it' : 'lower it');}
   // The clear box: screen to standback, w + 0.3 m each side, from 0.1 m above the floor to the top edge.
   const fx: V3 = [s.f[0], 0, s.f[1]], side: V3 = [-s.f[1], 0, s.f[0]], lo = fl.y + 0.1, hi = Math.max(top, lo + 0.1);
   obb = {c: [s.centre[0] + fx[0] * s.d / 2, (lo + hi) / 2, s.centre[2] + fx[2] * s.d / 2], u: [side, [0, 1, 0], fx], e: [s.size[0] / 2 + 0.3, (hi - lo) / 2, s.d / 2 - 0.05]};
   // The screen rectangle grown by 5 cm meets no other object's surface (no frame half inside a wall).
   const ax = rotate(s.rotation, [1, 0, 0]), ay = rotate(s.rotation, [0, 1, 0]), nrm = norm(rotate(s.rotation, [0, 0, 1])), ahead = mul(nrm, 5);
   const face: Obb = {c: s.centre, u: [ax, ay, nrm], e: [s.size[0] / 2 + 0.05, s.size[1] / 2 + 0.05, 0.02]};
   const fbox = obbBox(face), walls = new Set<string>();
   for (const p of pieces) {
    if (p === s.piece) continue;
    if (p.renderBox && overlaps(p.renderBox, fbox) && p.render.some(t => triObb(t, face))) {walls.add(label(p)); continue;}
    // Sunk whole into a solid: the first proxy face ahead of the centre is one we leave through.
    if (!p.proxyBox || !rayBox(s.centre, ahead, p.proxyBox)) continue;
    let first = Infinity, leaving = false;
    for (const t of p.proxy) {const k = rayTri(s.centre, ahead, t); if (k > 0 && k < first) {first = k; leaving = dot(cross(sub(t[1], t[0]), sub(t[2], t[0])), nrm) > 0;}}
    if (leaving) walls.add(label(p));
   }
   if (walls.size) {problems.push(`it is partly inside ${[...walls].slice(0, 3).join(', ')}`); hints.push('pull it out so the whole screen is in front of the surface');}
   const obox = obbBox(obb), blockers = new Set<string>();
   for (const p of pieces) {
    if (p === s.piece || walls.has(label(p)) || !p.proxyBox || !overlaps(p.proxyBox, obox)) continue;
    if (p.proxy.some(t => triObb(t, obb!))) blockers.add(label(p));
   }
   if (blockers.size) {problems.push(`${[...blockers].slice(0, 3).join(', ')} ${blockers.size === 1 ? 'stands' : 'stand'} in the space in front of it`); hints.push('move them out of the way or turn the screen');}
   // Visible from the eye at the standback: centre, corners inset 5 %, edge midpoints.
   const eye: V3 = [standback![0], fl.y + 1.7, standback![2]];
   const targets: V3[] = [];
   for (const [i, j] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]])
    targets.push(add(add(s.centre, mul(ax, i * s.size[0] / 2 * 0.95)), mul(ay, j * s.size[1] / 2 * 0.95)));
   const hiders = new Set<string>();
   for (const target of targets) {
    const dvec = sub(target, eye);
    for (const p of pieces) {
     if (p === s.piece || !p.renderBox || !rayBox(eye, dvec, p.renderBox)) continue;
     if (!blockers.has(label(p)) && !walls.has(label(p)) && p.render.some(t => {const k = rayTri(eye, dvec, t); return k > 0 && k < 0.995;})) hiders.add(label(p));
    }
   }
   if (hiders.size) {problems.push(`${[...hiders].slice(0, 3).join(', ')} ${hiders.size === 1 ? 'hides' : 'hide'} part of it from the standing spot`); hints.push('move what is in the way');}
   if (fl.ok && !reachable && main >= 0) {problems.push("its standing spot can't be reached from the spawn"); hints.push('connect it with floor, a ramp or stairs (steps up to 0.35 m)');}
  }
  boxes.push({s, obb});
  const done = !problems.length;
  items.push({id: 'screen.approach', label: `Screen approach clear: ${label(s.piece)}`, done, blocks: true, level: done ? 'done' : 'open', target: s.piece.id,
   ...(s.piece.key ? {key: s.piece.key} : {}), show: {position: standback ?? s.standXZ.map(r3)},
   message: done ? `Workspace ${s.workspace}: a clear standing spot ${s.d.toFixed(1)} m in front of it.` : `Workspace ${s.workspace}: ${problems.join('; ')}.`,
   ...(hints.length ? {hint: hints.join('; ').replace(/^./, c => c.toUpperCase())} : {})});
 }
 // Two screens' clear boxes may not overlap.
 for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
  const a = boxes[i].obb, b = boxes[j].obb;
  if (!a || !b || !overlaps(obbBox(a), obbBox(b)) || !obbTris(b).some(t => triObb(t, a))) continue;
  const item = items.find(x => x.id === 'screen.approach' && x.target === boxes[j].s.piece.id)!;
  const clash = `its approach overlaps ${label(boxes[i].s.piece)}'s`;
  item.message = item.done ? `Workspace ${boxes[j].s.workspace}: ${clash}.` : item.message.replace(/\.$/, `; ${clash}.`);
  item.done = false; item.level = 'open';
  item.hint = 'Move the screens apart or turn one away';
 }

 // walk.area
 const islandArea = new Map<number, number>();
 for (let c = 0; c < g.nx * g.nz; c++) for (let l = 0; l < g.layers[c]; l++) if (g.ok[c * MAX_LAYERS + l]) {
  const root = g.parent[c * MAX_LAYERS + l];
  islandArea.set(root, (islandArea.get(root) ?? 0) + g.cell * g.cell);
 }
 const unreachableHomes = homes.filter(h => !h.reachable && h.standback);
 const walkOk = main >= 0 && !unreachableHomes.length;
 const lost = [...islandArea].filter(([root, area]) => root !== main && area > 25).sort((a, b) => b[1] - a[1]);
 items.push({id: 'walk.area', label: 'Check the walkable area', done: walkOk, blocks: true, level: walkOk ? (lost.length ? 'warning' : 'done') : 'open',
  message: main < 0 ? "The spawn isn't on a walkable floor, so nothing can be reached." : unreachableHomes.length
   ? `${unreachableHomes.length} screen${unreachableHomes.length === 1 ? '' : 's'} can't be reached on foot from the spawn.`
   : lost.length ? `Every screen can be reached; ${lost.length} walkable place${lost.length === 1 ? '' : 's'} over 25 m² can't (the largest is ${Math.round(lost[0][1])} m²).`
   : 'The spawn reaches every screen on foot.',
  ...(lost.length && walkOk ? {show: {position: at(lost[0][0] === g.outside ? 0 : firstNode(g, lost[0][0]))}} : {}),
  ...(walkOk ? {} : {hint: 'Connect the places with floor, ramps or stairs; steps up to 0.35 m, slopes up to 49°'})});

 // budgets and sizes
 const totals = {placements: pieces.length, assets: assets.size, triangles: 0, gpuBytes: 0, collisionTriangles: 0};
 for (const p of pieces) {const a = assets.get(p.asset)!; totals.triangles += a.triangles; totals.collisionTriangles += a.proxy.length;}
 for (const a of assets.values()) totals.gpuBytes += a.gpuBytes;
 const over = (Object.keys(TOTALS) as Array<keyof typeof TOTALS>).filter(k => totals[k] > TOTALS[k]);
 items.push({id: 'budgets', label: 'Fits the world budget', done: !over.length, blocks: true, level: over.length ? 'open' : 'done',
  message: over.length ? `Over the limit: ${over.map(k => `${k} ${totals[k]} of ${TOTALS[k]}`).join(', ')}.` : `${totals.triangles.toLocaleString('en')} triangles, ${Math.round(totals.gpuBytes / 1048576)} MiB of GPU memory, ${totals.collisionTriangles.toLocaleString('en')} collision triangles.`,
  ...(over.length ? {hint: 'Simplify the largest objects or remove some'} : {})});
 const big = [...assets].filter(([, a]) => a.triangles > RECOMMENDED.triangles || a.maxTexture > RECOMMENDED.maxTexture);
 items.push({id: 'sizes', label: 'Recommended sizes', done: !big.length, blocks: false, level: big.length ? 'warning' : 'done',
  message: big.length ? `Over the recommended ${RECOMMENDED.triangles.toLocaleString('en')} triangles or ${RECOMMENDED.maxTexture} px: ${big.slice(0, 4).map(([id, a]) => `${a.object?.name ?? id} (${a.triangles.toLocaleString('en')}, ${a.maxTexture} px)`).join(', ')}.` : 'Every object is within the recommended sizes.',
  ...(big.length ? {hint: 'Simplify them from the Objects tab; they still load as they are'} : {})});

 // rights and the official-publishing check (never block)
 const objects = new Map([...assets].map(([id, a]) => [id, a.object]));
 const parts = provenanceParts(folder, project, objects);
 const unknown = parts.filter(p => p.missing.length);
 items.push({id: 'rights', label: 'Record licences', done: !unknown.length, blocks: false, level: unknown.length ? 'warning' : 'done',
  message: unknown.length ? `${unknown.length} part${unknown.length === 1 ? ' has' : 's have'} an unknown licence, author or source: ${unknown.slice(0, 4).map(p => p.what).join(', ')}.` : 'Every part has its licence, author and source recorded.',
  ...(unknown.length ? {hint: 'Fill them in where you know them; unknown parts still save and release'} : {})});
 const eligible = parts.every(p => p.official);
 items.push({id: 'publish.official', label: 'Official publishing', done: eligible, blocks: false, level: eligible ? 'done' : 'warning',
  message: eligible ? 'Every part is CC0-1.0 or CC-BY-4.0 with an author and a source.' : `${parts.filter(p => !p.official).length} part(s) don't meet the official bar (CC0-1.0 or CC-BY-4.0 with an author and a source); releasing on your own is fine.`});

 const result: CheckResult = {
  digest, checkedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), folder, ready: false, items, homes,
  walk: {cell: r3(g.cell), cells: g.nx * g.nz, islands: islandArea.size, mainArea: Math.round(main >= 0 ? islandArea.get(main) ?? 0 : 0), reachesOutside: main >= 0 && main === g.parent[g.outside], ms: Date.now() - started},
  totals, publishing: {officialEligible: eligible, parts},
 };
 try {mkdirSync(join(folder, 'builder/cache'), {recursive: true}); writeFileSync(cachePath, JSON.stringify(result));} catch {/* a read-only folder still checks */}
 return withSave(result, saved.total);
}
function firstNode(g: Grid, root: number): number {
 for (let i = 0; i < g.outside; i++) if (g.parent[i] === root && g.ok[i]) return i;
 return 0;
}
/** The save item depends on git, not on the digest: added on every read. */
function withSave(r: CheckResult, pendingTotal: number): CheckResult {
 const items = r.items.filter(i => i.id !== 'save');
 items.push({id: 'save', label: 'Save', done: !pendingTotal, blocks: false, level: pendingTotal ? 'warning' : 'done',
  message: pendingTotal ? `${pendingTotal} unsaved change${pendingTotal === 1 ? '' : 's'}.` : 'Everything is saved.'});
 return {...r, items, ready: items.every(i => i.done || !i.blocks)};
}

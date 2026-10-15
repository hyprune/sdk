// Primitives and materials for building in the world (RFC-0014 amendment: primitives and
// materials). A primitive (cube, box, cylinder, sphere, plane, ramp, stairs) is generated as an
// ordinary object format 0.11 directory: object.glb at its exact size with box-mapped UVs in
// metres, a collision proxy that matches it, a CPU thumbnail and primitive.json recording how it
// was made. Its id is a digest of shape, size and material, so the same request gives the same
// directory (idempotent), and another size or material gives another one: the placement swaps
// to it (objects.configure ref) and keeps its id. Materials live in a library folder
// (materials/<key>/: material.json, the texture, a swatch) in the world folder or the user's
// data directory. Pure JavaScript.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {decodeImage,encodeJpeg,encodePng,fitInside,imageMime,type Rgba} from './pixels.js';
import {FLOOR_PRESETS,floorPreset} from './presets.js';
import {boxProxy,convexHull,offStdout,renderThumbnail,type ThumbTexture} from './import.js';
import {validateManifest} from './validation.js';
import {dataHome} from './paths.js';

export const SHAPES = ['cube', 'box', 'cylinder', 'sphere', 'plane', 'ramp', 'stairs'] as const;
export type Shape = typeof SHAPES[number];
export type V3 = [number, number, number];
/** Default sizes (metres) per shape: what the Objects tab offers before you type numbers. */
export const DEFAULT_SIZES: Record<Shape, V3> = {cube: [1, 1, 1], box: [2, 1, 1], cylinder: [1, 2, 1], sphere: [1, 1, 1], plane: [4, 0.02, 4], ramp: [2, 1, 4], stairs: [1.2, 1.8, 3]};
export const SIZE_MIN = 0.01, SIZE_MAX = 100, STEP_RISE = 0.18;
const GENERATOR = 'hyprune builder primitive';

export type PrimitiveCode = 'primitive.invalid' | 'material.invalid' | 'material.unknown';
export class PrimitiveError extends Error {
 constructor(public code: PrimitiveCode, message: string, public hint?: string) {super(message);}
}
const fail = (code: PrimitiveCode, message: string, hint?: string): never => {throw new PrimitiveError(code, message, hint);};

// ---- materials ----
export interface MaterialRecord {
 materialVersion: '0.1'; key: string; name: string; colour: string;
 texture: null | {image: 'texture.jpg' | 'texture.png' | 'texture.ktx2'; tile: number; width: number; height: number};
 emissive: null | {colour: string; strength: number}; roughness: number; metallic: number;
 license: string; author: string; source: string;
}
/** A material ready to bake: its record, its texture bytes and a small decoded copy for thumbnails. */
export interface Material {record: MaterialRecord; texture: Uint8Array | null; swatch: Rgba | null; digest: string}
export interface MaterialPatch {
 name?: string; colour?: string; roughness?: number; metallic?: number;
 emissive?: null | {colour: string; strength: number};
 /** A texture: the user's PNG or JPEG (with provenance), a built-in floor texture, or null for none. */
 texture?: null | {path: string; license: string; author: string; source: string} | {preset: string};
 tile?: number;
}
export const KEY = /^[a-z][a-z0-9-]{0,47}$/;
/** The key of an inline material (never a valid library key). */
const INLINE = '-inline';
const HEX = /^#[0-9a-f]{6}$/;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const sha = (...parts: Array<string | Uint8Array>) => {const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex');};
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/** The user's material library: $HYPRUNE_MATERIAL_DIR, else $XDG_DATA_HOME/hyprune/materials. */
export const userMaterialsDir = (env = process.env) => env.HYPRUNE_MATERIAL_DIR || join(dataHome(env), 'hyprune', 'materials');
export const materialsDirOf = (folder: string) => join(folder, 'materials');

export function hexColour(text: string, what = 'colour'): string {
 const t = String(text).trim().toLowerCase();
 const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
 const full = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : t.startsWith('#') ? t : '#' + t;
 if (!HEX.test(full)) fail('material.invalid', `A ${what} is #rrggbb (not ${text})`, 'Like #c8a050');
 return full;
}
const linear = (hex: string): V3 => [1, 3, 5].map(i => {const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;}) as V3;

/** An inline material (no key, no texture): what `--colour` makes for a one-off primitive. */
export function plainMaterial(o: {colour: string; emissive?: null | {colour: string; strength: number}; roughness?: number; metallic?: number}): Material {
 const record: MaterialRecord = {materialVersion: '0.1', key: INLINE, name: `Colour ${hexColour(o.colour)}`, colour: hexColour(o.colour), texture: null,
  emissive: o.emissive ? {colour: hexColour(o.emissive.colour, 'glow colour'), strength: clamp(o.emissive.strength, 0, 16, 'glow strength')} : null,
  roughness: clamp(o.roughness ?? 0.7, 0, 1, 'roughness'), metallic: clamp(o.metallic ?? 0, 0, 1, 'metalness'),
  license: 'CC0-1.0', author: 'Hyprune contributors', source: 'Generated by the hyprune CLI'};
 return {record, texture: null, swatch: null, digest: 'sha256:' + sha(canonical({...record, key: null}))};
}
function clamp(v: number, lo: number, hi: number, what: string): number {
 if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail('material.invalid', `The ${what} is ${lo} to ${hi} (not ${v})`);
 return r4(v);
}
export function readMaterial(dir: string, key: string): Material {
 if (!KEY.test(key)) fail('material.invalid', `A material key is a slug like oak-planks (not ${key})`);
 const path = join(dir, key, 'material.json');
 if (!existsSync(path)) fail('material.unknown', `There is no material "${key}"`, `Materials: ${listMaterials(dir).map(m => m.key).join(', ') || 'none yet'}; built-in textures: ${FLOOR_PRESETS.map(f => f.id).join(', ')}`);
 const record = JSON.parse(readFileSync(path, 'utf8')) as MaterialRecord;
 const check = validateManifest('material', record);
 if (!check.valid) fail('material.invalid', `materials/${key}/material.json: ${check.errors.join('; ')}`);
 const texture = record.texture ? readFileSync(join(dir, key, record.texture.image)) : null;
 const swatchPath = join(dir, key, 'swatch.png');
 const swatch = record.texture && existsSync(swatchPath) ? decodeImage(readFileSync(swatchPath)) : null;
 return {record, texture, swatch, digest: 'sha256:' + sha(canonical(record), texture ?? '')};
}
export interface MaterialSummary {key: string; name: string; colour: string; textured: boolean; tile: number | null; swatch: string | null; license: string; author: string}
export function listMaterials(dir: string): MaterialSummary[] {
 if (!existsSync(dir)) return [];
 const out: MaterialSummary[] = [];
 for (const key of readdirSync(dir).sort()) {
  if (!KEY.test(key) || !existsSync(join(dir, key, 'material.json'))) continue;
  try {
   const r = JSON.parse(readFileSync(join(dir, key, 'material.json'), 'utf8')) as MaterialRecord;
   out.push({key, name: r.name, colour: r.colour, textured: !!r.texture, tile: r.texture?.tile ?? null,
    swatch: existsSync(join(dir, key, 'swatch.png')) ? join(dir, key, 'swatch.png') : null, license: r.license, author: r.author});
  } catch {/* a broken material is skipped here; readMaterial reports it */}
 }
 return out;
}
/** A swatch (128 px) of a texture tinted by the colour: the picker's thumbnail and the thumbnails' texture. */
function swatchOf(img: Rgba, colour: string): Rgba {
 const small = fitInside(img, 128), tint = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16) / 255), out = new Uint8Array(small.data.length);
 for (let i = 0; i < small.data.length; i += 4) {for (let c = 0; c < 3; c++) out[i + c] = Math.round(small.data[i + c] * tint[c]); out[i + 3] = 255;}
 return {width: small.width, height: small.height, data: out};
}
const swatchColour = (colour: string): Rgba => {
 const c = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16)), data = new Uint8Array(64 * 64 * 4);
 for (let i = 0; i < data.length; i += 4) {data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;}
 return {width: 64, height: 64, data};
};
/** Largest power of two at most `max` and at most the side: textures repeat and mip cleanly. */
const pow2 = (side: number, max: number) => {let p = 1; while (p * 2 <= Math.min(side, max)) p *= 2; return p;};
function resizeTo(img: Rgba, w: number, h: number): Rgba {
 if (img.width === w && img.height === h) return img;
 const out = new Uint8Array(w * h * 4), sx = img.width / w, sy = img.height / h;
 for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
  const s = [0, 0, 0, 0];
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {const i = (yy * img.width + xx) * 4; for (let c = 0; c < 4; c++) s[c] += img.data[i + c];}
  const n = (x1 - x0) * (y1 - y0), o = (y * w + x) * 4;
  for (let c = 0; c < 4; c++) out[o + c] = Math.round(s[c] / n);
 }
 return {width: w, height: h, data: out};
}
async function ktx2(img: Rgba): Promise<Uint8Array> {
 const {encodeToKTX2} = await import('ktx2-encoder');
 const png = encodePng(img);
 return new Uint8Array(await offStdout(() => encodeToKTX2(png, {enableDebug: false, isUASTC: false, generateMipmap: true, qualityLevel: 128,
  isSetKTX2SRGBTransferFunc: true, isKTX2File: true, imageDecoder: async (b: Uint8Array) => decodeImage(b)} as any)));
}
export interface MaterialResult {material: MaterialSummary; created: boolean; changed: boolean; dryRun?: true}
/**
 * Creates or changes a material: every given field is set to the value given (absolute, so a
 * retry gives the same material); fields not given keep their value (a new material: white,
 * no texture, roughness 0.7). A texture is fitted to a power of two of at most 1,024 px and
 * stored as KTX2 (Basis ETC1S, mipmapped), with a 128 px swatch.
 */
export async function setMaterial(dir: string, key: string, patch: MaterialPatch, o: {dryRun?: boolean} = {}): Promise<MaterialResult> {
 if (!KEY.test(key)) fail('material.invalid', `A material key is a slug like oak-planks (not ${key})`);
 const exists = existsSync(join(dir, key, 'material.json')), before = exists ? readMaterial(dir, key) : null;
 const r: MaterialRecord = before ? structuredClone(before.record) : {materialVersion: '0.1', key, name: key.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()),
  colour: '#ffffff', texture: null, emissive: null, roughness: 0.7, metallic: 0, license: 'CC0-1.0', author: 'Hyprune contributors', source: 'Generated by the hyprune CLI'};
 if (patch.name !== undefined) {const n = String(patch.name).trim(); if (!n || n.length > 64 || /[\u0000-\u001f\u007f]/.test(n)) fail('material.invalid', 'A material name is 1 to 64 characters'); r.name = n;}
 if (patch.colour !== undefined) r.colour = hexColour(patch.colour);
 if (patch.roughness !== undefined) r.roughness = clamp(patch.roughness, 0, 1, 'roughness');
 if (patch.metallic !== undefined) r.metallic = clamp(patch.metallic, 0, 1, 'metalness');
 if (patch.emissive !== undefined) r.emissive = patch.emissive ? {colour: hexColour(patch.emissive.colour, 'glow colour'), strength: clamp(patch.emissive.strength, 0, 16, 'glow strength')} : null;
 let texture: Uint8Array | null = before?.texture ?? null, swatch: Rgba | null = before?.swatch ?? null, image: Rgba | null = null;
 if (patch.texture === null) {r.texture = null; texture = null; swatch = null; r.license = 'CC0-1.0'; r.author = 'Hyprune contributors'; r.source = 'Generated by the hyprune CLI';}
 else if (patch.texture && 'preset' in patch.texture) {
  const p = floorPreset(patch.texture.preset);
  if (!p) return fail('material.invalid', `There is no built-in texture "${patch.texture.preset}"`, `Built-in textures: ${FLOOR_PRESETS.map(f => f.id).join(', ')}`);
  image = p.texture(512);
  r.texture = {image: 'texture.ktx2', tile: patch.tile ?? p.tile, width: 512, height: 512};
  r.license = 'CC0-1.0'; r.author = 'Hyprune contributors'; r.source = `Generated by the hyprune CLI (${p.name} texture)`;
 } else if (patch.texture) {
  const t = patch.texture;
  for (const k of ['license', 'author', 'source'] as const) if (!String(t[k] ?? '').trim()) fail('material.invalid', `The texture needs its ${k}`, k === 'license' ? 'An SPDX id like CC0-1.0, or LicenseRef-unknown' : 'Any text; "unknown" is fine');
  let st;
  try {st = statSync(t.path);} catch {return fail('material.invalid', `There is no file at ${t.path}`);}
  if (!st.isFile() || st.size > 256 * 1048576) fail('material.invalid', `${t.path} is not a texture file (a PNG or JPEG up to 256 MiB)`);
  const bytes = readFileSync(t.path), mime = imageMime(bytes);
  if (!mime) fail('material.invalid', 'A texture is a PNG or JPEG image');
  let img: Rgba;
  try {img = decodeImage(bytes, mime);} catch (e: any) {return fail('material.invalid', `The texture can't be read: ${e.message}`);}
  if (Math.min(img.width, img.height) < 16) fail('material.invalid', `The texture is ${img.width} x ${img.height}: at least 16 px`);
  const w = pow2(img.width, 1024), h = pow2(img.height, 1024);
  image = resizeTo(img, w, h);
  r.texture = {image: 'texture.ktx2', tile: patch.tile ?? r.texture?.tile ?? 1, width: w, height: h};
  r.license = t.license.trim(); r.author = t.author.trim(); r.source = t.source.trim();
 }
 if (patch.tile !== undefined) {
  if (!r.texture) fail('material.invalid', 'Only a textured material has a tile size', 'Give it a texture first');
  r.texture!.tile = clamp(patch.tile, 0.05, 100, 'tile');
 }
 const check = validateManifest('material', r);
 if (!check.valid) fail('material.invalid', check.errors.join('; '));
 if (image) {swatch = swatchOf(image, r.colour); if (!o.dryRun) texture = await ktx2(image);}
 // A new tint on the same texture: the stored swatch is re-tinted (the untinted texture is the KTX2).
 else if (r.texture && swatch && before && before.record.colour !== r.colour) swatch = tintSwatch(swatch, before.record.colour, r.colour);
 const summary: MaterialSummary = {key, name: r.name, colour: r.colour, textured: !!r.texture, tile: r.texture?.tile ?? null,
  swatch: join(dir, key, 'swatch.png'), license: r.license, author: r.author};
 const changed = !before || canonical(before.record) !== canonical(r) || !!image;
 if (o.dryRun) return {material: summary, created: !exists, changed, dryRun: true};
 if (!changed) return {material: summary, created: false, changed: false};
 mkdirSync(dir, {recursive: true});
 const stage = mkdtempSync(join(dir, `.${key}-`));
 try {
  writeFileSync(join(stage, 'material.json'), JSON.stringify(r, null, 1) + '\n');
  if (r.texture && texture) writeFileSync(join(stage, r.texture.image), texture);
  writeFileSync(join(stage, 'swatch.png'), encodePng(r.texture && swatch ? swatch : swatchColour(r.colour)));
  const target = join(dir, key), old = join(dir, `.${key}.old`);
  rmSync(old, {recursive: true, force: true});
  if (exists) renameSync(target, old);
  renameSync(stage, target);
  rmSync(old, {recursive: true, force: true});
 } finally {rmSync(stage, {recursive: true, force: true});}
 return {material: summary, created: !exists, changed: true};
}
/** A stored swatch re-tinted from one colour to another (the untinted texture stays in KTX2). */
function tintSwatch(s: Rgba, from: string, to: string): Rgba {
 const a = [1, 3, 5].map(i => Math.max(1, parseInt(from.slice(i, i + 2), 16)) / 255), b = [1, 3, 5].map(i => parseInt(to.slice(i, i + 2), 16) / 255);
 const out = new Uint8Array(s.data.length);
 for (let i = 0; i < s.data.length; i += 4) {for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round(s.data[i + c] / a[c] * b[c])); out[i + 3] = 255;}
 return {width: s.width, height: s.height, data: out};
}
/** A material by key from a library, or a built-in texture (grass, paving, …) copied into it on first use. */
export async function resolveMaterial(dir: string, key: string): Promise<Material> {
 if (!existsSync(join(dir, key, 'material.json')) && floorPreset(key)) await setMaterial(dir, key, {texture: {preset: key}, name: floorPreset(key)!.name});
 return readMaterial(dir, key);
}

// ---- geometry ----
interface Mesh {pos: number[]; nrm: number[]; uv: number[]; idx: number[]}
const mesh = (): Mesh => ({pos: [], nrm: [], uv: [], idx: []});
/** A flat quad (corners counter-clockwise seen from the front) with UVs from two axes, in metres. */
function quad(m: Mesh, c: V3[], n: V3, uv: (p: V3) => [number, number]): void {
 const base = m.pos.length / 3;
 for (const p of c) {m.pos.push(...p); m.nrm.push(...n); m.uv.push(...uv(p));}
 m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function tri(m: Mesh, c: V3[], n: V3, uv: (p: V3) => [number, number]): void {
 const base = m.pos.length / 3;
 for (const p of c) {m.pos.push(...p); m.nrm.push(...n); m.uv.push(...uv(p));}
 m.idx.push(base, base + 1, base + 2);
}
const norm3 = (v: number[]): V3 => {const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l];};
/** Box-mapped UVs in metres: each face uses its two in-plane axes (v down the face, so images stand upright). */
const UV = {x: (p: V3): [number, number] => [-p[2], -p[1]], X: (p: V3): [number, number] => [p[2], -p[1]], y: (p: V3): [number, number] => [p[0], p[2]],
 Y: (p: V3): [number, number] => [p[0], -p[2]], z: (p: V3): [number, number] => [-p[0], -p[1]], Z: (p: V3): [number, number] => [p[0], -p[1]]};
function cuboid(m: Mesh, lo: V3, hi: V3, faces = 'xXyYzZ'): void {
 const [a, b, c] = lo, [d, e, f] = hi;
 if (faces.includes('X')) quad(m, [[d, b, f], [d, b, c], [d, e, c], [d, e, f]], [1, 0, 0], UV.X);
 if (faces.includes('x')) quad(m, [[a, b, c], [a, b, f], [a, e, f], [a, e, c]], [-1, 0, 0], UV.x);
 if (faces.includes('Y')) quad(m, [[a, e, f], [d, e, f], [d, e, c], [a, e, c]], [0, 1, 0], UV.Y);
 if (faces.includes('y')) quad(m, [[a, b, c], [d, b, c], [d, b, f], [a, b, f]], [0, -1, 0], UV.y);
 if (faces.includes('Z')) quad(m, [[a, b, f], [d, b, f], [d, e, f], [a, e, f]], [0, 0, 1], UV.Z);
 if (faces.includes('z')) quad(m, [[d, b, c], [a, b, c], [a, e, c], [d, e, c]], [0, 0, -1], UV.z);
}
export interface Geometry {render: Mesh; proxy: V3[][]}
/** The mesh of a primitive standing on y = 0, centred on x and z, and its collision proxy. */
export function primitiveGeometry(shape: Shape, size: V3, steps?: number): Geometry {
 const [x, y, z] = size, hx = x / 2, hz = z / 2, m = mesh();
 if (shape === 'cube' || shape === 'box' || shape === 'plane') {
  cuboid(m, [-hx, 0, -hz], [hx, y, hz]);
  return {render: m, proxy: boxProxy([-hx, 0, -hz], [hx, Math.max(y, 0.01), hz])};
 }
 if (shape === 'cylinder') {
  const n = 32, ring = (i: number): [number, number] => {const a = i / n * 2 * Math.PI; return [Math.sin(a) * hx, Math.cos(a) * hz];};
  const perimeter = Math.PI * (3 * (hx + hz) - Math.sqrt((3 * hx + hz) * (hx + 3 * hz)));
  for (let i = 0; i < n; i++) {
   const [x0, z0] = ring(i), [x1, z1] = ring(i + 1), u0 = perimeter * i / n, u1 = perimeter * (i + 1) / n;
   const n0 = norm3([x0 / (hx * hx), 0, z0 / (hz * hz)]), n1 = norm3([x1 / (hx * hx), 0, z1 / (hz * hz)]), base = m.pos.length / 3;
   m.pos.push(x0, 0, z0, x1, 0, z1, x1, y, z1, x0, y, z0); m.nrm.push(...n0, ...n1, ...n1, ...n0); m.uv.push(u0, 0, u1, 0, u1, -y, u0, -y);
   m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
   tri(m, [[0, y, 0], [x0, y, z0], [x1, y, z1]], [0, 1, 0], UV.Y);
   tri(m, [[0, 0, 0], [x1, 0, z1], [x0, 0, z0]], [0, -1, 0], UV.y);
  }
  const pts: V3[] = [];
  for (let i = 0; i < 16; i++) {const a = i / 16 * 2 * Math.PI; pts.push([Math.sin(a) * hx, 0, Math.cos(a) * hz], [Math.sin(a) * hx, y, Math.cos(a) * hz]);}
  return {render: m, proxy: convexHull(pts) ?? boxProxy([-hx, 0, -hz], [hx, y, hz])};
 }
 if (shape === 'sphere') {
  const cols = 32, rows = 16, hy = y / 2, base = 0;
  const eq = Math.PI * (3 * (hx + hz) - Math.sqrt((3 * hx + hz) * (hx + 3 * hz))), mer = Math.PI * Math.max(hx, hy, hz);
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
   const th = r / rows * Math.PI, ph = c / cols * 2 * Math.PI, s = Math.sin(th);
   const p: V3 = [Math.sin(ph) * s * hx, hy + Math.cos(th) * hy, Math.cos(ph) * s * hz];
   m.pos.push(...p); m.nrm.push(...norm3([(p[0]) / (hx * hx), (p[1] - hy) / (hy * hy), p[2] / (hz * hz)])); m.uv.push(eq * c / cols, mer * r / rows);
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
   const a = base + r * (cols + 1) + c, b = a + cols + 1;
   if (r > 0) m.idx.push(a, b, a + 1);
   if (r < rows - 1) m.idx.push(a + 1, b, b + 1);
  }
  const pts: V3[] = [];
  for (let r = 0; r <= 6; r++) for (let c = 0; c < 12; c++) {const th = r / 6 * Math.PI, ph = c / 12 * 2 * Math.PI; pts.push([Math.sin(ph) * Math.sin(th) * hx, hy + Math.cos(th) * hy, Math.cos(ph) * Math.sin(th) * hz]);}
  return {render: m, proxy: convexHull(pts) ?? boxProxy([-hx, 0, -hz], [hx, y, hz])};
 }
 if (shape === 'ramp') {
  // A wedge: the floor at +z, rising to height y at -z (walk up it towards -z).
  const slope = norm3([0, z, y]);
  quad(m, [[-hx, 0, hz], [hx, 0, hz], [hx, y, -hz], [-hx, y, -hz]], slope, p => [p[0], -(Math.hypot(hz - p[2], p[1]))]);
  quad(m, [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]], [0, -1, 0], UV.y);
  quad(m, [[hx, 0, -hz], [-hx, 0, -hz], [-hx, y, -hz], [hx, y, -hz]], [0, 0, -1], UV.z);
  tri(m, [[hx, 0, hz], [hx, 0, -hz], [hx, y, -hz]], [1, 0, 0], UV.X);
  tri(m, [[-hx, 0, -hz], [-hx, 0, hz], [-hx, y, -hz]], [-1, 0, 0], UV.x);
  const pts: V3[] = [[-hx, 0, hz], [hx, 0, hz], [-hx, 0, -hz], [hx, 0, -hz], [-hx, y, -hz], [hx, y, -hz]];
  return {render: m, proxy: convexHull(pts) ?? boxProxy([-hx, 0, -hz], [hx, y, hz])};
 }
 // Stairs: `steps` solid steps rising towards -z, each y/steps high and z/steps deep.
 const n = steps ?? Math.max(1, Math.round(y / STEP_RISE)), rise = y / n, depth = z / n, proxy: V3[][] = [];
 for (let i = 0; i < n; i++) {
  const lo: V3 = [-hx, 0, hz - (i + 1) * depth], hi: V3 = [hx, (i + 1) * rise, hz - i * depth];
  // Hidden faces between steps are left out: each step's top, front, sides; the last one its back; the floor face once per step.
  cuboid(m, lo, hi, 'xXYyZ' + (i === n - 1 ? 'z' : ''));
  proxy.push(...boxProxy(lo, hi));
 }
 return {render: m, proxy};
}
function triangles(m: Mesh): {tris: number[][][]; uvs: number[][][]} {
 const tris: number[][][] = [], uvs: number[][][] = [];
 for (let i = 0; i < m.idx.length; i += 3) {
  tris.push([0, 1, 2].map(k => m.pos.slice(m.idx[i + k] * 3, m.idx[i + k] * 3 + 3)));
  uvs.push([0, 1, 2].map(k => m.uv.slice(m.idx[i + k] * 2, m.idx[i + k] * 2 + 2)));
 }
 return {tris, uvs};
}

// ---- the object directory ----
export interface PrimitiveSpec {shape: Shape; size: number[]; steps?: number}
export function checkSpec(spec: PrimitiveSpec): {shape: Shape; size: V3; steps?: number} {
 if (!(SHAPES as readonly string[]).includes(spec.shape)) fail('primitive.invalid', `There is no shape "${spec.shape}"`, `Shapes: ${SHAPES.join(', ')}`);
 const size = (spec.size?.length === 1 ? [spec.size[0], spec.size[0], spec.size[0]] : spec.size ?? DEFAULT_SIZES[spec.shape]).map(Number);
 if (size.length !== 3 || size.some(v => !Number.isFinite(v) || v < SIZE_MIN || v > SIZE_MAX))
  fail('primitive.invalid', `A size is width, height and depth in metres, each ${SIZE_MIN} to ${SIZE_MAX} (not ${spec.size?.join(', ')})`, 'Like 2,0.2,1');
 if (spec.shape === 'cube' && (size[0] !== size[1] || size[1] !== size[2])) fail('primitive.invalid', 'A cube has three equal sides', 'Use a box for other sizes');
 let steps: number | undefined;
 if (spec.shape === 'stairs') {
  steps = spec.steps ?? Math.max(1, Math.round(size[1] / STEP_RISE));
  if (!Number.isInteger(steps) || steps < 1 || steps > 64) fail('primitive.invalid', `Stairs have 1 to 64 steps (not ${spec.steps})`);
 } else if (spec.steps !== undefined) fail('primitive.invalid', 'Only stairs have steps');
 return {shape: spec.shape, size: size.map(r4) as V3, ...(steps !== undefined ? {steps} : {})};
}
const fmt = (v: number) => String(r4(v));
const SHAPE_NAMES: Record<Shape, string> = {cube: 'Cube', box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', plane: 'Plane', ramp: 'Ramp', stairs: 'Stairs'};
/** The id a primitive gets: shape and a digest of shape, size, steps and the material's content. */
export function primitiveId(spec: PrimitiveSpec, material: Material): string {
 const s = checkSpec(spec);
 return `${s.shape}-${sha(canonical({shape: s.shape, size: s.size, steps: s.steps ?? null, material: material.digest})).slice(0, 10)}`;
}
export interface BuiltPrimitive {id: string; manifest: Record<string, unknown>; record: Record<string, unknown>; glb: Uint8Array; thumbnail: Uint8Array}
export async function buildPrimitive(spec: PrimitiveSpec, material: Material, version = '0.0.0'): Promise<BuiltPrimitive> {
 const s = checkSpec(spec), id = primitiveId(s, material), geo = primitiveGeometry(s.shape, s.size, s.steps), mr = material.record;
 const core = await import('@gltf-transform/core'), ext = await import('@gltf-transform/extensions');
 const doc = new core.Document(), buffer = doc.createBuffer();
 doc.setLogger({debug: () => {}, info: () => {}, warn: (...a: unknown[]) => console.error(...a), error: (...a: unknown[]) => console.error(...a)} as any);
 const tile = mr.texture?.tile ?? 1;
 const acc = (type: 'VEC3' | 'VEC2' | 'SCALAR', arr: Float32Array | Uint16Array | Uint32Array) => doc.createAccessor().setType(type).setBuffer(buffer).setArray(arr);
 const r = geo.render, big = r.pos.length / 3 > 65535;
 const prim = doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array(r.pos))).setAttribute('NORMAL', acc('VEC3', new Float32Array(r.nrm)))
  .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(r.uv.map(v => v / tile)))).setIndices(acc('SCALAR', big ? new Uint32Array(r.idx) : new Uint16Array(r.idx)));
 const lin = linear(mr.colour);
 const mat = doc.createMaterial(mr.name).setBaseColorFactor([lin[0], lin[1], lin[2], 1]).setRoughnessFactor(mr.roughness).setMetallicFactor(mr.metallic);
 if (mr.texture && material.texture) {
  const t = doc.createTexture('texture').setImage(material.texture).setMimeType(mr.texture.image.endsWith('ktx2') ? 'image/ktx2' : mr.texture.image.endsWith('png') ? 'image/png' : 'image/jpeg');
  mat.setBaseColorTexture(t);
  mat.getBaseColorTextureInfo()!.setMinFilter(9987).setMagFilter(9729).setWrapS(10497).setWrapT(10497);
  if (mr.texture.image.endsWith('ktx2')) doc.createExtension(ext.KHRTextureBasisu).setRequired(true);
 }
 if (mr.emissive && mr.emissive.strength > 0) {
  const e = linear(mr.emissive.colour), strength = mr.emissive.strength;
  mat.setEmissiveFactor([e[0], e[1], e[2]]);
  if (strength !== 1) mat.setExtension('KHR_materials_emissive_strength', doc.createExtension(ext.KHRMaterialsEmissiveStrength).createEmissiveStrength().setEmissiveStrength(strength));
 }
 prim.setMaterial(mat);
 const node = doc.createNode(s.shape).setMesh(doc.createMesh(s.shape).addPrimitive(prim));
 doc.createScene(id).addChild(node);
 const proxyArr = new Float32Array(geo.proxy.flat().flat());
 doc.createNode('proxy').setMesh(doc.createMesh('proxy').addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc('VEC3', proxyArr)))); // outside the scene
 doc.getRoot().getAsset().generator = `${GENERATOR} ${version}`;
 const glb = await new core.NodeIO().registerExtensions([ext.KHRTextureBasisu, ext.KHRMaterialsEmissiveStrength]).writeBinary(doc);
 // Thumbnail: the shape with its colour (and the swatch as the texture, scaled to the tile).
 const {tris, uvs} = triangles(r);
 let thumbTex: ThumbTexture | null = null;
 if (material.swatch) {
  const sw = material.swatch, rgb = new Float32Array(sw.width * sw.height * 3);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) for (let c = 0; c < 3; c++) {const v = sw.data[j + c] / 255; rgb[i + c] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;}
  thumbTex = {width: sw.width, height: sw.height, rgb};
 }
 const colour: V3 = thumbTex ? [1, 1, 1] : lin, glow: V3 = mr.emissive ? linear(mr.emissive.colour).map(v => v * Math.min(1, mr.emissive!.strength) * 0.8) as V3 : [0, 0, 0];
 const thumbnail = await renderThumbnail(tris, tris.map(() => colour), tris.map(() => glow), 256, 3, uvs.map(t => t.map(p => [p[0] / tile, p[1] / tile])), tris.map(() => thumbTex));
 const textured = !!mr.texture, license = textured ? mr.license : 'CC0-1.0', author = textured ? mr.author : 'Hyprune contributors';
 const dims = s.shape === 'cube' ? `${fmt(s.size[0])} m` : `${s.size.map(fmt).join(' × ')} m`;
 const name = `${SHAPE_NAMES[s.shape]} ${dims}${mr.key !== INLINE ? ` (${mr.name})` : ''}`.slice(0, 64);
 const manifest: Record<string, unknown> = {
  formatVersion: '0.11', id, version: '1.0.0', name, description: `A generated ${s.shape}${s.steps ? ` with ${s.steps} steps` : ''}, ${dims}, in ${mr.name}.`.slice(0, 512),
  category: 'other', tags: ['primitive', s.shape], scene: 'object.glb', license,
  attribution: [{path: '.', author, license, ...(/^https:\/\//.test(mr.source) && textured ? {source: mr.source.slice(0, 2048)} : {})}],
  bounds: {min: [r4(-s.size[0] / 2), 0, r4(-s.size[2] / 2)], max: [r4(s.size[0] / 2), r4(s.size[1]), r4(s.size[2] / 2)]},
  thumbnail: 'thumbnail.png', lighting: {mode: 'probe'},
  traits: {collidable: {node: 'proxy'}, movable: {surfaces: ['floor', 'any'], upright: false, scale: [0.25, 4]}},
 };
 const record = {primitiveVersion: '0.1', shape: s.shape, size: s.size, ...(s.steps !== undefined ? {steps: s.steps} : {}),
  material: {key: mr.key === INLINE ? null : mr.key, name: mr.name, colour: mr.colour, textured, emissive: mr.emissive, digest: material.digest},
  generator: {name: GENERATOR, version}};
 const check = validateManifest('primitive', record);
 if (!check.valid) fail('primitive.invalid', check.errors.join('; '));
 return {id, manifest, record, glb, thumbnail};
}
export interface PrimitiveResult {id: string; ref: string; path: string; created: boolean; name: string; primitive: Record<string, unknown>; dryRun?: true}
/**
 * Writes a primitive's object directory into `root` (a world folder's objects/ or the user's
 * object folder) unless it is there already: the same shape, size and material is the same
 * directory. Checked with the object validator in a staging directory first.
 */
export async function writePrimitive(root: string, refSource: 'world' | 'user', spec: PrimitiveSpec, material: Material,
 o: {version?: string; dryRun?: boolean; validate?: (dir: string) => Promise<unknown>} = {}): Promise<PrimitiveResult> {
 const s = checkSpec(spec), id = primitiveId(s, material), target = join(root, id);
 const record = {shape: s.shape, size: s.size, ...(s.steps !== undefined ? {steps: s.steps} : {}), material: {key: material.record.key === INLINE ? null : material.record.key, name: material.record.name}};
 if (existsSync(join(target, 'object.json'))) {
  const name = JSON.parse(readFileSync(join(target, 'object.json'), 'utf8')).name;
  return {id, ref: `${refSource}/${id}`, path: target, created: false, name, primitive: record, ...(o.dryRun ? {dryRun: true as const} : {})};
 }
 const built = await buildPrimitive(s, material, o.version);
 if (o.dryRun) return {id, ref: `${refSource}/${id}`, path: target, created: true, name: built.manifest.name as string, primitive: record, dryRun: true};
 mkdirSync(root, {recursive: true});
 const stage = mkdtempSync(join(root, '.primitive-'));
 try {
  const dir = join(stage, id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'object.glb'), built.glb);
  writeFileSync(join(dir, 'thumbnail.png'), built.thumbnail);
  writeFileSync(join(dir, 'object.json'), JSON.stringify(built.manifest, null, 1) + '\n');
  writeFileSync(join(dir, 'primitive.json'), JSON.stringify(built.record, null, 1) + '\n');
  if (o.validate) await o.validate(dir);
  if (!existsSync(target)) renameSync(dir, target);
 } finally {rmSync(stage, {recursive: true, force: true});}
 return {id, ref: `${refSource}/${id}`, path: target, created: true, name: built.manifest.name as string, primitive: record};
}
/** The primitive.json of an object directory, or null. */
export function primitiveOf(dir: string): any {
 try {return JSON.parse(readFileSync(join(dir, 'primitive.json'), 'utf8'));} catch {return null;}
}
/** Primitives in `root` made with material `key` at another content than `material` now has: what a material change makes stale. */
export function stalePrimitives(root: string, key: string, material: Material): Array<{id: string; shape: Shape; size: V3; steps?: number}> {
 if (!existsSync(root)) return [];
 const out: Array<{id: string; shape: Shape; size: V3; steps?: number}> = [];
 for (const id of readdirSync(root).sort()) {
  const p = primitiveOf(join(root, id));
  if (p && p.material?.key === key && p.material.digest !== material.digest) out.push({id, shape: p.shape, size: p.size, ...(p.steps ? {steps: p.steps} : {})});
 }
 return out;
}

// RFC-0016 `look` on the CPU: a world folder rendered from a pose without Hyprune running (and
// without a GPU): the land, every placement at its pose and scale, base colours and textures,
// flat sun-and-sky shading, the panorama as the background. Enough to judge a layout; core's
// preview.render draws the real thing when Hyprune is running.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BASE,readProject,type Placement} from './builder.js';
import {decodeImage,encodePng,fitInside,type Rgba} from './pixels.js';
import {rotate} from './check.js';

type V3 = [number, number, number];
export interface Pose {position: number[]; yaw: number; pitch: number}
export type LookFrom = 'spawn' | 'overview' | string | {position: number[]; yaw?: number; pitch?: number; lookAt?: number[]};
export interface LookOptions {from?: LookFrom; fov?: number; size?: [number, number]; supersample?: number}
export interface Look {png: Buffer; width: number; height: number; pose: Pose; fov: number; renderer: 'cpu'; triangles: number; ms: number}

interface Tex {width: number; height: number; rgb: Float32Array; mean: V3}
interface Mesh {tris: number[][][]; uvs: Array<number[][] | null>; colour: V3[]; glow: V3[]; tex: Array<Tex | null>}
const srgbToLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c: number) => {c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;};
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l];};
const r3 = (v: number) => Math.round(v * 1e3) / 1e3 + 0;

function texture(img: Rgba, max = 512): Tex {
 const small = fitInside(img, max), rgb = new Float32Array(small.width * small.height * 3), mean: V3 = [0, 0, 0];
 for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) for (let c = 0; c < 3; c++) {const v = srgbToLinear(small.data[j + c] / 255); rgb[i + c] = v; mean[c] += v;}
 const n = small.width * small.height || 1;
 return {width: small.width, height: small.height, rgb, mean: [mean[0] / n, mean[1] / n, mean[2] / n]};
}
async function loadMesh(glb: string): Promise<Mesh> {
 const {libs, sceneTriangles} = await import('./import.js');
 const L = await libs(), doc = await L.io.read(glb);
 const {tris, mats, uvs} = sceneTriangles(L, doc), materials = doc.getRoot().listMaterials();
 const colour: V3[] = [], glow: V3[] = [], tex: Array<Tex | null> = [];
 for (const m of materials) {
  const f = m.getBaseColorFactor(), e = m.getEmissiveFactor(), t = m.getBaseColorTexture();
  let decoded: Tex | null = null;
  if (t?.getImage() && t.getMimeType() !== 'image/ktx2') try {decoded = texture(decodeImage(t.getImage()!, t.getMimeType()));} catch {/* colour only */}
  colour.push([f[0], f[1], f[2]]); glow.push([e[0], e[1], e[2]]); tex.push(decoded);
 }
 return {tris, uvs, colour: mats.map(i => i >= 0 ? colour[i] : [0.7, 0.7, 0.7] as V3), glow: mats.map(i => i >= 0 ? glow[i] : [0, 0, 0] as V3),
  tex: mats.map(i => i >= 0 ? tex[i] : null)};
}
const placed = (p: Placement, v: number[]): V3 => {const s = p.scale ?? 1, r = rotate(p.pose.rotation, [v[0] * s, v[1] * s, v[2] * s]); return [r[0] + p.pose.position[0], r[1] + p.pose.position[1], r[2] + p.pose.position[2]];};

/** The pose a `from` names: the spawn, an overview of the folder's bounds, a placement key (seen from its front), or explicit. */
export function lookPose(folder: string, from: LookFrom = 'spawn', bounds?: {min: V3; max: V3}): Pose {
 const base = JSON.parse(readFileSync(join(folder, BASE), 'utf8'));
 const facing = (eye: number[], target: number[]): Pose => {
  const d = norm(sub(target as V3, eye as V3));
  return {position: eye.map(r3), yaw: r3(Math.atan2(d[0], -d[2]) * 180 / Math.PI), pitch: r3(Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180 / Math.PI)};
 };
 if (typeof from === 'object') {
  if (!Array.isArray(from.position) || from.position.length !== 3 || from.position.some(v => !Number.isFinite(v))) throw new Error('from.position is [x, y, z] in metres');
  if (from.lookAt) return facing(from.position, from.lookAt);
  return {position: from.position, yaw: from.yaw ?? 0, pitch: from.pitch ?? 0};
 }
 if (from === 'spawn') {
  const s = base.spawns?.find((x: any) => x.id === base.defaultSpawn) ?? base.spawns?.[0];
  const p = s?.pose.position ?? [0, 0, 0], q = s?.pose.rotation ?? [0, 0, 0, 1];
  return {position: [p[0], p[1] + 1.7, p[2]], yaw: r3(-2 * Math.atan2(q[1], q[3]) * 180 / Math.PI), pitch: -4};
 }
 const project = readProject(folder);
 if (from === 'overview') {
  const b = bounds ?? {min: [-10, 0, -10] as V3, max: [10, 3, 10] as V3};
  const centre: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const r = Math.max(6, Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2);
  const d = r * 1.9, yaw = 35 * Math.PI / 180;
  // A three-quarter view from the spawn's side, looking down at about 32 degrees.
  return facing([centre[0] + Math.sin(yaw) * d * 0.85, centre[1] + d * 0.62, centre[2] + Math.cos(yaw) * d * 0.85], centre);
 }
 const p = project.placements.find(x => x.key === from || x.id === from);
 if (!p) throw Object.assign(new Error(`No placement with the key ${from}`), {code: 'look.unknown'});
 const objectDir = join(folder, 'objects', p.ref.slice('world/'.length)), o = JSON.parse(readFileSync(join(objectDir, 'object.json'), 'utf8'));
 const lo = o.bounds?.min ?? [-0.5, 0, -0.5], hi = o.bounds?.max ?? [0.5, 1, 0.5];
 const centre = placed(p, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
 const radius = Math.max(0.5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 * (p.scale ?? 1));
 const front = rotate(p.pose.rotation, [0, 0, 1]), flat = Math.hypot(front[0], front[2]) > 0.2 ? norm([front[0], 0, front[2]]) : [0, 0, 1] as V3;
 const dist = Math.max(2.5, radius * 2.6);
 return facing([centre[0] + flat[0] * dist, Math.max(centre[1] + radius * 0.6, 1.2), centre[2] + flat[2] * dist], centre);
}

/** Renders the folder (project placements, land and sky) from a pose into a PNG. */
export async function lookFolder(folder: string, o: LookOptions = {}): Promise<Look> {
 const started = Date.now();
 const [W, H] = o.size ?? [1024, 576];
 if (!(W >= 64 && W <= 1024 && H >= 64 && H <= 1024)) throw new Error('size: 64 to 1024 px');
 const ss = Math.max(1, Math.min(3, o.supersample ?? 2)), w = W * ss, h = H * ss, fov = Math.max(20, Math.min(120, o.fov ?? 70));
 const base = JSON.parse(readFileSync(join(folder, BASE), 'utf8')), project = readProject(folder);
 // The scene: the land (and any authored scene meshes) plus every placement.
 const meshes: Array<{mesh: Mesh; place?: Placement}> = [];
 if (base.scene && existsSync(join(folder, base.scene))) meshes.push({mesh: await loadMesh(join(folder, base.scene))});
 const cache = new Map<string, Mesh>();
 const bmin: V3 = [Infinity, Infinity, Infinity], bmax: V3 = [-Infinity, -Infinity, -Infinity];
 for (const p of project.placements) {
  const id = p.ref.slice('world/'.length), dir = join(folder, 'objects', id);
  if (!cache.has(id)) {
   try {const man = JSON.parse(readFileSync(join(dir, 'object.json'), 'utf8')); cache.set(id, await loadMesh(join(dir, man.scene ?? 'object.glb')));}
   catch {continue;}
  }
  meshes.push({mesh: cache.get(id)!, place: p});
  for (const t of cache.get(id)!.tris) for (const v of t) {const q = placed(p, v); for (let i = 0; i < 3; i++) {bmin[i] = Math.min(bmin[i], q[i]); bmax[i] = Math.max(bmax[i], q[i]);}}
 }
 const pose = lookPose(folder, o.from ?? 'spawn', Number.isFinite(bmin[0]) ? {min: bmin, max: bmax} : undefined);
 const yaw = pose.yaw * Math.PI / 180, pitch = pose.pitch * Math.PI / 180;
 const fwd: V3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
 const right = norm(cross(fwd, [0, 1, 0])), up = cross(right, fwd), eye = pose.position as V3;
 const f = 1 / Math.tan(fov * Math.PI / 360), aspect = w / h, near = 0.05;
 // The sun (towards it) and the sky for the background and the ambient light.
 const sun = norm((base.atmosphere?.sky?.sun?.direction ?? [0.3, 0.8, 0.4]) as V3);
 let sky: Tex | null = null;
 const skyFile = project.sky?.image ? join(folder, project.sky.image) : join(folder, 'sky/panorama.jpg');
 if (existsSync(skyFile)) try {sky = texture(decodeImage(readFileSync(skyFile)), 1024);} catch {/* gradient */}
 const skyAt = (d: V3): V3 => {
  if (!sky) {const t = Math.max(0, d[1]); return [0.35 + 0.2 * (1 - t), 0.5 + 0.15 * (1 - t), 0.75];}
  const u = 0.5 + Math.atan2(d[0], -d[2]) / (2 * Math.PI), v = Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI;
  const x = Math.min(sky.width - 1, Math.max(0, Math.floor(u * sky.width))), y = Math.min(sky.height - 1, Math.max(0, Math.floor(v * sky.height))), k = (y * sky.width + x) * 3;
  return [sky.rgb[k], sky.rgb[k + 1], sky.rgb[k + 2]];
 };
 const ambient: V3 = sky ? sky.mean.map(c => Math.min(0.6, c * 0.9 + 0.08)) as V3 : [0.35, 0.38, 0.42];
 const rgb = new Float32Array(w * h * 3), depth = new Float32Array(w * h).fill(Infinity);
 for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const sx = (2 * (x + 0.5) / w - 1) * aspect / f, sy = (1 - 2 * (y + 0.5) / h) / f;
  const c = skyAt(norm([fwd[0] + right[0] * sx + up[0] * sy, fwd[1] + right[1] * sx + up[1] * sy, fwd[2] + right[2] * sx + up[2] * sy]));
  rgb.set(c, (y * w + x) * 3);
 }
 let drawn = 0;
 // Camera space: x right, y up, z forward (depth).
 const toCam = (p: V3): V3 => {const d = sub(p, eye); return [dot(d, right), dot(d, up), dot(d, fwd)];};
 for (const {mesh, place} of meshes) {
  mesh.tris.forEach((t, k) => {
   const world = place ? t.map(v => placed(place, v)) : t as V3[];
   let n = cross(sub(world[1], world[0]), sub(world[2], world[0]));
   if (!Math.hypot(...n)) return;
   n = norm(n);
   const toEye = norm(sub(eye, world[0]));
   if (dot(n, toEye) < 0) n = [-n[0], -n[1], -n[2]]; // both sides lit, as in thumbnails
   const lit = Math.max(0, dot(n, sun)), shade: V3 = [ambient[0] + 0.85 * lit, ambient[1] + 0.82 * lit, ambient[2] + 0.75 * lit];
   const uv = mesh.uvs[k], tex = mesh.tex[k], colour = mesh.colour[k], glow = mesh.glow[k];
   // Clip against the near plane (the land's triangles reach behind the camera).
   let poly = world.map((p, i) => ({c: toCam(p), uv: uv ? uv[i] : [0, 0]}));
   const out: typeof poly = [];
   for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ain = a.c[2] >= near, bin = b.c[2] >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
     const s = (near - a.c[2]) / (b.c[2] - a.c[2]);
     out.push({c: [a.c[0] + s * (b.c[0] - a.c[0]), a.c[1] + s * (b.c[1] - a.c[1]), near], uv: [a.uv[0] + s * (b.uv[0] - a.uv[0]), a.uv[1] + s * (b.uv[1] - a.uv[1])]});
    }
   }
   if (out.length < 3) return;
   poly = out;
   drawn++;
   const scr = poly.map(p => ({x: (p.c[0] / p.c[2] * f / aspect * 0.5 + 0.5) * w, y: (0.5 - p.c[1] / p.c[2] * f * 0.5) * h, iz: 1 / p.c[2], u: p.uv[0] / p.c[2], v: p.uv[1] / p.c[2]}));
   for (let j = 1; j + 1 < scr.length; j++) {
    const A = scr[0], B = scr[j], C = scr[j + 1];
    const d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x))), x1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y))), y1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
     const gx = x + 0.5, gy = y + 0.5;
     const a = ((B.y - C.y) * (gx - C.x) + (C.x - B.x) * (gy - C.y)) / d, b = ((C.y - A.y) * (gx - C.x) + (A.x - C.x) * (gy - C.y)) / d, c = 1 - a - b;
     if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
     const iz = a * A.iz + b * B.iz + c * C.iz, z = 1 / iz, i = y * w + x;
     if (z >= depth[i]) continue;
     depth[i] = z;
     let base: V3 = colour;
     if (tex && uv) {
      const u = (a * A.u + b * B.u + c * C.u) * z, v = (a * A.v + b * B.v + c * C.v) * z;
      const tx = ((Math.floor(u * tex.width) % tex.width) + tex.width) % tex.width, ty = ((Math.floor(v * tex.height) % tex.height) + tex.height) % tex.height, o2 = (ty * tex.width + tx) * 3;
      // Far texels fade to the texture's mean colour (a cheap stand-in for mipmaps).
      const fade = Math.min(1, Math.max(0, (z - 12) / 50));
      base = [0, 1, 2].map(q => (tex.rgb[o2 + q] * (1 - fade) + tex.mean[q] * fade) * colour[q]) as V3;
     }
     rgb[i * 3] = base[0] * shade[0] + glow[0]; rgb[i * 3 + 1] = base[1] * shade[1] + glow[1]; rgb[i * 3 + 2] = base[2] * shade[2] + glow[2];
    }
   }
  });
 }
 const png = new Uint8Array(W * H * 4);
 for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let r = 0, g = 0, b = 0;
  for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {const k = ((y * ss + j) * w + x * ss + i) * 3; r += rgb[k]; g += rgb[k + 1]; b += rgb[k + 2];}
  const o2 = (y * W + x) * 4, n2 = ss * ss;
  png[o2] = Math.round(linearToSrgb(r / n2) * 255); png[o2 + 1] = Math.round(linearToSrgb(g / n2) * 255); png[o2 + 2] = Math.round(linearToSrgb(b / n2) * 255); png[o2 + 3] = 255;
 }
 return {png: Buffer.from(encodePng({width: W, height: H, data: png})), width: W, height: H, pose, fov, renderer: 'cpu', triangles: drawn, ms: Date.now() - started};
}

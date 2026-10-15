// Built-in skies and floors for the Open Plain starter and the world wizard (RFC-0014 amendment:
// the world wizard). Generated in JavaScript rather than shipped, like the Flat land starter:
// procedural equirectangular skies with their atmosphere, and tileable floor textures. All
// original and CC0-1.0.
import {encodeJpeg,encodePng,fitInside,type Rgba} from './pixels.js';
import {equirectDirection,gridTexture} from './starter.js';

type V3 = [number, number, number];
const norm = (v: number[]): V3 => {const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l];};
const smooth = (a: number, b: number, x: number) => {const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t);};
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const srgb = (linear: number) => Math.round(255 * Math.min(1, Math.max(0, linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055)));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
/** A direction from an azimuth (degrees clockwise from -Z, so 90 is +X) and an elevation in degrees. */
export function direction(azimuth: number, elevation: number): V3 {
 const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
 return norm([Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)]);
}

// ---- noise (seeded; `period` makes it tile) ----
function hash(x: number, y: number, seed = 0): number {
 let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
 h = Math.imul(h ^ (h >>> 13), 1274126177);
 return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const wrap = (v: number, p: number) => p ? ((v % p) + p) % p : v;
function noise(x: number, y: number, period = 0, seed = 0, periodY = period): number {
 const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
 const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
 const h = (i: number, j: number) => hash(wrap(i, period), wrap(j, periodY), seed);
 const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
 return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** Fractal noise in 0..1; with a period (in lattice cells at the first octave) it tiles. */
function fbm(x: number, y: number, octaves = 5, period = 0, seed = 0, periodY = period): number {
 let v = 0, a = 0.5, total = 0;
 for (let i = 0; i < octaves; i++) {v += a * noise(x, y, period, seed + i, periodY); total += a; x *= 2; y *= 2; period *= 2; periodY *= 2; a *= 0.5;}
 return v / total;
}

// ---- skies ----
export interface SkyPreset {
 id: string; name: string; description: string;
 zenith: V3; horizon: V3; ground: V3;
 sun: {direction: V3; color: V3; intensity: number; disc: number; glow: number; halo: number};
 /** A warm band along the horizon towards the sun (sunsets), its colour and strength. */
 horizonGlow?: {color: V3; strength: number};
 clouds: {cover: number; color: V3; shade: V3; scale: number; base?: number};
 stars?: number;
 exposure: number; fog: {color: V3; density: number};
}
export const SKY_PRESETS: readonly SkyPreset[] = Object.freeze([
 {id: 'clear-day', name: 'Clear day', description: 'A soft blue sky with a few clouds and a high sun.',
  zenith: [0.22, 0.38, 0.66], horizon: [0.72, 0.8, 0.86], ground: [0.33, 0.36, 0.33],
  sun: {direction: norm([0.55, 0.62, 0.56]), color: [1, 0.95, 0.86], intensity: 3, disc: 6, glow: 0.25, halo: 64},
  clouds: {cover: 0.8, color: [0.93, 0.94, 0.96], shade: [0.7, 0.74, 0.8], scale: 1.6},
  exposure: 1, fog: {color: [0.72, 0.8, 0.86], density: 0.0012}},
 {id: 'sunset', name: 'Sunset', description: 'A low golden sun, a warm horizon and pink clouds.',
  zenith: [0.09, 0.13, 0.32], horizon: [0.95, 0.5, 0.26], ground: [0.16, 0.12, 0.11],
  sun: {direction: direction(250, 5), color: [1, 0.62, 0.34], intensity: 2.4, disc: 9, glow: 0.9, halo: 18},
  horizonGlow: {color: [1, 0.42, 0.16], strength: 0.9},
  clouds: {cover: 0.55, color: [1, 0.6, 0.36], shade: [0.3, 0.2, 0.3], scale: 1.2, base: 0.1},
  exposure: 1.1, fog: {color: [0.78, 0.5, 0.36], density: 0.0016}},
 {id: 'overcast', name: 'Overcast', description: 'A calm grey sky with soft light and no shadows to speak of.',
  zenith: [0.5, 0.53, 0.58], horizon: [0.7, 0.72, 0.74], ground: [0.3, 0.31, 0.3],
  sun: {direction: direction(140, 48), color: [0.92, 0.94, 1], intensity: 0.9, disc: 0, glow: 0.05, halo: 6},
  clouds: {cover: 1, color: [0.78, 0.8, 0.83], shade: [0.48, 0.5, 0.54], scale: 0.9},
  exposure: 1.15, fog: {color: [0.66, 0.68, 0.7], density: 0.0024}},
 {id: 'night', name: 'Starry night', description: 'A clear night with stars and a bright moon.',
  zenith: [0.004, 0.007, 0.022], horizon: [0.03, 0.045, 0.08], ground: [0.012, 0.014, 0.018],
  sun: {direction: direction(35, 38), color: [0.62, 0.72, 1], intensity: 0.45, disc: 3, glow: 0.04, halo: 40},
  clouds: {cover: 0.25, color: [0.05, 0.06, 0.09], shade: [0.02, 0.025, 0.04], scale: 1.4},
  stars: 1, exposure: 1.6, fog: {color: [0.03, 0.045, 0.08], density: 0.001}},
] as SkyPreset[]);
export const skyPreset = (id: string) => SKY_PRESETS.find(p => p.id === id);

function starAt(d: V3): number {
 // Stars on a fixed angular grid (about 0.35 degrees), one candidate per cell.
 const az = Math.atan2(d[0], -d[2]), el = Math.asin(Math.max(-1, Math.min(1, d[1])));
 const cell = 0.006, cx = Math.floor(az / cell), cy = Math.floor(el / cell), h = hash(cx, cy, 77);
 if (h > 0.035) return 0;
 const sx = (cx + hash(cx, cy, 78)) * cell, sy = (cy + hash(cx, cy, 79)) * cell;
 const dist = Math.hypot((az - sx) * Math.cos(el), el - sy);
 return (0.3 + 3 * Math.pow(hash(cx, cy, 80), 6)) * Math.exp(-(dist * dist) / (2 * 0.0011 * 0.0011));
}
/** A preset's equirectangular panorama (2:1). */
export function skyPanorama(p: SkyPreset, width = 2048): Rgba {
 const height = width / 2, data = new Uint8Array(width * height * 4), s = p.sun.direction;
 const sunFlat = Math.hypot(s[0], s[2]) || 1;
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const d = equirectDirection((x + 0.5) / width, (y + 0.5) / height);
  const cos = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
  let c: number[];
  if (d[1] >= 0) {
   c = mix(p.horizon, p.zenith, Math.pow(d[1], 0.55));
   if (p.horizonGlow) {
    const flat = Math.hypot(d[0], d[2]) || 1, toward = Math.max(0, (d[0] * s[0] + d[2] * s[2]) / (flat * sunFlat));
    c = mix(c, p.horizonGlow.color, p.horizonGlow.strength * Math.pow(toward, 3) * (1 - smooth(0, 0.35, d[1])));
   }
   if (p.stars) c = c.map(v => v + p.stars! * starAt(d) * 0.6 * smooth(0.02, 0.2, d[1]));
   // Clouds on a plane above the viewer, thinning towards the horizon; lit towards the sun.
   const k = 1 / Math.max(d[1], 0.04), n = fbm(d[0] * k * p.clouds.scale + 7.3, d[2] * k * p.clouds.scale - 2.1);
   const threshold = 0.62 - 0.22 * p.clouds.cover;
   const cover = smooth(threshold - 0.1, threshold + 0.1, n) * smooth(0.02, 0.18, d[1]) * Math.min(1, 0.4 + 0.6 * p.clouds.cover);
   const base = p.clouds.base ?? 0.5, towards = Math.pow(Math.max(0, cos), base < 0.5 ? 2 : 1);
   const lit = mix(p.clouds.shade, p.clouds.color, base + (1 - base) * towards * (1 - 0.6 * (n - threshold)));
   c = mix(c, lit, cover);
  } else c = mix(p.horizon, p.ground, smooth(0, 0.08, -d[1]));
  // The disc (about 1 degree across) with a soft edge, so it doesn't alias.
  const glow = p.sun.glow * Math.pow(Math.max(cos, 0), p.sun.halo) + p.sun.disc * smooth(0.99982, 0.99988, cos);
  const o = (y * width + x) * 4, sc = p.sun.color;
  data[o] = srgb(c[0] + glow * sc[0]); data[o + 1] = srgb(c[1] + glow * sc[1]); data[o + 2] = srgb(c[2] + glow * sc[2]); data[o + 3] = 255;
 }
 return {width, height, data};
}
/** The world format 0.11 atmosphere of a preset sky (or the user's image with a sun). */
export function skyAtmosphere(p: SkyPreset, image: string, sun: V3 = p.sun.direction): Record<string, unknown> {
 return {
  fog: {color: p.fog.color, density: p.fog.density, heightFalloff: 0, baseHeight: 0, excludeUnlit: true},
  sky: {zenith: p.zenith, horizon: p.horizon, ground: p.ground,
        sun: {direction: sun.map(r4), color: p.sun.color, intensity: p.sun.intensity, angularRadius: 0.0093}},
  exposure: p.exposure, toneMapping: 'aces', bloom: {strength: 0.06, threshold: 1.2, radius: 3},
  panorama: {image, projection: 'equirect', encoding: 'srgb', intensity: 1, rotation: 0, maxResolution: 1024, environment: true},
 };
}

// ---- floors ----
export interface FloorPreset {id: string; name: string; description: string; tile: number; roughness: number; texture: (size: number) => Rgba; format: 'png' | 'jpeg'}
function paint(size: number, f: (u: number, v: number) => number[]): Rgba {
 const data = new Uint8Array(size * size * 4);
 for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const c = f((x + 0.5) / size, (y + 0.5) / size), o = (y * size + x) * 4;
  data[o] = srgb(c[0]); data[o + 1] = srgb(c[1]); data[o + 2] = srgb(c[2]); data[o + 3] = 255;
 }
 return {width: size, height: size, data};
}
function grass(size: number): Rgba {
 return paint(size, (u, v) => {
  const broad = fbm(u * 3, v * 3, 4, 3, 11), patch = smooth(0.42, 0.75, fbm(u * 4, v * 4, 4, 4, 12));
  const blades = fbm(u * 160, v * 160, 2, 160, 13), fine = noise(u * 384, v * 384, 384, 14);
  let c = mix([0.03, 0.08, 0.018], [0.08, 0.16, 0.035], broad);
  c = mix(c, [0.13, 0.15, 0.05], patch * 0.3);
  return c.map(x => x * (0.68 + 0.5 * blades + 0.16 * fine));
 });
}
function sand(size: number): Rgba {
 return paint(size, (u, v) => {
  const warp = fbm(u * 3, v * 3, 3, 3, 21), ripple = 0.5 + 0.5 * Math.sin((v * 14 + warp * 2.2) * 2 * Math.PI);
  const grain = noise(u * 384, v * 384, 384, 22), tone = fbm(u * 2, v * 2, 3, 2, 23);
  const c = mix([0.5, 0.38, 0.22], [0.66, 0.53, 0.33], tone);
  return c.map(x => x * (0.86 + 0.12 * ripple + 0.12 * grain));
 });
}
function paving(size: number): Rgba {
 // 8 x 8 stones per tile in running bond: each row of stones is shifted half a stone.
 const rows = 8;
 return paint(size, (u, v) => {
  const row = Math.floor(v * rows), shift = row % 2 ? 0.5 : 0, cu = u * rows + shift, col = Math.floor(cu) % rows;
  const fu = cu - Math.floor(cu), fv = v * rows - row, edge = Math.min(fu, 1 - fu, fv, 1 - fv);
  const grout = 1 - smooth(0.025, 0.05, edge), tint = hash(col, row, 31), wear = fbm(u * 16, v * 16, 4, 16, 32);
  // Each stone its own shade, slightly darker towards its bevelled edges.
  const bevel = 0.82 + 0.18 * smooth(0.05, 0.16, edge), warm = hash(col, row, 34) * 0.04;
  const stone = mix([0.2, 0.19, 0.17], [0.46, 0.43, 0.38], 0.6 * tint + 0.4 * wear)
   .map((x, i) => (x + (i === 0 ? warm : 0)) * bevel * (0.9 + 0.18 * noise(u * 320, v * 320, 320, 33)));
  return mix(stone, [0.08, 0.08, 0.075], grout);
 });
}
function concrete(size: number): Rgba {
 // Four 2 m slabs per 8 m tile with thin joints, mottled, with fine speckles.
 return paint(size, (u, v) => {
  const fu = (u * 4) % 1, fv = (v * 4) % 1, joint = 1 - smooth(0.003, 0.008, Math.min(fu, 1 - fu, fv, 1 - fv));
  const mottle = fbm(u * 6, v * 6, 5, 6, 41), speck = noise(u * 512, v * 512, 512, 42);
  const c = mix([0.3, 0.3, 0.29], [0.44, 0.44, 0.42], mottle).map(x => x * (0.94 + 0.1 * speck));
  return mix(c, [0.16, 0.16, 0.155], joint * 0.8);
 });
}
export const FLOOR_PRESETS: readonly FloorPreset[] = Object.freeze([
 {id: 'grid', name: 'Grid', description: 'Grey-green with 1 m lines and 10 m squares: easy to judge sizes on.', tile: 10, roughness: 0.95, texture: gridTexture, format: 'png'},
 {id: 'grass', name: 'Grass', description: 'A meadow with light and dark patches.', tile: 4, roughness: 0.95, texture: grass, format: 'jpeg'},
 {id: 'sand', name: 'Sand', description: 'Warm sand with soft ripples.', tile: 6, roughness: 0.9, texture: sand, format: 'jpeg'},
 {id: 'paving', name: 'Stone paving', description: 'Half-metre stones in rows, with dark joints.', tile: 4, roughness: 0.85, texture: paving, format: 'jpeg'},
 {id: 'concrete', name: 'Concrete', description: 'Smooth grey slabs, 2 m square.', tile: 8, roughness: 0.8, texture: concrete, format: 'jpeg'},
] as FloorPreset[]);
export const floorPreset = (id: string) => FLOOR_PRESETS.find(p => p.id === id);
export const encodeFloor = (p: FloorPreset, size = 1024) => p.format === 'png' ? encodePng(p.texture(size)) : encodeJpeg(p.texture(size), 90);

/** Thumbnails for the wizard: a sky at 256 x 128, a floor's tile at 128 x 128 (PNG bytes). */
export const skyThumbnail = (p: SkyPreset) => encodePng(skyPanorama(p, 256));
export const floorThumbnail = (p: FloorPreset) => encodePng(fitInside(p.texture(512), 128));

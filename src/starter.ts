// The Flat land starter (RFC-0014 "Starters", flat-land@0.1), generated rather than shipped:
// a 2,000 x 2,000 m plain at y = 0 with a soft grid texture (1 m minor, 10 m major lines) that is
// also its collision, and a procedural equirectangular sky with its sun. Everything here is
// original and CC0-1.0. Pure JavaScript: no Blender, no native image code.
import {encodeJpeg,encodePng,type Rgba} from './pixels.js';

export const LAND_HALF = 1000;
/** The direction towards the sun, shared by the panorama and atmosphere.sky.sun. */
export const SUN: [number, number, number] = norm([0.55, 0.62, 0.56]);
const ZENITH = [0.22, 0.38, 0.66], HORIZON = [0.72, 0.8, 0.86], GROUND = [0.33, 0.36, 0.33];

function norm(v: number[]): [number, number, number] {
 const l = Math.hypot(v[0], v[1], v[2]);
 return [v[0] / l, v[1] / l, v[2] / l];
}
const smooth = (a: number, b: number, x: number) => {const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t);};
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const srgb = (linear: number) => Math.round(255 * Math.min(1, Math.max(0, linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055)));

/** One 10 m tile of the land: grey-green with 1 m lines and a stronger 10 m line on its edge. */
export function gridTexture(size = 1024): Rgba {
 const data = new Uint8Array(size * size * 4), metres = 10 / size;
 const line = (p: number) => {
  const u = (p + 0.5) * metres, minor = Math.abs(u - Math.round(u)), major = Math.min(u, 10 - u);
  return Math.max(0.35 * (1 - smooth(0.012, 0.03, minor)), 1 - smooth(0.03, 0.06, major));
 };
 const across = Array.from({length: size}, (_, i) => line(i));
 for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const l = Math.max(across[x], across[y]), o = (y * size + x) * 4;
  data[o] = 110 + 70 * l; data[o + 1] = 118 + 66 * l; data[o + 2] = 108 + 64 * l; data[o + 3] = 255;
 }
 return {width: size, height: size, data};
}

// Value noise for the clouds (seeded, so every starter is identical).
function hash(x: number, y: number): number {
 let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
 h = Math.imul(h ^ (h >>> 13), 1274126177);
 return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number): number {
 const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
 const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
 const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
 return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x: number, y: number) => {let v = 0, a = 0.5; for (let i = 0; i < 5; i++) {v += a * noise(x, y); x *= 2.03; y *= 2.03; a *= 0.5;} return v;};

/**
 * A direction for an equirectangular texel (RFC-0014 amendment, world format 0.11): the image
 * centre looks along -Z, u grows towards +X (to the right when facing -Z), v = 0 is straight up.
 */
export function equirectDirection(u: number, v: number): [number, number, number] {
 const azimuth = (u - 0.5) * 2 * Math.PI, elevation = (0.5 - v) * Math.PI;
 return [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)];
}

/** The default sky: a soft blue gradient, a few clouds, the sun and a muted ground below. */
export function panorama(width = 2048): Rgba {
 const height = width / 2, data = new Uint8Array(width * height * 4);
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const d = equirectDirection((x + 0.5) / width, (y + 0.5) / height);
  let c: number[];
  if (d[1] >= 0) {
   c = mix(HORIZON, ZENITH, Math.pow(d[1], 0.55));
   // Clouds on a plane above the viewer, thinning towards the horizon.
   const k = 1 / Math.max(d[1], 0.04), n = fbm(d[0] * k * 1.6 + 7.3, d[2] * k * 1.6 - 2.1);
   const cover = smooth(0.52, 0.72, n) * smooth(0.02, 0.18, d[1]) * 0.8;
   c = mix(c, [0.93, 0.94, 0.96], cover);
  } else c = mix(HORIZON, GROUND, smooth(0, 0.08, -d[1]));
  const cos = d[0] * SUN[0] + d[1] * SUN[1] + d[2] * SUN[2];
  const glow = 0.25 * Math.pow(Math.max(cos, 0), 64) + (cos > 0.99985 ? 6 : 0);
  const o = (y * width + x) * 4;
  data[o] = srgb(c[0] + glow); data[o + 1] = srgb(c[1] + glow * 0.95); data[o + 2] = srgb(c[2] + glow * 0.85); data[o + 3] = 255;
 }
 return {width, height, data};
}
export const panoramaJpeg = () => encodeJpeg(panorama(), 88);

/** The atmosphere of a Flat land world (world format 0.11), with its panorama. */
export function starterAtmosphere(image = 'sky/panorama.jpg'): Record<string, unknown> {
 return {
  fog: {color: HORIZON, density: 0.0012, heightFalloff: 0, baseHeight: 0, excludeUnlit: true},
  sky: {zenith: ZENITH, horizon: HORIZON, ground: GROUND, sun: {direction: SUN.map(v => Math.round(v * 1e4) / 1e4), color: [1, 0.95, 0.86], intensity: 3, angularRadius: 0.0093}},
  exposure: 1, toneMapping: 'aces', bloom: {strength: 0.06, threshold: 1.2, radius: 3},
  panorama: {image, projection: 'equirect', encoding: 'srgb', intensity: 1, rotation: 0, maxResolution: 1024, environment: true},
 };
}

/** The land as a GLB: node 0 is two triangles with the grid texture, tiled every 10 m. */
export async function landGlb(): Promise<Uint8Array> {
 const core = await import('@gltf-transform/core');
 const doc = new core.Document(), buffer = doc.createBuffer();
 const h = LAND_HALF, tile = 10;
 const corners = [[-h, -h], [h, -h], [h, h], [-h, h]];
 const position = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(corners.flatMap(([x, z]) => [x, 0, z])));
 const normal = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(corners.flatMap(() => [0, 1, 0])));
 const uv = doc.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array(corners.flatMap(([x, z]) => [x / tile, z / tile])));
 const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 3, 2, 0, 2, 1]));
 const texture = doc.createTexture('land-grid').setMimeType('image/png').setImage(encodePng(gridTexture()));
 const material = doc.createMaterial('land').setBaseColorTexture(texture).setRoughnessFactor(0.95).setMetallicFactor(0);
 material.getBaseColorTextureInfo()!.setMinFilter(9987).setMagFilter(9729).setWrapS(10497).setWrapT(10497);
 const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setAttribute('TEXCOORD_0', uv)
  .setIndices(indices).setMaterial(material);
 const node = doc.createNode('land').setMesh(doc.createMesh('land').addPrimitive(prim));
 doc.createScene('flat-land').addChild(node);
 doc.getRoot().getAsset().generator = 'hyprune builder (Flat land starter)';
 return new core.NodeIO().writeBinary(doc);
}

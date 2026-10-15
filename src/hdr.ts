// High dynamic range sky images for the builder (RFC-0014 "Sky: panorama"): OpenEXR (parse-exr)
// and Radiance HDR (.hdr, RGBE) decoded to linear RGB, the sun found in the linear data, and
// tone mapping to sRGB, since world format 0.11 has no HDR images. Pure JavaScript.
import parseExr from 'parse-exr';
import {equirectDirection} from './starter.js';
import type {Rgba} from './pixels.js';

/** Linear RGB, row 0 at the top. */
export interface Hdr {width: number; height: number; data: Float32Array}
export const HDR_PIXEL_LIMIT = 8192 * 4096;

export function hdrKind(bytes: Uint8Array): 'exr' | 'hdr' | '' {
 if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return 'exr';
 const head = new TextDecoder('latin1').decode(bytes.subarray(0, 10));
 if (head.startsWith('#?RADIANCE') || head.startsWith('#?RGBE')) return 'hdr';
 return '';
}

/**
 * Reads an OpenEXR header with bounds checks before parse-exr sees the file (it does not check
 * them, and loops on some truncated files): single-part scanline images only, a sane data window,
 * RGB(A) or Y channels, and an offset table inside the file.
 */
function checkExrHeader(bytes: Uint8Array): void {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bad = (why: string): never => {throw new Error(`not a supported OpenEXR file (${why})`);};
 if (bytes.length < 8) bad('truncated');
 const flags = view.getUint32(4, true);
 if ((flags & 0xff) !== 2 || flags & 0x1a00) bad('only single-part scanline images');
 let p = 8;
 const text = () => {const start = p; while (p < bytes.length && bytes[p] !== 0 && p - start < 256) p++; if (p >= bytes.length || bytes[p] !== 0) bad('truncated header'); return new TextDecoder('latin1').decode(bytes.subarray(start, p++));};
 const attrs = new Map<string, [number, number]>();
 for (let n = 0; ; n++) {
  if (n > 256) bad('too many header attributes');
  const name = text();
  if (!name) break;
  text();
  if (p + 4 > bytes.length) bad('truncated header');
  const size = view.getInt32(p, true); p += 4;
  if (size < 0 || p + size > bytes.length) bad('truncated header');
  attrs.set(name, [p, size]); p += size;
 }
 for (const k of ['channels', 'compression', 'dataWindow']) if (!attrs.has(k)) bad(`no ${k}`);
 const [dw, dws] = attrs.get('dataWindow')!;
 if (dws !== 16) bad('dataWindow');
 const width = view.getInt32(dw + 8, true) - view.getInt32(dw, true) + 1, height = view.getInt32(dw + 12, true) - view.getInt32(dw + 4, true) + 1;
 if (width < 1 || height < 1 || width * height > HDR_PIXEL_LIMIT) bad(`${width} x ${height}`);
 const [cp] = attrs.get('compression')!;
 const lines = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256][bytes[cp]];
 if (!lines) bad(`compression ${bytes[cp]}`);
 const table = Math.ceil(height / lines) * 8;
 if (p + table > bytes.length) bad('truncated offset table');
 for (let i = 0; i < table; i += 8) {const off = Number(view.getBigUint64(p + i, true)); if (off < p + table || off >= bytes.length) bad('offset outside the file');}
}
function decodeExr(bytes: Uint8Array): Hdr {
 checkExrHeader(bytes);
 const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
 const exr = parseExr(ab, 1015);
 const {width, height} = exr;
 if (width * height > HDR_PIXEL_LIMIT) throw new Error(`the image is ${width} x ${height}: too large`);
 const src = exr.data as Float32Array, channels = exr.format === 1028 ? 1 : 4, out = new Float32Array(width * height * 3);
 // parse-exr (like three.js) returns rows bottom-up, for textures with flipY off.
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = ((height - 1 - y) * width + x) * channels, o = (y * width + x) * 3;
  for (let c = 0; c < 3; c++) {const v = src[i + (channels === 1 ? 0 : c)]; out[o + c] = Number.isFinite(v) && v > 0 ? v : 0;}
 }
 return {width, height, data: out};
}

function decodeRadiance(bytes: Uint8Array): Hdr {
 let p = 0;
 const line = () => {let s = ''; while (p < bytes.length && bytes[p] !== 0x0a) s += String.fromCharCode(bytes[p++]); p++; return s;};
 let format = '';
 for (let l = line(); l !== ''; l = line()) {
  if (p >= bytes.length) throw new Error('a truncated Radiance header');
  if (l.startsWith('FORMAT=')) format = l.slice(7).trim();
 }
 if (format && format !== '32-bit_rle_rgbe') throw new Error(`Radiance format ${format} is not supported (32-bit_rle_rgbe only)`);
 const m = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
 if (!m) throw new Error('only top-down Radiance images (-Y H +X W) are supported');
 const height = Number(m[1]), width = Number(m[2]);
 if (!width || !height || width * height > HDR_PIXEL_LIMIT) throw new Error(`the image is ${width} x ${height}: unsupported size`);
 const out = new Float32Array(width * height * 3), scan = new Uint8Array(width * 4);
 const need = (n: number) => {if (p + n > bytes.length) throw new Error('a truncated Radiance image');};
 for (let y = 0; y < height; y++) {
  need(4);
  if (width >= 8 && width < 32768 && bytes[p] === 2 && bytes[p + 1] === 2 && ((bytes[p + 2] << 8) | bytes[p + 3]) === width) {
   p += 4;
   for (let c = 0; c < 4; c++) for (let x = 0; x < width;) {
    need(1);
    let n = bytes[p++];
    if (n > 128) {n -= 128; need(1); if (x + n > width) throw new Error('a corrupt Radiance run'); const v = bytes[p++]; for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v;}
    else {if (!n || x + n > width) throw new Error('a corrupt Radiance run'); need(n); for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = bytes[p++];}
   }
  } else {need(width * 4); scan.set(bytes.subarray(p, p + width * 4)); p += width * 4;}
  for (let x = 0; x < width; x++) {
   const e = scan[x * 4 + 3], f = e ? Math.pow(2, e - 136) : 0, o = (y * width + x) * 3;
   out[o] = scan[x * 4] * f; out[o + 1] = scan[x * 4 + 1] * f; out[o + 2] = scan[x * 4 + 2] * f;
  }
 }
 return {width, height, data: out};
}

/** Linear RGB pixels of an OpenEXR or Radiance HDR image. */
export function decodeHdr(bytes: Uint8Array): Hdr {
 const kind = hdrKind(bytes);
 if (kind === 'exr') return decodeExr(bytes);
 if (kind === 'hdr') return decodeRadiance(bytes);
 throw new Error('not an OpenEXR or Radiance HDR image');
}

const lum = (d: Float32Array, i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
/**
 * The sun of a linear panorama: the centroid of the brightest 0.1 % above the horizon, when it is
 * clearly brighter than the sky (at least 20 times the median above the horizon); else null.
 */
export function hdrSun(img: Hdr): [number, number, number] | null {
 const step = Math.max(1, Math.floor(img.width / 1024)), samples: Array<[number, number, number]> = [];
 for (let y = 0; y < img.height / 2; y += step) for (let x = 0; x < img.width; x += step) samples.push([lum(img.data, (y * img.width + x) * 3), x, y]);
 if (!samples.length) return null;
 samples.sort((a, b) => b[0] - a[0]);
 const median = samples[samples.length >> 1][0];
 if (!(samples[0][0] > 20 * Math.max(median, 1e-6))) return null;
 // The brightest 0.1 %, keeping only texels near the peak (a small sun leaves sky in that share).
 const top = samples.slice(0, Math.max(4, Math.round(samples.length * 0.001))).filter(([l]) => l >= samples[0][0] * 0.25), sum = [0, 0, 0];
 for (const [, x, y] of top) {const d = equirectDirection((x + 0.5) / img.width, (y + 0.5) / img.height); for (let k = 0; k < 3; k++) sum[k] += d[k];}
 const l = Math.hypot(...sum);
 return l ? [sum[0] / l, sum[1] / l, sum[2] / l] : null;
}

/**
 * Tone maps a linear panorama to sRGB: exposure from the log-average luminance (key 0.18),
 * then the ACES fit (Narkowicz 2015) and the sRGB transfer function.
 */
export function toneMap(img: Hdr): Rgba {
 const n = img.width * img.height, step = Math.max(1, Math.floor(n / 1_000_000));
 let sum = 0, count = 0;
 for (let i = 0; i < n; i += step) {sum += Math.log(1e-4 + lum(img.data, i * 3)); count++;}
 const exposure = 0.18 / Math.exp(sum / count);
 const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
 const srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
 const out = new Uint8Array(n * 4);
 for (let i = 0; i < n; i++) {
  for (let c = 0; c < 3; c++) out[i * 4 + c] = srgb(aces(img.data[i * 3 + c] * exposure));
  out[i * 4 + 3] = 255;
 }
 return {width: img.width, height: img.height, data: out};
}

// Images for `hyprune object import` without native code: PNG (pngjs) and JPEG (jpeg-js)
// decoding and encoding in JavaScript, and an area-average downscale. Replaces sharp, which
// would need a native libvips build on every platform (NixOS among them).
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {PNG} = require('pngjs') as {PNG: {sync: {read(b: Buffer): {width: number; height: number; data: Buffer}; write(png: {width: number; height: number; data: Buffer}, o?: unknown): Buffer}}};
const jpeg = require('jpeg-js') as {decode(b: Uint8Array, o: unknown): {width: number; height: number; data: Uint8Array}; encode(img: {width: number; height: number; data: Uint8Array}, quality: number): {data: Buffer}};

export interface Rgba {width: number; height: number; data: Uint8Array}
export const IMAGE_PIXEL_LIMIT = 16384 * 16384;

export function imageMime(bytes: Uint8Array): string {
 if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
 if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
 return '';
}
/** RGBA8 pixels of a PNG or JPEG (other formats throw). */
export function decodeImage(bytes: Uint8Array, mime = imageMime(bytes)): Rgba {
 if (mime === 'image/png') {
  const png = PNG.sync.read(Buffer.from(bytes));
  return {width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)};
 }
 if (mime === 'image/jpeg') {
  const img = jpeg.decode(bytes, {useTArray: true, formatAsRGBA: true, maxResolutionInMP: IMAGE_PIXEL_LIMIT / 1e6, maxMemoryUsageInMB: 2048});
  return {width: img.width, height: img.height, data: img.data};
 }
 throw new Error(`can't decode ${mime || 'this image'} without native code (PNG and JPEG only)`);
}
export function encodePng(img: Rgba): Uint8Array {
 return new Uint8Array(PNG.sync.write({width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)}, {deflateLevel: 9}));
}
export function encodeJpeg(img: Rgba, quality = 90): Uint8Array {
 return new Uint8Array(jpeg.encode({width: img.width, height: img.height, data: img.data}, quality).data);
}
/** Downscale to fit inside max x max (aspect kept) by averaging each output pixel's source area. */
export function fitInside(img: Rgba, max: number): Rgba {
 const scale = Math.min(1, max / Math.max(img.width, img.height));
 if (scale >= 1) return img;
 const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
 const out = new Uint8Array(w * h * 4), sx = img.width / w, sy = img.height / h;
 for (let y = 0; y < h; y++) {
  const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
  for (let x = 0; x < w; x++) {
   const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
   const sum = [0, 0, 0, 0];
   for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const i = (yy * img.width + xx) * 4;
    for (let c = 0; c < 4; c++) sum[c] += img.data[i + c];
   }
   const n = (y1 - y0) * (x1 - x0), o = (y * w + x) * 4;
   for (let c = 0; c < 4; c++) out[o + c] = Math.round(sum[c] / n);
  }
 }
 return {width: w, height: h, data: out};
}

// A pure-JavaScript `ndarray-pixels` (getPixels/savePixels for PNG and JPEG) that
// `hyprune object import` maps glTF-Transform's import of ndarray-pixels to (pixels-hooks.ts),
// so its texture functions never load sharp's native code.
import {createRequire} from 'node:module';
import {decodeImage,encodePng,encodeJpeg} from './pixels.js';
const require = createRequire(import.meta.url);
const ndarray = require('ndarray') as (data: Uint8Array, shape: number[], stride?: number[], offset?: number) => any;

export async function getPixels(data: Uint8Array, mimeType: string): Promise<any> {
 const img = decodeImage(data, mimeType);
 return ndarray(img.data, [img.width, img.height, 4], [4, 4 * img.width, 1], 0);
}
export async function savePixels(pixels: any, mimeType: string, options: {quality?: number} = {}): Promise<Uint8Array> {
 const [width, height, channels] = pixels.shape as number[], data = new Uint8Array(width * height * 4);
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const o = (y * width + x) * 4;
  for (let c = 0; c < 4; c++) data[o + c] = c < channels ? pixels.get(x, y, c) : 255;
 }
 if (mimeType === 'image/png') return encodePng({width, height, data});
 if (mimeType === 'image/jpeg') return encodeJpeg({width, height, data}, options.quality ?? 90);
 throw new Error(`can't encode ${mimeType} without native code (PNG and JPEG only)`);
}

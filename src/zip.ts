// A small, strict .zip reader for imports (RFC-0014 "Formats": a zipped glTF scene with its
// textures). Stored and deflated entries only; no ZIP64, encryption or symlinks. Every name is
// checked before anything is written (no absolute paths, no "..", no drive letters, no
// control characters), and the sizes are capped up front from the central directory and again
// while inflating, so a crafted archive or a zip bomb fails before it fills the disk.
import {closeSync,mkdirSync,openSync,readSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {inflateRawSync} from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({entries: 4096, bytes: 2 * 1024 ** 3, entryBytes: 1024 ** 3, ratio: 1000, nameLength: 512, depth: 16});
export interface ZipEntry {name: string; method: number; compressed: number; size: number; offset: number; directory: boolean}
const fail = (message: string): never => {throw Object.assign(new Error(message), {rule: 'import.archive'});};

function readAt(fd: number, position: number, length: number): Buffer {
 const b = Buffer.alloc(length);
 let got = 0;
 while (got < length) {const n = readSync(fd, b, got, length - got, position + got); if (!n) break; got += n;}
 if (got !== length) fail('the archive is truncated');
 return b;
}
/** A safe relative name, or an error naming the entry. */
export function zipName(raw: string): string {
 const name = raw.replace(/\\/g, '/');
 if (!name || name.length > ZIP_LIMITS.nameLength) fail(`an entry name is empty or too long`);
 if (/[\u0000-\u001f\u007f]/.test(name)) fail(`an entry name has control characters`);
 if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) fail(`${name.slice(0, 80)}: absolute paths are refused`);
 const parts = name.replace(/\/$/, '').split('/');
 if (parts.some(p => p === '..' || p === '.' || p === '')) fail(`${name.slice(0, 80)}: ".." and empty path parts are refused`);
 if (parts.length > ZIP_LIMITS.depth) fail(`${name.slice(0, 80)}: nested deeper than ${ZIP_LIMITS.depth} folders`);
 return name;
}
/** The central directory: every entry, checked, before anything is extracted. */
export function zipEntries(file: string): ZipEntry[] {
 const fd = openSync(file, 'r');
 try {
  const size = statSync(file).size, tail = Math.min(size, 65557), buf = readAt(fd, size - tail, tail);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) {eocd = i; break;}
  if (eocd < 0) fail('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) fail('ZIP64 archives are not supported: zip it again under 4 GiB');
  if (count > ZIP_LIMITS.entries) fail(`more than ${ZIP_LIMITS.entries} entries`);
  if (cdOffset + cdSize > size) fail('the central directory lies outside the file');
  const cd = readAt(fd, cdOffset, cdSize), out: ZipEntry[] = [], seen = new Set<string>();
  let p = 0, total = 0;
  for (let i = 0; i < count; i++) {
   if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) fail('a central directory entry is damaged');
   const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), compressed = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
   const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), external = cd.readUInt32LE(p + 38), offset = cd.readUInt32LE(p + 42);
   const raw = cd.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
   p += 46 + nlen + xlen + clen;
   const name = zipName(raw), directory = name.endsWith('/');
   if (flags & 1) fail(`${name}: encrypted entries are refused`);
   if (((external >>> 16) & 0o170000) === 0o120000) fail(`${name}: symbolic links are refused`);
   if (directory) continue;
   if (method !== 0 && method !== 8) fail(`${name}: compression method ${method} is not supported (stored or deflated only)`);
   if (usize > ZIP_LIMITS.entryBytes) fail(`${name}: larger than 1 GiB unpacked`);
   if (compressed && usize / compressed > ZIP_LIMITS.ratio) fail(`${name}: unpacks ${Math.round(usize / compressed)} times its size (a zip bomb?)`);
   const key = name.toLowerCase();
   if (seen.has(key)) fail(`${name}: appears twice`);
   seen.add(key);
   total += usize;
   if (total > ZIP_LIMITS.bytes) fail('the archive unpacks to more than 2 GiB');
   out.push({name, method, compressed, size: usize, offset, directory});
  }
  return out;
 } finally {closeSync(fd);}
}
/** Extracts the given entries (all by default) under dest; sizes are enforced while inflating. */
export function extractZip(file: string, dest: string, entries = zipEntries(file)): string[] {
 const fd = openSync(file, 'r'), written: string[] = [];
 try {
  for (const e of entries) {
   const head = readAt(fd, e.offset, 30);
   if (head.readUInt32LE(0) !== 0x04034b50) fail(`${e.name}: local header missing`);
   const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
   const data = readAt(fd, start, e.compressed);
   let bytes: Buffer;
   try {bytes = e.method === 0 ? data : inflateRawSync(data, {maxOutputLength: e.size + 1});}
   catch (x: any) {return fail(`${e.name}: can't be unpacked (${String(x.message).split('\n')[0]})`);}
   if (bytes.length !== e.size) fail(`${e.name}: unpacks to ${bytes.length} bytes, not the ${e.size} it declares`);
   const target = join(dest, ...e.name.split('/'));
   mkdirSync(dirname(target), {recursive: true});
   writeFileSync(target, bytes, {flag: 'wx', mode: 0o644});
   written.push(e.name);
  }
  return written;
 } finally {closeSync(fd);}
}

// Data sources (RFC-0013 phase 2) as SDK operations, the same edits the Director's Data sources
// page makes (shell bridge/sources.py): sources.json entries written atomically (other entries,
// keys and their order kept), the source helper asked to reload, and its `test` op for a
// definition as written. RFC-0016: an HTTP source an assistant sets needs no confirmation; a
// command source it proposes is written with "confirm": "pending" and runs only after the user
// allows it in Hyprune. Secrets are named, never read or written here.
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,statSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {createConnection} from 'node:net';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {socketPath} from './paths.js';

export class SourceError extends Error {
 constructor(public code: 'source.invalid' | 'source.config' | 'source.helper' | 'source.unknown', message: string, public hint?: string) {super(message);}
}
const fail = (code: SourceError['code'], message: string, hint?: string): never => {throw new SourceError(code, message, hint);};
const SLUG = /^[a-z][a-z0-9-]*$/, SECRET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH'], OUTPUTS = ['json', 'number', 'text', 'lines'];

export interface SourceEntry {
 id: string; kind?: 'command' | 'http'; argv?: string[]; url?: string; method?: string; headers?: Record<string, string | {secret: string; prefix?: string}>;
 body?: unknown; output?: string; intervalS?: number; timeoutS?: number; map?: Record<string, unknown>; confirm?: 'pending'; [key: string]: unknown;
}

/** $XDG_CONFIG_HOME/hyprune/sources.json (~/.config when unset or relative), as the helper reads it. */
export function sourcesPath(env = process.env): string {
 if (env.HYPRUNE_SOURCES_CONFIG) return env.HYPRUNE_SOURCES_CONFIG;
 const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config');
 return join(base, 'hyprune', 'sources.json');
}
export function readSources(path = sourcesPath()): {sources: SourceEntry[]; [k: string]: unknown} {
 if (!existsSync(path)) return {sources: []};
 let config: any;
 try {config = JSON.parse(readFileSync(path, 'utf8'));}
 catch (e: any) {return fail('source.config', `${path} is not valid JSON (${e.message}); fix it by hand first`);}
 if (!config || typeof config !== 'object' || !Array.isArray(config.sources ?? [])) fail('source.config', `${path} is not an object with a sources list; fix it by hand first`);
 config.sources ??= [];
 return config;
}
/** The shape the Data sources page writes (the helper checks the rest when it reloads and tests). */
export function checkSource(e: SourceEntry): void {
 if (!e || typeof e !== 'object') fail('source.invalid', 'A source is an object');
 if (typeof e.id !== 'string' || !SLUG.test(e.id) || e.id.length > 128) fail('source.invalid', 'A source id is a slug (a-z, 0-9, -), starting with a letter');
 const kind = e.kind ?? 'command';
 if (kind === 'command') {
  if (!Array.isArray(e.argv) || !e.argv.length || e.argv.length > 64 || e.argv.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0')))
   fail('source.invalid', 'A command is an argument vector of 1 to 64 strings', 'Like ["hyprune-system-gauges", "cpu"]');
 } else if (kind === 'http') {
  if (typeof e.url !== 'string' || !/^https?:\/\/[^/\s]+/.test(e.url) || e.url.length > 2048)
   fail('source.invalid', 'The URL starts with https:// (or http:// for this machine or a local network)');
  const method = e.method ?? 'GET';
  if (!METHODS.includes(method)) fail('source.invalid', 'The method is GET, POST, PUT or PATCH');
  if (method === 'GET' && e.body !== undefined && e.body !== null) fail('source.invalid', 'A body needs POST, PUT or PATCH');
  const headers = e.headers ?? {};
  if (typeof headers !== 'object' || Object.keys(headers).length > 32) fail('source.invalid', 'Headers are names with a text value or a secret');
  for (const [name, value] of Object.entries(headers)) {
   if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) fail('source.invalid', `Header ${name.slice(0, 40)} is not a header name`);
   if (typeof value === 'object') {
    if (!SECRET.test(String((value as any).secret ?? '')) || Object.keys(value).some(k => k !== 'secret' && k !== 'prefix'))
     fail('source.invalid', `Header ${name} names a secret by letters, digits and ._- (at most 64)`);
   } else if (typeof value !== 'string' || value.length > 4096) fail('source.invalid', `Header ${name} is text (at most 4096 characters) or a secret`);
  }
 } else fail('source.invalid', 'A source is a command or an HTTP source');
 if (!OUTPUTS.includes(e.output ?? 'json')) fail('source.invalid', 'The output is json, number, text or lines');
 for (const k of ['intervalS', 'timeoutS'] as const) if (e[k] !== undefined && !(typeof e[k] === 'number' && e[k]! > 0)) fail('source.invalid', `${k} is a number of seconds`);
 if (e.map !== undefined && (typeof e.map !== 'object' || e.map === null || Array.isArray(e.map))) fail('source.invalid', 'The map is an object', 'Like {"value": "$.queue.depth", "display": "$.queue.depth"}');
 if (JSON.stringify(e).length > 48 * 1024) fail('source.invalid', 'The source is over 48 KiB');
}
function writeAtomic(path: string, config: unknown): void {
 const real = existsSync(path) && lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
 mkdirSync(dirname(real), {recursive: true, mode: 0o700});
 const mode = existsSync(real) ? statSync(real).mode & 0o777 : 0o600, temp = join(dirname(real), `.sources.json.${process.pid}.tmp`);
 writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', {mode});
 chmodSync(temp, mode);
 const fd = openSync(temp, 'r'); fsyncSync(fd); closeSync(fd);
 renameSync(temp, real);
}
export interface PutResult {entry: SourceEntry; created: boolean; changed: boolean; path: string; dryRun?: true; reload?: unknown}
/**
 * Writes one entry: its keys replace the entry's (null removes a key), keys it doesn't name stay.
 * `ifExists: "error"` refuses an existing id (RFC-0016 rule 3); the default updates it.
 */
export async function putSource(entry: SourceEntry, o: {path?: string; dryRun?: boolean; ifExists?: 'update' | 'error'; reload?: boolean} = {}): Promise<PutResult> {
 checkSource(Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null)) as SourceEntry);
 const path = o.path ?? sourcesPath(), config = readSources(path);
 let old = config.sources.find(s => s && s.id === entry.id);
 if (old && o.ifExists === 'error') fail('source.invalid', `A source is already called ${entry.id}`, 'Use another id, or ifExists "update"');
 const created = !old, before = JSON.stringify(old ?? null);
 const next: SourceEntry = {...(old ?? {id: entry.id})};
 for (const [k, v] of Object.entries(entry)) if (v === null) delete next[k]; else next[k] = v;
 const changed = JSON.stringify(next) !== before;
 if (o.dryRun) return {entry: next, created, changed, path, dryRun: true};
 if (changed) {
  if (old) config.sources[config.sources.indexOf(old)] = next; else config.sources.push(next);
  writeAtomic(path, config);
 }
 const reload = changed && o.reload !== false ? await helper('reload').catch(e => ({ok: false, error: e.message})) : undefined;
 return {entry: next, created, changed, path, ...(reload ? {reload} : {})};
}
export async function removeSource(id: string, o: {path?: string; dryRun?: boolean} = {}): Promise<{removed: boolean; previous: SourceEntry | null}> {
 const path = o.path ?? sourcesPath(), config = readSources(path), old = config.sources.find(s => s && s.id === id) ?? null;
 if (!old || o.dryRun) return {removed: !!old && !o.dryRun, previous: old};
 config.sources.splice(config.sources.indexOf(old), 1);
 writeAtomic(path, config);
 await helper('reload').catch(() => undefined);
 return {removed: true, previous: old};
}
/** sources.json entries, secrets named only (values are never in the file). */
export function listSources(path = sourcesPath()): SourceEntry[] { return readSources(path).sources; }

/** The source helper's control socket (sources.sock beside core's) and one request line. */
export function helperSocket(env = process.env): string {
 return env.HYPRUNE_SOURCES_SOCKET || join(dirname(env.HYPRUNE_SOCKET || socketPath(env)), 'sources.sock');
}
export function helper(op: string, fields: Record<string, unknown> = {}, timeoutMs = op === 'test' ? 70_000 : 5_000): Promise<any> {
 return new Promise((resolve, reject) => {
  let path: string;
  try {path = helperSocket();} catch (e: any) {return reject(new SourceError('source.helper', e.message));}
  if (!existsSync(path)) return reject(new SourceError('source.helper', 'The source helper is not running', 'Start Hyprune (the helper runs with it)'));
  const socket = createConnection(path), timer = setTimeout(() => {socket.destroy(); reject(new SourceError('source.helper', `The source helper did not answer in ${timeoutMs / 1000} s`));}, timeoutMs);
  let buffer = '';
  socket.on('connect', () => socket.write(JSON.stringify({op, ...fields}) + '\n'));
  socket.on('data', d => {
   buffer += d.toString('utf8');
   if (buffer.length > 64 * 1024) {socket.destroy(); clearTimeout(timer); reject(new SourceError('source.helper', 'The source helper answered more than 64 KiB'));}
   const nl = buffer.indexOf('\n');
   if (nl < 0) return;
   clearTimeout(timer); socket.end();
   try {
    const reply = JSON.parse(buffer.slice(0, nl));
    if (reply?.ok !== true) reject(new SourceError('source.helper', String(reply?.error ?? 'The source helper refused the request').slice(0, 512)));
    else resolve(reply);
   } catch {reject(new SourceError('source.helper', 'The source helper answered something that is not JSON'));}
  });
  socket.on('error', e => {clearTimeout(timer); reject(new SourceError('source.helper', `The source helper: ${e.message}`));});
 });
}
/** Runs a definition once with the helper's rules (nothing is published) and answers its raw output and mapped values. */
export async function testSource(entry: SourceEntry): Promise<unknown> {
 checkSource({...entry, id: entry.id || 'test'});
 if ((entry.kind ?? 'command') === 'command' && entry.confirm === 'pending') fail('source.invalid', 'A proposed command runs only after you allow it in Hyprune');
 const {id, enabled, ...source} = entry as any;
 const reply = await helper('test', {source});
 return Object.fromEntries(['values', 'stdout', 'stderr', 'error', 'exitCode', 'durationMs', 'raw', 'rawBytes', 'httpStatus', 'contentType', 'secrets']
  .filter(k => k in reply).map(k => [k, reply[k]]));
}

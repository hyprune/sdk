// World folders (RFC-0014 "Building a world", phase 1 as amended): `hyprune builder` creates a
// folder from the Flat land starter as a git repository, saves (Make world, then one commit),
// releases (a version commit and an annotated tag v<version>; with a remote, a push and the
// RFC-0015 assets built from the tag), changes the sky and sets the remote. Core reads the
// folder in editor mode (builder/base.json plus the placements it writes to
// builder/project.json) and never runs git; this module is the project helper.
import {execFileSync,spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {validateManifest} from './validation.js';
import {validateWorld} from './world.js';
import {decodeImage,encodeJpeg,fitInside,imageMime,type Rgba} from './pixels.js';
import {equirectDirection,landGlb,panoramaJpeg,starterAtmosphere} from './starter.js';
import {packRelease} from './registry/pack.js';
import {userName} from './import.js';

export const STARTER = 'flat-land@0.1';
export const BASE = 'builder/base.json', PROJECT = 'builder/project.json', SKY = 'sky/panorama.jpg';
const WORKSPACE_BASE = 20, SCREEN_TYPE = 'com.hyprune.window', MAX_GIT_FILE = 95 * 1048576;
const LOCAL_TIMEOUT = 60_000, NETWORK_TIMEOUT = 30 * 60_000;

export type BuilderCode = 'git.missing' | 'git.identity' | 'git.failed' | 'project.unknown' | 'project.invalid' | 'save.nothing' | 'make.invalid'
 | 'release.unsaved' | 'release.version' | 'release.id' | 'remote.invalid' | 'remote.auth' | 'remote.rejected' | 'sky.invalid' | 'builder.busy';
export class BuilderError extends Error {
 constructor(public code: BuilderCode, message: string) {super(message);}
}
const fail = (code: BuilderCode, message: string): never => {throw new BuilderError(code, message);};

export interface Placement {id: string; ref: string; pose: {position: number[]; rotation: number[]}; scale: number; workspace?: number; locked?: boolean}
export interface Project {
 projectVersion: '0.1'; id: string; name: string; starter: typeof STARTER; base: typeof BASE;
 sky: {image: string | null; license: string; author: string; source: string}; placements: Placement[]; releaseUpload?: boolean;
}
export interface Pending {added: number; modified: number; deleted: number; total: number}
export interface Status {
 projectId: string; worldId: string; name: string; folder: string; version: string; placements: number;
 branch: string; head: string | null; pending: Pending;
 lastSave: {commit: string; message: string; at: string} | null;
 lastVersion: {version: string; tag: string; commit: string} | null; suggestedVersion: string;
 remote: {name: 'origin'; url: string; kind: 'github' | 'other'; repo: string | null} | null;
 identity: {name: string; email: string} | null; sky: Project['sky'];
}

// ---- folders ----
export function projectsDir(env: NodeJS.ProcessEnv = process.env): string {
 if (env.HYPRUNE_PROJECTS_DIR) return resolve(env.HYPRUNE_PROJECTS_DIR);
 return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'), 'hyprune/projects');
}
/** A folder and world id slug from a name: "Harbour Plaza!" -> "harbour-plaza". */
export function slugify(name: string): string {
 let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
 if (!s) s = 'world';
 return /^[a-z]/.test(s) ? s : 'world-' + s;
}
export function validName(name: string): string {
 const n = name.trim();
 if (!n || n.length > 64 || /[\u0000-\u001f\u007f]/.test(n)) fail('project.invalid', 'A world name is 1 to 64 characters without control characters');
 return n;
}
/** A project folder from a folder path, a slug or a local.<slug> world id. */
export function projectFolder(target: string, root = projectsDir()): string {
 const slug = target.startsWith('local.') ? target.slice(6) : target;
 const folder = /^[a-z][a-z0-9-]{0,63}$/.test(slug) && !target.includes('/') ? join(root, slug) : resolve(target);
 if (!existsSync(join(folder, PROJECT)) || !existsSync(join(folder, '.git'))) fail('project.unknown', `No world folder at ${folder}`);
 return folder;
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** Atomic JSON write (a temporary file in the same directory, then a rename). */
function writeJson(path: string, value: unknown): void {
 mkdirSync(dirname(path), {recursive: true});
 const temp = `${path}.${process.pid}.tmp`;
 writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
 renameSync(temp, path);
}
export function readProject(folder: string): Project {
 const project = readJson(join(folder, PROJECT));
 const check = validateManifest('project', project, undefined, '0.11');
 if (!check.valid) fail('project.invalid', `${PROJECT}: ${check.errors.join('; ')}`);
 return project as Project;
}

// ---- git (RFC-0014 "The project helper": fixed argument vectors, no hooks, no prompts) ----
function gitEnv(folder: string): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = {...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_CEILING_DIRECTORIES: dirname(folder), LC_ALL: 'C'};
 for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete env[k];
 return env;
}
interface Run {status: number; stdout: string; stderr: string}
function run(cmd: string, args: string[], folder: string, o: {input?: string; timeout?: number; cwd?: string} = {}): Run {
 const r = spawnSync(cmd, args, {cwd: o.cwd ?? folder, env: gitEnv(folder), input: o.input, encoding: 'utf8', timeout: o.timeout ?? LOCAL_TIMEOUT, maxBuffer: 64 * 1048576});
 if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') fail(cmd === 'git' ? 'git.missing' : 'git.failed', `${cmd} is not installed`);
 if (r.error) fail('git.failed', `${cmd} ${args[0] ?? ''}: ${r.error.message}`);
 return {status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr};
}
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false'];
function gitTry(folder: string, args: string[], o: {input?: string; timeout?: number} = {}): Run {
 return run('git', [...SAFE, '-C', folder, ...args], folder, o);
}
function git(folder: string, args: string[], o: {input?: string; timeout?: number} = {}): string {
 const r = gitTry(folder, args, o);
 if (r.status !== 0) fail('git.failed', `git ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
 return r.stdout;
}
/** git's version, refusing anything older than 2.30 (RFC-0014). */
export function gitVersion(): string {
 let out = '';
 try {out = execFileSync('git', ['--version'], {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']});}
 catch {fail('git.missing', 'git is not installed: building worlds needs git 2.30 or newer');}
 const m = /(\d+)\.(\d+)/.exec(out);
 if (!m || +m[1] < 2 || (+m[1] === 2 && +m[2] < 30)) fail('git.missing', `git ${m ? m[0] : '?'} is too old: building worlds needs 2.30 or newer`);
 return m![0];
}
function identity(folder: string): {name: string; email: string} | null {
 const get = (k: string) => gitTry(folder, ['config', '--get', k]).stdout.trim();
 const name = get('user.name'), email = get('user.email');
 return name && email ? {name, email} : null;
}
/** Pending changes in the folder (untracked files included, .gitignore honoured). */
export function pending(folder: string): Pending {
 const out = git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
 const p = {added: 0, modified: 0, deleted: 0, total: 0}, parts = out.split('\0');
 for (let i = 0; i < parts.length; i++) {
  const e = parts[i];
  if (e.length < 4) continue;
  const xy = e.slice(0, 2);
  if (xy[0] === 'R' || xy[0] === 'C') i++; // the rename's source path follows
  if (xy === '??' || xy.includes('A')) p.added++;
  else if (xy.includes('D')) p.deleted++;
  else p.modified++;
  p.total++;
 }
 return p;
}

// ---- versions ----
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
export function compareVersions(a: string, b: string): number {
 const pa = SEMVER.exec(a)!, pb = SEMVER.exec(b)!;
 for (let i = 1; i <= 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
 if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
 const xa = pa[4].split('.'), xb = pb[4].split('.');
 for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
  if (xa[i] === undefined || xb[i] === undefined) return xa[i] === undefined ? -1 : 1;
  const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
  if (na && nb && +xa[i] !== +xb[i]) return +xa[i] - +xb[i];
  if (na !== nb) return na ? -1 : 1;
  if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
 }
 return 0;
}
function versionTags(folder: string): Array<{version: string; tag: string; commit: string}> {
 const out = git(folder, ['for-each-ref', '--format=%(refname:strip=2) %(*objectname) %(objectname)', 'refs/tags/v*']);
 return out.split('\n').filter(Boolean).map(l => {const [tag, peeled, obj] = l.split(' '); return {tag, version: tag.slice(1), commit: peeled || obj};})
  .filter(t => SEMVER.test(t.version)).sort((a, b) => compareVersions(b.version, a.version));
}
const nextPatch = (v: string) => {const m = SEMVER.exec(v)!; return m[4] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}.${+m[3] + 1}`;};

// ---- remote ----
/** A remote URL as RFC-0014 allows it (https://, ssh:// or user@host:path), with its GitHub owner/repo. */
export function parseRemote(url: string): {url: string; kind: 'github' | 'other'; owner: string | null; repo: string | null} {
 const u = url.trim();
 if (u.length > 512 || /[\s\u0000-\u001f]/.test(u) || u.startsWith('-')) fail('remote.invalid', 'Not a remote URL');
 const forms = [/^https:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/, /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/, /^[A-Za-z0-9._-]+@([^/:\s]+):(?!\/\/)(.+)$/];
 const m = forms.map(f => f.exec(u)).find(Boolean);
 if (!m) fail('remote.invalid', 'The remote must be an https://, ssh:// or user@host:path URL');
 const host = m![1].toLowerCase(), path = m![2].replace(/\.git$/, '').replace(/\/$/, '');
 const gh = host === 'github.com' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(path);
 return {url: u, kind: gh ? 'github' : 'other', owner: gh ? path.split('/')[0] : null, repo: gh ? path : null};
}
function remoteOf(folder: string): Status['remote'] {
 const r = gitTry(folder, ['remote', 'get-url', 'origin']);
 if (r.status !== 0) return null;
 const url = r.stdout.trim();
 try {const p = parseRemote(url); return {name: 'origin', url, kind: p.kind, repo: p.repo};}
 catch {return {name: 'origin', url, kind: 'other', repo: null};}
}
/** RFC-0015's published id for a GitHub repository: io.github.<owner>.<name>, the hyprune-world- prefix dropped. */
export function publishedId(repo: string): string {
 const [owner, name] = repo.toLowerCase().split('/');
 const part = (s: string) => {const p = s.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''); return /^[a-z]/.test(p) ? p : 'x' + p;};
 return `io.github.${part(owner)}.${part(name.replace(/^hyprune-world-/, '') || name)}`;
}
export function setRemote(folder: string, url: string | null): Status['remote'] {
 const current = remoteOf(folder);
 if (url === null) {if (current) git(folder, ['remote', 'remove', 'origin']); return null;}
 const p = parseRemote(url);
 git(folder, current ? ['remote', 'set-url', 'origin', p.url] : ['remote', 'add', 'origin', p.url]);
 return remoteOf(folder);
}

// ---- create ----
const GITIGNORE = 'builder/cache/\nreleases/\n*.tmp\n';
// export-ignore keeps git's own files out of `git archive`, which Release packs from.
const GITATTRIBUTES = `.gitignore export-ignore
.gitattributes export-ignore
.github export-ignore
*.glb binary
*.bin binary
*.png binary
*.jpg binary
*.jpeg binary
*.ktx2 binary
*.ogg binary
*.wav binary
# Large files: uncomment to keep them in Git LFS (RFC-0015: LFS bandwidth counts against your quota).
# *.glb filter=lfs diff=lfs merge=lfs -text
# *.ktx2 filter=lfs diff=lfs merge=lfs -text
`;
export interface CreateOptions {root?: string; identity?: {name: string; email: string}}
export interface Created {projectId: string; worldId: string; name: string; folder: string; commit: string}
export async function createProject(name: string, o: CreateOptions = {}): Promise<Created> {
 gitVersion();
 const display = validName(name), root = o.root ?? projectsDir(), base = slugify(display);
 mkdirSync(root, {recursive: true});
 let slug = base;
 for (let n = 2; existsSync(join(root, slug)); n++) slug = `${base}-${n}`;
 const folder = join(root, slug), worldId = `local.${slug}`;
 mkdirSync(folder);
 try {
  mkdirSync(join(folder, 'starter')); mkdirSync(join(folder, 'sky'));
  writeFileSync(join(folder, 'starter/land.glb'), await landGlb());
  writeFileSync(join(folder, SKY), panoramaJpeg());
  const author = userName() || 'unknown';
  const manifest = {
   formatVersion: '0.11', id: worldId, version: '0.1.0', name: display, license: 'CC0-1.0',
   description: `Built with the Hyprune builder from the Flat land starter.`,
   scene: 'starter/land.glb', defaultSpawn: 'start',
   spawns: [{id: 'start', pose: {position: [0, 0, 0], rotation: [0, 0, 0, 1]}}],
   collision: [{node: 0, shape: 'mesh', layer: 'static'}],
   playable: {volumes: [{type: 'box', min: [-1000, -50, -1000], max: [1000, 500, 1000]}], maxFlyHeight: 500},
   atmosphere: starterAtmosphere(SKY),
   attribution: [{path: '.', author, license: 'CC0-1.0'}],
  };
  writeJson(join(folder, BASE), manifest);
  const project: Project = {projectVersion: '0.1', id: worldId, name: display, starter: STARTER, base: BASE,
   sky: {image: SKY, license: 'CC0-1.0', author: 'Hyprune contributors', source: 'Generated by the hyprune CLI (Flat land starter)'}, placements: []};
  writeJson(join(folder, PROJECT), project);
  writeFileSync(join(folder, '.gitignore'), GITIGNORE);
  writeFileSync(join(folder, '.gitattributes'), GITATTRIBUTES);
  await make(folder);
  git(folder, ['init', '-q', '-b', 'main']);
  if (o.identity) {
   if (!o.identity.name.trim() || !/^[^\s<>@]+@[^\s<>@]+$/.test(o.identity.email)) fail('git.identity', 'A commit name and an email address are needed');
   git(folder, ['config', 'user.name', o.identity.name.trim()]);
   git(folder, ['config', 'user.email', o.identity.email]);
  }
  if (!identity(folder)) fail('git.identity', 'git has no commit name and email: pass --git-name and --git-email (stored in this world folder only)');
  git(folder, ['add', '-A']);
  git(folder, ['commit', '-q', '-F', '-'], {input: `Create ${display} from the Flat land starter\n`});
  return {projectId: worldId, worldId, name: display, folder, commit: git(folder, ['rev-parse', 'HEAD']).trim()};
 } catch (e) {
  rmSync(folder, {recursive: true, force: true});
  throw e;
 }
}

// ---- make (RFC-0014 "Make world", phase 1: objects, screens as homes, provenance) ----
type Vec = number[];
const rotate = (q: Vec, v: Vec): Vec => {
 const [x, y, z, w] = q, [vx, vy, vz] = v;
 const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
 return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const qmul = (a: Vec, b: Vec): Vec => [
 a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
 a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const qnorm = (q: Vec) => {const l = Math.hypot(...q); return q.map(v => r4(v / l));};
function screenAnchor(object: any): any {
 return object?.traits?.mount?.anchors?.find((a: any) => a.role === 'mounted-workspace' && a.size && a.pose) ?? null;
}
function spdxAnd(licenses: string[]): string {
 const distinct = [...new Set(licenses)];
 return distinct.length === 1 ? distinct[0] : distinct.map(l => /\s/.test(l) ? `(${l})` : l).join(' AND ');
}
export interface Made {manifest: Record<string, any>; homes: Array<{slot: string; workspace: number; placement: string}>; warnings: string[]}
/** Writes world.json, ATTRIBUTION.md and LICENSE from builder/base.json and the project's placements. */
export async function make(folder: string): Promise<Made> {
 const base = readJson(join(folder, BASE)), project = readProject(folder), warnings: string[] = [];
 const m = structuredClone(base);
 const assets = [...new Set(project.placements.map(p => p.ref.slice('world/'.length)))];
 const objects = new Map<string, any>();
 for (const id of assets) {
  const path = join(folder, 'objects', id, 'object.json');
  if (!existsSync(path)) fail('make.invalid', `objects/${id}/object.json is missing (placed as world/${id})`);
  objects.set(id, readJson(path));
 }
 if (assets.length) {
  m.objectAssets = [...(base.objectAssets ?? []), ...assets.map(id => ({id, dir: `objects/${id}`}))];
  m.objects = [...(base.objects ?? []), ...project.placements.map(p => {
   const o: Record<string, unknown> = {id: p.id, asset: p.ref.slice('world/'.length), pose: {position: p.pose.position.map(r4), rotation: qnorm(p.pose.rotation)}};
   if (p.scale !== 1) o.scale = p.scale;
   o.locked = true;
   return o;
  })];
 }
 // Screens bound to a workspace become homes: slot = workspace - 20 (the default base).
 const homes: Made['homes'] = [], slots = new Set<string>();
 for (const p of project.placements) {
  if (p.workspace === undefined) continue;
  const a = screenAnchor(objects.get(p.ref.slice('world/'.length)));
  if (!a) {warnings.push(`${p.id}: has a workspace but its object is not a workspace screen`); continue;}
  const n = p.workspace - WORKSPACE_BASE, slot = String(n).padStart(2, '0');
  if (n < 1) {warnings.push(`${p.id}: workspace ${p.workspace} is not above ${WORKSPACE_BASE}; the screen is a prop in the made world`); continue;}
  if (slots.has(slot)) {warnings.push(`${p.id}: workspace ${p.workspace} already has a screen`); continue;}
  slots.add(slot);
  const s = p.scale, turn = qmul(p.pose.rotation, a.pose.rotation), q = qnorm(turn);
  const local = rotate(p.pose.rotation, a.pose.position.map((v: number) => v * s));
  const centre = p.pose.position.map((v, i) => r4(v + local[i]));
  const size = [r4(a.size[0] * s), r4(a.size[1] * s)];
  const id = `screen-${slot}`, spawn = `home-${slot}`;
  // The arrival: the standback in front of the screen on the land (y = 0), facing it.
  const normal = rotate(turn.map(v => v / Math.hypot(...turn)), [0, 0, 1]), flat = Math.hypot(normal[0], normal[2]);
  const f = flat > 0.3 ? [normal[0] / flat, normal[2] / flat] : [0, 1], d = Math.max(2.5, 0.87 * size[0]), yaw = Math.atan2(f[0], f[1]);
  m.anchors = [...(m.anchors ?? []), {id, pose: {position: centre, rotation: q}, size, screenType: SCREEN_TYPE,
   mount: {type: a.mountType, role: 'mounted-workspace', interaction: 'focus-in'}}];
  m.areas = [...(m.areas ?? []), {id, workspaceSlot: slot, primaryAnchor: id, toolAnchors: [], dataAnchors: [], theme: String(objects.get(p.ref.slice('world/'.length))?.name ?? 'Screen').slice(0, 256), spawnId: spawn}];
  m.spawns = [...m.spawns, {id: spawn, pose: {position: [r4(centre[0] + f[0] * d), 0, r4(centre[2] + f[1] * d)], rotation: [0, r4(Math.sin(yaw / 2)), 0, r4(Math.cos(yaw / 2))]}}];
  homes.push({slot, workspace: p.workspace, placement: p.id});
 }
 // Provenance: the folder's own files, the sky, each copied object (its own attribution).
 const author = base.attribution?.[0]?.author ?? 'unknown';
 const attribution: Array<Record<string, string>> = [{path: '.', author, license: 'CC0-1.0'}, {path: 'starter', author: 'Hyprune contributors', license: 'CC0-1.0'}];
 const sky = project.sky;
 if (sky.image) attribution.push({path: sky.image, author: sky.author, license: sky.license, ...(sky.source.startsWith('https://') ? {source: sky.source} : {})});
 for (const [id, o] of objects) for (const a of (o.attribution ?? [{path: '.', author: 'unknown', license: o.license ?? 'LicenseRef-unknown'}]))
  attribution.push({...a, path: a.path === '.' ? `objects/${id}` : `objects/${id}/${a.path}`});
 m.attribution = attribution;
 m.license = spdxAnd(attribution.map(a => a.license));
 const check = validateManifest('world', m, undefined, m.formatVersion);
 if (!check.valid) fail('make.invalid', check.errors.join('; '));
 writeJson(join(folder, 'world.json'), m);
 writeFileSync(join(folder, 'ATTRIBUTION.md'), attributionText(m));
 writeFileSync(join(folder, 'LICENSE'), licenseText(m));
 return {manifest: m, homes, warnings};
}
function attributionText(m: Record<string, any>): string {
 const rows = m.attribution.map((a: any) => `| \`${a.path}\` | ${a.author.replaceAll('|', '\\|')} | ${a.license} | ${a.source ?? ''} |`);
 return `# ${m.name}: attribution\n\nWritten by the Hyprune builder from each part's recorded provenance.\n\n| Path | Author | Licence | Source |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
}
function licenseText(m: Record<string, any>): string {
 const ids = [...new Set<string>(m.attribution.map((a: any) => a.license))];
 const link = (id: string) => id.startsWith('LicenseRef-') ? 'not recorded: ask the author before reusing these parts' : `https://spdx.org/licenses/${id}.html`;
 return `${m.name}\n\nThis world combines parts under these licences (SPDX: ${m.license}).\nATTRIBUTION.md lists which licence covers which path.\n\n${ids.map(id => `- ${id}: ${link(id)}`).join('\n')}\n`;
}

/** The package files (tracked or new, not ignored, not export-ignored) copied to a fresh directory and validated. */
async function validateFolder(folder: string): Promise<string[]> {
 const files = git(folder, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
  .filter(f => existsSync(join(folder, f)) && !['.gitignore', '.gitattributes'].includes(f) && !f.startsWith('.github/'));
 const stage = mkdtempSync(join(tmpdir(), 'hyprune-make-'));
 try {
  for (const f of files) {mkdirSync(dirname(join(stage, 'w', f)), {recursive: true}); copyFileSync(join(folder, f), join(stage, 'w', f));}
  return (await validateWorld(join(stage, 'w'))).warnings;
 } catch (e: any) {
  return fail('make.invalid', e.message);
 } finally {rmSync(stage, {recursive: true, force: true});}
}

// ---- busy lock: one save, release or sky change at a time per folder ----
function locked<T>(folder: string, fn: () => Promise<T>): Promise<T> {
 const path = join(folder, 'builder/cache/busy');
 mkdirSync(dirname(path), {recursive: true});
 try {writeFileSync(path, String(process.pid), {flag: 'wx'});}
 catch {
  const age = Date.now() - statSync(path).mtimeMs;
  if (age < NETWORK_TIMEOUT) fail('builder.busy', 'Another save, release or sky change is running on this world');
  writeFileSync(path, String(process.pid));
 }
 return fn().finally(() => rmSync(path, {force: true}));
}

// ---- status, list ----
export function status(folder: string): Status {
 const project = readProject(folder), base = readJson(join(folder, BASE));
 const head = gitTry(folder, ['rev-parse', '--verify', '-q', 'HEAD']).stdout.trim() || null;
 const log = head ? git(folder, ['log', '-1', '--format=%H%x00%cI%x00%B']).split('\0') : null;
 const tags = versionTags(folder);
 return {
  projectId: project.id, worldId: base.id, name: project.name, folder, version: base.version, placements: project.placements.length,
  branch: gitTry(folder, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim() || 'HEAD', head: head?.slice(0, 12) ?? null, pending: pending(folder),
  lastSave: log ? {commit: log[0].slice(0, 12), at: log[1], message: log[2].trim()} : null,
  lastVersion: tags[0] ? {...tags[0], commit: tags[0].commit.slice(0, 12)} : null,
  suggestedVersion: tags[0] ? nextPatch(tags[0].version) : base.version,
  remote: remoteOf(folder), identity: identity(folder), sky: project.sky,
 };
}
export function listProjects(root = projectsDir()): Status[] {
 if (!existsSync(root)) return [];
 const out: Status[] = [];
 for (const e of readdirSync(root).sort()) {
  const folder = join(root, e);
  if (!existsSync(join(folder, PROJECT)) || !existsSync(join(folder, '.git'))) continue;
  try {out.push(status(folder));} catch {/* a broken folder is listed by repair, not here */}
 }
 return out;
}

// ---- save ----
const at = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** "placed 2 objects, moved 1, removed 1, changed the sky" from the saved and current project files. */
export function changeSummary(before: Project | null, after: Project): string {
 const was = new Map((before?.placements ?? []).map(p => [p.id, p])), parts: string[] = [];
 const added = after.placements.filter(p => !was.has(p.id)).length;
 const removed = [...was.keys()].filter(id => !after.placements.some(p => p.id === id)).length;
 const moved = after.placements.filter(p => was.has(p.id) && JSON.stringify([p.pose, p.scale]) !== JSON.stringify([was.get(p.id)!.pose, was.get(p.id)!.scale])).length;
 const rebound = after.placements.filter(p => was.has(p.id) && p.workspace !== was.get(p.id)!.workspace).length;
 const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
 if (added) parts.push(`placed ${n(added, 'object', 'objects')}`);
 if (moved) parts.push(`moved ${moved}`);
 if (removed) parts.push(`removed ${removed}`);
 if (rebound) parts.push(`changed ${n(rebound, 'workspace', 'workspaces')}`);
 if (before && JSON.stringify(before.sky) !== JSON.stringify(after.sky)) parts.push('changed the sky');
 if (before && before.name !== after.name) parts.push('renamed the world');
 return parts.join(', ');
}
export interface Saved {commit: string; message: string; pending: Pending; homes: Made['homes']; warnings: string[]}
export function save(folder: string, message = ''): Promise<Saved> {
 return locked(folder, async () => {
  const made = await make(folder), warnings = [...made.warnings, ...await validateFolder(folder)];
  const changes = pending(folder);
  if (!changes.total) fail('save.nothing', 'Nothing to save: there are no changes since the last save');
  git(folder, ['add', '-A']);
  for (const f of git(folder, ['diff', '--cached', '--name-only', '-z', '--diff-filter=AM']).split('\0').filter(Boolean))
   if (statSync(join(folder, f)).size > MAX_GIT_FILE) warnings.push(`${f} is over 95 MiB: common git hosts refuse such files`);
  const savedProject = gitTry(folder, ['show', `HEAD:${PROJECT}`]);
  const before = savedProject.status === 0 ? JSON.parse(savedProject.stdout) as Project : null;
  const summary = changeSummary(before, readProject(folder));
  const text = message.trim() || `Save ${at()}${summary ? ' · ' + summary : ''}`;
  git(folder, ['commit', '-q', '-F', '-'], {input: text + '\n'});
  return {commit: git(folder, ['rev-parse', 'HEAD']).trim(), message: text, pending: changes, homes: made.homes, warnings};
 });
}

// ---- release ----
export interface ReleaseOptions {version?: string; notes?: string; id?: string; output?: string; onStage?: (stage: 'version' | 'build' | 'push' | 'release') => void}
export interface Released {
 version: string; tag: string; commit: string; worldId: string; pushed: boolean; release: string | null;
 assets: string[]; warnings: string[];
}
export function release(folder: string, o: ReleaseOptions = {}): Promise<Released> {
 return locked(folder, async () => {
  const stage = o.onStage ?? (() => {});
  if (pending(folder).total) fail('release.unsaved', 'Save first: Release makes a version from the saved state');
  const tags = versionTags(folder), latest = tags[0]?.version, base = readJson(join(folder, BASE));
  const version = o.version ?? (latest ? nextPatch(latest) : base.version);
  if (!SEMVER.test(version)) fail('release.version', `${version} is not a version (SemVer, no build metadata, like 0.2.0)`);
  if (latest && compareVersions(version, latest) <= 0) fail('release.version', `v${version} is not newer than v${latest}`);
  const remote = remoteOf(folder), warnings: string[] = [];
  let worldId: string = base.id;
  if (remote) {
   const wanted = o.id ?? (remote.repo ? publishedId(remote.repo) : null);
   if (!wanted) fail('release.id', 'This remote is not on GitHub: pass the published world id (--id, reverse-domain, not local.)');
   if (wanted!.startsWith('local.') || !validateManifest('world', {...base, id: wanted}, undefined, base.formatVersion).valid) fail('release.id', `${wanted} is not a published world id`);
   worldId = wanted!;
  } else if (o.id) worldId = o.id;
  // The version commit: version (and the published id) in the base and the made world.
  stage('version');
  if (base.version !== version || base.id !== worldId) {
   writeJson(join(folder, BASE), {...base, version, id: worldId});
   await make(folder);
   warnings.push(...await validateFolder(folder));
   git(folder, ['add', '-A']);
   git(folder, ['commit', '-q', '-F', '-'], {input: `Release v${version}\n`});
  } else warnings.push(...await validateFolder(folder));
  const tag = `v${version}`;
  git(folder, ['tag', '-a', tag, '-F', '-'], {input: (o.notes?.trim() || `Release ${tag}`) + '\n'});
  const commit = git(folder, ['rev-parse', 'HEAD']).trim();
  const result: Released = {version, tag, commit, worldId, pushed: false, release: null, assets: [], warnings};
  if (!remote) return result;
  // Build from the tag, not the working tree (git archive honours export-ignore).
  stage('build');
  const out = resolve(o.output ?? join(folder, 'releases', tag)), stageDir = mkdtempSync(join(tmpdir(), 'hyprune-release-'));
  try {
   const tar = join(stageDir, 'tag.tar'), pkg = join(stageDir, 'package');
   git(folder, ['archive', '--format=tar', '-o', tar, tag]);
   mkdirSync(pkg);
   execFileSync('tar', ['-xf', tar, '-C', pkg, '--no-same-owner', '--no-same-permissions'], {stdio: 'pipe'});
   const repoUrl = remote.repo ? `https://github.com/${remote.repo}` : (/^https:\/\//.test(remote.url) ? remote.url.replace(/\.git$/, '') : null);
   if (!repoUrl) fail('release.id', 'The release record needs an https repository URL; this remote has none');
   const packed = await packRelease(pkg, {type: 'world', tag, repo: repoUrl!, commit, output: out});
   result.assets = [packed.archive, packed.sha256File, packed.record];
  } finally {rmSync(stageDir, {recursive: true, force: true});}
  stage('push');
  const branch = gitTry(folder, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim() || 'main';
  const push = gitTry(folder, ['push', '--atomic', '--porcelain', 'origin', `refs/heads/${branch}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`], {timeout: NETWORK_TIMEOUT});
  if (push.status !== 0) {
   const text = push.stderr + push.stdout;
   if (/rejected|non-fast-forward|fetch first/i.test(text)) fail('remote.rejected', `The remote has changes Hyprune won't merge; the local tag ${tag} stays. Resolve it with git, then release again.`);
   fail('remote.auth', `Set up access to this remote (the push failed; the local tag ${tag} stays): run "git -C ${folder} push origin ${branch}" in a terminal. ${text.trim().split('\n').at(-1) ?? ''}`);
  }
  result.pushed = true;
  const project = readProject(folder);
  if (remote.kind === 'github' && project.releaseUpload !== false) {
   stage('release');
   const gh = run('gh', ['release', 'create', tag, '--verify-tag', '--repo', remote.repo!, '--title', `${project.name} ${version}`, '--notes-file', '-',
    ...(SEMVER.exec(version)![4] ? ['--prerelease'] : []), ...result.assets], folder, {input: o.notes?.trim() || `Release ${tag}`, timeout: NETWORK_TIMEOUT});
   if (gh.status !== 0) warnings.push(`gh release create failed (${(gh.stderr || gh.stdout).trim().split('\n').at(-1)}): attach the assets in ${out} to the release by hand`);
   else result.release = gh.stdout.trim().split('\n').at(-1) || null;
  } else if (remote.kind !== 'github') warnings.push(`Pushed ${tag}; this remote is not GitHub, so attach the assets in ${out} to its release by hand`);
  return result;
 });
}

// ---- sky ----
export interface SkyOptions {license: string; author: string; source: string}
/** The sun from a panorama: the centroid of its brightest 0.1 % above the horizon (on a 512 x 256 copy). */
export function panoramaSun(img: Rgba): [number, number, number] | null {
 const small = fitInside(img, 512), w = small.width, h = small.height, lum: Array<[number, number]> = [];
 for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x++) {
  const o = (y * w + x) * 4;
  lum.push([0.2126 * small.data[o] + 0.7152 * small.data[o + 1] + 0.0722 * small.data[o + 2], y * w + x]);
 }
 lum.sort((a, b) => b[0] - a[0]);
 if (lum[0][0] < 200) return null; // no bright sun (overcast): keep the starter's
 const top = lum.slice(0, Math.max(4, Math.round(lum.length * 0.001))).filter(([l]) => l >= lum[0][0] * 0.9);
 const sum = [0, 0, 0];
 for (const [, i] of top) {const d = equirectDirection(((i % w) + 0.5) / w, (Math.floor(i / w) + 0.5) / h); for (let k = 0; k < 3; k++) sum[k] += d[k];}
 const l = Math.hypot(...sum);
 return [r4(sum[0] / l), r4(sum[1] / l), r4(sum[2] / l)];
}
export function setSky(folder: string, image: string, o: SkyOptions): Promise<{image: string; width: number; height: number; sun: number[] | null}> {
 return locked(folder, async () => {
  const bytes = readFileSync(image), mime = imageMime(bytes);
  if (!mime) fail('sky.invalid', 'The sky must be a PNG or JPEG image');
  let img: Rgba;
  try {img = decodeImage(bytes, mime);} catch (e: any) {return fail('sky.invalid', e.message);}
  if (Math.abs(img.width - 2 * img.height) > 2 || img.width < 1024 || img.width > 16384)
   fail('sky.invalid', `An equirectangular sky is 2:1 and 1,024 to 8,192 px wide (this one is ${img.width} x ${img.height})`);
  if (img.width > 8192) img = fitInside(img, 8192);
  for (const [k, v] of Object.entries(o)) if (!v?.trim() || v.length > (k === 'source' ? 1024 : 512)) fail('sky.invalid', `The sky needs its ${k}`);
  if (!validateManifest('project', {...readProject(folder), sky: {image: SKY, ...o}}, undefined, '0.11').valid) fail('sky.invalid', `${o.license} is not an SPDX licence expression`);
  writeFileSync(join(folder, SKY), mime === 'image/jpeg' && img.width <= 8192 && bytes.length < 32 * 1048576 ? bytes : encodeJpeg(img, 90));
  const sun = panoramaSun(img), base = readJson(join(folder, BASE));
  base.atmosphere.panorama = {...base.atmosphere.panorama, image: SKY};
  if (sun && sun[1] > 0.02) base.atmosphere.sky.sun.direction = sun;
  writeJson(join(folder, BASE), base);
  const project = readProject(folder);
  writeJson(join(folder, PROJECT), {...project, sky: {image: SKY, license: o.license.trim(), author: o.author.trim(), source: o.source.trim()}});
  return {image: SKY, width: img.width, height: img.height, sun};
 });
}

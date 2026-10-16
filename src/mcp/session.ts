// The MCP server's session (RFC-0016): the world folder in focus, the paired connection to core
// (the assistant profile; offline when Hyprune isn't running) and the journal of this
// session's changes with their inverses, for `undo`.
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {HypruneClient,RpcError} from '../client.js';
import {projectFolder,readProject,status,type Placement} from '../builder.js';

export const ASSISTANT_PROTOCOL = '0.33';
export class ToolError extends Error {
 constructor(public code: string, message: string, public hint?: string, public data?: Record<string, unknown>, public retryable = false) {super(message);}
}
export interface JournalEntry {
 /** What was done, in words ("placed cpu-tower"). */
 action: string; tool: string; at: string;
 /** The inverse: run by undo, newest first. Null for changes undo can't reverse (say so). */
 undo: null | (() => Promise<void>);
}

/** The control socket: HYPRUNE_SOCKET, else this Hyprland instance's, else the only one in the runtime directory. */
export function findSocket(env = process.env): string | null {
 if (env.HYPRUNE_SOCKET) return existsSync(env.HYPRUNE_SOCKET) ? env.HYPRUNE_SOCKET : null;
 const runtime = env.XDG_RUNTIME_DIR;
 if (!runtime || !runtime.startsWith('/')) return null;
 if (env.HYPRLAND_INSTANCE_SIGNATURE) {
  const p = join(runtime, 'hyprune', env.HYPRLAND_INSTANCE_SIGNATURE, 'control.sock');
  if (existsSync(p)) return p;
 }
 try {
  const all = readdirSync(join(runtime, 'hyprune')).map(d => join(runtime, 'hyprune', d, 'control.sock')).filter(existsSync);
  return all.length === 1 ? all[0] : null;
 } catch {return null;}
}

export class Session {
 agent = {name: 'an MCP client', version: undefined as string | undefined};
 folder: string | null = null;
 journal: JournalEntry[] = [];
 /** The journal's length at the last save (or discard), and whether the folder was saved when the first later change came. */
 savedLength = 0;
 cleanAfterSave = false;
 changes = 0;
 paused = false;
 private client: HypruneClient<any> | null = null;
 private connecting: Promise<HypruneClient<any> | null> | null = null;
 private offlineReason = 'Hyprune is not running';
 private ended = false;
 private closing = false;
 constructor(readonly o: {offline?: boolean; log?: (line: string) => void} = {}) {}
 log(line: string): void {(this.o.log ?? (l => process.stderr.write(`hyprune mcp: ${l}\n`)))(line);}

 /** Starts pairing at once (the user sees the prompt when the assistant starts), never throws. */
 warm(): void {if (!this.o.offline) this.core().catch(() => undefined);}
 /** The paired client, or null when Hyprune isn't running (the reason in offlineReason). */
 core(): Promise<HypruneClient<any> | null> {
  if (this.client && this.client.hello) return Promise.resolve(this.client);
  if (this.o.offline || this.ended) return Promise.resolve(null);
  if (this.connecting) return this.connecting;
  const socket = findSocket();
  if (!socket) {this.offlineReason = 'Hyprune is not running (no control socket)'; return Promise.resolve(null);}
  const client = new HypruneClient<any>({socket, protocol: ASSISTANT_PROTOCOL as any, client: {id: 'com.hyprune.mcp', name: 'Hyprune MCP server'},
   pair: {agent: {name: this.agent.name, ...(this.agent.version ? {version: this.agent.version} : {})}}, reconnect: false, capabilities: [],
   onPairing: () => this.log('waiting for the user to allow this assistant in Hyprune')});
  client.on('fault', e => this.log(`connection: ${e.message}`));
  // Hyprune closing the connection (the user pressed Disconnect, or Hyprune stopped) ends the
  // session's in-world access: never re-pair behind the user's back (a remembered approval would).
  client.on('disconnect', () => {
   if (this.client !== client || this.closing) return;
   this.client = null; this.ended = true;
   this.offlineReason = 'Hyprune disconnected this assistant';
   this.log(this.offlineReason);
  });
  this.connecting = client.connect().then(async () => {
   await client.subscribe();
   this.client = client;
   this.log(`paired with Hyprune (${client.hello?.protocol}, profile ${(client.hello as any)?.profile ?? 'none'})`);
   return client;
  }).catch((e: any) => {
   client.close();
   if (e instanceof RpcError && e.data?.rule === 'pair.denied') this.offlineReason = 'The user did not allow this assistant in Hyprune';
   else if (e instanceof RpcError && e.code === -32001) this.offlineReason = 'This Hyprune is too old for assistants (IPC 0.33 needed)';
   else this.offlineReason = `Hyprune did not answer (${String(e?.message ?? e).split('\n')[0]})`;
   this.log(this.offlineReason);
   return null;
  }).finally(() => {this.connecting = null;});
  return this.connecting;
 }
 /** The paired client or an assistant.offline tool error. */
 async online(): Promise<HypruneClient<any>> {
  const c = await this.core();
  if (!c) throw new ToolError('assistant.offline', `${this.offlineReason}: in-world tools need Hyprune`,
   this.ended ? 'Restart the assistant\'s Hyprune connection to pair again; world-folder tools still work' : 'World-folder tools (create, sky, floor, materials, save, look) still work', undefined, !this.ended);
  return c;
 }
 state(): any {return (this.client?.snapshot as any)?.state ?? null;}
 /** A core call; RpcErrors become tool errors with their rule and hint. Retries while an asset decodes. */
 async call(method: string, params: Record<string, unknown>): Promise<any> {
  const c = await this.online();
  for (let attempt = 0; ; attempt++) {
   try {return await c.call(method as never, params as never);}
   catch (e: any) {
    if (e instanceof RpcError) {
     if (e.data?.retryable && attempt < 40 && !['assistant.paused', 'assistant.limit', 'preview.limit'].includes(String(e.data?.rule))) {await new Promise(r => setTimeout(r, 250)); continue;}
     throw new ToolError(String(e.data?.rule ?? `ipc.${e.code}`), e.message, e.data?.hint, {code: e.code, ...(e.data?.id ? {id: e.data.id} : {})}, !!e.data?.retryable);
    }
    throw e;
   }
  }
 }

 // ---- the folder in focus ----
 /** The folder named, else the one in focus, else the one Hyprune has open. */
 folderOf(project?: unknown): string {
  if (typeof project === 'string' && project) {
   try {return projectFolder(project);}
   catch (e: any) {throw new ToolError('project.unknown', e.message, 'world_list names your world folders');}
  }
  const open = this.state()?.builder;
  if (!this.folder && open?.projectId) try {this.folder = projectFolder(open.projectId);} catch {/* not ours */}
  if (!this.folder) throw new ToolError('project.none', 'No world folder is open', 'world_create makes one; world_open opens one');
  return this.folder;
 }
 /** In-world tools act on the folder Hyprune has loaded; it must be the one in focus. */
 async loadedFolder(): Promise<{folder: string; slug: string}> {
  await this.online();
  const b = this.state()?.builder, folder = this.folderOf();
  const slug = status(folder).projectId;
  if (!b || b.projectId !== slug) throw new ToolError('world.not_open', `Hyprune has ${b ? `${b.name} open` : 'no world folder open'}, not ${slug}`, 'world_open opens it in Hyprune');
  return {folder, slug};
 }
 placements(folder: string): Placement[] {return readProject(folder).placements;}
 instance(idOrKey: string): any {
  const list = this.state()?.objects?.instances ?? [];
  return list.find((i: any) => i.key === idOrKey) ?? list.find((i: any) => i.id === idOrKey) ?? null;
 }

 // ---- journal and the HUD's Assistant chip ----
 /** Set by the tool runner before each call: whether the folder had no unsaved changes then. */
 cleanBeforeCall = false;
 async record(entry: Omit<JournalEntry, 'at'>): Promise<void> {
  if (this.journal.length <= this.savedLength) {this.savedLength = this.journal.length; this.cleanAfterSave = this.cleanBeforeCall;}
  this.journal.push({...entry, at: new Date().toISOString()});
  if (this.journal.length > 256) this.journal.shift();
  this.changes++;
  await this.report(entry.action);
 }
 async report(action?: string): Promise<void> {
  const c = this.client;
  if (!c?.hello) return;
  try {
   const r: any = await c.call('assistant.report' as never, {changes: this.changes, ...(action ? {action: action.slice(0, 128)} : {})} as never);
   this.paused = !!r?.paused;
  } catch {/* informational */}
 }
 /** Refuses changes while the user has paused the assistant (folder changes too, not only core's). */
 async checkPaused(): Promise<void> {
  if (!this.client?.hello) return;
  await this.report();
  if (this.paused) throw new ToolError('assistant.paused', 'The user paused the assistant', 'Wait until they resume it in Hyprune', undefined, true);
 }
 close(): void {this.closing = true; this.client?.close();}
}

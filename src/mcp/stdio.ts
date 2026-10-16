// The Model Context Protocol over stdio (RFC-0016: `hyprune mcp`, any MCP client): JSON-RPC 2.0
// messages, one per line, on stdin and stdout; logs on stderr only. A small implementation of
// the transport and the lifecycle (initialize, ping, tools, resources, prompts), so the SDK
// adds no dependency for it; tests drive it with a plain client.
import {createInterface} from 'node:readline';

/** Protocol revisions this server speaks, newest first. */
export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export interface McpTool {name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>}
export type McpContent = {type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string};
export interface McpToolResult {content: McpContent[]; isError?: boolean; structuredContent?: Record<string, unknown>}
export interface McpHandlers {
 info: {name: string; title?: string; version: string};
 instructions?: string;
 initialized?: (client: {name: string; version?: string}, protocol: string) => void;
 tools: () => McpTool[];
 call: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
 resources?: () => Array<{uri: string; name: string; description?: string; mimeType?: string}>;
 read?: (uri: string) => Promise<{uri: string; mimeType: string; text: string}>;
 prompts?: () => Array<{name: string; description?: string; arguments?: Array<{name: string; description?: string; required?: boolean}>}>;
 prompt?: (name: string, args: Record<string, string>) => Promise<{description?: string; messages: Array<{role: 'user' | 'assistant'; content: McpContent}>}>;
}
class McpError extends Error { constructor(public code: number, message: string) {super(message);} }

/** Serves MCP on the given streams until the input ends. Requests run concurrently; answers keep their ids. */
export function serveMcp(h: McpHandlers, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
 const write = (m: unknown) => {output.write(JSON.stringify(m) + '\n');};
 let initialized = false;
 const handle = async (method: string, params: any): Promise<unknown> => {
  if (method === 'initialize') {
   const asked = String(params?.protocolVersion ?? ''), version = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
   initialized = true;
   h.initialized?.({name: String(params?.clientInfo?.name ?? 'an MCP client').slice(0, 64), version: params?.clientInfo?.version ? String(params.clientInfo.version).slice(0, 32) : undefined}, version);
   return {protocolVersion: version, serverInfo: h.info,
    capabilities: {tools: {listChanged: false}, ...(h.resources ? {resources: {listChanged: false}} : {}), ...(h.prompts ? {prompts: {listChanged: false}} : {})},
    ...(h.instructions ? {instructions: h.instructions} : {})};
  }
  if (method === 'ping') return {};
  if (!initialized) throw new McpError(-32002, 'Server not initialized');
  if (method === 'tools/list') return {tools: h.tools()};
  if (method === 'tools/call') {
   const name = String(params?.name ?? ''), args = params?.arguments ?? {};
   if (!h.tools().some(t => t.name === name)) throw new McpError(-32602, `Unknown tool: ${name}`);
   if (typeof args !== 'object' || Array.isArray(args)) throw new McpError(-32602, 'arguments must be an object');
   return h.call(name, args);
  }
  if (method === 'resources/list' && h.resources) return {resources: h.resources()};
  if (method === 'resources/templates/list' && h.resources) return {resourceTemplates: []};
  if (method === 'resources/read' && h.read) return {contents: [await h.read(String(params?.uri ?? ''))]};
  if (method === 'prompts/list' && h.prompts) return {prompts: h.prompts()};
  if (method === 'prompts/get' && h.prompt) return h.prompt(String(params?.name ?? ''), params?.arguments ?? {});
  throw new McpError(-32601, `Method not found: ${method}`);
 };
 return new Promise(resolve => {
  const lines = createInterface({input, crlfDelay: Infinity});
  const pending = new Set<Promise<void>>();
  lines.on('line', line => {
   if (!line.trim()) return;
   let m: any;
   try {m = JSON.parse(line);} catch {write({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); return;}
   if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    if (m && 'id' in m && !('method' in m)) return; // a response to nothing we sent
    write({jsonrpc: '2.0', id: m?.id ?? null, error: {code: -32600, message: 'Invalid request'}}); return;
   }
   if (!('id' in m)) return; // notifications (initialized, cancelled): nothing to answer
   const job = handle(m.method, m.params ?? {})
    .then(result => write({jsonrpc: '2.0', id: m.id, result}))
    .catch((e: any) => write({jsonrpc: '2.0', id: m.id, error: {code: e instanceof McpError ? e.code : -32603, message: String(e?.message ?? e).split('\n')[0]}}))
    .finally(() => pending.delete(job));
   pending.add(job);
  });
  lines.on('close', () => {Promise.allSettled([...pending]).then(() => resolve());});
 });
}

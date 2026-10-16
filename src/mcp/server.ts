// `hyprune mcp` (RFC-0016): the MCP server any assistant can start over stdio. It pairs with
// Hyprune (the user approves it once, or always) and exposes end-user building operations only.
import {cpSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {serveMcp} from './stdio.js';
import {Session} from './session.js';
import {TOOLS,describeWorld,runTool} from './tools.js';
import {SHAPES,DEFAULT_SIZES,listMaterials,materialsDirOf} from '../primitives.js';

export const mcpHelp = `hyprune mcp [--offline] [--project P]
    An MCP server over stdio for AI assistants (RFC-0016): build worlds in Hyprune.
    Add it to an MCP client as the command "hyprune mcp". It asks Hyprune to pair (you allow
    it once or always in the HUD); without Hyprune it still edits world folders.
hyprune mcp --install-skill DIR   copy the hyprune-world-builder skill (SKILL.md and examples) into DIR`;

const SKILL_DIR = new URL('../../../skills/hyprune-world-builder/', import.meta.url).pathname;
export function skillText(): string {
 const read = (f: string) => readFileSync(join(SKILL_DIR, f), 'utf8');
 const body = read('SKILL.md').replace(/^---[\s\S]*?---\n/, '');
 const examples = readdirSync(join(SKILL_DIR, 'examples')).sort().map(f => read(join('examples', f)));
 return `${body}\n\n${examples.join('\n\n')}`;
}
const VERSION = (() => {try {return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;} catch {return '0.0.0';}})();

export async function mcpMain(argv: string[]): Promise<void> {
 const {values: v} = parseArgs({args: argv.slice(1), options: {offline: {type: 'boolean'}, project: {type: 'string'}, 'install-skill': {type: 'string'}, help: {type: 'boolean', short: 'h'}}});
 if (v.help) {console.log(mcpHelp); return;}
 if (v['install-skill']) {
  const target = resolve(v['install-skill'], 'hyprune-world-builder');
  cpSync(SKILL_DIR, target, {recursive: true});
  console.log(`installed the hyprune-world-builder skill in ${target}`);
  return;
 }
 const session = new Session({offline: !!v.offline});
 if (v.project) try {session.folder = session.folderOf(v.project);} catch (e: any) {session.log(e.message);}
 const shutdown = () => {session.close(); process.exit(0);};
 process.once('SIGTERM', shutdown);
 await serveMcp({
  info: {name: 'hyprune', title: 'Hyprune world builder', version: VERSION},
  instructions: 'Build and change Hyprune worlds (world folders): shapes, materials, catalog objects, workspace screens, data-driven behaviours, sky and floor. Plan first, build in passes, look and read the checklist after each pass; place with keys and ifExists "update". Changes stay unsaved until save; undo reverses your steps; releasing is the user\'s. The build_a_world prompt has the full method.',
  initialized: client => {session.agent = {name: client.name, version: client.version}; session.warm();},
  tools: () => TOOLS.map(({run, ...t}) => t),
  call: (name, args) => runTool(name, args, session),
  resources: () => [
   {uri: 'hyprune://world/current', name: 'The world in focus', description: 'world_describe of the folder in focus', mimeType: 'application/json'},
   {uri: 'hyprune://catalog', name: 'Shapes and materials', description: 'The shapes with default sizes and the folder\'s materials', mimeType: 'application/json'},
   {uri: 'hyprune://guide/building', name: 'Building guide', description: 'How to plan, build and check a world', mimeType: 'text/markdown'},
  ],
  read: async uri => {
   if (uri === 'hyprune://world/current') return {uri, mimeType: 'application/json', text: JSON.stringify(describeWorld(session, session.folderOf()))};
   if (uri === 'hyprune://catalog') {
    let materials: unknown[] = [];
    try {materials = listMaterials(materialsDirOf(session.folderOf()));} catch {/* no folder */}
    return {uri, mimeType: 'application/json', text: JSON.stringify({shapes: SHAPES.map(s => ({shape: s, defaultSize: DEFAULT_SIZES[s]})), materials})};
   }
   if (uri === 'hyprune://guide/building') return {uri, mimeType: 'text/markdown', text: skillText()};
   throw new Error(`Unknown resource ${uri}`);
  },
  prompts: () => [{name: 'build_a_world', description: 'Turn a description into a planned, built and checked Hyprune world', arguments: [{name: 'description', description: 'What the world should be', required: true}]}],
  prompt: async (name, args) => {
   if (name !== 'build_a_world') throw new Error(`Unknown prompt ${name}`);
   return {description: 'Plan, build and check a Hyprune world', messages: [{role: 'user', content: {type: 'text', text: `${skillText()}\n\n---\n\nThe user's request: ${String(args.description ?? '').slice(0, 4000)}`}}]};
  },
 });
 session.close();
}
export const skillDir = () => existsSync(SKILL_DIR) ? SKILL_DIR : null;

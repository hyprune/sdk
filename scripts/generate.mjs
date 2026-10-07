// Deliberately small, deterministic generator for the pinned schemas, not a
// general JSON Schema compiler. Reject new constructs rather than erasing types.
import {readFileSync, writeFileSync} from 'node:fs';
const names = ['common','ipc','world','extension','screen-type'];
const docs = Object.fromEntries(names.map(n => [n, JSON.parse(readFileSync(`vendor/schema/v0/${n}.schema.json`))]));
docs.mock = JSON.parse(readFileSync('contracts/mock.schema.json'));
const ident = s => s.split(/[^A-Za-z0-9]+/).map(p=>p[0]?.toUpperCase()+p.slice(1)).join('');
const refName = (file, def) => ident(file)+'_'+ident(def || 'Document');
function type(s, file) {
  if (s.$ref) {
    const [path, fragment] = s.$ref.split('#');
    return refName(path ? path.split('/').at(-1).replace('.schema.json','') : file, fragment?.split('/').at(-1));
  }
  if ('const' in s) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(JSON.stringify).join(' | ');
  if (s.allOf) return "("+s.allOf.map(x=>type(x,file)).join(" & ")+")";
  if (s.oneOf || s.anyOf) return '('+(s.oneOf || s.anyOf).map(x=>type(x,file)).join(' | ')+')';
  if (s.type === 'object') {
    const props = Object.entries(s.properties || {}).map(([k,v]) => `${JSON.stringify(k)}${s.required?.includes(k)?'':'?'}: ${type(v,file)}`).join('; ');
    if (s.additionalProperties && typeof s.additionalProperties === 'object') return `Record<string, ${type(s.additionalProperties,file)}>`;
    return props ? `{ ${props} }` : s.additionalProperties===false?'Record<string, never>':'Record<string, unknown>';
  }
  if (s.type === 'array') {
    if (s.minItems === s.maxItems && Number.isInteger(s.minItems)) return '['+Array(s.minItems).fill(type(s.items,file)).join(', ')+']';
    return `Array<${type(s.items,file)}>`;
  }
  if (['string','boolean','number','null'].includes(s.type)) return s.type;
  if (s.type === 'integer') return 'number';
  if (!Object.keys(s).some(k=>!['description','title','$schema','$id','$defs'].includes(k))) return 'unknown';
  throw new Error(`Unhandled schema in ${file}: ${JSON.stringify(s)}`);
}
let output = '// Generated from vendor/schema; do not edit. Run npm run generate.\n';
for (const [name,doc] of Object.entries(docs)) {
  output += `export type ${refName(name)} = ${type(doc,name)};\n`;
  for (const [key,s] of Object.entries(doc.$defs || {})) output += `export type ${refName(name,key)} = ${type(s,name)};\n`;
}
writeFileSync('src/generated.ts',output);
let maps='\nexport interface MethodMap {\n';
for(const [key] of Object.entries(docs.ipc.$defs).filter(([k])=>k.endsWith('.params'))) {
 const method=key.slice(0,-7); maps+=`  '${method}': {params: Ipc_${ident(key)}; result: Ipc_${ident(method+'.result')}};\n`;
}
maps+='}\nexport interface MockMethodMap extends Omit<MethodMap, "session.hello"> {\n';
for(const method of ['session.hello','camera.set','waypoint.set','ui.open','data.publish']) maps+=`  '${method}': {params: Mock_${ident(method+'.params')}; result: Mock_${ident(method+'.result')}};\n`;
maps+='}\n';
writeFileSync('src/generated.ts',output+maps);

// Deliberately small, deterministic generator for the pinned schemas, not a
// general JSON Schema compiler. Reject new constructs rather than erasing types.
import {readFileSync, writeFileSync} from 'node:fs';
const names = ['common','ipc','world','extension','screen-type'];
const docs = Object.fromEntries(names.map(n => [n, JSON.parse(readFileSync(`vendor/schema/v0/${n}.schema.json`))]));
for (const name of ['common','world','ipc']) docs[name+'02']=JSON.parse(readFileSync(`vendor/schema/v0.2/${name}.schema.json`));
for (const name of ['common','ipc']) docs[name+'03']=JSON.parse(readFileSync(`vendor/schema/v0.3/${name}.schema.json`));
for(const v of ['04','05'])for (const name of ['common','ipc'])docs[name+v]=JSON.parse(readFileSync(`vendor/schema/v0.${Number(v)}/${name}.schema.json`));
const ident = s => s.split(/[^A-Za-z0-9]+/).map(p=>p[0]?.toUpperCase()+p.slice(1)).join('');
const refName = (file, def) => ident(file)+'_'+ident(def || 'Document');
function type(s, file) {
  if (s.$ref) {
    const [path, fragment] = s.$ref.split('#');
    const target=path ? path.split('/').at(-1).replace('.schema.json','')+(file.endsWith('05') && !path?.includes('/v0.2/') ? '05' : file.endsWith('04') && !path?.includes('/v0.2/') ? '04' : file.endsWith('03') && !path?.includes('/v0.2/') ? '03' : file.endsWith('02') || path?.includes('/v0.2/') ? '02' : '') : file;
    return refName(target, fragment?.split('/').at(-1));
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
for (const [name,doc] of Object.entries(docs)) for(const [key,s] of Object.entries(doc.properties || {})) output += `export type ${refName(name,key)} = ${type(s,name)};\n`;
for (const [name,map] of [['ipc','LegacyMethodMap'],['ipc02','MethodMap'],['ipc03','SessionMethodMap'],['ipc04','MountMethodMap'],['ipc05','HandsMethodMap']]) {
 output+=`\nexport interface ${map} {\n`;
 for(const key of Object.keys(docs[name].$defs).filter(k=>k.endsWith('.params'))) {
  const method=key.slice(0,-7); output+=`  '${method}': {params: ${refName(name,key)}; result: ${refName(name,method+'.result')}};\n`;
 }
 output+='}\n';
}
output+="export interface ProtocolMethods {'0.1':LegacyMethodMap; '0.2':MethodMap; '0.3':SessionMethodMap; '0.4':MountMethodMap; '0.5':HandsMethodMap}\n";
writeFileSync('src/generated.ts',output);

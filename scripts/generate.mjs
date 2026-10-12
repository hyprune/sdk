// Deliberately small, deterministic generator for the pinned schemas, not a
// general JSON Schema compiler. Reject new constructs rather than erasing types.
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {withHeader} from './readme-header.mjs';
const names = ['common','ipc','world','extension','screen-type'];
const docs = Object.fromEntries(names.map(n => [n, JSON.parse(readFileSync(`vendor/schema/v0/${n}.schema.json`))]));
for (const name of ['common','world','ipc']) docs[name+'02']=JSON.parse(readFileSync(`vendor/schema/v0.2/${name}.schema.json`));
for (const name of ['common','ipc']) docs[name+'03']=JSON.parse(readFileSync(`vendor/schema/v0.3/${name}.schema.json`));
for(const v of ['04','05','06'])for (const name of ['common','ipc'])docs[name+v]=JSON.parse(readFileSync(`vendor/schema/v0.${Number(v)}/${name}.schema.json`));
// Vendored IPC pins come from the schema directories, never a hand list (AGENTS rule 6).
const minor = v => Number(v.split('.')[1]);
const ipcVersions = ['0.1', ...readdirSync('vendor/schema').filter(d => /^v0\.\d+$/.test(d) && existsSync(`vendor/schema/${d}/ipc.schema.json`))
  .map(d => d.slice(1)).sort((a, b) => minor(a) - minor(b))];
const docName = v => v === '0.1' ? 'ipc' : 'ipc' + String(minor(v)).padStart(2, '0');
for (const v of ipcVersions.filter(v => minor(v) >= 7)) docs[docName(v)] = JSON.parse(readFileSync(`vendor/schema/v${v}/ipc.schema.json`));
docs.common07=JSON.parse(readFileSync('vendor/schema/v0.7/common.schema.json'));
docs.common08=JSON.parse(readFileSync('vendor/schema/v0.8/common.schema.json'));
docs.common09=JSON.parse(readFileSync('vendor/schema/v0.9/common.schema.json'));
docs.world09=JSON.parse(readFileSync('vendor/schema/v0.9/world.schema.json'));
docs.world08=JSON.parse(readFileSync('vendor/schema/v0.8/world.schema.json'));
docs.world07=JSON.parse(readFileSync('vendor/schema/v0.7/world.schema.json'));
docs.world06=JSON.parse(readFileSync('vendor/schema/v0.6/world.schema.json'));
docs.world05=JSON.parse(readFileSync('vendor/schema/v0.5/world.schema.json'));
docs.world04=JSON.parse(readFileSync('vendor/schema/v0.4/world.schema.json'));
// Object, library and library release record schemas (RFC-0011) are discovered the same way;
// they share the world format numbering (object09 = v0.9/object.schema.json).
for (const kind of ['object','library','library-releases']) for (const d of readdirSync('vendor/schema').filter(d => /^v0\.\d+$/.test(d) && existsSync(`vendor/schema/${d}/${kind}.schema.json`)).sort((a, b) => minor(a.slice(1)) - minor(b.slice(1))))
  docs[kind + String(minor(d.slice(1))).padStart(2, '0')] = JSON.parse(readFileSync(`vendor/schema/${d}/${kind}.schema.json`));
// Registry documents (RFC-0015) are versioned on their own under registry/v0.N/; keys keep the
// cross-file $ref names (index01 = registry/v0.1/index.schema.json).
for (const d of existsSync('vendor/schema/registry') ? readdirSync('vendor/schema/registry').filter(d => /^v0\.\d+$/.test(d)).sort((a, b) => minor(a.slice(1)) - minor(b.slice(1))) : [])
  for (const kind of ['index','release-record','sources']) if (existsSync(`vendor/schema/registry/${d}/${kind}.schema.json`))
    docs[kind + String(minor(d.slice(1))).padStart(2, '0')] = JSON.parse(readFileSync(`vendor/schema/registry/${d}/${kind}.schema.json`));
const ident = s => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(p=>p[0]?.toUpperCase()+p.slice(1)).join('');
const refName = (file, def) => ident(file)+'_'+ident(def || 'Document');
function type(s, file) {
  if (s.$ref) {
    const [path, fragment] = s.$ref.split('#');
    const explicitVersion = path?.match(/\/v0\.(\d+)\//)?.[1];
    const suffix = explicitVersion ? String(explicitVersion).padStart(2,'0') : file.match(/([0-9]{2})$/)?.[1] || '';
    const target=path ? path.split('/').at(-1).replace('.schema.json','')+suffix : file;
    return refName(target, fragment?.split('/').at(-1));
  }
  if ('const' in s) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(JSON.stringify).join(' | ');
  // `not: {}` matches nothing (reserved names): the property can never be present.
  // A `not` beside declared properties only excludes combinations of them (e.g. at most one
  // of clip/face/seat): a value refinement, not a TypeScript shape.
  if ('not' in s && s.properties && Object.keys(s.not).length) {
    const members=s.not.anyOf || s.not.oneOf || [s.not], declared=Object.keys(s.properties);
    if (Object.keys(s.not).some(k=>!['anyOf','oneOf','properties','required'].includes(k)) || members.some(m=>Object.keys(m).some(k=>!['properties','required'].includes(k)) ||
      [...Object.keys(m.properties || {}),...(m.required || [])].some(k=>!declared.includes(k)))) throw new Error(`Unhandled not in ${file}: ${JSON.stringify(s)}`);
    const {not,...rest}=s; return type(rest,file);
  }
  if ('not' in s) {
    if (Object.keys(s.not).length || Object.keys(s).some(k=>!['not','description','title'].includes(k))) throw new Error(`Unhandled not in ${file}: ${JSON.stringify(s)}`);
    return 'never';
  }
  if (s.allOf) {
    const {allOf,...base}=s;
    // An if/then(/else) member only makes properties the parent already declares required
    // or narrows their values (e.g. `values` when type is enum, no stops on generic paths);
    // it refines values, not the TypeScript shape.
    const refinement=x=>{
      if (!('if' in x)) return false;
      const declared=Object.keys(base.properties || {});
      const branches=[x.then || {},x.else || {}];
      if (Object.keys(x).some(k=>!['if','then','else'].includes(k)) || branches.some(b=>Object.keys(b).some(k=>!['properties','required'].includes(k)) ||
        [...Object.keys(b.properties || {}),...(b.required || [])].some(k=>!declared.includes(k)))) throw new Error(`Unhandled if/then in ${file}: ${JSON.stringify(x)}`);
      return true;
    };
    const parts=allOf.filter(x=>!refinement(x)).map(x=>type(x,file));
    if (base.type || base.properties) parts.unshift(type(base,file));
    return parts.length===1 ? parts[0] : "("+parts.join(" & ")+")";
  }
  if (s.oneOf || s.anyOf) {
    const {oneOf,anyOf,...base}=s;
    // A member with only bounds (e.g. {minimum, maximum}) takes the base type.
    const typed=x=>base.type && !['type','$ref','const','enum','properties','oneOf','anyOf','allOf','items'].some(k=>k in x)?{...x,type:base.type}:x;
    const union='('+(oneOf || anyOf).map(x=>type(typed(x),file)).join(' | ')+')';
    return base.type || base.properties ? '('+type(base,file)+' & '+union+')' : union;
  }
  if(Array.isArray(s.type))return s.type.map(t=>type({...s,type:t},file)).join(' | ');
  if (s.type === 'object' || s.properties) {
    // propertyNames only constrains string keys further; TypeScript keys stay strings.
    if (s.propertyNames && Object.keys(s.propertyNames).some(k=>!['type','minLength','maxLength','pattern','$ref'].includes(k))) throw new Error(`Unhandled propertyNames in ${file}: ${JSON.stringify(s.propertyNames)}`);
    const props = Object.entries(s.properties || {}).map(([k,v]) => `${JSON.stringify(k)}${s.required?.includes(k)?'':'?'}: ${type(v,file)}`).join('; ');
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      const record=`Record<string, ${type(s.additionalProperties,file)}>`;
      // Named properties beside a typed map (e.g. required clips): both apply.
      return props && s.required?.length ? `({ ${props} } & ${record})` : record;
    }
    return props ? `{ ${props} }` : s.additionalProperties===false?'Record<string, never>':'Record<string, unknown>';
  }
  if (s.type === 'array') {
    if (s.minItems === s.maxItems && Number.isInteger(s.minItems)) return '['+Array(s.minItems).fill(type(s.items || {},file)).join(', ')+']';
    return `Array<${type(s.items || {},file)}>`;
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
// Each supported IPC version has a deliberately named method map: the SDK's API
// surface. Every vendored pin must have one, and PROTOCOLS follows this table.
const methodMaps = {'0.1':'LegacyMethodMap','0.2':'MethodMap','0.3':'SessionMethodMap','0.4':'MountMethodMap','0.5':'HandsMethodMap','0.6':'KeymapMethodMap','0.7':'GraphicsMethodMap','0.8':'HoldMethodMap','0.9':'HudMethodMap','0.10':'PerformanceMethodMap','0.11':'ClimbingMethodMap','0.12':'RecordingMethodMap','0.13':'AuthoringMethodMap','0.14':'InkMethodMap','0.15':'PlacementMethodMap','0.16':'UpscalerMethodMap','0.17':'CaptureNotesMethodMap','0.18':'OffloadDeviceMethodMap','0.19':'PlayerMethodMap','0.20':'PocketMethodMap','0.21':'QuestMethodMap','0.22':'ObjectsMethodMap','0.23':'NpcsMethodMap','0.24':'LiveMethodMap','0.25':'CompanionMethodMap'};
const unmapped = ipcVersions.filter(v => !methodMaps[v]), stale = Object.keys(methodMaps).filter(v => !ipcVersions.includes(v));
if (unmapped.length || stale.length) throw new Error(`IPC method maps out of sync with vendored pins: add ${unmapped.join(', ') || '-'}; remove ${stale.join(', ') || '-'}`);
for (const [name,map] of ipcVersions.map(v => [docName(v), methodMaps[v]])) {
 output+=`\nexport interface ${map} {\n`;
 for(const key of Object.keys(docs[name].$defs).filter(k=>k.endsWith('.params') && docs[name].$defs[k.slice(0,-7)+'.result'])) {
  const method=key.slice(0,-7); output+=`  '${method}': {params: ${refName(name,key)}; result: ${refName(name,method+'.result')}};\n`;
 }
 output+='}\n';
}
output+='export interface ProtocolMethods {'+ipcVersions.map(v => `'${v}':${methodMaps[v]}`).join('; ')+'}\n';
output+='export const PROTOCOLS = ['+ipcVersions.map(v => `'${v}'`).join(',')+'] as const;\n';
writeFileSync('src/generated.ts',output);
writeFileSync('README.md',withHeader(readFileSync('README.md','utf8')));

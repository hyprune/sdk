// `hyprune builder primitive|material|materials|rebuild PROJECT …` (a world folder) and
// `hyprune object primitive|material|materials …` (the user's folders, for any world): the same
// commands over two places. --json writes JSON lines ({event: done|error}) like `builder`.
import {parseArgs} from 'node:util';
import {join} from 'node:path';
import {DEFAULT_SIZES,SHAPES,listMaterials,materialsDirOf,plainMaterial,resolveMaterial,setMaterial,stalePrimitives,userMaterialsDir,writePrimitive,
 type MaterialPatch,type Shape} from './primitives.js';
import {validateObject} from './object.js';
import {objectDir} from './paths.js';
import {readFileSync} from 'node:fs';

export const primitiveHelp=`hyprune builder primitive PROJECT --shape ${SHAPES.join('|')} [--size X,Y,Z] [--steps N]
    [--material KEY | --colour #rrggbb [--emissive #rrggbb --emissive-strength N] [--roughness R] [--metallic M]] [--dry-run] [--json]
      Writes objects/<shape>-<digest>/ (the same request gives the same folder); place it with objects.place world/<id>.
      KEY is a material in materials/, or a built-in texture (grid, grass, sand, paving, concrete), copied in on first use.
hyprune builder material PROJECT KEY [--name N] [--colour #rrggbb] [--texture FILE --license SPDX --author A --source S | --texture-preset ID | --no-texture]
    [--tile M] [--emissive #rrggbb --emissive-strength N | --no-emissive] [--roughness R] [--metallic M] [--dry-run] [--json]
hyprune builder materials PROJECT [--json]
hyprune builder rebuild PROJECT [--material KEY] [--json]
      Rebuilds primitives whose material changed; answers {swaps: [{from, to}]} for objects.configure {ref}.
hyprune object primitive|material|materials …  The same in your own folders ($XDG_DATA_HOME/hyprune/objects, …/materials), for any world.`;

const OPTIONS={help:{type:'boolean',short:'h'},json:{type:'boolean'},shape:{type:'string'},size:{type:'string'},steps:{type:'string'},material:{type:'string'},
 colour:{type:'string'},color:{type:'string'},emissive:{type:'string'},'emissive-strength':{type:'string'},roughness:{type:'string'},metallic:{type:'string'},
 name:{type:'string'},texture:{type:'string'},'texture-preset':{type:'string'},'no-texture':{type:'boolean'},'no-emissive':{type:'boolean'},tile:{type:'string'},
 license:{type:'string'},author:{type:'string'},source:{type:'string'},'dry-run':{type:'boolean'}} as const;

export interface Place {objects:string;materials:string;refSource:'world'|'user'}
export const userPlace=():Place=>({objects:objectDir(),materials:userMaterialsDir(),refSource:'user'});
export const folderPlace=(folder:string):Place=>({objects:join(folder,'objects'),materials:materialsDirOf(folder),refSource:'world'});

function sdkVersion():string {
 try {return JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;} catch {return '0.0.0';}
}
class UsageError extends Error {constructor(public code:string,message:string,public hint?:string){super(message);}}
const num=(text:string|undefined,what:string,code='primitive.invalid')=>{
 if(text===undefined) return undefined;
 const n=Number(text);if(text.trim()==='' || !Number.isFinite(n)) throw new UsageError(code,`${what} must be a number (not ${text})`);return n;
};
/** Runs one verb in a place; `args` are the arguments after the place (the project for builder). */
export async function primitiveCommand(place:Place,verb:string,args:string[]):Promise<unknown> {
 const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:OPTIONS as any}) as {values:Record<string,any>;positionals:string[]};
 const dryRun=!!v['dry-run'];
 const emissive=()=>v['no-emissive']?null:v.emissive!==undefined?{colour:v.emissive,strength:num(v['emissive-strength'],'The glow strength','material.invalid') ?? 1}:undefined;
 if(verb==='materials') return {materials:listMaterials(place.materials)};
 if(verb==='material') {
  const key=p[0];
  if(!key) throw new UsageError('material.invalid','material needs a KEY (a slug like oak-planks)');
  const patch:MaterialPatch={};
  if(v.name!==undefined) patch.name=v.name;
  if((v.colour ?? v.color)!==undefined) patch.colour=v.colour ?? v.color;
  if(v.roughness!==undefined) patch.roughness=num(v.roughness,'The roughness','material.invalid');
  if(v.metallic!==undefined) patch.metallic=num(v.metallic,'The metalness','material.invalid');
  const e=emissive();if(e!==undefined) patch.emissive=e;
  if(v['no-texture']) patch.texture=null;
  else if(v['texture-preset']!==undefined) patch.texture={preset:v['texture-preset']};
  else if(v.texture!==undefined) patch.texture={path:v.texture,license:v.license ?? '',author:v.author ?? '',source:v.source ?? ''};
  if(v.tile!==undefined) patch.tile=num(v.tile,'The tile','material.invalid');
  const r=await setMaterial(place.materials,key,patch,{dryRun});
  // What the change makes stale: primitives made with the old content (rebuild swaps them).
  const stale=dryRun?[]:stalePrimitives(place.objects,key,await resolveMaterial(place.materials,key)).map(s=>s.id);
  return {...r,stale};
 }
 if(verb==='rebuild') {
  const version=sdkVersion(),swaps:Array<{from:string;to:string}>=[];
  const keys=v.material?[v.material]:listMaterials(place.materials).map(m=>m.key);
  for(const key of keys) {
   const material=await resolveMaterial(place.materials,key);
   for(const s of stalePrimitives(place.objects,key,material)) {
    const r=await writePrimitive(place.objects,place.refSource,{shape:s.shape,size:s.size,steps:s.steps},material,{version,validate:dir=>validateObject(dir)});
    swaps.push({from:`${place.refSource}/${s.id}`,to:r.ref});
   }
  }
  return {swaps};
 }
 if(verb==='primitive') {
  const shape=v.shape as Shape;
  if(!shape) throw new UsageError('primitive.invalid','primitive needs --shape',`Shapes: ${SHAPES.join(', ')}`);
  const size=v.size!==undefined?String(v.size).split(',').map(x=>Number(x)):(DEFAULT_SIZES as any)[shape];
  const steps=num(v.steps,'The number of steps');
  const colour=v.colour ?? v.color;
  if(v.material!==undefined && colour!==undefined) throw new UsageError('primitive.invalid','Give --material or --colour, not both');
  const material=v.material!==undefined?await resolveMaterial(place.materials,v.material)
   :plainMaterial({colour:colour ?? '#d8d8d8',emissive:emissive() ?? null,roughness:num(v.roughness,'The roughness','material.invalid'),metallic:num(v.metallic,'The metalness','material.invalid')});
  return writePrimitive(place.objects,place.refSource,{shape,size,...(steps!==undefined?{steps}:{})},material,{version:sdkVersion(),dryRun,validate:dir=>validateObject(dir)});
 }
 throw new UsageError('primitive.invalid',`Unknown command: ${verb}`);
}
/** Prints a verb's result (JSON lines with --json) or its error, as `builder` does. */
export async function primitiveMain(place:Place,verb:string,args:string[]):Promise<void> {
 const json=args.includes('--json');
 if(args.includes('--help') || args.includes('-h')){console.log(primitiveHelp);return;}
 try {
  const r:any=await primitiveCommand(place,verb,args);
  if(json) return void process.stdout.write(JSON.stringify({event:'done',result:r})+'\n');
  if(verb==='materials') return console.log(r.materials.map((m:any)=>`${m.key}  ${m.name}  ${m.colour}${m.textured?`, textured every ${m.tile} m`:''}`).join('\n') || 'no materials yet');
  if(verb==='material') return console.log(`${r.dryRun?'would ':''}${r.created?'create':'update'} ${r.material.key}${r.stale?.length?` (${r.stale.length} primitive(s) to rebuild)`:''}`);
  if(verb==='rebuild') return console.log(r.swaps.map((s:any)=>`${s.from} -> ${s.to}`).join('\n') || 'nothing to rebuild');
  console.log(`${r.dryRun?'would write':r.created?'wrote':'already there:'} ${r.ref} (${r.name})`);
 } catch(e:any) {
  if(!json){if(e?.hint) e.message+=`\n  ${e.hint}`;throw e;}
  process.stdout.write(JSON.stringify({event:'error',error:{message:String(e.message).split('\n')[0],code:e.code || 'primitive.failed',...(e.hint?{hint:e.hint}:{})}})+'\n');
  process.exitCode=1;
 }
}

// `hyprune builder`: world folders (RFC-0014 phase 1 as amended). --json writes JSON lines
// ({event: stage|done|error}) for the Director's Builder page, like `object import --json`.
import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {folderPlace,primitiveHelp,primitiveMain} from './primitive-cli.js';
import {checkProject,type CheckItem} from './check.js';
import {applyFloor,applySky,applySpawn,createProject,discard,history,listFloors,listProjects,listSkies,listStarters,make,projectFolder,release,save,setRemote,status,thumbnailsDir,
 BuilderError,type FloorChoice,type SkyChoice,type SpawnChoice,type Status} from './builder.js';

export const builderHelp=`hyprune builder create NAME [--starter open-plain] [SKY] [FLOOR] [SPAWN] [--if-exists suffix|error] [--dry-run]
    [--git-name N --git-email E] [--json]
      SKY:   --sky PRESET | --sky-image FILE --sky-license SPDX --sky-author A --sky-source S
      FLOOR: --floor PRESET | --floor-image FILE --floor-license SPDX --floor-author A --floor-source S; --tile METRES
      SPAWN: --spawn X,Y,Z; --yaw DEGREES (a heading: 0 faces -Z, 90 faces +X) | --facing sun|away|left|right
hyprune builder starters|skies|floors [--thumbnails DIR] [--json]
hyprune builder list [--json]
hyprune builder status PROJECT [--json]
hyprune builder make PROJECT [--json]
hyprune builder check PROJECT [--fresh] [--json]
    the checklist: spawn, screen approaches, walkable area, budgets, licences, official publishing
hyprune builder save PROJECT [-m MESSAGE] [--json]
hyprune builder discard PROJECT [PATH ...] [--dry-run] [--json]   (back to the last save; core reloads the folder)
hyprune builder history PROJECT [--limit N] [--json]
hyprune builder release PROJECT [VERSION] [--notes TEXT | --notes-file FILE] [--id ID] [--skip-check] [--json]
hyprune builder sky PROJECT (IMAGE --license SPDX --author A --source S | --preset ID) [--dry-run] [--json]
    IMAGE: an equirectangular PNG, JPEG, OpenEXR or Radiance HDR (tone mapped)
hyprune builder floor PROJECT (IMAGE --license SPDX --author A --source S | --preset ID | --tile METRES) [--tile METRES] [--dry-run] [--json]
hyprune builder spawn PROJECT [--at X,Y,Z] [--yaw DEGREES | --facing sun|away|left|right] [--dry-run] [--json]
hyprune builder remote PROJECT [URL | --clear] [--json]
${primitiveHelp}
  PROJECT is a world folder, its slug or its local.<slug> id; folders live in
  $HYPRUNE_PROJECTS_DIR (default $XDG_DATA_HOME/hyprune/projects).`;

const pendingText=(s:Status)=>s.pending.total?`${s.pending.total} unsaved change${s.pending.total===1?'':'s'}`:'saved';
function statusText(s:Status):string {
 return `${s.name} (${s.projectId}) ${s.version}, ${s.placements} placed, ${pendingText(s)}\n  ${s.folder}\n  last save: ${s.lastSave?`${s.lastSave.commit} ${s.lastSave.message.split('\n')[0]}`:'none'}\n  last version: ${s.lastVersion?.tag ?? 'none'}${s.remote?`\n  remote: ${s.remote.url}`:''}`;
}

export async function builderMain(argv:string[]):Promise<void> {
 // Primitives and materials (their own options): PROJECT, then the verb's arguments.
 if(['primitive','material','materials','rebuild'].includes(argv[1]) && !argv.includes('--help') && !argv.includes('-h')) {
  let folder:string;
  try {folder=projectFolder(argv[2] ?? '');}
  catch(e:any) {
   if(!argv.includes('--json')) throw e;
   process.stdout.write(JSON.stringify({event:'error',error:{message:String(e.message),code:e.code || 'project.unknown'}})+'\n');process.exitCode=1;return;
  }
  return primitiveMain(folderPlace(folder),argv[1],argv.slice(3));
 }
 const {values:v,positionals:p}=parseArgs({args:argv.slice(2),allowPositionals:true,options:{
  help:{type:'boolean',short:'h'},json:{type:'boolean'},message:{type:'string',short:'m'},notes:{type:'string'},'notes-file':{type:'string'},
  id:{type:'string'},license:{type:'string'},author:{type:'string'},source:{type:'string'},clear:{type:'boolean'},
  'git-name':{type:'string'},'git-email':{type:'string'},starter:{type:'string'},preset:{type:'string'},'dry-run':{type:'boolean'},
  sky:{type:'string'},'sky-image':{type:'string'},'sky-license':{type:'string'},'sky-author':{type:'string'},'sky-source':{type:'string'},
  floor:{type:'string'},'floor-image':{type:'string'},'floor-license':{type:'string'},'floor-author':{type:'string'},'floor-source':{type:'string'},
  tile:{type:'string'},spawn:{type:'string'},at:{type:'string'},yaw:{type:'string'},facing:{type:'string'},'if-exists':{type:'string'},thumbnails:{type:'string'},fresh:{type:'boolean'},'skip-check':{type:'boolean'},limit:{type:'string'}}});
 const verb=argv[1];
 if(v.help || !verb){console.log(builderHelp);return;}
 const line=(value:unknown):void=>{process.stdout.write(JSON.stringify(value)+'\n');};
 const done=(result:unknown,text:string)=>v.json?line({event:'done',result}):console.log(text);
 const need=(i:number,what:string)=>{if(!p[i]) throw new BuilderError('project.unknown',`builder ${verb} needs ${what}`);return p[i];};
 const num=(text:string|undefined,code:'floor.invalid'|'spawn.invalid',what:string)=>{
  if(text===undefined) return undefined;const n=Number(text);if(text.trim()==='' || !Number.isFinite(n)) throw new BuilderError(code,`${what} must be a number (not ${text})`);return n;};
 const vec=(text:string|undefined)=>{
  if(text===undefined) return undefined;const v=text.split(',').map(Number);
  if(v.length!==3 || v.some(x=>!Number.isFinite(x))) throw new BuilderError('spawn.invalid',`A position is X,Y,Z in metres (not ${text})`);return v;};
 const prov=(prefix:string)=>({license:(v as any)[prefix+'license'] ?? '',author:(v as any)[prefix+'author'] ?? '',source:(v as any)[prefix+'source'] ?? ''});
 const skyChoice=(image:string|undefined,preset:string|undefined,prefix:string):SkyChoice|undefined=>
  preset!==undefined?{preset}:image!==undefined?{image,...prov(prefix)}:undefined;
 const floorChoice=(image:string|undefined,preset:string|undefined,prefix:string):FloorChoice|undefined=>{
  const tile=num(v.tile,'floor.invalid','The tile');
  if(preset!==undefined) return {preset,...(tile!==undefined?{tile}:{})};
  if(image!==undefined) return {image,...prov(prefix),...(tile!==undefined?{tile}:{})};
  return tile!==undefined?{tile}:undefined;};
 const spawnChoice=(at:string|undefined):SpawnChoice|undefined=>{
  const position=vec(at),yaw=num(v.yaw,'spawn.invalid','The yaw'),facing=v.facing as SpawnChoice['facing'];
  return position || yaw!==undefined || facing?{...(position?{position}:{}),...(yaw!==undefined?{yaw}:{}),...(facing?{facing}:{})}:undefined;};
 const dryRun=!!v['dry-run'];
 try {
  switch(verb) {
   case 'create': {
    const identity=v['git-name'] || v['git-email']?{name:v['git-name'] ?? '',email:v['git-email'] ?? ''}:undefined;
    const ifExists=v['if-exists'];
    if(ifExists!==undefined && ifExists!=='suffix' && ifExists!=='error') throw new BuilderError('project.invalid','--if-exists is suffix or error');
    const o={identity,starter:v.starter,sky:skyChoice(v['sky-image'],v.sky,'sky-'),floor:floorChoice(v['floor-image'],v.floor,'floor-'),spawn:spawnChoice(v.spawn),ifExists:ifExists as 'suffix'|'error'|undefined};
    if(dryRun){const plan=await createProject(need(0,'a name'),{...o,dryRun:true});return done(plan,`would create ${plan.name} in ${plan.folder} (${plan.worldId})`);}
    const r=await createProject(need(0,'a name'),o);
    return done({...r,status:status(r.folder)},`created ${r.name} in ${r.folder} (${r.worldId})`);
   }
   case 'starters': {const r=listStarters();return done({starters:r},r.map(x=>`${x.id}  ${x.name}: ${x.description}`).join('\n'));}
   case 'skies': {const r=listSkies(v.thumbnails ?? thumbnailsDir());return done({skies:r},r.map(x=>`${x.id}  ${x.name}: ${x.description}`).join('\n'));}
   case 'floors': {const r=listFloors(v.thumbnails ?? thumbnailsDir());return done({floors:r},r.map(x=>`${x.id}  ${x.name} (${x.tile} m): ${x.description}`).join('\n'));}
   case 'floor': {
    const folder=projectFolder(need(0,'a project')),choice=floorChoice(p[1],v.preset,'');
    if(!choice) throw new BuilderError('floor.invalid','builder floor needs an image, --preset ID or --tile METRES');
    const r=await applyFloor(folder,choice,{dryRun});
    return done({...r,status:status(folder)},`${dryRun?'would set':'floor set:'} ${r.floor.preset ?? r.floor.image}, every ${r.floor.tile} m`);
   }
   case 'spawn': {
    const folder=projectFolder(need(0,'a project')),r=await applySpawn(folder,spawnChoice(v.at) ?? {},{dryRun});
    return done({...r,status:status(folder)},`${dryRun?'would put':'spawn at'} ${r.position.join(', ')} facing ${r.yaw}°`);
   }
   case 'list': {const r=listProjects();return done({projects:r},r.map(statusText).join('\n') || 'no world folders yet');}
   case 'status': {const r=status(projectFolder(need(0,'a project')));return done(r,statusText(r));}
   case 'make': {const r=await make(projectFolder(need(0,'a project')));return done({homes:r.homes,warnings:r.warnings},`made world.json: ${r.manifest.objects?.length ?? 0} objects, ${r.homes.length} homes`);}
   case 'check': {
    const r=await checkProject(projectFolder(need(0,'a project')),{cache:!v.fresh});
    const mark=(i:CheckItem)=>i.done?(i.level==='warning'?'!':'✓'):i.blocks?'✗':'!';
    return done(r,[`${r.ready?'ready to release':'not ready: blocking items are open'} (walkable ${r.walk.mainArea} m², ${r.walk.ms} ms)`,
     ...r.items.map(i=>`${mark(i)} ${i.label}: ${i.message}${i.hint && !i.done?`\n    ${i.hint}`:''}`)].join('\n'));
   }
   case 'discard': {
    const folder=projectFolder(need(0,'a project')),r=await discard(folder,{paths:p.slice(1),dryRun});
    return done({...r,status:status(folder)},`${dryRun?'would restore':'restored'} ${r.restored.length} and ${dryRun?'remove':'removed'} ${r.removed.length} file(s)`);
   }
   case 'history': {
    const r=history(projectFolder(need(0,'a project')),v.limit?Number(v.limit):50);
    return done({history:r},r.map(h=>`${h.commit.slice(0,12)} ${h.at} ${h.version?`v${h.version} `:''}${h.message}`).join('\n') || 'no saves');
   }
   case 'save': {
    const folder=projectFolder(need(0,'a project')),r=await save(folder,v.message ?? '');
    if(!v.json) for(const w of r.warnings) console.error('warning: '+w);
    return done({...r,status:status(folder)},`saved ${r.commit.slice(0,12)}: ${r.message}`);
   }
   case 'release': {
    const folder=projectFolder(need(0,'a project'));
    const notes=v['notes-file']?readFileSync(v['notes-file'],'utf8'):v.notes;
    const r=await release(folder,{version:p[1],notes,id:v.id,skipCheck:!!v['skip-check'],onStage:stage=>v.json?line({event:'stage',stage}):console.error(stage)});
    if(!v.json) for(const w of r.warnings) console.error('warning: '+w);
    return done({...r,status:status(folder)},`released ${r.tag} (${r.commit.slice(0,12)})${r.pushed?', pushed':''}${r.release?`: ${r.release}`:''}`);
   }
   case 'sky': {
    const folder=projectFolder(need(0,'a project'));
    const choice=v.preset!==undefined?{preset:v.preset}:{image:need(1,'an image or --preset ID'),...prov('')};
    const r=await applySky(folder,choice,{dryRun});
    return done({...r,status:status(folder)},`${dryRun?'would set the sky':'sky set'} (${r.preset ?? `${r.width} x ${r.height}`})`);
   }
   case 'remote': {
    const folder=projectFolder(need(0,'a project'));
    const r=v.clear?setRemote(folder,null):p[1]?setRemote(folder,p[1]):status(folder).remote;
    return done({remote:r,status:status(folder)},r?`origin ${r.url}`:'no remote');
   }
   default: throw new Error(`Unknown command: builder ${verb}\n${builderHelp}`);
  }
 } catch(e:any) {
  if(!v.json){if(e?.hint) e.message+=`\n  ${e.hint}`;throw e;}
  line({event:'error',error:{message:String(e.message).split('\n')[0],code:e.code || 'builder.failed',...(e.hint?{hint:e.hint}:{}),...(e.data?{data:e.data}:{})}});
  process.exitCode=1;
 }
}

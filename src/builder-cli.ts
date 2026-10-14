// `hyprune builder`: world folders (RFC-0014 phase 1 as amended). --json writes JSON lines
// ({event: stage|done|error}) for the Director's Builder page, like `object import --json`.
import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {createProject,listProjects,make,projectFolder,release,save,setRemote,setSky,status,BuilderError,type Status} from './builder.js';

export const builderHelp=`hyprune builder create NAME [--git-name N --git-email E] [--json]
hyprune builder list [--json]
hyprune builder status PROJECT [--json]
hyprune builder make PROJECT [--json]
hyprune builder save PROJECT [-m MESSAGE] [--json]
hyprune builder release PROJECT [VERSION] [--notes TEXT | --notes-file FILE] [--id ID] [--json]
hyprune builder sky PROJECT IMAGE --license SPDX --author A --source S [--json]
hyprune builder remote PROJECT [URL | --clear] [--json]
  PROJECT is a world folder, its slug or its local.<slug> id; folders live in
  $HYPRUNE_PROJECTS_DIR (default $XDG_DATA_HOME/hyprune/projects).`;

const pendingText=(s:Status)=>s.pending.total?`${s.pending.total} unsaved change${s.pending.total===1?'':'s'}`:'saved';
function statusText(s:Status):string {
 return `${s.name} (${s.projectId}) ${s.version}, ${s.placements} placed, ${pendingText(s)}\n  ${s.folder}\n  last save: ${s.lastSave?`${s.lastSave.commit} ${s.lastSave.message.split('\n')[0]}`:'none'}\n  last version: ${s.lastVersion?.tag ?? 'none'}${s.remote?`\n  remote: ${s.remote.url}`:''}`;
}

export async function builderMain(argv:string[]):Promise<void> {
 const {values:v,positionals:p}=parseArgs({args:argv.slice(2),allowPositionals:true,options:{
  help:{type:'boolean',short:'h'},json:{type:'boolean'},message:{type:'string',short:'m'},notes:{type:'string'},'notes-file':{type:'string'},
  id:{type:'string'},license:{type:'string'},author:{type:'string'},source:{type:'string'},clear:{type:'boolean'},
  'git-name':{type:'string'},'git-email':{type:'string'}}});
 const verb=argv[1];
 if(v.help || !verb){console.log(builderHelp);return;}
 const line=(value:unknown):void=>{process.stdout.write(JSON.stringify(value)+'\n');};
 const done=(result:unknown,text:string)=>v.json?line({event:'done',result}):console.log(text);
 const need=(i:number,what:string)=>{if(!p[i]) throw new BuilderError('project.unknown',`builder ${verb} needs ${what}`);return p[i];};
 try {
  switch(verb) {
   case 'create': {
    const identity=v['git-name'] || v['git-email']?{name:v['git-name'] ?? '',email:v['git-email'] ?? ''}:undefined;
    const r=await createProject(need(0,'a name'),{identity});
    return done({...r,status:status(r.folder)},`created ${r.name} in ${r.folder} (${r.worldId})`);
   }
   case 'list': {const r=listProjects();return done({projects:r},r.map(statusText).join('\n') || 'no world folders yet');}
   case 'status': {const r=status(projectFolder(need(0,'a project')));return done(r,statusText(r));}
   case 'make': {const r=await make(projectFolder(need(0,'a project')));return done({homes:r.homes,warnings:r.warnings},`made world.json: ${r.manifest.objects?.length ?? 0} objects, ${r.homes.length} homes`);}
   case 'save': {
    const folder=projectFolder(need(0,'a project')),r=await save(folder,v.message ?? '');
    if(!v.json) for(const w of r.warnings) console.error('warning: '+w);
    return done({...r,status:status(folder)},`saved ${r.commit.slice(0,12)}: ${r.message}`);
   }
   case 'release': {
    const folder=projectFolder(need(0,'a project'));
    const notes=v['notes-file']?readFileSync(v['notes-file'],'utf8'):v.notes;
    const r=await release(folder,{version:p[1],notes,id:v.id,onStage:stage=>v.json?line({event:'stage',stage}):console.error(stage)});
    if(!v.json) for(const w of r.warnings) console.error('warning: '+w);
    return done({...r,status:status(folder)},`released ${r.tag} (${r.commit.slice(0,12)})${r.pushed?', pushed':''}${r.release?`: ${r.release}`:''}`);
   }
   case 'sky': {
    const folder=projectFolder(need(0,'a project'));
    const r=await setSky(folder,need(1,'an image'),{license:v.license ?? '',author:v.author ?? '',source:v.source ?? ''});
    return done({...r,status:status(folder)},`sky set (${r.width} x ${r.height})${r.sun?', sun from the panorama':''}`);
   }
   case 'remote': {
    const folder=projectFolder(need(0,'a project'));
    const r=v.clear?setRemote(folder,null):p[1]?setRemote(folder,p[1]):status(folder).remote;
    return done({remote:r,status:status(folder)},r?`origin ${r.url}`:'no remote');
   }
   default: throw new Error(`Unknown command: builder ${verb}\n${builderHelp}`);
  }
 } catch(e:any) {
  if(!v.json) throw e;
  line({event:'error',error:{message:String(e.message).split('\n')[0],code:e.code || 'builder.failed'}});
  process.exitCode=1;
 }
}

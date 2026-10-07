import {existsSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {validateManifest} from './validation.js';
export const EXTENSION_TYPES=['screen-type','widget','movement-mode','integration'] as const;
export type ExtensionType=typeof EXTENSION_TYPES[number];
export function scaffold(type:ExtensionType,directory:string,id='org.example.'+type.replaceAll('-','')):string {
 if(!EXTENSION_TYPES.includes(type)) throw new Error('Type must be '+EXTENSION_TYPES.join(', '));
 const root=resolve(directory);if(existsSync(root)) throw new Error('Scaffold destination already exists');
 const key={'screen-type':'screenTypes',widget:'widgets','movement-mode':'movementModes',integration:'integrations'}[type];
 const manifest={manifestVersion:'0.1',id,version:'0.1.0',name:type+' example',license:'MIT',apiVersion:'0.1',runtime:'process',entrypoint:'main.mjs',capabilities:['state.read'],contributes:{[key]:type==='screen-type'?['screen-type.json']:[id+'.'+type.replaceAll('-','')]},sandbox:{required:true,network:false}};
 const check=validateManifest('extension',manifest);if(!check.valid) throw new Error(check.errors.join('; '));
 if(id==='com.hyprune.core' || id.startsWith('com.hyprune.core.')) throw new Error('Reserved core provider identity');
 mkdirSync(root,{recursive:true});
 try {
 const json=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value,null,2)+'\n');json('extension.json',manifest);
 json('package.json',{name:id,version:'0.1.0',private:true,type:'module',scripts:{start:'node main.mjs'},dependencies:{'@hyprune/sdk':'0.2.0'}});
 const source=`#!/usr/bin/env node\nimport {clientFromEnvironment} from '@hyprune/sdk';\nconst client=clientFromEnvironment();\nclient.on('fault',e=>console.error(e.message));\nclient.on('state',s=>console.log(JSON.stringify({contribution:${JSON.stringify(type)},revision:s.revision,world:s.state.world,position:s.state.movement.position})));\nawait client.connect();\nawait client.subscribe();\nfor(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>client.close());\n`;
 writeFileSync(join(root,'main.mjs'),source,{mode:0o755});
 if(type==='screen-type') {
 const descriptor={descriptorVersion:'0.1',id:id+'.screen',name:'Planar screen example',provider:id,source:'custom',geometry:'plane',defaultSize:[1.6,.9],resolution:{width:1280,height:720},input:{pointer:false,keyboard:false,touch:false},alphaMode:'opaque',colorSpace:'srgb',maxFps:30};
 const r=validateManifest('screen-type',descriptor);if(!r.valid) throw new Error(r.errors.join('; '));json('screen-type.json',descriptor);
 }
 writeFileSync(join(root,'LICENSE'),readFileSync(new URL('../LICENSE',import.meta.url)));
 writeFileSync(join(root,'README.md'),`# ${id}\n\nGenerated Hyprune ${type} scaffold, API 0.1.\n\nInstall the SDK locally before its first publication: \`npm install /path/to/hyprune/sdk\`. Run with the mock supervisor: \`hyprune-mock --client-id ${id} --launch node ${root}/main.mjs\`.\n\nThe executable is a working state subscriber. ${type==='widget'?'Presentation is shell-specific; this example renders JSON in the terminal.':'Its contribution reserves metadata only; no portable host contract for this provider is ratified.'}\n\nThe manifest requires a sandbox. Direct execution here is trusted developer mode, outside the distributable extension contract. Do not claim isolation or load it as a compositor plugin.\n\nProvenance: original generated MIT example; no external content assets. Build: no compilation beyond SDK installation.\n`);
 return root;
 }catch(e){rmSync(root,{recursive:true,force:true});throw e;}
}

import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const s=JSON.parse(readFileSync('vendor/schema/v0/ipc.schema.json'));
s.$id='https://hyprune.com/sdk/mock/0.1-mock.1/ipc.schema.json';
s.title='Hyprune mock-only protocol (not core IPC)';
function refs(v) { if (!v || typeof v!=='object') return; for(const [k,x] of Object.entries(v)) { if(k==='$ref' && x.startsWith('common.schema')) v[k]='https://hyprune.com/schema/v0/'+x; else refs(x); } }
refs(s);
const obj=p=>({type:'object',properties:p,required:Object.keys(p),additionalProperties:false});
const str={type:'string',minLength:1,maxLength:256};
const vec=n=>({type:'array',items:{type:'number'},minItems:n,maxItems:n});
const revision={$ref:'https://hyprune.com/schema/v0/common.schema.json#/$defs/revision'};
const additions={
 'camera.set':obj({position:vec(3),orientation:vec(4)}),
 'waypoint.set':obj({id:str,position:vec(3),label:str}),
 'ui.open':obj({leaseId:str,outputId:str,panel:str}),
 'data.publish':obj({sourceId:{$ref:'https://hyprune.com/schema/v0/common.schema.json#/$defs/id'},values:obj({cpuPercent:{type:'number',minimum:0,maximum:100},ramUsedBytes:{type:'number',minimum:0},ramTotalBytes:{type:'number',minimum:1},netRxBytes:{type:'number',minimum:0},netTxBytes:{type:'number',minimum:0}})})
};
for(const [method,params] of Object.entries(additions)) {
 s.$defs[method+'.params']=params; s.$defs[method+'.result']=obj({revision});
 s.$defs[method+'.request']=obj({jsonrpc:{const:'2.0'},id:{type:'string',minLength:1,maxLength:128},method:{const:method},params:{$ref:'#/$defs/'+method+'.params'}});
 s.$defs[method+'.response']=obj({jsonrpc:{const:'2.0'},id:{type:'string',minLength:1,maxLength:128},result:{$ref:'#/$defs/'+method+'.result'}});
 s.$defs.request.oneOf.push({$ref:'#/$defs/'+method+'.request'});
 s.$defs.response.anyOf.push({$ref:'#/$defs/'+method+'.response'});
}
const events={
 'world.metadata':obj({worldId:str,zones:{type:'array',items:obj({id:str,name:str,bounds:obj({min:vec(3),max:vec(3)})})},waypoint:{$ref:'#/$defs/waypoint.set.params'}}),
 'data.updated':s.$defs['data.publish.params']
};
for(const [method,params] of Object.entries(events)) {
 s.$defs[method+'.notification']=obj({jsonrpc:{const:'2.0'},method:{const:method},params});
 s.$defs.notification.oneOf.push({$ref:'#/$defs/'+method+'.notification'});
}
s.$defs['session.hello.result'].properties.protocol.const='0.1-mock.1';
s.$defs['session.hello.result'].properties.methods.items.enum.push(...Object.keys(additions));
s.$defs['session.hello.result'].properties.events.items.enum.push(...Object.keys(events));
mkdirSync('contracts',{recursive:true});writeFileSync('contracts/mock.schema.json',JSON.stringify(s,null,2)+'\n');

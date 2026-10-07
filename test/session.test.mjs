import test from 'node:test';
import assert from 'node:assert/strict';
import {StateStore,validateWire} from '../dist/src/index.js';
test('first session client accepts 0.3 and preserves version isolation',()=>{
 const state={runtime:{active:true,outputs:['output']},world:{id:'com.hyprune.switchyard',spawnId:'arrival'},surfaces:[],movement:{modeId:'com.hyprune.walk',position:[0,1.7,10],orientation:[0,0,0,1]},shell:{leases:[]},location:{zones:[],waypoint:null,route:[],autodrive:false,transition:null},integrations:{sources:[]},spatial:{world:{id:'com.hyprune.switchyard',name:'Switchyard',places:[]},map:null,output:{id:'output',name:'HEADLESS-1',width:1920,height:1080,scale:1},projection:null},workspaces:{currentId:10,locations:[]}};
 const store=new StateStore('0.3');store.install({sessionId:'session',revision:1,state},'sub');
 assert.equal(store.apply({subscriptionId:'sub',sessionId:'session',baseRevision:1,revision:2,changes:{workspaces:{currentId:11,locations:[]}}}),true);
 assert.equal(store.snapshot.state.workspaces.currentId,11);
 for(const [method,params] of [['shell.bind',{leaseId:'lease',pid:123}],['workspace.activate',{id:11}]]) {
  const req={jsonrpc:'2.0',id:'test',method,params};validateWire(req,'0.3');assert.throws(()=>validateWire(req,'0.2'));
 }
});

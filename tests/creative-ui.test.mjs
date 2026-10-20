import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const code=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
const render=code.slice(code.indexOf('function renderComposer()'),code.indexOf('function sendToTask('));
const handler=code.slice(code.indexOf('$("create-draft").onclick ='),code.indexOf('$("connection-button").onclick'));
function fixture({enabled=true,configured=true,api}={}){
 const row={provider:'redfox',kind:'video',source_id:'7695600881273670946',collection_request_id:'22222222-2222-2222-2222-222222222222',collection:'games'};
 const nodes=Object.fromEntries(['create-draft','draft-source','mode','format','composer-help'].map(id=>[id,{value:({'draft-source':'video:'+row.source_id,mode:'A',format:'video'})[id]||'',disabled:false,textContent:'',replaceChildren(){}}]));
 const calls=[],opened=[],pages=[];let target='游戏甲';
 const ctx={$:id=>nodes[id],Option:function(label,value){this.value=value;},qualityCapabilities:{creative_candidate:{enabled,configured},creation:{enabled:false}},currentProfile:{game:target,learning_source:'network',task_id:'11111111-1111-1111-1111-111111111111',version:'a'.repeat(64)},gameGeneration:1,game:()=>target,pool:()=>[row],rowKey:r=>r.kind+':'+r.source_id,api:async(path,payload)=>{calls.push({path,payload});return api?api(path,payload):{id:'task-one'};},show(){},refreshStatus:async()=>{},switchPage:p=>pages.push(p),openTask:id=>opened.push(id)};
 vm.runInNewContext(render+'\n'+handler,ctx);
 return {ctx,nodes,calls,opened,pages,setGame:value=>{target=value;ctx.gameGeneration++;}};
}
test('held or unconfigured candidate cannot post and unconfigured composer explains the missing executor',async()=>{
 for(const flags of [{enabled:false,configured:true},{enabled:true,configured:false}]){
  const f=fixture(flags);f.ctx.renderComposer();assert.equal(f.nodes['create-draft'].disabled,true);
  await f.nodes['create-draft'].onclick();assert.equal(f.calls.length,0);
  if(flags.enabled)assert.match(f.nodes['composer-help'].textContent,/尚未配置/);
 }
});
test('candidate submits only the exact current game/profile/source identifiers; local or other-game profile is rejected',async()=>{
 const f=fixture();f.ctx.renderComposer();assert.equal(f.nodes['create-draft'].disabled,false);
 await f.nodes['create-draft'].onclick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/creative-candidates');
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].payload)),{game:'游戏甲',mode:'A',format:'video',study_task_id:'11111111-1111-1111-1111-111111111111',profile_version:'a'.repeat(64),source:{provider:'redfox',request_id:'22222222-2222-2222-2222-222222222222',source_id:'7695600881273670946'}});
 for(const changes of [{game:'游戏乙'},{learning_source:'local'}]){
  const rejected=fixture();Object.assign(rejected.ctx.currentProfile,changes);rejected.ctx.renderComposer();assert.equal(rejected.nodes['create-draft'].disabled,true);
  await rejected.nodes['create-draft'].onclick();assert.equal(rejected.calls.length,0);
 }
});
test('late task creation for a previous game cannot navigate or open its result in the newly selected game',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),f=fixture({api:()=>pending});
 const submitted=f.nodes['create-draft'].onclick();assert.equal(f.calls.length,1);f.setGame('游戏乙');release({id:'old-game-task'});
 await submitted;assert.deepEqual(f.opened,[]);assert.deepEqual(f.pages,[]);
 assert.equal(f.calls[0].payload.game,'游戏甲');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
const profile=code.slice(code.indexOf('async function loadProfile()'),code.indexOf('async function learning()'));
test('network dossier reads only its explicit source store and never falls back to a legacy local profile',async()=>{
 const calls=[];const ctx={URLSearchParams,qualityCapabilities:{study:{supported_sources:['network','local']}},currentProfile:{learning_source:'local'},gameGeneration:1,game:()=> '率土之滨',learningSource:()=> 'network',renderGameState(){},renderComposer(){},api:async path=>{calls.push(path);assert(path.startsWith('/api/game-study-profile?'));return null;}};
 vm.runInNewContext(profile,ctx);await ctx.loadProfile();assert.equal(ctx.currentProfile,null);assert.equal(calls.length,1);
 ctx.learningSource=()=> 'local';await ctx.loadProfile();assert.equal(ctx.currentProfile,null);assert.equal(calls.length,2);assert.equal(new URLSearchParams(calls[1].split('?')[1]).get('learning_source'),'local','local profile read must stay source-scoped and never use the network or legacy store');
});
test('an older server without local capability cannot be asked for a network profile as local fallback',async()=>{
 const calls=[],ctx={URLSearchParams,qualityCapabilities:{study:{}},currentProfile:{learning_source:'network'},gameGeneration:1,game:()=> '率土之滨',learningSource:()=> 'local',renderGameState(){},renderComposer(){},api:async p=>calls.push(p)};
 vm.runInNewContext(profile,ctx);await ctx.loadProfile();assert.equal(ctx.currentProfile,null);assert.equal(calls.length,0);
});
test('late dossier response cannot replace a different selected game or source',async()=>{
 for(const next of ['game','source']){
  let target='率土之滨',source='network',release;const pending=new Promise(r=>release=r),ctx={URLSearchParams,currentProfile:null,gameGeneration:1,game:()=>target,learningSource:()=>source,renderGameState(){},renderComposer(){},api:()=>pending};
  vm.runInNewContext(profile,ctx);const read=ctx.loadProfile();if(next==='game')target='星际猎人';else source='local';release({game:'率土之滨',learning_source:'network'});await read;assert.equal(ctx.currentProfile,null);
 }
});

const savedFunction=code.slice(code.indexOf('function savedStudyTask()'),code.indexOf('function renderGameState()'));
const learningFunction=code.slice(code.indexOf('async function learning()'),code.indexOf('async function searchGame()'));
const recordsFunction=code.slice(code.indexOf('async function loadRecords()'),code.indexOf('function sourceURL('));
function savedContext(source='local'){
 const task={id:'study-one',task_store:'game-study',state:'completed',payload:{game:'星际猎人',learning_source:source},result:{game:'星际猎人',learning_source:source,profile_version:'version-one',source_counts:{captured_origins:37},comparisonMetrics:{collection_request_id:'query-one'}}};
 const calls=[],opened=[],nodes=new Map();
 const ctx={URLSearchParams,gameGeneration:1,listGeneration:0,learningBusy:false,sourceMode:'game',records:[],
  game:()=> '星际猎人',learningSource:()=>source,studyEntryEnabled:()=>true,
  currentProfile:{game:'星际猎人',learning_source:source,task_id:task.id,version:'version-one'},
  tasks:[task],recordCollection:null,localLibrarySnapshot:{game:'星际猎人',count:37},
  renderGameState(){},renderRecords(){},refreshStatus:async()=>{},show(){},openTask:id=>opened.push(id),
  $:id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:''});return nodes.get(id);},
  api:async(path,body)=>{calls.push({path,body});return {id:'new-task',state:'queued'};}};
 vm.runInNewContext(savedFunction+'\n'+learningFunction+'\n'+recordsFunction,ctx);
 return {ctx,task,calls,opened};
}
test('local completed matching dossier opens without a network collection or any API call',async()=>{
 const h=savedContext();assert.equal(h.ctx.savedStudyTask()?.id,h.task.id);
 await h.ctx.learning();assert.deepEqual(h.opened,[h.task.id]);assert.deepEqual(h.calls,[]);
});
test('saved dossier rejects wrong game/source/task version and incomplete tasks',()=>{
 for(const mutate of [
  h=>h.ctx.currentProfile.game='other',h=>h.ctx.currentProfile.learning_source='network',
  h=>h.ctx.currentProfile.task_id='other',h=>h.ctx.currentProfile.version='other',
  h=>h.task.payload.game='other',h=>h.task.payload.learning_source='network',
  h=>h.task.result.game='other',h=>h.task.result.learning_source='network',
  h=>h.task.state='running',h=>h.ctx.localLibrarySnapshot={game:'other',count:37},
  h=>h.ctx.localLibrarySnapshot={game:'星际猎人',count:null}
 ]){const h=savedContext();mutate(h);assert.equal(h.ctx.savedStudyTask(),null);assert.equal(h.calls.length,0);}
});
test('full unfiltered local count permits viewing and an appended upload permits only explicit relearning',async()=>{
 const h=savedContext();let count=37;h.ctx.$('query').value='no-match';
 h.ctx.api=async(path,body)=>{h.calls.push({path,body});assert.equal(body,undefined);return {records:path.startsWith('/api/local-videos?')?Array.from({length:count},(_,i)=>({source_id:'local-'+i,kind:'video',title:'clip'})):[]};};
 await h.ctx.loadRecords();assert.equal(h.ctx.records.length,0);assert.equal(h.ctx.localLibrarySnapshot.count,37);assert(h.ctx.savedStudyTask());
 count=38;await h.ctx.loadRecords();assert.equal(h.ctx.localLibrarySnapshot.count,38);assert.equal(h.ctx.savedStudyTask(),null);assert(h.calls.every(c=>c.body===undefined));
 h.ctx.api=async(path,body)=>{h.calls.push({path,body});return {id:'new-task',state:'queued'};};
 await h.ctx.learning();assert.equal(h.calls.filter(c=>c.body!==undefined).length,1);assert.equal(h.calls.at(-1).path,'/api/game-study-tasks');
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).body)),{game:'星际猎人',learning_source:'local'});
});
test('network saved dossier still requires the current exact game collection',()=>{
 const h=savedContext('network');assert.equal(h.ctx.savedStudyTask(),null);
 h.ctx.recordCollection={requested_scope:{purpose:'game-research',keyword:'星际猎人'},latest_request:{id:'query-one'}};
 assert(h.ctx.savedStudyTask());h.ctx.recordCollection.latest_request.id='query-two';assert.equal(h.ctx.savedStudyTask(),null);
});
test('a late local-library response cannot replace the current game count, and failed reads remain unknown',async()=>{
 const h=savedContext();let target='星际猎人',release;
 h.ctx.game=()=>target;
 h.ctx.api=path=>path.includes(encodeURIComponent('星际猎人'))?new Promise(resolve=>{if(path.startsWith('/api/local-videos?'))release=resolve;else resolve({records:[]});}):Promise.resolve({records:[]});
 const old=h.ctx.loadRecords();target='率土之滨';await h.ctx.loadRecords();
 release({records:Array.from({length:37},()=>({kind:'video',title:'old'}))});await old;
 assert.equal(h.ctx.localLibrarySnapshot.game,'率土之滨');assert.equal(h.ctx.localLibrarySnapshot.count,0);
 h.ctx.api=async path=>{if(path.startsWith('/api/local-videos?'))throw Error('unavailable');return {records:[]};};
 await h.ctx.loadRecords();assert.equal(h.ctx.localLibrarySnapshot.count,null);
});
test('older same-source profile response cannot overwrite a newer version',async()=>{
 const deferred=[];const ctx={URLSearchParams,gameGeneration:1,currentProfile:null,game:()=> '星际猎人',learningSource:()=> 'local',qualityCapabilities:{study:{supported_sources:['local']}},renderGameState(){},renderComposer(){},api:()=>new Promise(resolve=>deferred.push(resolve))};
 vm.runInNewContext(profile,ctx);const a=ctx.loadProfile(),b=ctx.loadProfile();
 deferred[1]({game:'星际猎人',learning_source:'local',version:'new'});await b;
 deferred[0]({game:'星际猎人',learning_source:'local',version:'old'});await a;assert.equal(ctx.currentProfile.version,'new');
});

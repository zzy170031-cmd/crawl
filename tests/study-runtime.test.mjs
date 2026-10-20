import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Tasks,hash} from '../app/tasks.mjs';
import {createNetworkStudyRuntime} from '../app/study-runtime.mjs';
const at='2026-10-20T00:00:00Z',game='海城',id='7695600881273670946',id2='7695600986567609600';
const query=(game,request='query-a')=>({binding:{source_provider:'redfox',collection_request_id:request,collection_fingerprint:hash({game,request})},provenance:{provider:'redfox',request_id:request,game,collected_at:at,start_date:'2026-10-12',end_date:'2026-10-18',update_policy:'T+1'},records:[id,id2].map(source_id=>({provider:'redfox',kind:'video',game,source_id,title:'真实保存候选',source_url:'https://www.douyin.com/video/'+source_id,collection_request_id:request,collected_at:at,published_date:'2026-10-15',duration_ms:10000,like_count:null,comment_count:null,share_count:null,collect_count:null}))});
function draft(game){return {game,background_and_loop:[],player_situations:[],necessary_terms:[],content_types:[],expression_methods:[],platform_actions:[],peer_transfer:[],unknowns:[]};}
function setup(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'study-runtime-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const cli=join(root,'controlled-cli');writeFileSync(cli,'never execute');chmodSync(cli,0o700);
 const bytes=Buffer.from('controlled original bytes'),path=join(root,'original.mp4');writeFileSync(path,bytes);
 const frame=join(root,'frame.png');writeFileSync(frame,Buffer.from('controlled frame bytes'));
 const calls={current:[],captured:[],asset:[],host:0,media:0,factory:0};let secondAvailable=false,enabled=true,hostHook;
 const deps={
  dataRoot:root,cliPath:cli,python:'controlled-no-execution',isEnabled:()=>enabled,
  getCurrentCollection:async game=>{calls.current.push(game);return query(game);},
  readCapturedCollection:async(game,request)=>{calls.captured.push([game,request]);return query(game,request);},
  assets:{read:async row=>{calls.asset.push(row.source_id);if(row.source_id===id2&&!secondAvailable)return null;return {provider:'redfox',source_id:row.source_id,url:row.source_url,current_collection_request_id:row.collection_request_id,status:'av_readable',source_path:path,source_sha256:hash(bytes),bytes:bytes.length};}},
  mediaFactory:()=>({prepare:async(item,{signal})=>{signal?.throwIfAborted();calls.media++;return {source_sha256:item.media.sha256,duration:10,has_audio:false,transcript:null,frames:[0,5,9.7].map(time=>({path:frame,sha256:hash(readFileSync(frame)),time}))};}}),
  hostFactory:()=>{calls.factory++;return {json:async(system,input,schema,options)=>{calls.host++;assert(options.auditDir.startsWith(join(root,'game-study-tasks','audits')));assert.equal(options.images.length,1);if(hostHook)await hostHook(input);return {value:draft(input.packet.game),receipt:{provider:'codex-host',status:'completed',owned_process_closed:true,tool_events:0,exec_attempts:1,runner_retries:0,input_sha256:hash(input),model:null}};}};}
 };
 const make=overrides=>{const runtime=createNetworkStudyRuntime({...deps,...overrides});t.after(()=>runtime.close());return runtime;};
 return {root,cli,path,bytes,calls,deps,make,setEnabled:v=>enabled=v,setSecondAvailable:v=>secondAvailable=v,setHostHook:v=>hostHook=v};
}
function countTasks(root){const db=new DatabaseSync(join(root,'game-study-tasks/tasks.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) AS n FROM tasks').get().n;}finally{db.close();}}
test('fresh explicit capture, fixed-request pre/post validation, old missing original never expands, isolated storage and read-only APIs',async t=>{
 const f=setup(t),legacy=new Tasks(f.root);legacy.profile(game,{marker:'old production profile'});const legacyTask=legacy.create('learn',{game:'old'});legacy.close();
 f.setHostHook(()=>f.setSecondAvailable(true));const runtime=f.make();
 assert.equal(runtime.configured(),true);const task=await runtime.start({game,learning_source:'network'});await runtime.idle();
 const result=runtime.read(task.id);assert.equal(result.state,'completed');assert.equal(result.result.accepted,false);assert.equal(result.result.status,'partial');assert.equal(result.result.source_counts.unavailable_originals,1);
 assert.deepEqual(f.calls.current,[game]);assert.deepEqual(f.calls.captured,[[game,'query-a'],[game,'query-a']]);assert.equal(f.calls.asset.filter(x=>x===id2).length,1);
 assert.equal(f.calls.host,1);assert.equal(f.calls.media,1);assert(!JSON.stringify(result).includes(f.root));
 const before=structuredClone(f.calls);runtime.list();runtime.profile({game,learning_source:'network'});runtime.has(task.id);await runtime.idle();assert.deepEqual(f.calls,before);
 const check=new DatabaseSync(join(f.root,'tasks.sqlite'),{readOnly:true});try{assert.equal(check.prepare('SELECT state FROM tasks WHERE id=?').get(legacyTask.id).state,'queued');assert.deepEqual(JSON.parse(check.prepare('SELECT value FROM profiles WHERE game=?').get(game).value),{marker:'old production profile'});}finally{check.close();}
 await runtime.close();assert.equal(runtime.configured(),false);
});
test('disabled, missing CLI and zero readable originals fail before creating any task or invoking Host',async t=>{
 for(const mode of ['disabled','cli','originals']){
  const f=setup(t);if(mode==='disabled')f.setEnabled(false);
  const runtime=f.make(mode==='cli'?{cliPath:join(f.root,'missing')} :mode==='originals'?{assets:{read:async()=>null}}:{});
  await assert.rejects(runtime.start({game,learning_source:'network'}),{code:mode==='disabled'?'STUDY_SERVICE_HELD':mode==='cli'?'STUDY_HOST_CONFIGURATION_REQUIRED':'STUDY_ORIGINALS_REQUIRED'});
  assert.equal(countTasks(f.root),0);assert.equal(f.calls.host,0);assert.equal(f.calls.media,0);
  if(mode!=='originals'){assert.equal(f.calls.current.length,0);assert.equal(f.calls.factory,0);}
 }
});
test('wrong game and source reject; two games capture their own current requests and profiles',async t=>{
 const f=setup(t),runtime=f.make();
 await assert.rejects(runtime.start({game,learning_source:'local'}),{code:'STUDY_SERVICE_INPUT_INVALID'});assert.equal(f.calls.current.length,0);
 const a=await runtime.start({game,learning_source:'network'}),b=await runtime.start({game:'另一游戏',learning_source:'network'});await runtime.idle();
 assert.equal(runtime.profile({game,learning_source:'network'}).task_id,a.id);assert.equal(runtime.profile({game:'另一游戏',learning_source:'network'}).task_id,b.id);
 assert.deepEqual(f.calls.current,[game,'另一游戏']);assert.equal(f.calls.host,2);
 const g=setup(t),wrong=g.make({getCurrentCollection:async()=>query('wrong game')});
 await assert.rejects(wrong.start({game,learning_source:'network'}));assert.equal(countTasks(g.root),0);assert.equal(g.calls.host,0);
});
test('captured request or original bytes drift fails closed, never refreshes current query or retries inference',async t=>{
 const f=setup(t),runtime=f.make({readCapturedCollection:async(game,request)=>{f.calls.captured.push([game,request]);return query(game,'different-query');}});
 const task=await runtime.start({game,learning_source:'network'});await runtime.idle();
 assert.equal(runtime.read(task.id).state,'needs_input');assert.equal(f.calls.host,0);assert.equal(f.calls.current.length,1);
 const g=setup(t);g.setHostHook(()=>writeFileSync(g.path,'changed bytes'));
 const after=g.make(),second=await after.start({game,learning_source:'network'});await after.idle();
 assert.equal(after.read(second.id).state,'needs_input');assert.equal(g.calls.host,1);assert.equal(after.profile({game,learning_source:'network'}),null);
 await after.idle();assert.equal(g.calls.host,1);
});
test('close cancels and waits for owned callback; missing explicit configuration cannot spawn or acquire',async t=>{
 const f=setup(t);let release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);f.setHostHook(async()=>{entered();await held;});
 const runtime=f.make(),task=await runtime.start({game,learning_source:'network'});await started;
 let closed=false;const closing=runtime.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release();await closing;
 const db=new DatabaseSync(join(f.root,'game-study-tasks/tasks.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT state,owner FROM tasks WHERE id=?').get(task.id);assert.equal(row.state,'cancelled');assert.equal(row.owner,null);}finally{db.close();}
 assert.equal(f.calls.host,1);assert.equal(existsSync(join(f.root,'tasks.sqlite')),false);
});

test('current collection exceptions normalize before task creation while original errors preserve their own code',async t=>{
 for(const result of ['throws','missing']){
  const f=setup(t),runtime=f.make({getCurrentCollection:async()=>{if(result==='throws')throw Error('/private/source detail');return null;}});
  await assert.rejects(runtime.start({game,learning_source:'network'}),{code:'STUDY_CURRENT_COLLECTION_REQUIRED'});assert.equal(countTasks(f.root),0);assert.equal(f.calls.host,0);
 }
 const f=setup(t),runtime=f.make({assets:{read:async()=>{throw Object.assign(Error('corrupt original'),{code:'MEDIA_ASSET_INVALID'});}}});
 await assert.rejects(runtime.start({game,learning_source:'network'}),{code:'LIBRARY_ONLINE_READ_FAILED'});assert.equal(countTasks(f.root),0);
});

test('existing ancestor aliases canonicalize, but data leaf, task directory and SQLite symlinks are rejected',async t=>{
 const f=setup(t),parent=join(f.root,'real-parent'),alias=join(f.root,'alias-parent');mkdirSync(parent);symlinkSync(parent,alias,'dir');
 const runtime=f.make({dataRoot:join(alias,'data')});assert.equal(runtime.configured(),true);
 assert(existsSync(join(parent,'data/game-study-tasks/tasks.sqlite')));await runtime.close();
 const leaf=join(f.root,'leaf-link');symlinkSync(join(parent,'data'),leaf,'dir');
 assert.throws(()=>createNetworkStudyRuntime({...f.deps,dataRoot:leaf}),{code:'STUDY_RUNTIME_PATH_INVALID'});
 for(const target of ['game-study-tasks','tasks.sqlite']){
  const root=join(f.root,target==='tasks.sqlite'?'sqlite-root':'directory-root');mkdirSync(root);
  if(target==='game-study-tasks')symlinkSync(join(parent,'data/game-study-tasks'),join(root,target),'dir');
  else {mkdirSync(join(root,'game-study-tasks'));symlinkSync(join(parent,'data/game-study-tasks/tasks.sqlite'),join(root,'game-study-tasks/tasks.sqlite'));}
  assert.throws(()=>createNetworkStudyRuntime({...f.deps,dataRoot:root}),{code:'STUDY_RUNTIME_PATH_INVALID'});
 }
});

test('runtime accepts the actual macOS /tmp ancestor alias at startup', {skip:process.platform!=='darwin'},async t=>{
 const f=setup(t),path=mkdtempSync('/tmp/study-runtime-alias-');t.after(()=>rmSync(path,{recursive:true,force:true}));
 const runtime=f.make({dataRoot:path});assert.equal(runtime.configured(),true);assert(existsSync(join(realpathSync(path),'game-study-tasks/tasks.sqlite')));await runtime.close();
});

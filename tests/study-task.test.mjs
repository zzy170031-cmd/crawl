import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Tasks,hash} from '../app/tasks.mjs';
import {createStudyTaskRunner,STUDY_TASK_PIPELINE} from '../app/study-task.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function library({game,learning_source}){
 const fp=hash({game,learning_source}),row={provider:learning_source==='local'?'local_upload':'redfox',game,source_id:learning_source==='local'?'local_'+'a'.repeat(64):'7695600881273670946',availability:'available'};
 return {game,binding:{source_provider:'game_study_library',game,library_id:'library_'+fp,library_fingerprint:fp,collection:learning_source==='local'?null:{collection_request_id:'saved-query'}},records:[row],items:[{media:{path:'/private/original.mp4',sha256:'a'.repeat(64)}}]};
}
function output(game){return {version:STUDY_TASK_PIPELINE,receipt:{provider:'codex-host',status:'completed',owned_process_closed:true,tool_events:0,exec_attempts:1,runner_retries:0,game_study_version:STUDY_TASK_PIPELINE,audit_dir:'/private/audit',files:['/private/receipt']},draft:{game,background_and_loop:[],player_situations:[],necessary_terms:[],content_types:[],expression_methods:[],platform_actions:[],peer_transfer:[],unknowns:[],status:'ready',accepted:true,receipt:{path:'/private/leak'}},coverage:{status:'partial',accepted:true,ready:true,candidate_count:1,representative_count:1,domains:{background_loop:{status:'missing',source_ids:[],missing:['reference_missing'],path:'/private/hidden'}},image_pages:[]},comparisonMetrics:{collection_request_id:null,window:null,groups:[],excluded:[],path:'/private/raw'}};}
function fixture(t,overrides={}){
 const folder=mkdtempSync(join(tmpdir(),'study-task-')),db=new Tasks(folder);t.after(()=>{db.close();rmSync(folder,{recursive:true,force:true});});
 const calls={capture:0,prepare:0,infer:0,validate:0};
 const deps={db,captureInput:async input=>{calls.capture++;return library(input);},preparePacket:async(lib,ctx)=>{calls.prepare++;return {packet:{game:ctx.game,learning_source:ctx.learning_source,library:{binding:lib.binding,records:lib.records},sources:[],representative_samples:[]},images:[],files:[]};},runStudy:async(packet,ctx)=>{calls.infer++;return output(ctx.game);},revalidateInput:async()=>{calls.validate++;return true;},...overrides};
 return {db,folder,calls,deps,runner:createStudyTaskRunner(deps)};
}
const input={game:'游戏甲',learning_source:'local'};
test('create captures normalized parameters before await, private checkpoint only, dedupe by server snapshot and separate game/source',async t=>{
 const held=deferred(),captured=[];const f=fixture(t,{captureInput:async value=>{captured.push({...value});await held.promise;return library(value);}}),value={game:'  游戏甲  ',learning_source:'local'};
 const pending=f.runner.create(value);value.game='游戏乙';value.learning_source='network';held.resolve();const task=await pending;assert.equal(task.payload.game,'游戏甲');assert.equal(task.payload.learning_source,'local');assert.equal(task.type,'learn');assert.equal(task.payload.learning_pipeline,STUDY_TASK_PIPELINE);assert(!JSON.stringify(task).includes('/private'));
 assert.equal((await f.runner.create(input)).id,task.id);const other=await f.runner.create({game:'游戏甲',learning_source:'network'}),different=await f.runner.create({game:'游戏乙',learning_source:'local'});assert.notEqual(other.id,task.id);assert.notEqual(different.id,task.id);assert.equal(f.db.list().length,3);
 assert(f.db.checkpoint('study-task:'+task.id+':input').library.items[0].media.path);assert.deepEqual(captured[0],input);
 for(const bad of [{game:'x',learning_source:'combined'},{...input,rows:[]},{...input,path:'/x'}])await assert.rejects(f.runner.create(bad),{code:'STUDY_TASK_INPUT_INVALID'});
});
test('one execution, fixed-source checks before/after, public result/profile sanitized and completed restart reads without inference',async t=>{
 const f=fixture(t),task=await f.runner.create(input),unrelated=f.db.create('create',{game:'another',profile_version:'x',source:{kind:'video',source_id:'other'},mode:'x',format:'x',destination:'x'});
 f.db.profile(input.game,{status:'legacy',value:'preserve in private history'});
 const result=await f.runner.run(task.id);assert.equal(result.state,'completed');assert.equal(result.result.status,'partial');assert.equal(result.result.accepted,false);assert.equal(result.result.ready,false);assert.equal(result.result.draft.accepted,false);assert.equal(f.calls.infer,1);assert.equal(f.calls.validate,2);assert.equal(f.db.get(unrelated.id).state,'queued');
 assert(!JSON.stringify(result).includes('/private'));assert(!JSON.stringify(f.db.profile(input.game)).includes('/private'));assert.equal(f.db.profile(input.game).status,'partial');
 const reopened=new Tasks(f.folder);try{const again=createStudyTaskRunner({...f.deps,db:reopened,runStudy:()=>assert.fail('must not infer again')});assert.deepEqual(await again.run(task.id),result);}finally{reopened.close();}
 assert(f.db.checkpoint('study-task:'+task.id+':inference-started'));assert(f.db.checkpoint('study-task:'+task.id+':output').output.receipt.audit_dir);assert.equal(f.calls.infer,1);
});
test('cancel waits for owned callback to settle and rejects late successful output/profile',async t=>{
 const held=deferred(),entered=deferred();const f=fixture(t,{runStudy:async(packet,ctx)=>{entered.resolve(ctx);await held.promise;return output(ctx.game);}}),task=await f.runner.create(input);const running=f.runner.run(task.id),ctx=await entered.promise;let cancelled=false;const cancellation=f.runner.cancel(task.id).then(r=>{cancelled=true;return r;});await Promise.resolve();assert(ctx.signal.aborted);assert.equal(cancelled,false);assert.equal(f.db.profile(input.game),null);held.resolve();const result=await cancellation;await running;assert.equal(result.state,'cancelled');assert.equal(f.db.profile(input.game),null);assert.equal(f.db.checkpoint('study-task:'+task.id+':output'),null);
});
test('lost lease cannot overwrite new owner/result or publish profile',async t=>{
 const held=deferred(),entered=deferred();const f=fixture(t,{runStudy:async(p,c)=>{entered.resolve();await held.promise;return output(c.game);}}),task=await f.runner.create(input),running=f.runner.run(task.id);await entered.promise;
 f.db.db.prepare('UPDATE tasks SET owner=?,lease=?,result=? WHERE id=?').run('replacement-owner',Date.now()+30000,JSON.stringify({marker:'new-owner'}),task.id);held.resolve();await running;
 assert.equal(f.db.get(task.id).owner,'replacement-owner');assert.deepEqual(f.db.get(task.id).result,{marker:'new-owner'});assert.equal(f.db.profile(input.game),null);assert.equal(f.db.checkpoint('study-task:'+task.id+':output'),null);
});
test('source change before or after inference stops publication; no automatic retry even if queued again without output receipt',async t=>{
 for(const at of ['before','after']){
  let checks=0;const f=fixture(t,{revalidateInput:async()=>++checks!==(at==='before'?1:2)}),task=await f.runner.create(input),result=await f.runner.run(task.id);
  assert.equal(result.state,'needs_input');assert.equal(result.error,'STUDY_TASK_SOURCE_CHANGED');assert.equal(f.db.profile(input.game),null);assert.equal(f.calls.infer,at==='before'?0:1);
 }
 const f=fixture(t,{runStudy:async()=>{f.calls.infer++;throw Error('/private/secret upstream');}}),task=await f.runner.create(input);await f.runner.run(task.id);assert.equal(f.calls.infer,1);f.db.retry(task.id);const again=await f.runner.run(task.id);assert.equal(again.state,'needs_input');assert.equal(f.calls.infer,1);assert(!again.error.includes('/private'));
});
test('expired inference with no receipt is held; persisted completed callback receipt recovers without a second model call',async t=>{
 const f=fixture(t),task=await f.runner.create(input),prefix='study-task:'+task.id;
 const stored=f.db.checkpoint(prefix+':input');f.db.checkpoint(prefix+':inference-started',{started_at:new Date().toISOString()});f.db.db.prepare("UPDATE tasks SET state='running',owner='dead',lease=1 WHERE id=?").run(task.id);
 const held=await f.runner.run(task.id);assert.equal(held.state,'needs_input');assert.equal(f.calls.infer,0);
 // A different task crashed after its complete response was durably saved.
 const second=await f.runner.create({game:'游戏乙',learning_source:'local'}),p='study-task:'+second.id,s=f.db.checkpoint(p+':input'),out=output('游戏乙');
 f.db.checkpoint(p+':inference-started',{owner:'dead'});f.db.checkpoint(p+':output',{output:out,output_sha256:hash(out),library_sha256:s.library_sha256});f.db.db.prepare("UPDATE tasks SET state='running',owner='dead',lease=1 WHERE id=?").run(second.id);
 assert.equal((await f.runner.run(second.id)).state,'completed');assert.equal(f.calls.infer,0);assert.equal(f.calls.prepare,0);assert.equal(f.calls.validate,2);assert.equal(f.db.profile('游戏乙').accepted,false);
});
test('exact task claim leaves legacy learn untouched, wrong packet source fails before inference and concurrent run cannot duplicate it',async t=>{
 const f=fixture(t),old=f.db.create('learn',{game:'old'});assert.throws(()=>f.runner.run(old.id),{code:'STUDY_TASK_NOT_CANDIDATE'});assert.equal(f.db.get(old.id).state,'queued');
 const held=deferred(),entered=deferred(),g=fixture(t,{preparePacket:async(lib,ctx)=>{entered.resolve();await held.promise;return {packet:{game:ctx.game,learning_source:'network',library:{binding:lib.binding,records:lib.records}}};}}),task=await g.runner.create(input),running=g.runner.run(task.id);await entered.promise;await assert.rejects(g.runner.run(task.id),{code:'STUDY_TASK_BUSY'});held.resolve();assert.equal((await running).state,'needs_input');assert.equal(g.calls.infer,0);
});


test('missing/incomplete Host receipt cannot become a recoverable completed response or public profile',async t=>{
 const f=fixture(t,{runStudy:async(p,c)=>{const r=output(c.game);delete r.receipt;return r;}}),task=await f.runner.create(input),result=await f.runner.run(task.id);
 assert.equal(result.state,'needs_input');assert.equal(result.error,'STUDY_TASK_RECEIPT_INVALID');assert.equal(f.db.checkpoint('study-task:'+task.id+':output'),null);assert.equal(f.db.profile(input.game),null);
});

test('heartbeat renews an owned lease; cancellation through another DB owner is observed before late callback publishes',async t=>{
 const held=deferred(),entered=deferred();const f=fixture(t,{leaseMs:300,heartbeatMs:10,runStudy:async(p,c)=>{entered.resolve(c);await held.promise;return output(c.game);}}),task=await f.runner.create(input),running=f.runner.run(task.id),ctx=await entered.promise;
 const lease=f.db.get(task.id).lease;await new Promise(r=>setTimeout(r,30));assert(f.db.get(task.id).lease>lease);
 f.db.cancel(task.id);await new Promise(r=>setTimeout(r,30));assert(ctx.signal.aborted);held.resolve();assert.equal((await running).state,'cancelled');assert.equal(f.db.profile(input.game),null);
});


test('cancel after lease expiry settles the same owner after callback and stays cancelled after runner reconstruction',async t=>{
 const held=deferred(),entered=deferred();const f=fixture(t,{runStudy:async(p,c)=>{entered.resolve(c);await held.promise;return output(c.game);}}),task=await f.runner.create(input),running=f.runner.run(task.id);await entered.promise;
 const owner=f.db.get(task.id).owner;f.db.db.prepare('UPDATE tasks SET lease=1 WHERE id=? AND owner=?').run(task.id,owner);
 let settled=false;const cancelled=f.runner.cancel(task.id).then(r=>{settled=true;return r;});await Promise.resolve();assert.equal(settled,false);assert.equal(f.db.get(task.id).owner,owner);
 held.resolve();const result=await cancelled;await running;assert.equal(result.state,'cancelled');assert.equal(result.cancelled,1);assert.equal(f.db.get(task.id).owner,null);assert.equal(f.db.get(task.id).lease,0);assert.equal(f.db.profile(input.game),null);
 const rebuilt=createStudyTaskRunner({...f.deps,runStudy:()=>assert.fail('cancelled task must not infer')});assert.equal((await rebuilt.run(task.id)).state,'cancelled');assert.equal(f.db.get(task.id).owner,null);
});

test('cancelled old callback with expired lease cannot release or overwrite a replacement owner',async t=>{
 const held=deferred(),entered=deferred();const f=fixture(t,{runStudy:async(p,c)=>{entered.resolve();await held.promise;return output(c.game);}}),task=await f.runner.create(input),running=f.runner.run(task.id);await entered.promise;
 f.db.db.prepare('UPDATE tasks SET lease=1 WHERE id=?').run(task.id);
 const cancelling=f.runner.cancel(task.id);
 f.db.db.prepare('UPDATE tasks SET owner=?,lease=?,result=? WHERE id=?').run('replacement-owner',Date.now()+30000,JSON.stringify({marker:'replacement-result'}),task.id);
 held.resolve();await cancelling;await running;
 const after=f.db.get(task.id);assert.equal(after.state,'running');assert.equal(after.owner,'replacement-owner');assert.deepEqual(after.result,{marker:'replacement-result'});assert.equal(after.cancelled,1);assert.equal(f.db.profile(input.game),null);assert.equal(f.db.checkpoint('study-task:'+task.id+':output'),null);
});


test('restart settles persisted cancelled expired lease without callbacks, but leaves an active replacement owner untouched',async t=>{
 const f=fixture(t),task=await f.runner.create(input);
 f.db.db.prepare("UPDATE tasks SET state='running',owner='dead-process',lease=1,cancelled=1 WHERE id=?").run(task.id);
 const untouched=()=>assert.fail('recovery must not capture, validate, prepare or infer');
 const reopened=new Tasks(f.folder);
 try{
  const runner=createStudyTaskRunner({db:reopened,captureInput:untouched,preparePacket:untouched,runStudy:untouched,revalidateInput:untouched});
  const recovered=await runner.run(task.id);assert.equal(recovered.state,'cancelled');assert.equal(recovered.cancelled,1);assert.equal(reopened.get(task.id).owner,null);assert.equal(reopened.get(task.id).lease,0);assert.equal(reopened.profile(input.game),null);
  assert.equal((await runner.run(task.id)).state,'cancelled');
  const other=await f.runner.create({game:'游戏乙',learning_source:'local'});
  const liveLease=Date.now()+30000;f.db.db.prepare("UPDATE tasks SET state='running',owner='replacement-owner',lease=?,cancelled=1,result=? WHERE id=?").run(liveLease,JSON.stringify({marker:'replacement'}),other.id);
  const result=await runner.run(other.id);assert.equal(result.state,'running');assert.equal(reopened.get(other.id).owner,'replacement-owner');assert.equal(reopened.get(other.id).lease,liveLease);assert.deepEqual(result.result,{marker:'replacement'});assert.equal(f.calls.prepare,0);assert.equal(f.calls.infer,0);assert.equal(f.calls.validate,0);
 }finally{reopened.close();}
});

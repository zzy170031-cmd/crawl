import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks,hash} from '../app/tasks.mjs';
import {createCreativeTaskRunner,creativeTaskRequest,CREATIVE_TASK_PIPELINE} from '../app/creative-task.mjs';
const study='12345678-1234-1234-1234-123456789abc',query='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source='7698255254555268331';
const request=(game='游戏甲')=>({game,study_task_id:study,profile_version:'a'.repeat(64),source:{provider:'redfox',request_id:query,source_id:source},mode:'B',format:'video'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
// Controlled callbacks below test persistence/ownership, not content semantics.
function setup(t,{runHook,validateHook,prepareHook}={}){
 const folder=realpathSync(mkdtempSync(join(tmpdir(),'creative-task-'))),db=new Tasks(folder);t.after(()=>{db.close();rmSync(folder,{recursive:true,force:true});});const calls={capture:0,prepare:0,run:0,validate:0};
 const captureInput=async r=>{calls.capture++;return {game:r.game,mode:r.mode,format:r.format,study:{game:r.game,binding:{task_id:study,profile_version:r.profile_version}},selected:{row:{provider:'redfox',kind:'video',source_id:source,collection_request_id:query},collection:{request_id:query,fingerprint:'b'.repeat(64)},media:{path:join(folder,'not-an-actual-media-test'),sha256:'c'.repeat(64),size:1}}};};
 const output=input=>{const binding={game:input.game,mode:input.mode,format:input.format,study_task_id:study,profile_version:input.study.binding.profile_version,collection_request_id:query,collection_fingerprint:'b'.repeat(64),source_id:source,source_sha256:'c'.repeat(64),input_sha256:hash(input),attachment_sha256:'d'.repeat(64)},draft={rows:[['controlled lifecycle result']],links:[]};return {version:CREATIVE_TASK_PIPELINE,status:'needs_review',accepted:false,ready:false,delivery_enabled:false,binding,coverage:{continuous_video_read:false},source_reading:[],game_bridge:[],plan:{game:input.game},draft,draft_sha256:hash(draft),boundary:'controlled callbacks only',receipt:{provider:'codex-host',status:'completed',owned_process_closed:true,exit_code:0,tool_events:0,exec_attempts:1,runner_retries:0,input_sha256:binding.input_sha256,creative_version:CREATIVE_TASK_PIPELINE,input_binding:binding,audit_dir:folder}};};
 const deps={db,captureInput,prepareInput:async(input,ctx)=>{calls.prepare++;if(prepareHook)await prepareHook(input,ctx);return input;},runCandidate:async(input,ctx)=>{calls.run++;const value=output(input);if(runHook)return await runHook(value,ctx,input);return value;},revalidateInput:async(input,ctx)=>{calls.validate++;return validateHook?await validateHook(input,ctx):true;}};
 return {db,folder,calls,deps,make:overrides=>createCreativeTaskRunner({...deps,...overrides})};
}
test('strict explicit request captures one fixed cross-topic source and never accepts client rows/paths',()=>{
 assert.deepEqual(creativeTaskRequest(request()),request());
 for(const value of [null,{},[],{...request(),path:'/private'}, {...request(),source:{...request().source,title:'injected'}},{...request(),mode:'C'},{...request(),profile_version:'old'},{...request(),source:{...request().source,provider:'browser'}}])assert.throws(()=>creativeTaskRequest(value));
});
test('exact candidate identity deduplicates, public result omits private receipt and restart reads never infer',async t=>{
 const f=setup(t),runner=f.make(),first=await runner.create(request()),again=await runner.create(request());assert.equal(first.id,again.id);
 const result=await runner.run(first.id);assert.equal(result.state,'completed');assert.equal(result.task_store,'creative-candidate');assert.equal(result.result.status,'needs_review');assert.equal(result.result.accepted,false);assert.equal(result.result.delivery_enabled,false);assert(!JSON.stringify(result).includes(f.folder));assert.equal(f.calls.run,1);
 const restarted=f.make({runCandidate:()=>assert.fail('restart must not execute')});assert.deepEqual(restarted.read(first.id),result);assert.deepEqual(await restarted.run(first.id),result);assert.equal(f.calls.run,1);assert.equal(f.db.profile('游戏甲'),null);
 const other=await runner.create(request('游戏乙'));assert.notEqual(first.id,other.id);assert.equal(other.payload.game,'游戏乙');
});
test('queued legacy create tasks are not claimed, and started without a complete receipt never retries',async t=>{
 const f=setup(t),old=f.db.create('create',{game:'legacy',source:{kind:'video',source_id:source}}),runner=f.make(),task=await runner.create(request());
 f.db.checkpoint(`creative-task:${task.id}:started`,{owner:'dead'});f.db.db.prepare("UPDATE tasks SET state='running',owner='dead',lease=1 WHERE id=?").run(task.id);
 assert.equal((await runner.run(task.id)).state,'needs_input');assert.equal(f.calls.run,0);assert.equal(f.db.get(old.id).state,'queued');assert.throws(()=>runner.read(old.id),{code:'CREATIVE_TASK_NOT_FOUND'});
});
test('source drift before or after inference fails closed; missing or private output cannot publish',async t=>{
 for(const when of ['before','after','private','mismatch']){
  let checks=0;const f=setup(t,{validateHook:()=>++checks!==(when==='before'?1:when==='after'?2:-1),runHook:value=>{if(when==='private')value.coverage.path='/private/credential';if(when==='mismatch')value.binding.profile_version='f'.repeat(64);return value;}}),runner=f.make(),task=await runner.create(request()),result=await runner.run(task.id);
  assert.equal(result.state,'needs_input');assert.equal(result.result,null);assert.equal(f.calls.run,when==='before'?0:1);assert(!JSON.stringify(result).includes('/private'));assert.equal(f.db.profile('游戏甲'),null);
 }
});
test('cancel waits for its owned callback and late result cannot publish; a replacement owner is not cancelled',async t=>{
 const entered=deferred(),release=deferred(),f=setup(t,{runHook:async value=>{entered.resolve();await release.promise;return value;}}),runner=f.make(),task=await runner.create(request()),work=runner.run(task.id);await entered.promise;
 let done=false;const cancelled=runner.cancel(task.id).then(v=>{done=true;return v;});await Promise.resolve();assert.equal(done,false);release.resolve();assert.equal((await cancelled).state,'cancelled');await work;assert.equal(runner.read(task.id).result,null);
 const g=setup(t),second=g.make(),other=await second.create(request());g.db.db.prepare("UPDATE tasks SET state='running',owner='replacement',lease=? WHERE id=?").run(Date.now()+60000,other.id);
 await assert.rejects(second.cancel(other.id),{code:'CREATIVE_TASK_NOT_OWNER'});assert.equal(g.db.get(other.id).cancelled,0);assert.equal(g.db.get(other.id).owner,'replacement');
});
test('expired cancelled orphan converges only on explicit action; GET stays read-only',async t=>{
 const f=setup(t),runner=f.make(),task=await runner.create(request());f.db.db.prepare("UPDATE tasks SET state='running',cancelled=1,owner='dead',lease=1 WHERE id=?").run(task.id);
 assert.equal(runner.read(task.id).state,'running');assert.equal(f.db.get(task.id).owner,'dead');assert.equal((await runner.cancel(task.id)).state,'cancelled');assert.equal(f.calls.run,0);
});
test('input fingerprint changes create a different candidate, while tampered checkpoints never execute',async t=>{
 const f=setup(t),runner=f.make(),task=await runner.create(request());const key=`creative-task:${task.id}:input`,saved=f.db.checkpoint(key);saved.captured.selected.row.title='mutated';f.db.checkpoint(key,saved);
 assert.throws(()=>runner.run(task.id),{code:'CREATIVE_TASK_CAPTURE_CHANGED'});assert.equal(f.calls.run,0);
});
test('preparation cannot retarget mode/format/profile/source or change captured metadata before inference starts',async t=>{
 for(const mutate of [x=>{x.mode='A';x.format='image';},x=>{x.study.binding.profile_version='f'.repeat(64);},x=>{x.selected.row.title='replaced';}]){
  const f=setup(t,{prepareHook:mutate}),runner=f.make(),task=await runner.create(request()),result=await runner.run(task.id);
  assert.equal(result.state,'needs_input');assert.equal(f.calls.run,0);assert.equal(f.db.checkpoint(`creative-task:${task.id}:started`),null);assert.equal(result.result,null);
 }
});

test('explicit delivery read verifies fixed checkpoints and sources without another inference; altered output cannot be approved',async t=>{
 const f=setup(t),runner=f.make(),task=await runner.create(request());await assert.rejects(runner.readVerified(task.id),{code:'CREATIVE_TASK_CHECKPOINT'});
 const done=await runner.run(task.id);assert.deepEqual(await runner.readVerified(task.id),done);assert.equal(f.calls.run,1);
 const altered=structuredClone(done.result);altered.plan.game='替换游戏';f.db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(altered),task.id);await assert.rejects(runner.readVerified(task.id),{code:'CREATIVE_TASK_CHECKPOINT'});assert.equal(f.calls.run,1);
 f.db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify(done.result),task.id);f.db.checkpoint(`creative-task:${task.id}:public`,{result:altered,sha256:hash(altered)});await assert.rejects(runner.readVerified(task.id),{code:'CREATIVE_TASK_CHECKPOINT'});
 const g=setup(t);let valid=true;const second=g.make({revalidateInput:async()=>valid}),other=await second.create(request());await second.run(other.id);valid=false;await assert.rejects(second.readVerified(other.id),{code:'CREATIVE_TASK_SOURCE_CHANGED'});assert.equal(g.calls.run,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Tasks,hash} from '../app/tasks.mjs';
import {createStudyService} from '../app/study-service.mjs';
import {STUDY_TASK_PIPELINE,createStudyTaskRunner} from '../app/study-task.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const request=game=>({game,learning_source:'network'});
function library(value){
 const fp=hash(value),row={provider:value.learning_source==='network'?'redfox':'local_upload',game:value.game,source_id:'7695600881273670946',availability:'available'};
 return {game:value.game,binding:{source_provider:'game_study_library',game:value.game,library_id:'library_'+fp,library_fingerprint:fp,collection:value.learning_source==='network'?{collection_request_id:'query'}:null},records:[row],items:[{media:{path:'/private/original.mp4'}}]};
}
function output(game){
 return {version:STUDY_TASK_PIPELINE,receipt:{provider:'codex-host',status:'completed',owned_process_closed:true,tool_events:0,exec_attempts:1,runner_retries:0,game_study_version:STUDY_TASK_PIPELINE,audit_dir:'/private/audit'},draft:{game,background_and_loop:[],player_situations:[],necessary_terms:[],content_types:[],expression_methods:[],platform_actions:[],peer_transfer:[],unknowns:[]},coverage:{status:'partial',domains:{},image_pages:[]},comparisonMetrics:{groups:[],excluded:[],window:null}};
}
function fixture(t,extra={}){
 const folder=mkdtempSync(join(tmpdir(),'study-service-')),db=new Tasks(folder),calls={capture:0,prepare:0,run:0,validate:0};
 t.after(()=>{db.close();rmSync(folder,{recursive:true,force:true});});
 const deps={db,canStart:()=>true,captureInput:async value=>{calls.capture++;return library(value);},preparePacket:async(lib,ctx)=>{calls.prepare++;return {packet:{game:ctx.game,learning_source:ctx.learning_source,library:{binding:lib.binding,records:lib.records}},images:[],files:[]};},runStudy:async(p,ctx)=>{calls.run++;return output(ctx.game);},revalidateInput:async()=>{calls.validate++;return true;},...extra};
 return {folder,db,calls,deps,service:createStudyService(deps)};
}
test('explicit starts capture input and run FIFO with one active callback; duplicate task executes once',async t=>{
 const held=deferred(),entered=deferred(),order=[];let active=0,max=0;
 const f=fixture(t,{runStudy:async(p,ctx)=>{order.push(ctx.game);active++;max=Math.max(max,active);if(ctx.game==='甲'){entered.resolve();await held.promise;}active--;return output(ctx.game);}});
 const value=request('甲'),first=f.service.start(value);value.game='wrong';const a=await first;await entered.promise;
 const same=await f.service.start(request('甲')),b=await f.service.start(request('乙'));assert.equal(same.id,a.id);assert.equal(b.state,'queued');
 assert.equal(f.service.read(a.id).resume_required,false);assert.equal(f.service.read(b.id).resume_required,false);
 held.resolve();await f.service.idle();assert.deepEqual(order,['甲','乙']);assert.equal(max,1);assert.equal(f.service.read(a.id).state,'completed');assert.equal(f.service.read(b.id).state,'completed');
 await f.service.start(request('甲'));await f.service.idle();assert.deepEqual(order,['甲','乙']);
 assert.equal(f.service.profile(request('甲')).task_id,a.id);assert.equal(f.service.read(a.id).task_store,'game-study');
});
test('gate false and invalid/local inputs cause zero capture; gate is checked again at FIFO dispatch and reads cannot resume',async t=>{
 let gate=false;const held=deferred(),entered=deferred();const f=fixture(t,{canStart:()=>gate,runStudy:async(p,ctx)=>{f.calls.run++;if(ctx.game==='甲'){entered.resolve();await held.promise;}return output(ctx.game);}});
 await assert.rejects(f.service.start(request('甲')),{code:'STUDY_SERVICE_HELD'});assert.equal(f.calls.capture,0);
 for(const value of [{game:'甲',learning_source:'local'},{...request('甲'),rows:[]},{game:'甲'},null])await assert.rejects(f.service.start(value),{code:'STUDY_SERVICE_INPUT_INVALID'});
 gate=true;const a=await f.service.start(request('甲'));await entered.promise;const b=await f.service.start(request('乙'));
 gate=false;held.resolve();await f.service.idle();assert.equal(f.calls.run,1);assert.equal(f.service.read(b.id).state,'queued');
 const calls={...f.calls};gate=true;f.service.read(b.id);f.service.list();f.service.has(a.id);f.service.profile(request('甲'));await f.service.idle();assert.deepEqual(f.calls,calls);
 await f.service.start(request('乙'));await f.service.idle();assert.equal(f.calls.run,2);
});
test('cancel queued task never prepares it; active cancellation waits callback and discards late output',async t=>{
 const entered=deferred(),held=deferred();let signal;
 const f=fixture(t,{runStudy:async(p,ctx)=>{f.calls.run++;signal=ctx.signal;entered.resolve();await held.promise;return output(ctx.game);}});
 const a=await f.service.start(request('甲'));await entered.promise;const b=await f.service.start(request('乙'));
 assert.equal((await f.service.cancel(b.id)).state,'cancelled');let settled=false;const cancellation=f.service.cancel(a.id).then(r=>{settled=true;return r;});
 await Promise.resolve();assert(signal.aborted);assert.equal(settled,false);held.resolve();assert.equal((await cancellation).state,'cancelled');await f.service.idle();
 assert.equal(f.calls.prepare,1);assert.equal(f.calls.run,1);assert.equal(f.db.profile('甲'),null);assert.equal(f.db.get(a.id).owner,null);
});
test('read APIs isolate current network pipeline from legacy/local/other games and never execute callbacks after restart',async t=>{
 const f=fixture(t),a=await f.service.start(request('甲'));await f.service.idle();
 const legacy=f.db.create('learn',{game:'甲'}),other=f.db.create('create',{game:'x',profile_version:'x',source:{kind:'video',source_id:'x'}});
 const localRunner=createStudyTaskRunner(f.deps),local=await localRunner.create({game:'甲',learning_source:'local'});
 const reject=()=>assert.fail('read-only operation cannot call provider');
 const service=createStudyService({...f.deps,captureInput:reject,preparePacket:reject,runStudy:reject,revalidateInput:reject});
 assert.equal(service.has(legacy.id),false);assert.equal(service.has(other.id),false);assert.equal(service.has(local.id),false);assert.equal(service.has('missing'),false);
 for(const id of [legacy.id,other.id,local.id,'missing'])assert.throws(()=>service.read(id),{code:'STUDY_SERVICE_TASK_NOT_FOUND'});
 assert.deepEqual(service.list('甲').map(x=>x.id),[a.id]);assert.deepEqual(service.list('乙'),[]);assert.equal(service.profile(request('乙')),null);
 assert.throws(()=>service.profile({game:'甲',learning_source:'local'}),{code:'STUDY_SERVICE_INPUT_INVALID'});
 assert(!JSON.stringify([service.read(a.id),service.profile(request('甲'))]).includes('/private'));
 await service.idle();assert.equal(f.db.get(legacy.id).state,'queued');assert.equal(f.db.get(local.id).state,'queued');
});
test('failed and interrupted inference are not retried by start or rebuilt service',async t=>{
 const f=fixture(t,{runStudy:async()=>{f.calls.run++;throw Error('/private/upstream');}});
 const failed=await f.service.start(request('甲'));await f.service.idle();assert.equal(f.service.read(failed.id).state,'needs_input');
 await f.service.start(request('甲'));await f.service.idle();assert.equal(f.calls.run,1);assert(!f.service.read(failed.id).error.includes('/private'));
 const runner=createStudyTaskRunner(f.deps),crashed=await runner.create(request('乙'));
 f.db.checkpoint('study-task:'+crashed.id+':inference-started',{owner:'dead'});
 f.db.db.prepare("UPDATE tasks SET state='running',owner='dead',lease=1 WHERE id=?").run(crashed.id);
 const rebuilt=createStudyService({...f.deps,runStudy:()=>assert.fail('must not rerun interrupted inference')});
 assert.equal(rebuilt.read(crashed.id).state,'running');await rebuilt.idle();assert.equal(f.db.get(crashed.id).state,'running');
 await rebuilt.start(request('乙'));await rebuilt.idle();assert.equal(rebuilt.read(crashed.id).state,'needs_input');
});
test('stop cancels queued/owned active callbacks, waits for closure, rejects starts and is idempotent',async t=>{
 const held=deferred(),entered=deferred();let signal;
 const f=fixture(t,{runStudy:async(p,ctx)=>{signal=ctx.signal;entered.resolve();await held.promise;return output(ctx.game);}});
 const a=await f.service.start(request('甲'));await entered.promise;const b=await f.service.start(request('乙'));
 let closed=false;const ending=f.service.stop().then(()=>{closed=true;});
 await new Promise(r=>setImmediate(r));assert(signal.aborted);assert.equal(closed,false);
 await assert.rejects(f.service.start(request('丙')),{code:'STUDY_SERVICE_STOPPED'});held.resolve();await ending;await f.service.stop();
 for(const id of [a.id,b.id]){const row=f.db.get(id);assert.equal(row.state,'cancelled');assert.equal(row.owner,null);assert.equal(row.lease,0);}
});
test('stop during snapshot capture does not enqueue late input; cancellation never changes replacement owner',async t=>{
 const captured=deferred(),release=deferred(),f=fixture(t,{captureInput:async value=>{captured.resolve();await release.promise;return library(value);}});
 const starting=f.service.start(request('甲'));await captured.promise;const rejected=assert.rejects(starting,{code:'STUDY_SERVICE_STOPPED'}),stopping=f.service.stop();release.resolve();await rejected;await stopping;
 assert.equal(f.calls.run,0);assert.equal(f.db.list()[0].state,'cancelled');
 const g=fixture(t),runner=createStudyTaskRunner(g.deps),foreign=await runner.create(request('甲'));
 g.db.db.prepare("UPDATE tasks SET state='running',owner='foreign',lease=? WHERE id=?").run(Date.now()+30000,foreign.id);
 await assert.rejects(g.service.cancel(foreign.id),{code:'STUDY_SERVICE_NOT_OWNER'});await g.service.stop();assert.equal(g.db.get(foreign.id).owner,'foreign');assert.equal(g.db.get(foreign.id).cancelled,0);
});

test('reconstructed service marks orphan queued or expired running as explicit-resume only, with zero read callbacks or writes',async t=>{
 const f=fixture(t),runner=createStudyTaskRunner(f.deps),task=await runner.create(request('甲'));
 const service=createStudyService(f.deps),before={...f.calls},stored=f.db.get(task.id);
 assert.equal(service.read(task.id).resume_required,true);assert.equal(service.list('甲')[0].resume_required,true);
 await service.idle();assert.deepEqual(f.calls,before);assert.deepEqual(f.db.get(task.id),stored);
 const started=await service.start(request('甲'));assert.equal(started.id,task.id);assert.equal(started.resume_required,false);
 await service.idle();assert.equal(f.calls.run,1);assert.equal(service.read(task.id).resume_required,false);
 await service.start(request('甲'));await service.idle();assert.equal(f.calls.run,1);
 const other=await runner.create(request('乙'));
 f.db.db.prepare("UPDATE tasks SET state='running',owner='other-process',lease=? WHERE id=?").run(Date.now()+30000,other.id);
 assert.equal(service.read(other.id).resume_required,false);
 f.db.db.prepare('UPDATE tasks SET lease=1 WHERE id=?').run(other.id);
 const expired=f.db.get(other.id),reads={...f.calls};
 assert.equal(service.read(other.id).resume_required,true);await service.idle();
 assert.deepEqual(f.db.get(other.id),expired);assert.deepEqual(f.calls,reads);
 for(const state of ['completed','needs_input','cancelled','failed']){
  f.db.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(state,other.id);
  assert.equal(service.read(other.id).resume_required,false);
 }
});

test('explicit start/cancel settle cancelled expired orphan without inference; GET and live leases remain untouched',async t=>{
 const f=fixture(t),runner=createStudyTaskRunner(f.deps),a=await runner.create(request('甲')),b=await runner.create(request('乙')),live=await runner.create(request('丙'));
 for(const task of [a,b,live])f.db.db.prepare("UPDATE tasks SET state='running',cancelled=1,owner='dead-owner',lease=? WHERE id=?").run(task===live?Date.now()+30000:1,task.id);
 const service=createStudyService(f.deps),before={...f.calls},saved=f.db.get(a.id);
 assert.equal(service.read(a.id).resume_required,true);assert.deepEqual(f.db.get(a.id),saved);assert.deepEqual(f.calls,before);
 const started=await service.start(request('甲'));await service.idle();assert.equal(started.state,'cancelled');assert.equal(started.resume_required,false);
 assert.equal((await service.cancel(b.id)).state,'cancelled');
 for(const task of [a,b]){const row=f.db.get(task.id);assert.equal(row.owner,null);assert.equal(row.lease,0);}
 assert.equal(f.calls.prepare,0);assert.equal(f.calls.run,0);assert.equal(f.calls.validate,0);
 const liveBefore=f.db.get(live.id);await service.start(request('丙'));await service.idle();
 await assert.rejects(service.cancel(live.id),{code:'STUDY_SERVICE_NOT_OWNER'});assert.deepEqual(f.db.get(live.id),liveBefore);
});

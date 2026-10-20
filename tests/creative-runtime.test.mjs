import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCreativeRuntime} from '../app/creative-runtime.mjs';
import {fixture,output,fakeHost} from './helpers/creative-fixture.mjs';
const query='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,{host,sourceHook}={}){
 const f=fixture(t),cli=join(f.root,'configured-cli');writeFileSync(cli,'never executed');chmodSync(cli,0o700);
 f.input.selected.row.collection_request_id=query;f.input.selected.collection.request_id=query;
 const calls={study:0,source:0,asset:0,media:0,factory:0};let enabled=true;
 const request={game:f.input.game,mode:'A',format:'video',study_task_id:f.study.binding.task_id,profile_version:f.study.profile.version,source:{provider:'redfox',request_id:query,source_id:f.input.selected.row.source_id}};
 const deps={dataRoot:f.root,cliPath:cli,python:'controlled-unused',isEnabled:()=>enabled,
  getStudyEvidence:async input=>{calls.study++;assert.equal(input.taskId,request.study_task_id);assert.equal(input.profileVersion,request.profile_version);return structuredClone(f.study);},
  getSource:async input=>{calls.source++;assert.equal(input.request_id,query);if(sourceHook)await sourceHook();return {row:structuredClone(f.input.selected.row),collection:structuredClone(f.input.selected.collection)};},
  assets:{read:async row=>{calls.asset++;return {provider:'redfox',status:'av_readable',source_id:row.source_id,url:row.source_url,current_collection_request_id:query,source_path:f.media.path,source_sha256:f.media.sha256,bytes:f.media.size};}},
  mediaFactory:()=>({prepare:async(item,ctx)=>{calls.media++;ctx.stage('读取实际视频并提取3张代表画面');return structuredClone(f.prepared);}}),
  hostFactory:()=>{calls.factory++;return host||fakeHost(output(f.input.game));}
 };
 const make=overrides=>{const r=createCreativeRuntime({...deps,...overrides});t.after(()=>r.close());return r;};
 return {...f,cli,calls,request,deps,make,setEnabled:value=>enabled=value};
}
test('explicit source/profile candidate uses the actual engine, deduplicates and leaves read APIs inference-free',async t=>{
 const host=fakeHost(),f=setup(t,{host}),runtime=f.make(),task=await runtime.start(f.request);await runtime.idle();
 const done=runtime.read(task.id);assert.equal(done.state,'completed');assert.equal(done.result.status,'needs_review');assert.equal(done.result.delivery_enabled,false);assert.equal(host.calls.length,1);assert.equal(f.calls.media,1);assert.equal(f.calls.study,3);assert.equal(f.calls.source,3);assert(!JSON.stringify(done).includes(f.root));
 const counts=structuredClone(f.calls);runtime.read(task.id);runtime.list();await runtime.idle();assert.deepEqual(f.calls,counts);
 assert.equal((await runtime.start(f.request)).id,task.id);await runtime.idle();assert.equal(host.calls.length,1);assert.equal(f.calls.media,1);
 const db=new DatabaseSync(join(f.root,'creative-candidate-tasks/tasks.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM profiles').get().n,0);}finally{db.close();}
});
test('disabled and missing CLI fail before source reads, factories, task creation or inference',async t=>{
 for(const mode of ['held','cli']){const f=setup(t);if(mode==='held')f.setEnabled(false);const runtime=f.make(mode==='cli'?{cliPath:join(f.root,'missing')} :{});
  await assert.rejects(runtime.start(f.request),{code:mode==='held'?'CREATIVE_RUNTIME_HELD':'CREATIVE_HOST_CONFIGURATION_REQUIRED'});assert.equal(f.calls.study,0);assert.equal(f.calls.source,0);assert.equal(f.calls.factory,0);assert.equal(runtime.list().length,0);
 }
});
test('two explicit candidates dispatch FIFO, never concurrently, and preserve requested A/B mode',async t=>{
 const entered=deferred(),release=deferred();let active=0,peak=0,n=0;
 const host=fakeHost(output(),async()=>{active++;peak=Math.max(peak,active);if(++n===1){entered.resolve();await release.promise;}active--;});
 const f=setup(t,{host}),runtime=f.make(),a=await runtime.start(f.request);await entered.promise;const b=await runtime.start({...f.request,mode:'B'});assert.notEqual(a.id,b.id);assert.equal(host.calls.length,1);release.resolve();await runtime.idle();assert.equal(host.calls.length,2);assert.equal(peak,1);assert.equal(runtime.read(a.id).result.mode,'A');assert.equal(runtime.read(b.id).result.mode,'B');
});
test('close cancels queued work, waits for its owned callback and never publishes late results',async t=>{
 const entered=deferred(),release=deferred(),host=fakeHost(output(),async()=>{entered.resolve();await release.promise;}),f=setup(t,{host}),runtime=f.make(),a=await runtime.start(f.request);await entered.promise;const b=await runtime.start({...f.request,mode:'B'});
 let closed=false;const closing=runtime.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);release.resolve();await closing;
 const db=new DatabaseSync(join(f.root,'creative-candidate-tasks/tasks.sqlite'),{readOnly:true});try{for(const id of [a.id,b.id]){const row=db.prepare('SELECT state,result,owner FROM tasks WHERE id=?').get(id);assert.equal(row.state,'cancelled');assert.equal(row.result,null);assert.equal(row.owner,null);}}finally{db.close();}assert.equal(host.calls.length,1);
});
test('restarted queued candidate is read-only until explicitly continued; a closed gate cannot dispatch it',async t=>{
 let firstRead=true;const f=setup(t,{sourceHook:()=>{if(firstRead){firstRead=false;f.setEnabled(false);}}}),one=f.make();await assert.rejects(one.start(f.request),{code:'CREATIVE_RUNTIME_HELD'});const task=one.list()[0];assert.equal(task.resume_required,true);assert.equal(task.state,'queued');assert.equal(f.calls.media,0);await one.close();
 f.setEnabled(true);const two=f.make(),before=structuredClone(f.calls);assert.equal(two.read(task.id).resume_required,true);await two.idle();assert.deepEqual(f.calls,before);assert.equal((await two.start(f.request)).id,task.id);await two.idle();assert.equal(two.read(task.id).state,'completed');assert.equal(f.calls.media,1);
});
test('a trusted isolation store must stay inside the canonical data root and cannot traverse a symlink',t=>{
 const f=setup(t);symlinkSync(f.root,join(f.root,'alias'),'dir');assert.throws(()=>f.make({taskDirectory:join(f.root,'alias/nested')}),{code:'CREATIVE_RUNTIME_PATH'});assert.throws(()=>f.make({taskDirectory:join(f.root,'../outside')}),{code:'CREATIVE_RUNTIME_PATH'});
 const r=f.make({taskDirectory:join(f.root,'acceptance/candidate-store')});assert.deepEqual(r.list(),[]);
});
test('explicit start safely settles an expired cancellation after restart without inference',async t=>{
 let first=true;const f=setup(t,{sourceHook:()=>{if(first){first=false;f.setEnabled(false);}}}),one=f.make();await assert.rejects(one.start(f.request));const task=one.list()[0];await one.close();
 const db=new DatabaseSync(join(f.root,'creative-candidate-tasks/tasks.sqlite'));db.prepare("UPDATE tasks SET state='running',cancelled=1,owner='dead',lease=1 WHERE id=?").run(task.id);db.close();
 f.setEnabled(true);const two=f.make();assert.equal(two.read(task.id).state,'running');assert.equal(two.read(task.id).resume_required,true);assert.equal((await two.start(f.request)).state,'cancelled');await two.idle();assert.equal(f.calls.media,0);assert.equal(two.read(task.id).resume_required,false);
});

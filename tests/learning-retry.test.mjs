import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Tasks} from '../app/tasks.mjs';

const payload=()=>({game:'受控重试',source_provider:'redfox',learning_pipeline:'candidate-only',collection_request_id:'receipt',collection_fingerprint:'fingerprint'});
async function setup(t){const folder=await mkdtemp(join(tmpdir(),'learning-retry-')),db=new Tasks(folder);t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});return {folder,db};}
function terminal(db,task,state='failed'){db.db.prepare('UPDATE tasks SET state=?,owner=NULL,error=?,result=? WHERE id=?').run(state,'local stage failed',JSON.stringify({checkpoint:'original-failure',evidence:['preserved']}),task.id);}

test('explicit terminal retry atomically issues one server grant and preserves failure history and payload',async t=>{
 const {folder,db}=await setup(t),task=db.create('learn',payload()),original=task.payload;
 assert.equal(db.learningRetry(task.id),null);terminal(db,task);
 const second=new Tasks(folder);t.after(()=>second.close());
 db.retry(task.id);const first=db.learningRetry(task.id);
 assert.equal(first.task_id,task.id);assert.equal(first.generation,1);assert.match(first.attempt_id,/^[a-f0-9-]{36}$/);assert.equal(first.authorization,'explicit_task_retry');assert(Number.isFinite(Date.parse(first.authorized_at)));
 second.retry(task.id);assert.deepEqual(second.learningRetry(task.id),first);assert.deepEqual(db.get(task.id).payload,original);assert.equal(db.get(task.id).key,task.key);
 const receipt=db.db.prepare('SELECT * FROM learning_retry_authorizations WHERE task_id=?').get(task.id);
 assert.equal(receipt.previous_error,'local stage failed');assert.equal(receipt.previous_state,'failed');assert.deepEqual(JSON.parse(receipt.previous_result),{checkpoint:'original-failure',evidence:['preserved']});
 assert.deepEqual(db.get(task.id).result,JSON.parse(receipt.previous_result));
 terminal(db,task,'needs_input');db.retry(task.id);const next=db.learningRetry(task.id);assert.equal(next.generation,2);assert.notEqual(next.attempt_id,first.attempt_id);
 assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM learning_retry_authorizations').get().n,2);
});

test('new tasks, ineligible states, an owned terminal state and copied payload fields do not mint grants',async t=>{
 const {db}=await setup(t);
 for(const state of ['queued','running','completed','completed_with_warnings']){
  const task=db.create('learn',{...payload(),learningRetry:{attempt_id:'client'},learning_retry:{token:'client'},retry_token:'client'},state);
  db.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(state,task.id);db.retry(task.id);assert.equal(db.learningRetry(task.id),null);
 }
 const owned=db.create('learn',payload(),'owned');terminal(db,owned);db.db.prepare('UPDATE tasks SET owner=? WHERE id=?').run('live-owner',owned.id);db.retry(owned.id);assert.equal(db.learningRetry(owned.id),null);assert.equal(db.get(owned.id).state,'failed');
 for(const p of [{game:'legacy'},{...payload(),source_provider:'browser'},{...payload(),collection_request_id:''}]){
  const task=db.create('learn',p);terminal(db,task);db.retry(task.id);assert.equal(db.learningRetry(task.id),null);
 }
 const create=db.create('create',{game:'other',source:{kind:'video',source_id:'1'}});terminal(db,create);db.retry(create.id);assert.equal(db.learningRetry(create.id),null);
 const cancelled=db.create('learn',payload(),'cancelled');terminal(db,cancelled,'cancelled');db.retry(cancelled.id);assert.equal(db.learningRetry(cancelled.id).generation,1);
});

test('automatic lease recovery never creates or rotates explicit authorization and owner check is enforced',async t=>{
 const {db}=await setup(t),task=db.create('learn',payload());db.claim('dead');db.db.prepare('UPDATE tasks SET lease=0 WHERE id=?').run(task.id);
 db.claim('recovered');assert.equal(db.learningRetry(task.id,'recovered'),null);
 terminal(db,task);db.retry(task.id);const grant=db.learningRetry(task.id);db.claim('dead-again');db.db.prepare('UPDATE tasks SET lease=0 WHERE id=?').run(task.id);db.claim('new-owner');
 assert.deepEqual(db.learningRetry(task.id,'new-owner'),grant);assert.equal(db.learningRetry(task.id,'dead-again'),null);assert.equal(db.learningRetry(task.id,'wrong-owner'),null);
 assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM learning_retry_authorizations').get().n,1);
});

test('failed task state transition rolls back the new retry grant',async t=>{
 const {db}=await setup(t),task=db.create('learn',payload());terminal(db,task);
 db.db.exec("CREATE TRIGGER reject_retry BEFORE UPDATE OF state ON tasks WHEN NEW.state='queued' BEGIN SELECT RAISE(ABORT,'controlled state failure'); END");
 assert.throws(()=>db.retry(task.id),/controlled state failure/);assert.equal(db.learningRetry(task.id),null);assert.equal(db.get(task.id).state,'failed');assert.equal(db.get(task.id).error,'local stage failed');
 db.db.exec("DROP TRIGGER reject_retry; CREATE TRIGGER ignore_retry BEFORE UPDATE OF state ON tasks WHEN NEW.state='queued' BEGIN SELECT RAISE(IGNORE); END");
 db.retry(task.id);assert.equal(db.learningRetry(task.id),null);assert.equal(db.get(task.id).state,'failed');
});

test('worker forwards only the durable server grant to mocked preliminary learning; production gates remain untouched',async t=>{
 const {folder}=await setup(t);
 // Process-local module mocks exercise the real worker without opening the
 // production quality gate, running a model, a service or any network call.
 const source=`
 import {registerHooks} from 'node:module';
 import assert from 'node:assert/strict';
 registerHooks({load(url,context,next){
  if(url.endsWith('/app/quality-policy.mjs'))return {format:'module',shortCircuit:true,source:"export const experimentalQualityHold=()=>({reason:'mock hold'}); export const projectQualityHeldProfile=p=>p; export const assertQualityExecutionAllowed=()=>{};"};
  if(url.endsWith('/app/learning-snapshot.mjs'))return {format:'module',shortCircuit:true,source:"export class LearningSnapshotError extends Error{}; export const resolveBoundGameCollection=()=>globalThis.retryFixtureSnapshot; export const readLearningSnapshot=()=>{throw Error('media snapshot is outside this worker retry fixture');};"};
  return next(url,context);
 }});
 const {Tasks}=await import(${JSON.stringify(new URL('../app/tasks.mjs',import.meta.url).href)});
 const {serverLearningBinding}=await import(${JSON.stringify(new URL('../app/learning-contract.mjs',import.meta.url).href)});
 const {startWorker}=await import(${JSON.stringify(new URL('../app/worker.mjs',import.meta.url).href)});
 const db=new Tasks(${JSON.stringify(folder)}),seen=[];
 const snapshot=globalThis.retryFixtureSnapshot={binding:{source_provider:'redfox',collection_request_id:'fixture',collection_fingerprint:'f'.repeat(64)},provenance:{game:'受控重试',provider:'redfox',request_id:'fixture'},records:[{source_id:'1',kind:'video'}]};
 const task=db.create('learn',{...serverLearningBinding(snapshot),taskOwner:'payload-owner-forgery',learningRetry:{attempt_id:'payload-forgery'},learning_retry:{attempt_id:'payload-forgery'}});
 const worker=startWorker(db,{interval:999999,gameProvider:'redfox',bridge:{},model:{identity:()=>assert.fail('no model'),json:()=>assert.fail('no model')},preliminaryLearning:async(s,ctx)=>{
  assert.deepEqual(s,snapshot);assert.equal(ctx.taskOwner,db.get(task.id).owner);assert.match(ctx.taskOwner,/^[a-f0-9-]{36}$/);assert.notEqual(ctx.taskOwner,task.payload.taskOwner);seen.push(ctx.learningRetry);return {status:'needs_input',blocking_gaps:['controlled stop']};
 }});
 try{await worker.tick();assert.equal(seen.length,1);assert.equal(seen[0],null);
  db.retry(task.id);const grant=db.learningRetry(task.id);await worker.tick();assert.equal(seen.length,2);assert.deepEqual(seen[1],grant);assert.notEqual(grant.attempt_id,'payload-forgery');assert.equal(grant.generation,1);
 }finally{worker.stop();db.close();}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr||child.error?.message);assert.equal(child.signal,null);
});

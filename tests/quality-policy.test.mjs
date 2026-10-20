import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Tasks,hash} from '../app/tasks.mjs';
import {deliver,composeRows} from '../app/delivery.mjs';
import {SideBridge} from '../app/side-bridge.mjs';
import {randomUUID} from 'node:crypto';
import {startWorker} from '../app/worker.mjs';
import {experimentalQualityHold,projectQualityHeldProfile,assertQualityExecutionAllowed,qualityCapabilities,networkStudyEnabled} from '../app/quality-policy.mjs';

const game='受控质量暂停测试';
test('limited explicit network dossier does not release old learning, creation or delivery',()=>{
 const caps=qualityCapabilities();assert.equal(networkStudyEnabled(),true);assert.equal(caps.study.enabled,true);assert.equal(caps.study.semantic_acceptance,false);assert.equal(caps.study.automatic_paid_collection,false);
 assert.equal(caps.creative_candidate.enabled,true);assert.equal(caps.creative_candidate.semantic_acceptance,false);assert.equal(caps.creative_candidate.automatic_paid_collection,false);assert.equal(caps.creative_candidate.delivery_enabled,false);
 assert.equal(caps.reviewed_candidate_delivery.enabled,true);assert.equal(caps.reviewed_candidate_delivery.pipeline,'four-template-delivery-1');assert.equal(caps.reviewed_candidate_delivery.requires_template_plan_confirmation,true);assert.equal(caps.reviewed_candidate_delivery.automatic_resume,false);
 for(const key of ['learning','creation','delivery'])assert.equal(caps[key].enabled,false);
 for(const key of ['learn','create','delivery'])assert.throws(()=>assertQualityExecutionAllowed(key,{}),{code:'EXPERIMENTAL_QUALITY_HOLD'});
});
const profile=()=>({game,status:'ready',version:'old-ready',expires_at:new Date(Date.now()+86400000).toISOString(),
  relevant_video_ids:Array.from({length:20},(_,i)=>'video:'+String(7696356432198913300n+BigInt(i))),
  evidence:Array.from({length:20},(_,i)=>({id:'video:'+String(7696356432198913300n+BigInt(i)),kind:'video',counts_as_relevant:true,summary_quality:{status:'consistent',checks:[{relation:'supported'}]}})),
  blocking_gaps:[],experimental_quality_hold:{active:false}});
const createPayload=()=>({game,profile_version:'old-ready',mode:'A',format:'video',source:{kind:'video',provider:'redfox',source_id:'7696356432198913300'},experimental_quality_hold:{active:false}});
async function setup(t){const folder=await mkdtemp(join(tmpdir(),'crawl-quality-hold-')),db=new Tasks(folder);t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});return {folder,db};}

test('fixed server quality policy overrides all-supported machine/client profiles without rewriting old evidence',()=>{
 const old=profile(),saved=structuredClone(old),projected=projectQualityHeldProfile(old);
 assert.equal(projected.status,'needs_input');assert.equal(projected.experimental_quality_hold.active,true);
 assert.equal(projected.evidence.length,20);assert.deepEqual(old,saved);assert(Object.isFrozen(experimentalQualityHold()));
 assert.throws(()=>{experimentalQualityHold().active=false;},TypeError);
 assert.throws(assertQualityExecutionAllowed,e=>e.code==='EXPERIMENTAL_QUALITY_HOLD');
 assert.equal(projectQualityHeldProfile(projected).blocking_gaps.length,1);
 assert.equal(projectQualityHeldProfile(null),null);
});

test('old queued learn/create and direct DB retries stop before models, searches, media or writes and preserve checkpoints',async t=>{
 const {db}=await setup(t);db.profile(game,profile());
 const calls=[];const forbidden=name=>async()=>{calls.push(name);throw Error('forbidden '+name);};
 const worker=startWorker(db,{interval:999999,browserMode:'side-browser',gameProvider:'redfox',
  model:{identity:forbidden('identity'),json:forbidden('json')},search:forbidden('search'),web:forbidden('web'),
  fingerprintMedia:forbidden('fingerprint'),readMedia:forbidden('media'),preliminaryLearning:forbidden('learning'),publish:forbidden('publish'),
  bridge:{completedDelivery:()=>null,request:forbidden('request'),wait:forbidden('wait'),get:forbidden('snapshot')},
 });t.after(()=>worker.stop());
 for(const type of ['learn','create']){
  const task=db.create(type,type==='create'?createPayload():{game,source_provider:'redfox',experimental_quality_hold:{active:false}});
  const evidence={read_at:'2026-10-18T00:00:00Z',raw:'preserved evidence'};
  db.checkpoint('video-evidence:'+task.id,evidence);
  db.db.prepare('UPDATE tasks SET result=? WHERE id=?').run(JSON.stringify({evidence:[evidence]}),task.id);
  for(let i=0;i<2;i++){
   await worker.tick();const held=db.get(task.id);
   assert.equal(held.state,'needs_input');assert.equal(held.result.experimental_quality_hold.active,true);
   assert.match(held.error,/摘要忠实性/);assert.deepEqual(held.result.evidence,[evidence]);
   assert.deepEqual(db.checkpoint('video-evidence:'+task.id),evidence);assert.deepEqual(calls,[]);
   if(i===0)db.retry(task.id);
  }
 }
 assert.equal(db.profile(game).status,'ready');
});

test('readiness becoming ready cannot clear quality hold or start model initialization',async t=>{
 const {db}=await setup(t);let ready=false,modelCalls=0;
 const task=db.create('learn',{game});
 const worker=startWorker(db,{interval:999999,canRun:()=>ready,model:{identity:async()=>{modelCalls++;throw Error('unexpected');}}});t.after(()=>worker.stop());
 await worker.tick();assert.equal(db.get(task.id).state,'queued');
 ready=true;await worker.tick();assert.equal(db.get(task.id).state,'needs_input');assert.equal(modelCalls,0);
 db.retry(task.id);await worker.tick();assert.equal(db.get(task.id).state,'needs_input');assert.equal(modelCalls,0);
});

test('HTTP old-ready GET, cached/forced learning, creation, retry and refresh cannot release the hold',async t=>{
 const {db,folder}=await setup(t);const original=profile();db.profile(game,original);
 const learn=db.create('learn',{game}),create=db.create('create',createPayload());
 db.db.prepare("UPDATE tasks SET state='needs_input'").run();
 const port=14326,base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,[fileURLToPath(new URL('../app/server.mjs',import.meta.url))],{
  env:{...process.env,PORT:String(port),CRAWL_DATA_DIR:folder,CRAWL_SEARCH_MODE:'manual',CRAWL_GAME_SOURCE:'browser',CRAWL_HOTSPOT_SOURCE:'browser',CRAWL_MODEL_URL:'http://127.0.0.1:1',REDFOX_API_KEY:'',EXPERIMENTAL_QUALITY_HOLD:'false'},stdio:'pipe'});
 let stderr='';child.stderr.on('data',b=>stderr+=b);
 t.after(async()=>{child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r));});
 let token;for(let i=0;i<60;i++){try{const r=await fetch(base+'/api/session');if(r.ok){token=(await r.json()).token;break;}}catch{}await delay(50);}assert(token,stderr);
 const post=(path,payload={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-crawl-token':token},body:JSON.stringify(payload)});
 const projected=await(await fetch(base+'/api/game-profile?game='+encodeURIComponent(game))).json();
 assert.equal(projected.status,'needs_input');assert.equal(projected.independent_content_count,20);assert.equal(projected.experimental_quality_hold.active,true);assert.deepEqual(db.profile(game),original);
 for(const [path,payload] of [
  ['/api/game-research',{game,force:false,experimental_quality_hold:{active:false}}],
  ['/api/game-research',{game,force:true,experimental_quality_hold:{active:false}}],
  ['/api/creative-jobs',{game,source_id:'7696356432198913300',kind:'video',experimental_quality_hold:{active:false}}],
  ['/api/tasks/'+learn.id+'/retry',{}],['/api/tasks/'+create.id+'/retry',{}],
 ]){const response=await post(path,payload);assert.equal(response.status,409,path);assert.equal((await response.json()).code,'EXPERIMENTAL_QUALITY_HOLD');}
 assert.equal(db.list().length,2);assert.equal(db.get(learn.id).state,'needs_input');assert.equal(db.get(create.id).state,'needs_input');
 const refresh=await post('/api/refresh',{experimental_quality_hold:{active:false}});assert.equal(refresh.status,202);assert.equal((await refresh.json()).experimental_quality_hold.active,true);
 assert.equal((await(await fetch(base+'/api/quality-policy')).json()).experimental_quality_hold.active,true);
 assert.deepEqual(db.profile(game),original);
 // The fixed hold does not prevent viewing old task evidence or cancelling work.
 assert.equal((await fetch(base+'/api/tasks/'+learn.id)).status,200);
 assert.equal((await post('/api/tasks/'+learn.id+'/cancel')).status,200);
 // A previously verified delivery receipt is the sole retry exception. It
 // restores local task state without model/source work or a second write.
 new SideBridge(db,{folder});
 const recovered=db.create('create',createPayload(),'completed-receipt');
 db.db.prepare("UPDATE tasks SET state='needs_input' WHERE id=?").run(recovered.id);
 const receipt={status:'completed',warnings:[],readback_verified:true},plan={text:'原交付稿'},evidence=[{id:'original-proof'}],now=new Date().toISOString();
 db.db.prepare('INSERT INTO bridge_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'fixture-completed-receipt','delivery',recovered.id,'fulfilled',JSON.stringify({plan,evidence}),JSON.stringify(receipt),null,now,new Date(Date.now()+60000).toISOString(),now);
 const retried=await post('/api/tasks/'+recovered.id+'/retry');assert.equal(retried.status,200);
 for(let i=0;i<50&&db.get(recovered.id).state!=='completed';i++)await delay(50);
 assert.equal(db.get(recovered.id).state,'completed');
 assert.deepEqual(db.get(recovered.id).result,{plan,evidence,delivery:receipt});
});


test('CLI and lower-level delivery transitions cannot start writes; collection remains available',async t=>{
 const {db,folder}=await setup(t),bridge=new SideBridge(db,{folder});
 const pending=bridge.request('delivery',{plan:{text:'prior draft'},destination:null});
 const target={file_id:'fixture-file',url:'https://docs.qq.com/sheet/fixture'};
 assert.throws(()=>bridge.approve(pending.id,target),e=>e.code==='EXPERIMENTAL_QUALITY_HOLD');
 assert.equal(bridge.get(pending.id).state,'awaiting_approval');
 // Simulate an approval persisted before the fixed hold was introduced.
 db.db.prepare("UPDATE bridge_requests SET state='approved',payload=? WHERE id=?")
  .run(JSON.stringify({...pending.payload,destination:target}),pending.id);
 assert.throws(()=>bridge.beginDelivery(pending.id),e=>e.code==='EXPERIMENTAL_QUALITY_HOLD');
 assert.equal(bridge.get(pending.id).state,'approved');
 const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/bridge.mjs',import.meta.url)),'begin-delivery',pending.id],{env:{...process.env,CRAWL_DATA_DIR:folder,REDFOX_API_KEY:''},stdio:'pipe'});
 let stderr='';child.stderr.on('data',b=>stderr+=b);const code=await new Promise(r=>child.once('exit',r));
 assert.equal(code,1);assert.match(stderr,/摘要忠实性/);assert.equal(bridge.get(pending.id).state,'approved');
 assert.equal(bridge.request('search',{keyword:game,scope:'game'}).state,'pending');
 assert.equal(bridge.request('media',{source_id:'7696356432198913300'}).state,'pending');
});

test('direct Tencent deliver refuses unfinished work before any client call and only restores completed local receipt',async t=>{
 const {db}=await setup(t);let calls=0,verifications=0;
 const target={file_id:'fixture-file',url:'https://docs.qq.com/sheet/fixture'},task={id:'old-delivery',payload:{mode:'B',destination:target}},plan={game,meaning:'old meaning',rationale:'old rationale',ideas:[]},evidence=[];
 const args={task,plan,evidence,db,client:{call:async()=>{calls++;throw Error('unexpected Tencent call');}},verify:async()=>{verifications++;throw Error('unexpected export');}};
 const draft=composeRows(task,plan,evidence),planHash=hash({plan,draft}),key='delivery:'+hash({task:task.id,planHash,target});
 await assert.rejects(deliver(args),e=>e.code==='EXPERIMENTAL_QUALITY_HOLD');
 const unfinished={plan_hash:planHash,target,stage:'created',sheet_id:'prior-tab',verified_batches:[],warnings:[]};db.checkpoint(key,unfinished);
 await assert.rejects(deliver(args),e=>e.code==='EXPERIMENTAL_QUALITY_HOLD');assert.deepEqual(db.checkpoint(key),unfinished);
 const complete={...unfinished,content_verified_at:'2026-10-18T00:00:00Z',content_status:'verified',stage:'content_verified'};db.checkpoint(key,complete);
 const restored=await deliver(args);assert.equal(restored.cached,true);assert.equal(restored.content_verified_at,complete.content_verified_at);assert.deepEqual(db.checkpoint(key),complete);
 assert.equal(calls,0);assert.equal(verifications,0);
});

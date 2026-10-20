// Exact-ID candidate lifecycle. Own store only; no old worker, latest profile,
// paid acquisition, automatic retry, or delivery is reachable from this module.
import {randomUUID} from 'node:crypto';
import {hash} from './tasks.mjs';
import {validHostReceipt} from './host-receipt.mjs';
import {normalizeLocalGame} from './local-videos.mjs';
import {CREATIVE_CANDIDATE_VERSION} from './creative-candidate.mjs';
import {LOCAL_CREATIVE_ID,validLocalCreativeSource} from './creative-local-source.mjs';
export const CREATIVE_TASK_PIPELINE=CREATIVE_CANDIDATE_VERSION;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(Error(code),{code});},clone=x=>structuredClone(x),now=()=>new Date().toISOString();
const terminal=new Set(['completed','completed_with_warnings','needs_input','failed','cancelled']);
const stages=new Set(['核验固定选题与档案','读取实际视频并提取3张代表画面','使用已有本地Small模型转写语音（CPU/INT8）','一次创作归纳执行中']);
const keys=id=>Object.fromEntries(['input','started','output','public'].map(k=>[k,`creative-task:${id}:${k}`]));
const pick=(v,fields)=>Object.fromEntries(fields.filter(k=>v?.[k]!==undefined).map(k=>[k,clone(v[k])]));
export function creativeTaskRequest(value){
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='format,game,mode,profile_version,source,study_task_id')fail('CREATIVE_TASK_INPUT');
 const s=value.source;
 const local=s?.provider==='local_upload'&&value.mode==='A'&&Object.keys(s).sort().join(',')==='provider,source_id'&&LOCAL_CREATIVE_ID.test(s.source_id);
 const network=s?.provider==='redfox'&&Object.keys(s).sort().join(',')==='provider,request_id,source_id'&&UUID.test(s.request_id)&&/^\d{10,25}$/.test(s.source_id);
 if(!s||Array.isArray(s)||!(local||network)||!UUID.test(value.study_task_id)||!SHA.test(value.profile_version)||!['A','B'].includes(value.mode)||!['video','image'].includes(value.format))fail('CREATIVE_TASK_INPUT');
 return {...clone(value),game:normalizeLocalGame(value.game)};
}
function payloadFor(captured,request){
 const study=captured?.study,s=captured?.selected;
 if(request.source.provider==='local_upload'){
  if(captured?.game!==request.game||captured.mode!==request.mode||captured.format!==request.format||study?.game!==request.game||study.binding?.task_id!==request.study_task_id||study.binding?.profile_version!==request.profile_version||s?.row?.source_id!==request.source.source_id||!validLocalCreativeSource(s,request.game,request.mode))fail('CREATIVE_TASK_CAPTURE');
  return {...request,creative_pipeline:CREATIVE_TASK_PIPELINE,input_fingerprint:hash(captured),source_fingerprint:s.origin.fingerprint,source_sha256:s.media.sha256};
 }
 if(captured?.game!==request.game||captured.mode!==request.mode||captured.format!==request.format||study?.game!==request.game||study.binding?.task_id!==request.study_task_id||study.binding?.profile_version!==request.profile_version||s?.row?.provider!=='redfox'||s.row.kind!=='video'||s.row.source_id!==request.source.source_id||s.row.collection_request_id!==request.source.request_id||s.collection?.request_id!==request.source.request_id||!SHA.test(s.collection.fingerprint)||!SHA.test(s.media?.sha256))fail('CREATIVE_TASK_CAPTURE');
 return {...request,creative_pipeline:CREATIVE_TASK_PIPELINE,input_fingerprint:hash(captured),source_fingerprint:s.collection.fingerprint,source_sha256:s.media.sha256};
}
function preparedMatches(prepared,captured,request){
 // Preparation may add the verified sparse-media artifact, and nothing else.
 // In particular it cannot retarget mode/format, swap a profile, or replace a
 // selected source while the task continues to display the captured labels.
 const fixed=clone(prepared),original=clone(captured);
 if(fixed?.selected)delete fixed.selected.prepared;if(original?.selected)delete original.selected.prepared;
 payloadFor(prepared,request);
 if(hash(fixed)!==hash(original))fail('CREATIVE_TASK_PREPARED_CHANGED');
}
function noPrivate(value){
 const forbidden=new Set(['path','source_path','attached_path','file','files','images','audit_dir','auditDir','receipt','packet','media','items','cli_path']);
 if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){if(forbidden.has(key))fail('CREATIVE_TASK_PRIVATE_OUTPUT');noPrivate(v);}
}
function project(output,payload){
 const r=output?.receipt,b=output?.binding;
 const sourceBound=payload.source.provider==='local_upload'
  ? b?.source_provider==='local_upload'&&b.local_source_fingerprint===payload.source_fingerprint&&b.collection_request_id===undefined&&b.collection_fingerprint===undefined
  : b?.collection_request_id===payload.source.request_id&&b.collection_fingerprint===payload.source_fingerprint&&b.source_provider!== 'local_upload';
 if(output?.version!==CREATIVE_TASK_PIPELINE||!['needs_input','needs_review'].includes(output.status)||output.accepted!==false||output.ready!==false||output.delivery_enabled!==false||output.plan?.game!==payload.game||b?.game!==payload.game||b.mode!==payload.mode||b.format!==payload.format||b.study_task_id!==payload.study_task_id||b.profile_version!==payload.profile_version||!sourceBound||b.source_id!==payload.source.source_id||b.source_sha256!==payload.source_sha256||!SHA.test(b.input_sha256)||!SHA.test(b.attachment_sha256)||!validHostReceipt(r,{inputHash:b.input_sha256})||r.creative_version!==CREATIVE_TASK_PIPELINE||hash(r.input_binding)!==hash(b)||!output.draft||hash(output.draft)!==output.draft_sha256)fail('CREATIVE_TASK_OUTPUT');
 const result={...pick(output,['version','status','accepted','ready','delivery_enabled','binding','coverage','source_reading','game_bridge','plan','draft','draft_sha256','boundary']),game:payload.game,mode:payload.mode,format:payload.format};
 noPrivate(result);result.result_version=hash(result);return result;
}
export function createCreativeTaskRunner({db,captureInput,prepareInput,runCandidate,revalidateInput,leaseMs=30000,heartbeatMs=5000}={}){
 if(!db?.db||[captureInput,prepareInput,runCandidate,revalidateInput].some(f=>typeof f!=='function')||!Number.isInteger(leaseMs)||leaseMs<20||!Number.isInteger(heartbeatMs)||heartbeatMs<1||heartbeatMs>=leaseMs)fail('CREATIVE_TASK_CONFIG');
 const active=new Map();
 function taskFor(id){const t=db.get(id);if(t?.type!=='creative-candidate'||t.payload?.creative_pipeline!==CREATIVE_TASK_PIPELINE)fail('CREATIVE_TASK_NOT_FOUND');return t;}
 const read=id=>({...pick(taskFor(id),['id','type','state','payload','result','error','stage','cancelled','created','updated']),task_store:'creative-candidate'});
 const list=()=>db.db.prepare("SELECT id FROM tasks WHERE type='creative-candidate' AND json_valid(payload) AND json_extract(payload,'$.creative_pipeline')=? ORDER BY updated DESC,id DESC").all(CREATIVE_TASK_PIPELINE).map(t=>read(t.id));
 const requireOwned=(id,owner)=>{const t=taskFor(id);if(t.state!=='running'||t.owner!==owner||t.cancelled||t.lease<=Date.now())fail('CREATIVE_TASK_OWNERSHIP_LOST');};
 async function create(value){
  const request=creativeTaskRequest(value),captured=clone(await captureInput(clone(request))),payload=payloadFor(captured,request),saved={request,captured,payload_sha256:hash(payload),captured_sha256:hash(captured)};
  return db.transaction(()=>{const t=db.create('creative-candidate',payload),k=keys(t.id),old=db.checkpoint(k.input);if(old){if(hash(old)!==hash(saved))fail('CREATIVE_TASK_CAPTURE_CHANGED');}else db.checkpoint(k.input,saved);return read(t.id);});
 }
 function settleCancelled(task){
  if(active.has(task.id)||task.state!=='running'||!task.cancelled||task.lease>Date.now())return false;
  return db.db.prepare("UPDATE tasks SET state='cancelled',stage=?,error=?,owner=NULL,lease=0,updated=? WHERE id=? AND state='running' AND cancelled=1 AND owner IS ? AND lease<=?").run('已取消','取消后的执行器已结束；未重新推理',now(),task.id,task.owner,Date.now()).changes===1;
 }
 function run(id){
  if(active.size)fail('CREATIVE_TASK_BUSY');const owner=randomUUID(),k=keys(id);
  const claimed=db.transaction(()=>{
   const t=taskFor(id);if(settleCancelled(t)||terminal.has(t.state)||t.cancelled)return null;
   if(t.state==='running'&&t.lease>Date.now())fail('CREATIVE_TASK_BUSY');if(!['running','queued'].includes(t.state))fail('CREATIVE_TASK_STATE');
   const saved=db.checkpoint(k.input);if(!saved||saved.payload_sha256!==hash(t.payload)||saved.captured_sha256!==hash(saved.captured)||hash(payloadFor(saved.captured,saved.request))!==hash(t.payload))fail('CREATIVE_TASK_CAPTURE_CHANGED');
   const prior=db.checkpoint(k.output);
   if(db.checkpoint(k.started)&&!prior){db.db.prepare("UPDATE tasks SET state='needs_input',error=?,stage=?,owner=NULL,lease=0,updated=? WHERE id=?").run('推理已开始但没有完整回执；未自动重试','需要人工处理',now(),id);return null;}
   if(prior&&(prior.sha256!==hash(prior.output)||prior.captured_sha256!==saved.captured_sha256))fail('CREATIVE_TASK_CHECKPOINT');
   db.db.prepare("UPDATE tasks SET state='running',owner=?,lease=?,stage=?,updated=? WHERE id=? AND cancelled=0").run(owner,Date.now()+leaseMs,'核验固定选题与档案',now(),id);return {task:db.get(id),saved,prior};
  });
  if(!claimed)return Promise.resolve(read(id));
  const controller=new AbortController(),ctx={taskId:id,taskOwner:owner,game:claimed.task.payload.game,signal:controller.signal};
  const check=()=>{controller.signal.throwIfAborted();requireOwned(id,owner);};
  ctx.stage=value=>{if(!stages.has(value))fail('CREATIVE_TASK_STAGE');check();db.transaction(()=>{requireOwned(id,owner);db.stage(id,owner,value);});};
  const timer=setInterval(()=>{try{db.transaction(()=>{requireOwned(id,owner);db.db.prepare('UPDATE tasks SET lease=?,updated=? WHERE id=? AND owner=?').run(Date.now()+leaseMs,now(),id,owner);});}catch{controller.abort();}},heartbeatMs);timer.unref?.();
  const validate=async()=>{check();const valid=await revalidateInput(clone(claimed.saved.captured),ctx);check();if(valid!==true)fail('CREATIVE_TASK_SOURCE_CHANGED');};
  const promise=(async()=>{
   try{
    await validate();let output=claimed.prior?.output;
    if(!output){
     const prepared=await prepareInput(clone(claimed.saved.captured),ctx);check();preparedMatches(prepared,claimed.saved.captured,claimed.saved.request);
     db.transaction(()=>{requireOwned(id,owner);if(db.checkpoint(k.started))fail('CREATIVE_TASK_ALREADY_STARTED');db.checkpoint(k.started,{owner,captured_sha256:claimed.saved.captured_sha256,started_at:now()});db.stage(id,owner,'一次创作归纳执行中');});
     output=await runCandidate(prepared,ctx);check();project(output,claimed.task.payload);
     db.transaction(()=>{requireOwned(id,owner);if(db.checkpoint(k.output))fail('CREATIVE_TASK_CHECKPOINT');db.checkpoint(k.output,{output,sha256:hash(output),captured_sha256:claimed.saved.captured_sha256});});
    }
    await validate();const result=project(output,claimed.task.payload);check();
    db.transaction(()=>{requireOwned(id,owner);db.checkpoint(k.public,{result,sha256:hash(result)});db.db.prepare('UPDATE tasks SET state=?,result=?,stage=?,error=?,owner=NULL,lease=0,updated=? WHERE id=? AND owner=? AND cancelled=0').run(result.status==='needs_input'?'needs_input':'completed',JSON.stringify(result),result.status==='needs_input'?'原片或结合证据需补充':'创作候选已保存，待审阅',result.status==='needs_input'?'关键内容或适配条件未满足；未自动重试':null,now(),id,owner);});
   }catch(error){db.transaction(()=>{const t=taskFor(id);if(t.state!=='running'||t.owner!==owner||!t.cancelled&&t.lease<=Date.now())return;db.db.prepare('UPDATE tasks SET state=?,stage=?,error=?,owner=NULL,lease=0,updated=? WHERE id=? AND owner=?').run(t.cancelled?'cancelled':'needs_input',t.cancelled?'已取消':'需要人工处理',t.cancelled?'用户已取消；未保存迟到结果':/^(?:CREATIVE|STUDY_EVIDENCE)_[A-Z_]+$/.test(error.code||'')?error.code:'创作候选未完成；未自动重试',now(),id,owner);});}
   finally{clearInterval(timer);active.delete(id);}return read(id);
  })();active.set(id,{owner,controller,promise});return promise;
 }
 async function cancel(id){
  let running;db.transaction(()=>{const t=taskFor(id);if(settleCancelled(t)||terminal.has(t.state))return;running=active.get(id);if(t.owner!==null&&t.owner!==running?.owner)fail('CREATIVE_TASK_NOT_OWNER');db.cancel(id);running?.controller.abort();});
  if(running)await running.promise;return read(id);
 }
 async function readVerified(id,{signal}={}){
  signal?.throwIfAborted();const t=taskFor(id),k=keys(id),saved=db.checkpoint(k.input),out=db.checkpoint(k.output),pub=db.checkpoint(k.public);
  if(t.state!=='completed'||t.cancelled||!saved||saved.payload_sha256!==hash(t.payload)||saved.captured_sha256!==hash(saved.captured)||hash(payloadFor(saved.captured,saved.request))!==hash(t.payload)||!out||out.sha256!==hash(out.output)||out.captured_sha256!==saved.captured_sha256||!pub||pub.sha256!==hash(pub.result)||hash(project(out.output,t.payload))!==hash(t.result)||hash(pub.result)!==hash(t.result))fail('CREATIVE_TASK_CHECKPOINT');
  if(await revalidateInput(clone(saved.captured),{game:t.payload.game,signal})!==true)fail('CREATIVE_TASK_SOURCE_CHANGED');
  signal?.throwIfAborted();if(hash(taskFor(id).result)!==hash(t.result))fail('CREATIVE_TASK_CHECKPOINT');return read(id);
 }
 return {create,run,read,list,cancel,readVerified};
}

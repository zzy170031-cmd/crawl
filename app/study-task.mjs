// Isolated candidate lifecycle; never registered with the production worker.
import {randomUUID} from 'node:crypto';
import {hash} from './tasks.mjs';
import {normalizeLocalGame} from './local-videos.mjs';
import {GAME_STUDY_VERSION,gameStudySchema} from './game-study.mjs';
import {validateHostOutput} from './host-assistant.mjs';
import {validHostReceipt} from './host-receipt.mjs';
export const STUDY_TASK_PIPELINE=GAME_STUDY_VERSION;
const PROGRESS_STAGES=new Set(['核验固定学习来源','读取实际视频并提取3张代表画面','使用已有本地Small模型转写语音（CPU/INT8）','一次归纳执行中']);
const keys=id=>({input:`study-task:${id}:input`,started:`study-task:${id}:inference-started`,output:`study-task:${id}:output`,result:`study-task:${id}:public-result`});
const fail=code=>{throw Object.assign(Error(code),{code});};
const clone=value=>structuredClone(value);
const pick=(value,fields)=>Object.fromEntries(fields.filter(k=>value?.[k]!==undefined).map(k=>[k,clone(value[k])]));
const now=()=>new Date().toISOString();
function request(value){
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='game,learning_source'||!['network','local'].includes(value.learning_source))fail('STUDY_TASK_INPUT_INVALID');
 return {game:normalizeLocalGame(value.game),learning_source:value.learning_source};
}
function sourceBinding(library,input){
 const b=library?.binding;
 if(!b||b.source_provider!=='game_study_library'||b.game!==input.game||library.game!==input.game||!/^[a-f0-9]{64}$/.test(b.library_fingerprint||'')||b.library_id!=='library_'+b.library_fingerprint||!Array.isArray(library.records)||!library.records.length||library.records.length>30||!Array.isArray(library.items))fail('STUDY_TASK_SNAPSHOT_INVALID');
 if(input.learning_source==='local'?b.collection!==null:!b.collection?.collection_request_id)fail('STUDY_TASK_SNAPSHOT_INVALID');
 for(const row of library.records)if(row.game!==input.game||row.provider!==(input.learning_source==='local'?'local_upload':'redfox'))fail('STUDY_TASK_SNAPSHOT_INVALID');
 return {game:input.game,learning_source:input.learning_source,library_id:b.library_id,library_fingerprint:b.library_fingerprint,learning_pipeline:STUDY_TASK_PIPELINE};
}
function publicTask(task){return task?pick(task,['id','type','state','payload','result','error','stage','cancelled','created','updated']):null;}
function checkPublic(value){
 const privateKeys=new Set(['path','source_path','attached_path','media','items','receipt','file','files','images','audit_dir','auditDir']);
 if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){if(privateKeys.has(key))fail('STUDY_TASK_OUTPUT_PRIVATE');checkPublic(child);}
}
function completeOutput(output){
 const receipt=output?.receipt;
 if(!output||output.version!==GAME_STUDY_VERSION||!validHostReceipt(receipt,{requireExit:false})||receipt.game_study_version!==GAME_STUDY_VERSION)fail('STUDY_TASK_RECEIPT_INVALID');
}
function projectOutput(output,library,payload){
 completeOutput(output);
 if(!output||output.version!==GAME_STUDY_VERSION||!output.draft||!output.coverage||!output.comparisonMetrics)fail('STUDY_TASK_OUTPUT_INVALID');
 const schema=gameStudySchema(payload.game),draft=pick(output.draft,Object.keys(schema.properties));validateHostOutput(draft,schema);
 const status=output.coverage.status==='partial'?'partial':'needs_review';
 const coverage={...pick(output.coverage,['candidate_count','representative_count','candidate_pool_complete','learning_source','relatedness_counts','remaining_acceptance','boundary']),status,accepted:false,ready:false,domains:{}};
 // Nested public fields are also reconstructed; no receipt/file/source packets.
 if(coverage.relatedness_counts)coverage.relatedness_counts=pick(coverage.relatedness_counts,['related','uncertain','unrelated']);
 for(const [domain,value]of Object.entries(output.coverage.domains||{}))if(['background_loop','gameplay_terms','content_types','video_and_image','duration_interaction','platform_requirements','peer_expression'].includes(domain))coverage.domains[domain]=pick(value,['status','source_ids','missing','output_present']);
 coverage.image_pages=(output.coverage.image_pages||[]).map(x=>pick(x,['id','source_id','page_index','page_count']));
 const metrics=pick(output.comparisonMetrics,['learning_source','collection_request_id','not_inferred','boundary']);
 metrics.window=output.comparisonMetrics.window?pick(output.comparisonMetrics.window,['start','end','timezone']):null;
 metrics.excluded=(output.comparisonMetrics.excluded||[]).map(x=>pick(x,['source_id','reason']));
 metrics.groups=(output.comparisonMetrics.groups||[]).map(g=>{
  const row=pick(g,['id','type','classification_status','classification_origin','format','relevance','sample_count','source_ids']);
  row.window=g.window?pick(g.window,['start','end','timezone']):null;row.duration_seconds=g.duration_seconds?pick(g.duration_seconds,['known','missing','min','max','median']):null;row.metrics={};
  for(const key of ['like_count','comment_count','share_count','collect_count'])if(g.metrics?.[key])row.metrics[key]=pick(g.metrics[key],['known','missing','min','max','median']);return row;
 });
 const source_counts={selected:library.records.length,available_originals:library.records.filter(r=>r.availability==='available').length,unavailable_originals:library.records.filter(r=>r.availability!=='available').length};
 // New local tasks disclose the captured pool and the library limit. Preserve
 // historical network result hashes and the distinction from actually read samples.
 if(payload.learning_source==='local'){source_counts.captured_origins=library.coverage?.input_origins??library.records.length;source_counts.excluded_candidates=Array.isArray(library.excluded)?library.excluded.length:0;}
 const result={game:payload.game,learning_source:payload.learning_source,learning_pipeline:STUDY_TASK_PIPELINE,library_id:payload.library_id,library_fingerprint:payload.library_fingerprint,status,accepted:false,ready:false,draft:{...draft,status,accepted:false},coverage,comparisonMetrics:metrics,source_counts};
 checkPublic(result);
 result.profile_version=hash(result);return result;
}
export function createStudyTaskRunner({db,captureInput,preparePacket,runStudy,revalidateInput,leaseMs=30000,heartbeatMs=5000}){
 if(!db?.db||[captureInput,preparePacket,runStudy,revalidateInput].some(f=>typeof f!=='function')||!Number.isInteger(leaseMs)||leaseMs<20||!Number.isInteger(heartbeatMs)||heartbeatMs<1||heartbeatMs>=leaseMs)fail('STUDY_TASK_CONFIG_INVALID');
 const active=new Map();
 const read=id=>publicTask(taskFor(id));
 function profile(input){
  const captured=request(input);
  const found=db.db.prepare(`SELECT id FROM tasks
   WHERE type=? AND state=? AND json_valid(payload)
    AND json_extract(payload,'$.learning_pipeline')=?
    AND json_extract(payload,'$.game')=? AND json_extract(payload,'$.learning_source')=?
   ORDER BY updated DESC,id DESC LIMIT 1`).get('learn','completed',STUDY_TASK_PIPELINE,captured.game,captured.learning_source);
  if(!found)return null;
  const task=taskFor(found.id),result=task.result,version=result?.profile_version;
  if(!result||!/^[a-f0-9]{64}$/.test(version||'')||result.game!==captured.game||result.learning_source!==captured.learning_source||result.learning_pipeline!==STUDY_TASK_PIPELINE||result.library_id!==task.payload.library_id||result.library_fingerprint!==task.payload.library_fingerprint||result.accepted!==false||result.ready!==false||!['partial','needs_review'].includes(result.status))fail('STUDY_TASK_PROFILE_INVALID');
  const {profile_version,...body}=result;
  const saved=db.checkpoint(keys(task.id).result);
  if(hash(body)!==version||!saved?.result||saved.sha256!==hash(result)||hash(saved.result)!==saved.sha256)fail('STUDY_TASK_PROFILE_INVALID');
  const stored=db.checkpoint('study-profile:'+hash({game:captured.game,version}));
  if(!stored||stored.task_id!==task.id||stored.version!==version||typeof stored.created_at!=='string')fail('STUDY_TASK_PROFILE_INVALID');
  const {version:storedVersion,task_id,created_at,...storedResult}=stored;
  if(hash(storedResult)!==hash(result))fail('STUDY_TASK_PROFILE_INVALID');
  checkPublic(stored);
  return clone(stored);
 }
 function taskFor(id){const task=db.get(id),p=task?.payload;if(task?.type!=='learn'||p?.learning_pipeline!==STUDY_TASK_PIPELINE||Object.keys(p).sort().join(',')!=='game,learning_pipeline,learning_source,library_fingerprint,library_id')fail('STUDY_TASK_NOT_CANDIDATE');return task;}
 function owned(id,owner){const task=taskFor(id);return task.state==='running'&&task.owner===owner&&task.lease>Date.now()&&!task.cancelled;}
 function requireOwned(id,owner){if(!owned(id,owner))fail('STUDY_TASK_OWNERSHIP_LOST');}
 async function create(input){
  const captured=request(input); // Synchronous capture before any await.
  const library=clone(await captureInput({...captured})),payload=sourceBinding(library,captured);
  return db.transaction(()=>{
   const task=db.create('learn',payload),k=keys(task.id),existing=db.checkpoint(k.input),snapshot={payload_sha256:hash(payload),library_sha256:hash(library),library};
   if(existing){if(existing.payload_sha256!==snapshot.payload_sha256||existing.library_sha256!==snapshot.library_sha256)fail('STUDY_TASK_SNAPSHOT_CONFLICT');}
   else db.checkpoint(k.input,snapshot);
   return publicTask(task);
  });
 }
 function run(id){
  if(active.has(id))return Promise.reject(Object.assign(Error('STUDY_TASK_BUSY'),{code:'STUDY_TASK_BUSY'}));
  const owner=randomUUID(),k=keys(id);
  const claimed=db.transaction(()=>{
   const task=taskFor(id);
   // Recovery after the cancelling process exited has no callback left to await.
   // Only an already-cancelled, expired lease is eligible; active owners survive.
   if(task.cancelled&&task.state==='running'&&task.lease<=Date.now()){
    db.db.prepare("UPDATE tasks SET state='cancelled',stage=?,error=?,owner=NULL,lease=0,updated=? WHERE id=? AND state='running' AND cancelled=1 AND owner IS ? AND lease<=?").run('已取消','取消后进程已结束；未重试推理',now(),id,task.owner,Date.now());
    return null;
   }
   if(task.cancelled||['completed','completed_with_warnings','cancelled','failed','needs_input'].includes(task.state))return null;
   if(task.state==='running'&&task.lease>Date.now())fail('STUDY_TASK_BUSY');
   if(!['running','queued'].includes(task.state))fail('STUDY_TASK_STATE_INVALID');
   const stored=db.checkpoint(k.input);
   if(!stored||hash(stored.library)!==stored.library_sha256||stored.payload_sha256!==hash(task.payload)||hash(sourceBinding(stored.library,task.payload))!==hash(task.payload))fail('STUDY_TASK_SNAPSHOT_INVALID');
   const prior=db.checkpoint(k.output);
   if(db.checkpoint(k.started)&&!prior){db.db.prepare("UPDATE tasks SET state='needs_input',stage=?,error=?,owner=NULL,lease=0,updated=? WHERE id=?").run('需要人工确认是否重试','推理已开始但没有完整回执；未自动重试',now(),id);return null;}
   if(prior&&(prior.output_sha256!==hash(prior.output)||prior.library_sha256!==stored.library_sha256))fail('STUDY_TASK_CHECKPOINT_INVALID');
   db.db.prepare("UPDATE tasks SET state='running',owner=?,lease=?,stage=?,updated=? WHERE id=? AND cancelled=0").run(owner,Date.now()+leaseMs,'核验固定学习来源',now(),id);
   return {task:db.get(id),stored,prior};
  });
  if(!claimed)return Promise.resolve(read(id));
  const controller=new AbortController(),ctx={game:claimed.task.payload.game,learning_source:claimed.task.payload.learning_source,taskId:id,taskOwner:owner,signal:controller.signal};
  ctx.stage=value=>{
   if(typeof value!=='string'||!PROGRESS_STAGES.has(value))fail('STUDY_TASK_STAGE_INVALID');
   controller.signal.throwIfAborted();
   db.transaction(()=>{requireOwned(id,owner);db.db.prepare('UPDATE tasks SET stage=?,updated=? WHERE id=? AND owner=? AND cancelled=0').run(value,now(),id,owner);});
  };
  const heartbeat=()=>{try{db.transaction(()=>{requireOwned(id,owner);db.db.prepare('UPDATE tasks SET lease=?,updated=? WHERE id=? AND owner=?').run(Date.now()+leaseMs,now(),id,owner);});}catch{controller.abort();}};
  const timer=setInterval(heartbeat,heartbeatMs);timer.unref?.();
  const check=()=>{controller.signal.throwIfAborted();requireOwned(id,owner);};
  const validate=async()=>{check();const result=await revalidateInput(clone(claimed.stored.library),ctx);check();if(result!==true)fail('STUDY_TASK_SOURCE_CHANGED');};
  const promise=(async()=>{
   try{
    await validate();let output=claimed.prior?.output;
    if(!output){
     const prepared=await preparePacket(clone(claimed.stored.library),ctx);check();
     if(!prepared?.packet||prepared.packet.game!==ctx.game||prepared.packet.learning_source!==ctx.learning_source||prepared.packet.collection!==undefined||hash(prepared.packet.library?.binding)!==hash(claimed.stored.library.binding)||hash(prepared.packet.library?.records)!==hash(claimed.stored.library.records))fail('STUDY_TASK_PACKET_CHANGED');
     db.transaction(()=>{requireOwned(id,owner);if(db.checkpoint(k.started))fail('STUDY_TASK_INFERENCE_ALREADY_STARTED');db.checkpoint(k.started,{owner,started_at:now(),library_sha256:claimed.stored.library_sha256});db.db.prepare('UPDATE tasks SET stage=? WHERE id=? AND owner=?').run('一次归纳执行中',id,owner);});
     output=await runStudy(prepared.packet,{...ctx,images:prepared.images||[],files:prepared.files||[]});check();completeOutput(output);
     db.transaction(()=>{requireOwned(id,owner);if(db.checkpoint(k.output))fail('STUDY_TASK_CHECKPOINT_CONFLICT');db.checkpoint(k.output,{output,output_sha256:hash(output),library_sha256:claimed.stored.library_sha256,finished_at:now()});});
    }
    await validate();const result=projectOutput(output,claimed.stored.library,claimed.task.payload);check();
    db.transaction(()=>{
     requireOwned(id,owner);
     const profile={...result,version:result.profile_version,task_id:id,created_at:now()};
     const old=db.profile(ctx.game);if(old)db.checkpoint('study-profile-history:'+hash({game:ctx.game,profile:old}),old);
     db.checkpoint('study-profile:'+hash({game:ctx.game,version:profile.version}),profile);
     db.checkpoint(k.result,{result,sha256:hash(result)});db.profile(ctx.game,profile);
     db.db.prepare("UPDATE tasks SET state='completed',result=?,error=NULL,stage=?,owner=NULL,lease=0,updated=? WHERE id=? AND owner=? AND cancelled=0").run(JSON.stringify(result),'候选档案已保存，待复核',now(),id,owner);
    });
   }catch(error){
    db.transaction(()=>{
     const current=taskFor(id);
     // Cancellation may release this owner only after its callback has ended.
     if(current.state!=='running'||current.owner!==owner)return;
     const cancelled=Boolean(current.cancelled);
     // Cancellation settles only our own callback, even if its lease expired
     // while awaiting it. An expired non-cancelled owner cannot publish or finish.
     if(!cancelled&&current.lease<=Date.now())return;
     db.db.prepare('UPDATE tasks SET state=?,error=?,stage=?,owner=NULL,lease=0,updated=? WHERE id=? AND owner=?').run(cancelled?'cancelled':'needs_input',cancelled?'用户已取消；未保存迟到结果':/^STUDY_TASK_[A-Z_]+$/.test(error.code||'')?error.code:'候选学习未完成；未自动重试',cancelled?'已取消':'需要处理后显式重试',now(),id,owner);
    });
   }finally{clearInterval(timer);active.delete(id);}
   return read(id);
  })();
  active.set(id,{controller,promise});return promise;
 }
 async function cancel(id){taskFor(id);db.cancel(id);const running=active.get(id);if(running){running.controller.abort();await running.promise;}return read(id);}
 return {create,run,cancel,read,profile};
}

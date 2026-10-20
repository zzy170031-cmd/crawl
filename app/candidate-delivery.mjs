// Explicit, fixed-draft delivery. This module never invokes the legacy writer,
// a model, source collection, a retry loop, or a generic remote-tool proxy.
import {randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {Tasks,hash} from './tasks.mjs';
import {CREATIVE_TASK_PIPELINE} from './creative-task.mjs';
import {destination,resolveDestination} from './delivery.mjs';
import {TencentClient} from './tencent-client.mjs';
import {verifyExport} from './verify-export.mjs';
export const CANDIDATE_DELIVERY_VERSION='reviewed-candidate-delivery-1';
const fail=code=>{throw Object.assign(Error(code),{code});};
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const now=()=>new Date().toISOString(),clone=structuredClone;
const key=id=>`candidate-delivery:${id}:frozen`;
const recordKey=id=>`candidate-delivery:${id}:receipt`;
const sheetName=id=>`候选-${id.replaceAll('-','').slice(0,28)}`;
const reads=new Set(['sheet_get_sheet_info','sheet_get_cell_data','manage_export_file','manage_export_progress']);
const mutations=new Set(['sheet_add_sheet','sheet_set_range_value','sheet_set_link','sheet_set_cell_style','sheet_set_dimension_size']);
function request(v){
 if(!v||Array.isArray(v)||Object.keys(v).sort().join(',')!=='draft_sha256,result_version,task_id'||!UUID.test(v.task_id)||!SHA.test(v.result_version)||!SHA.test(v.draft_sha256))fail('CANDIDATE_DELIVERY_INPUT');
 return clone(v);
}
function candidate(t,q){
 const r=t?.result,c=clone(r||{});delete c.result_version;
 if(t?.id!==q.task_id||t.type!=='creative-candidate'||t.state!=='completed'||t.cancelled||t.payload?.creative_pipeline!==CREATIVE_TASK_PIPELINE||r?.version!==CREATIVE_TASK_PIPELINE||r.status!=='needs_review'||r.accepted!==false||r.ready!==false||r.delivery_enabled!==false||r.result_version!==q.result_version||hash(c)!==q.result_version||r.draft_sha256!==q.draft_sha256||hash(r.draft)!==q.draft_sha256||!Array.isArray(r.plan?.blocking_gaps)||r.plan.blocking_gaps.length||['insufficient','unsuitable'].includes(r.plan.fit))fail('CANDIDATE_DELIVERY_CANDIDATE_INVALID');
 const d=r.draft;
 if(!Array.isArray(d.rows)||!d.rows.length||d.rows.length>10000||d.rows.some(row=>!Array.isArray(row)||row.length!==4||row.some(s=>typeof s!=='string'||s.length>100000))||!Array.isArray(d.links)||d.links.length>1000)fail('CANDIDATE_DELIVERY_DRAFT_INVALID');
 const seen=new Set();for(const l of d.links){let u;try{u=new URL(l.url);}catch{fail('CANDIDATE_DELIVERY_DRAFT_INVALID');}const pos=`${l.row}:${l.col}`;
  if(!Number.isInteger(l.row)||l.row<0||l.row>=d.rows.length||!Number.isInteger(l.col)||l.col<0||l.col>3||u.protocol!=='https:'||u.username||u.password||d.rows[l.row][l.col]!==l.url||seen.has(pos))fail('CANDIDATE_DELIVERY_DRAFT_INVALID');seen.add(pos);
 }
 if(!r.binding||r.binding.game!==r.game||r.binding.mode!==r.mode||r.binding.format!==r.format)fail('CANDIDATE_DELIVERY_CANDIDATE_INVALID');
 return r;
}
function localTarget(v){try{return destination(v);}catch{fail('CANDIDATE_DELIVERY_DESTINATION_INVALID');}}
function authorization(q,target,value){
 if(value===undefined)return {record_id:randomUUID(),basis:'explicit_draft_and_target_confirmation',scope:'exact frozen candidate; new dedicated sheet only',...q,target,authorized_at:now()};
 if(!value||typeof value.record_id!=='string'||!value.record_id.trim()||value.record_id.length>200||value.basis!=='existing_test_authorization_and_independent_review'||typeof value.scope!=='string'||!value.scope.trim()||value.scope.length>2000||value.task_id!==q.task_id||value.result_version!==q.result_version||value.draft_sha256!==q.draft_sha256||hash(localTarget(value.target))!==hash(target))fail('CANDIDATE_DELIVERY_AUTHORIZATION_INVALID');
 return {record_id:value.record_id,basis:value.basis,scope:value.scope,...q,target,authorized_at:now()};
}
function text(cell){
 if(!cell)return '';
 if(['STRING','RICH_STRING'].includes(cell.value_type)){
  // Tencent STRING responses include inactive protobuf defaults. They are not
  // numeric/formula cells; nonempty formula and contradictory values still fail.
  if(![undefined,null,''].includes(cell.formula)||![undefined,null,0].includes(cell.number_value)||![undefined,null,false].includes(cell.bool_value))return null;
  return typeof cell.string_value==='string'?cell.string_value:null;
 }
 if(cell.value_type===''&&cell.string_value===''&&[undefined,null,''].includes(cell.formula)&&[undefined,null,0].includes(cell.number_value)&&[undefined,null,false].includes(cell.bool_value))return '';
 if(cell.value_type!==undefined||cell.number_value!==undefined||cell.bool_value!==undefined||cell.formula!==undefined)return null;
 return typeof cell.string_value==='string'?cell.string_value:cell.string_value===undefined?'':null;
}
const linkValue=c=>c?.hyperlink?.url??c?.link?.url??c?.hyperlink??c?.link;
export function createCandidateDelivery({dataRoot,readCandidate,getDestination,isEnabled=()=>false,client=new TencentClient(),verify=verifyExport,leaseMs=30000,timeoutMs=180000}={}){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||[readCandidate,getDestination,isEnabled,verify].some(f=>typeof f!=='function')||!client?.call||!Number.isInteger(leaseMs)||leaseMs<30||!Number.isInteger(timeoutMs)||timeoutMs<1)fail('CANDIDATE_DELIVERY_CONFIG');
 const namedRoot=resolve(dataRoot);mkdirSync(namedRoot,{recursive:true,mode:0o700});const stat=lstatSync(namedRoot);if(!stat.isDirectory()||stat.isSymbolicLink())fail('CANDIDATE_DELIVERY_CONFIG');
 const folder=join(realpathSync(namedRoot),'candidate-deliveries');mkdirSync(folder,{recursive:true,mode:0o700});
 if(!lstatSync(folder).isDirectory()||lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder)fail('CANDIDATE_DELIVERY_CONFIG');
 for(const suffix of ['','-wal','-shm'])try{const file=join(folder,'tasks.sqlite'+suffix),s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||realpathSync(file)!==file)fail('CANDIDATE_DELIVERY_CONFIG');}catch(e){if(e.code!=='ENOENT')throw e;}
 const db=new Tasks(realpathSync(folder)),active=new Map(),preparing=new Set();let closed=false;
 const task=id=>{const t=db.get(id);if(!t||t.type!=='candidate-delivery'||t.payload?.version!==CANDIDATE_DELIVERY_VERSION)fail('CANDIDATE_DELIVERY_NOT_FOUND');return t;};
 function frozen(id){const t=task(id),f=db.checkpoint(key(id));if(!f||hash(f.intent)!==t.payload.intent_sha256||hash(f.draft)!==f.intent.draft_sha256||hash(f.authorization)!==f.intent.authorization_sha256||f.sheet_name!==sheetName(id))fail('CANDIDATE_DELIVERY_CHECKPOINT_INVALID');return f;}
 function read(id){const t=task(id),f=frozen(id),r=db.checkpoint(recordKey(id));return {id:t.id,task_store:'candidate-delivery',version:CANDIDATE_DELIVERY_VERSION,state:t.state==='writing'&&t.lease<=Date.now()?'unknown':t.state,candidate_task_id:f.intent.task_id,result_version:f.intent.result_version,draft_sha256:f.intent.draft_sha256,target:clone(f.intent.target),sheet_name:f.sheet_name,authorization:clone(f.authorization),receipt:r?clone(r):null,error:t.error||null,created:t.created,updated:t.updated};}
 const list=()=>db.db.prepare("SELECT id FROM tasks WHERE type='candidate-delivery' ORDER BY created,id").all().map(t=>read(t.id));
 function owned(id,owner,signal){signal?.throwIfAborted();const t=task(id);if(t.state!=='writing'||t.owner!==owner||t.cancelled||t.lease<=Date.now())fail('CANDIDATE_DELIVERY_OWNERSHIP_LOST');}
 function save(id,owner,signal,r){db.transaction(()=>{owned(id,owner,signal);db.checkpoint(recordKey(id),r);});}
 async function checkTarget(f){if(hash(localTarget(await getDestination()))!==hash(f.intent.target))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');}
 function start(id,resumeExpected=null){
  if(active.has(id))return;const owner=randomUUID();
  const claimed=db.transaction(()=>{const t=task(id);const expectedState=resumeExpected?'reconciled_partial':'approved';if(t.state!==expectedState||t.owner!==null||t.cancelled)return false;if(resumeExpected&&hash(db.checkpoint(recordKey(id)))!==resumeExpected)fail('CANDIDATE_DELIVERY_RESUME_INVALID');db.db.prepare("UPDATE tasks SET state='writing',owner=?,lease=?,updated=? WHERE id=? AND state=? AND owner IS NULL AND cancelled=0").run(owner,Date.now()+leaseMs,now(),id,expectedState);return true;});if(!claimed)return;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]),f=frozen(id);
  const r=resumeExpected?clone(db.checkpoint(recordKey(id))):{version:CANDIDATE_DELIVERY_VERSION,intent_sha256:hash(f.intent),task_id:f.intent.task_id,result_version:f.intent.result_version,draft_sha256:f.intent.draft_sha256,target:f.intent.target,sheet_name:f.sheet_name,operations:[],content_verified:false,links_verified:false,style_status:'not_attempted',warnings:[],scope:'exact frozen rows and hyperlink targets; not gameplay or creative quality certification'};
  const timer=setInterval(()=>{try{db.transaction(()=>{owned(id,owner,signal);db.db.prepare('UPDATE tasks SET lease=? WHERE id=? AND owner=?').run(Date.now()+leaseMs,id,owner);});}catch{controller.abort();}},Math.max(10,Math.floor(leaseMs/3)));timer.unref?.();
  async function call(name,args){
   if(!reads.has(name)&&!mutations.has(name))fail('CANDIDATE_DELIVERY_TOOL_DENIED');owned(id,owner,signal);
   let operation;if(mutations.has(name)){
    if(isEnabled()!==true)fail('CANDIDATE_DELIVERY_DISABLED');await checkTarget(f);owned(id,owner,signal);
    operation={sequence:r.operations.length,name,args_sha256:hash(args),status:'pending',started_at:now()};r.operations.push(operation);save(id,owner,signal,r);
   }
   const value=await client.call(name,args,{signal});owned(id,owner,signal);
   if(operation){operation.status='responded';operation.responded_at=now();save(id,owner,signal,r);}return value;
  }
  const promise=(async()=>{
   try{
    if(isEnabled()!==true)fail('CANDIDATE_DELIVERY_DISABLED');await checkTarget(f);candidate(await readCandidate(f.intent.task_id,{signal}),f.intent);owned(id,owner,signal);
    let nextRow=0;
    if(resumeExpected){
     const proof=await partialProof(call,f,r);if(!r.resume_proof||hash(proof)!==r.resume_proof.proof_sha256||hash(r.resume_proof.facts)!==r.resume_proof.proof_sha256)fail('CANDIDATE_DELIVERY_RESUME_INVALID');nextRow=proof.next_row;
     r.resume_authorizations=[...(r.resume_authorizations||[]),{authorized_at:now(),owner,proof_sha256:hash(proof),next_row:nextRow,authorization_sha256:f.intent.authorization_sha256,basis:'explicit_resume_after_read_only_prefix_reconciliation'}];save(id,owner,signal,r);
    }else{
     const info=await call('sheet_get_sheet_info',{file_id:f.intent.target.file_id});if(!Array.isArray(info.sheets)||info.sheets.some(s=>s.sheet_name===f.sheet_name))fail('CANDIDATE_DELIVERY_SHEET_COLLISION');
     const added=await call('sheet_add_sheet',{file_id:f.intent.target.file_id,name:f.sheet_name,append_index:true});if(typeof added?.sheet_id!=='string'||!added.sheet_id)fail('CANDIDATE_DELIVERY_REMOTE_UNKNOWN');r.sheet_id=added.sheet_id;save(id,owner,signal,r);
    }
    const base={file_id:f.intent.target.file_id,sheet_id:r.sheet_id};
    for(let row=nextRow;row<f.draft.rows.length;row+=15){const end=Math.min(row+14,f.draft.rows.length-1),before=await readCells(call,base,row,end);if(before.some(c=>text(c)!==''||linkValue(c)!==undefined&&linkValue(c)!==null))fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');
     await call('sheet_set_range_value',rangeArgs(base,f.draft,row));await readAfterWrite(call,base,f.draft,row,end,signal);
    }
    for(const link of f.draft.links)await call('sheet_set_link',{...base,...link,display_text:link.url});
    // A transport failure remains unknown, including a style request. A returned
    // style deficiency is only a warning and cannot conceal text corruption.
    await call('sheet_set_cell_style',{...base,start_row:0,end_row:f.draft.rows.length-1,start_col:0,end_col:3,wrap_text:true,font_family:'微软雅黑',font_size:11,vertical_align:'top'});r.style_status='requested';
    const checked=await verifyCells(call,base,f.draft);if(checked.linkMismatch)fail('CANDIDATE_DELIVERY_LINK_MISMATCH');r.content_verified=true;r.links_verified=checked.links;
    const exported=await verify({call:(n,a)=>call(n,a)},base.file_id,f.sheet_name,clone(f.draft),signal);owned(id,owner,signal);
    if(exported?.content!==true)fail('CANDIDATE_DELIVERY_EXPORT_MISMATCH');r.export={content:true,links:exported.links===true,styles:exported.styles===true};
    r.links_verified=checked.links||r.export.links;r.style_status=r.export.styles?'verified':'unverified';if(!r.export.styles)r.warnings.push('STYLE_NOT_VERIFIED');
    // Export is itself a read; repeat live cells after all formatting operations.
    const final=await verifyCells(call,base,f.draft);if(final.linkMismatch)fail('CANDIDATE_DELIVERY_LINK_MISMATCH');r.links_verified=final.links||r.export.links;r.link_verification_method=final.links?'live_cell_properties':'bounded_export_snapshot';
    r.content_sha256=hash(f.draft.rows);r.links_sha256=r.links_verified?hash(f.draft.links):null;r.verified_at=now();r.url=`${f.intent.target.url}?tab=${encodeURIComponent(r.sheet_id)}`;
    finish(r.links_verified?'verified':'content_verified_links_pending');
   }catch(e){db.transaction(()=>{const t=task(id);if(t.owner!==owner||t.state!=='writing')return;r.failure_code=/^CANDIDATE_DELIVERY_[A-Z_]+$/.test(e.code||'')?e.code:'CANDIDATE_DELIVERY_REMOTE_UNKNOWN';if(e.code==='CANDIDATE_DELIVERY_LINK_MISMATCH')r.links_verified=false;r.stopped_at=now();db.checkpoint(recordKey(id),r);db.db.prepare('UPDATE tasks SET state=?,owner=NULL,lease=0,error=?,updated=? WHERE id=? AND owner=?').run(r.operations.length?'unknown':t.cancelled?'cancelled':'blocked',r.failure_code,now(),id,owner);});}
   finally{clearInterval(timer);active.delete(id);}
  })();
  function finish(state){db.transaction(()=>{owned(id,owner,signal);db.checkpoint(recordKey(id),r);db.db.prepare('UPDATE tasks SET state=?,owner=NULL,lease=0,error=NULL,updated=? WHERE id=? AND owner=?').run(state,now(),id,owner);});}
  active.set(id,{owner,controller,promise});
 }
 async function approve(value,{authorization:auth,expectedTarget}={}){
  if(closed)fail('CANDIDATE_DELIVERY_CLOSED');if(isEnabled()!==true)fail('CANDIDATE_DELIVERY_DISABLED');const q=request(value);
  const pending=(async()=>{
   const target=localTarget(await getDestination());if(expectedTarget!==undefined&&hash(localTarget(expectedTarget))!==hash(target))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');const identity=hash({version:CANDIDATE_DELIVERY_VERSION,...q,target});
   const existing=db.db.prepare("SELECT id FROM tasks WHERE type='candidate-delivery' AND key=?").get(identity);
   if(existing){const f=frozen(existing.id);if(auth!==undefined)authorization(q,target,auth);if(hash(f.intent.target)!==hash(target))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');return read(existing.id);}
   // A target change cannot silently create a second delivery of an unresolved
   // effect. A new explicit approval is required after resolving the old intent.
   const previous=list().find(t=>t.candidate_task_id===q.task_id&&t.result_version===q.result_version&&t.draft_sha256===q.draft_sha256);
   if(previous)fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');
   const r=candidate(await readCandidate(q.task_id),q),a=authorization(q,target,auth),resolved=await resolveDestination(target,{client,signal:AbortSignal.timeout(Math.min(timeoutMs,60000))});
   if(hash(resolved)!==hash(target))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');if(closed||isEnabled()!==true)fail('CANDIDATE_DELIVERY_DISABLED');
   if(hash(localTarget(await getDestination()))!==hash(target))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');
   const id=db.transaction(()=>{const duplicate=db.db.prepare('SELECT id FROM tasks WHERE key=?').get(identity);if(duplicate)return duplicate.id;
    if(list().some(t=>t.candidate_task_id===q.task_id&&t.result_version===q.result_version&&t.draft_sha256===q.draft_sha256))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');
    const id=randomUUID(),intent={version:CANDIDATE_DELIVERY_VERSION,...q,candidate_pipeline:CREATIVE_TASK_PIPELINE,draft_render_version:r.version,source_binding_sha256:hash(r.binding),target,authorization_sha256:hash(a)};
    db.db.prepare('INSERT INTO tasks(id,key,type,state,payload,stage,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,identity,'candidate-delivery','approved',JSON.stringify({version:CANDIDATE_DELIVERY_VERSION,intent_sha256:hash(intent)}),'固定草稿已批准',now(),now());
    db.checkpoint(key(id),{intent,draft:clone(r.draft),authorization:a,sheet_name:sheetName(id)});return id;
   });start(id);return read(id);
  })();preparing.add(pending);try{return await pending;}catch(e){if(/^CANDIDATE_DELIVERY_[A-Z_]+$/.test(e.code||''))throw e;fail('CANDIDATE_DELIVERY_PREPARATION_FAILED');}finally{preparing.delete(pending);}
 }
 async function reconcileOwned(id){
  if(closed)fail('CANDIDATE_DELIVERY_CLOSED');const t=task(id),f=frozen(id);
  if(t.owner&&t.lease>Date.now()||active.has(id))fail('CANDIDATE_DELIVERY_BUSY');
  const expected=hash(t),signal=AbortSignal.timeout(timeoutMs),r=clone(db.checkpoint(recordKey(id))||{});
  const call=(n,a)=>{if(!reads.has(n))fail('CANDIDATE_DELIVERY_TOOL_DENIED');return client.call(n,a,{signal});};
  try{
   const info=await call('sheet_get_sheet_info',{file_id:f.intent.target.file_id}),matches=info.sheets?.filter(s=>s.sheet_name===f.sheet_name);
   if(!Array.isArray(matches)||matches.length!==1||typeof matches[0].sheet_id!=='string'||r.sheet_id&&r.sheet_id!==matches[0].sheet_id)fail('CANDIDATE_DELIVERY_REMOTE_UNKNOWN');
   if(t.state!=='verified'&&!t.cancelled&&isPartialLog(f,r)){
    const facts=await partialProof(call,f,r),proof={version:'candidate-resume-proof-1',checked_at:now(),facts,proof_sha256:hash(facts),boundary:'Local ownership cannot lock remote user edits; only the read-back snapshots and never-attempted batches are proven. No overwrite or resend of attempted batches.'};
    db.transaction(()=>{if(hash(task(id))!==expected||hash(db.checkpoint(recordKey(id))||{})!==hash(r))fail('CANDIDATE_DELIVERY_BUSY');r.resume_proof=proof;r.reconciliations=[...(r.reconciliations||[]),{checked_at:proof.checked_at,method:'read_only_responded_range_prefix',next_row:facts.next_row,proof_sha256:proof.proof_sha256}];db.checkpoint(recordKey(id),r);db.db.prepare("UPDATE tasks SET state='reconciled_partial',owner=NULL,lease=0,error=NULL,updated=? WHERE id=?").run(now(),id);});return read(id);
   }
   const base={file_id:f.intent.target.file_id,sheet_id:matches[0].sheet_id};
   const checked=await verifyCells(call,base,f.draft);if(checked.linkMismatch)fail('CANDIDATE_DELIVERY_LINK_MISMATCH');
   let exported;
   if(!checked.links){exported=await verify({call},base.file_id,f.sheet_name,clone(f.draft),signal);if(exported?.content!==true)fail('CANDIDATE_DELIVERY_EXPORT_MISMATCH');}
   const final=await verifyCells(call,base,f.draft);if(final.linkMismatch)fail('CANDIDATE_DELIVERY_LINK_MISMATCH');
   const links=final.links||exported?.links===true;
   const evidence={checked_at:now(),content_verified:true,links_verified:links,content_sha256:hash(f.draft.rows),links_sha256:links?hash(f.draft.links):null,sheet_id:matches[0].sheet_id,method:final.links?'read_only_all_cells_and_link_properties':exported?'read_only_all_cells_and_bounded_export':'read_only_all_cells_links_pending',...(exported?{export:{content:true,links:exported.links===true,styles:exported.styles===true},style_status:exported.styles===true?'verified':'unverified'}:{})};
   db.transaction(()=>{if(hash(task(id))!==expected)fail('CANDIDATE_DELIVERY_BUSY');r.reconciliations=[...(r.reconciliations||[]),evidence];
    if(t.state!=='verified'){Object.assign(r,evidence,{url:`${f.intent.target.url}?tab=${encodeURIComponent(evidence.sheet_id)}`,target:f.intent.target,task_id:f.intent.task_id,result_version:f.intent.result_version,draft_sha256:f.intent.draft_sha256});db.db.prepare('UPDATE tasks SET state=?,owner=NULL,lease=0,error=NULL,updated=? WHERE id=?').run(links?'verified':'content_verified_links_pending',now(),id);}db.checkpoint(recordKey(id),r);
   });
  }catch(e){if(e.code==='CANDIDATE_DELIVERY_BUSY')throw e;db.transaction(()=>{if(hash(task(id))!==expected)fail('CANDIDATE_DELIVERY_BUSY');r.reconciliations=[...(r.reconciliations||[]),{checked_at:now(),content_verified:false,code:'CANDIDATE_DELIVERY_RECONCILE_INCOMPLETE'}];db.checkpoint(recordKey(id),r);if(t.state!=='verified')db.db.prepare("UPDATE tasks SET state='unknown',owner=NULL,lease=0,error=?,updated=? WHERE id=?").run('CANDIDATE_DELIVERY_RECONCILE_INCOMPLETE',now(),id);});}
  return read(id);
 }
 function reconcile(id){if(closed)fail('CANDIDATE_DELIVERY_CLOSED');const pending=reconcileOwned(id);preparing.add(pending);return pending.finally(()=>preparing.delete(pending));}
 function resume(id){
  if(closed)fail('CANDIDATE_DELIVERY_CLOSED');if(isEnabled()!==true)fail('CANDIDATE_DELIVERY_DISABLED');
  let resumeSnapshot=null;const pending=(async()=>{
   const t=task(id),f=frozen(id),r=db.checkpoint(recordKey(id));if(t.state!=='reconciled_partial'||t.owner!==null||t.cancelled||active.has(id)||!r?.resume_proof)fail('CANDIDATE_DELIVERY_RESUME_INVALID');const snapshot=hash(r),taskHash=hash(t),signal=AbortSignal.timeout(timeoutMs);resumeSnapshot={taskHash,receiptHash:snapshot};
   await checkTarget(f);candidate(await readCandidate(f.intent.task_id,{signal}),f.intent);
   const resolved=await resolveDestination(f.intent.target,{client,signal});if(hash(resolved)!==hash(f.intent.target))fail('CANDIDATE_DELIVERY_DESTINATION_CHANGED');
   const call=(name,args)=>{if(!['sheet_get_sheet_info','sheet_get_cell_data'].includes(name))fail('CANDIDATE_DELIVERY_TOOL_DENIED');return client.call(name,args,{signal});};
   const facts=await partialProof(call,f,r);if(hash(facts)!==r.resume_proof.proof_sha256||hash(r.resume_proof.facts)!==r.resume_proof.proof_sha256)fail('CANDIDATE_DELIVERY_RESUME_INVALID');
   if(closed||isEnabled()!==true)fail('CANDIDATE_DELIVERY_DISABLED');await checkTarget(f);if(hash(task(id))!==taskHash||hash(db.checkpoint(recordKey(id)))!==snapshot)fail('CANDIDATE_DELIVERY_BUSY');start(id,snapshot);return read(id);
  })();preparing.add(pending);return pending.catch(e=>{if(resumeSnapshot&&!active.has(id))db.transaction(()=>{const current=task(id);if(current.state==='reconciled_partial'&&current.owner===null&&hash(current)===resumeSnapshot.taskHash&&hash(db.checkpoint(recordKey(id)))===resumeSnapshot.receiptHash)db.db.prepare("UPDATE tasks SET state='unknown',error=?,updated=? WHERE id=? AND owner IS NULL").run('CANDIDATE_DELIVERY_RESUME_INVALID',now(),id);});if(/^CANDIDATE_DELIVERY_[A-Z_]+$/.test(e.code||''))throw e;fail('CANDIDATE_DELIVERY_RESUME_INVALID');}).finally(()=>preparing.delete(pending));
 }
 async function cancel(id){const a=active.get(id);db.transaction(()=>{const t=task(id);if(['verified','content_verified_links_pending','cancelled','blocked'].includes(t.state))return;if(t.owner&&t.owner!==a?.owner&&t.lease>Date.now())fail('CANDIDATE_DELIVERY_BUSY');if(a&&t.owner!==a.owner)fail('CANDIDATE_DELIVERY_OWNERSHIP_LOST');db.db.prepare('UPDATE tasks SET cancelled=1,state=?,updated=? WHERE id=?').run(a?'writing':t.state==='approved'?'cancelled':'unknown',now(),id);a?.controller.abort();});if(a)await a.promise;return read(id);}
 async function idle(){while(preparing.size||active.size)await Promise.allSettled([...preparing,...[...active.values()].map(a=>a.promise)]);}
 async function close(){if(closed)return;closed=true;for(const a of active.values())a.controller.abort();await idle();db.close();}
 return {approve,read,list,reconcile,resume,cancel,idle,close};
}
async function readCells(call,base,start,end){const r=await call('sheet_get_cell_data',{...base,start_row:start,end_row:end,start_col:0,end_col:3,return_csv:false});if(![undefined,null,''].includes(r?.error)||!Array.isArray(r?.cells)||r.cells.some(c=>!c||!Number.isInteger(c.row)||!Number.isInteger(c.col)||c.row<start||c.row>end||c.col<0||c.col>3)||new Set(r.cells.map(c=>`${c.row}:${c.col}`)).size!==r.cells.length)fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');return r.cells;}
function compareCells(cells,draft,start,end){for(let row=start;row<=end;row++)for(let col=0;col<4;col++)if(text(cells.find(c=>c.row===row&&c.col===col))!==draft.rows[row][col])fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');}
async function verifyCells(call,base,draft){let links=true,linkMismatch=false;for(let start=0;start<draft.rows.length;start+=15){const end=Math.min(start+14,draft.rows.length-1),cells=await readCells(call,base,start,end);compareCells(cells,draft,start,end);for(const l of draft.links.filter(l=>l.row>=start&&l.row<=end)){const actual=linkValue(cells.find(c=>c.row===l.row&&c.col===l.col));if(actual!==l.url){links=false;if(actual!==undefined&&actual!==null)linkMismatch=true;}}}return {links,linkMismatch};}

function rangeArgs(base,draft,start){const values=[];for(let row=start;row<=Math.min(start+14,draft.rows.length-1);row++)for(let col=0;col<4;col++)values.push({row,col,value_type:'STRING',string_value:draft.rows[row][col]});return {...base,values};}
function isPartialLog(f,r){return typeof r?.sheet_id==='string'&&r.sheet_id.length>0&&Array.isArray(r.operations)&&r.operations.length>=2&&(r.operations.length-1)*15<f.draft.rows.length&&r.operations.every((o,i)=>o?.sequence===i&&o.status==='responded'&&o.name===(i===0?'sheet_add_sheet':'sheet_set_range_value'));}
async function partialProof(call,f,r){
 if(!isPartialLog(f,r)||r.intent_sha256!==hash(f.intent)||r.draft_sha256!==f.intent.draft_sha256||r.result_version!==f.intent.result_version||hash(r.target)!==hash(f.intent.target)||r.sheet_name!==f.sheet_name)fail('CANDIDATE_DELIVERY_RESUME_INVALID');
 const base={file_id:f.intent.target.file_id,sheet_id:r.sheet_id},first={file_id:base.file_id,name:f.sheet_name,append_index:true};
 if(r.operations[0].args_sha256!==hash(first))fail('CANDIDATE_DELIVERY_RESUME_INVALID');
 for(let i=1;i<r.operations.length;i++)if(r.operations[i].args_sha256!==hash(rangeArgs(base,f.draft,(i-1)*15)))fail('CANDIDATE_DELIVERY_RESUME_INVALID');
 const info=await call('sheet_get_sheet_info',{file_id:base.file_id}),matches=info.sheets?.filter(s=>s.sheet_name===f.sheet_name);if(!Array.isArray(matches)||matches.length!==1||matches[0].sheet_id!==base.sheet_id)fail('CANDIDATE_DELIVERY_RESUME_INVALID');
 const nextRow=(r.operations.length-1)*15;
 for(let row=0;row<f.draft.rows.length;row+=15){const end=Math.min(row+14,f.draft.rows.length-1),cells=await readCells(call,base,row,end);if(cells.some(c=>c.row<row||c.row>end||c.col<0||c.col>3))fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');if(row<nextRow){
  compareCells(cells,f.draft,row,end);
  for(const cell of cells){const actual=linkValue(cell);if(actual!==undefined&&actual!==null&&actual!==''){const expected=f.draft.links.find(l=>l.row===cell.row&&l.col===cell.col)?.url;if(actual!==expected)fail('CANDIDATE_DELIVERY_LINK_MISMATCH');}}
 }else if(cells.some(c=>text(c)!==''||linkValue(c)!==undefined&&linkValue(c)!==null))fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');}
 return {intent_sha256:hash(f.intent),authorization_sha256:f.intent.authorization_sha256,task_id:f.intent.task_id,result_version:f.intent.result_version,source_binding_sha256:f.intent.source_binding_sha256,draft_sha256:f.intent.draft_sha256,operations_count:r.operations.length,target:f.intent.target,sheet_id:r.sheet_id,sheet_name:f.sheet_name,operations_sha256:hash(r.operations),next_row:nextRow,total_rows:f.draft.rows.length,prefix_sha256:hash(f.draft.rows.slice(0,nextRow)),unattempted_rows_empty:true};
}
function waitRead(ms,signal){signal?.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});}
async function readAfterWrite(call,base,draft,start,end,signal){
 for(let attempt=0;attempt<=3;attempt++){
  const cells=await readCells(call,base,start,end);let delayed=false;
  for(let row=start;row<=end;row++)for(let col=0;col<4;col++){const actual=text(cells.find(c=>c.row===row&&c.col===col)),expected=draft.rows[row][col];if(actual===expected)continue;if(actual!=='')fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');delayed=true;}
  if(!delayed)return;if(attempt===3)fail('CANDIDATE_DELIVERY_CONTENT_MISMATCH');await waitRead([250,750,1500][attempt],signal);
 }
}

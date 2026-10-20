import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Tasks,hash} from '../app/tasks.mjs';
import {CREATIVE_TASK_PIPELINE} from '../app/creative-task.mjs';
import {createCandidateDelivery} from '../app/candidate-delivery.mjs';
import {handleCandidateDeliveryHttp} from '../app/candidate-delivery-http.mjs';
import {qualityCapabilities} from '../app/quality-policy.mjs';
const tick=()=>new Promise(r=>setTimeout(r,5));
function setup(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'candidate-delivery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const draft={rows:Array.from({length:18},(_,i)=>[`行${i}`,i===16?'https://example.com/source':`完整正文${i}\n第二行`,'游戏桥','追加拆解']),links:[{row:16,col:1,url:'https://example.com/source'}]};
 const result={version:CREATIVE_TASK_PIPELINE,status:'needs_review',accepted:false,ready:false,delivery_enabled:false,game:'测试游戏',mode:'A',format:'video',binding:{game:'测试游戏',mode:'A',format:'video',source_id:'12345678901'},plan:{fit:'expression',blocking_gaps:[]},draft,draft_sha256:hash(draft)};result.result_version=hash(result);
 const candidate={id:randomUUID(),type:'creative-candidate',state:'completed',payload:{creative_pipeline:CREATIVE_TASK_PIPELINE},result};
 const q={task_id:candidate.id,result_version:result.result_version,draft_sha256:result.draft_sha256};
 let enabled=true,target={file_id:'file123',url:'https://docs.qq.com/sheet/file123'};const calls=[],sheets=[];let hook=async()=>{};
 const client={async call(name,args,{signal}={}){calls.push({name,args:structuredClone(args)});await hook(name,args,signal);
  if(name==='manage_query_file_info')return {file_id:target.file_id,url:target.url,type:'sheet'};
  if(name==='sheet_get_sheet_info')return {sheets:sheets.map(s=>({sheet_id:s.id,sheet_name:s.name}))};
  if(name==='sheet_add_sheet'){const s={id:`sheet${sheets.length}`,name:args.name,cells:[]};sheets.push(s);return {sheet_id:s.id};}
  const s=sheets.find(s=>s.id===args.sheet_id);if(!s)throw Error('SECRET /private/path');
  if(name==='sheet_get_cell_data')return {cells:structuredClone(s.cells.filter(c=>c.row>=args.start_row&&c.row<=args.end_row))};
  if(name==='sheet_set_range_value'){for(const c of args.values){const old=s.cells.find(x=>x.row===c.row&&x.col===c.col);if(old)Object.assign(old,c);else s.cells.push({...c});}return {};}
  if(name==='sheet_set_link'){s.cells.find(c=>c.row===args.row&&c.col===args.col).hyperlink={url:args.url};return {};}
  if(name==='sheet_set_cell_style')return {};throw Error('unexpected');
 }};
 const instances=[];const make=overrides=>{const service=createCandidateDelivery({dataRoot:root,readCandidate:async()=>structuredClone(candidate),getDestination:()=>structuredClone(target),isEnabled:()=>enabled,client,verify:async()=>({content:true,links:true,styles:false}),...options,...overrides});instances.push(service);return service;};
 t.after(async()=>{for(const s of instances)await s.close();});
 return {root,q,candidate,draft,calls,sheets,client,make,setHook:f=>hook=f,setEnabled:v=>enabled=v,setTarget:v=>target=v};
}
const mutations=x=>x.calls.filter(c=>c.name.startsWith('sheet_set_')||c.name==='sheet_add_sheet');

// Independent regression cases: no live Tencent or Host calls.
test('a final explicit wrong hyperlink overrides an earlier successful export',async t=>{
 const f=setup(t),s=f.make({verify:async()=>{f.sheets[0].cells.find(c=>c.row===16&&c.col===1).hyperlink={url:'https://changed-after-export.example/'};return {content:true,links:true,styles:true};}});
 const created=await s.approve(f.q);await s.idle();const result=s.read(created.id);
 assert.equal(result.state,'unknown');
 const count=mutations(f).length;await s.approve(f.q);assert.equal(mutations(f).length,count);
});
test('absent API hyperlink attributes may use a scoped successful export, without treating an explicit wrong link as absent',async t=>{
 const f=setup(t);f.setHook(async name=>{if(name==='sheet_set_cell_style')for(const cell of f.sheets[0].cells)delete cell.hyperlink;});
 const s=f.make(),created=await s.approve(f.q);await s.idle();const result=s.read(created.id);
 assert.equal(result.state,'verified');assert.equal(result.receipt.links_verified,true);
});
test('frozen sheet name is bound to its intent and fits the XLSX 31-character sheet-name limit',async t=>{
 const f=setup(t),s=f.make(),created=await s.approve(f.q);await s.idle();assert(created.sheet_name.length<=31);
 const db=new Tasks(join(f.root,'candidate-deliveries'));
 try{const key='candidate-delivery:'+created.id+':frozen',saved=db.checkpoint(key);saved.sheet_name='unapproved-sheet-name';db.checkpoint(key,saved);assert.throws(()=>s.read(created.id),{code:'CANDIDATE_DELIVERY_CHECKPOINT_INVALID'});}finally{db.close();}
});
test('relative roots, symlink roots/folders and SQLite sidecar links reject before opening a delivery store',t=>{
 const f=setup(t),deps={readCandidate:async()=>f.candidate,getDestination:()=>({file_id:'file123',url:'https://docs.qq.com/sheet/file123'}),client:{call:async()=>assert.fail('no provider call')},verify:async()=>assert.fail('no export')};
 assert.throws(()=>createCandidateDelivery({...deps,dataRoot:'relative-root'}),{code:'CANDIDATE_DELIVERY_CONFIG'});
 const rootAlias=join(f.root,'root-alias');symlinkSync(f.root,rootAlias,'dir');assert.throws(()=>createCandidateDelivery({...deps,dataRoot:rootAlias}),{code:'CANDIDATE_DELIVERY_CONFIG'});
 const other=join(f.root,'other');mkdirSync(other);const folder=join(f.root,'candidate-deliveries');symlinkSync(other,folder,'dir');assert.throws(()=>createCandidateDelivery({...deps,dataRoot:f.root}),{code:'CANDIDATE_DELIVERY_CONFIG'});rmSync(folder);mkdirSync(folder);
 const target=join(f.root,'do-not-open');writeFileSync(target,'unchanged');
 for(const suffix of ['', '-wal','-shm']){const path=join(folder,'tasks.sqlite'+suffix);symlinkSync(target,path);assert.throws(()=>createCandidateDelivery({...deps,dataRoot:f.root}),{code:'CANDIDATE_DELIVERY_CONFIG'});rmSync(path);}
});
test('a target changed after the review screen is rejected before any provider call, including repeat approval',async t=>{
 const f=setup(t),s=f.make(),shown={file_id:'file123',url:'https://docs.qq.com/sheet/file123'};
 f.setTarget({file_id:'other123',url:'https://docs.qq.com/sheet/other123'});
 await assert.rejects(s.approve(f.q,{expectedTarget:shown}),{code:'CANDIDATE_DELIVERY_DESTINATION_CHANGED'});
 assert.equal(f.calls.length,0);assert.equal(s.list().length,0);
 f.setTarget(shown);const first=await s.approve(f.q,{expectedTarget:shown});await s.idle();
 assert.equal(s.read(first.id).state,'verified');
 const count=f.calls.length;
 await assert.rejects(s.approve(f.q,{expectedTarget:{file_id:'other123',url:'https://docs.qq.com/sheet/other123'}}),{code:'CANDIDATE_DELIVERY_DESTINATION_CHANGED'});
 assert.equal(f.calls.length,count);
});
test('HTTP keeps the displayed target as a precondition, and cancellation requires session plus empty body',async()=>{
 const origin='http://127.0.0.1:4319',id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',target={file_id:'file123',url:'https://docs.qq.com/sheet/file123'};
 const q={task_id:id,result_version:'a'.repeat(64),draft_sha256:'b'.repeat(64)},calls=[];
 const service={approve:async(...args)=>{calls.push(['approve',...args]);return {id};},cancel:async value=>{calls.push(['cancel',value]);return {id,state:'unknown'};}};
 const invoke=async(path,value,token='session')=>{let response;await handleCandidateDeliveryHttp({method:'POST',headers:{host:'127.0.0.1:4319','x-crawl-token':token}},null,new URL(path,origin),{service,token:'session',origin,body:async()=>value,json:(_,status,body)=>{response={status,body};}});return response;};
 for(const value of [q,{...q,target,rows:[]},{...q,target:{...target,override:true}},{...q,target:{...target,url:'https://evil.example/sheet/file123'}}]){
  const r=await invoke('/api/candidate-deliveries',value);assert(r.status>=400);assert.equal(calls.length,0);
 }
 assert.equal((await invoke('/api/candidate-deliveries',{...q,target})).status,202);
 assert.deepEqual(calls,[['approve',q,{expectedTarget:target}]]);
 assert.equal((await invoke(`/api/candidate-deliveries/${id}/cancel`,{},'wrong')).status,403);
 assert.equal((await invoke(`/api/candidate-deliveries/${id}/cancel`,{force:true})).status,400);assert.equal(calls.length,1);
 assert.equal((await invoke(`/api/candidate-deliveries/${id}/cancel`,{})).status,200);assert.deepEqual(calls[1],['cancel',id]);
});
// Supersedes the pre-acceptance all-held assertion after the real, independently
// reviewed four-tab recovery. The historical single-sheet writer is still held.
test('bounded recovery enables reviewed candidate and four-template entries while legacy execution remains held',async t=>{
 const caps=qualityCapabilities();
 assert.equal(caps.creative_candidate.enabled,true);
 assert.equal(caps.creative_candidate.semantic_acceptance,false);
 assert.equal(caps.creative_candidate.automatic_paid_collection,false);
 assert.equal(caps.creative_candidate.delivery_enabled,false);
 const delivery=caps.reviewed_candidate_delivery;
 assert.equal(delivery.enabled,true);
 assert.equal(delivery.pipeline,'four-template-delivery-1');
 assert.equal(delivery.requires_exact_draft_confirmation,true);
 assert.equal(delivery.requires_template_plan_confirmation,true);
 assert.equal(delivery.template_layout,true);
 assert.equal(delivery.automatic_resume,false);
 for(const key of ['learning','creation','delivery'])assert.equal(caps[key].enabled,false,key);
 const f=setup(t),legacy=f.make({isEnabled:()=>false});
 await assert.rejects(legacy.approve(f.q),{code:'CANDIDATE_DELIVERY_DISABLED'});
 assert.equal(f.calls.length,0);assert.equal(legacy.list().length,0);
});

async function respondedPrefix(t,{prefixLink=false}={}){
 const f=setup(t);
 if(prefixLink){f.draft.rows[1][1]='https://example.com/prefix';f.draft.links.unshift({row:1,col:1,url:f.draft.rows[1][1]});f.candidate.result.draft_sha256=hash(f.draft);delete f.candidate.result.result_version;f.candidate.result.result_version=hash(f.candidate.result);f.q.draft_sha256=f.candidate.result.draft_sha256;f.q.result_version=f.candidate.result.result_version;}
 let fault=true;const s=f.make({client:{call:async(name,args,ctx)=>{const value=await f.client.call(name,args,ctx);if(name==='sheet_get_cell_data'&&args.start_row===0&&value.cells.length&&fault){fault=false;throw Error('controlled read failure after responded prefix');}return value;}}});
 const created=await s.approve(f.q);await s.idle();assert.equal(s.read(created.id).state,'unknown');return {...f,s,id:created.id};
}
test('two independent resumptions cannot duplicate add or either range batch',async t=>{
 const f=await respondedPrefix(t);await f.s.reconcile(f.id);const b=f.make();let arrivals=0,release;const barrier=new Promise(r=>release=r);
 f.setHook(async name=>{if(name==='manage_query_file_info'){arrivals++;if(arrivals===2)release();await barrier;}});
 const results=await Promise.allSettled([f.s.resume(f.id),b.resume(f.id)]);await Promise.all([f.s.idle(),b.idle()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.s.read(f.id).state,'verified');
 assert.equal(f.sheets.length,1);assert.deepEqual(f.calls.filter(c=>c.name==='sheet_set_range_value').map(c=>c.args.values[0].row),[0,15]);
 assert.equal(f.s.read(f.id).receipt.resume_authorizations.length,1);
});
test('partial proof rejects a user-modified hyperlink in the already written prefix before any resume writes',async t=>{
 const f=await respondedPrefix(t,{prefixLink:true});f.sheets[0].cells.find(c=>c.row===1&&c.col===1).hyperlink={url:'https://user-edit.example/'};const before=mutations(f).length;
 assert.equal((await f.s.reconcile(f.id)).state,'unknown');await assert.rejects(f.s.resume(f.id));assert.equal(mutations(f).length,before);
});

test('resume HTTP remains explicit, authenticated, empty-body only and GET cannot dispatch',async()=>{
 const origin='http://127.0.0.1:4319',id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',calls=[];
 const service={resume:async x=>{calls.push(x);return {id:x};},read:()=>({id})};
 const invoke=async(method,path,value={},token='session')=>{let response;await handleCandidateDeliveryHttp({method,headers:{host:'127.0.0.1:4319','x-crawl-token':token}},null,new URL(path,origin),{service,token:'session',origin,body:async()=>value,json:(_,status,body)=>{response={status,body};}});return response;};
 assert.equal((await invoke('GET',`/api/candidate-deliveries/${id}/resume`)).status,405);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/resume`,{},'wrong')).status,403);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/resume`,{force:true})).status,400);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/resume?force=1`)).status,400);assert.equal(calls.length,0);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/resume`)).status,200);assert.deepEqual(calls,[id]);
});
test('cancellation during pre-resume read validation prevents all subsequent mutations',async t=>{
 const f=await respondedPrefix(t);await f.s.reconcile(f.id);const before=mutations(f).length;let entered=false,release;
 f.setHook(async name=>{if(name==='manage_query_file_info'){entered=true;await new Promise(r=>release=r);}});
 const resume=f.s.resume(f.id);while(!entered)await tick();await f.s.cancel(f.id);release();await assert.rejects(resume);await f.s.idle();
 assert.equal(mutations(f).length,before);assert.equal(f.s.read(f.id).state,'unknown');
});
test('resume rechecks newly changed prefix links; extra links reject, matching links remain resumable',async t=>{
 for(const mode of ['changed-after-proof','extra','matching']){
  const f=await respondedPrefix(t,{prefixLink:true});await f.s.reconcile(f.id);const before=mutations(f).length;
  const cell=f.sheets[0].cells.find(c=>c.row===(mode==='extra'?2:1)&&c.col===1);
  cell.hyperlink={url:mode==='matching'?f.draft.rows[1][1]:'https://user-change.example/'};
  if(mode==='matching'){await f.s.resume(f.id);await f.s.idle();assert.equal(f.s.read(f.id).state,'verified');assert.deepEqual(f.calls.filter(c=>c.name==='sheet_set_range_value').map(c=>c.args.values[0].row),[0,15]);}
  else {await assert.rejects(f.s.resume(f.id));assert.equal(mutations(f).length,before);assert.equal(f.s.read(f.id).state,'unknown');}
 }
});
function refreshFrozenFixture(f){
 f.candidate.result.draft_sha256=hash(f.draft);delete f.candidate.result.result_version;f.candidate.result.result_version=hash(f.candidate.result);f.q.draft_sha256=f.candidate.result.draft_sha256;f.q.result_version=f.candidate.result.result_version;
}
test('provider RICH_STRING links and explicit formatted-empty defaults retain exact draft text',async t=>{
 const f=setup(t);f.draft.rows[3][2]='';refreshFrozenFixture(f);
 f.setHook(async name=>{if(name==='sheet_get_cell_data')for(const sheet of f.sheets)for(const c of sheet.cells){Object.assign(c,{number_value:0,bool_value:false,formula:''});c.value_type=c.string_value===''?'':c.row===16&&c.col===1?'RICH_STRING':'STRING';}});
 const s=f.make(),created=await s.approve(f.q);await s.idle();assert.equal(s.read(created.id).state,'verified');assert.equal(f.sheets[0].cells.find(c=>c.row===3&&c.col===2).string_value,'');
});
test('RICH_STRING and formatted-empty compatibility cannot hide formulas, typed values or unknown text types',async t=>{
 for(const bad of [{value_type:'RICH_STRING',formula:'=HYPERLINK("https://evil.example")'},{value_type:'RICH_STRING',number_value:7},{value_type:'RICH_STRING',bool_value:true},{value_type:'',string_value:'hidden text',number_value:0,bool_value:false,formula:''},{value_type:'NUMBER',number_value:0,string_value:'行0'},{value_type:'BOOL',bool_value:false,string_value:'行0'}]){
  const f=setup(t);f.setHook(async name=>{if(name==='sheet_get_cell_data'&&f.sheets[0]?.cells.length)Object.assign(f.sheets[0].cells[0],bad);});
  const s=f.make(),created=await s.approve(f.q);await s.idle();assert.equal(s.read(created.id).state,'unknown');assert.equal(f.calls.filter(c=>c.name==='sheet_set_range_value').length,1);
 }
});
async function fullyWrittenUnknown(t){
 const f=setup(t);f.setHook(async name=>{if(name==='sheet_set_cell_style'){for(const c of f.sheets[0].cells){delete c.hyperlink;Object.assign(c,{number_value:0,bool_value:false,formula:'',value_type:c.row===16&&c.col===1?'RICH_STRING':'STRING'});}throw Error('controlled style response unavailable');}});
 const s=f.make(),created=await s.approve(f.q);await s.idle();assert.equal(s.read(created.id).state,'unknown');f.setHook(async()=>{});return {...f,s,id:created.id};
}
test('read-only reconciliation can verify missing link attributes by export without replaying writes',async t=>{
 const f=await fullyWrittenUnknown(t);let exports=0;const s=f.make({verify:async(_client,fileId,sheetName,draft)=>{exports++;assert.equal(fileId,'file123');assert.equal(sheetName,f.sheets[0].name);assert.deepEqual(draft,f.draft);return {content:true,links:true,styles:false};}});const before=mutations(f).length;
 const reconciled=await s.reconcile(f.id);assert.equal(reconciled.state,'verified');assert.equal(reconciled.receipt.links_verified,true);assert.equal(exports,1);assert.equal(mutations(f).length,before);
});
test('readonly export fallback cannot hide a live wrong link before or after export',async t=>{
 for(const timing of ['before','after']){
  const f=await fullyWrittenUnknown(t);let exports=0;const change=()=>{f.sheets[0].cells.find(c=>c.row===16&&c.col===1).hyperlink={url:'https://explicit-wrong.example/'};};
  if(timing==='before')change();const s=f.make({verify:async()=>{exports++;change();return {content:true,links:true,styles:true};}}),before=mutations(f).length;
  assert.equal((await s.reconcile(f.id)).state,'unknown');assert.equal(exports,timing==='before'?0:1);assert.equal(mutations(f).length,before);
 }
});
test('readonly reconciliation does not expose mutation tools to its export verifier',async t=>{
 const f=await fullyWrittenUnknown(t);let attempted=false;const s=f.make({verify:async client=>{attempted=true;await client.call('sheet_set_range_value',{values:[]});return {content:true,links:true,styles:true};}}),before=mutations(f).length;
 assert.equal((await s.reconcile(f.id)).state,'unknown');assert.equal(attempted,true);assert.equal(mutations(f).length,before);
});
test('readonly export rejects content failure or later text change and retains missing-link status without proof',async t=>{
 for(const mode of ['export-content-false','live-text-change','links-unproved']){
  const f=await fullyWrittenUnknown(t);const s=f.make({verify:async()=>{if(mode==='live-text-change')f.sheets[0].cells[0].string_value='changed after export';return {content:mode!=='export-content-false',links:mode!=='links-unproved',styles:true};}}),before=mutations(f).length;
  assert.equal((await s.reconcile(f.id)).state,mode==='links-unproved'?'content_verified_links_pending':'unknown');assert.equal(mutations(f).length,before);
 }
});

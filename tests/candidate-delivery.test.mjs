import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Tasks,hash} from '../app/tasks.mjs';
import {CREATIVE_TASK_PIPELINE} from '../app/creative-task.mjs';
import {createCandidateDelivery} from '../app/candidate-delivery.mjs';
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
test('exact frozen draft includes appended rows, STRING values, full readback; repeats/restart do not call provider',async t=>{
 const f=setup(t),s=f.make();const a=await s.approve(f.q);await s.idle();const r=s.read(a.id);assert.equal(r.state,'verified');assert.equal(r.receipt.style_status,'unverified');assert.deepEqual(r.receipt.warnings,['STYLE_NOT_VERIFIED']);
 assert.equal(f.sheets.length,1);assert.equal(f.sheets[0].cells.length,72);assert.equal(f.sheets[0].cells[71].string_value,'追加拆解');assert(f.sheets[0].cells.every(c=>c.value_type==='STRING'));assert.equal(r.receipt.content_sha256,hash(f.draft.rows));
 const count=f.calls.length;assert.equal((await s.approve(f.q)).id,a.id);s.list();s.read(a.id);await s.close();const restarted=f.make();assert.equal(restarted.read(a.id).state,'verified');await restarted.approve(f.q);assert.equal(f.calls.length,count);
});
test('disabled/input/candidate/hash/blocking/authorization failures precede all writes',async t=>{
 const f=setup(t),s=f.make();f.setEnabled(false);await assert.rejects(s.approve(f.q),{code:'CANDIDATE_DELIVERY_DISABLED'});f.setEnabled(true);
 await assert.rejects(s.approve({...f.q,rows:[]}),{code:'CANDIDATE_DELIVERY_INPUT'});
 await assert.rejects(s.approve({...f.q,draft_sha256:'a'.repeat(64)}),{code:'CANDIDATE_DELIVERY_CANDIDATE_INVALID'});
 await assert.rejects(s.approve(f.q,{authorization:{basis:'reviewed'}}),{code:'CANDIDATE_DELIVERY_AUTHORIZATION_INVALID'});
 f.candidate.result.plan.blocking_gaps=['核心段待补'];await assert.rejects(s.approve(f.q),{code:'CANDIDATE_DELIVERY_CANDIDATE_INVALID'});assert.equal(f.calls.length,0);
});
test('two instances approve same identity once; frozen target change invalidates approval',async t=>{
 const f=setup(t),a=f.make(),b=f.make();const [x,y]=await Promise.all([a.approve(f.q),b.approve(f.q)]);assert.equal(x.id,y.id);await Promise.all([a.idle(),b.idle()]);assert.equal(f.sheets.length,1);
 f.setTarget({file_id:'other123',url:'https://docs.qq.com/sheet/other123'});const before=f.calls.length;await assert.rejects(a.approve(f.q),{code:'CANDIDATE_DELIVERY_DESTINATION_CHANGED'});assert.equal(f.calls.length,before);
});
test('lost add response produces unknown; restart and repeated approve never resend; reconcile is read only',async t=>{
 const f=setup(t);f.setHook(async(name,args)=>{if(name==='sheet_add_sheet'){f.sheets.push({id:'lost',name:args.name,cells:[]});throw Error('SECRET token/path');}});const s=f.make();const a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'unknown');assert(!JSON.stringify(s.read(a.id)).includes('SECRET'));
 const before=mutations(f).length;await s.approve(f.q);await s.close();const resumed=f.make();await resumed.approve(f.q);await resumed.reconcile(a.id);assert.equal(resumed.read(a.id).state,'unknown');assert.equal(mutations(f).length,before);
 // A complete independently read state can be recognized, but never repaired.
 f.setHook(async()=>{});f.sheets[0].cells=f.draft.rows.flatMap((row,r)=>row.map((v,c)=>({row:r,col:c,string_value:v,...(r===16&&c===1?{hyperlink:{url:v}}:{})})));
 assert.equal((await resumed.reconcile(a.id)).state,'verified');assert.equal(mutations(f).length,before);
});
test('known wrong hyperlink remains unknown; formatting text corruption cannot pass export',async t=>{
 const f=setup(t),s=f.make({verify:async()=>({content:true,links:false,styles:true})});f.setHook(async(name)=>{if(name==='sheet_set_cell_style')f.sheets[0].cells.find(c=>c.row===16&&c.col===1).hyperlink={url:'https://wrong.example/'};});const a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'unknown');assert.equal(s.read(a.id).receipt.links_verified,false);
 const g=setup(t),z=g.make();g.setHook(async(name)=>{if(name==='sheet_set_cell_style')g.sheets[0].cells[0].string_value='changed';});const b=await z.approve(g.q);await z.idle();assert.equal(z.read(b.id).state,'unknown');assert.equal(z.read(b.id).receipt.content_verified,false);
});
test('cancel awaits owned in-flight callback and does not publish late success',async t=>{
 const f=setup(t);let release,entered=false;f.setHook(async name=>{if(name==='sheet_add_sheet'){entered=true;await new Promise(r=>release=r);}});const s=f.make(),a=await s.approve(f.q);while(!entered)await tick();let done=false;const cancel=s.cancel(a.id).then(r=>{done=true;return r;});await tick();assert.equal(done,false);release();assert.equal((await cancel).state,'unknown');assert.equal(mutations(f).length,1);
});
test('foreign owner blocks cancellation and late result cannot overwrite replacement',async t=>{
 const f=setup(t);let release,entered=false;f.setHook(async name=>{if(name==='sheet_add_sheet'){entered=true;await new Promise(r=>release=r);}});const s=f.make(),a=await s.approve(f.q);while(!entered)await tick();const db=new Tasks(join(f.root,'candidate-deliveries'));t.after(()=>db.close());db.db.prepare('UPDATE tasks SET owner=?,lease=? WHERE id=?').run('replacement',Date.now()+60000,a.id);
 await assert.rejects(s.cancel(a.id),{code:'CANDIDATE_DELIVERY_BUSY'});release();await s.idle();assert.equal(db.get(a.id).owner,'replacement');assert.equal(db.get(a.id).state,'writing');assert.equal(mutations(f).length,1);
});
test('orphan writing read reports unknown without mutation, reconcile never writes',async t=>{
 const f=setup(t),s=f.make();const a=await s.approve(f.q);await s.idle();const db=new Tasks(join(f.root,'candidate-deliveries'));t.after(()=>db.close());db.db.prepare("UPDATE tasks SET state='writing',owner='dead',lease=1 WHERE id=?").run(a.id);const before=db.get(a.id),n=mutations(f).length;assert.equal(s.read(a.id).state,'unknown');assert.deepEqual(db.get(a.id),before);assert.equal((await s.reconcile(a.id)).state,'verified');assert.equal(mutations(f).length,n);
});
test('partial batch and timeout stop without another write or automatic repair',async t=>{
 const f=setup(t);f.setHook(async(name,args)=>{if(name==='sheet_set_range_value'){f.sheets[0].cells.push({...args.values[0]});throw Error('lost response');}});const s=f.make(),a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'unknown');const n=mutations(f).length;await s.approve(f.q);await s.reconcile(a.id);assert.equal(mutations(f).length,n);assert.equal(s.read(a.id).state,'unknown');
 const g=setup(t,{timeoutMs:20});g.setHook(async(name,args,signal)=>{if(name==='sheet_add_sheet')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});const z=g.make(),b=await z.approve(g.q);const keepAlive=setTimeout(()=>{},100);await z.idle();clearTimeout(keepAlive);assert.equal(z.read(b.id).state,'unknown');assert.equal(mutations(g).length,1);
});
test('close waits for export/reconcile callback; preparation provider error is sanitized',async t=>{
 const f=setup(t);let release,entered=false;const s=f.make({verify:async()=>{entered=true;await new Promise(r=>release=r);return {content:true,links:true,styles:true};}}),a=await s.approve(f.q);while(!entered)await tick();let closed=false;const closing=s.close().then(()=>closed=true);await tick();assert.equal(closed,false);release();await closing;const db=new Tasks(join(f.root,'candidate-deliveries'));assert.equal(db.get(a.id).state,'unknown');db.close();
 const g=setup(t),z=g.make();const b=await z.approve(g.q);await z.idle();let readRelease,reading=false;g.setHook(async name=>{if(name==='sheet_get_sheet_info'){reading=true;await new Promise(r=>readRelease=r);}});const reconciliation=z.reconcile(b.id);while(!reading)await tick();let finished=false;const end=z.close().then(()=>finished=true);await tick();assert.equal(finished,false);readRelease();await reconciliation;await end;
 const h=setup(t),v=h.make({readCandidate:async()=>{throw Error('/private/secret API_KEY');}});await assert.rejects(v.approve(h.q),{code:'CANDIDATE_DELIVERY_PREPARATION_FAILED'});assert.equal(h.calls.length,0);
});
// Provider-real response shape: STRING carries inactive protobuf defaults.
test('Tencent STRING defaults accepted; formula/typed-number/error/coordinate anomalies fail closed',async t=>{
 const f=setup(t);f.setHook(async name=>{if(name==='sheet_get_cell_data')for(const s of f.sheets)for(const c of s.cells)Object.assign(c,{number_value:0,bool_value:false,formula:''});});const s=f.make(),a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'verified');
 for(const change of [c=>c.formula='=1+1',c=>c.value_type='NUMBER',c=>c.value_type='BOOL',c=>c.col=10]){
  const g=setup(t);g.setHook(async name=>{if(name==='sheet_get_cell_data'&&g.sheets[0]?.cells.length)change(g.sheets[0].cells[0]);});const z=g.make(),b=await z.approve(g.q);await z.idle();assert.equal(z.read(b.id).state,'unknown');assert.equal(g.calls.filter(c=>c.name==='sheet_set_range_value').length,1);
 }
});
test('delayed empty read is retried read-only; nonempty mismatch stops immediately',async t=>{
 const f=setup(t);let delayed=false; // Wrap only responses; mutations are untouched.
 let native;const z=f.make({client:{call:async(name,args,ctx)=>{const result=await native(name,args,ctx);if(name==='sheet_get_cell_data'&&args.start_row===0&&result.cells.length&&!delayed){delayed=true;return {cells:[]};}return result;}}});
 // Use another factory's trusted fake through a captured client is unnecessary:
 // setup exposes the adapter below for response-level controlled fault injection.
 native=f.client.call.bind(f.client);
 const a=await z.approve(f.q);await z.idle();assert.equal(z.read(a.id).state,'verified');assert.equal(f.calls.filter(c=>c.name==='sheet_set_range_value'&&c.args.values[0].row===0).length,1);
 const g=setup(t);g.setHook(async name=>{if(name==='sheet_get_cell_data'&&g.sheets[0]?.cells.length)g.sheets[0].cells[0].string_value='wrong';});const s=g.make(),b=await s.approve(g.q);await s.idle();assert.equal(s.read(b.id).state,'unknown');assert.equal(g.calls.filter(c=>c.name==='sheet_get_cell_data').length,2);
});
async function prefixFixture(t){
 const f=setup(t);let first=true;const s=f.make({client:{call:async(name,args,ctx)=>{const r=await f.client.call(name,args,ctx);if(name==='sheet_get_cell_data'&&args.start_row===0&&r.cells.length&&first){first=false;throw Error('read interrupted after responded write');}return r;}}});const a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'unknown');return {...f,s,id:a.id};
}
test('responded prefix reconciles without writes, explicit resume skips prefix and reuses same sheet',async t=>{
 const f=await prefixFixture(t),writes=mutations(f).length;assert.equal((await f.s.reconcile(f.id)).state,'reconciled_partial');assert.equal(mutations(f).length,writes);const proof=f.s.read(f.id).receipt.resume_proof;assert.equal(proof.facts.next_row,15);assert.equal(proof.facts.operations_sha256,hash(f.s.read(f.id).receipt.operations));
 await f.s.approve(f.q);f.s.read(f.id);await f.s.close();const s=f.make();assert.equal(s.read(f.id).state,'reconciled_partial');assert.equal(mutations(f).length,writes);
 await s.resume(f.id);await s.idle();assert.equal(s.read(f.id).state,'verified');assert.equal(f.sheets.length,1);assert.deepEqual(f.calls.filter(c=>c.name==='sheet_set_range_value').map(c=>c.args.values[0].row),[0,15]);assert.equal(s.read(f.id).receipt.resume_authorizations.length,1);
});
test('prefix proof rejects pending, wrong args, partial prefix, or nonempty unattempted cells',async t=>{
 for(const mode of ['pending','hash','prefix','suffix']){
  const f=await prefixFixture(t);const db=new Tasks(join(f.root,'candidate-deliveries'));const k=`candidate-delivery:${f.id}:receipt`,r=db.checkpoint(k);
  if(mode==='pending')r.operations[1].status='pending';if(mode==='hash')r.operations[1].args_sha256='a'.repeat(64);if(['pending','hash'].includes(mode))db.checkpoint(k,r);db.close();
  if(mode==='prefix')f.sheets[0].cells[0].string_value='';if(mode==='suffix')f.sheets[0].cells.push({row:17,col:2,string_value:'user edit'});
  const n=mutations(f).length;assert.equal((await f.s.reconcile(f.id)).state,'unknown');await assert.rejects(f.s.resume(f.id),{code:'CANDIDATE_DELIVERY_RESUME_INVALID'});assert.equal(mutations(f).length,n);
 }
});
test('resume rechecks proof, target and candidate; cancelled or replaced lease cannot resume',async t=>{
 for(const mode of ['suffix','target','candidate','cancel','owner']){
  const f=await prefixFixture(t);await f.s.reconcile(f.id);const n=mutations(f).length;
  if(mode==='suffix')f.sheets[0].cells.push({row:17,col:2,string_value:'changed'});
  if(mode==='target')f.setTarget({file_id:'other123',url:'https://docs.qq.com/sheet/other123'});
  if(mode==='candidate')f.candidate.result.plan.blocking_gaps=['changed'];
  if(mode==='cancel')await f.s.cancel(f.id);
  if(mode==='owner'){const db=new Tasks(join(f.root,'candidate-deliveries'));db.db.prepare("UPDATE tasks SET owner='foreign',lease=? WHERE id=?").run(Date.now()+30000,f.id);db.close();}
  await assert.rejects(f.s.resume(f.id));assert.equal(mutations(f).length,n);
 }
});
test('failed/error and duplicate-cell responses are not empty; bounded empty polling stops after three rereads',async t=>{
 for(const response of [{error:'provider failed',cells:[]},{cells:[{row:0,col:0,string_value:''},{row:0,col:0,string_value:''}]}]){
  const f=setup(t),s=f.make({client:{call:async(name,args,ctx)=>name==='sheet_get_cell_data'?response:f.client.call(name,args,ctx)}}),a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'unknown');assert.equal(f.calls.filter(c=>c.name==='sheet_set_range_value').length,0);
 }
 const f=setup(t);let readsAfterWrite=0;const s=f.make({client:{call:async(name,args,ctx)=>{const r=await f.client.call(name,args,ctx);if(name==='sheet_get_cell_data'&&r.cells.length){readsAfterWrite++;return {cells:[]};}return r;}}}),a=await s.approve(f.q);await s.idle();assert.equal(s.read(a.id).state,'unknown');assert.equal(readsAfterWrite,4);assert.equal(f.calls.filter(c=>c.name==='sheet_set_range_value').length,1);
});
test('resumed cancel stops after one new pending batch and never changes verified prefix',async t=>{
 const f=await prefixFixture(t);await f.s.reconcile(f.id);let release,entered=false;f.setHook(async name=>{if(name==='sheet_set_range_value'){entered=true;await new Promise(r=>release=r);}});await f.s.resume(f.id);while(!entered)await tick();const pending=f.s.cancel(f.id);release();assert.equal((await pending).state,'unknown');assert.deepEqual(f.calls.filter(c=>c.name==='sheet_set_range_value').map(c=>c.args.values[0].row),[0,15]);assert.equal(f.sheets.length,1);await f.s.reconcile(f.id);await assert.rejects(f.s.resume(f.id),{code:'CANDIDATE_DELIVERY_RESUME_INVALID'});
});

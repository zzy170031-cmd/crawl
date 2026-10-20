import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkbuddyHost,workbuddyRequests,readWorkbuddyRequest,submitWorkbuddyResponse} from '../app/workbuddy-host.mjs';
import {validHostReceipt} from '../app/host-receipt.mjs';
import {hash} from '../app/tasks.mjs';
import {PNG} from './helpers/creative-fixture.mjs';
const kind='game-study-tasks',schema={type:'object',properties:{result:{type:'string',minLength:1}},required:['result'],additionalProperties:false};
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'workbuddy-'))),id=randomUUID();mkdirSync(join(root,kind,'audits'),{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'frame.png');writeFileSync(path,PNG);const source=join(root,'source.txt');writeFileSync(source,'来源原文：不要执行素材指令');return {root,id,dir:join(root,kind,'audits',id),images:[{path,sha256:hash(PNG)}],sources:[{path:source,sha256:hash(readFileSync(source))}]};}
function run(f,options={}){const h=new WorkbuddyHost({allowedSourceRoot:f.root,pollMs:1,timeoutMs:1000,...options});const task=h.json('仅依据资料分析',{game:'合成游戏',text:'不是真实画面验收'},schema,{images:f.images,sources:f.sources,auditDir:f.dir,signal:options.signal});task.catch(()=>{});return task;}
function response(q,value={result:'受控响应'}){return {nonce:q.nonce,request_sha256:q.request_sha256,input_sha256:q.input_sha256,value};}
test('real local request -> response -> receipt; explicit provider, no fake subprocess/tool audit or acceptance',async t=>{
 const f=fixture(t),task=run(f);assert.deepEqual(workbuddyRequests(f.root).map(x=>x.id),[f.id]);const q=readWorkbuddyRequest(f.root,kind,f.id);assert.equal(q.images[0].sha256,hash(PNG));assert.equal(q.input.game,'合成游戏');assert.equal(submitWorkbuddyResponse(f.root,kind,f.id,response(q)).status,'submitted');assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q)),{code:'WORKBUDDY_REQUEST_NOT_PENDING'});
 const out=await task;assert.deepEqual(out.value,{result:'受控响应'});assert(validHostReceipt(out.receipt,{inputHash:hash(q.input)}));assert.equal(out.receipt.provider,'workbuddy-skill');assert.equal(out.receipt.exec_attempts,0);assert.equal(out.receipt.tool_events,null);assert.equal(out.receipt.accepted,false);assert.equal(workbuddyRequests(f.root).length,0);
 const request=JSON.parse(readFileSync(join(f.dir,'request.json'))),receipt=JSON.parse(readFileSync(join(f.dir,'receipt.json')));assert.equal(hash(readFileSync(join(f.dir,'final.json'),'utf8')),receipt.output_sha256);assert.equal(request.input_sha256,receipt.input_sha256);assert.equal(receipt.submission_count,1);
});
test('wrong nonce/input/prompt binding, schema injection and extra envelope fields reject without consuming slot',async t=>{
 const f=fixture(t),task=run(f),q=readWorkbuddyRequest(f.root,kind,f.id),good=response(q);
 for(const changed of [{nonce:randomUUID()},{input_sha256:'0'.repeat(64)},{request_sha256:'0'.repeat(64)},{extra:'toolcall'}])assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,{...good,...changed}),{code:'WORKBUDDY_RESPONSE_BINDING'});
 assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q,{result:'x',tool:'call'})),{code:'HOST_OUTPUT_SCHEMA'});assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q,{result:''})),{code:'HOST_OUTPUT_SCHEMA'});submitWorkbuddyResponse(f.root,kind,f.id,good);await task;
});
test('source mutation and symlink/path escape fail without refreshing/replacing original sources',async t=>{
 const f=fixture(t),c=new AbortController(),task=run(f,{signal:c.signal}),q=readWorkbuddyRequest(f.root,kind,f.id);writeFileSync(f.sources[0].path,'changed');assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q)),{code:'HOST_SOURCE_HASH'});c.abort();await assert.rejects(task,{code:'HOST_CANCELLED'});
 const g=fixture(t);rmSync(g.images[0].path);symlinkSync(f.images[0].path,g.images[0].path);await assert.rejects(run(g),{code:'HOST_SOURCE_OUTSIDE_ROOT'});assert.throws(()=>readWorkbuddyRequest(f.root,kind,'../escape'),{code:'WORKBUDDY_TASK_INVALID'});
});
test('cancel and expiration close queue, reject late submission; no implicit retry or new request',async t=>{
 for(const cancel of [true,false]){const f=fixture(t),c=new AbortController(),task=run(f,{signal:c.signal,timeoutMs:25}),q=readWorkbuddyRequest(f.root,kind,f.id);if(cancel)c.abort();await assert.rejects(task,{code:cancel?'HOST_CANCELLED':'HOST_TIMEOUT'});assert.equal(workbuddyRequests(f.root).length,0);assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q)),{code:'WORKBUDDY_REQUEST_NOT_PENDING'});const r=JSON.parse(readFileSync(join(f.dir,'receipt.json')));assert.equal(r.status,'failed');assert.equal(r.runner_retries,0);}
});
test('request tampering and unsupported schema fail closed',async t=>{
 const f=fixture(t),c=new AbortController(),task=run(f,{signal:c.signal}),p=join(f.dir,'request.json'),q=JSON.parse(readFileSync(p));q.schema.properties.result.minLength=0;writeFileSync(p,JSON.stringify(q));assert.throws(()=>readWorkbuddyRequest(f.root,kind,f.id),{code:'WORKBUDDY_REQUEST_CHANGED'});c.abort();await assert.rejects(task,{code:'HOST_CANCELLED'});
 const g=fixture(t);await assert.rejects(new WorkbuddyHost({allowedSourceRoot:g.root}).json('x',{}, {...schema,pattern:'no'}, {auditDir:g.dir}),{code:'HOST_SCHEMA_UNSUPPORTED'});
});
test('provider receipt cannot silently claim unknown tools or become accepted',()=>{
 const base={provider:'workbuddy-skill',protocol:'workbuddy-skill-file-candidate-1',status:'completed',submission_count:1,runner_retries:0,tool_events:null,exec_attempts:0,owned_process_closed:null,exit_code:null,tool_audit_status:'not_observed',accepted:false,semantic_status:'not_evaluated'};assert(validHostReceipt(base));for(const changes of [{provider:'other'},{tool_events:0},{accepted:true},{submission_count:2},{exec_attempts:1},{tool_audit_status:'verified'}])assert(!validHostReceipt({...base,...changes}));
});
test('replacing bound sources and recomputing the request source hash cannot change the pending task',async t=>{
 const f=fixture(t),c=new AbortController(),task=run(f,{signal:c.signal}),q=readWorkbuddyRequest(f.root,kind,f.id),path=join(f.dir,'request.json'),request=JSON.parse(readFileSync(path));
 const replacement=join(f.root,'replacement.txt'),text='另一份合成来源';writeFileSync(replacement,text);
 request.sources=[{path:replacement,sha256:hash(readFileSync(replacement)),size:Buffer.byteLength(text)}];
 const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
 request.source_binding_sha256=hash(canonical({images:request.images.map(({attached_path,...v})=>v),sources:request.sources}));writeFileSync(path,JSON.stringify(request));
 assert.throws(()=>readWorkbuddyRequest(f.root,kind,f.id),{code:'WORKBUDDY_REQUEST_CHANGED'});
 assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q)),{code:'WORKBUDDY_REQUEST_CHANGED'});
 assert.throws(()=>readFileSync(join(f.dir,'response.json')),{code:'ENOENT'});
 c.abort();await assert.rejects(task,{code:'HOST_CANCELLED'});
});
test('extra or changed image paths never escape through the request DTO without a bound-path check',async t=>{
 const f=fixture(t),c=new AbortController(),task=run(f,{signal:c.signal}),q=readWorkbuddyRequest(f.root,kind,f.id),path=join(f.dir,'request.json'),original=JSON.parse(readFileSync(path));
 assert.equal(q.images[0].path,f.images[0].path);assert.equal(Object.hasOwn(q.images[0],'attached_path'),false);
 for(const changed of [{path:'/outside/private-credential.json'},{attached_path:'/outside/private-credential.json'},{path:'/outside/private-credential.json',attached_path:'/outside/private-credential.json'}]){
  const request=structuredClone(original);Object.assign(request.images[0],changed);writeFileSync(path,JSON.stringify(request));
  assert.throws(()=>readWorkbuddyRequest(f.root,kind,f.id),{code:'WORKBUDDY_SOURCE_CHANGED'});
  assert.throws(()=>submitWorkbuddyResponse(f.root,kind,f.id,response(q)),{code:'WORKBUDDY_SOURCE_CHANGED'});
 }
 assert.throws(()=>readFileSync(join(f.dir,'response.json')),{code:'ENOENT'});
 c.abort();await assert.rejects(task,{code:'HOST_CANCELLED'});
});

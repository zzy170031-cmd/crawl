import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {handleCreativeHttp} from '../app/creative-http.mjs';
const id='12345678-1234-1234-1234-123456789abc';
const valid={game:'游戏甲',study_task_id:'11111111-1111-1111-1111-111111111111',profile_version:'a'.repeat(64),source:{provider:'redfox',request_id:'22222222-2222-2222-2222-222222222222',source_id:'7695600881273670946'},mode:'A',format:'video'};
async function fixture(t){
 let origin;const calls={start:[],cancel:[],read:[],list:0},tasks=[{id,task_store:'creative-candidate',type:'creative-candidate',state:'queued',payload:{...valid}},{id:'33333333-3333-3333-3333-333333333333',payload:{...valid,game:'游戏乙'}}];
 const runtime={list:()=>{calls.list++;return tasks;},read:value=>{calls.read.push(value);const task=tasks.find(t=>t.id===value);if(!task)throw Object.assign(Error('/private/missing/receipt'),{code:'CREATIVE_TASK_NOT_FOUND'});return task;},start:async value=>{calls.start.push(value);if(value.game==='内部失败')throw Object.assign(Error('/private/credentials/token'),{code:'UNLISTED'});if(value.game==='未启用')throw Object.assign(Error('/private/gate'),{code:'CREATIVE_RUNTIME_HELD'});return tasks[0];},cancel:async value=>{calls.cancel.push(value);return {...tasks[0],state:'cancelled'};}};
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const body=async req=>{let value='';for await(const c of req)value+=c;return JSON.parse(value||'{}');};
 const server=createServer(async(req,res)=>{if(!await handleCreativeHttp(req,res,new URL(req.url,origin),{runtime,origin,token:'session',json,body}))json(res,404,{error:'other'});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
 const post=(path,value={},headers={})=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json','x-crawl-token':'session',...headers},body:JSON.stringify(value)});
 return {origin,post,calls,runtime};
}
test('host/origin/session guard executes before reads/mutations; GET is read-only and game filtering is exact',async t=>{
 const f=await fixture(t),base='/api/creative-candidates';
 assert.equal((await f.post(base,valid,{'x-crawl-token':'wrong'})).status,403);assert.equal((await f.post(base,valid,{origin:'https://elsewhere.test'})).status,403);
 assert.equal((await fetch(f.origin+base,{headers:{origin:'https://elsewhere.test'}})).status,403);
 const badHost=await new Promise((resolve,reject)=>{const req=request(f.origin+base,{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(badHost,403);assert.equal(f.calls.list,0);assert.equal(f.calls.read.length,0);assert.equal(f.calls.start.length,0);
 assert.equal((await (await fetch(f.origin+base)).json()).length,2);const filtered=await(await fetch(f.origin+base+'?game='+encodeURIComponent(' 游戏甲 '))).json();assert.equal(filtered.length,1);assert.equal(filtered[0].id,id);
 assert.equal((await fetch(f.origin+base+'/'+id)).status,200);assert.equal(f.calls.start.length,0);assert.equal(f.calls.cancel.length,0);
 assert.equal((await f.post(base,valid)).status,202);assert.deepEqual(f.calls.start,[valid]);
});
test('all extra query/body fields and retry routes reject; no other task store fallback',async t=>{
 const f=await fixture(t),base='/api/creative-candidates';
 for(const suffix of ['?game=x&game=y','?source=local','?path=/private'])assert.equal((await fetch(f.origin+base+suffix)).status,400);
 assert.equal((await f.post(base+'?game=游戏甲',valid)).status,400);
 for(const value of [{...valid,path:'/private'}, {...valid,source:{...valid.source,rows:[]}}, {...valid,mode:'C'}, {...valid,game:''}])assert.equal((await f.post(base,value)).status,400);
 assert.equal(f.calls.start.length,0);
 assert.equal((await f.post(base+'/'+id+'/retry')).status,404);
 for(const value of [[],null,{force:true},{receipt:'/private'}])assert.equal((await f.post(base+'/'+id+'/cancel',value)).status,400);
 assert.equal((await f.post(base+'/'+id+'/cancel?force=1')).status,400);assert.equal(f.calls.cancel.length,0);
 assert.equal((await f.post(base+'/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cancel')).status,404);
 assert.equal((await fetch(f.origin+'/api/tasks/'+id)).status,404);assert.equal((await f.post(base+'/'+id+'/cancel')).status,200);assert.deepEqual(f.calls.cancel,[id]);
});
test('known and unknown exceptions expose only whitelisted codes and fixed safe messages',async t=>{
 const f=await fixture(t),base='/api/creative-candidates';
 for(const [game,status,code]of [['内部失败',400,'CREATIVE_REQUEST_FAILED'],['未启用',409,'CREATIVE_RUNTIME_HELD']]){const res=await f.post(base,{...valid,game}),value=await res.json();assert.equal(res.status,status);assert.equal(value.code,code);assert(!JSON.stringify(value).includes('/private'));assert(!JSON.stringify(value).includes('token'));}
 f.runtime.read=()=>null;const missing=await fetch(f.origin+base+'/'+id);assert.equal(missing.status,404);assert.equal((await missing.json()).code,'CREATIVE_TASK_NOT_FOUND');
 const invalidJSON=await fetch(f.origin+base,{method:'POST',headers:{'x-crawl-token':'session','content-type':'application/json'},body:'{broken'});assert.equal(invalidJSON.status,400);assert.equal((await invalidJSON.json()).code,'CREATIVE_TASK_INPUT');
});
test('explicit local A HTTP dispatch accepts ID only and rejects local B or injected paths before runtime',async t=>{
 const f=await fixture(t),base='/api/creative-candidates',local={...valid,source:{provider:'local_upload',source_id:'local_'+'a'.repeat(64)}};
 assert.equal((await f.post(base,local)).status,202);assert.deepEqual(f.calls.start,[local]);
 for(const value of [{...local,mode:'B'},{...local,source:{...local.source,path:'/private/video'}},{...local,source:{...local.source,request_id:valid.source.request_id}}])
  assert.equal((await f.post(base,value)).status,400);
 assert.equal(f.calls.start.length,1);
});

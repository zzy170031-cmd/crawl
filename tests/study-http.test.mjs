import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {handleStudyHttp} from '../app/study-http.mjs';
async function fixture(t){
 let origin;const counts={start:0,cancel:0,read:0},id='12345678-1234-1234-1234-123456789abc';
 const task={id,task_store:'game-study',type:'learn',state:'queued',payload:{game:'游戏甲',learning_source:'network'}};
 const service={start:async value=>{counts.start++;if(value.game==='fail')throw Object.assign(Error('/private/credential should stay private'),{code:'INTERNAL'});if(value.game==='held')throw Object.assign(Error('private'),{code:'STUDY_SERVICE_HELD'});return task;},list:()=>[task],profile:()=>null,has:value=>value===id,read:()=>{counts.read++;return task;},cancel:async()=>{counts.cancel++;return {...task,state:'cancelled'};}};
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const body=async req=>{let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text||'{}');};
 const server=createServer(async(req,res)=>{if(!await handleStudyHttp(req,res,new URL(req.url,origin),{service,token:'test-session',origin,json,body}))json(res,404,{error:'other route'});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
 const post=(path,value={},headers={})=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json','x-crawl-token':'test-session',...headers},body:JSON.stringify(value)});
 return {origin,post,counts,id};
}
test('study routes protect host/origin/session before mutation and GET never starts work',async t=>{
 const f=await fixture(t),base='/api/game-study-tasks';
 assert.equal((await f.post(base,{game:'游戏甲',learning_source:'network'},{'x-crawl-token':''})).status,403);
 assert.equal((await f.post(base,{}, {origin:'https://untrusted.example'})).status,403);
 assert.equal((await fetch(f.origin+base,{headers:{origin:'https://untrusted.example'}})).status,403);
 const badHost=await new Promise((resolve,reject)=>{const r=request(f.origin+base,{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});assert.equal(badHost,403);
 for(const path of [base,base+'/'+f.id,'/api/game-study-profile?game=游戏甲&learning_source=network'])assert.equal((await fetch(f.origin+path)).status,200);
 assert.equal(f.counts.start,0);assert.equal(f.counts.cancel,0);
 assert.equal((await f.post(base,{game:'游戏甲',learning_source:'network'})).status,202);assert.equal(f.counts.start,1);
});
test('cancel uses only its explicit store route and rejects other-store IDs, retry and extra input',async t=>{
 const f=await fixture(t),base='/api/game-study-tasks/'+f.id;
 assert.equal((await f.post(base+'/cancel',{path:'/private'})).status,400);assert.equal(f.counts.cancel,0);
 assert.equal((await f.post(base+'/retry')).status,404);assert.equal(f.counts.start,0);
 assert.equal((await f.post('/api/game-study-tasks/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cancel')).status,404);assert.equal(f.counts.cancel,0);
 assert.equal((await f.post(base+'/cancel')).status,200);assert.equal(f.counts.cancel,1);
 assert.equal((await fetch(f.origin+'/api/tasks/'+f.id)).status,404);assert.equal(f.counts.read,0);
});
test('study API exposes only fixed error descriptions and does not leak upstream paths',async t=>{
 const f=await fixture(t),failed=await f.post('/api/game-study-tasks',{game:'fail'}),value=await failed.json();
 assert.equal(failed.status,400);assert.equal(value.code,'STUDY_REQUEST_FAILED');assert(!JSON.stringify(value).includes('/private'));assert(!JSON.stringify(value).includes('credential'));
 const held=await f.post('/api/game-study-tasks',{game:'held'});assert.equal(held.status,409);assert.equal((await held.json()).code,'STUDY_SERVICE_HELD');
});

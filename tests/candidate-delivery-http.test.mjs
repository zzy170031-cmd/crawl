import test from 'node:test';
import assert from 'node:assert/strict';
import {handleCandidateDeliveryHttp} from '../app/candidate-delivery-http.mjs';
test('candidate delivery HTTP keeps review explicit and rejects cross-origin/token/query/raw draft input before service',async()=>{
 const calls=[],id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',origin='http://127.0.0.1:4319';
 const service={list:()=>{calls.push('list');return [];},read:id=>{calls.push('read');return {id};},approve:async value=>{calls.push(value);return {id};},reconcile:async id=>{calls.push('reconcile');return {id};}};
 const invoke=async(method,path,input={},headers={})=>{let result;await handleCandidateDeliveryHttp({method,headers:{host:'127.0.0.1:4319',...headers}},null,new URL(path,origin),{service,origin,token:'t',body:async()=>input,json:(_,status,value)=>result={status,value}});return result;};
 assert.equal((await invoke('POST','/api/candidate-deliveries')).status,403);assert.equal((await invoke('GET','/api/candidate-deliveries',{}, {origin:'https://evil.test'})).status,403);assert.equal(calls.length,0);
 assert.equal((await invoke('GET','/api/candidate-deliveries?force=true')).status,400);assert.equal(calls.length,0);
 assert.equal((await invoke('POST','/api/candidate-deliveries',{task_id:id,rows:[]},{'x-crawl-token':'t'})).status,400);assert.equal(calls.length,0);
 assert.equal((await invoke('GET','/api/candidate-deliveries')).status,200);assert.deepEqual(calls,['list']);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/reconcile`,{rows:[]},{'x-crawl-token':'t'})).status,400);assert.deepEqual(calls,['list']);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/reconcile`,{},{'x-crawl-token':'t'})).status,200);assert.deepEqual(calls,['list','reconcile']);
 assert.equal((await invoke('POST',`/api/candidate-deliveries/${id}/retry`,{},{'x-crawl-token':'t'})).status,404);
});
test('candidate delivery service errors do not expose credentials or file paths',async()=>{
 let output;await handleCandidateDeliveryHttp({method:'POST',headers:{host:'127.0.0.1:4319','x-crawl-token':'t'}},null,new URL('http://127.0.0.1:4319/api/candidate-deliveries'),{service:{approve:async()=>{throw Error('/private/secret/token');}},origin:'http://127.0.0.1:4319',token:'t',body:async()=>({task_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',draft_sha256:'a'.repeat(64),result_version:'b'.repeat(64),target:{file_id:'abcd',url:'https://docs.qq.com/sheet/abcd'}}),json:(_,status,value)=>output={status,value}});assert.equal(output.status,409);assert(!JSON.stringify(output).includes('/private'));assert.equal(output.value.code,'CANDIDATE_DELIVERY_FAILED');
});

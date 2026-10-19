import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadRedfoxMedia} from '../app/redfox-media-download.mjs';
import {parseRedfoxMediaReceipt} from '../app/redfox-media-source.mjs';
import {RedfoxSourceError} from '../app/redfox-error.mjs';
const row={provider:'redfox',kind:'video',source_id:'7695475154498981158',source_url:'https://www.douyin.com/video/7695475154498981158'};
const at='2026-10-19T10:00:00Z';
const response={code:2000,data:{title:'测试原片',desc:'受控下载夹具',videoUrl:'https://v9-default.365yg.com/media.mp4?sign=public',resources:[{type:'video',downloadUrl:'https://v9-default.365yg.com/media.mp4?sign=public',durationSeconds:30}]}};
const receipt=()=>({...parseRedfoxMediaReceipt(response,row,{startedAt:at,receivedAt:at}),response:structuredClone(response)});
async function folder(t){const path=await mkdtemp(join(tmpdir(),'redfox-download-test-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
function streamResponse(chunks,{mime='video/mp4',length,status=200,redirected=false,url=receipt().media_url}={}){
 return {status,redirected,url,headers:new Headers({'content-type':mime,...(length===undefined?{}:{'content-length':String(length)})}),body:new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new Uint8Array(chunk));controller.close();}})};
}
test('single allowed CDN stream writes a private temporary file and exposes idempotent cleanup',async t=>{
 const path=await folder(t);let calls=0;
 const result=await downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async(url,options)=>{
  calls++;assert.equal(url,receipt().media_url);assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');assert.equal(options.headers.REDFOX_API_KEY,undefined);
  return streamResponse([[0,1,2],[3,4]],{length:5});
 }});
 assert.equal(calls,1);assert.deepEqual([...await readFile(result.sourcePath)],[0,1,2,3,4]);assert.equal((await stat(result.sourcePath)).mode&0o777,0o600);
 assert.equal(result.sourcePath.startsWith(path),true);assert.equal(result.identity_verified,undefined);await result.cleanup();await result.cleanup();assert.deepEqual(await readdir(path),[]);
});
test('octet-stream is accepted without pretending to validate encoded media',async t=>{
 const path=await folder(t);const result=await downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async()=>streamResponse([[1,2]],{mime:'application/octet-stream'})});
 assert.equal((await readFile(result.sourcePath)).length,2);await result.cleanup();
});
test('tampered receipt identity or forbidden CDN is rejected before any fetch',async t=>{
 const path=await folder(t);let calls=0;
 for(const edit of [r=>r.media_url='https://localhost/file',r=>r.source_id='7695475154498981111',r=>r.response.data.videoUrl='https://v9-default.365yg.com.evil.test/a',r=>delete r.response]){
  const value=receipt();edit(value);await assert.rejects(downloadRedfoxMedia(row,value,{folder:path,fetch:async()=>{calls++;}}),/回执/);
 }
 assert.equal(calls,0);assert.deepEqual(await readdir(path),[]);
});
test('redirects, substituted final URLs and bad MIME fail once and remove all temporary files',async t=>{
 const path=await folder(t);
 for(const changes of [{status:302},{redirected:true},{url:'https://v9-default.365yg.com/other'},{mime:'text/html'},{mime:''}]){
  let calls=0;await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async()=>{calls++;return streamResponse([[1,2]],changes);}}));assert.equal(calls,1);assert.deepEqual(await readdir(path),[]);
 }
});
test('declared size and streamed bytes both enforce the configured limit, without retry',async t=>{
 const path=await folder(t);
 for(const reply of [()=>streamResponse([[1]],{length:5}),()=>streamResponse([[1,2],[3,4]])]){
  let calls=0;await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,maxBytes:3,fetch:async()=>{calls++;return reply();}}),/上限/);assert.equal(calls,1);assert.deepEqual(await readdir(path),[]);
 }
});
test('truncated and empty streams are rejected and cleaned',async t=>{
 const path=await folder(t);
 for(const reply of [()=>streamResponse([[1,2]],{length:3}),()=>streamResponse([])])await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async()=>reply()}),/不完整/);
 assert.deepEqual(await readdir(path),[]);
});
test('cancellation before fetch costs no request',async t=>{
 const path=await folder(t);const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,signal:controller.signal,fetch:async()=>{calls++;}}),/取消/);
 assert.equal(calls,0);assert.deepEqual(await readdir(path),[]);
});
test('cancellation stops a stalled body read and cleans partial media without retry',async t=>{
 const path=await folder(t);const controller=new AbortController();let calls=0,readStarted;
 const started=new Promise(resolve=>{readStarted=resolve;});
 const job=downloadRedfoxMedia(row,receipt(),{folder:path,signal:controller.signal,fetch:async()=>{
  calls++;return {status:200,headers:new Headers({'content-type':'video/mp4'}),body:{getReader(){let first=true;return {read(){if(first){first=false;return Promise.resolve({done:false,value:new Uint8Array([1,2])});}readStarted();return new Promise(()=>{});},cancel:async()=>{},releaseLock(){}};}}};
 }});
 await started;controller.abort();await assert.rejects(job,/取消/);assert.equal(calls,1);assert.deepEqual(await readdir(path),[]);
});
test('deadline bounds a noncooperative fetch and a stalled stream; neither retries',async t=>{
 const path=await folder(t);
 for(const factory of [()=>new Promise(()=>{}),()=>({status:200,headers:new Headers({'content-type':'video/mp4'}),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{},releaseLock(){}})}})]){
  let calls=0;await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,timeoutMs:30,fetch:()=>{calls++;return factory();}}),/超时/);assert.equal(calls,1);assert.deepEqual(await readdir(path),[]);
 }
});
test('transport exceptions, including forged typed errors, never expose upstream messages',async t=>{
 const path=await folder(t);
 for(const error of [Error('secret-token https://upstream.invalid/private'),new RedfoxSourceError('secret-token https://upstream.invalid/private')]){
  let calls=0;await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async()=>{calls++;throw error;}}),e=>!e.message.includes('secret-token')&&!e.message.includes('https://'));
  assert.equal(calls,1);assert.deepEqual(await readdir(path),[]);
 }
});
test('production transfer deadline remains bounded at five minutes',async t=>{
 const path=await folder(t);let calls=0;
 await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,timeoutMs:300001,fetch:async()=>{calls++;}}),/超时设置无效/);
 assert.equal(calls,0);
});
test('stream failure records only allowlisted cause and byte progress, never transport details',async t=>{
 const path=await folder(t);let calls=0;
 await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async()=>{
  calls++;let reads=0;return {status:200,headers:new Headers({'content-type':'video/mp4','content-length':'10'}),body:{getReader:()=>({read:async()=>{if(!reads++)return {done:false,value:new Uint8Array([1,2,3])};throw Object.assign(Error('private-signed-url'),{cause:{code:'UND_ERR_SOCKET',message:'secret'}});},cancel:async()=>{},releaseLock(){}})}};
 }}),e=>e.message.includes('UND_ERR_SOCKET')&&e.message.includes('已接收3字节')&&e.message.includes('声明10字节')&&!e.message.includes('private')&&!e.message.includes('secret'));
 assert.equal(calls,1);assert.deepEqual(await readdir(path),[]);
 await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async()=>{throw Object.assign(Error('private'),{code:'secret-token'});}}),e=>!e.message.includes('secret-token')&&!e.message.includes('private'));
});

test('observed CDN redirect is followed only after the same URL safety check, without resolver credentials',async t=>{
 const path=await folder(t),calls=[],next='https://v5-che.douyinvod.com/redirected.mp4';
 const result=await downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async(url,options)=>{calls.push(url);assert.equal(options.redirect,'manual');assert.equal(options.headers.REDFOX_API_KEY,undefined);return calls.length===1?{status:302,url,headers:new Headers({location:next})}:streamResponse([[1,2]],{url:next,length:2});}});
 assert.deepEqual(calls,[receipt().media_url,next]);assert.equal((await readFile(result.sourcePath)).length,2);await result.cleanup();
});
test('redirects to private addresses, downgrade, credentials, unreviewed host, loops and excessive chains stop before forbidden fetch',async t=>{
 const path=await folder(t);
 for(const next of ['http://v5-che.douyinvod.com/video','https://127.0.0.1/video','https://user:pass@v5-che.douyinvod.com/video','https://v5-che.douyinvod.com.evil.test/video',receipt().media_url]){
  let calls=0;await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async(url)=>{calls++;return {status:302,url,headers:new Headers({location:next})};}}),/跳转/);assert.equal(calls,1);
 }
 let calls=0;await assert.rejects(downloadRedfoxMedia(row,receipt(),{folder:path,fetch:async(url)=>{calls++;return {status:302,url,headers:new Headers({location:`https://v5-che.douyinvod.com/hop-${calls}`})};}}),/次数/);assert.equal(calls,4);assert.deepEqual(await readdir(path),[]);
});

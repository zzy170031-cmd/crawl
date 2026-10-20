import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedfoxMediaSource,parseRedfoxMediaReceipt,REDFOX_MEDIA_ENDPOINT} from '../app/redfox-media-source.mjs';
const row={provider:'redfox',kind:'video',source_id:'7695475154498981158',source_url:'https://www.douyin.com/video/7695475154498981158'};
const at='2026-10-19T10:00:00Z';
const data={code:2000,data:{title:'',desc:'实际来源描述',videoUrl:'https://v9-default.365yg.com/media.mp4?sign=public',resources:[{type:'video',downloadUrl:'https://v9-default.365yg.com/media.mp4?sign=public',durationSeconds:30},{type:'audio',downloadUrl:'https://example.org/music.mp3'}]}};
const receipt=response=>parseRedfoxMediaReceipt(response,row,{startedAt:at,receivedAt:at});
const permitted={userInitiated:true,maxRequests:1};
test('resolver is one explicitly authorized attempt and never claims downloaded or verified',async()=>{
 let calls=0;
 const source=createRedfoxMediaSource({apiKey:'fixture-secret',clock:()=>at,fetch:async(url,init)=>{
  calls++;assert.equal(url,REDFOX_MEDIA_ENDPOINT);assert.equal(init.redirect,'error');assert.equal(init.headers.REDFOX_API_KEY,'fixture-secret');assert.deepEqual(JSON.parse(init.body),{url:row.source_url});
  return {status:200,text:async()=>JSON.stringify(data)};
 }});
 for(const authorization of [{},{userInitiated:true},{userInitiated:false,maxRequests:1},{userInitiated:true,maxRequests:2}]) await assert.rejects(source.resolve(row,authorization));
 assert.equal(calls,0);
 const result=await source.resolve(row,permitted);
 assert.equal(calls,1);assert.equal(result.status,'resolved_not_downloaded');assert.equal(result.identity_verified,false);assert.equal(result.duration_seconds,30);assert.equal(result.title,'');
 assert(!JSON.stringify(result).includes('fixture-secret'));
});
test('rejects uncollected source identity and arbitrary URLs before calling',async()=>{
 let calls=0;const source=createRedfoxMediaSource({apiKey:'fixture-secret',fetch:async()=>{calls++;}});
 for(const edit of [{provider:'browser'},{kind:'topic'},{source_id:7695475154498981158},{source_url:'https://localhost/video/7695475154498981158'}]) await assert.rejects(source.resolve({...row,...edit},permitted));
 assert.equal(calls,0);
});
test('images, music, private hosts and redirected resources cannot be called video evidence',()=>{
 for(const value of [
  {code:2000,data:{resources:[{type:'audio',downloadUrl:'https://v9-default.365yg.com/music.mp3'}]}},
  {code:2000,data:{resources:[{type:'image',downloadUrl:'https://v9-default.365yg.com/image.jpg'}]}},
  ...['http://v9-default.365yg.com/video','https://127.0.0.1/video','https://v9-default.365yg.com.evil.test/video','https://user:pass@v9-default.365yg.com/video','https://v9-default.365yg.com:8443/video'].map(videoUrl=>({code:2000,data:{videoUrl}})),
 ]) assert.throws(()=>receipt(value));
});
test('response and transport diagnostics never disclose secrets; no retry',async()=>{
 for(const response of [()=>{throw Object.assign(Error('fixture-secret'),{cause:{code:'ECONNRESET'}});},()=>({status:200,redirected:true,text:async()=>JSON.stringify(data)}),()=>({status:200,text:async()=>JSON.stringify({code:2000,data:{title:'fixture-secret'}})})]) {
  let calls=0;const source=createRedfoxMediaSource({apiKey:'fixture-secret',fetch:async()=>{calls++;return response();}});
  await assert.rejects(source.resolve(row,permitted),e=>!e.message.includes('fixture-secret'));
  assert.equal(calls,1);
 }
});
test('deadline is bounded even with noncooperative fetch and does not retry',async()=>{
 let calls=0;const source=createRedfoxMediaSource({apiKey:'fixture-secret',timeoutMs:5,fetch:()=>{calls++;return new Promise(()=>{});}});
 await assert.rejects(source.resolve(row,permitted),/超时/);assert.equal(calls,1);
});
test('observed additional CDN hosts are exact, not suffix lookalikes',()=>{
 for(const host of ['v5-dy-ov-experiment.zjcdn.com','v5-gz-a.douyinvod.com','v26.douyinvod.com','n98-v-ncdnon.douyinvod.com']) {
  assert.equal(receipt({code:2000,data:{videoUrl:`https://${host}/media.mp4`}}).media_url,`https://${host}/media.mp4`);
  assert.throws(()=>receipt({code:2000,data:{videoUrl:`https://${host}.evil.test/media.mp4`}}));
 }
});
test('reviewed media gateway permits only its exact host and raw embedded origin',()=>{
 const host='1aaaedc3949ba59abgnd56u2vjbrmhzgoxaqn6artg4.bdcgslb.com';
 const url=`https://${host}/v5-e.douyinvod.com/video/file?signature=fixture`;
 assert.equal(receipt({code:2000,data:{videoUrl:url}}).media_url,url);
 for(const changed of [
  url.replace(host,'other.bdcgslb.com'),url.replace(host,host+'.evil.test'),
  url.replace('/v5-e.douyinvod.com/','/127.0.0.1/'),
  url.replace('/v5-e.douyinvod.com/','/%76%35-e.douyinvod.com/'),
  url.replace('/video/file','/%2e%2e/private'),url.replace('/video/file','/a/../file'),
  url.replace(host,host+':443'),url.replace('https://1','https://%31'),url+'#',
 ])assert.throws(()=>receipt({code:2000,data:{videoUrl:changed}}));
});
test('retains bounded original resolver receipt before rejecting a new host, without leaking it in public error',async()=>{
 let retained,calls=0;
 const reply={code:2000,data:{desc:'真实视频',videoUrl:'https://new-unreviewed.invalid/video?private-signature=abc',unused:'discard'}};
 const source=createRedfoxMediaSource({apiKey:'fixture-secret',clock:()=>at,fetch:async()=>{calls++;return {status:200,text:async()=>JSON.stringify(reply)};}});
 await assert.rejects(source.resolve(row,{...permitted,onReceipt:r=>{retained=r;}}),e=>!e.message.includes('private-signature'));
 assert.equal(calls,1);assert.equal(retained.status,'unvalidated');assert.equal(retained.source_id,row.source_id);assert.equal(retained.response.data.videoUrl,reply.data.videoUrl);assert.equal(retained.response.data.unused,undefined);
});
test('JSON-escaped credential never reaches receipt persistence or parse output',async()=>{
 let retained=0;const secret='fixture-secret';const encoded=[...secret].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const body='{"code":2000,"data":{"desc":"'+encoded+'","videoUrl":"https://v9-default.365yg.com/media.mp4"}}';assert(!body.includes(secret));
 const source=createRedfoxMediaSource({apiKey:secret,clock:()=>at,fetch:async()=>({status:200,text:async()=>body})});
 await assert.rejects(source.resolve(row,{...permitted,onReceipt:()=>{retained++;}}),e=>!e.message.includes(secret));assert.equal(retained,0);
});
test('unvalidated receipt retains only bounded primitive fields, never nested arbitrary objects',async()=>{
 let retained;
 const source=createRedfoxMediaSource({apiKey:'fixture-secret',clock:()=>at,fetch:async()=>({status:200,text:async()=>JSON.stringify({code:2000,data:{title:{unexpected_private_field:'omit-me'},desc:'x'.repeat(20001),videoUrl:{private:'omit-me'},resources:[{type:'video',downloadUrl:{private:'omit-me'},durationSeconds:{private:'omit-me'},unexpected:'omit-me'}]}})})});
 await assert.rejects(source.resolve(row,{...permitted,onReceipt:r=>{retained=r;}}));
 assert(!JSON.stringify(retained).includes('omit-me'));assert.equal(retained.response.data.title,null);assert.equal(retained.response.data.desc,null);assert.equal(retained.response.data.resources[0].durationSeconds,null);
});
test('rotating numbered Douyin media nodes work without allowing arbitrary subdomains or suffix lookalikes',()=>{
 for(const host of ['v26.douyinvod.com','v95-zj-a.douyinvod.com','v5-gz-a.douyinvod.com'])assert.equal(new URL(receipt({code:2000,data:{videoUrl:`https://${host}/media`}}).media_url).hostname,host);
 for(const host of ['v95-zj-a.douyinvod.com.evil.test','v95-zj-a.douyinvod.com@127.0.0.1','evil.v95-zj-a.douyinvod.com','admin.douyinvod.com','evil.n98-v-ncdnon.douyinvod.com','n99-v-ncdnon.douyinvod.com','v95_zj.douyinvod.com','v95..douyinvod.com'])assert.throws(()=>receipt({code:2000,data:{videoUrl:`https://${host}/media`}}));
});

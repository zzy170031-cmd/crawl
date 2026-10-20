import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreativeSourceReader} from '../app/creative-source.mjs';
import {SideBridge} from '../app/side-bridge.mjs';
import {createRedfoxGameSource} from '../app/redfox-game-source.mjs';
import {createRedfoxHotspotSource} from '../app/redfox-hotspot-source.mjs';
import {hash} from '../app/tasks.mjs';

const at='2026-01-02T08:00:00.000Z',game='测试游戏';
const id='7695600881273670946',requestId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const input=mode=>({game,mode,request_id:requestId,source_id:id});
async function fixture(mode='A'){
 const payload=mode==='A'
  ?{provider:'redfox',purpose:'game-research',keyword:game,hours:24,sort:'likes',limit:30}
  :{provider:'redfox',purpose:'hotspots',board:'redfox_daily_hot',hours:24,category:'游戏',keyword:''};
 const row=mode==='A'
  ?{videoId:id,videoType:'0',content:game+' 测试作品',authorName:'作者',opusUrl:`https://www.iesdouyin.com/share/video/${id}`,coverUrl:'https://p3.douyinpic.com/test.jpg',publishTime:'2026-01-01 12:00:00',duration:30000,likeCount:1,commentCount:0,shareCount:0,collectCount:0}
  :{workId:id,workType:'0',content:'其他游戏的热点作品',title:'测试热点',accountName:'作者',category:'游戏',workUrl:`https://www.iesdouyin.com/share/video/${id}`,coverUrl:'https://p3.douyinpic.com/test.jpg',publishTime:'2026-01-01 12:00:00',duration:30000,likeCount:1,commentCount:0,shareCount:0,collectCount:0};
 const response={code:2000,data:mode==='A'?{list:[row],total:1,pageNum:1,pageSize:50}:[row]};
 // Entirely synthetic transport: never calls global fetch or reads credentials.
 const source=(mode==='A'?createRedfoxGameSource:createRedfoxHotspotSource)({apiKey:'fixture-only',clock:()=>at,fetch:async()=>({status:200,redirected:false,text:async()=>JSON.stringify(response)})});
 const request={id:requestId,kind:'search',task_id:null,state:'fulfilled',created_at:at,payload};
 request.result=SideBridge.prototype.validate.call({},request,await source.collect(payload));
 const calls=[];
 const bridge={get:arg=>{calls.push(arg);return request;},latestSearch:()=>assert.fail('latest lookup forbidden'),request:()=>assert.fail('collection forbidden'),update:()=>assert.fail('write forbidden'),validate:()=>assert.fail('must use actual bridge validation')};
 return {request,bridge,calls,reader:createCreativeSourceReader({bridge})};
}
test('A replays only the exact saved query and returns detached video plus full response fingerprint',async()=>{
 const f=await fixture(),before=hash(f.request);
 const actual=f.reader.read(input('A'));
 assert.equal(actual.row.source_id,id);assert.equal(actual.row.game,game);
 assert.deepEqual(actual.collection,{request_id:requestId,fingerprint:hash(f.request.result)});
 assert.deepEqual(f.calls,[requestId]);actual.row.title='caller edit';assert.equal(hash(f.request),before);
 assert.equal(f.reader.read(input('A')).row.title,f.request.result.records[0].title);
});
test('B accepts a fixed hotspot source independently of target game, without inventing its game identity',async()=>{
 const f=await fixture('B'),actual=f.reader.read({...input('B'),game:'另一个目标游戏'});
 assert.equal(actual.row.game,null);assert.equal(actual.collection.fingerprint,hash(f.request.result));
 assert.equal(actual.row.collection_request_id,requestId);
});
test('wrong request state, owner, purpose, provider, ID or target cannot reuse a saved response',async()=>{
 const edits=[
  r=>r.state='pending',r=>r.state='failed',r=>r.state='writing',
  r=>r.task_id='11111111-1111-4111-8111-111111111111',
  r=>delete r.task_id,r=>r.kind='media',r=>r.id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  r=>r.payload.provider='browser',r=>r.payload.purpose='game-learning',
  r=>r.payload.keyword='不同游戏'
 ];
 for(const edit of edits){const f=await fixture();edit(f.request);assert.throws(()=>f.reader.read(input('A')),{code:'CREATIVE_SOURCE_REQUIRED'});}
 for(const mode of ['A','B']){const f=await fixture(mode);assert.throws(()=>f.reader.read(input(mode==='A'?'B':'A')),{code:'CREATIVE_SOURCE_REQUIRED'});}
});
test('records, collection, raw receipts, dates and duplicates cannot silently replace stored query output',async()=>{
 const edits=[
  r=>r.result.records[0].title='tampered',
  r=>r.result.records[0].collection_request_id='other',
  r=>r.result.collection_request_id='other',
  r=>r.result.records[0].kind='image',
  r=>r.result.records.push(structuredClone(r.result.records[0])),
  r=>r.result.api_pages[0].response.data.list[0].content='different',
  r=>r.created_at='2026-01-03T08:00:00.000Z',
  r=>r.payload.hours=72
 ];
 for(const edit of edits){const f=await fixture();edit(f.request);assert.throws(()=>f.reader.read(input('A')),{code:'CREATIVE_SOURCE_REQUIRED'});}
 const f=await fixture('B');f.request.result.records[0].like_count=999;
 assert.throws(()=>f.reader.read(input('B')),{code:'CREATIVE_SOURCE_REQUIRED'});
});
test('missing source and malformed requests fail before a source read where possible; errors reveal no payload',async()=>{
 const f=await fixture();
 for(const value of [null,{}, {...input('A'),mode:'C'},{...input('A'),request_id:'bad'},{...input('A'),source_id:Number(id)},{...input('A'),game:''},{...input('A'),packet:{secret:'private'}}]){
  assert.throws(()=>f.reader.read(value),{code:'CREATIVE_SOURCE_REQUIRED'});
 }
 assert.equal(f.calls.length,0);
 assert.throws(()=>f.reader.read({...input('A'),source_id:'7695600881273670947'}),{code:'CREATIVE_SOURCE_REQUIRED'});
 for(const get of [()=>null,()=>{throw Error('private-token-and-path');}]){
  const reader=createCreativeSourceReader({bridge:{get}});
  assert.throws(()=>reader.read(input('A')),e=>e.code==='CREATIVE_SOURCE_REQUIRED'&&e.message==='CREATIVE_SOURCE_REQUIRED'&&!e.cause);
 }
 assert.throws(()=>createCreativeSourceReader(),{code:'CREATIVE_SOURCE_REQUIRED'});
});

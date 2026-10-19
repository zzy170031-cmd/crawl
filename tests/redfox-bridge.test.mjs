import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks} from '../app/tasks.mjs';
import {SideBridge,validateSearchInput} from '../app/side-bridge.mjs';
import {openStore,recordsForLatest} from '../app/store.mjs';
import {collectionProvenance} from '../app/collection-provenance.mjs';
import {createRedfoxGameSource,redfoxGameScope} from '../app/redfox-game-source.mjs';
import {createRedfoxHotspotSource,redfoxHotspotScope,REDFOX_HOTSPOT_CATEGORIES} from '../app/redfox-hotspot-source.mjs';
const game={provider:'redfox',purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'};
const hot={provider:'redfox',purpose:'hotspots',board:'redfox_daily_hot',hours:24,category:'游戏',keyword:'',sort:'likes'};
async function setup(t){const folder=await mkdtemp(join(tmpdir(),'redfox-bridge-'));const db=new Tasks(folder);const store=openStore(join(folder,'store.sqlite'));t.after(async()=>{store.close();db.close();await rm(folder,{recursive:true,force:true});});return {db,store,bridge:new SideBridge(db,{folder})};}
async function result(request,{empty=false,total=1,at=request.created_at}={}){
 const isGame=request.payload.purpose!=='hotspots';const scope=(isGame?redfoxGameScope:redfoxHotspotScope)(request.payload,at);
 const id='7696356432198913321',date=`${scope.end_date} 12:30:00`;
 const row=isGame?{videoId:id,videoType:'0',content:`${request.payload.keyword}攻略`,authorName:'作者',opusUrl:`https://www.iesdouyin.com/share/video/${id}`,publishTime:date,duration:10000,likeCount:4}:
 {workId:id,workType:'0',content:'游戏攻略',accountName:'作者',workUrl:`https://www.iesdouyin.com/share/video/${id}`,publishTime:date,category:request.payload.category==='all'?'游戏':request.payload.category,likeCount:4};
 const response=isGame?{code:2000,data:{list:empty?[]:[row],total:empty?0:total,pageNum:1,pageSize:50}}:{code:2000,data:empty?[]:[row]};
 const source=(isGame?createRedfoxGameSource:createRedfoxHotspotSource)({apiKey:'fake-test-key',clock:()=>at,fetch:async()=>({status:200,redirected:false,text:async()=>JSON.stringify(response)})});
 return source.collect(request.payload);
}
test('redfox input is separate strict schema; browser input stays compatible',()=>{
 assert.equal(validateSearchInput(game).provider,'redfox');assert.equal(validateSearchInput(hot).category,'游戏');
 for(const value of [{...game,board:1001},{...game,hours:1},{...game,category:'游戏'},{...hot,board:1001},{...hot,category:'608'},{...hot,hours:1},{...game,provider:'unknown'}]) assert.throws(()=>validateSearchInput(value));
 assert.equal(validateSearchInput({purpose:'hotspots',board:1001,hours:24,category:'608'}).category,'608');
 assert.equal(validateSearchInput({...game,user_initiated:true}).user_initiated,undefined);
});
test('both API branches rebuild receipts and preserve identity without DOM or old board aliases',async t=>{
 const {bridge,store}=await setup(t);
 for(const payload of [game,hot]){
  const req=bridge.request('search',payload),raw=await result(req),data=bridge.validate(req,raw);
  assert.equal(data.provider,'redfox');assert.equal(data.records[0].collection_request_id,req.id);
  assert.equal(data.records[0].sub_type,0);assert.equal(data.records[0].board,payload.board??null);
  assert.equal(data.records[0].applied_hours,null);assert.equal(data.records[0].source_endpoint,raw.source_endpoint);
  assert.equal(data.records[0].start_date,raw.observed_scope.start_date);assert.equal(data.pagination,undefined);
  store.import(data);assert.equal(store.all()[0].data.api_pagination.status,raw.api_pagination.status);
  assert.throws(()=>bridge.validate(req,{...raw,records:[{...raw.records[0],title:'tampered'}]}));
  assert.throws(()=>bridge.validate({...req,payload:{...req.payload,provider:undefined}},raw));
 }
 assert.equal(recordsForLatest(store.all()).length,2);
});
test('latest lookup isolates all filters and provider; short repeat preserves ID and time',async t=>{
 const {bridge}=await setup(t);const req=bridge.request('search',game);assert.equal(bridge.request('search',game).id,req.id);
 const raw=await result(req);bridge.fulfill(req.id,{request_id:req.id,task_id:null,result:raw});
 const cached=bridge.request('search',game,{reuseWithinMs:60000});assert.equal(cached.id,req.id);assert.equal(cached.created_at,req.created_at);
 assert.equal(bridge.latestSearchForScope(game).id,req.id);
 for(const diff of [{sort:'recent'},{hours:24},{keyword:'星际猎人'},{provider:undefined}])assert.equal(bridge.latestSearchForScope({...game,...diff}),null);
 const h=bridge.request('search',hot);assert.equal(bridge.latestSearchForScope(hot).id,h.id);
 for(const diff of [{category:'音乐'},{hours:72},{keyword:'攻略'},{sort:'recent'}])assert.equal(bridge.latestSearchForScope({...hot,...diff}),null);
 assert.notEqual(bridge.request('search',game,{reuseWithinMs:0}).id,req.id);
});
test('expired paid attempt can only be superseded by explicit new request, live lease still deduplicates',async t=>{
 const {bridge,db}=await setup(t);db.db.exec('CREATE TABLE collection_jobs(request_id TEXT,state TEXT,attempts INTEGER,lease INTEGER)');
 const req=bridge.request('search',game);db.db.prepare('INSERT INTO collection_jobs VALUES(?,?,?,?)').run(req.id,'running',1,Date.now()+60000);
 assert.equal(bridge.request('search',game).id,req.id);
 db.db.prepare('UPDATE collection_jobs SET lease=0 WHERE request_id=?').run(req.id);
 const fresh=bridge.request('search',game);assert.notEqual(fresh.id,req.id);assert.equal(bridge.get(req.id).state,'failed');
 assert.match(bridge.get(req.id).error,/结果未知/);
});
test('calendar scope rejects delayed next-day receipts and latest excludes yesterday request',async t=>{
 const {bridge,db}=await setup(t);const req=bridge.request('search',game);
 const yesterday=new Date(Date.parse(req.created_at)-86400000).toISOString();db.db.prepare('UPDATE bridge_requests SET created_at=? WHERE id=?').run(yesterday,req.id);
 assert.equal(bridge.latestSearchForScope(game),null);
 const old=bridge.get(req.id);const raw=await result(old,{at:req.created_at});assert.throws(()=>bridge.validate(old,raw),/跨自然日/);
});
test('store exact API scopes replace empties without hiding another date/category/provider',async t=>{
 const {bridge,store}=await setup(t);const a=bridge.request('search',game);store.import(bridge.validate(a,await result(a)));
 const b=bridge.request('search',{...game,hours:24});store.import(bridge.validate(b,await result(b)));
 const h=bridge.request('search',hot);store.import(bridge.validate(h,await result(h)));
 const h2=bridge.request('search',{...hot,category:'音乐'});store.import(bridge.validate(h2,await result(h2)));
 const empty=bridge.validate(a,await result(a,{empty:true}));store.import(empty);
 const rows=recordsForLatest(store.all());assert.equal(rows.length,3);assert.equal(rows.some(r=>r.collection==='games'&&r.date_window===168),false);
 assert.equal(rows.filter(r=>r.collection==='hotspots').length,2);
});
test('provenance reports API sample/date semantics without global or Douhot completion',async t=>{
 const {bridge}=await setup(t);const req=bridge.request('search',game);const data=bridge.validate(req,await result(req,{total:200}));
 const c=collectionProvenance({...req,state:'fulfilled',result:data},data.records).collection;
 assert.equal(c.completeness,'api_sample_partial');assert.equal(c.status,'partial');assert.equal(c.global_completeness,'unknown');
 assert.equal(c.pagination,null);assert.equal(c.data_end_date,data.observed_scope.end_date);assert.equal(c.requested_scope.update_policy,'T+1');
 const h=bridge.request('search',hot),hd=bridge.validate(h,await result(h,{empty:true}));
 const hc=collectionProvenance({...h,state:'fulfilled',result:hd},[]).collection;
 assert.equal(hc.completeness,'api_response_complete');assert.equal(hc.global_completeness,'unknown');assert.equal(hc.returned_source_count,0);
});

test('request deduplication rolls over at Shanghai midnight and retains prior receipt time',async t=>{
 const {bridge}=await setup(t);const OriginalDate=Date;let fixed=OriginalDate.parse('2026-10-19T15:59:59.000Z');
 class ClockDate extends OriginalDate {constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}}
 globalThis.Date=ClockDate;
 try {
  const first=bridge.request('search',game);assert.equal(bridge.request('search',game).id,first.id);
  fixed+=2000;const next=bridge.request('search',game);assert.notEqual(next.id,first.id);
  assert.equal(bridge.latestSearchForScope(game).id,next.id);
  assert.equal(bridge.get(first.id).created_at,'2026-10-19T15:59:59.000Z');
 } finally {globalThis.Date=OriginalDate;}
});

test('all 87 daily-board scopes retain separate latest requests and stored snapshots',async t=>{
 const {bridge,store}=await setup(t),expected=[];
 for(const category of ['all',...REDFOX_HOTSPOT_CATEGORIES])for(const hours of [24,72,168]){
  const payload={...hot,category,hours};assert.equal(bridge.latestSearchForScope(payload),null);
  const req=bridge.request('search',payload),raw=await result(req);bridge.fulfill(req.id,{request_id:req.id,task_id:null,result:raw});store.import(bridge.validate(req,raw));expected.push({payload,id:req.id});
 }
 assert.equal(recordsForLatest(store.all()).length,87);
 for(const {payload,id} of expected){const actual=bridge.latestSearchForScope(payload);assert.equal(actual.id,id);assert.equal(actual.state,'fulfilled');assert.equal(actual.result.records.length,1);assert.equal(actual.payload.category,payload.category);assert.equal(actual.payload.hours,payload.hours);}
 const target=expected.find(x=>x.payload.category==='游戏'&&x.payload.hours===72),newRequest=bridge.request('search',target.payload,{reuseWithinMs:0}),empty=await result(newRequest,{empty:true});
 bridge.fulfill(newRequest.id,{request_id:newRequest.id,task_id:null,result:empty});store.import(bridge.validate(newRequest,empty));assert.equal(recordsForLatest(store.all()).length,86);assert.equal(bridge.latestSearchForScope(target.payload).result.records.length,0);
 for(const item of expected.filter(x=>x!==target))assert.equal(bridge.latestSearchForScope(item.payload).id,item.id);
});

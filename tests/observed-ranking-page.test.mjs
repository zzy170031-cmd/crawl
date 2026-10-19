import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseObservedRankingPage, observeCurrentRankingPageDOM, observeFinalRankingScopeDOM, waitForObservedRankingPage, createRankingRequestEpoch, waitForRankingEpochIdle, createRankingTraversal, paceRankingClick, scopedRankingReads } from "../app/observed-ranking-page.mjs";
import { settleObservedResponses } from "../app/observed-ranking-identities.mjs";

const target = { board: 1001, hours: 72, category: "all" };
const url = "https://douhot.douyin.com/douhot/v1/material/video_billboard";
const item = (values = {}) => ({ item_id: "7697398053100633275", item_title: "", nick_name: " 作者 ", score: null, play_cnt: 12345, like_cnt: 12.5, ...values });
const receipt = (values = {}) => ({ url, status: 200, request: { sub_type: 1001, date_window: 72, page: 1, page_size: 30 }, body: { code: 0, data: { page: { page: 1, page_size: 30, total: 1000 }, objs: [item()] } }, ...values });
const parse = values => parseObservedRankingPage(values, target, null, 1);
const request = (payload = {}) => ({ url: () => url, postDataJSON: () => ({ sub_type: 1001, date_window: 72, page: 1, page_size: 30, ...payload }) });

test("response rows preserve empty strings and precise source numbers without fabricated rank", () => {
  const result = parse([receipt()]);
  assert.equal(result.metadata.total, 1000); assert.equal(result.actual_count, 1);
  assert.deepEqual(result.records[0], { kind: "video", source_endpoint: "douhot-page-response", source_id: "7697398053100633275", source_url: "https://www.douyin.com/video/7697398053100633275", page: 1, position_in_response: 1, title: "", author: " 作者 ", source_rank: null, score: null, play_count: 12345, like_count: 12.5, metric_precision: "observed" });
  const emptyAuthor = receipt(); emptyAuthor.body.data.objs[0].nick_name = "";
  assert.equal(parse([emptyAuthor]).records[0].author, "");
});

test("schema requires exact string identity, strings and present finite nonnegative metrics or explicit null", () => {
  for (const fields of [{ item_id: 7697398053100633275 }, { item_id: "not-an-id" }, { item_title: null }, { nick_name: null }, { item_title: "a".repeat(1001) }, { nick_name: "a".repeat(201) }, { score: undefined }, { play_cnt: "12345" }, { like_cnt: -1 }, { score: Infinity }, { score: NaN }]) {
    const changed = receipt(); changed.body.data.objs = [item(fields)];
    assert.throws(() => parse([changed]), /字段缺失或类型/);
  }
  const missing = receipt(); delete missing.body.data.objs[0].like_cnt;
  assert.throws(() => parse([missing]));
  const duplicates = receipt(); duplicates.body.data.objs.push(item());
  assert.throws(() => parse([duplicates]), /重复视频ID/);
});

test("same-page receipts must have identical ordered persisted fields and metadata", () => {
  assert.equal(parse([receipt(), receipt()]).records.length, 1);
  for (const fields of [{ item_id: "7697398053100633276" }, { item_title: "changed" }, { nick_name: "changed" }, { score: 1 }, { play_cnt: 12346 }, { like_cnt: null }]) {
    const changed = receipt(); changed.body.data.objs[0] = item(fields);
    assert.throws(() => parse([receipt(), changed]), /有序记录或指标发生变化/);
  }
  const a = receipt(); a.body.data.objs.push(item({item_id:"7697398053100633276"}));
  const b = structuredClone(a); b.body.data.objs.reverse();
  assert.throws(() => parse([a, b]), /有序记录或指标发生变化/);
  b.body.data.page.total = 999; assert.throws(() => parse([a, b]), /元数据冲突/);
  assert.throws(() => parse([receipt(), receipt({status:403})]), /未成功/);
});

test("wrong scope, page or pagination metadata cannot be adopted", () => {
  for (const fields of [{sub_type:1002},{date_window:24},{page:2},{page:"1"},{tags:[{value:605}]}]) {
    const changed = receipt(); Object.assign(changed.request, fields); assert.throws(() => parse([changed]), /未取得/);
  }
  const changed=receipt();changed.body.data.page.page=2;assert.throws(()=>parse([changed]),/分页字段/);
});

test("active page requires unique visible actual pagination item with matching aria label", () => {
  const node = (text, label, visible = true) => ({ innerText:text, getAttribute:()=>label, getClientRects:()=>visible?[{}]:[] });
  const evaluate = nodes => vm.runInNewContext(`(${observeCurrentRankingPageDOM.toString()})()`, { document:{querySelectorAll:selector=>{assert.equal(selector,".arco-table-pagination li.arco-pagination-item-active");return nodes;}}, getComputedStyle:()=>({display:"block",visibility:"visible",opacity:"1"}) });
  assert.equal(evaluate([node("1","第 1 页")]).page,1);
  for(const nodes of [[],[node("1","第 1 页",false)],[node("1","第 2 页")],[node("1","")],[node("1","第 1 页"),node("2","第 2 页")]])assert.equal(evaluate(nodes).page,null);
});

test("final DOM snapshot returns selected scope, page and URL from one synchronous evaluation", () => {
  const node=(text,label=null,shown=true)=>({innerText:text,getAttribute:name=>name==="aria-label"?label:null,hasAttribute:()=>false,getClientRects:()=>shown?[{}]:[]});
  const selected=[node("近3天"),node("低粉爆款"),node("近1天",null,false)];
  const environment={location:{href:"https://douhot.douyin.com/square/hotspot?date_window=72&sub_type=1002"},
    getComputedStyle:()=>({display:"block",visibility:"visible",opacity:"1"}),
    document:{querySelectorAll:selector=>selector==='[role="combobox"]'?[node("电视剧"),node("30条/页")]:selector==='.arco-tag-checked'?selected:selector.includes('下一页')?[{...node('', '下一页'),hasAttribute:name=>name==='disabled'}]:[node("1","第 1 页")]}};
  const result=vm.runInNewContext(`(${observeFinalRankingScopeDOM.toString()})()`,environment);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{url:environment.location.href,page:1,next_disabled:true,timeLabel:"近3天",boardLabel:"低粉爆款",categoryLabel:"电视剧"});
});

test("page wait accepts late completed receipt only for exact scope and page and cancels", async () => {
  const old=receipt();old.request.page=2;const receipts=[old];
  const waiting=waitForObservedRankingPage(receipts,target,null,1,{timeoutMs:100});
  setTimeout(()=>receipts.push(receipt()),5);assert.equal((await waiting).request.page,1);
  await assert.rejects(waitForObservedRankingPage([old],target,null,1,{timeoutMs:5}),{code:"SOURCE_RESPONSE_TIMEOUT"});
  const abort=new AbortController();const pending=waitForObservedRankingPage([],target,null,1,{signal:abort.signal});abort.abort(Error("cancelled"));await assert.rejects(pending,/cancelled/);
});

test("request epoch rejects old-round objects and waits only current scope/page requests", async () => {
  const previous=createRankingRequestEpoch(), current=createRankingRequestEpoch(), old=request(), now=request();
  previous.observe(old);previous.close();assert.equal(previous.owns(old),false);assert.equal(current.owns(old),false);
  current.observe(now);current.observe(request({page:2}));current.observe(request({date_window:24}));
  assert.equal(current.owns(now),true);assert.equal(current.pending(target,null,1),1);
  const waiting=waitForRankingEpochIdle(current,target,null,1,{timeoutMs:100});setTimeout(()=>current.complete(now),5);await waiting;
  const failed=request();current.observe(failed);current.failed(failed);current.complete(failed);
  await assert.rejects(waitForRankingEpochIdle(current,target,null,1),/请求失败/);
  const fresh=createRankingRequestEpoch();fresh.observe(request());const abort=new AbortController();
  const blocked=waitForRankingEpochIdle(fresh,target,null,1,{signal:abort.signal});abort.abort(Error("cancelled"));await assert.rejects(blocked,/cancelled/);
  await assert.rejects(waitForRankingEpochIdle(fresh,target,null,1,{timeoutMs:5}),/等待超时/);
});

const pageResult = (page, count=26, total=1000, size=30) => ({metadata:{page,page_size:size,total},actual_count:count,
  records:Array.from({length:count},(_,i)=>({source_id:String(10000000000+page*1000+i),page,position_in_response:i+1}))});
test("pagination completes only on a coherent disabled next control, not a short response or metadata total",()=>{
 const traversal=createRankingTraversal(target),first=pageResult(1,26,60),second=pageResult(2,26,60);
 assert.equal(traversal.append(first,{page:1,next_disabled:false},first.records),false);
 assert.throws(()=>traversal.result(),/尚未确认结束/);
 assert.equal(traversal.append(second,{page:2,next_disabled:true},second.records),true);
 const result=traversal.result();assert.equal(result.records.length,52);
 assert.equal(result.summary.metadata_total_difference,8);assert.equal(result.summary.status,'accessible_complete');
 assert.deepEqual(result.summary.terminal,{page:2,next_disabled:true,observed_current_page:2});
 assert.deepEqual(result.summary.pages.map(p=>p.page),[1,2]);
});

test("pagination refuses missing pager, skipped pages, cross-page metadata drift and repeated IDs",()=>{
 const first=pageResult(1),second=pageResult(2);
 for(const next of [null,undefined])assert.throws(()=>createRankingTraversal(target).append(first,{page:1,next_disabled:next},first.records),/未确认/);
 assert.throws(()=>createRankingTraversal(target).append(second,{page:2,next_disabled:true},second.records),/不连续/);
 for(const mutation of ['total','page_size','duplicate']){
  const traversal=createRankingTraversal(target);traversal.append(first,{page:1,next_disabled:false},first.records);
  const changed=pageResult(2);if(mutation==='duplicate')changed.records[0].source_id=first.records[0].source_id;else changed.metadata[mutation]++;
  assert.throws(()=>traversal.append(changed,{page:2,next_disabled:false},changed.records),/变化|重复/);
  assert.throws(()=>traversal.result(),/尚未确认/);
 }
});

test("50-page and 1500-row caps fail an incomplete board without calling it empty or terminal",()=>{
 const byPage=createRankingTraversal(target);
 for(let page=1;page<50;page++){const item=pageResult(page,1,2000);byPage.append(item,{page,next_disabled:false},item.records);}
 const fiftieth=pageResult(50,1,2000);assert.throws(()=>byPage.append(fiftieth,{page:50,next_disabled:false},fiftieth.records),/上限/);
 assert.equal(byPage.progress().pages.length,50);assert.equal(byPage.progress().status,'partial');assert.throws(()=>byPage.result());
 const byCount=createRankingTraversal(target),large1=pageResult(1,750,2000,1000),large2=pageResult(2,750,2000,1000);
 byCount.append(large1,{page:1,next_disabled:false},large1.records);
 assert.throws(()=>byCount.append(large2,{page:2,next_disabled:false},large2.records),/1500/);
 assert.equal(byCount.progress().collected_count,1500);assert.throws(()=>byCount.result());
 const terminal=createRankingTraversal(target);terminal.append(large1,{page:1,next_disabled:false},large1.records);terminal.append(large2,{page:2,next_disabled:true},large2.records);assert.equal(terminal.result().records.length,1500);
});

test("next-page pacing enforces at least two seconds even after an early wake and supports cancellation",async()=>{
 let time=100,waits=[];
 const clock={now:()=>time,sleep:async ms=>{waits.push(ms);time+=waits.length===1?ms/2:ms;}};
 await paceRankingClick(0,{clock});assert.equal(time,2000);assert.deepEqual(waits,[1900,950]);
 const abort=new AbortController();abort.abort(Error('cancel pagination'));await assert.rejects(paceRankingClick(time,{clock,signal:abort.signal}),/cancel pagination/);
});

test("dynamic drain includes newly arriving matching reads and ignores unrelated unfinished bodies",async()=>{
 let firstDone,secondDone;const first=new Promise(r=>firstDone=r),second=new Promise(r=>secondDone=r);
 const reads=new Map([[first,receipt()],[new Promise(()=>{}),receipt({request:{sub_type:1001,date_window:24,page:1}})]]);
 const view=scopedRankingReads(reads,target,null,1);let done=false;const waiting=settleObservedResponses(view,{timeoutMs:100}).then(()=>{done=true;});
 reads.set(second,receipt());firstDone();await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);secondDone();await waiting;
 assert.equal(view.size,2);
});

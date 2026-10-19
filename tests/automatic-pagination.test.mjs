import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomaticCollector, observeScopeDOM } from "../app/automatic-collector.mjs";
import { observeCurrentRankingPageDOM, observeFinalRankingScopeDOM } from "../app/observed-ranking-page.mjs";

async function fixture(scenario) {
  const folder = await mkdtemp(join(tmpdir(), "actual-pagination-"));
  let pageNumber = 1, url = "", clockTime = 0, closed = false, oldBodyReads = 0, navigations = 0;
  const terminalPage = scenario === "page-cap" ? 51 : 3;
  const handlers = new Map(), requests = new Map(), clicks = [], sleeps = [];
  const abort = new AbortController();
  const endpoint = "https://douhot.douyin.com/douhot/v1/material/video_billboard";
  const actualCount = page => scenario === "empty-middle" && page === 2 ? 0 : 2;
  const response = (request, page, old = false) => ({url:()=>endpoint,status:()=>200,request:()=>request,json:async()=>{
    if(old)oldBodyReads++;
    return {code:scenario==="failed-page"&&page===2?1:0,data:{page:{page,page_size:30,total:scenario==="total-drift"&&page===2?89:terminalPage*30},
      objs:Array.from({length:actualCount(page)},(_,i)=>({item_id:String(10000000000+(scenario==="duplicate"&&page===2?1:page)*100+i),item_title:old?"OLD CONFLICT":"",nick_name:"作者",score:null,play_cnt:page*100+i,like_cnt:0}))}};
  }});
  const emitPage = page => {
    if(page>1&&scenario==="old-late") handlers.get("response")?.(response(requests.get(page-1),page-1,true));
    const request={url:()=>endpoint,postDataJSON:()=>({sub_type:1001,date_window:24,page,page_size:30})};
    requests.set(page,request);handlers.get("request")?.(request);
    if(scenario!=="missing-page"||page!==2)handlers.get("response")?.(response(request,page));
  };
  const ready={first(){return this;},filter(){return this;},waitFor:async()=>{}};
  const page={url:()=>url,title:async()=>"热点宝",close:async()=>{closed=true;},isClosed:()=>closed,
    on:(event,fn)=>handlers.set(event,fn),off:event=>handlers.delete(event),
    goto:async target=>{url=target;navigations++;emitPage(1);return {status:()=>200};},
    locator:selector=>{
      if(selector==="body")return {innerText:async()=>scenario==="verification"&&pageNumber===2?"请完成安全验证":"视频总榜"};
      if(selector==='[role="dialog"], [aria-modal="true"]')return {evaluateAll:async()=>[]};
      if(selector==='.arco-table-pagination li[aria-label="下一页"]')return {click:async options=>{
        assert.deepEqual(options,{timeout:15000});assert.ok(pageNumber<terminalPage);
        clicks.push({from:pageNumber,at:clockTime});pageNumber++;emitPage(pageNumber);
      }};
      if(selector==='tbody tr')return {...ready,nth:()=>({evaluate:async()=>({})})};
      return ready;
    },
    evaluate:async fn=>{
      const scope={url,timeLabel:"近1天",boardLabel:"视频总榜",categoryLabel:"请选择垂类"};
      if(fn===observeScopeDOM)return scope;
      if(fn===observeCurrentRankingPageDOM)return {page:pageNumber};
      if(fn===observeFinalRankingScopeDOM)return {...scope,page:scenario==="page-drift"&&pageNumber===2?3:pageNumber,
        timeLabel:scenario==="scope-drift"&&pageNumber===2?"近3天":"近1天",
        next_disabled:scenario==="missing-pager"?null:scenario==="early-disabled"?true:pageNumber===terminalPage};
      return {};
    },
  };
  const collector=createAutomaticCollector({profileDir:folder,scopeResponseTimeoutMs:10,
    paginationClock:{now:()=>clockTime,sleep:async ms=>{sleeps.push(ms);clockTime+=ms;if(scenario==="cancel-pace")abort.abort(Error("cancel pagination"));}},
    chromium:{launchPersistentContext:async()=>({newPage:async()=>page,close:async()=>{closed=true;}})},
  });
  return {collector,abort,clicks,sleeps,stats:()=>({pageNumber,navigations,oldBodyReads}),close:async()=>{await collector.close();await rm(folder,{recursive:true,force:true});}};
}

test("normal next clicks traverse every short accessible page with fresh request epochs and terminal evidence",async()=>{
 for(const scenario of ["normal","old-late","empty-middle"]){
  const f=await fixture(scenario);
  try{
   const result=await f.collector.collect({purpose:"hotspots",board:1001,hours:24,category:"all"});
   const count=scenario==="empty-middle"?4:6;assert.equal(result.records.length,count);
   assert.deepEqual([...new Set(result.records.map(row=>row.page))],scenario==="empty-middle"?[1,3]:[1,2,3]);
   assert.deepEqual(f.clicks,[{from:1,at:2000},{from:2,at:4000}]);assert.equal(f.stats().navigations,1);assert.equal(f.stats().oldBodyReads,0);
   const summary=result.pagination.boards[0];assert.equal(summary.collected_count,count);assert.equal(summary.metadata_total,90);assert.equal(summary.metadata_total_difference,90-count);
   assert.deepEqual(summary.pages.map(page=>page.page),[1,2,3]);assert.deepEqual(summary.terminal,{page:3,next_disabled:true,observed_current_page:3});
   assert.equal(summary.status,"accessible_complete");assert.ok(result.records.every(row=>row.title===""&&row.source_rank===null));
  }finally{await f.close();}
 }
});

test("pagination failures retain progress but never return a partial board as successful or empty",async()=>{
 const scenarios={"failed-page":/未成功/,"missing-page":/响应超时/,"total-drift":/total发生变化/,"duplicate":/重复/,
   "scope-drift":/时间筛选/,"page-drift":/当前页/,"missing-pager":/下一页控件/,"early-disabled":/提前禁用/,"page-cap":/50页/,"cancel-pace":/cancel pagination/,"verification":/安全验证/};
 for(const [scenario,pattern] of Object.entries(scenarios)){
  const f=await fixture(scenario);
  try{
   await assert.rejects(f.collector.collect({purpose:"hotspots",board:1001,hours:24,category:"all"},{signal:f.abort.signal}),pattern);
   assert.equal(f.stats().navigations,1);
   if(scenario==="page-cap"){assert.equal(f.clicks.length,49);assert.equal(f.stats().pageNumber,50);assert.equal(f.collector.status().source_observations[0].pages.length,50);}
   if(["failed-page","missing-page","duplicate","total-drift"].includes(scenario))assert.equal(f.collector.status().source_observations[0].progress.collected_count,2);
   if(["missing-pager","early-disabled","cancel-pace"].includes(scenario))assert.equal(f.clicks.length,0);
  }finally{await f.close();}
 }
});

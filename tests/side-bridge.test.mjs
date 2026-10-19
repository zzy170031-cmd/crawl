import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks, hash } from "../app/tasks.mjs";
import { parseSearchCard } from "../app/search-card.mjs";
import { SideBridge } from "../app/side-bridge.mjs";
import {
  openStore,
  recordsForLatest,
  creativeSourceFor,
} from "../app/store.mjs";
const stamp = () => new Date().toISOString();
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), "crawl-bridge-"));
  const db = new Tasks(folder);
  return { folder, db, bridge: new SideBridge(db, { folder }) };
}
function searchResult(id = "12345678901", game = "率土之滨") {
  return {
    records: [
      {
        kind: "video",
        source_id: id,
        title: "实际观察标题",
        source_url: "https://www.douyin.com/video/" + id,
        observed_url:
          "https://www.douyin.com/search/" + encodeURIComponent(game),
        like_count: 12,
      },
    ],
    failures: [],
    scope: "可见搜索结果，不是完整排名",
    searched_at: stamp(),
  };
}
function envelope(r, result) {
  return { request_id: r.id, task_id: r.task_id, result };
}
function selectedGameResult({keyword="率土之滨",hours=168,sort="likes"}={}) {
  const result=searchResult("12345678901",keyword);
  result.source_endpoint="douyin_visible_search";
  result.observed_scope={site:"douyin",type:"video",keyword:keyword.normalize("NFKC").trim(),hours,sort,
    time_label:{24:"一天内",168:"一周内",4320:"半年内"}[hours],
    sort_label:{likes:"最多点赞",recent:"最新发布",relevance:"综合排序"}[sort],
    selection_evidence:{type:"aria-selected",time:"aria-checked",sort:"checked"}};
  result.records[0].source_endpoint="douyin_visible_search";
  result.records[0].observed_url+="?type=video";
  const card={source_id:"12345678901",text:"00:30\n12\n实际观察标题\n@实际作者\n1小时前"};
  result.records[0]={...parseSearchCard({url:`https://www.douyin.com/video/${card.source_id}`,text:card.text},result.records[0].observed_url,result.searched_at),source_endpoint:"douyin_visible_search"};
  const before=[{...card,source_id:"12345678902"}],after=[card];
  result.result_update={method:"changed-visible-cards-and-stable-scope",before_cards:before,after_cards:after,
    before_fingerprint:hash(before),after_fingerprint:hash(after),changed_identity_count:2,card_count:1,stable_observations:3,
    transitions:[{group:"sort",from:sort === "relevance" ? "最多点赞" : "综合排序",to:result.observed_scope.sort_label}]};
  result.collection_batches=[{cards:after,scope:structuredClone(result.observed_scope),observed_at:result.searched_at}];
  result.excluded_records=[];
  return result;
}
function rehashGameUpdate(value) {
  const update=value.result_update,before=new Set(update.before_cards.map(card=>card.source_id)),after=new Set(update.after_cards.map(card=>card.source_id));
  update.before_fingerprint=hash(update.before_cards);update.after_fingerprint=hash(update.after_cards);
  update.changed_identity_count=[...before].filter(id=>!after.has(id)).length+[...after].filter(id=>!before.has(id)).length;
  update.card_count=update.after_cards.length;
}
function parseEvidenceCard(card,value,batch=value.collection_batches.at(-1)) {
  return {...parseSearchCard({url:`https://www.douyin.com/video/${card.source_id}`,text:card.text},
    `https://www.douyin.com/search/${encodeURIComponent(value.observed_scope.keyword)}?type=video`,batch.observed_at),source_endpoint:"douyin_visible_search"};
}
test("真实分组选中样式仍须有列表代际证据，ARIA路径也不能跳过更新核验",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168});
    const good=selectedGameResult();
    good.observed_scope.selection_evidence={type:"video-url-and-links",sort:"observed-group-class",time:"observed-group-class"};
    good.collection_batches[0].scope=structuredClone(good.observed_scope);
    const result=bridge.validate(r,good);
    assert.deepEqual(result.result_update,good.result_update);assert.deepEqual(result.collection_batches,good.collection_batches);
    for(const mutate of [
      x=>delete x.result_update,x=>x.result_update.method="network-confirmed",x=>x.result_update.stable_observations=2,
      x=>x.result_update.stable_observations="3",x=>x.result_update.before_fingerprint="a".repeat(64),
      x=>x.result_update.after_fingerprint="b".repeat(64),x=>x.result_update.changed_identity_count=1,
      x=>x.result_update.card_count=2,x=>x.result_update.transitions=[],
      x=>x.result_update.transitions[0].group="unknown",x=>x.result_update.transitions[0].from="最多点赞",
      x=>x.result_update.transitions[0].to="最新发布",x=>x.result_update.transitions.push({...x.result_update.transitions[0]}),
      x=>{x.result_update.before_cards=structuredClone(x.result_update.after_cards);rehashGameUpdate(x);},
      x=>{x.result_update.before_cards=[{...x.result_update.after_cards[0],text:"文字变了身份没变"}];rehashGameUpdate(x);},
      x=>{x.result_update.after_cards.push({...x.result_update.after_cards[0]});rehashGameUpdate(x);},
    ]){const value=selectedGameResult();mutate(value);assert.throws(()=>bridge.validate(r,value));}
  }finally{db.close();}
});
test("滚动卡片批次必须同范围且完整归属；同ID整行采用最后观察，不拼接旧字段",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168});
    const good=selectedGameResult(),first=good.collection_batches[0].cards[0];
    const updated={...first,text:first.text.replace("\n12\n","\n13\n")};
    const second={...first,source_id:"12345678903"};
    good.collection_batches.push({cards:[updated,second],scope:structuredClone(good.observed_scope),observed_at:good.searched_at});
    good.records=[parseEvidenceCard(updated,good),parseEvidenceCard(second,good)];
    assert.equal(bridge.validate(r,good).records[0].like_count,13);
    for(const mutate of [
      x=>x.records[0].like_count=12,x=>x.records[0].title="未在原卡的标题",x=>x.records[0].published_text="今天",
      x=>x.records.push({...x.records[0]}),x=>x.records.pop(),x=>delete x.collection_batches,
      x=>x.collection_batches[1].scope.hours=24,x=>x.collection_batches[1].scope.selection_evidence.time="checked",
      x=>x.collection_batches[1].observed_at="2099-01-01T00:00:00Z",x=>x.collection_batches[1].observed_at="2000-01-01T00:00:00Z",
      x=>x.collection_batches[0].cards[0].text="不能解析原卡",x=>x.collection_batches.push(...Array.from({length:9},()=>structuredClone(x.collection_batches[1]))),
    ]){const value=structuredClone(good);mutate(value);assert.throws(()=>bridge.validate(r,value));}
    const outside=selectedGameResult();outside.collection_batches[0].cards[0].text=first.text.replace("1小时前","1年前");
    rehashGameUpdate(outside);outside.records=[parseEvidenceCard(outside.collection_batches[0].cards[0],outside)];
    assert.throws(()=>bridge.validate(r,outside),/超出/);
  }finally{db.close();}
});
test("新请求不能重贴旧批次相对日期证据，行采集时间必须来自最后对应批次",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168});
    const old=selectedGameResult();
    old.searched_at="2000-01-01T00:00:00Z";
    old.collection_batches[0].observed_at=old.searched_at;
    old.records[0].collected_at=old.searched_at;
    assert.throws(()=>bridge.validate(r,old),/批次时间/);
    const early=selectedGameResult();
    early.collection_batches[0].observed_at=new Date(Date.parse(r.created_at)-1).toISOString();
    early.records[0].collected_at=early.collection_batches[0].observed_at;
    assert.throws(()=>bridge.validate(r,early),/批次时间/);
    const wrongRow=selectedGameResult();wrongRow.records[0].collected_at="2000-01-01T00:00:00Z";
    assert.throws(()=>bridge.validate(r,wrongRow),/最后一次/);
    const future=selectedGameResult();future.searched_at=new Date(Date.now()+6*60000).toISOString();
    assert.throws(()=>bridge.validate(r,future),/未来/);
    const exact=selectedGameResult();exact.searched_at=r.created_at;
    exact.collection_batches[0].observed_at=r.created_at;exact.records[0].collected_at=r.created_at;
    assert.equal(bridge.validate(r,exact).scope_verification,"source_selected");
  }finally{db.close();}
});
test("采样上限排除必须已输出30条且余项日期明确在范围内，不隐去卡片",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168});
    const value=selectedGameResult(),base=value.result_update.after_cards[0];
    const cards=Array.from({length:31},(_,i)=>({...base,source_id:String(10000000000+i)}));
    value.result_update.after_cards=cards;value.collection_batches[0].cards=cards;rehashGameUpdate(value);
    value.records=cards.slice(0,30).map(card=>parseEvidenceCard(card,value));
    value.excluded_records=[{source_id:cards[30].source_id,published_text:"1小时前",publication_precision:"relative",reason:"sample_limit"}];
    assert.equal(bridge.validate(r,value).records.length,30);
    const tooFew=structuredClone(value);tooFew.records.pop();assert.throws(()=>bridge.validate(r,tooFew),/排除/);
    const unknownReason=structuredClone(value);unknownReason.excluded_records[0].reason="publication_unknown";
    assert.throws(()=>bridge.validate(r,unknownReason),/排除/);
    const hidden=structuredClone(value);hidden.excluded_records=[];assert.throws(()=>bridge.validate(r,hidden),/未交代/);
  }finally{db.close();}
});
test("新游戏来源必须保留与请求一致的实际类型排序时间选择证据，入库回读不丢失",async()=>{
  const {db,bridge}=await setup();const store=openStore(":memory:");
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168,sort:"likes"});
    const result=bridge.fulfill(r.id,envelope(r,selectedGameResult())).result;
    assert.equal(result.scope_verification,"source_selected");
    assert.equal(result.applied_hours,168);assert.equal(result.applied_sort,"likes");
    assert.deepEqual(result.observed_scope,selectedGameResult().observed_scope);
    store.import(result);const row=recordsForLatest(store.all())[0];
    assert.equal(row.scope_verification,"source_selected");assert.equal(row.applied_hours,168);assert.equal(row.applied_sort,"likes");
    assert.deepEqual(store.all()[0].data.observed_scope,result.observed_scope);
    for(const [hours,sort] of [[24,"recent"],[168,"relevance"]]) {
      const req=bridge.request("search",{purpose:"game-learning",keyword:"率土之滨",hours,sort});
      assert.equal(bridge.validate(req,selectedGameResult({hours,sort})).applied_sort,sort);
    }
  }finally{store.close();db.close();}
});
test("游戏来源拒绝默认搜索伪装指定时间排序、错误选择证据和非视频页面",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168,sort:"likes"});
    const mutations=[
      x=>delete x.observed_scope,x=>x.observed_scope=null,x=>x.observed_scope.site="douhot",
      x=>x.observed_scope.type="user",x=>x.observed_scope.keyword="另一个游戏",x=>x.observed_scope.hours=24,
      x=>x.observed_scope.hours="168",x=>x.observed_scope.sort="relevance",x=>x.observed_scope.time_label="不限",
      x=>x.observed_scope.sort_label="综合排序",x=>delete x.observed_scope.selection_evidence.type,
      x=>x.observed_scope.selection_evidence.time="class-active",x=>x.observed_scope.selection_evidence.sort=true,
      x=>x.source_endpoint="douyin-visible-search",x=>x.records[0].source_endpoint="other",
      x=>x.records[0].observed_url=x.records[0].observed_url.replace("?type=video",""),
      x=>x.records[0].observed_url=x.records[0].observed_url.replace("type=video","type=user"),
      x=>x.records[0].observed_url+="&type=video",x=>x.records[0].observed_url=x.records[0].observed_url.replace("www.douyin.com","www.douyin.com:444"),
    ];
    for(const mutate of mutations){const result=selectedGameResult();mutate(result);assert.throws(()=>bridge.validate(r,result));}
    for(const hours of [1,72,4320]) {
      const req=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours});
      assert.throws(()=>bridge.validate(req,selectedGameResult({hours})),/observed_scope/);
    }
    const markerOnly=searchResult();markerOnly.records[0].source_endpoint="douyin_visible_search";
    assert.throws(()=>bridge.validate(r,markerOnly),/observed_scope/);
  }finally{db.close();}
});
test("空的新游戏结果仍要证明范围；旧无marker观察仅兼容为未核验而不复制请求范围",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"game-research",keyword:"率土之滨",hours:168,sort:"likes"});
    const empty=selectedGameResult();empty.records=[];
    empty.result_update.after_cards[0].text="00:30\n12\n实际观察标题\n@实际作者";
    empty.result_update.after_fingerprint=hash(empty.result_update.after_cards);
    empty.excluded_records=[{source_id:"12345678901",published_text:null,publication_precision:"unknown",reason:"publication_unknown"}];
    assert.throws(()=>bridge.validate(r,empty),/不能以日期未知/);
    delete empty.observed_scope;
    assert.throws(()=>bridge.validate(r,empty),/observed_scope/);
    const legacy=searchResult();legacy.scope_verification="source_selected";legacy.applied_hours=168;legacy.applied_sort="likes";
    legacy.records[0].scope_verification="source_selected";
    const result=bridge.validate(r,legacy);
    assert.equal(result.scope_verification,"unverified");assert.equal(result.applied_hours,null);assert.equal(result.applied_sort,null);
    assert.equal(result.records[0].scope_verification,"unverified");assert.equal(result.records[0].applied_hours,null);
    assert.equal(result.records[0].date_window,0);assert.equal(result.observed_scope,undefined);
    legacy.records=[];assert.equal(bridge.validate(r,legacy).scope_verification,"unverified");
  }finally{db.close();}
});

test("bridge accepts only exact source error codes and preserves persisted legacy error identity", async () => {
  const {db, bridge} = await setup();
  try {
    for (const code of ["VERIFICATION_REQUIRED", "ACCESS_RESTRICTED", "SOURCE_TIMEOUT", "SOURCE_RESPONSE_TIMEOUT", "OPERATION_CLEANUP_FAILED", "CLOSE_TIMEOUT"]) {
      const r = bridge.request("search", {purpose:"game-research",keyword:"率土之滨"});
      const failed = bridge.fulfill(r.id, {request_id:r.id,task_id:r.task_id,error:{code,message:"来源明确失败"}});
      assert.equal(failed.error_code, code);
      assert.equal(failed.error, code + ": 来源明确失败");
      await assert.rejects(bridge.wait(failed), {code});
    }
    for (const code of ["UNTRUSTED", "VERIFICATION_REQUIRED: injected", "verification_required", 1, {toString:()=>"SOURCE_FAILED"}]) {
      const r = bridge.request("search", {purpose:"game-research",keyword:"率土之滨"});
      assert.throws(()=>bridge.fulfill(r.id, {request_id:r.id,task_id:r.task_id,error:{code,message:"no"}}), /错误分类无效/);
      assert.equal(bridge.get(r.id).state, "pending");
      bridge.update(r.id,"cancelled");
    }
    const r = bridge.request("search", {purpose:"game-research",keyword:"率土之滨"});
    for (const [message, code] of [["LOGIN_REQUIRED: VERIFICATION_REQUIRED: 旧格式", "LOGIN_REQUIRED"], ["SOURCE_FAILED: SOURCE_TIMEOUT: 旧格式", "SOURCE_FAILED"], ["未知旧错误", null], ["UNTRUSTED: 旧错误", null]]) {
      const failed = bridge.update(r.id,"failed",null,message);
      assert.equal(failed.error_code, code);
      await assert.rejects(bridge.wait(failed), {code:code || "BRIDGE_FAILED"});
    }
  } finally { db.close(); }
});
function pageResponseResult(change = {}) {
  const result = searchResult();
  result.observed_scope = {boards:[1002],hours:24,category:"all"};
  result.records[0] = {...result.records[0],title:"",author:"",
    observed_url:"https://douhot.douyin.com/square/hotspot?active_tab=hotspot_video&sub_type=1002&date_window=24",
    source_endpoint:"douhot-page-response",sub_type:1002,date_window:24,
    page:2,position_in_response:7,source_rank:null,score:123.456,play_count:null,like_count:987654,
    metric_precision:"observed",...change};
  return result;
}
function paginatedResult({boards=[1002],pages=34,count=26,total=1000}={}) {
  const result=pageResponseResult();
  const base=result.records[0];
  result.records=[];
  result.observed_scope.boards=boards;
  result.pagination={max_pages_per_board:50,max_rows_per_board:1500,boards:boards.map(board=>{
    for(let page=1;page<=pages;page++) for(let i=0;i<count;i++) result.records.push({...base,
      source_id:String(10000000000+(page-1)*count+i),source_url:`https://www.douyin.com/video/${10000000000+(page-1)*count+i}`,
      sub_type:board,page,position_in_response:i+1});
    return {board,hours:24,category:"all",pages:Array.from({length:pages},(_,i)=>({page:i+1,page_size:30,total,actual_count:count})),
      collected_count:pages*count,metadata_total:total,metadata_total_difference:total-pages*count,status:"accessible_complete",
      terminal:{page:pages,next_disabled:true,observed_current_page:pages}};
  })};
  return result;
}
test("有完整分页证据才能突破200条；34页26条差额原样入库，跨榜同视频不丢来源",async()=>{
  const {db,bridge}=await setup();const store=openStore(":memory:");
  try {
    const r=bridge.request("search",{purpose:"hotspots",board:1002,hours:24,category:"all"});
    const input=paginatedResult();
    const result=bridge.fulfill(r.id,envelope(r,input)).result;
    assert.equal(result.records.length,884);
    assert.equal(result.pagination.boards[0].metadata_total_difference,116);
    assert.equal(result.records.at(-1).page,34);
    assert.equal(result.records.at(-1).position_in_response,26);
    store.import(result);
    assert.deepEqual(store.all()[0].data.pagination,result.pagination);
    assert.equal(recordsForLatest(store.all()).length,884);
    const all=bridge.request("search",{purpose:"hotspots",hours:24,category:"all"});
    const full=bridge.validate(all,paginatedResult({boards:[1001,1002,1003,1004,1005],pages:50,count:30,total:1500}));
    assert.equal(full.records.length,7500);
    assert.equal(full.records[0].source_id,full.records[1500].source_id);
    const tooMany=paginatedResult({boards:[1001,1002,1003,1004,1005],pages:50,count:30,total:1500});
    tooMany.records.push({...tooMany.records[0]});
    assert.throws(()=>bridge.validate(all,tooMany),/结构/);
  }finally{store.close();db.close();}
});
test("旧来源与游戏仍限200；伪造分页、漏页、错scope、缺终点及重复ID均拒绝",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"hotspots",board:1002,hours:24,category:"all"});
    const old=paginatedResult();delete old.pagination;
    assert.throws(()=>bridge.validate(r,old),/结构/);
    const game=bridge.request("search",{purpose:"game-research",keyword:"率土之滨"});
    assert.throws(()=>bridge.validate(game,paginatedResult()),/结构/);
    const mutate=[
      x=>x.pagination=null,x=>x.pagination.max_pages_per_board=51,x=>x.pagination.max_rows_per_board=2000,
      x=>x.pagination.boards=[],x=>x.pagination.boards.push(structuredClone(x.pagination.boards[0])),
      x=>x.pagination.boards[0].board=1001,x=>x.pagination.boards[0].hours=72,x=>x.pagination.boards[0].category="605",
      x=>x.pagination.boards[0].status="partial",x=>x.pagination.boards[0].pages.shift(),
      x=>x.pagination.boards[0].pages[1].page=3,x=>x.pagination.boards[0].pages[1].page_size=29,
      x=>x.pagination.boards[0].pages[1].total=999,x=>x.pagination.boards[0].pages[1].actual_count=25,
      x=>x.pagination.boards[0].pages[1].actual_count="26",x=>x.pagination.boards[0].collected_count++,
      x=>x.pagination.boards[0].metadata_total=999,x=>x.pagination.boards[0].metadata_total_difference=0,
      x=>x.pagination.boards[0].terminal.next_disabled=false,x=>x.pagination.boards[0].terminal.next_disabled=null,
      x=>x.pagination.boards[0].terminal.observed_current_page=1,x=>delete x.pagination.boards[0].terminal,
      x=>x.records[0].page=3,x=>x.records[0].position_in_response=2,x=>x.records.pop(),
      x=>{x.records[26].source_id=x.records[0].source_id;x.records[26].source_url=x.records[0].source_url;},
      x=>{x.records[0].source_endpoint="douhot-visible-page";x.records[0].title="legacy";},
    ];
    for(const change of mutate){const value=paginatedResult({pages:2,total:60});change(value);assert.throws(()=>bridge.validate(r,value));}
    assert.equal(bridge.validate(r,paginatedResult({pages:2,total:60})).records.length,52);
    assert.throws(()=>bridge.validate(r,paginatedResult({pages:1,total:1000})),/终点/);
    assert.throws(()=>bridge.validate(r,paginatedResult({pages:3,count:10,total:60})),/终点/);
    assert.throws(()=>bridge.validate(r,paginatedResult({pages:51,count:1})),/连续页/);
    assert.throws(()=>bridge.validate(r,paginatedResult({pages:50,count:31,total:2000})),/行数/);
    assert.throws(()=>bridge.validate(r,paginatedResult({pages:2,count:26,total:30})),/合计/);
    const empty=bridge.validate(r,paginatedResult({pages:1,count:0,total:0}));
    assert.equal(empty.records.length,0);assert.equal(empty.pagination.boards[0].terminal.next_disabled,true);
  }finally{db.close();}
});
test("热点页面响应保留真实空标题作者、原始指标、页码及来源并可入库回读",async()=>{
  const {db,bridge}=await setup();const store=openStore(":memory:");
  try {
    const r=bridge.request("search",{purpose:"hotspots",board:1002,hours:24,category:"all"});
    const validated=bridge.fulfill(r.id,envelope(r,pageResponseResult())).result;
    store.import(validated);
    const row=recordsForLatest(store.all())[0];
    for(const [key,value] of Object.entries({title:"",author:"",page:2,position_in_response:7,
      source_endpoint:"douhot-page-response",source_rank:null,score:123.456,play_count:null,
      like_count:987654,metric_precision:"observed",collection_request_id:r.id})) assert.equal(row[key],value,key);
    assert.equal(bridge.get(r.id).result.records[0].title,"");
  } finally {store.close();db.close();}
});
test("页面响应空字段仅对严格热点来源开放，游戏与旧来源仍拒绝空标题",async()=>{
  const {db,bridge}=await setup();
  try {
    const hot=bridge.request("search",{purpose:"hotspots",board:1002,hours:24,category:"all"});
    for(const change of [{source_endpoint:"douhot-visible-page"},{source_endpoint:undefined},
      {kind:"topic"},{observed_url:"https://www.douyin.com/search/test"},
      {observed_url:"https://douhot.douyin.com:444/square/hotspot"},
      {observed_url:"https://douhot.douyin.com/video/detail"},{title:null},{author:null},
      {title:undefined},{author:undefined},{title:12},{author:12}])
      assert.throws(()=>bridge.validate(hot,pageResponseResult(change)));
    const game=bridge.request("search",{purpose:"game-research",keyword:"率土之滨"});
    const emptyGame=searchResult();emptyGame.records[0].title="";
    assert.throws(()=>bridge.validate(game,emptyGame),/标题/);
    assert.throws(()=>bridge.validate(game,pageResponseResult()),/来源标记/);
  } finally {db.close();}
});
test("页面响应页码位置和指标严格按数字及显式null核验，不猜排名或舍入精度",async()=>{
  const {db,bridge}=await setup();
  try {
    const r=bridge.request("search",{purpose:"hotspots",board:1002,hours:24,category:"all"});
    for(const field of ["page","position_in_response"])
      for(const value of [undefined,null,0,-1,1.5,"2",Infinity,Number.MAX_SAFE_INTEGER+1])
        assert.throws(()=>bridge.validate(r,pageResponseResult({[field]:value})),/页码|位置/);
    assert.throws(()=>bridge.validate(r,pageResponseResult({position_in_response:1001})),/位置/);
    for(const field of ["score","play_count","like_count"])
      for(const value of [undefined,"0",-1,Infinity,NaN])
        assert.throws(()=>bridge.validate(r,pageResponseResult({[field]:value})),/指标/);
    for(const change of [{source_rank:1},{source_rank:undefined},{metric_precision:"rounded"},{metric_precision:undefined}])
      assert.throws(()=>bridge.validate(r,pageResponseResult(change)),/排名|指标/);
    const row=bridge.validate(r,pageResponseResult({title:"  源标题  ",author:"  源作者  ",like_count:0,like_display:"10万"})).records[0];
    assert.equal(row.title,"  源标题  ");assert.equal(row.author,"  源作者  ");assert.equal(row.like_count,0);
    assert.equal(row.like_display,null);
  } finally {db.close();}
});
test('same-millisecond older failure cannot shadow the newer pending request during idempotent search creation',async()=>{
 const {db,bridge}=await setup();
 try {
  const input={purpose:'game-research',keyword:'率土之滨'};
  const old=bridge.request('search',input);bridge.update(old.id,'failed',null,'验证失败');
  const latest=bridge.request('search',input);
  db.db.prepare('UPDATE bridge_requests SET created_at=? WHERE id IN (?,?)').run(stamp(),old.id,latest.id);
  const repeated=bridge.request('search',input,{reuseWithinMs:60000});
  assert.equal(repeated.id,latest.id);assert.equal(repeated.state,'pending');
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM bridge_requests').get().n,2);
 }finally{db.close();}
});
test("public cooldown reuses exact recent success without retimestamping and never crosses scope or task", async () => {
  const { db, bridge } = await setup();
  try {
    const input = {
      keyword: "率土之滨",
      purpose: "game-research",
      hours: 168,
      sort: "likes",
    };
    const original = bridge.request("search", input);
    const completed = bridge.fulfill(
      original.id,
      envelope(original, searchResult()),
    );
    const again = bridge.request("search", input, { reuseWithinMs: 60000 });
    assert.deepEqual(again, completed);
    for (const change of [
      { keyword: "王者荣耀" },
      { hours: 24 },
      { sort: "recent" },
    ])
      assert.notEqual(
        bridge.request(
          "search",
          { ...input, ...change },
          { reuseWithinMs: 60000 },
        ).id,
        original.id,
      );
    const task = db.create("learn", { game: "率土之滨" });
    assert.notEqual(
      bridge.request("search", input, { taskId: task.id, reuseWithinMs: 60000 })
        .id,
      original.id,
    );
    db.db
      .prepare("UPDATE bridge_requests SET updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 61000).toISOString(), original.id);
    assert.notEqual(
      bridge.request("search", input, { reuseWithinMs: 60000 }).id,
      original.id,
    );
  } finally {
    db.close();
  }
});
test("持久搜索请求匹配身份，游戏搜索保留真实指标并去除虚构榜单排名", async () => {
  const { folder, db, bridge } = await setup();
  try {
    const r = bridge.request("search", {
      keyword: "率土之滨",
      scope: "game",
      hours: 168,
    });
    assert.equal(
      bridge.request("search", {
        keyword: "率土之滨",
        scope: "game",
        hours: 168,
      }).id,
      r.id,
    );
    const second = new Tasks(folder),
      other = new SideBridge(second, { folder });
    assert.equal(other.get(r.id).state, "pending");
    assert.throws(
      () =>
        bridge.fulfill(r.id, {
          ...envelope(r, searchResult()),
          task_id: "wrong",
        }),
      /不匹配/,
    );
    const done = other.fulfill(r.id, envelope(r, searchResult()));
    assert.equal(done.result.records[0].game, "率土之滨");
    assert.equal(done.result.records[0].score, null);
    assert.equal(done.result.records[0].source_rank, null);
    assert.equal(done.result.records[0].like_count, 12);
    assert.equal(done.result.records[0].sub_type, 0);
    assert.throws(
      () => bridge.fulfill(r.id, envelope(r, searchResult())),
      /失效/,
    );
    second.close();
  } finally {
    db.close();
  }
});
test("取消和过期请求拒绝回填；未知媒体路径不能冒充原片", async () => {
  const { folder, db, bridge } = await setup();
  try {
    const t = db.create("learn", { game: "率土之滨" });
    const r = bridge.request(
      "media",
      { source_id: "12345678901" },
      { taskId: t.id },
    );
    db.cancel(t.id);
    assert.throws(() => bridge.fulfill(r.id, envelope(r, {})), /失效/);
    const exp = bridge.request("web", { game: "另一个游戏" });
    db.db
      .prepare("UPDATE bridge_requests SET expires_at=? WHERE id=?")
      .run("2020-01-01", exp.id);
    assert.throws(
      () => bridge.fulfill(exp.id, envelope(exp, { sources: [] })),
      /失效/,
    );
    const m = bridge.request("media", { source_id: "12345678901" });
    const fake = {
      source_id: "12345678901",
      url: "https://www.douyin.com/video/12345678901",
      source_path: "/tmp/not-managed.mp4",
      title: "原片",
      observed_at: stamp(),
    };
    assert.throws(() => bridge.fulfill(m.id, envelope(m, fake)), /托管目录/);
    const dir = join(folder, "media", "12345678901");
    await mkdir(dir, { recursive: true });
    const out = join(folder, "elsewhere.mp4");
    await writeFile(out, Buffer.alloc(2000));
    await symlink(out, join(dir, "source.mp4"));
    assert.throws(
      () =>
        bridge.fulfill(
          m.id,
          envelope(m, { ...fake, source_path: join(dir, "source.mp4") }),
        ),
      /路径/,
    );
  } finally {
    db.close();
  }
});
test("空搜索也更新独立范围，旧游戏证据留存但不再展示过期结果", async () => {
  const { folder, db, bridge } = await setup();
  const store = openStore(join(folder, "hotspots.sqlite"));
  try {
    const first = bridge.request("search", {
      keyword: "率土之滨",
      scope: "game",
    });
    const a = bridge.fulfill(first.id, envelope(first, searchResult())).result;
    store.import(a);
    const second = bridge.request("search", {
      keyword: "其他游戏",
      scope: "game",
    });
    const b = bridge.fulfill(
      second.id,
      envelope(second, searchResult("12345678902", "其他游戏")),
    ).result;
    store.import(b);
    const refresh = bridge.request("search", {
      keyword: "率土之滨",
      scope: "game",
    });
    const blank = {
      records: [],
      failures: [],
      scope: "本次搜索无结果",
      searched_at: new Date(Date.now() + 50).toISOString(),
    };
    store.import(bridge.fulfill(refresh.id, envelope(refresh, blank)).result);
    assert.equal(store.all().length, 3);
    const rows = recordsForLatest(store.all());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].game, "其他游戏");
  } finally {
    store.close();
    db.close();
  }
});
test("交付必须批准具体目标且登记开始，写入未知不能通过重试产生第二次交付", async () => {
  const { db, bridge } = await setup();
  try {
    const t = db.create("create", {
      game: "率土之滨",
      source: { kind: "video", source_id: "12345678901" },
    });
    const r = bridge.request(
      "delivery",
      {
        game: "率土之滨",
        plan: { text: "draft" },
        evidence: [],
        destination: null,
      },
      { taskId: t.id },
    );
    assert.throws(() => bridge.beginDelivery(r.id), /未批准/);
    assert.throws(
      () => bridge.fulfill(r.id, envelope(r, { status: "completed" })),
      /失效/,
    );
    bridge.approve(r.id, {
      file_id: "file123",
      url: "https://docs.qq.com/sheet/test",
    });
    bridge.beginDelivery(r.id);
    assert.throws(() => bridge.beginDelivery(r.id), /禁止重复/);
    assert.throws(
      () =>
        bridge.fulfill(
          r.id,
          envelope(r, { status: "completed", readback_verified: false }),
        ),
      /回读/,
    );
    const unknown = bridge.fulfill(
      r.id,
      envelope(r, { status: "unknown", message: "网络丢响应，待回读" }),
    );
    assert.equal(unknown.state, "unknown");
    const retried = bridge.request(
      "delivery",
      {
        game: "率土之滨",
        plan: { text: "draft" },
        evidence: [{ read_at: stamp() }],
        destination: null,
      },
      { taskId: t.id },
    );
    assert.equal(retried.id, r.id);
    assert.throws(
      () =>
        bridge.approve(r.id, {
          file_id: "file123",
          url: "https://docs.qq.com/sheet/test",
        }),
      /不可批准/,
    );
  } finally {
    db.close();
  }
});

test("未来观察时间与错误游戏查询不能冒充当前游戏素材", async () => {
  const { db, bridge } = await setup();
  try {
    const r = bridge.request("search", { keyword: "率土之滨", scope: "game" });
    assert.throws(
      () =>
        bridge.fulfill(
          r.id,
          envelope(r, {
            ...searchResult(),
            searched_at: "2036-01-01T00:00:00Z",
          }),
        ),
      /未来/,
    );
    assert.throws(
      () =>
        bridge.fulfill(
          r.id,
          envelope(r, searchResult("12345678901", "其他游戏")),
        ),
      /搜索词不匹配/,
    );
    assert.equal(bridge.get(r.id).state, "pending");
  } finally {
    db.close();
  }
});
test("术语修正须绑定媒体哈希、原始转写与同时间独立OCR", async () => {
  const { db, bridge } = await setup();
  try {
    const r = bridge.request("transcript-review", {
      source_id: "12345678901",
      media_hash: "sha",
      segments: [{ start: 2, end: 5, text: "推荐站法组合" }],
      ocr_readings: [{ time: 3, text: "推荐战法组合" }],
    });
    const result = {
      source_id: "12345678901",
      media_hash: "sha",
      status: "reviewed_with_corrections",
      corrections: [
        {
          segment_index: 0,
          original_text: "推荐站法组合",
          corrected_text: "推荐战法组合",
          frame_time: 3,
          subtitle_text: "战法",
          reason: "同时间画面明确显示战法",
        },
      ],
      uncertainties: [],
    };
    assert.throws(
      () =>
        bridge.fulfill(r.id, envelope(r, { ...result, media_hash: "wrong" })),
      /身份/,
    );
    assert.throws(
      () =>
        bridge.fulfill(
          r.id,
          envelope(r, {
            ...result,
            corrections: [{ ...result.corrections[0], frame_time: 20 }],
          }),
        ),
      /同时间/,
    );
    assert.throws(
      () =>
        bridge.fulfill(
          r.id,
          envelope(r, {
            ...result,
            corrections: [
              { ...result.corrections[0], original_text: "别的台词" },
            ],
          }),
        ),
      /原始/,
    );
    const done = bridge.fulfill(r.id, envelope(r, result));
    assert.equal(done.result.corrections[0].original_text, "推荐站法组合");
    const gap = bridge.request("transcript-review", {
      source_id: "12345678901",
      media_hash: "sha2",
      segments: [],
      ocr_readings: [],
    });
    assert.throws(
      () =>
        bridge.fulfill(
          gap.id,
          envelope(gap, {
            source_id: "12345678901",
            media_hash: "sha2",
            status: "reviewed_no_changes",
            corrections: [],
            uncertainties: ["字幕不清"],
          }),
        ),
      /待复核/,
    );
  } finally {
    db.close();
  }
});

test("学习池与近期热点范围分离，学习最少20目标30的请求不可降级", async () => {
  const { db, bridge } = await setup();
  try {
    const r = bridge.request("search", {
      keyword: "率土之滨",
      purpose: "game-learning",
      hours: 4320,
      minimum_required: 3,
      target: 5,
    });
    assert.equal(r.payload.minimum_required, 20);
    assert.equal(r.payload.target, 30);
    const v = bridge.fulfill(r.id, envelope(r, searchResult())).result;
    assert.equal(v.records[0].collection, "learning");
    assert.equal(v.collection_key, JSON.stringify(["learning", "率土之滨"]));
    assert.throws(
      () =>
        bridge.request("search", {
          keyword: "率土之滨",
          purpose: "hotspots",
          hours: 4320,
        }),
      /时间窗口/,
    );
  } finally {
    db.close();
  }
});

test("未知交付只能通过目标匹配的回读对账恢复，不能重新开始写入", async () => {
  const { db, bridge } = await setup();
  try {
    const r = bridge.request("delivery", {
      plan: { text: "original" },
      destination: null,
    });
    bridge.approve(r.id, {
      file_id: "file123",
      url: "https://docs.qq.com/sheet/test",
    });
    bridge.beginDelivery(r.id);
    bridge.fulfill(
      r.id,
      envelope(r, { status: "unknown", message: "响应中断" }),
    );
    const receipt = {
      status: "completed",
      file_id: "file123",
      sheet_id: "tab1",
      document_url: "https://docs.qq.com/sheet/test?tab=tab1",
      readback_verified: true,
      verified_at: stamp(),
      warnings: [],
    };
    assert.throws(
      () =>
        bridge.reconcileDelivery(
          r.id,
          envelope(r, { ...receipt, file_id: "other" }),
        ),
      /目标/,
    );
    const recovered = bridge.reconcileDelivery(r.id, envelope(r, receipt));
    assert.equal(recovered.state, "fulfilled");
    assert.equal(recovered.result.reconciliation, "readback_only_no_republish");
    assert.throws(() => bridge.beginDelivery(r.id), /禁止重复/);
  } finally {
    db.close();
  }
});

test("同游戏近期列表、学习池和课程快照互不吞并", async () => {
  const { folder, db, bridge } = await setup(),
    store = openStore(join(folder, "hotspots.sqlite"));
  try {
    for (const purpose of ["game-research", "game-learning"]) {
      const r = bridge.request("search", {
        keyword: "率土之滨",
        purpose,
        hours: purpose === "game-learning" ? 4320 : 168,
      });
      store.import(
        bridge.fulfill(
          r.id,
          envelope(
            r,
            searchResult(
              purpose === "game-learning" ? "12345678902" : "12345678901",
            ),
          ),
        ).result,
      );
    }
    const rows = recordsForLatest(store.all());
    assert.equal(rows.length, 2);
    assert.deepEqual(
      new Set(rows.map((r) => r.collection)),
      new Set(["games", "learning"]),
    );
  } finally {
    store.close();
    db.close();
  }
});
test("合法通用热点可联动当前游戏，其他游戏、课程与失效快照不能混入", () => {
  const input = { source_id: "12345678901", kind: "video" },
    base = { ...input, snapshot_id: 3 };
  const sources = [
    { ...base, collection: "courses" },
    { ...base, collection: "games", game: "其他游戏" },
    { ...base, collection: "hotspots", game: null },
  ];
  assert.equal(
    creativeSourceFor(sources, input, "率土之滨").collection,
    "hotspots",
  );
  assert.equal(
    creativeSourceFor(sources.slice(0, 2), input, "率土之滨"),
    undefined,
  );
  assert.equal(
    creativeSourceFor(sources, { ...input, snapshot_id: 2 }, "率土之滨"),
    undefined,
  );
  assert.equal(
    creativeSourceFor(
      [{ ...base, collection: "games", game: "率土之滨" }],
      input,
      "率土之滨",
    ).game,
    "率土之滨",
  );
});
test("新的字幕复核修订不会复用前次fulfilled待核验结果", async () => {
  const { db, bridge } = await setup();
  try {
    const t = db.create("learn", { game: "率土之滨" }),
      payload = {
        source_id: "12345678901",
        media_hash: "sha",
        segments: [],
        ocr_readings: [],
      };
    const old = bridge.request(
      "transcript-review",
      { ...payload, review_revision: "attempt1" },
      { taskId: t.id },
    );
    bridge.fulfill(
      old.id,
      envelope(old, {
        source_id: payload.source_id,
        media_hash: "sha",
        status: "needs_review",
        corrections: [],
        uncertainties: ["画面字幕需补读"],
      }),
    );
    const fresh = bridge.request(
      "transcript-review",
      { ...payload, review_revision: "attempt2" },
      { taskId: t.id },
    );
    assert.notEqual(old.id, fresh.id);
    assert.equal(fresh.state, "pending");
    assert.equal(bridge.get(old.id).result.status, "needs_review");
  } finally {
    db.close();
  }
});

test("任务重试可重新请求网页资料，不永久复用空网页回填", async () => {
  const { db, bridge } = await setup();
  try {
    const t = db.create("learn", { game: "率土之滨" }),
      r = bridge.request("web", { game: "率土之滨" }, { taskId: t.id });
    bridge.fulfill(r.id, envelope(r, { sources: [] }));
    const fresh = bridge.request("web", { game: "率土之滨" }, { taskId: t.id });
    assert.notEqual(fresh.id, r.id);
    assert.equal(fresh.state, "pending");
  } finally {
    db.close();
  }
});

test("相关作品搜索的快照范围不会覆盖真正热点查询", async () => {
  const { db, bridge } = await setup();
  try {
    const r = bridge.request("search", {
      keyword: "主题标题",
      purpose: "related-work",
      target_game: "率土之滨",
      hours: 24,
    });
    const result = bridge.fulfill(
      r.id,
      envelope(r, searchResult("12345678901", "主题标题")),
    ).result;
    assert.equal(
      result.collection_key,
      JSON.stringify(["related", "率土之滨", "主题标题"]),
    );
  } finally {
    db.close();
  }
});

test("近期游戏搜索默认目标30最少20，显式扩大半年仍保留真实范围", async () => {
  const { db, bridge } = await setup();
  try {
    const recent = bridge.request("search", {
      keyword: "率土之滨",
      purpose: "game-research",
      hours: 168,
      minimum_required: 1,
      limit: 5,
    });
    assert.equal(recent.payload.minimum_required, 20);
    assert.equal(recent.payload.limit, 30);
    assert.equal(recent.payload.hours, 168);
    const expanded = bridge.request("search", {
      keyword: "率土之滨",
      purpose: "game-research",
      hours: 4320,
    });
    assert.equal(expanded.payload.hours, 4320);
    const result = bridge.fulfill(
      expanded.id,
      envelope(expanded, {
        ...searchResult(),
        scope: "实际页面筛选近半年，不能称为近7天热点",
      }),
    ).result;
    assert.equal(result.records.length, 1);
    assert.match(result.scope, /近半年/);
  } finally {
    db.close();
  }
});

test("热点行业与时间必须由实际观察确认，不得把旧榜单改写为新范围", async () => {
  const { db, bridge } = await setup();
  try {
    assert.throws(
      () => bridge.request("search", { board: 2001, category: "628" }),
      /行业/,
    );
    assert.throws(
      () => bridge.request("search", { category: "bogus" }),
      /行业/,
    );
    const r = bridge.request("search", {
      board: 1001,
      hours: 72,
      category: "628",
    });
    const observed = searchResult();
    observed.records[0].observed_url =
      "https://douhot.douyin.com/video/detail?video_id=12345678901";
    assert.throws(
      () => bridge.fulfill(r.id, envelope(r, observed)),
      /observed_scope/,
    );
    observed.observed_scope = { boards: [1001], hours: 24, category: "628" };
    assert.throws(() => bridge.fulfill(r.id, envelope(r, observed)), /不匹配/);
    observed.observed_scope = { boards: [1001], hours: 72, category: "all" };
    assert.throws(() => bridge.fulfill(r.id, envelope(r, observed)), /不匹配/);
    observed.observed_scope = { boards: [1002], hours: 72, category: "628" };
    assert.throws(() => bridge.fulfill(r.id, envelope(r, observed)), /不匹配/);
    observed.observed_scope = { boards: [1001], hours: 72, category: "628" };
    observed.records[0].date_window = 24;
    assert.throws(() => bridge.fulfill(r.id, envelope(r, observed)), /不匹配/);
    observed.records[0].date_window = 72;
    observed.records[0].sub_type = 1001;
    const done = bridge.fulfill(r.id, envelope(r, observed));
    assert.deepEqual(done.result.records[0].category_filter, [{ value: 628 }]);
    assert.equal(done.result.records[0].date_window, 72);
    assert.deepEqual(done.result.observed_scope, observed.observed_scope);
  } finally {
    db.close();
  }
});

test("全榜采集只接受已观察的榜单且空结果也需确认筛选范围", async () => {
  const { db, bridge } = await setup();
  try {
    const r = bridge.request("search", {
      board: null,
      hours: 24,
      category: "all",
    });
    const observed = searchResult();
    observed.records[0].observed_url =
      "https://douhot.douyin.com/video/detail?video_id=12345678901";
    observed.observed_scope = { boards: [1001], hours: 24, category: "all" };
    observed.records[0].sub_type = 1002;
    assert.throws(() => bridge.fulfill(r.id, envelope(r, observed)), /不匹配/);
    observed.records = [];
    delete observed.observed_scope;
    assert.throws(
      () => bridge.fulfill(r.id, envelope(r, observed)),
      /observed_scope/,
    );
    observed.observed_scope = { boards: [1001], hours: 24, category: "all" };
    assert.equal(
      bridge.fulfill(r.id, envelope(r, observed)).result.records.length,
      0,
    );
  } finally {
    db.close();
  }
});

test("search batch provenance is assigned only from the internal request identity", async () => {
  const { folder, db, bridge } = await setup(),
    store = openStore(":memory:");
  try {
    const request = bridge.request("search", {
      purpose: "game-research",
      keyword: "率土之滨",
    });
    const result = searchResult();
    result.collection_request_id = "forged-top";
    result.records[0].collection_request_id = "forged-row";
    const done = bridge.fulfill(request.id, envelope(request, result));
    assert.equal(done.result.collection_request_id, request.id);
    assert.equal(done.result.records[0].collection_request_id, request.id);
    store.import(done.result);
    assert.equal(store.all()[0].data.collection_request_id, request.id);
    assert.equal(
      recordsForLatest(store.all())[0].collection_request_id,
      request.id,
    );
    assert.equal(JSON.stringify(done).includes("forged-"), false);
  } finally {
    store.close();
    db.close();
  }
});

test("latest scope lookup searches all UI requests, not the most recent twenty, and never returns task-owned requests", async () => {
  const { db, bridge } = await setup();
  try {
    const old = bridge.request("search", {
      purpose: "game-research",
      keyword: "率土之滨",
      hours: 168,
    });
    bridge.update(old.id, "fulfilled", { records: [] });
    for (let i = 0; i < 30; i++) {
      const other = bridge.request("search", {
        purpose: "game-research",
        keyword: "其他游戏" + i,
      });
      bridge.update(other.id, "failed", null, "受控失败");
    }
    const task = bridge.request(
      "search",
      { purpose: "game-research", keyword: "率土之滨" },
      { taskId: "private-task" },
    );
    assert.equal(
      bridge.latestSearchForScope({
        purpose: "game-research",
        keyword: "率土之滨",
      }).id,
      old.id,
    );
    assert.equal(
      bridge.latestSearchForScope({
        purpose: "game-research",
        keyword: "不存在",
      }),
      null,
    );
    const next = bridge.request("search", {
      purpose: "game-research",
      keyword: "率土之滨",
      hours: 4320,
      sort: "recent",
    });
    // Same creation millisecond must still pick the newest insertion.
    db.db
      .prepare("UPDATE bridge_requests SET created_at=? WHERE id IN (?,?)")
      .run("2026-10-01T00:00:00.000Z", old.id, next.id);
    const publicRequest = bridge.latestSearchForScope({
      purpose: "game-research",
      keyword: "率土之滨",
    });
    assert.equal(publicRequest.id, next.id);
    assert.equal(publicRequest.task_id, null);
    assert.equal(Object.hasOwn(publicRequest, "request_key"), false);
    assert.notEqual(publicRequest.id, task.id);
  } finally {
    db.close();
  }
});

test("latest hotspot lookup binds exact board/null, time, category and keyword without mutating expired state", async () => {
  const { db, bridge } = await setup();
  try {
    const scopes = [
      {
        purpose: "hotspots",
        board: null,
        hours: 24,
        category: "all",
        keyword: "",
      },
      {
        purpose: "hotspots",
        board: 1001,
        hours: 24,
        category: "all",
        keyword: "",
      },
      {
        purpose: "hotspots",
        board: 1001,
        hours: 72,
        category: "all",
        keyword: "",
      },
      {
        purpose: "hotspots",
        board: 1001,
        hours: 72,
        category: "628",
        keyword: "",
      },
      {
        purpose: "hotspots",
        board: 1001,
        hours: 72,
        category: "628/62804",
        keyword: "",
      },
      {
        purpose: "hotspots",
        board: 1001,
        hours: 72,
        category: "628/62804",
        keyword: "' OR 1=1 --",
      },
    ];
    const requests = scopes.map((scope) => bridge.request("search", scope));
    for (let i = 0; i < scopes.length; i++)
      assert.equal(bridge.latestSearchForScope(scopes[i]).id, requests[i].id);
    db.db
      .prepare("UPDATE bridge_requests SET expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00Z", requests[0].id);
    assert.equal(bridge.latestSearchForScope(scopes[0]).state, "pending");
    assert.equal(bridge.get(requests[0].id).state, "pending");
    assert.equal(
      bridge.latestSearchForScope({ ...scopes[0], keyword: "no such scope" }),
      null,
    );
    assert.throws(
      () =>
        bridge.latestSearchForScope({
          purpose: "game-learning",
          keyword: "率土之滨",
        }),
      /仅支持/,
    );
  } finally {
    db.close();
  }
});

test("missing internal search request id stays null instead of accepting fabricated provenance", async () => {
  const { db, bridge } = await setup();
  try {
    const request = bridge.request("search", {
      purpose: "game-research",
      keyword: "率土之滨",
    });
    const result = searchResult();
    result.collection_request_id = "forged";
    result.records[0].collection_request_id = "forged";
    const validated = bridge.validate({ ...request, id: undefined }, result);
    assert.equal(validated.collection_request_id, null);
    assert.equal(validated.records[0].collection_request_id, null);
    assert.equal(
      bridge.latestSearchForScope({
        purpose: "courses",
        keyword: "抖音创作公开课",
      }),
      null,
    );
  } finally {
    db.close();
  }
});

test("search publication evidence survives validation and snapshot storage without inventing exact instants", async () => {
  const { db, bridge } = await setup(),
    store = openStore(":memory:");
  try {
    const request = bridge.request("search", {
        purpose: "game-research",
        keyword: "率土之滨",
      }),
      result = searchResult();
    Object.assign(result.records[0], {
      author: "公开作者",
      published_text: "1天前",
      publication_precision: "relative",
      published_date: null,
      published_at: "2026-10-18T00:00:00Z",
    });
    const fulfilled = bridge.fulfill(request.id, envelope(request, result));
    store.import(fulfilled.result);
    const row = recordsForLatest(store.all())[0];
    assert.equal(row.author, "公开作者");
    assert.equal(row.published_text, "1天前");
    assert.equal(row.publication_precision, "relative");
    assert.equal(row.published_date, null);
    assert.equal(Object.hasOwn(row, "published_at"), false);
    const other = bridge.request("search", {
        purpose: "game-research",
        keyword: "率土之滨",
      }),
      dated = searchResult();
    Object.assign(dated.records[0], {
      published_text: "2026-10-19",
      publication_precision: "date",
      published_date: "2026-10-19",
    });
    assert.equal(
      bridge.fulfill(other.id, envelope(other, dated)).result.records[0]
        .published_date,
      "2026-10-19",
    );
  } finally {
    store.close();
    db.close();
  }
});

test("search bridge rejects invalid or fabricated publication fields", async () => {
  const { db, bridge } = await setup();
  try {
    const request = bridge.request("search", {
      purpose: "game-research",
      keyword: "率土之滨",
    });
    for (const fields of [
      { published_text: 123 },
      { published_text: "1天前", published_date: "2026-10-18" },
      { published_text: "2026-02-30", publication_precision: "date" },
      { published_text: "2026-10-19", publication_precision: "timestamp" },
    ]) {
      const result = searchResult();
      Object.assign(result.records[0], fields);
      assert.throws(() => bridge.validate(request, result), {
        code: "BRIDGE_INVALID",
      });
    }
  } finally {
    db.close();
  }
});

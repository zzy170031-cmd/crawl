import test from "node:test";
import assert from "node:assert/strict";
import { observedRankingPageReceipts } from "../app/ranking-page-receipts.mjs";

const target={board:1001,hours:24,category:"all"};
const receipt=({page=1,size=30,total=1000,count=25,request={},responsePage={},status=200,code=0,body}={})=>({
  url:"https://douhot.douyin.com/douhot/v1/material/video_billboard",status,
  request:{sub_type:1001,date_window:24,page,page_size:size,...request},
  body:body ?? {code,data:{page:{page,page_size:size,total,...responsePage},objs:Array.from({length:count},(_,i)=>({item_id:String(12345678901+i)}))}},
});
const inspect=(receipts,page=1,scope=target,children=null)=>observedRankingPageReceipts(receipts,scope,children,page);

test("preserves the observed 25/30/1000 difference without deriving last-page or completeness",()=>{
  const original=receipt();const result=inspect([original]);
  assert.deepEqual(result.metadata,{page:1,page_size:30,total:1000});
  assert.equal(result.actual_count,25);assert.equal(result.receipts[0],original);
  assert.deepEqual(Object.keys(result).sort(),["actual_count","metadata","receipts"]);
  assert.equal(original.body.data.objs.length,25);
});

test("accepts only the exact requested page and full scope, ignoring receipts of other pages or industries",()=>{
  const wanted=receipt({page:2});
  const otherPage=receipt({page:1,responsePage:{page:2}});
  const wrongHours=receipt({page:2,request:{date_window:72}});
  const wrongBoard=receipt({page:2,request:{sub_type:1002}});
  const wrongIndustry=receipt({page:2,request:{tags:[{value:608,children:[{value:60801}]}]}});
  assert.deepEqual(inspect([otherPage,wrongHours,wrongBoard,wrongIndustry,wanted],2).receipts,[wanted]);
  for(const values of [[],[otherPage],[wrongHours],[wrongBoard],[wrongIndustry],[receipt({request:{page:"1"}})]])
    assert.throws(()=>inspect(values,2),/未取得/);
  assert.throws(()=>inspect([receipt({request:{page:"1"}})],1),/未取得/);
  const tagged=receipt({request:{tags:[{value:608,children:[{value:60801}]}]}});
  assert.equal(inspect([tagged],1,{...target,category:"608/60801"},["60801"]).actual_count,25);
  assert.throws(()=>inspect([tagged],1,{...target,category:"608/60802"},["60802"]),/未取得/);
});

test("requires exact successful schema and matching positive integer request/response pagination",()=>{
  for(const changed of [
    {status:403},{code:1},{body:{code:0,data:{page_num:1,objs:[]}}},
    {responsePage:{page:2}},{responsePage:{page:"1"}},{responsePage:{page:0}},
    {request:{page_size:"30"}},{request:{page_size:0}},{responsePage:{page_size:20}},
    {responsePage:{page_size:30.5}},{size:1001},{responsePage:{total:"1000"}},
    {responsePage:{total:-1}},{responsePage:{total:1.2}},{responsePage:{total:Infinity}},
    {responsePage:{total:Number.MAX_SAFE_INTEGER+1}},{count:31},{total:20},
  ]) assert.throws(()=>inspect([receipt(changed)]));
  for(const value of [0,-1,1.5,"1",Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>inspect([receipt()],value),/正整数/);
  assert.throws(()=>inspect(null),/集合/);
  assert.throws(()=>inspect(Array.from({length:65},()=>receipt())),/上限/);
});

test("same-round same-page metadata or count conflicts fail closed, while identical metadata receipts remain available for identity validation",()=>{
  const a=receipt(),b=receipt();
  assert.equal(inspect([a,b]).receipts.length,2);
  for(const second of [receipt({total:999}),receipt({size:29}),receipt({count:24})])
    assert.throws(()=>inspect([a,second]),/冲突|变化/);
  assert.throws(()=>inspect([a,receipt({code:1})]),/未成功/);
  // Different video identities are deliberately left for the existing strict
  // identity helper; this helper proves only page metadata and actual count.
  b.body.data.objs[0].item_id="99999999999";
  assert.equal(inspect([a,b]).receipts.length,2);
});

test("an empty observed page is evidence only of that page, not proof of the end of the board",()=>{
  const empty=inspect([receipt({page:2,count:0})],2);
  assert.equal(empty.actual_count,0);assert.equal(empty.metadata.total,1000);
  assert.deepEqual(Object.keys(empty).sort(),["actual_count","metadata","receipts"]);
  assert.equal(inspect([receipt({total:0,count:0})]).actual_count,0);
  assert.throws(()=>inspect([receipt({page:2,total:0,count:0})],2),/不一致/);
});

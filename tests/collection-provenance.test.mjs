import test from "node:test";
import assert from "node:assert/strict";
import { collectionProvenance } from "../app/collection-provenance.mjs";
const request = (state, result = null) => ({
  id: "new-request", state, result, error: state === "failed" ? "source unavailable" : null,
  payload: {purpose:"hotspots",keyword:"",board:null,hours:24,category:"608"},
});
const rows = [
  {source_id:"new-video",collection_request_id:"new-request"},
  {source_id:"old-video",collection_request_id:"old-request"},
  {source_id:"legacy-video"},
];
test("部分榜单更新保留旧记录并区分来源批次，不宣称完整", () => {
  const result = collectionProvenance(request("fulfilled", {
    records:[rows[0]],failures:["1002:来源超时"],
    observed_scope:{boards:[1001],hours:24,category:"608"},
  }), rows);
  assert.deepEqual(result.records.map(row=>row.cache_state),["current","historical","unattributed"]);
  assert.equal(result.collection.status,"partial");
  assert.equal(result.collection.completeness,"unverified");
  assert.equal(result.collection.current_source_count,1);
  assert.equal(result.collection.historical_source_count,1);
  assert.equal(result.collection.unattributed_source_count,1);
  assert.deepEqual(result.collection.observed_scope.boards,[1001]);
});
test("失败或等待采集时不把已有快照标成本次新结果", () => {
  for(const state of ["failed","pending"]){
    const result=collectionProvenance(request(state),rows.slice(1));
    assert.equal(result.collection.status,state);
    assert.equal(result.collection.current_source_count,0);
    assert.equal(result.collection.returned_source_count,null);
    assert.equal(result.collection.latest_request.error,state === "failed" ? "source unavailable" : null);
  }
});
test("API provenance derives only allowlisted persisted failure prefix, never trusts an extra error_code field", () => {
  for (const [error, code] of [["VERIFICATION_REQUIRED: 请人工验证", "VERIFICATION_REQUIRED"],
    ["SOURCE_TIMEOUT: 超时", "SOURCE_TIMEOUT"], ["LOGIN_REQUIRED: VERIFICATION_REQUIRED: 旧错误", "LOGIN_REQUIRED"],
    ["arbitrary: 错误", null], ["没有分类的旧错误", null]]) {
    const failed = {...request("failed"),error,error_code:"ARBITRARY"};
    assert.equal(collectionProvenance(failed,rows.slice(1)).collection.latest_request.error_code,code);
    failed.state="pending";
    assert.equal(collectionProvenance(failed,rows.slice(1)).collection.latest_request.error_code,null);
  }
});
test("没有请求或只有首屏成功，不推断全部数据已采完", () => {
  const legacy=collectionProvenance(null,[rows[2]]);
  assert.equal(legacy.collection.status,"not_requested");
  assert.equal(legacy.records[0].is_from_latest_request,false);
  const firstPage=collectionProvenance(request("fulfilled",{records:[rows[0]],failures:[]}),[rows[0]]);
  assert.equal(firstPage.collection.status,"observed");
  assert.equal(firstPage.collection.completeness,"unverified");
  assert.equal(rows[0].cache_state,undefined);
});
test("已核验可访问分页与来源声明总数分开，少于总数不宣传官方全量",()=>{
  const pagination={max_pages_per_board:50,max_rows_per_board:1500,boards:[{board:1001,hours:24,category:"608",
    status:"accessible_complete",pages:Array.from({length:34},(_,i)=>({page:i+1,page_size:30,total:1000,actual_count:26})),
    collected_count:884,metadata_total:1000,metadata_total_difference:116,
    terminal:{page:34,next_disabled:true,observed_current_page:34}}]};
  const req=request("fulfilled",{records:[rows[0]],failures:[],pagination});
  req.payload.board=1001;
  let result=collectionProvenance(req,rows).collection;
  assert.equal(result.completeness,"accessible_pages_complete");
  assert.equal(result.metadata_total_status,"count_mismatch");
  assert.equal(result.pagination,pagination);
  req.payload.board=null;
  result=collectionProvenance(req,rows).collection;
  assert.equal(result.completeness,"partial_accessible_pages");
  assert.equal(result.status,"partial");
  req.payload.board=1001;req.result.failures=["其他来源失败"];
  assert.equal(collectionProvenance(req,rows).collection.completeness,"partial_accessible_pages");
  req.result.failures=[];pagination.boards[0].metadata_total_difference=0;
  assert.equal(collectionProvenance(req,rows).collection.metadata_total_status,"matched_counts");
  for(const state of ["pending","failed"]){req.state=state;
    result=collectionProvenance(req,rows).collection;
    assert.equal(result.pagination,null);assert.equal(result.completeness,"unverified");}
});

test("Redfox counts account for every response item without leaking excluded raw records",()=>{
  const req={...request("fulfilled",{records:[rows[0]],excluded_records:[{reason:"non_video",source_id:"private"},{reason:"type_unknown"},{reason:"duplicate"},{reason:"sample_limit"},{reason:"future_reason"}],api_pagination:{status:"partial"}}),payload:{provider:"redfox",purpose:"game-research"}};
  const summary=collectionProvenance(req,rows).collection.selection_summary;
  assert.deepEqual(summary,{response_count:6,retained_count:1,excluded_counts:{non_video:1,type_unknown:1,duplicate:1,sample_limit:1,other:1}});
  assert(!JSON.stringify(summary).includes("private"));
  for(const state of ["pending","failed"]){req.state=state;assert.equal(collectionProvenance(req,rows).collection.selection_summary,null);}
  req.state="fulfilled";delete req.result.excluded_records;
  assert.equal(collectionProvenance(req,rows).collection.selection_summary,null);
});

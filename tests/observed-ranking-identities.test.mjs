import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesObservedVideoScope, observedVideoIdentities, matchVisibleVideoIdentity, settleObservedResponses, waitForObservedVideoScope } from '../app/observed-ranking-identities.mjs';
const expected = {board:1001,hours:24,category:'all'};
const row = {item_id:'7697398053100633275',item_title:'实际标题',nick_name:'实际作者'};
const receipt = (override={}) => ({url:'https://douhot.douyin.com/douhot/v1/material/video_billboard',status:200,request:{sub_type:1001,date_window:24,page:1},body:{code:0,data:{objs:[row]}},...override});

test('scope wait observes late headers and completed body while refusing old industry/time scopes',async()=>{
 const scope={board:1001,hours:72,category:'605'},children=['60507','60504','60508','60509'];
 const current=receipt({request:{sub_type:1001,date_window:72,tags:[{value:605,children:children.map(value=>({value:Number(value)}))}]}});
 const receipts=[receipt(),receipt({request:{sub_type:1001,date_window:72,tags:null}})];
 let done=false;
 const waiting=waitForObservedVideoScope(receipts,scope,children,{timeoutMs:200}).then(value=>{done=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,5)); assert.equal(done,false);
 // Starting a body read is not enough: only its completed receipt is visible.
 let finishBody;const body=new Promise(resolve=>finishBody=resolve).then(()=>receipts.push(current));
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(done,false);
 finishBody();await body;assert.equal(await waiting,current);
});

test('scope wait times out without adopting old scope and keeps same-scope failure invalid',async()=>{
 await assert.rejects(waitForObservedVideoScope([receipt({request:{sub_type:1002,date_window:24}})],expected,null,{timeoutMs:5}),{code:'SOURCE_RESPONSE_TIMEOUT'});
 for(const failed of [receipt({status:403}),receipt({body:{code:1,data:{objs:[]}}}),receipt({body:null})]){
  const found=await waitForObservedVideoScope([failed],expected,null,{timeoutMs:5});
  assert.equal(found,failed);assert.throws(()=>observedVideoIdentities([found],expected,null));
 }
});

test('scope wait cancellation rejects both an active wait and an already available receipt',async()=>{
 const abort=new AbortController();
 const waiting=waitForObservedVideoScope([],expected,null,{timeoutMs:200,signal:abort.signal});
 abort.abort(Error('cancelled by caller'));await assert.rejects(waiting,/cancelled by caller/);
 await assert.rejects(waitForObservedVideoScope([receipt()],expected,null,{signal:abort.signal}),/cancelled by caller/);
});

test('observed response identity requires exact successful source scope and actual DOM title/author',()=>{
 const identities=observedVideoIdentities([receipt()],expected,null);
 assert.equal(matchVisibleVideoIdentity(identities,{title:'实际标题',author:'实际作者'}),row.item_id);
 assert.throws(()=>matchVisibleVideoIdentity(identities,{title:'实际标…',author:'实际作者'}),/未与/);
 assert.throws(()=>matchVisibleVideoIdentity(identities,{title:'实际标题',author:'其他作者'}),/未与/);
 for(const value of [receipt({url:'https://evil.test/douhot/v1/material/video_billboard'}),receipt({url:'https://douhot.douyin.com/account/me'}),receipt({request:{sub_type:1002,date_window:24}}),receipt({request:{sub_type:1001,date_window:72}}),receipt({request:{sub_type:1001,date_window:24,tags:[{value:608}]}})])
  assert.throws(()=>observedVideoIdentities([value],expected,null),/未取得/);
 for(const value of [receipt({status:403}),receipt({body:{code:1,data:{objs:[]}}}),receipt({body:{code:0,data:{search_list:[row]}}})])
  assert.throws(()=>observedVideoIdentities([value],expected,null));
});

test('industry scope requires exactly the live checked parent/children without stale or extra tags',()=>{
 const scope={board:1001,hours:24,category:'608'},children=['60801','60802'];
 const tagged=receipt({request:{sub_type:1001,date_window:24,tags:[{value:608,children:[{value:60802},{value:60801}]}]}});
 assert.equal(matchesObservedVideoScope(tagged,scope,children),true);
 for(const tags of [[{value:608}],[{value:608,children:[{value:60801}]}],[{value:608,children:[{value:60801},{value:60801}]}],[{value:608,children:[{value:'60801'},{value:'60802'}]}],[{value:628,children:[{value:60801},{value:60802}]}],[...tagged.request.tags,{value:628}]])
  assert.equal(matchesObservedVideoScope({...tagged,request:{...tagged.request,tags}},scope,children),false);
 assert.equal(matchesObservedVideoScope(tagged,scope,null),false);
 assert.equal(matchesObservedVideoScope(tagged,{...scope,category:'608/60801'},children),false);
});

test('different-scope responses cannot supply IDs and same title/author ambiguity is rejected',()=>{
 const wrong=receipt({request:{sub_type:1001,date_window:72},body:{code:0,data:{objs:[{...row,item_id:'7697398053100633276'}]}}});
 assert.equal(matchVisibleVideoIdentity(observedVideoIdentities([wrong,receipt()],expected),{title:row.item_title,author:row.nick_name}),row.item_id);
 const ambiguous=receipt({body:{code:0,data:{objs:[row,{...row,item_id:'7697398053100633276'}]}}});
 assert.throws(()=>matchVisibleVideoIdentity(observedVideoIdentities([ambiguous],expected),{title:row.item_title,author:row.nick_name}),/歧义/);
 assert.equal(observedVideoIdentities([receipt(),receipt()],expected).length,1);
 assert.throws(()=>observedVideoIdentities([receipt(),receipt({body:{code:0,data:{objs:[{...row,item_title:'不同标题'}]}}})],expected),/冲突/);
});

test('numeric or aliased identity fields are rejected rather than rounded or guessed',()=>{
 for(const changed of [{...row,item_id:Number(row.item_id)},{...row,item_id:12345678901},{...row,item_id:undefined,video_id:row.item_id},{...row,nick_name:undefined,author_name:row.nick_name},{...row,item_title:''}])
  assert.throws(()=>observedVideoIdentities([receipt({body:{code:0,data:{objs:[changed]}}})],expected),/结构不可核验/);
 assert.deepEqual(observedVideoIdentities([receipt({body:{code:0,data:{objs:[]}}})],expected),[]);
});

test('response settlement waits for pending JSON and fails boundedly on timeout/cancellation',async()=>{
 let complete;const pending=new Promise(r=>complete=r);let done=false;
 const waiting=settleObservedResponses(new Set([pending]),{timeoutMs:1000}).then(()=>{done=true;});
 await new Promise(r=>setImmediate(r));assert.equal(done,false);complete();await waiting;assert.equal(done,true);
 await assert.rejects(settleObservedResponses([new Promise(()=>{})],{timeoutMs:5}),/尚未读取完成/);
 const abort=new AbortController();abort.abort(Error('cancelled'));
 await assert.rejects(settleObservedResponses([new Promise(()=>{})],{signal:abort.signal}),/cancelled/);
});

test('response settlement dynamically drains reads added while the first body is settling',async()=>{
 let firstDone,secondDone;
 const first=new Promise(r=>firstDone=r),second=new Promise(r=>secondDone=r),reads=new Set([first]);
 let drained=false;
 const waiting=settleObservedResponses(reads,{timeoutMs:1000}).then(()=>{drained=true;});
 reads.add(second);firstDone();await new Promise(r=>setImmediate(r));assert.equal(drained,false);
 secondDone();await waiting;assert.equal(drained,true);
});

test('newly arriving response bodies share the same bounded drain deadline',async()=>{
 let firstDone;
 const first=new Promise(r=>firstDone=r),reads=new Set([first]);
 const waiting=settleObservedResponses(reads,{timeoutMs:10});
 reads.add(new Promise(()=>{}));firstDone();
 await assert.rejects(waiting,/尚未读取完成/);
});

test('identity mismatch diagnostics are bounded public metadata without raw response or IDs',()=>{
 const items=Array.from({length:9},(_,i)=>({source_id:'7697398053100633275'+i,title:'文'.repeat(300),author:'名'.repeat(150),token:'PRIVATE_TOKEN'}));
 assert.throws(()=>matchVisibleVideoIdentity(items,{title:'另一标题',author:'名'.repeat(150)}),error=>{
  const info=error.identity_diagnostic;
  assert.equal(info.author_matches,9);assert.equal(info.title_matches,0);
  assert.equal(info.candidates.length,3);assert.equal(info.first_candidates.length,3);
  assert.equal(info.candidates[0].title.length,200);assert.equal(info.visible.author.length,100);
  assert.doesNotMatch(JSON.stringify(info),/PRIVATE_TOKEN|7697398053100633275/);
  return true;
 });
});

test('observed literal-dots title truncation requires a long unique prefix and exact author',()=>{
 const prefix='A substantial displayed title prefix',author='Public author';
 const identity={source_id:'7697398053100633275',title:prefix+' complete original title',author};
 assert.equal(matchVisibleVideoIdentity([identity],{title:prefix+'...',author}),identity.source_id);
 assert.throws(()=>matchVisibleVideoIdentity([identity],{title:'A substantial',author}),/未与/);
 assert.throws(()=>matchVisibleVideoIdentity([identity],{title:'A...',author}),/未与/);
 assert.throws(()=>matchVisibleVideoIdentity([identity],{title:prefix+'…',author}),/未与/);
 assert.throws(()=>matchVisibleVideoIdentity([identity],{title:prefix+'．．．',author}),/未与/);
 assert.throws(()=>matchVisibleVideoIdentity([identity],{title:prefix+'...',author:'Other author'}),/未与/);
 assert.throws(()=>matchVisibleVideoIdentity([identity,{...identity,source_id:'7697398053100633276',title:prefix+' different video'}],{title:prefix+'...',author}),/歧义/);
 assert.throws(()=>matchVisibleVideoIdentity([identity,{...identity,source_id:'7697398053100633276',title:prefix+'...'}],{title:prefix+'...',author}),/歧义/);
});

test('invalid identity schema diagnostics expose types and lengths but never raw fields',()=>{
 const bad={...row,item_title:'  ',nick_name:'PRIVATE_AUTHOR',media_type:2,image_cnt:3,private_token:'PRIVATE_TOKEN'};
 assert.throws(()=>observedVideoIdentities([receipt({body:{code:0,data:{objs:[row,bad]}}})],expected,null),error=>{
  const d=error.identity_schema_diagnostic;
  assert.equal(d.row_index,1);assert.equal(d.fields.item_title.length,2);assert.equal(d.fields.item_title.normalized_length,0);
  assert.equal(d.id_is_decimal_string,true);assert.equal(d.media_type,2);assert.equal(d.image_count,3);
  assert.doesNotMatch(JSON.stringify(d),/PRIVATE_AUTHOR|PRIVATE_TOKEN|7697398053100633275/);return true;
 });
});

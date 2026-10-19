import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {gameFilterTarget,observeGameFiltersDOM,assertGameSearchScope,applyGameSearchFilters,diagnosticGameSnapshot,fingerprintGameCards,waitForStableGameCards} from '../app/game-search-scope.mjs';
const payload={keyword:'率土之滨',hours:168,sort:'likes'};
const url='https://www.douyin.com/search/'+encodeURIComponent(payload.keyword)+'?type=video';
const control=(label,selected=true,kind='aria-checked')=>({label,selection:{kind,selected}});
const selected=()=>({url,controls:[control('视频',true,'aria-selected'),control('最多点赞'),control('一周内')]});
function node(text,attrs={},children=[],visible=true){
 const value={tagName:'DIV',innerText:text,textContent:text,children,parentElement:null,
  getAttribute:key=>attrs[key]??null,getClientRects:()=>visible?[{}]:[],
  querySelectorAll:()=>children.flatMap(child=>[child,...child.querySelectorAll('*')])};
 children.forEach(child=>child.parentElement=value);return value;
}
test('visible filter label with SVG survives diagnostics; classes and unrelated selected ancestors prove nothing',()=>{
 const icon=node('',{},[]),filter=node('筛选',{},[icon]);
 const css=node('最多点赞',{class:'active selected'}), hidden=node('一周内',{'role':'radio','aria-checked':'true'},[],false);
 const video=node('视频',{role:'tab','aria-selected':'true'});
 const option=node('一周内',{role:'radio','aria-checked':'false'});
 node('一周内 不限',{role:'radio','aria-checked':'true'},[option]);
 const result=vm.runInNewContext(`(${observeGameFiltersDOM})()`,{URL,location:{href:url+'&private_token=secret'},
  document:{querySelectorAll:()=>[filter,icon,css,hidden,video,option]},getComputedStyle:()=>({})});
 assert(result.controls.some(c=>c.label==='筛选'));
 assert.equal(result.controls.find(c=>c.label==='最多点赞').selection,null);
 assert.equal(result.controls.filter(c=>c.label==='一周内').length,1);
 assert.equal(result.controls.find(c=>c.label==='一周内').selection.selected,false);
 assert.equal(result.controls.find(c=>c.label==='视频').selection.kind,'aria-selected');
 assert.equal(result.url,url);assert(!JSON.stringify(result).includes('secret'));
});
test('exact standard selected scope is verified independently of URL arguments; no approximate time mapping',()=>{
 const scope=assertGameSearchScope(selected(),gameFilterTarget(payload));
 assert.deepEqual(scope,{site:'douyin',keyword:'率土之滨',type:'video',hours:168,sort:'likes',sort_label:'最多点赞',time_label:'一周内',selection_evidence:{type:'aria-selected',sort:'aria-checked',time:'aria-checked'}});
 for(const hours of [1,72,4320,'168'])assert.throws(()=>gameFilterTarget({...payload,hours}),/等价时间/);
 for(const mutation of [s=>s.controls[0].selection=null,s=>s.controls[1].selection.selected=false,
  s=>s.controls.push(control('不限')),s=>s.controls.push(control('一周内')),s=>s.url+='&type=user',
  s=>s.url=s.url.replace('www.douyin.com','evil.invalid'),s=>s.truncated=true]){
  const snapshot=selected();mutation(snapshot);assert.throws(()=>assertGameSearchScope(snapshot,gameFilterTarget(payload)),{code:'SOURCE_FAILED'});
 }
});
function fakePage({cssOnly=false,duplicates=1,unchanged=false,hoverOnly=false,neverOpen=false}={}){
 let opened=false;const clicks=[],hovers=[];let state=selected();
 state.controls[1].selection.selected=false;state.controls[2].selection.selected=false;
 if(cssOnly)state.controls[1].selection=null;
 return {clicks,hovers,evaluate:async fn=>{assert.equal(fn,observeGameFiltersDOM);return opened?structuredClone(state):{url,controls:[control('筛选')]};},
  getByText:label=>({first:()=>({waitFor:async()=>{}}),count:async()=>label==='筛选'?duplicates:1,nth:()=>({isVisible:async()=>true,hover:async()=>{hovers.push(label);if(hoverOnly&&!neverOpen)opened=true;},click:async()=>{
   clicks.push(label);if(label==='筛选'){if(!neverOpen)opened=true;}else if(!unchanged)state.controls.find(c=>c.label===label).selection.selected=true;
  }})})};
}
test('normal unique filter opens and only standard semantic options are clicked and rechecked',async()=>{
 const page=fakePage(),observations=[];
 const filters=await applyGameSearchFilters(page,payload,{observe:(stage,snapshot)=>observations.push({stage,snapshot})});
 assert.deepEqual(page.clicks,['筛选','最多点赞','一周内']);
 assert.deepEqual(page.hovers,['筛选']);
 assert.equal((await filters.read()).scope.hours,168);
 assert(observations.some(o=>o.stage==='open_filters_opened'));
});
test('hover-expanded filter is not clicked closed; missing options remain a distinct bounded diagnostic failure',async()=>{
 const page=fakePage({hoverOnly:true});await applyGameSearchFilters(page,payload);
 assert.deepEqual(page.hovers,['筛选']);assert.deepEqual(page.clicks,['最多点赞','一周内']);
 const absent=fakePage({neverOpen:true});
 await assert.rejects(applyGameSearchFilters(absent,payload),/选项尚不可见/);
 assert.deepEqual(absent.hovers,['筛选']);assert.deepEqual(absent.clicks,['筛选']);
});
test('unknown menu semantics, ambiguous entry, unchanged selection and cancellation fail closed',async()=>{
 for(const options of [{cssOnly:true},{duplicates:2},{unchanged:true}]){
  const page=fakePage(options);await assert.rejects(applyGameSearchFilters(page,payload),{code:'SOURCE_FAILED'});
  if(options.cssOnly)assert.deepEqual(page.clicks,['筛选']);
  if(options.duplicates)assert.equal(page.clicks.length,0);
 }
 const page=fakePage(),controller=new AbortController();controller.abort(Error('cancelled'));
 await assert.rejects(applyGameSearchFilters(page,payload,{signal:controller.signal}),/cancelled/);assert.equal(page.clicks.length,0);
});

function failingActionPage(action,error,before=()=>{}){
 const page=fakePage(),get=page.getByText;
 page.getByText=label=>{
  const list=get(label);if(label!=='筛选')return list;
  if(action==='count')return {...list,count:async()=>{before();throw error;}};
  const nth=list.nth;return {...list,nth:index=>{
   const item=nth(index);return {...item,[action]:async()=>{before();throw error;}};
  }};
 };
 return page;
}
test('menu hover/click/locator timeouts retain public filter diagnostic without exposing raw Playwright trace',async()=>{
 for(const action of ['hover','click','count','isVisible']){
  const timeout=Object.assign(Error('RAW_PRIVATE_TRACE'),{name:'TimeoutError'});
  const page=failingActionPage(action,timeout);
  await assert.rejects(applyGameSearchFilters(page,payload),error=>{
   assert.equal(error.code,'SOURCE_FAILED');assert(error.diagnostics.game_filters);
   assert.equal(error.diagnostics.menu_action.reason,'timeout');assert(!JSON.stringify(error).includes('RAW_PRIVATE_TRACE'));
   assert(!error.message.includes('RAW_PRIVATE_TRACE'));return true;
  });
 }
});
test('menu normalization preserves cancellation and real authentication guards, never absorbs unrelated read failures',async()=>{
 for(const code of ['LOGIN_REQUIRED','VERIFICATION_REQUIRED','ACCESS_RESTRICTED']){
  const auth=Object.assign(Error('auth'),{code}),timeout=Object.assign(Error('timeout'),{name:'TimeoutError'});let timedOut=false;
  const page=failingActionPage('hover',timeout,()=>{timedOut=true;});
  await assert.rejects(applyGameSearchFilters(page,payload,{guard:async()=>{if(timedOut)throw auth;}}),error=>error===auth);
  const direct=failingActionPage('click',auth);
  await assert.rejects(applyGameSearchFilters(direct,payload),error=>error===auth);
 }
 const cancelled=Error('explicit cancel'),abort=new AbortController();
 await assert.rejects(applyGameSearchFilters(failingActionPage('hover',Object.assign(Error('timeout'),{name:'TimeoutError'}),()=>abort.abort(cancelled)),payload,{signal:abort.signal}),error=>error===cancelled);
 const network=Error('unrelated read failure'),page=fakePage();page.evaluate=async()=>{throw network;};
 await assert.rejects(applyGameSearchFilters(page,payload),error=>error===network);
});

test('observed grouped class pattern binds each unlimited option to its actual heading',()=>{
 const option=(label,selected=false)=>Object.assign(node(label,{class:'eXMmo3JR'+(selected?' sDNqBVWH':'')}),{tagName:'SPAN'});
 const sortOptions=[option('综合排序',true),option('最新发布'),option('最多点赞')];
 const timeOptions=[option('不限',true),option('一天内'),option('一周内'),option('半年内')];
 const group=(title,options)=>node(title+' '+options.map(n=>n.innerText).join(' '),{},[node(title),node(options.map(n=>n.innerText).join(' '),{},options)]);
 const root=node('menu',{},[group('排序依据',sortOptions),group('发布时间',timeOptions),group('视频时长',[option('不限',true),option('1分钟')]),group('搜索范围',[option('不限',true),option('全部')])]);
 const all=root.querySelectorAll('*');
 const read=()=>JSON.parse(JSON.stringify(vm.runInNewContext(`(${observeGameFiltersDOM})()`,{URL,location:{href:url},document:{querySelectorAll:selector=>selector==='body *'?all:[]},getComputedStyle:()=>({})})));
 let actual=read();assert.equal(actual.groups.sort.selected,'综合排序');assert.equal(actual.groups.time.selected,'不限');
 assert.equal(actual.controls.filter(c=>c.label==='不限').length,3);
 sortOptions[0].getAttribute=k=>k==='class'?'eXMmo3JR':null;
 sortOptions[2].getAttribute=k=>k==='class'?'eXMmo3JR sDNqBVWH':null;
 actual=read();assert.equal(actual.groups.sort.selected,'最多点赞');assert.equal(actual.groups.time.selected,'不限');
 sortOptions[2].getAttribute=k=>k==='class'?'eXMmo3JR guessed-active':null;
 assert.equal(read().groups.sort,undefined);
});
test('wrong keyword is rejected before any source menu action',async()=>{
 const page=fakePage();page.evaluate=async()=>({url:url.replace(encodeURIComponent(payload.keyword),'wrong'),controls:[control('筛选')]});
 await assert.rejects(applyGameSearchFilters(page,payload),/实际搜索关键词/);assert.deepEqual(page.clicks,[]);assert.deepEqual(page.hovers,[]);
});
test('public status diagnostics retain bounded identity evidence, not full raw batches',()=>{
 const cards=Array.from({length:200},(_,i)=>({source_id:String(7000000000000000000n+BigInt(i)),text:'x'.repeat(8000)}));
 const snapshot={url,controls:[],groups:{},cards};
 const status=diagnosticGameSnapshot(snapshot),failure=diagnosticGameSnapshot(snapshot,{samples:true});
 assert.equal(status.cards,undefined);assert.equal(status.card_samples,undefined);assert.equal(status.card_count,200);
 assert.equal(status.card_ids.length,8);assert.equal(status.card_fingerprint,fingerprintGameCards(cards));
 assert.equal(failure.card_samples.length,3);assert(failure.card_samples.every(c=>c.text.length===600));
 assert(JSON.stringify(failure).length<3000);assert.equal(cards[0].text.length,8000);
});
test('same identities with changed text do not establish a new result generation; abort propagates',async()=>{
 const before={cards:[{source_id:'12345678901',text:'old'}]},after={cards:[{source_id:'12345678901',text:'new'}]};
 await assert.rejects(waitForStableGameCards(async()=>after,{before,timeoutMs:5,wait:async()=>new Promise(r=>setImmediate(r))}),/结果更新信号/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(waitForStableGameCards(async()=>after,{signal:controller.signal,wait:async()=>{}}),{name:'AbortError'});
});
test('same-snapshot duplicate identity preserves exact duplicates but rejects conflicting or oversized copies',async()=>{
 const source_id='12345678901',card=text=>Object.assign(node(text),{href:'https://www.douyin.com/video/'+source_id,tagName:'A'});
 const raw='00:30\n12\n公开标题\n@公开作者\n1小时前';
 const read=entries=>JSON.parse(JSON.stringify(vm.runInNewContext(`(${observeGameFiltersDOM})()`,{URL,location:{href:url},
  document:{querySelectorAll:selector=>selector==='body *'?entries:entries},getComputedStyle:()=>({})})));
 const exact=read([card(raw),card(raw)]);assert.equal(exact.cards.length,1);assert.deepEqual(exact.card_conflicts,[]);
 for(const second of [raw.replace('1小时前','1年前'),raw+'x'.repeat(8000)]){
  const snapshot=read([card(raw),card(second)]);assert(snapshot.card_conflicts.length>0);
  await assert.rejects(waitForStableGameCards(async()=>snapshot,{wait:async()=>{}}),/不同内容/);
  assert(snapshot.card_conflicts.every(item=>!Object.hasOwn(item,'text')));
 }
});

test('scroll progress requires a new ID for the whole collection, not removal or recycled old cards',async()=>{
 const card=source_id=>({source_id,text:source_id}),a=card('12345678901'),b=card('12345678902'),c=card('12345678903');
 const before={cards:[a,b]},seenIdentities=new Set([a.source_id,b.source_id,c.source_id]);
 for(const cards of [[b],[b,c],[{...b,text:'updated likes'}]]){
  let reads=0;const result=await waitForStableGameCards(async()=>{reads++;return{cards};},{before,seenIdentities,allowNoProgress:true,timeoutMs:15,wait:async()=>new Promise(r=>setTimeout(r,1))});
  assert.equal(result.no_progress,true);assert(reads>=3);
 }
 let reads=0;const d=card('12345678904');
 const result=await waitForStableGameCards(async()=>({cards:++reads<5?[b,c]:[b,d]}),{before,seenIdentities,allowNoProgress:true,timeoutMs:40,wait:async()=>new Promise(r=>setTimeout(r,1))});
 assert.equal(result.no_progress,undefined);assert(reads>=7);assert.deepEqual(result.snapshot.cards,[b,d]);
});

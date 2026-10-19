import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks} from '../app/tasks.mjs';
import {SideBridge} from '../app/side-bridge.mjs';
import {createAutomaticCollector} from '../app/automatic-collector.mjs';
import {classifyGamePublication,fingerprintGameCards} from '../app/game-search-scope.mjs';
const id=index=>String(7000000000000000000n+BigInt(index));
const cards=(start,count,date='1天前',likes=42)=>Array.from({length:count},(_,i)=>({source_id:id(start+i),text:`00:15\n${likes}\n公开标题${start+i}\n@公开作者\n${date}`}));
async function fixture(scenario='valid'){
 const folder=await mkdtemp(join(tmpdir(),'game-dom-'));
 let url='',closed=false,sort='综合排序',time='不限',phase=0,wheels=0,gotos=0,handles=0,disposed=0,reads=0,lastWheelAt=0;
 if(scenario==='already-selected'){sort='最多点赞';time='一周内';phase=2;}
 if(scenario==='final-reorder')time='一周内';
 const clicks=[];
 const snapshot=()=>{
  reads++;let value=phase===0?cards(1,16,'1年前'):phase===1?cards(5,16,'1年前'):wheels?cards(10,36,'1天前',43):cards(10,16);
  if(wheels&&(scenario==='no-new-cards'||scenario==='delayed-scroll'&&Date.now()-lastWheelAt<450))value=cards(10,16);
  if(phase>=2){if(scenario==='outside')value[0]=cards(10,1,'1年前')[0];else if(scenario==='unknown')value=value.map(card=>({...card,text:card.text.replace('1天前','日期未提供')}));else value[0]={...value[0],text:value[0].text.replace('1天前','日期未提供')};}
  if(['reorder','final-reorder'].includes(scenario)&&phase===1)value=cards(1,16,'1年前').reverse();
  if(scenario==='text-only'&&phase===1)value=cards(1,16,'1年前',50);
  if(scenario==='unchanged'&&phase>=1)value=cards(1,16,'1年前');
  const groups={sort:{title:'排序依据',selected:sort,options:['综合排序','最新发布','最多点赞'].map(label=>({label,classes:label===sort?['eXMmo3JR','sDNqBVWH']:['eXMmo3JR']}))},time:{title:'发布时间',selected:time,options:['不限','一天内','一周内','半年内'].map(label=>({label,classes:label===time?['eXMmo3JR','sDNqBVWH']:['eXMmo3JR']}))}};
  if(scenario==='drift'&&wheels)groups.time.selected='不限';
  return {url,groups,cards:value,controls:[{label:'筛选'},...['最多点赞','一周内'].map(label=>({label,selection:null}))],truncated:false,cards_overflow:false,node_update:{before_nodes:16,detached_nodes:8,reused_nodes_changed_id:0}};
 };
 const visible={first(){return this;},waitFor:async()=>{}};
 const page={url:()=>url,isClosed:()=>closed,close:async()=>{closed=true;},title:async()=>'公开搜索结果',frames:()=>[],on:()=>{},
  goto:async value=>{gotos++;url=value;return{status:()=>200};},
  locator:selector=>selector==='body'?{...visible,innerText:async()=>'公开视频结果'}:selector==='[role="dialog"], [aria-modal="true"]'?{evaluateAll:async()=>[]}:visible,
  evaluate:async fn=>fn.name==='observeGameFiltersDOM'?snapshot():{controls:[]},
  evaluateHandle:async()=>{handles++;return{dispose:async()=>{disposed++;}};},
  waitForTimeout:async()=>{await new Promise(resolve=>scenario==='delayed-scroll'?setTimeout(resolve,120):setImmediate(resolve));},
  getByText:label=>({count:async()=>1,first:()=>visible,nth:()=>({isVisible:async()=>true,hover:async()=>{},click:async()=>{
   clicks.push(label);if(label==='最多点赞'){sort=label;phase=1;}else if(label==='一周内'){time=label;phase=2;}
  }})}),mouse:{wheel:async()=>{wheels++;lastWheelAt=Date.now();}},
 };
 const ctx={pages:()=>[],newPage:async()=>page,close:async()=>{},on:()=>{}};
 const collector=createAutomaticCollector({profileDir:folder,responseTimeoutMs:scenario==='delayed-scroll'?1200:25,chromium:{launchPersistentContext:async()=>ctx}});
 return {collector,folder,stats:()=>({clicks,wheels,gotos,handles,disposed,reads}),cleanup:async()=>{await collector.close();await rm(folder,{recursive:true,force:true});}};
}
test('actual DOM group transitions plus changed overlapping card identities can complete game collection without API replay',async()=>{
 const f=await fixture();try{
  const db=new Tasks(f.folder),bridge=new SideBridge(db,{folder:f.folder});
  let result;
  try{const request=bridge.request('search',{purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes',limit:30});
   result=await f.collector.collect(request.payload);
   const validated=bridge.validate(request,result);assert.equal(validated.records.length,30);assert.equal(validated.scope_verification,'source_selected');
  }finally{db.close();}
  assert.equal(result.records.length,30);assert.equal(result.collection_batches.length,2);
  assert.equal(result.collection_batches[0].cards.length,16);assert.equal(result.collection_batches[1].cards.length,36);
  assert.equal(result.excluded_records.filter(row=>row.reason==='publication_unknown').length,1);
  assert.equal(result.excluded_records.filter(row=>row.reason==='sample_limit').length,5);
  assert.equal(result.result_update.method,'changed-visible-cards-and-stable-scope');
  assert.deepEqual(result.result_update.transitions,[{group:'sort',from:'综合排序',to:'最多点赞'},{group:'time',from:'不限',to:'一周内'}]);
  assert.equal(result.result_update.after_fingerprint,fingerprintGameCards(result.result_update.after_cards));
  assert.equal(result.records[0].like_count,43);assert.equal(result.records[0].published_text,'1天前');
  assert.equal(result.records[0].published_date,null);
  assert.deepEqual(f.stats().clicks,['最多点赞','一周内']);assert.equal(f.stats().gotos,1);
  assert.equal(f.stats().handles,2);assert.equal(f.stats().disposed,2);
 }finally{await f.cleanup();}
});
test('unchanged cards, definite publication contradiction and changed scope never become fresh success',async()=>{
 for(const scenario of ['unchanged','outside','unknown','drift','already-selected','final-reorder','text-only']){
  const f=await fixture(scenario);try{
   await assert.rejects(f.collector.collect({purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes'}),{code:'SOURCE_FAILED'});
   assert.equal(f.stats().gotos,1);assert.equal(f.stats().handles,f.stats().disposed);
   if(scenario==='already-selected')assert.equal(f.stats().clicks.length,0);
  }finally{await f.cleanup();}
 }
});
test('publication window uses conservative source precision, not invented exact publish instants',()=>{
 const observedAt='2026-10-19T05:00:00.000Z',check=(published_text,hours=168,extra={})=>classifyGamePublication({published_text,...extra},{hours,observedAt});
 assert.equal(check('1年前'),'outside');assert.equal(check('8天前'),'outside');assert.equal(check('7天前'),'unknown');
 assert.equal(check('6天前'),'within');assert.equal(check('昨天',24),'unknown');assert.equal(check('今天',24),'within');
 assert.equal(check('2026-10-18',24,{publication_precision:'date',published_date:'2026-10-18'}),'unknown');
 assert.equal(check('2026-10-01',168,{publication_precision:'date',published_date:'2026-10-01'}),'outside');
 assert.equal(check('未知'),'unknown');assert.equal(check(null),'unknown');
});

test('intermediate sort may reorder the same identities before final time selection changes membership',async()=>{
 const f=await fixture('reorder');const db=new Tasks(f.folder),bridge=new SideBridge(db,{folder:f.folder});
 try{const request=bridge.request('search',{purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes',limit:30});
 const result=await f.collector.collect(request.payload);
 assert.equal(bridge.validate(request,result).records.length,30);
 assert.deepEqual(f.stats().clicks,['最多点赞','一周内']);assert.equal(result.result_update.transitions.length,2);
 assert.deepEqual(result.result_update.before_cards.map(card=>card.source_id),cards(1,16).reverse().map(card=>card.source_id));
 assert(result.result_update.changed_identity_count>0);
 }finally{db.close();await f.cleanup();}
});

test('scroll waits past the old 360ms stable window for genuinely new cards, with no repeated wheel',async()=>{
 const f=await fixture('delayed-scroll');try{
 const result=await f.collector.collect({purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes',limit:30});
 assert.equal(result.records.length,30);assert.equal(f.stats().wheels,1);assert.equal(result.stop_reason,'sample_limit_reached');
 }finally{await f.cleanup();}
});
test('a bounded scroll without new identity stops once and reports a partial sample, not source exhaustion',async()=>{
 const f=await fixture('no-new-cards');const db=new Tasks(f.folder),bridge=new SideBridge(db,{folder:f.folder});try{
 const request=bridge.request('search',{purpose:'game-research',keyword:'率土之滨',hours:168,sort:'likes',limit:30});
 const result=await f.collector.collect(request.payload);
 assert.equal(result.records.length,15);assert.equal(f.stats().wheels,1);assert.equal(result.stop_reason,'no_new_cards_observed');
 assert.match(result.scope,/不代表来源末尾/);assert.match(result.scope,/不足20条/);
 assert.equal(bridge.validate(request,result).records.length,15);
 }finally{db.close();await f.cleanup();}
});

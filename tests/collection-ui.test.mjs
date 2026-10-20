import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Exercise the production renderer with minimal DOM nodes. This checks state
// feedback only; it is not browser layout or real-source acceptance evidence.
const source=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
test('空白源标题作者仅在卡片、详情及预览辅助文本显示中性提示，不改原值',()=>{
  const node=(tag,text='')=>({tag,textContent:text,children:[],dataset:{},attributes:{},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(key,value){this.attributes[key]=value;},showModal(){this.open=true;}});
  const nodes=new Map();
  const context={el:node,button:text=>node('button',text),materialPreview:()=>node('img'),
    rowKey:row=>row.source_id,materialClosing:false,activeRow:null,materialHistory:false,
    date:()=>'',pool:()=>[],sourceURL:()=>null,history:{pushState(){}},
    $:id=>{if(!nodes.has(id))nodes.set(id,node('div'));return nodes.get(id);}};
  vm.runInNewContext(source.slice(source.indexOf('function materialText('),source.indexOf('function materialPreview('))+
    source.slice(source.indexOf('function openMaterial('),source.indexOf('function gameTasks(')),context);
  const row={source_id:'12345678901',kind:'video',title:' \n\t ',author:'　 ',source_count:2,
    grouped_sources:[{title:' ',author:'\t'}]};
  const before=JSON.stringify(row);
  const flatten=n=>[n,...n.children.flatMap(flatten)];
  const card=flatten(context.materialCard(row));
  assert(card.some(n=>n.textContent==='未提供标题'));
  assert(card.some(n=>n.textContent==='作者未记录'));
  assert(card.some(n=>n.attributes['aria-label']==='查看素材：未提供标题'));
  context.openMaterial(row);
  assert.equal(nodes.get('detail-title').textContent,'未提供标题');
  const detail=flatten(nodes.get('evidence-panel'));
  assert.equal(detail.filter(n=>n.textContent==='作者未记录').length,2);
  assert(detail.some(n=>n.textContent==='未提供标题'));
  assert.equal(JSON.stringify(row),before);
  assert.equal(context.materialText(' 真实标题 ','未提供标题'),' 真实标题 ');
});
test('页面响应指标使用中性来源指标标签，旧DOM增量标签与游戏标签不变',()=>{
  const context={};
  vm.runInNewContext(source.slice(source.indexOf('function materialMetricLabel('),source.indexOf('function materialCard(')),context);
  for(const [key,label] of [['play_count','播放'],['like_count','点赞']]) {
    assert.equal(context.materialMetricLabel({source_endpoint:'douhot-page-response'},key),label);
    assert.equal(context.materialMetricLabel({source_endpoint:'douhot-visible-page'},key),`新增${label}`);
    assert.equal(context.materialMetricLabel({source_endpoint:'douyin_visible_search'},key),label);
  }
});
const renderer=source.slice(source.indexOf('function requestMatchesProvider('),source.indexOf('function materialCard('));
const gameScope={purpose:'game-research',keyword:'率土之滨'};
const hotScope={purpose:'hotspots',keyword:'',board:1001,hours:24,category:'608'};
function render({mode='game',rows=[],collection=null,pending=[],recent=[],redfox=false,collector={}}){
  const nodes=new Map();
  const context={sourceMode:mode,records:rows,recordCollection:collection,cardSignature:'',bridge:{pending,recent,collector},searchBusy:false,hotspotSearchBusy:false,localUploadController:null,localUploadNotice:'',sourceProviders:{game:redfox?"redfox":"browser",hotspots:redfox?"redfox":"browser"},redfoxMode:()=>redfox,nextSyncAt:0,
    $:id=>{if(!nodes.has(id)) nodes.set(id,{textContent:'',checked:false,replaceChildren(){}});return nodes.get(id);},
    scope:()=>hotScope,automaticSearch:()=>true,date:x=>new Date(x).toISOString(),game:()=> '率土之滨',hotspotScopeLabel:()=> '视频总榜 · 近1天',materialCard:()=>({})};
  vm.runInNewContext(renderer+'\nrenderRecords()',context);
  return nodes;
}
const old={snapshot_id:1,collected_at:'2026-10-18T01:00:00Z'};
const request=(id,state,at,payload=gameScope)=>({id,state,kind:'search',payload,created_at:at,updated_at:at,error:state==='failed'?'<b>来源失败</b>':null});
test('分页完成仅声明可访问页面并显示来源条数差额，不掩盖其他榜单失败',()=>{
  for (const partial of [false,true]) {
    const nodes=render({mode:'hotspot',rows:[old],collection:{requested_scope:hotScope,
      latest_request:request('pages','fulfilled','2026-10-18T02:00:00Z',hotScope),
      status:partial?'partial':'observed',failures:partial?['1002:读取失败']:[],
      completeness:partial?'partial_accessible_pages':'accessible_pages_complete',
      historical_source_count:0,unattributed_source_count:0,
      pagination:{boards:[{pages:[{},{}],metadata_total_difference:3}]}}});
    const text=nodes.get('material-summary').textContent;
    assert.match(text,/可访问分页（2 页）/);
    assert.match(text,/来源标称总数比实际返回多 3 条/);
    if(partial) assert.match(text,/1002:读取失败/);
    assert.doesNotMatch(text,/全榜完成|完整采集范围尚未核验/);
  }
});
test('多个客户端反复刷新状态只读取本地接口，不触发来源复检、模型或收费API',async()=>{
  const refresh=source.slice(source.indexOf('async function refreshStatus()'),source.indexOf('let changeTimer;'));
  const composer=source.slice(source.indexOf('function renderComposer()'),source.indexOf('function sendToTask('));
  const profile=source.slice(source.indexOf('async function loadProfile()'),source.indexOf('async function learning()'));
  const calls=[],target='率土之滨',profilePath='/api/game-profile?game='+encodeURIComponent(target);
  const allowed=new Set(['/api/tasks','/api/bridge/status','/api/quality-policy','/api/readiness',profilePath]);
  const clients=Array.from({length:6},(_,client)=>{
    const nodes=new Map();let recordsReads=0;
    const context={readiness:null,bridge:null,tasks:[],page:'discover',lastReadinessCheck:0,qualityCapabilities:null,currentProfile:null,gameGeneration:0,
      api:async(path,body)=>{
        calls.push({client,path,body});assert(allowed.has(path),'refresh must not call search, check, learning, model or paid endpoints: '+path);assert.equal(body,undefined);
        if(path==='/api/readiness')return {ready:false,checking:false,sites:[{id:'douyin',state:'unknown'}]};
        if(path==='/api/bridge/status')return {collector:{state:'idle'}};
        if(path==='/api/quality-policy')return {capabilities:{creation:{enabled:false}}};
        if(path===profilePath)return {status:'ready'};
        return [];
      },
      $:id=>{if(!nodes.has(id))nodes.set(id,{value:id==='draft-source'?'saved-row':'',textContent:'',replaceChildren(...children){this.children=children;}});return nodes.get(id);},
      Option:class{constructor(text,value){this.text=text;this.value=value;}},game:()=>target,pool:()=>[{source_id:'saved-row',title:'已选素材',collection:'games'}],rowKey:row=>row.source_id,
      automaticSearch:()=>true,loadRecords:async()=>{recordsReads++;},show:error=>{throw error;},
      renderReadiness:()=>{},renderTasks:()=>{},renderBridge:()=>{},renderGameState:()=>{},updatePageVisibility:()=>{},
      checkReadiness:()=>assert.fail('UI polling must not probe source'),fetch:()=>assert.fail('UI polling must not call a remote source'),
      requestHotspots:()=>assert.fail('UI polling must not spend'),learning:()=>assert.fail('UI polling must not run a model')};
    vm.runInNewContext(composer+'\n'+profile+'\n'+refresh,context);
    return {context,nodes,recordsReads:()=>recordsReads};
  });
  for(let round=0;round<2;round++)await Promise.all(clients.map(({context})=>context.refreshStatus()));
  assert.equal(calls.length,60);
  assert(calls.every(({path,body})=>body===undefined&&!path.endsWith('/check')));
  for(const [client,{context,nodes,recordsReads}] of clients.entries()){
    assert.deepEqual(calls.filter(c=>c.client===client).map(c=>c.path).sort(),[...allowed,...allowed].sort());
    assert.equal(context.currentProfile.status,'ready');assert.equal(recordsReads(),2);
    assert.equal(nodes.get('draft-source').value,'saved-row');
    assert.equal(nodes.get('create-draft').disabled,true,'refresh must honor local quality policy despite an old ready profile');
    assert.match(nodes.get('composer-help').textContent,/验收通过后恢复/);
  }
});
test('API范围状态即使不在recent20中也显示本次失败，历史内容不隐藏错误',()=>{
  const nodes=render({rows:[old],collection:{requested_scope:gameScope,latest_request:request('a','failed','2026-10-18T02:00:00Z')}});
  assert.equal(nodes.get('no-results').hidden,true);
  assert.match(nodes.get('material-summary').textContent,/本次未更新，正在展示历史采集内容：<b>来源失败<\/b>/);
});
test('更新的排队请求覆盖旧失败提示，热点也显示历史内容',()=>{
  const nodes=render({mode:'hotspot',rows:[old],collection:{requested_scope:hotScope,latest_request:request('a','failed','2026-10-18T02:00:00Z',hotScope)},pending:[request('b','pending','2026-10-18T03:00:00Z',hotScope)]});
  assert.match(nodes.get('material-summary').textContent,/当前为历史采集内容/);
  assert.doesNotMatch(nodes.get('material-summary').textContent,/本次未更新/);
});
test('部分采集保留来源缺口，合并来源也计入历史时间范围',()=>{
  const newer={snapshot_id:2,collected_at:'2026-10-18T02:00:00Z'};
  const nodes=render({rows:[{...newer,grouped_sources:[newer,old]}],collection:{requested_scope:gameScope,latest_request:request('a','fulfilled','2026-10-18T02:00:00Z'),status:'partial',failures:['1002:超时'],historical_source_count:1,unattributed_source_count:0,completeness:'unverified'}});
  const text=nodes.get('material-summary').textContent;
  assert.match(text,/本次仅部分采集成功：1002:超时/);
  assert.match(text,/包含 2 个采集批次，最早采集 2026-10-18T01:00:00.000Z/);
  assert.match(text,/有 1 个来源不属于本次采集/);
  assert.match(text,/完整采集范围尚未核验/);
});
test('任务所属搜索不覆盖广场状态或禁用同步',()=>{
  const privateTask={...request('task-search','pending','2026-10-18T03:00:00Z'),task_id:'learning-task'};
  const nodes=render({rows:[old],collection:{requested_scope:gameScope,latest_request:request('public','fulfilled','2026-10-18T02:00:00Z')},pending:[privateTask]});
  assert.equal(nodes.get('sync-game').disabled,false);
  assert.doesNotMatch(nodes.get('material-summary').textContent,/排队|正在采集/);
});
test('不同ID同创建时间保留API最新批次，同ID则读取更新的终态',()=>{
  const at='2026-10-18T02:00:00Z';
  let nodes=render({rows:[old],collection:{requested_scope:gameScope,latest_request:request('new','fulfilled',at)},recent:[{...request('old','failed',at),updated_at:'2026-10-18T03:00:00Z'}]});
  assert.doesNotMatch(nodes.get('material-summary').textContent,/本次未更新/);
  nodes=render({rows:[old],collection:{requested_scope:gameScope,latest_request:request('same','pending',at)},recent:[request('same','fulfilled',at)]});
  assert.equal(nodes.get('sync-game').disabled,false);
  nodes=render({rows:[old],collection:{requested_scope:gameScope,latest_request:request('new','pending',at)},recent:[request('old','failed',at),request('new','fulfilled',at)]});
  assert.equal(nodes.get('sync-game').disabled,false);
  assert.doesNotMatch(nodes.get('material-summary').textContent,/本次未更新/);
});
test('红狐按钮不被旧浏览器请求或中断计费请求阻塞，正在运行时禁用',()=>{
  const paid=request('paid','pending','2026-10-19T01:00:00Z',{...gameScope,provider:'redfox'});
  let nodes=render({redfox:true,pending:[request('old','pending','2026-10-19T01:00:00Z')]});
  assert.equal(nodes.get('sync-game').disabled,false);
  nodes=render({redfox:true,pending:[paid],collector:{recent:[{request_id:'paid',state:'interrupted',attempts:1}]}});
  assert.equal(nodes.get('sync-game').disabled,false);
  assert.match(nodes.get('material-summary').textContent,/中断.*手动重试/);
  nodes=render({redfox:true,pending:[paid],collector:{active_request_id:'paid'}});
  assert.equal(nodes.get('sync-game').disabled,true);
  nodes=render({redfox:true,pending:[paid],collector:{recent:[{request_id:'paid',state:'running',attempts:1,lease:Date.now()+30000}]}});
  assert.equal(nodes.get('sync-game').disabled,true);
});
test('红狐游戏输入、回车、范围选择、轮询都不自动调用来源',async()=>{
  const calls=[], nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  const context={$,sourceProviders:{game:'redfox',hotspots:'redfox'},listGeneration:0,gameGeneration:0,records:[],cardSignature:'',
    setTimeout:fn=>{calls.push(fn);return 1;},clearTimeout:()=>{},renderRecords:()=>{},show:()=>{},
    loadRecords:async()=>{},requestHotspots:async()=>{throw Error('selector must not spend');}};
  const range=source.slice(source.indexOf('let scopeChangeTimer;'),source.indexOf('$("sort").onchange'));
  vm.runInNewContext(range,context);
  for(const id of ['board','hours','category']) $(id).onchange();
  for(const fn of calls) await fn();
  assert.equal(calls.length,3);
  assert.match(source,/event.key === "Enter" && sourceProviders.game !== "redfox"/);
  assert.match(source,/sourceProviders.game !== "redfox" && automaticSearch\(\) && generation/);
  assert.match(source,/sourceProviders.game !== "redfox" && \$\("auto-sync"\)\.checked/);
});
test('Redfox collection entry tolerates Tencent failure but not missing source configuration',()=>{
 const guard=source.slice(source.indexOf('const allConnectionsConfirmed'),source.indexOf('const verifiedConnectionCount'));
 for(const [mode,ready,collection,configured,expected] of [[true,false,true,true,true],[true,false,true,false,false],[true,true,false,true,false],[false,false,true,true,false],[false,true,true,true,true]]){
  const context={redfoxMode:()=>mode,pendingDestination:false,confirmedConnections:new Set(['douyin','douhot','tencent']),readiness:{ready,collection_ready:collection,redfox:{games:{configured},hotspots:{configured}},sites:[{id:'tencent',state:'failed'}]}};
  vm.runInNewContext(guard+'\nanswer=allConnectionsConfirmed()',context);
  assert.equal(context.answer,expected);
 }
});

test('Redfox summary explains excluded items only for the current successful request',()=>{
  const scope={...gameScope,provider:'redfox'};
  const collection={provider:'redfox',requested_scope:scope,latest_request:request('paid','fulfilled','2026-10-19T01:00:00Z',scope),selection_summary:{response_count:50,retained_count:30,excluded_counts:{non_video:17,sample_limit:3}},historical_source_count:0,unattributed_source_count:0};
  let nodes=render({redfox:true,collection});
  assert.match(nodes.get('material-summary').textContent,/接口返回 50 条，保留 30 条视频；未纳入：非视频 17 条、超出样本上限 3 条（仅本次响应）/);
  for(const state of ['pending','failed']){
    collection.latest_request.state=state;
    nodes=render({redfox:true,collection});
    assert.doesNotMatch(nodes.get('material-summary').textContent,/接口返回/);
  }
});

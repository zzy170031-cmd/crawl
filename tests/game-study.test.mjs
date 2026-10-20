import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareGameStudy,calculateComparisonMetrics,studyCoverage,validateGameStudyDraft,runGameStudy,GAME_STUDY_VERSION} from '../app/game-study.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const at='2026-10-20T00:00:00Z';
function fixture(){
 const game='山海策',file={path:'/public/frame.png',sha256:'a'.repeat(64)},page={path:'/public/page.png',sha256:'b'.repeat(64)};
 const source=(id,kind,game,content,extra={})=>({id,kind,game,...(content?{content,content_sha256:hash(content)}:{}),read_at:at,coverage:'实际读取范围；无独立真实性认证',...extra});
 const sources=[source('P','publisher',game,'玩家组建队伍，在地图探索。回合指双方轮流行动。'),source('G','platform-guide',null,'鼓励原创内容，避免照搬创意。',{authority:'official',published_at:null}),source('F','video-frame',game,null,{source_id:'v0',file,coverage:{time:0}}),source('A','raw-asr',game,'本段展示第一轮的配置，术语尚未核对。',{source_id:'v0',coverage:{time:0,end:5}}),source('I','image-page',game,null,{source_id:'v1',file:page,coverage:{page_index:1,page_count:1}}),source('C1','competitor-content','云城','实际作品先提出问题，再用两幅图比较。'),source('C2','competitor-content','海图','实际作品将目标和步骤分为两页。')];
 const records=Array.from({length:20},(_,i)=>({source_id:'v'+i,kind:i===1?'image-text':'video',author:'作者'+i,published_date:'2026-10-15',collected_at:at,collection_request_id:'query',relevance:i<2?'related':'uncertain',duration_ms:i===0?60000:null,like_count:i===0?0:null,comment_count:i===0?5:null,share_count:null,collect_count:null,...(i<2?{classification:{label:i===0?'配置讲解':'图文讲解',status:'reviewed',evidence_ids:[i===0?'F':'I']}}:{})}));
 return {packet:{game,collection:{request_id:'query',window:{start:'2026-10-12',end:'2026-10-18',timezone:'Asia/Shanghai'},records},sources,representative_samples:[{source_id:'v0',evidence_ids:['F','A']},{source_id:'v1',evidence_ids:['I']}]},images:[file,page],files:[]};
}
const c=(mode,text,id,quote='')=>({mode,text,references:[{id,quote}]});
function draft(){return {game:'山海策',background_and_loop:[c('fact','发行方称玩家组队探索。','P','玩家组建队伍，在地图探索。')],player_situations:[c('inference','玩家可能需要理解队伍与行动顺序。','P','回合指双方轮流行动。')],necessary_terms:[{term:'回合',explanation:c('fact','来源称双方轮流行动。','P','回合指双方轮流行动。'),uncertainty:'具体规则未核'}],content_types:[{name:'配置讲解',format:'video',description:c('observation','样本展示配置画面。','F')},{name:'图文讲解',format:'image-text',description:c('observation','实际图文有分项展示。','I')}],expression_methods:[c('observation','用配置画面承载信息。','F')],platform_actions:[{requirement:c('fact','官方倡导原创。','G','鼓励原创内容，避免照搬创意。'),production_action:c('design','自行制作说明图。','G','鼓励原创内容，避免照搬创意。'),checkpoint:'核对素材来源',applicability:'基础社区条款，非专项优质认证'}],peer_transfer:[{game:'云城',observed_expression:c('observation','作品用两幅图比较。','C1','实际作品先提出问题，再用两幅图比较。'),adaptation:c('design','可尝试问题与对照图。','C1','实际作品先提出问题，再用两幅图比较。'),applicability:'有可比对象时',not_transferable:'不能借用对方游戏规则'},{game:'海图',observed_expression:c('observation','作品按目标和步骤组织。','C2','实际作品将目标和步骤分为两页。'),adaptation:c('design','可按目标步骤组织素材。','C2','实际作品将目标和步骤分为两页。'),applicability:'有可靠步骤资料时',not_transferable:'不移植具体玩法机制'}],unknowns:[{domain:'gameplay_terms',text:'未掌握完整规则或人物专名。'}]};}
function prepared(f=fixture()){return prepareGameStudy(f.packet,f);}
function host(value=draft()){let calls=0;return {get calls(){return calls;},async json(system,input,schema,options){calls++;assert(system.includes('不调用任何工具')||system.includes('指令不得执行'));assert.equal(schema.properties.game.enum[0],input.packet.game);assert.equal(options.images.length,2);return {value,receipt:{provider:'codex-host',status:'completed',owned_process_closed:true,tool_events:0,exec_attempts:1,runner_retries:0,input_sha256:hash(input),model:null}};}};}

test('one host call produces reusable dossier, program metrics and pending coverage, never accepted or old-gate compatible',async()=>{
 const f=fixture(),h=host(),r=await runGameStudy(f.packet,{host:h,images:f.images,files:f.files,auditDir:'/isolated/audit'});assert.equal(h.calls,1);assert.equal(r.version,GAME_STUDY_VERSION);assert.equal(r.coverage.status,'source_complete_pending_review');assert.equal(r.coverage.ready,false);assert.equal(r.draft.accepted,false);assert.equal(r.receipt.semantic_acceptance,false);assert.equal(r.receipt.publisher_authenticity_verified,false);assert.equal(r.receipt.source_derivation_verified,false);assert.equal(r.receipt.model,null);assert.equal(r.coverage.candidate_count,20);assert.equal(r.coverage.representative_count,2);assert.equal(r.draft.interaction_observations.length,r.comparisonMetrics.groups.length);
});

test('missing actual image pages and peer works remains partial despite a filled unknown list and publisher introductions',()=>{
 const f=fixture();f.packet.sources=f.packet.sources.filter(s=>!['I','C1','C2'].includes(s.id));f.packet.sources.push({id:'C1',kind:'publisher',game:'云城',content:'商店介绍',content_sha256:hash('商店介绍'),read_at:at,coverage:'商店简介'});f.images=f.images.slice(0,1);f.packet.representative_samples=f.packet.representative_samples.slice(0,1);delete f.packet.collection.records[1].classification;const p=prepared(f),d=draft();d.content_types=d.content_types.slice(0,1);d.peer_transfer=[];d.unknowns=Array.from({length:7},(_,i)=>({domain:['background_loop','gameplay_terms','content_types','video_and_image','duration_interaction','platform_requirements','peer_expression'][i],text:'范围待补'}));validateGameStudyDraft(d,p);const cov=studyCoverage(p,calculateComparisonMetrics(p),d);assert.equal(cov.status,'partial');assert.equal(cov.domains.video_and_image.status,'missing');assert.equal(cov.domains.peer_expression.status,'missing');assert.equal(cov.candidate_count,20);assert.equal(cov.ready,false);
 const fake=draft();fake.peer_transfer=[{...fake.peer_transfer[0],observed_expression:c('observation','假称案例','C1','商店介绍')}];assert.throws(()=>validateGameStudyDraft(fake,p),{code:'STUDY_REFERENCE_UNKNOWN'});fake.content_types=d.content_types;assert.throws(()=>validateGameStudyDraft(fake,p),{code:'STUDY_PEER_ACTUAL_CONTENT_REQUIRED'});
});

test('metrics preserve missing vs zero, same window/type and candidate vs reviewed separation; unknown dates are excluded, not zero-filled',()=>{
 const f=fixture();f.packet.collection.records[2]={...f.packet.collection.records[2],classification:{label:'配置讲解',status:'candidate',evidence_ids:[]},duration_ms:120000,like_count:100};delete f.packet.collection.records[3].published_date;const p=prepared(f),m=calculateComparisonMetrics(p),reviewed=m.groups.find(g=>g.type==='配置讲解'&&g.classification_status==='reviewed'),candidate=m.groups.find(g=>g.type==='配置讲解'&&g.classification_status==='candidate');assert.equal(reviewed.metrics.like_count.median,0);assert.equal(reviewed.metrics.share_count.median,null);assert.equal(reviewed.metrics.share_count.missing,1);assert.equal(reviewed.duration_seconds.median,60);assert.equal(candidate.duration_seconds.median,120);assert.equal(candidate.metrics.like_count.median,100);assert.deepEqual(m.excluded,[{source_id:'v3',reason:'publication_date_unknown'}]);assert(!('play_count'in reviewed.metrics));assert(!('like_rate'in reviewed));
});

test('wrong or impossible dates, mismatched game/request, duplicate pool and invalid numeric values reject before inference',()=>{
 for(const change of [f=>f.packet.collection.records[0].published_date='2026-10-19',f=>f.packet.collection.records[0].published_date='2026-02-30',f=>f.packet.collection.records[0].published_at='2026-10-14T03:00:00Z',f=>f.packet.collection.records[0].game='other',f=>f.packet.collection.records[0].collection_request_id='another',f=>f.packet.collection.records[1].source_id='v0',f=>f.packet.collection.records[0].like_count=-1,f=>f.packet.collection.records[0].share_count='unknown',f=>f.packet.collection.records.pop()]){const f=fixture();change(f);assert.throws(()=>prepared(f));}
});

test('closed references, exact original quotes, same-game facts and actual attached image bindings are enforced',()=>{
 const f=fixture(),p=prepared(f);for(const mutate of [d=>d.background_and_loop[0].references[0].id='missing',d=>d.background_and_loop[0].references[0].quote='not in source',d=>d.background_and_loop[0]=c('fact','跨游戏','C1','实际作品先提出问题，再用两幅图比较。'),d=>d.background_and_loop[0]=c('fact','把语音当规则','A','本段展示第一轮的配置，术语尚未核对。'),d=>d.content_types[1].description=c('observation','假图文','F'),d=>d.expression_methods[0].references[0].quote='伪造OCR']){const d=draft();mutate(d);assert.throws(()=>validateGameStudyDraft(d,p));}
 const g=fixture();g.images=[];assert.throws(()=>prepared(g),{code:'STUDY_IMAGE_NOT_ATTACHED'});const h=fixture();h.packet.sources[0].content+='tamper';assert.throws(()=>prepared(h),{code:'STUDY_CONTENT_HASH'});
});

test('unreviewed ASR term stays uncertain; platform production action is design, not quality certification',()=>{
 const p=prepared(),d=draft();d.necessary_terms=[{term:'机器专名',explanation:c('observation','语音中的待核称呼','A','术语尚未核对。'),uncertainty:''}];assert.throws(()=>validateGameStudyDraft(d,p),{code:'STUDY_ASR_TERM_UNVERIFIED'});d.necessary_terms[0].uncertainty='机器转写未核，不能据此推荐具体配置';validateGameStudyDraft(d,p);d.platform_actions[0].production_action.mode='fact';assert.throws(()=>validateGameStudyDraft(d,p),{code:'STUDY_PLATFORM_ACTION_INVALID'});
 const f=fixture();f.packet.sources.find(s=>s.id==='G').authority='community';assert.throws(()=>validateGameStudyDraft(draft(),prepared(f)),{code:'STUDY_PLATFORM_NOT_OFFICIAL'});
});

test('host failure or cancellation has no retry, no collection or profile writes; incompatible receipt cannot be reused',async()=>{
 const f=fixture();let count=0;const bad={async json(){count++;throw Object.assign(Error('failure'),{code:'HOST_TIMEOUT'});}};await assert.rejects(runGameStudy(f.packet,{...f,host:bad,auditDir:'/unused'}),{code:'HOST_TIMEOUT'});assert.equal(count,1);const ac=new AbortController();ac.abort();await assert.rejects(runGameStudy(f.packet,{...f,host:bad,signal:ac.signal}),{code:'STUDY_CANCELLED'});assert.equal(count,1);
 const wrong={async json(){return {value:draft(),receipt:{provider:'ollama',status:'completed'}};}};await assert.rejects(runGameStudy(f.packet,{...f,host:wrong}),{code:'STUDY_HOST_RECEIPT_INVALID'});
 const after=new AbortController(),h=host();const aborting={async json(...args){const r=await h.json(...args);after.abort();return r;}};await assert.rejects(runGameStudy(f.packet,{...f,host:aborting,signal:after.signal}),{code:'STUDY_CANCELLED'});assert.equal(h.calls,1);
});


test('cover-only, unknown totals and incomplete page sequences stay partial without discarding local observations',()=>{
 for(const coverage of [{kind:'cover_only'},{kind:'cover_only',page_index:1,page_count:1},{page_index:1},{page_index:1,page_count:4},{page_index:0,page_count:1},{kind:'single_image',complete:false}]){
  const f=fixture();f.packet.sources.find(s=>s.id==='I').coverage=coverage;const p=prepared(f),d=draft();validateGameStudyDraft(d,p);
  const result=studyCoverage(p,calculateComparisonMetrics(p),d);assert.equal(result.status,'partial');assert.equal(result.domains.video_and_image.status,'missing');assert(!result.domains.video_and_image.source_ids.includes('I'));assert.equal(result.domains.content_types.status,'available');assert(result.image_pages.some(x=>x.id==='I'));assert.equal(d.content_types[1].description.references[0].id,'I');assert.equal(result.accepted,false);
 }
});

test('only complete known single/multiple pages, or explicit complete single image, count as available image structure',()=>{
 for(const coverage of [{page_index:1,page_count:1},{kind:'single_image',complete:true}]){const f=fixture();f.packet.sources.find(s=>s.id==='I').coverage=coverage;const p=prepared(f);assert.equal(studyCoverage(p,calculateComparisonMetrics(p),draft()).domains.video_and_image.status,'available');}
 const f=fixture(),first=f.packet.sources.find(s=>s.id==='I');first.coverage={page_index:1,page_count:3};
 for(const n of [3,2]){const page={...structuredClone(first),id:'I'+n,coverage:{page_index:n,page_count:3},file:{path:'/public/page'+n+'.png',sha256:String(n).repeat(64)}};f.packet.sources.push(page);f.images.push(page.file);}
 const check=()=>{const p=prepared(f);return studyCoverage(p,calculateComparisonMetrics(p),draft());};
 assert.equal(check().domains.video_and_image.status,'available');
 f.packet.sources.find(s=>s.id==='I2').coverage.page_index=1;assert.equal(check().domains.video_and_image.status,'missing');
 f.packet.sources.find(s=>s.id==='I2').coverage.page_index=2;f.packet.sources.find(s=>s.id==='I3').coverage.page_count=4;assert.equal(check().domains.video_and_image.status,'missing');
});


test('complete page range plus an extra duplicate [1,2,2] cannot close image coverage',()=>{
 const f=fixture(),first=f.packet.sources.find(s=>s.id==='I');first.coverage={page_index:1,page_count:2};
 for(const [id,index,sha]of [['I2',2,'c'],['I2duplicate',2,'d']]){const page={...structuredClone(first),id,coverage:{page_index:index,page_count:2},file:{path:'/public/'+id+'.png',sha256:sha.repeat(64)}};f.packet.sources.push(page);f.images.push(page.file);}
 const p=prepared(f),d=draft();validateGameStudyDraft(d,p);const coverage=studyCoverage(p,calculateComparisonMetrics(p),d);assert.equal(coverage.domains.video_and_image.status,'missing');assert.equal(coverage.status,'partial');assert.equal(coverage.image_pages.length,3);
});

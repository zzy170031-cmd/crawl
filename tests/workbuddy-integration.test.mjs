// These tests exercise the real file bridge with controlled replies, not a
// desktop model session. They certify binding/lifecycle, never creative quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Tasks,hash} from '../app/tasks.mjs';
import {WorkbuddyHost,workbuddyRequests,readWorkbuddyRequest,submitWorkbuddyResponse} from '../app/workbuddy-host.mjs';
import {runCreativeCandidate,CREATIVE_PRODUCTION_HEADER} from '../app/creative-candidate.mjs';
import {createCreativeTaskRunner} from '../app/creative-task.mjs';
import {createCreativeRuntime} from '../app/creative-runtime.mjs';
import {createNetworkStudyRuntime} from '../app/study-runtime.mjs';
import {createStudyTaskRunner} from '../app/study-task.mjs';
import {runGameStudy} from '../app/game-study.mjs';
import {createStudyEvidenceReader} from '../app/study-evidence-reader.mjs';
import {fixture,output,PNG} from './helpers/creative-fixture.mjs';

function temporary(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'workbuddy-integration-')));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
async function pending(root,kind){for(let i=0;i<300;i++){const found=workbuddyRequests(root).filter(x=>x.kind===kind);if(found.length===1)return readWorkbuddyRequest(root,kind,found[0].id);assert(found.length<=1);await delay(10);}assert.fail('No bounded WorkBuddy request became available');}
function submit(root,q,value){return submitWorkbuddyResponse(root,q.kind,q.id,{nonce:q.nonce,input_sha256:q.input_sha256,request_sha256:q.request_sha256,value});}
function assertUnacceptedReceipt(receipt){assert.equal(receipt.provider,'workbuddy-skill');assert.equal(receipt.status,'completed');assert.equal(receipt.submission_count,1);assert.equal(receipt.accepted,false);assert.equal(receipt.semantic_status,'not_evaluated');assert.equal(receipt.tool_events,null);assert.equal(receipt.tool_audit_status,'not_observed');assert.equal(receipt.exec_attempts,0);assert.equal(receipt.exit_code,null);}

for(const mode of ['A','B'])test(`real WorkBuddy file request/reply persists ${mode} creative task with five columns and no acceptance`,async t=>{
 const f=fixture(t),folder=join(f.root,'creative-candidate-tasks');mkdirSync(join(folder,'audits'),{recursive:true});
 const db=new Tasks(folder);t.after(()=>db.close());const host=new WorkbuddyHost({allowedSourceRoot:f.root,pollMs:5,timeoutMs:5000});
 f.input.mode=mode;const query='22222222-2222-4222-8222-222222222222';f.input.selected.row.collection_request_id=query;f.input.selected.collection.request_id=query;
 const runner=createCreativeTaskRunner({db,captureInput:async()=>f.input,prepareInput:async captured=>captured,revalidateInput:async()=>true,runCandidate:(input,ctx)=>runCreativeCandidate(input,{host,dataRoot:f.root,auditDir:join(folder,'audits',ctx.taskId),signal:ctx.signal})});
 const task=await runner.create({game:f.input.game,mode,format:'video',study_task_id:f.study.binding.task_id,profile_version:f.study.binding.profile_version,source:{provider:'redfox',request_id:query,source_id:f.input.selected.row.source_id}});
 const completed=runner.run(task.id),q=await pending(f.root,'creative-candidate-tasks');
 assert.equal(q.id,task.id);assert.equal(q.input.mode,mode);assert(q.schema.properties.plan.properties.ideas.items.properties.shots.items.required.includes('production_content'));assert(q.images.length>=3);assert(q.images.every(im=>hash(readFileSync(im.path))===im.sha256));assert(q.sources.length>0);
 const reply=submit(f.root,q,output(f.input.game));assert.deepEqual(reply,{status:'submitted',semantic_acceptance:false});const done=await completed;
 assert.equal(done.state,'completed');assert.equal(done.result.accepted,false);assert.equal(done.result.ready,false);assert.equal(done.result.delivery_enabled,false);assert.equal(done.result.draft.rows[0][4],CREATIVE_PRODUCTION_HEADER);assert(done.result.draft.rows.every(row=>row.length===5));assert(done.result.draft.rows.some(row=>row[4].includes('你先选。我留在这里，等你回来。')));
 const receipt=JSON.parse(readFileSync(join(folder,'audits',task.id,'receipt.json'),'utf8'));assertUnacceptedReceipt(receipt);assert.equal(workbuddyRequests(f.root).length,0);
});

test('real WorkBuddy study task preserves its actual file receipt through fixed evidence read-back',async t=>{
 const root=temporary(t),folder=join(root,'game-study-tasks');mkdirSync(join(folder,'audits'),{recursive:true});const db=new Tasks(folder);t.after(()=>db.close());
 const game='受控测试游戏',at='2026-10-20T00:00:00Z',id='7695600881273670946',sha='a'.repeat(64),fp='b'.repeat(64),content='游戏采用轮流行动，玩家需要选择下一步。';
 const file={path:join(root,'publisher.txt'),sha256:hash(content)},image={path:join(root,'sample.png'),sha256:hash(PNG)};writeFileSync(file.path,content);writeFileSync(image.path,PNG);
 const origin={provider:'redfox',source_id:id,game,kind:'video',title:'受控来源',source_url:'https://www.douyin.com/video/'+id,collection_request_id:'fixed-query',collected_at:at,uploaded_at:null,published_at:null,published_date:null,publication_date:null,like_count:null,share_count:null,comment_count:null,collect_count:null,duration_ms:1000};
 const row={...origin,origins:[origin],sha256:sha,availability:'available',library_id:'media_'+sha},library={game,binding:{source_provider:'game_study_library',game,library_id:'library_'+fp,library_fingerprint:fp,collection:{source_provider:'redfox',collection_request_id:'fixed-query',collection_fingerprint:'c'.repeat(64),collected_at:at,window:{start_date:'2026-10-12',end_date:'2026-10-19',update_policy:'T+1'}}},records:[row],items:[]};
 const packet={game,learning_source:'network',library:{binding:library.binding,records:library.records},sources:[{id:'P',game,kind:'publisher',content,content_sha256:file.sha256,file,read_at:at,coverage:'saved original text'},{id:'F',game,kind:'video-frame',source_id:id,file:image,read_at:at,coverage:{time:0}}],representative_samples:[{source_id:id,evidence_ids:['F']}]};
 const draft={game,background_and_loop:[{mode:'fact',text:'游戏采用轮流行动。',references:[{id:'P',quote:'游戏采用轮流行动'}]}],player_situations:[],necessary_terms:[],content_types:[{name:'选择展示',format:'video',description:{mode:'observation',text:'受控画面样本展示一个画面。',references:[{id:'F',quote:''}]}}],expression_methods:[],platform_actions:[],peer_transfer:[],unknowns:[]};
 const host=new WorkbuddyHost({allowedSourceRoot:root,pollMs:5,timeoutMs:5000}),runner=createStudyTaskRunner({db,captureInput:async()=>library,preparePacket:async()=>({packet,images:[image],files:[file]}),revalidateInput:async()=>true,runStudy:(p,ctx)=>runGameStudy(p,{...ctx,host,auditDir:join(folder,'audits',ctx.taskId)})});
 const task=await runner.create({game,learning_source:'network'}),running=runner.run(task.id),q=await pending(root,'game-study-tasks');
 assert.equal(q.input.packet.game,game);assert.equal(q.schema.properties.game.enum[0],game);assert.equal(q.images.length,1);assert.equal(q.images[0].sha256,hash(readFileSync(q.images[0].path)));assert.equal(q.sources[0].sha256,file.sha256);submit(root,q,draft);
 const done=await running;assert.equal(done.state,'completed');assert.equal(done.result.accepted,false);assert.equal(done.result.ready,false);
 const reader=createStudyEvidenceReader({db,dataRoot:root}),fixed=await reader.read({game,taskId:task.id,profileVersion:done.result.profile_version});
 assert.equal(fixed.packet.sources[0].content,content);assert.equal(fixed.images[0].sha256,image.sha256);assert.equal(fixed.profile.accepted,false);assert.equal(fixed.binding.task_id,task.id);const receipt=JSON.parse(readFileSync(join(folder,'audits',task.id,'receipt.json'),'utf8'));assertUnacceptedReceipt(receipt);
 writeFileSync(image.path,'changed');await assert.rejects(reader.read({game,taskId:task.id,profileVersion:done.result.profile_version}),{code:'STUDY_EVIDENCE_HASH'});
});

for(const provider of ['workbuddy','unknown-provider','codex'])test(`real runtime ${provider} configuration uses no substitute host and rejects unsupported/missing CLI`,async t=>{
 const root=temporary(t),expected=provider==='workbuddy';let studyReads=0,creativeReads=0;const marker=()=>{throw Object.assign(Error('Reached captured source reader, not media'),{code:'CONTROLLED_SOURCE_STOP'});};
 const study=createNetworkStudyRuntime({dataRoot:join(root,'study'),hostProvider:provider,python:'python3',isEnabled:()=>true,getCurrentCollection:async()=>{studyReads++;marker();},readCapturedCollection:async()=>assert.fail('No source replay should run'),assets:{read:async()=>assert.fail('No paid media should run')}});
 const creative=createCreativeRuntime({dataRoot:join(root,'creative'),hostProvider:provider,python:'python3',isEnabled:()=>true,getStudyEvidence:async()=>{creativeReads++;marker();},getSource:async()=>assert.fail('No source fetch should run'),assets:{read:async()=>assert.fail('No paid media should run')}});
 t.after(async()=>{await study.close();await creative.close();});assert.equal(study.configured(),expected);assert.equal(creative.configured(),expected);
 await assert.rejects(study.start({game:'测试游戏',learning_source:'network'}),{code:expected?'STUDY_CURRENT_COLLECTION_REQUIRED':'STUDY_HOST_CONFIGURATION_REQUIRED'});
 await assert.rejects(creative.start({game:'测试游戏',mode:'A',format:'video',study_task_id:'11111111-1111-4111-8111-111111111111',profile_version:'b'.repeat(64),source:{provider:'redfox',request_id:'22222222-2222-4222-8222-222222222222',source_id:'7695600881273670946'}}),{code:expected?'CONTROLLED_SOURCE_STOP':'CREATIVE_HOST_CONFIGURATION_REQUIRED'});
 assert.equal(studyReads,expected?1:0);assert.equal(creativeReads,expected?1:0);
});

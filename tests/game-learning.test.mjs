import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks} from '../app/tasks.mjs';
import {ContentGroups} from '../app/content-groups.mjs';
import {runGameLearning,validateLearningSummary} from '../app/game-learning.mjs';
import {gameReference} from '../app/game-reference.mjs';
const game='率土之滨';
const source={id:'web:appstore:123',kind:'web',content:'与玩家组建同盟',url:'https://apps.apple.com/cn/app/id123',read_at:'2026-10-19T00:00:00Z'};
const summary={summary:'游戏语境',game_facts:[{text:'发行方介绍支持同盟协作',evidence_id:source.id,quote:'组建同盟'}],player_interests:[{text:"玩家关注",evidence_ids:["video:7696356432198913301"]}],creative_methods:[{text:"表达方法",evidence_ids:["video:7696356432198913301"]}],unknowns:[]};
const snapshot={provenance:{game,request_id:'receipt-1'},records:Array.from({length:21},(_,i)=>({kind:'video',provider:'redfox',source_id:String(7696356432198913300n+BigInt(i)),author:'作者'+i,title:'标题'+i}))};
function card(row){return {id:'video:'+row.source_id,kind:'video',source_id:row.source_id,read_at:'2026-10-18T01:00:00Z',pipeline_version:'extractive-learning-1',counts_as_relevant:true,summary_quality:{status:'source_bound'},machine_output:{version:'learning-extractive-evidence-3'},learning_notes:[{suggested_action:'保留对象原文',possible_benefit:'便于回看',boundary:'未测效果',time:1,evidence_id:'F1_T',quote:'对象'}],learning_card:{summary:'实际观察',content_type:'讨论',quality_notes:[]},analysis:{needs_audio_review:true}};}
async function setup(t){const folder=await mkdtemp(join(tmpdir(),'game-learning-')),db=new Tasks(folder);t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});return {db,groups:new ContentGroups(db),game,model:{json:async()=>structuredClone(summary)},identity:{name:'fixture',digest:'fixture'},stage:()=>{}};}
test('bound learning skips missing originals, needs no bridge or paid calls, persists 20 preliminary groups but cannot clear server quality hold',async t=>{
 const ctx=await setup(t);let read=0;const options={fingerprint:async r=>'fp:'+r.source_id,readMedia:async r=>{read++;if(r.source_id===snapshot.records[0].source_id){const e=Error('missing');e.code='MEDIA_ASSET_REQUIRED';throw e;}return card(r);},reference:async()=>[source]};
 const p=await runGameLearning(snapshot,ctx,options);assert.equal(p.status,'needs_input');assert.equal(p.experimental_quality_hold.active,true);assert(p.blocking_gaps.some(g=>g.includes('摘要忠实性')));assert.equal(p.independent_content_count,20);assert.equal(p.progress.verified_count,0);assert.equal(p.unavailable_sources.length,1);assert(p.evidence.filter(x=>x.kind==='video').every(x=>x.analysis.needs_audio_review));assert(ctx.db.checkpoint('game-profile-version:'+p.version));
 const again=await runGameLearning(snapshot,ctx,options);assert.equal(again.progress.reused_count,20);assert.equal(read,22);assert(again.evidence.filter(x=>x.kind==='video').every(x=>x.read_at==='2026-10-18T01:00:00Z'));
});
test('same theme, unavailable and unknown source remain partial rather than quota filling',async t=>{
 const ctx=await setup(t);const p=await runGameLearning(snapshot,ctx,{fingerprint:async()=>null,readMedia:async r=>({...card(r),counts_as_relevant:false}),reference:async()=>[]});assert.equal(p.status,'needs_input');assert.equal(p.independent_content_count,0);assert.equal(p.sample_coverage.read,21);assert.equal(p.game_facts.length,0);
 await assert.rejects(runGameLearning(snapshot,{...ctx,game:'其他游戏'}),/批次/);
});
test('cancellation preserves completed evidence checkpoints but never publishes a partial profile as ready',async t=>{
 const ctx=await setup(t),controller=new AbortController();let calls=0;
 await assert.rejects(runGameLearning(snapshot,{...ctx,signal:controller.signal},{fingerprint:async r=>'fp:'+r.source_id,readMedia:async r=>{if(++calls===2)controller.abort(Error('cancelled'));return card(r);},reference:async()=>[source]}),/cancelled/);assert.equal(ctx.db.profile(game),null);assert.equal(calls,2);
});
test('summary rejects invented facts, wrong sources and machine-irrelevant content',()=>{
 assert.throws(()=>validateLearningSummary({...summary,game_facts:[{text:'invented',evidence_id:source.id,quote:'自动抽卡'}]},[source]),/原句/);
 assert.throws(()=>validateLearningSummary({...summary,creative_methods:[{text:'fake',evidence_ids:['video:wrong']}]},[source]),/相关性/);
});
test('empty cognition text cannot pass readiness with valid citations',async t=>{
 const evidence=[source,{id:summary.player_interests[0].evidence_ids[0],counts_as_relevant:true}];
 for(const field of ['summary','game_facts','player_interests','creative_methods']){
   const empty=structuredClone(summary);if(field==='summary')empty.summary=' ';else empty[field][0].text='\n ';
   assert.throws(()=>validateLearningSummary(empty,evidence),/正文|不能为空/);
 }
 const ctx=await setup(t);ctx.model.json=async()=>{throw Error('overview must not rewrite the source with a model');};
 const p=await runGameLearning(snapshot,ctx,{fingerprint:async()=>null,readMedia:async r=>card(r),reference:async()=>[source]});
 assert.equal(p.independent_content_count,21);assert.equal(p.status,'needs_input');assert(!p.blocking_gaps.some(g=>g.includes('汇总未通过')));assert.equal(p.game_facts[0].quote,source.content);
});
test('historical consistent free summaries cannot count toward the new preliminary profile',async t=>{
 const ctx=await setup(t);const p=await runGameLearning(snapshot,ctx,{fingerprint:async()=>null,readMedia:async r=>({...card(r),pipeline_version:undefined,summary_quality:{status:'consistent'}}),reference:async()=>[source]});
 assert.equal(p.independent_content_count,0);assert.equal(p.player_interests.length,0);assert(p.evidence.filter(e=>e.kind==='video').every(e=>e.counts_as_relevant===false));
});
test('public reference matches one exact game only, does not mistake related titles for official identity',async()=>{
 const row={kind:'software',primaryGenreName:'Games',trackName:game,trackId:123,trackViewUrl:'https://apps.apple.com/cn/app/id123',artistName:'发行方',description:'组建同盟'};
 const fetchImpl=async u=>{assert.equal(u.hostname,'itunes.apple.com');assert.equal(u.searchParams.get('term'),game);return new Response(JSON.stringify({results:[{...row,trackName:'云·'+game},row]}));};
 const result=await gameReference(game,{fetchImpl});assert.equal(result.length,1);assert.equal(result[0].publisher,'发行方');
 assert.deepEqual(await gameReference(game,{fetchImpl:async()=>new Response(JSON.stringify({results:[{...row,trackName:'其他游戏'}]}))}),[]);
 assert.deepEqual(await gameReference(game,{fetchImpl:async()=>new Response(JSON.stringify({results:[row,row]}))}),[]);
});

test('default owned learning roles are disposed once on return or cancellation; caller-owned roles are not disposed',async t=>{
 const empty={...snapshot,records:[]};let created=0,disposed=0;
 const model={json:async()=>assert.fail('empty snapshot must not infer')},roles={vision:model,analysis:model,visionIdentity:{name:'fixture',digest:'v'},analysisIdentity:{name:'fixture',digest:'v'},cacheIdentity:{version:'fixture'},dispose:async(...args)=>{assert.deepEqual(args,[],'cleanup must not receive the cancelled task signal');disposed++;}};
 const createModels=async()=>{created++;return roles;};
 const ctx=await setup(t);delete ctx.model;delete ctx.identity;
 await runGameLearning(empty,ctx,{reference:async()=>[],createModels});assert.equal(created,1);assert.equal(disposed,1);
 const controller=new AbortController();
 await assert.rejects(runGameLearning(empty,{...ctx,signal:controller.signal,saveProgress:()=>{controller.abort(Error('cancel-owned'));throw controller.signal.reason;}},{reference:async()=>[],createModels}),/cancel-owned/);assert.equal(created,2);assert.equal(disposed,2);
 await runGameLearning(empty,{...ctx,visionModel:model,analysisModel:model,visionIdentity:roles.visionIdentity,analysisIdentity:roles.analysisIdentity},{reference:async()=>[],createModels:()=>assert.fail('explicit roles must be borrowed')});assert.equal(disposed,2);
});

import {pixelWitnessBasis} from '../app/learning-pixel-witness.mjs';
import {pixelFixture,pixelFixtureReadings} from './learning-pixel-fixture.mjs';
import {captionFixture} from './learning-caption-fixture.mjs';
import {createHash} from 'node:crypto';
import {learningStageSemanticKey,LEARNING_STAGE_SEMANTICS,learningReferenceQuotes,learningCaptionTags,captionTagAmbiguity,buildDisplayedUIUnits,learningSectionScope,pixelIdentityProjection} from '../app/learning-topic-stages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateLearningContract,serverLearningBinding,validateLearningTaskBinding,validateLearningRoles,validateLearningCard,bindLearningCard,validateLearningProfile} from '../app/learning-contract.mjs';
import {qualityCapabilities,qualityExecutionAllowed,projectQualityHeldProfile} from '../app/quality-policy.mjs';
import {hash} from '../app/tasks.mjs';
const contract=candidateLearningContract(),spec=contract.spec;
const copy=value=>structuredClone(value);
export function contractRoles(){return {vision_identity:copy(spec.vision.identity),analysis_identity:copy(spec.analysis.identity),parameters:{version:spec.roles,vision:copy(spec.vision),analysis:copy(spec.analysis)}};}
export function contractSnapshot(count=20){return {binding:{source_provider:'redfox',collection_request_id:'server-receipt',collection_fingerprint:hash('real-receipt')},provenance:{game:'测试游戏',provider:'redfox',request_id:'server-receipt'},records:Array.from({length:count},(_,i)=>({source_id:String(i+1),kind:'video',provider:'redfox',title:'标题不是学习证据'}))};}
export function contractCard(sourceId){
  const roles=contractRoles();
  const card={target_game:'测试游戏',id:'video:'+sourceId,source_id:sourceId,kind:'video',media_hash:hash('original:'+sourceId),counts_as_relevant:true,pipeline_version:spec.card_pipeline,display_version:spec.display,
    machine_output:{binding_projection:{version:spec.binding_projection,status:'projection_applied',inference:'stage_inference_per_receipt',reason_usage:'audit_only_not_knowledge',boundary:'controlled projection limitation'},stages_version:spec.stages.version,code_sha256:spec.stages.code_sha256,stages:['scope_hint','literal_grounding','relation'].map(name=>({name,checkpoint:'fixture:'+name,raw_sha256:hash(name),input_sha256:hash('input:'+name)})),vision_prompt_version:spec.vision_prompt,version:spec.selection,display_version:spec.display,visual_identity:copy(spec.vision.identity),analysis_identity:copy(spec.analysis.identity),vision_parameters:roles.parameters.vision,inference_parameters:roles.parameters.analysis,vision_parameters_sha256:hash(roles.parameters.vision),parameters_sha256:hash(roles.parameters.analysis)},model_roles:roles,
    summary_quality:{status:'source_bound',human_reviewed:false,pipeline_version:spec.card_pipeline,catalog_sha256:hash('catalog:'+sourceId)},
    expression_observations:{version:spec.observations,source_id:sourceId,media_hash:hash('original:'+sourceId),input_sha256:hash('observed:'+sourceId),status:'observed',observations:[{observation:'画面出现编号标题',possible_viewer_benefit:'项目判断：便于定位',limitation:'不代表内容准确',evidence:[{id:'F0_T',quote:'第一组 配置主题',time:0}]}]},
    topic:{quotes:[{quote:'配置主题',time:0,evidence_id:'F0_T'}]},learning_card:{game_relevance:'relevant',relationship_type:'direct_game',relevance_basis:[{source_id:sourceId,quote:'配置主题',time:0}],blocking_gaps:[],content_type:'操作配置讲解',summary:'原文索引',quality_notes:[]},analysis:{needs_audio_review:true}};
  const jsonHash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const rows=[['F0_T',0,'ocr','配置主题'],['F0_V',0,'visual_description','配置主题的实际游戏UI'],['F1_T',10,'ocr','配置主题'],['F1_V',10,'visual_description','角色详细配置UI']],bounds=[['F0_T',null,0,null],['F0_V',null,0,null],['F1_T',null,1,null],['F1_V',null,1,null]];
  card.subtitle_review={ocr_readings:[{source_id:sourceId,time:0,visible_text:rows[0][3],visible_content:rows[1][3]},{source_id:sourceId,time:10,visible_text:rows[2][3],visible_content:rows[3][3]}]};card.transcript={raw_segments:[]};
  const refs=[{id:'web:appstore:1',kind:'web',game:'测试游戏',title:'测试游戏',publisher:'fixture',url:'https://apps.apple.com/cn/app/id1',content:'配置主题的实际游戏UI',content_sha256:hash('配置主题的实际游戏UI'),source_type:'publisher_store_description',version:null,read_at:null,scope:'发行方介绍不是原片证据'}];
  const base={evidence:rows,source_boundaries:bounds};
  const audit=(name,input,raw)=>{const d={name,semantic_version:LEARNING_STAGE_SEMANTICS[name],source_id:sourceId,media_hash:card.media_hash,source_rows_sha256:jsonHash({sources:rows,boundaries:bounds}),visual_identity:copy(spec.vision.identity),analysis_identity:copy(spec.analysis.identity),inference_parameters:copy(spec.analysis),parameters_sha256:jsonHash(spec.analysis),prompt:'fixture',schema:{type:'object'},input,dependencies:[]};Object.assign(d,{input_sha256:jsonHash(input),schema_sha256:jsonHash(d.schema),prompt_sha256:jsonHash(d.prompt)});const key=learningStageSemanticKey(d);return {checkpoint:key+':attempt:initial',status:'valid',descriptor:d,raw_output:raw,raw_sha256:jsonHash(raw)};};
  const proposals=[{quote:'配置主题',role:'primary',basis_ids:['F0_V']}];const primary=audit('literal_grounding',{...base,task:'literal_grounding',literal_topics:[['配置主题','F0_T','ocr',0,4]]},{subjects:proposals});
  const caption=captionFixture(sourceId,'测试游戏'),tags=learningCaptionTags(caption),exactTag=tags[0];
  const raw={status:'source_declared_visual_supported',ui_support:'specific_compatible',visual_ids:['F0_V','F1_V'],object_quotes:['配置主题'],other_game_tags:[],other_game_names:'none',matches:[],reason:'controlled source declaration UI support'};const target=audit('target_identity',{...base,task:'target_identity',target_game:'测试游戏',target_references:refs,reference_quotes:learningReferenceQuotes(refs),caption_receipt:caption,caption_tags:tags,exact_target_tag:exactTag,object_quotes:[['配置主题','F0_T',0],['配置主题','F1_T',10]]},raw);
  card.raw_relation_selection={relationship_type:'游戏画面',relevance_ids:['F0_V']};
  card.primary_topic={section_scope:learningSectionScope([],[]),status:'machine_located',source_assignment:'program_candidate_occurrence_not_model_selected',proposals,bindings:[{quote:'配置主题',source_id:'F0_T',time:0,start:0,end:4,occurrences:[]}],receipt:primary};card.target_identity={...raw,caption_tag_assessment:captionTagAmbiguity(caption,'测试游戏'),reason_usage:'audit_only_not_knowledge',target_game:'测试游戏',matched:false,supported:true,evidence_level:'source_declared_visual_supported',source_caption_receipt:caption,source_caption_sha256:jsonHash(caption),exact_target_tag:exactTag,source_id:sourceId,media_hash:card.media_hash,references:refs,references_sha256:jsonHash(refs),receipt:target};
  const units=buildDisplayedUIUnits(rows.map((r,i)=>({id:r[0],time:r[1],kind:r[2],text:r[3],frame_index:Math.floor(i/2)})),[{kind:'ocr',text:'配置主题',parent_id:'F0_T',time:0,start:0,end:4,occurrences:[{parent_id:'F1_T',time:10,start:0,end:4}]}]);
  const uiRaw={form:'displayed_game_ui',support_unit_ids:units.filter(u=>u.object_quote).map(u=>u.id)},uiAudit=audit('displayed_ui_support',{...base,evidence_columns:['id','time','kind','unaltered_text'],task:'displayed_ui_support',support_units:units},uiRaw);
  Object.assign(card.target_identity,{binding_status:'source_declared_visual_supported',support_source:'program_caption_plus_blind_displayed_ui_not_old_identity_positive',displayed_ui_support:{usage:'proposal_only_not_pixel_confirmation',excluded_frames:[],...uiRaw,supported:true,selected_units:units.filter(u=>u.object_quote),receipt:uiAudit,source_id:sourceId,media_hash:card.media_hash}});
  card.machine_output.stages=[card.machine_output.stages[0],{name:'literal_grounding',checkpoint:primary.checkpoint,semantic_key:learningStageSemanticKey(primary.descriptor),raw_sha256:primary.raw_sha256,input_sha256:primary.descriptor.input_sha256},card.machine_output.stages[2],{name:'target_identity',checkpoint:target.checkpoint,semantic_key:learningStageSemanticKey(target.descriptor),raw_sha256:target.raw_sha256,input_sha256:target.descriptor.input_sha256},{name:'displayed_ui_support',checkpoint:uiAudit.checkpoint,semantic_key:learningStageSemanticKey(uiAudit.descriptor),raw_sha256:uiAudit.raw_sha256,input_sha256:uiAudit.descriptor.input_sha256}];
  card.subtitle_review.ocr_readings=pixelFixtureReadings(card.subtitle_review.ocr_readings);
  card.target_identity.pixel_witness=pixelFixture(card.target_identity.displayed_ui_support.selected_units,{sourceId,mediaHash:card.media_hash,readings:card.subtitle_review.ocr_readings});
  card.target_identity.v18_audit={raw_target_identity:copy(raw),target_identity_receipt:copy(target),raw_identity_usage:'audit_only_not_pixel_confirmation'};
  for(const key of Object.keys(raw))delete card.target_identity[key];
  Object.assign(card.target_identity,pixelIdentityProjection(card.target_identity.pixel_witness,raw,exactTag,captionTagAmbiguity(caption,'测试游戏')));
  card.machine_output.pixel_witness_version=spec.pixel_witness.version;
  card.learning_card.relevance_basis=pixelWitnessBasis(card.target_identity.pixel_witness,sourceId);
  return card;

}
function profile(count=20){
 const snapshot=contractSnapshot(count),task=serverLearningBinding(snapshot),bindings=snapshot.records.map(r=>({source_id:r.source_id,fingerprint:hash('fp:'+r.source_id),group_key:'group:'+r.source_id}));
 const videos=snapshot.records.map((r,i)=>bindLearningCard(contractCard(r.source_id),{sourceFingerprint:bindings[i].fingerprint,groupKey:bindings[i].group_key}));
 return {game:snapshot.provenance.game,pipeline_version:spec.pipeline,overview_version:spec.overview,learning_task_binding:task,learning_collection_records:snapshot.records,learning_source_bindings:bindings,collection_origin:snapshot.provenance,model_roles:contractRoles(),evidence:[...videos,{id:'web:publisher',kind:'web',content:'发行方原文介绍'}],game_facts:[{text:'介绍原文',quote:'发行方原文介绍',evidence_ids:['web:publisher']}],content_distribution:[{object_examples:[{text:'配置主题',time:0,evidence_id:'video:1'}]}],creative_methods:[{text:'画面出现编号标题。不代表内容准确',evidence_ids:['video:1']}],independent_content_count:count,sample_coverage:{relevant:count},status:'ready',blocking_gaps:[]};
}
test('fixed candidate is immutable, not accepted, and 20 fully bound mock cards do not grant any execution',()=>{
 const p=profile();assert.deepEqual(validateLearningProfile(p).issues,[]);assert.equal(validateLearningProfile(p).valid,true);
 assert.equal(contract.accepted,false);assert.throws(()=>{contract.spec.vision.runtime.version='999';},TypeError);
 for(const type of ['learn','create','delivery'])assert.equal(qualityExecutionAllowed(type,{...p.learning_task_binding,accepted:true}),false);
 assert.equal(qualityCapabilities().learning.enabled,false);assert.equal(qualityCapabilities().creation.enabled,false);assert.equal(qualityCapabilities().delivery.enabled,false);
 const projection=projectQualityHeldProfile(p);assert.equal(projection.status,'needs_input');assert.equal(projection.experimental_quality_hold.active,true);assert.equal(projection.candidate_contract_check.valid,true);assert.equal(p.status,'ready');
});
test('server stamps receipt data; a client ID, old retry, changed snapshot or forged source cannot upgrade a task',()=>{
 const snapshot=contractSnapshot(),binding=serverLearningBinding(snapshot);assert(validateLearningTaskBinding(binding,snapshot).valid);
 const fromClient={game:'other',learning_contract_id:contract.id,accepted:true};assert.equal(validateLearningTaskBinding(fromClient,snapshot).valid,false);
 for(const mutate of [b=>{b.learning_contract_id='old';},b=>{b.collection_fingerprint=hash('other');},b=>{delete b.learning_source;},b=>{b.learning_source.records_sha256=hash('other');}]){const altered=copy(binding);mutate(altered);assert.equal(validateLearningTaskBinding(altered,snapshot).valid,false);}
 const changed=copy(snapshot);changed.records[0].title='updated source';assert.equal(validateLearningTaskBinding(binding,changed).valid,false);
 assert.equal(serverLearningBinding(snapshot).game,'测试游戏');assert.equal(binding.accepted,undefined);
});
test('weight, runtime, role and effective request parameters must match actual fixed roles',()=>{
 assert(validateLearningRoles(contractRoles()).valid);
 for(const mutate of [r=>r.vision_identity.digest='old-weight',r=>r.parameters.analysis.runtime.version='0.30.6',r=>r.parameters.vision.inference.effective_prefill=true,r=>r.parameters.analysis.inference.maxTokens=1600,r=>r.parameters.vision.inference.thinking=true,r=>r.parameters.analysis.inference.temperature=0.7,r=>r.parameters.version='roles-1']){
  const roles=contractRoles();mutate(roles);assert.equal(validateLearningRoles(roles).valid,false);
 }
});
test('one old or changed relevant card fails the entire candidate profile despite 20 and a current contract ID',()=>{
 for(const mutate of [p=>p.evidence[19].machine_output.version='learning-extractive-evidence-3',p=>p.evidence[19].machine_output.visual_identity.name='qwen3-vl:8b-instruct',p=>p.evidence[19].expression_observations.version='learning-expression-observations-1',p=>p.evidence[19].machine_output.inference_parameters.runtime.version='0.30.6',p=>p.evidence[19].summary_quality.human_reviewed=true,p=>p.evidence[19].machine_output.vision_prompt_version='learning-media-2',p=>p.evidence[19].learning_card.relationship_type='same_theme']){
  const p=profile();mutate(p);assert.equal(validateLearningProfile(p).valid,false);assert.equal(projectQualityHeldProfile(p).status,'needs_input');
 }
});
test('current source hashes and server content groups, not asserted counts, determine candidate minimum',()=>{
 assert.equal(validateLearningProfile(profile(19)).valid,false);
 const p=profile();p.learning_source_bindings[19].group_key='group:1';p.evidence[19]=bindLearningCard(p.evidence[19],{sourceFingerprint:p.learning_source_bindings[19].fingerprint,groupKey:'group:1'});
 const result=validateLearningProfile(p);assert.equal(result.independent_content_count,19);assert(result.issues.includes('MINIMUM_INDEPENDENT_CONTENT'));assert(result.issues.includes('PROFILE_COUNT_MISMATCH'));
 for(const mutate of [x=>x.learning_source_bindings[0].fingerprint=hash('changed'),x=>x.evidence[0].media_hash=hash('new file'),x=>x.learning_collection_records[0].source_id='outside',x=>x.evidence.push(copy(x.evidence[0]))]){const changed=profile();mutate(changed);assert.equal(validateLearningProfile(changed).valid,false);}
});
test('old evidence cannot be relabelled with a new binding and cached parameter hash cannot be forged independently',()=>{
 const card=contractCard('1');card.machine_output.vision_parameters_sha256=hash('fake');assert.equal(validateLearningCard(card).valid,false);assert.throws(()=>bindLearningCard(card,{sourceFingerprint:hash('fp'),groupKey:'g'}),/候选合同/);
 const old=profile();delete old.learning_task_binding;delete old.learning_source_bindings;assert.equal(validateLearningProfile(old).valid,false);
});
test('game intro, concrete topic direction and real current expression observations are separate requirements',()=>{
 for(const mutate of [p=>p.game_facts=[],p=>p.game_facts[0].quote='模型补造',p=>p.content_distribution=[{type:'分类',count:20,object_examples:[]}],p=>p.creative_methods=[{text:'固定回看建议',evidence_ids:['video:1']}],p=>p.creative_methods[0].evidence_ids=['video:missing']]){const p=profile();mutate(p);assert.equal(validateLearningProfile(p).valid,false);}
 const old=profile();old.pipeline_version='game-learning-extractive-1';old.experimental_quality_hold={active:false};assert.equal(projectQualityHeldProfile(old).experimental_quality_hold.active,true);
});

test('bound runner refuses a drifted actual role before cached evidence, inference, ASR or public reference work',async t=>{
 const {runGameLearning}=await import('../app/game-learning.mjs');
 const snapshot=contractSnapshot(1),roles=contractRoles();roles.parameters.analysis.runtime.version='0.30.6';let reads=0;
 const ctx={game:snapshot.provenance.game,learningTaskBinding:serverLearningBinding(snapshot),visionIdentity:roles.vision_identity,analysisIdentity:roles.analysis_identity,
  visionModel:{cacheParameters:()=>roles.parameters.vision},analysisModel:{cacheParameters:()=>roles.parameters.analysis},
  db:{checkpoint:()=>assert.fail('must validate roles before cache')},groups:{annotate:()=>assert.fail('must validate roles first')}};
 await assert.rejects(runGameLearning(snapshot,ctx,{readMedia:async()=>{reads++;},fingerprint:()=>assert.fail('fingerprint not reached'),reference:()=>assert.fail('no reference request')}),{code:'LEARNING_CONTRACT_MISMATCH'});assert.equal(reads,0);
 const altered=copy(ctx.learningTaskBinding);altered.collection_request_id='other';
 await assert.rejects(runGameLearning(snapshot,{...ctx,learningTaskBinding:altered},{readMedia:()=>assert.fail('must validate task first')}),{code:'LEARNING_CONTRACT_MISMATCH'});
});

test('bound runner rereads old outer evidence instead of stamping it current, then reuses only the exact validated source fingerprint',async t=>{
 const {runGameLearning}=await import('../app/game-learning.mjs'),{Tasks}=await import('../app/tasks.mjs'),{ContentGroups}=await import('../app/content-groups.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const folder=await mkdtemp(join(tmpdir(),'contract-run-')),db=new Tasks(folder);t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});
 const snapshot=contractSnapshot(1),roles=contractRoles(),groups=new ContentGroups(db),game=snapshot.provenance.game;
 const ctx={game,db,groups,learningTaskBinding:serverLearningBinding(snapshot),visionIdentity:roles.vision_identity,analysisIdentity:roles.analysis_identity,visionModel:{cacheParameters:()=>roles.parameters.vision},analysisModel:{cacheParameters:()=>roles.parameters.analysis}};
 let reads=0,fp=hash('initial-fingerprint');
 const old=contractCard('1');old.machine_output.version='learning-extractive-evidence-3';
 const key='preliminary-learning:'+hash({id:'1',game,version:spec.pipeline});db.checkpoint(key,{fingerprint:fp,evidence:old});
 const options={fingerprint:async()=>fp,readMedia:async row=>{reads++;return contractCard(row.source_id);},reference:async()=>[]};
 const first=await runGameLearning(snapshot,ctx,options);assert.equal(reads,1);assert.equal(first.progress.reused_count,0);assert.equal(first.status,'needs_input');assert.equal(first.learning_task_binding.learning_contract_id,contract.id);assert(first.evidence[0].learning_contract_binding);
 const again=await runGameLearning(snapshot,ctx,options);assert.equal(reads,1);assert.equal(again.progress.reused_count,1);assert.equal(again.candidate_contract_check.valid,false,'one source must remain partial');
 fp=hash('changed-file');await runGameLearning(snapshot,ctx,options);assert.equal(reads,2,'file/fingerprint drift requires rereading evidence');
 assert.equal(old.machine_output.version,'learning-extractive-evidence-3','old in-memory evidence remains unchanged');
});

test('malformed persisted JSON fails closed across validators and profile projection instead of throwing',()=>{
 const malformed=[null,[],0,'wrong',true];
 for(const value of malformed){
  for(const validate of [validateLearningTaskBinding,validateLearningRoles,validateLearningCard,validateLearningProfile])assert.equal(validate(value).valid,false);
 }
 for(const mutate of [
   p=>p.evidence[0].expression_observations.observations=null,
   p=>p.evidence[0].expression_observations.observations=[null],
   p=>p.evidence[0].expression_observations.observations=[{evidence:'bad'}],
   p=>p.evidence[0].expression_observations.observations=[{evidence:[null]}],
   p=>p.evidence[0].learning_card.relevance_basis=[null],
   p=>p.evidence[0].learning_card.blocking_gaps='bad',
   p=>p.evidence[0].topic.quotes='bad',
   p=>p.evidence.push(null),p=>p.evidence.push(7),p=>p.evidence='bad',
   p=>p.learning_collection_records.push(null),p=>p.learning_source_bindings.push(null),
   p=>p.game_facts=[null],p=>p.game_facts[0].evidence_ids='web:publisher',
   p=>p.content_distribution=[null],p=>p.content_distribution[0].object_examples='bad',
   p=>p.content_distribution[0].object_examples=[null],
   p=>p.creative_methods=[null],p=>p.creative_methods[0].evidence_ids='video:1',
   p=>p.creative_methods[0].evidence_ids=[null],p=>p.model_roles.parameters=null,
   p=>p.learning_task_binding.learning_source=[]
 ]){
   const p=profile();mutate(p);
   assert.equal(validateLearningProfile(p).valid,false);
   const projected=projectQualityHeldProfile(p);assert.equal(projected.status,'needs_input');assert.equal(projected.candidate_contract_check.valid,false);assert.equal(projected.experimental_quality_hold.active,true);
 }
 const card=contractCard('1');card.learning_card.relevance_basis=[1];assert.equal(validateLearningCard(card).valid,false);
 assert.equal(validateLearningCard(contractCard('1'),null).valid,false);
});

test('final source fence catches post-read file/group/snapshot changes and preserves the prior profile',async t=>{
 const {runGameLearning}=await import('../app/game-learning.mjs'),{Tasks}=await import('../app/tasks.mjs'),{ContentGroups}=await import('../app/content-groups.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 for(const scenario of ['stable','fingerprint','group','snapshot','io','cancel']){
  const folder=await mkdtemp(join(tmpdir(),'contract-fence-')),db=new Tasks(folder);t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});
  const snapshot=contractSnapshot(),roles=contractRoles(),baseGroups=new ContentGroups(db),game=snapshot.provenance.game,controller=new AbortController();let afterReference=false,reads=0;
  const ioError=Object.assign(Error('controlled disk read failure'),{code:'EIO'});
  const groups={annotate:rows=>baseGroups.annotate(rows),independentCount:rows=>baseGroups.independentCount(rows),key:r=>afterReference&&scenario==='group'&&r.source_id==='1'?'changed-group':baseGroups.key(r)};
  const prior={status:'needs_input',sentinel:'old stored evidence'};db.profile(game,prior);
  const ctx={game,db,groups,signal:controller.signal,learningTaskBinding:serverLearningBinding(snapshot),visionIdentity:roles.vision_identity,analysisIdentity:roles.analysis_identity,visionModel:{cacheParameters:()=>roles.parameters.vision},analysisModel:{cacheParameters:()=>roles.parameters.analysis}};
  const options={readMedia:async row=>{reads++;if(reads===20){afterReference=true;if(scenario==='snapshot')snapshot.records[0].title='changed after read';}return contractCard(row.source_id);},fingerprint:async row=>{
   if(afterReference&&row.source_id==='1'){
    if(scenario==='io')throw ioError;
    if(scenario==='cancel')controller.abort(Error('cancel at final source fence'));
    if(scenario==='fingerprint')return hash('new file after reference');
   }
   return hash('fp:'+row.source_id);
  },reference:async()=>{
   // Target reference now precedes local reading; mutations occur at final read.
   return [{id:'web:publisher',kind:'web',content:'发行方原文介绍'}];
  }};
  if(scenario==='stable'){
   const value=await runGameLearning(snapshot,ctx,options);assert.equal(value.candidate_contract_check.valid,true);assert.equal(value.candidate_contract_check.freshness_checked,false,'static projection never claims a fresh reread');assert.equal(value.status,'needs_input');assert.equal(reads,20);continue;
  }
  await assert.rejects(runGameLearning(snapshot,ctx,options),error=>scenario==='io'?error===ioError:scenario==='cancel'?error===controller.signal.reason:scenario==='snapshot'?error.code==='LEARNING_CONTRACT_MISMATCH':error.code==='LEARNING_CONTRACT_SOURCE_CHANGED');
  assert.equal(reads,20);assert.deepEqual(db.profile(game),prior,'failed final fence must not overwrite the earlier profile');
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM checkpoints WHERE key LIKE 'game-profile-version:%'").get().n,0);
 }
});

test('candidate cards reject old helper identity, omitted stage audit and malformed stage arrays even with current selection version',()=>{
 for(const change of [m=>{m.code_sha256='0'.repeat(64);},m=>{m.stages_version='learning-topic-stages-1';},m=>{delete m.stages;},m=>{m.stages=[null];},m=>{m.stages=m.stages.slice(0,2);}]){const card=contractCard('1');change(card.machine_output);const result=validateLearningCard(card);assert.equal(result.valid,false);assert(result.issues.some(i=>i.startsWith('CARD_STAGES')));}
});

test('candidate contract is entirely serializable data with explicit stage semantics, never function-valued properties',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(contract)),contract);assert.equal(contract.spec.stages.semantic_versions.literal_grounding,'literal-focused-primary-3');assert.equal(contract.spec.stages.semantic_versions.target_identity,'source-declared-visual-support-3');
});

test('pixel basis cannot copy rejected old V, repeat one panel or invent source text behind a valid checkpoint',()=>{
 for(const mutate of [c=>c.learning_card.relevance_basis[0].quote='旧CG中的未经复核主张',c=>c.learning_card.relevance_basis[1]=copy(c.learning_card.relevance_basis[0]),c=>c.learning_card.relevance_basis[0].source_id='other']){const c=contractCard('1');mutate(c);assert(validateLearningCard(c).issues.includes('CARD_PIXEL_BASIS'));}
});


test('active identity rejects old-object leakage, forged panel assignment, altered raw audit and old free reasons',()=>{
 assert.equal(validateLearningCard(contractCard('1')).valid,true);
 for(const mutate of [
 c=>c.target_identity.object_quotes.push('战法品质A级'),
 c=>c.target_identity.visual_ids=['F0_V'],
 c=>c.target_identity.reason=c.target_identity.v18_audit.raw_target_identity.reason,
 c=>c.target_identity.ui_support='specific_compatible',
 c=>c.target_identity.matches=copy(c.target_identity.receipt.raw_output.matches),
 c=>c.target_identity.v18_audit.raw_target_identity.object_quotes=[],
 c=>c.target_identity.v18_audit.target_identity_receipt.raw_output.reason='modified',
 c=>delete c.target_identity.v18_audit,
 c=>c.target_identity.field_semantics.object_quotes='official_verified'
 ]){const c=contractCard('1');mutate(c);assert(validateLearningCard(c).issues.includes('CARD_TARGET_IDENTITY'));}
});

test('text UI proposals cannot lose their audit-only usage or claim pixel confirmation',()=>{
 for(const change of [c=>delete c.target_identity.displayed_ui_support.usage,c=>c.target_identity.displayed_ui_support.usage='pixel_confirmed']){
  const c=contractCard('1');change(c);assert.equal(validateLearningCard(c).valid,false);
 }
});

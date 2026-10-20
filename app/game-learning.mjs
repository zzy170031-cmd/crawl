import {assertLearningTaskBinding,assertLearningRoles,validateLearningCard,bindLearningCard} from './learning-contract.mjs';
import {projectQualityHeldProfile} from './quality-policy.mjs';
import {inspectEvidenceLearningMedia,learningEvidenceFingerprint} from './learning-media.mjs';
import {buildLearningOverview,LEARNING_OVERVIEW_VERSION} from './learning-overview.mjs';
import {gameReference} from './game-reference.mjs';
import {diversify} from './media.mjs';
import {hash} from './tasks.mjs';
import {createLearningModels} from './learning-models.mjs';
import {Model} from './model.mjs';
import {object,string,strings,list,claim,validateSchema} from './contracts.mjs';

const VERSION='game-learning-extractive-2';
const schema=object({summary:string,game_facts:list(object({text:string,evidence_id:string,quote:string})),player_interests:list(claim),creative_methods:list(claim),unknowns:strings});
export function validateLearningSummary(value,evidence) {
  validateSchema(value,schema);
  if(!value.summary.trim())throw Error('游戏认知摘要不能为空');
  for(const fact of value.game_facts){
    const source=evidence.find(e=>e.id===fact.evidence_id&&e.kind==='web');
    if(!fact.text.trim()||!source||!fact.quote.trim()||!source.content.includes(fact.quote))throw Error('游戏事实缺少正文或实际资料原句');
  }
  for(const item of [...value.player_interests,...value.creative_methods])
    if(!item.text.trim()||!item.evidence_ids.length||item.evidence_ids.some(id=>!evidence.some(e=>e.id===id&&e.counts_as_relevant)))throw Error('初学结论缺少正文或引用了未通过相关性检查的作品');
  return value;
}

// All rows originate in the server-validated, immutable Redfox query receipt.
// Missing originals remain exclusions. This runner never resolves or buys media.
export async function runGameLearning(snapshot,ctx,{readMedia=inspectEvidenceLearningMedia,fingerprint=learningEvidenceFingerprint,reference=gameReference,minimum=20,createModels=createLearningModels}={}) {
  if(snapshot.provenance.game!==ctx.game)throw Error('游戏学习批次与目标游戏不一致');
  // Worker supplies this server-owned binding. Diagnostic dependency-injected
  // runs remain held and cannot acquire a contract by producing a success flag.
  const contractBound=Boolean(ctx.learningTaskBinding);
  if(contractBound)assertLearningTaskBinding(ctx.learningTaskBinding,snapshot);
  let ownedRoles=null;
  try {
  if(readMedia===inspectEvidenceLearningMedia){
    if(ctx.visionModel||ctx.analysisModel){
      const visionModel=ctx.visionModel||ctx.model,analysisModel=ctx.analysisModel||visionModel;
      if(!visionModel?.json||!analysisModel?.json)throw Error('显式双模型接口不完整');
      const visionIdentity=ctx.visionIdentity||ctx.identity||await visionModel.identity(),analysisIdentity=ctx.analysisIdentity||(visionModel===analysisModel?visionIdentity:await analysisModel.identity());
      ctx={...ctx,visionModel,analysisModel,visionIdentity,analysisIdentity,identity:visionIdentity};
    }else if(ctx.model&&!(ctx.model instanceof Model)){
      // Injected controlled dependencies never silently reach the real service.
      if(!ctx.identity)throw Error('注入模型缺少实际身份');
      ctx={...ctx,visionModel:ctx.model,analysisModel:ctx.model,visionIdentity:ctx.identity,analysisIdentity:ctx.identity};
    }else{
      const roles=await createModels({visionModel:ctx.model,signal:ctx.signal,visionOptions:{thinking:false,contextLength:8192,maxTokens:2200,prefillJson:true},analysisOptions:{thinking:false,contextLength:32768,maxTokens:900,prefillJson:true}});
      ownedRoles=roles;
      ctx={...ctx,visionModel:roles.vision,analysisModel:roles.analysis,visionIdentity:roles.visionIdentity,analysisIdentity:roles.analysisIdentity,identity:roles.visionIdentity,modelRoleParameters:roles.cacheIdentity};
    }
  }
  const {db,model,identity,signal,stage=()=>{},groups,game,saveProgress=()=>{}}=ctx;
  const modelRoles={vision_identity:ctx.visionIdentity||identity,analysis_identity:ctx.analysisIdentity||identity,parameters:ctx.modelRoleParameters||null};
  if(contractBound){
    const options={vision:{thinking:false,contextLength:8192,maxTokens:2200,prefillJson:true},analysis:{thinking:false,contextLength:32768,maxTokens:900,prefillJson:true}};
    // Read actual wrappers, never trust a ctx label in place of runtime metadata.
    modelRoles.parameters={version:'learning-model-roles-2',vision:ctx.visionModel?.cacheParameters?.(options.vision),analysis:ctx.analysisModel?.cacheParameters?.(options.analysis)};
    assertLearningRoles(modelRoles);
  }
  signal?.throwIfAborted();stage('读取游戏发行方公开介绍');
  const referenceKey='game-reference:'+hash({game,version:VERSION,date:new Date().toISOString().slice(0,10)});
  let refs=db.checkpoint(referenceKey),referenceFailure=null;
  if(!refs)try{refs=await reference(game,{signal});if(refs.length)db.checkpoint(referenceKey,refs);}catch(error){signal?.throwIfAborted();referenceFailure='公开资料读取失败，没有用模型记忆补造游戏规则';refs=[];}
  ctx={...ctx,targetGameReferences:refs};
  const sourceBindings=[];
  const rows=diversify(groups.annotate(snapshot.records),30),evidence=[],excluded=[];
  const progress={candidate_count:rows.length,read_count:0,verified_count:0,relevant_count:0,minimum_required:minimum,target:30,total_to_read:rows.length,reused_count:0,newly_read_count:0,unavailable_count:0};
  const save=()=>saveProgress({progress:{...progress},evidence:[...evidence],unavailable_sources:[...excluded]});
  save();
  for(const row of rows){
    signal?.throwIfAborted();stage(`初步学习 ${progress.read_count+1}/${rows.length}：${row.source_id}`);
    try {
      const fp=await fingerprint(row,ctx),key='preliminary-learning:'+hash({id:row.source_id,game,version:VERSION});
      const cached=db.checkpoint(key);
      let observed;
      if(fp&&cached?.fingerprint===fp&&cached?.evidence?.source_id===row.source_id&&(!contractBound||validateLearningCard(cached.evidence,{sourceId:row.source_id,sourceFingerprint:fp,groupKey:groups.key(row)}).valid)){
        observed={...cached.evidence,reused_from:{read_at:cached.evidence.read_at,scope:'复用未变的本地初步学习证据，没有重新下载或声称远端更新'}};progress.reused_count++;
      }else{
        observed=await readMedia(row,ctx);signal?.throwIfAborted();
        if(observed.source_id!==row.source_id||observed.id!=='video:'+row.source_id)throw Error('认知卡来源不匹配');
        const after=await fingerprint(row,ctx);
        if(contractBound)observed=bindLearningCard(observed,{sourceFingerprint:after,groupKey:groups.key(row)});
        if(after)db.checkpoint(key,{fingerprint:after,evidence:observed});
        progress.newly_read_count++;
      }
      // A historical successful free-summary card cannot satisfy this pipeline.
      if(observed.pipeline_version!=='extractive-learning-1'||observed.summary_quality?.status!=='source_bound')observed={...observed,counts_as_relevant:false,learning_status:'needs_review'};
      if(contractBound){
        const currentFingerprint=await fingerprint(row,ctx);
        // Rebind only evidence which already passed version/identity checks.
        if(observed.learning_contract_binding?.source_fingerprint!==currentFingerprint)throw Error('学习过程中本地源指纹已改变');
        observed=bindLearningCard(observed,{sourceFingerprint:currentFingerprint,groupKey:groups.key(row)});
        sourceBindings.push({source_id:row.source_id,fingerprint:currentFingerprint,group_key:groups.key(row)});
      }
      evidence.push(observed);progress.read_count=groups.independentCount(evidence);
      progress.relevant_count=groups.independentCount(evidence.filter(e=>e.counts_as_relevant));
      // Machine point checks never become fully verified audiovisual evidence.
      progress.verified_count=0;
    }catch(error){
      signal?.throwIfAborted();
      excluded.push({source_id:row.source_id,code:error.code==='MEDIA_ASSET_REQUIRED'?'MEDIA_ASSET_REQUIRED':'LEARNING_FAILED',message:error.code==='MEDIA_ASSET_REQUIRED'?'尚无已确认的原片，请另行确认获取预算':'本条初学未完成，保留检查点供重试'});
      progress.unavailable_count=excluded.length;
    }
    save();
  }
  evidence.push(...refs);
  const relevant=evidence.filter(e=>e.kind==='video'&&e.counts_as_relevant);
  let summary=buildLearningOverview(game,refs,evidence.filter(e=>e.kind==='video'));
  let summaryFailure=null;
  if(relevant.length&&refs.length){
    stage('按原始证据整理游戏介绍与视频类型');
    const key='learning-summary:'+hash({game,refs,relevant,identity,modelRoles,version:VERSION,overview:LEARNING_OVERVIEW_VERSION});
    try{
      const {summary:body,game_facts,player_interests,creative_methods,unknowns}=summary;
      validateLearningSummary({summary:body,game_facts,player_interests,creative_methods,unknowns},evidence);
      signal?.throwIfAborted();db.checkpoint(key,summary);
    }catch(error){signal?.throwIfAborted();summaryFailure='游戏认知汇总未通过原文引用检查，已保留单条学习结果';}
  }
  const count=groups.independentCount(relevant);
  const gaps=[...(count<minimum?[`实际相关初学内容${count}组，尚不足${minimum}组`]:[]),...(!refs.length?[referenceFailure||'未找到唯一同名游戏的发行方介绍，请补充可核验游戏资料']:[]),...(summaryFailure?[summaryFailure]:[]),...(!summary.game_facts.length?['尚未形成有原句依据的游戏入门事实']:[]),...(!summary.player_interests.length||!summary.creative_methods.length?['玩家关注点或内容表达认知尚未形成']:[])];
  const profile=projectQualityHeldProfile({game,pipeline_version:VERSION,learning_task_binding:ctx.learningTaskBinding||null,learning_source_bindings:sourceBindings,learning_collection_records:contractBound?snapshot.records:null,model_roles:modelRoles,overview_version:summary.source_summary_version,game_identity:summary.game_identity,content_distribution:summary.content_distribution,video_scopes:summary.video_scopes,summary:summary.summary,game_overview:summary.game_facts,game_facts:summary.game_facts.map(f=>({text:f.text,evidence_ids:[f.evidence_id],quote:f.quote})),
    relevant_video_ids:relevant.map(e=>e.id),player_interests:summary.player_interests,creative_methods:summary.creative_methods,
    video_content_map:relevant.map(e=>({evidence_id:e.id,content_type:e.learning_card.content_type,summary:e.learning_card.summary})),
    initial_quality_notes:relevant.flatMap(e=>e.learning_card.quality_notes.map(note=>({...note,evidence_id:e.id,scope:'基于同片原文的有限表达观察，不是优质认证或热门因果证明'}))),
    creative_context:{purpose:'供选题后的深拆解理解游戏语境；不是最终创作方案',requires_selected_video_analysis:true},
    unknowns:[...summary.unknowns,'音效、音乐、完整连续动作及未列明的转写词语尚未核验'],blocking_gaps:gaps,
    evidence,evidence_index:evidence.map(e=>({id:e.id,read_at:e.read_at,url:e.url,coverage:e.coverage||e.scope})),unavailable_sources:excluded,
    sample_coverage:{candidates:rows.length,read:progress.read_count,relevant:count,expression_observed:summary.sample_counts.expression_observed,minimum,full_audiovisual_verified:0},
    collection_origin:snapshot.provenance,progress,independent_content_count:count,status:gaps.length?'needs_input':'ready',
    coverage:'初步认知：均匀抽帧、完整音轨机器转写、字幕点核；不等于逐帧或人工视听复核',
    created_at:new Date().toISOString(),expires_at:new Date(Date.now()+7*86400000).toISOString()});
  profile.version=hash({game,summary,evidence,source:snapshot.provenance,identity,modelRoles,version:VERSION});
  // Finish awaited external work before the final freshness fence. Ownership
  // cleanup failure must not publish a completed profile; failed owners remain
  // recoverable through the model coordinator's explicit cleanup path.
  if(ownedRoles){const finishingRoles=ownedRoles;ownedRoles=null;await finishingRoles.dispose();}
  if(contractBound){
    const checked=await Promise.allSettled(relevant.map(async observed=>{
      const row=rows.find(candidate=>candidate.source_id===observed.source_id);
      return {observed,row,fingerprint:row?await fingerprint(row,ctx):null};
    }));
    signal?.throwIfAborted();
    for(const entry of checked)if(entry.status==='rejected')throw entry.reason;
    assertLearningTaskBinding(ctx.learningTaskBinding,snapshot);
    // No await after the group/source comparison and before the synchronous DB
    // writes. Never silently replace a binding with a later file/group value.
    for(const {value:{observed,row,fingerprint:current}} of checked){
      const binding=observed.learning_contract_binding;
      if(!row||!current||binding?.source_fingerprint!==current||binding?.group_key!==groups.key(row)){
        const error=Error('学习完成前原片指纹或独立内容组已变化，未保存候选档案，请重新检查');
        error.code='LEARNING_CONTRACT_SOURCE_CHANGED';throw error;
      }
    }
  }
  signal?.throwIfAborted();db.profile(game,profile);db.checkpoint('game-profile-version:'+profile.version,profile);
  return profile;
  } finally {
    if(ownedRoles)await ownedRoles.dispose();
  }
}

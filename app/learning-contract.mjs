import {validatePixelWitness,pixelWitnessBasis,LEARNING_PIXEL_WITNESS_VERSION,LEARNING_PIXEL_WITNESS_MODEL,LEARNING_PIXEL_WITNESS_OPTIONS,LEARNING_PIXEL_WITNESS_CODE_SHA256} from './learning-pixel-witness.mjs';
import {LEARNING_TOPIC_STAGES_VERSION,LEARNING_TOPIC_STAGES_CODE_SHA256,learningStageSemanticKey,LEARNING_STAGE_SEMANTICS,learningTargetReferences,learningReferenceQuotes,learningCaptionTags,validLearningCaptionReceipt,substantiveIdentityObject,substantiveIdentityOccurrence,LEARNING_BINDING_PROJECTION_VERSION,captionTagAmbiguity,learningSectionScope,displayedUIUnitId,displayedUIFrameExclusions,pixelIdentityProjection} from './learning-topic-stages.mjs';
import {createHash} from 'node:crypto';

// This is a candidate specification, not an acceptance switch. No environment,
// model output, HTTP body or saved profile can grant execution permission.
const digest='a8ee95bc3592ebaa624014ca8b429d25e0ef5f45030dc35786da7ff7e9e1b60a';
const identity={name:'qwen3.5:9b-q8_0',digest};
const runtime={engine:'ollama',version:'0.40.6'};
const inference=(contextLength,maxTokens)=>({request_version:'ollama-json-2',thinking:false,contextLength,maxTokens,prefillJson:true,effective_prefill:false,temperature:0.2});
const role=(name,context,tokens)=>({version:'learning-model-roles-2',role:name,identity:{...identity},runtime:{...runtime},inference:inference(context,tokens)});
const spec={stages:{version:LEARNING_TOPIC_STAGES_VERSION,code_sha256:LEARNING_TOPIC_STAGES_CODE_SHA256,semantic_versions:LEARNING_STAGE_SEMANTICS},vision_prompt:'learning-vision-prompt-3',pipeline:'game-learning-extractive-2',card_pipeline:'extractive-learning-1',selection:'learning-extractive-evidence-19',pixel_witness:{version:LEARNING_PIXEL_WITNESS_VERSION,model:LEARNING_PIXEL_WITNESS_MODEL,options:LEARNING_PIXEL_WITNESS_OPTIONS,code_sha256:LEARNING_PIXEL_WITNESS_CODE_SHA256},binding_projection:LEARNING_BINDING_PROJECTION_VERSION,display:'learning-extractive-display-6',overview:'extractive-game-overview-6',observations:'learning-expression-observations-3',roles:'learning-model-roles-2',vision:role('vision',8192,2200),analysis:role('analysis',32768,900),minimum_independent:20};
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableHash=value=>hash(canonical(value));
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const CANDIDATE_LEARNING_CONTRACT=freeze({id:'learning-candidate-'+stableHash(spec),status:'candidate',accepted:false,spec});
export function candidateLearningContract(){return CANDIDATE_LEARNING_CONTRACT;}
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const arrayOf=(value,predicate)=>Array.isArray(value)&&value.every(predicate);
const strings=value=>arrayOf(value,item=>typeof item==='string');
const text=value=>typeof value==='string'&&Boolean(value.trim());
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const equal=(a,b)=>stableHash(a??null)===stableHash(b??null);
function result(issues){return {valid:issues.length===0,issues:[...new Set(issues)],contract_id:CANDIDATE_LEARNING_CONTRACT.id,status:'candidate',accepted:false};}
function assertValid(check){if(check.valid)return;const error=Error('学习证据不符合服务端候选合同：'+check.issues.join('；'));error.code='LEARNING_CONTRACT_MISMATCH';error.contract_issues=check.issues;throw error;}
function sourceSnapshot(snapshot){return {game:snapshot?.provenance?.game,provider:snapshot?.binding?.source_provider,request_id:snapshot?.binding?.collection_request_id,fingerprint:snapshot?.binding?.collection_fingerprint,records_sha256:stableHash(snapshot?.records??null)};}
export function serverLearningBinding(snapshot){
  const origin=sourceSnapshot(snapshot);
  if(!text(origin.game)||origin.provider!=='redfox'||!text(origin.request_id)||!sha(origin.fingerprint)||!Array.isArray(snapshot?.records)||snapshot.provenance?.request_id!==origin.request_id)throw Error('学习合同缺少服务端采集回执');
  return {game:origin.game,learning_pipeline:spec.pipeline,source_provider:'redfox',collection_request_id:origin.request_id,collection_fingerprint:origin.fingerprint,learning_contract_id:CANDIDATE_LEARNING_CONTRACT.id,learning_source:origin};
}
export function validateLearningTaskBinding(payload,snapshot){
  if(!record(payload)||!record(payload.learning_source)||snapshot!==undefined&&(!record(snapshot)||!record(snapshot.provenance)||!record(snapshot.binding)||!arrayOf(snapshot.records,record)))return result(['TASK_JSON_SHAPE']);
  const issues=[];
  if(payload?.learning_contract_id!==CANDIDATE_LEARNING_CONTRACT.id||payload?.learning_pipeline!==spec.pipeline)issues.push('TASK_CONTRACT_VERSION');
  if(payload?.source_provider!=='redfox'||!text(payload?.game)||!text(payload?.collection_request_id)||!sha(payload?.collection_fingerprint))issues.push('TASK_SOURCE_BINDING');
  const source=payload?.learning_source;
  if(!source||source.game!==payload?.game||source.provider!=='redfox'||source.request_id!==payload?.collection_request_id||source.fingerprint!==payload?.collection_fingerprint||!sha(source.records_sha256))issues.push('TASK_SOURCE_BINDING');
  if(snapshot&&!equal(source,sourceSnapshot(snapshot)))issues.push('TASK_SNAPSHOT_CHANGED');
  return result(issues);
}
export function assertLearningTaskBinding(payload,snapshot){assertValid(validateLearningTaskBinding(payload,snapshot));}
export function validateLearningRoles(roles){
  if(!record(roles)||!record(roles.parameters)||!['vision','analysis'].every(name=>record(roles[name+'_identity'])&&record(roles.parameters[name])))return result(['ROLE_JSON_SHAPE']);
  const issues=[];
  for(const name of ['vision','analysis']){
    if(!equal(roles?.[name+'_identity'],identity))issues.push(name.toUpperCase()+'_MODEL_IDENTITY');
    if(!equal(roles?.parameters?.[name],spec[name]))issues.push(name.toUpperCase()+'_RUNTIME_OR_PARAMETERS');
  }
  if(roles?.parameters?.version!==spec.roles)issues.push('ROLE_COORDINATOR_VERSION');
  return result(issues);
}
export function assertLearningRoles(roles){assertValid(validateLearningRoles(roles));}
// Keep a digest of the original evidence, not a success label attached to it.
export function learningCardDigest(card){const {learning_contract_binding,...evidence}=card||{};return stableHash(evidence);}

function taskTopic(value){return record(value)&&(value.kind==='raw_asr'||value.topic_role==='speech_task'||/^S[0-9]+$/.test(value.evidence_id||'')||value.source?.kind==='raw_asr'||/^S[0-9]+$/.test(value.source?.id||''));}
function taskEvidenceCheck(card,stageList){
 const quotes=card.topic?.quotes,hasTask=Array.isArray(quotes)&&quotes.some(taskTopic),meta=card.task_grounding,hasFourth=Array.isArray(stageList)&&stageList.some(s=>s?.name==='task_support');
 if(!hasTask)return {hasTask:false,valid:meta==null&&!hasFourth};
 if(!arrayOf(quotes,record)||!record(meta)||!record(meta.support_receipt)||!hasFourth)return {hasTask:true,valid:false};
 const bad=()=>({hasTask:true,valid:false}),receipt=meta.support_receipt,d=receipt.descriptor,raw=receipt.raw_output,stage=stageList.find(s=>s?.name==='task_support');
 const taskQuotes=quotes.filter(taskTopic),objects=quotes.filter(q=>!taskTopic(q));
 if(taskQuotes.length!==1||objects.length>1||!record(d)||!record(d.input)||!record(d.schema)||!record(raw)||!record(stage))return bad();
 const task=taskQuotes[0],object=objects[0],input=d.input;
 if(meta.source_id!==card.source_id||meta.media_hash!==card.media_hash||meta.catalog_sha256!==card.summary_quality.catalog_sha256||!['unknown','machine_selected_support_not_verified'].includes(meta.status)||meta.not_synchronous!==true||meta.subtitle_verified!==false)return bad();
 if(d.name!=='task_support'||d.source_id!==card.source_id||d.media_hash!==card.media_hash||d.semantic_version!==LEARNING_STAGE_SEMANTICS.task_support||!equal(d.visual_identity,spec.vision.identity)||!equal(d.analysis_identity,spec.analysis.identity)||!equal(d.inference_parameters,spec.analysis)||d.parameters_sha256!==hash(spec.analysis))return bad();
 if(receipt.status!=='valid'||receipt.checkpoint!==stage.checkpoint||!receipt.checkpoint.startsWith(learningStageSemanticKey(d)+':attempt:')||receipt.raw_sha256!==hash(raw)||receipt.raw_sha256!==stage.raw_sha256||d.input_sha256!==hash(input)||d.input_sha256!==stage.input_sha256||d.schema_sha256!==hash(d.schema)||!text(d.prompt)||d.prompt_sha256!==hash(d.prompt))return bad();
 if(Object.keys(raw).sort().join('|')!=='object_quote|support_status|visual_ids'||typeof raw.object_quote!=='string'||!['supported','unsupported','uncertain'].includes(raw.support_status)||!strings(raw.visual_ids)||raw.visual_ids.length>3||new Set(raw.visual_ids).size!==raw.visual_ids.length)return bad();
 if(meta.support_status!==raw.support_status||!equal(meta.visual_ids,raw.visual_ids)||input.task!=='task_support'||!record(input.selected_task)||!arrayOf(input.evidence,r=>Array.isArray(r)&&r.length===4&&text(r[0])&&Number.isFinite(r[1])&&r[1]>=0&&typeof r[2]==='string'&&text(r[3]))||!arrayOf(input.ocr_objects,r=>Array.isArray(r)&&r.length===3&&text(r[0])&&text(r[1])&&Number.isFinite(r[2])&&r[2]>=0)||!strings(input.visual_ids))return bad();
 const readings=card.subtitle_review?.ocr_readings,segments=card.transcript?.raw_segments;
 if(!arrayOf(readings,r=>record(r)&&r.source_id===card.source_id&&Number.isFinite(r.time)&&r.time>=0&&typeof r.visible_text==='string'&&typeof r.visible_content==='string')||!arrayOf(segments,s=>record(s)&&(s.source_id===undefined||s.source_id===card.source_id)&&Number.isFinite(s.start)&&s.start>=0&&Number.isFinite(s.end)&&s.end>=s.start&&typeof s.text==='string'))return bad();
 const rows=[],bounds=[];readings.forEach((r,i)=>{for(const [suffix,kind,body] of [['T','ocr',r.visible_text],['V','visual_description',r.visible_content]])if(body.trim()){rows.push(['F'+i+'_'+suffix,r.time,kind,body]);bounds.push(['F'+i+'_'+suffix,null,i,null]);}});segments.forEach((s,i)=>{if(s.text.trim()){rows.push(['S'+i,s.start,'raw_asr',s.text]);bounds.push(['S'+i,s.end,null,i]);}});
 if(!equal(input.evidence,rows)||!equal(input.source_boundaries,bounds)||!equal(input.visual_ids,rows.filter(r=>r[2]==='visual_description').map(r=>r[0])))return bad();
 const byId=new Map(rows.map(r=>[r[0],r]));
 const validQuote=(q,kind,role)=>record(q)&&q.source_id===card.source_id&&q.kind===kind&&q.topic_role===role&&text(q.quote)&&Number.isFinite(q.time)&&q.time>=0&&record(q.source)&&q.source.source_id===card.source_id&&q.source.id===q.evidence_id&&q.source.kind===kind&&q.source.time===q.time&&byId.get(q.evidence_id)?.[1]===q.time&&byId.get(q.evidence_id)?.[2]===kind&&q.source.text===byId.get(q.evidence_id)?.[3]&&q.source.text.includes(q.quote)&&Number.isInteger(q.start)&&Number.isInteger(q.end)&&q.start>=0&&q.end>=q.start&&q.source.text.slice(q.start,q.end)===q.quote;
 if(!validQuote(task,'raw_asr','speech_task')||meta.task_id!==task.evidence_id||meta.task_time!==task.time||meta.task_quote!==task.quote||input.selected_task.parent_id!==task.evidence_id||input.selected_task.time!==task.time||input.selected_task.quote!==task.quote||input.selected_task.parent_text!==task.source.text)return bad();
 const index=Number(task.evidence_id.slice(1)),context=rows.filter(r=>r[2]==='raw_asr'&&Math.abs(Number(r[0].slice(1))-index)<=1);
 if(!arrayOf(input.selected_task.context,c=>record(c)&&c.source_id===card.source_id&&c.kind==='raw_asr'&&/^S[0-9]+$/.test(c.id||'')&&c.segment_index===Number(c.id.slice(1))&&c.end===segments[c.segment_index]?.end)||!equal(input.selected_task.context.map(c=>[c.id,c.time,c.kind,c.text]),context)||!equal(task.source.context,input.selected_task.context))return bad();
 if(raw.object_quote){if(!object||!validQuote(object,'ocr','visual_object')||object.quote!==raw.object_quote||meta.object_id!==object.evidence_id||meta.object_time!==object.time||meta.object_quote!==object.quote||!input.ocr_objects.some(o=>o[0]===object.quote&&o[1]===object.evidence_id&&o[2]===object.time))return bad();}
 else if(object||meta.object_id!==null||meta.object_time!==null||meta.object_quote!==null)return bad();
 if(raw.visual_ids.some(id=>byId.get(id)?.[2]!=='visual_description'||!input.visual_ids.includes(id)))return bad();
 if(card.counts_as_relevant===true||meta.status==='machine_selected_support_not_verified'){
  const ui=card.target_identity?.pixel_witness;
  if(meta.status!=='machine_selected_support_not_verified'||raw.support_status!=='supported'||!raw.visual_ids.length||(card.counts_as_relevant===true&&card.learning_card.relationship_type!=='direct_game')||!record(ui)||ui.supported!==true)return bad();
 }
 if(meta.evidence_level!==(meta.status==='machine_selected_support_not_verified'?(object?'task_and_object_machine_candidate':'task_only_object_unverified'):'insufficient')||!text(meta.boundary)||meta.status==='unknown'&&card.counts_as_relevant===true)return bad();
 if(meta.evidence_level==='task_only_object_unverified'&&(!card.learning_card.summary.includes(meta.boundary)||!card.learning_card.uncertainties?.includes(meta.boundary)))return bad();
 return {hasTask:true,valid:true};
}


function cardSource(card){
 const readings=card.subtitle_review?.ocr_readings,segments=card.transcript?.raw_segments;
 if(!arrayOf(readings,r=>record(r)&&r.source_id===card.source_id&&Number.isFinite(r.time)&&r.time>=0&&typeof r.visible_text==='string'&&typeof r.visible_content==='string')||!arrayOf(segments,s=>record(s)&&Number.isFinite(s.start)&&s.start>=0&&Number.isFinite(s.end)&&s.end>=s.start&&typeof s.text==='string'))return null;
 const rows=[],bounds=[];readings.forEach((r,i)=>{for(const [suffix,kind,body] of [['T','ocr',r.visible_text],['V','visual_description',r.visible_content]])if(body.trim()){rows.push(['F'+i+'_'+suffix,r.time,kind,body]);bounds.push(['F'+i+'_'+suffix,null,i,null]);}});segments.forEach((s,i)=>{if(s.text.trim()){rows.push(['S'+i,s.start,'raw_asr',s.text]);bounds.push(['S'+i,s.end,null,i]);}});return {rows,bounds};
}
function stageAuditValid(card,stages,name,audit){
 const d=audit?.descriptor,stage=stages.find(s=>s?.name===name);let source=cardSource(card);if(source&&name==='displayed_ui_support')source={rows:source.rows.filter(r=>r[2]!=='raw_asr'),bounds:source.bounds.filter(r=>!r[0].startsWith('S'))};
 return source&&record(audit)&&record(d)&&record(d.input)&&record(d.schema)&&record(audit.raw_output)&&record(stage)&&d.name===name&&d.semantic_version===LEARNING_STAGE_SEMANTICS[name]&&d.source_id===card.source_id&&d.media_hash===card.media_hash&&equal(d.visual_identity,spec.vision.identity)&&equal(d.analysis_identity,spec.analysis.identity)&&equal(d.inference_parameters,spec.analysis)&&d.parameters_sha256===hash(spec.analysis)&&d.source_rows_sha256===hash({sources:source.rows,boundaries:source.bounds})&&equal(d.input.evidence,source.rows)&&equal(d.input.source_boundaries,source.bounds)&&d.input_sha256===hash(d.input)&&d.schema_sha256===hash(d.schema)&&text(d.prompt)&&d.prompt_sha256===hash(d.prompt)&&audit.status==='valid'&&text(audit.checkpoint)&&audit.checkpoint.startsWith(learningStageSemanticKey(d)+':attempt:')&&audit.checkpoint===stage.checkpoint&&stage.semantic_key===learningStageSemanticKey(d)&&audit.raw_sha256===hash(audit.raw_output)&&audit.raw_sha256===stage.raw_sha256&&stage.input_sha256===d.input_sha256;
}
function displayedUIEvidenceCheck(card,stages){
 const ui=card.target_identity?.displayed_ui_support,source=cardSource(card);
 if(ui?.usage!=='proposal_only_not_pixel_confirmation')return false;
 if(!record(ui)||!source||ui.source_id!==card.source_id||ui.media_hash!==card.media_hash||!['displayed_game_ui','illustration_or_diagram','mixed','uncertain'].includes(ui.form)||!strings(ui.support_unit_ids)||ui.support_unit_ids.length>4||new Set(ui.support_unit_ids).size!==ui.support_unit_ids.length||!arrayOf(ui.selected_units,record)||typeof ui.supported!=='boolean')return false;
 const excluded=displayedUIFrameExclusions(source.rows.map(r=>({id:r[0],time:r[1],kind:r[2],text:r[3]})));if(!equal(ui.excluded_frames,excluded))return false;
 if(ui.receipt==null)return !source.rows.some(r=>r[2]==='visual_description')&&ui.form==='uncertain'&&!ui.supported&&!ui.selected_units.length&&!ui.support_unit_ids.length&&!stages.some(s=>s.name==='displayed_ui_support');
 if(!stageAuditValid(card,stages,'displayed_ui_support',ui.receipt))return false;
 const input=ui.receipt.descriptor.input,raw=ui.receipt.raw_output;
 if(Object.keys(input).sort().join('|')!=='evidence|evidence_columns|source_boundaries|support_units|task'||input.task!=='displayed_ui_support'||!equal(raw,{form:ui.form,support_unit_ids:ui.support_unit_ids})||!arrayOf(input.support_units,record))return false;
 const map=new Map(source.rows.map(r=>[r[0],r])),units=input.support_units;
 if(new Set(units.map(u=>u.id)).size!==units.length||units.some(u=>{
  const v=map.get(u.visual_id),t=map.get(u.ocr_id);
  if(excluded.some(e=>e.visual_id===u.visual_id)||Object.keys(u).sort().join('|')!=='end|id|object_quote|ocr_id|start|time|visual_id'||v?.[2]!=='visual_description'||u.time!==v[1]||u.ocr_id!==(map.has(u.visual_id.replace(/_V$/u,'_T'))?u.visual_id.replace(/_V$/u,'_T'):null))return true;
  const {id,...body}=u;if(id!==displayedUIUnitId(body)||id.length>200)return true;
  return u.object_quote===null?u.start!==null||u.end!==null:!text(u.object_quote)||!substantiveIdentityObject(u.object_quote)||!Number.isInteger(u.start)||!Number.isInteger(u.end)||u.start<0||u.end<u.start||t?.[2]!=='ocr'||t[1]!==u.time||!substantiveIdentityOccurrence(t[3],u.object_quote,u.start,u.end);
 }))return false;
 if(units.some(u=>u.object_quote===null&&units.some(o=>o.visual_id===u.visual_id&&o.object_quote!==null)))return false;
 const selected=ui.support_unit_ids.map(id=>units.find(u=>u.id===id));if(selected.some(u=>!u)||!equal(ui.selected_units,selected))return false;
 const supported=['displayed_game_ui','mixed'].includes(ui.form)&&new Set(selected.map(u=>u.time)).size>=2&&selected.some(u=>u.object_quote!==null);
 return ui.supported===supported;
}
function identityEvidenceCheck(card,stages){
 const i=card.target_identity,raw=i?.v18_audit?.raw_target_identity;
 if(!record(i)||!record(raw)||i.source_id!==card.source_id||i.media_hash!==card.media_hash||!Array.isArray(i.references)||i.references_sha256!==hash(i.references)||i.v18_audit.raw_identity_usage!=='audit_only_not_pixel_confirmation'||!equal(i.v18_audit.target_identity_receipt,i.receipt))return false;
 const fields=['status','ui_support','visual_ids','object_quotes','other_game_tags','other_game_names','matches','reason'];
 if(Object.keys(raw).sort().join('|')!==[...fields].sort().join('|')||!['source_declared_visual_supported','contradicted','insufficient'].includes(raw.status)||!['specific_compatible','generic','narrative','uncertain'].includes(raw.ui_support)||!['none','present','uncertain'].includes(raw.other_game_names)||!strings(raw.visual_ids)||!strings(raw.object_quotes)||!strings(raw.other_game_tags)||typeof raw.reason!=='string'||!arrayOf(raw.matches,m=>record(m)&&text(m.source_id)&&text(m.reference_id)&&text(m.reference_quote))||raw.matches.length>3)return false;
 // These old free-form claims must never be copied back to the active root.
 if(['matches','other_game_names','other_game_tags'].some(k=>Object.hasOwn(i,k)))return false;
 const game=card.target_game,caption=i.source_caption_receipt;
 if(!text(game)||i.target_game!==game||!equal(learningTargetReferences(i.references,game),i.references)||i.source_caption_sha256!==hash(caption)||caption!==null&&(!validLearningCaptionReceipt(caption)||caption.source_id!==card.source_id))return false;
 const tags=learningCaptionTags(caption),exactTag=tags.find(t=>t.name===game)||null,ambiguity=captionTagAmbiguity(caption,game);
 if(!equal(i.exact_target_tag,exactTag)||!equal(i.caption_tag_assessment,ambiguity)||!record(i.pixel_witness)||!arrayOf(i.pixel_witness.panel_frames,record)||!arrayOf(i.pixel_witness.accepted_units,a=>record(a)&&record(a.unit)))return false;
 const expected=pixelIdentityProjection(i.pixel_witness,raw,exactTag,ambiguity);
 if(!equal(expected,Object.fromEntries(Object.keys(expected).map(k=>[k,i[k]]))))return false;
 if(i.receipt==null)return !caption&&learningReferenceQuotes(i.references).length===0&&raw.status==='insufficient'&&!i.supported&&raw.matches.length===0&&!stages.some(s=>s.name==='target_identity')&&card.counts_as_relevant!==true;
 if(!stageAuditValid(card,stages,'target_identity',i.receipt))return false;
 const d=i.receipt.descriptor;
 if(!equal(raw,i.receipt.raw_output)||!equal(d.input.target_references,i.references)||!equal(d.input.reference_quotes,learningReferenceQuotes(i.references))||!equal(d.input.caption_receipt,caption)||!equal(d.input.caption_tags,tags)||!equal(d.input.exact_target_tag,exactTag)||d.input.target_game!==game)return false;
 const source=cardSource(card);if(!source)return false;const byId=new Map(source.rows.map(r=>[r[0],r]));
 if(raw.visual_ids.some(id=>byId.get(id)?.[2]!=='visual_description')||raw.other_game_tags.some(id=>!tags.some(t=>t.id===id))||!arrayOf(d.input.object_quotes,o=>Array.isArray(o)&&o.length===3&&text(o[0])&&byId.get(o[1])?.[2]==='ocr'&&byId.get(o[1])?.[1]===o[2]&&byId.get(o[1])?.[3].includes(o[0]))||raw.object_quotes.some(q=>!d.input.object_quotes.some(o=>o[0]===q)))return false;
 if(raw.matches.some(m=>!byId.has(m.source_id)||!learningReferenceQuotes(i.references).some(r=>r.reference_id===m.reference_id&&r.quote===m.reference_quote)))return false;
 return card.counts_as_relevant!==true||i.supported;
}

function primaryEvidenceCheck(card,stages){
 const p=card.primary_topic;if(!record(p)||!['machine_located','insufficient'].includes(p.status)||p.source_assignment!=='program_candidate_occurrence_not_model_selected'||!arrayOf(p.proposals,x=>record(x)&&Object.keys(x).sort().join('|')==='basis_ids|quote|role'&&text(x.quote)&&['primary','local','uncertain'].includes(x.role)&&strings(x.basis_ids))||!arrayOf(p.bindings,record)||p.bindings.length!==p.proposals.length)return false;
 if(p.receipt==null)return !p.proposals.length&&!card.topic.quotes.length&&card.counts_as_relevant!==true&&!stages.some(s=>s.name==='literal_grounding');
 if(Object.hasOwn(p.receipt?.descriptor?.input||{},'target_game')||Object.hasOwn(p.receipt?.descriptor?.input||{},'target_references')||!stageAuditValid(card,stages,'literal_grounding',p.receipt)||!equal(p.receipt.raw_output,{subjects:p.proposals}))return false;
 const source=cardSource(card),map=new Map(source.rows.map(r=>[r[0],r])),options=p.receipt.descriptor.input.literal_topics;
 if(!arrayOf(options,o=>Array.isArray(o)&&o.length===5&&text(o[0])&&text(o[1])&&['ocr','raw_asr'].includes(o[2])&&Number.isInteger(o[3])&&Number.isInteger(o[4])))return false;
 if(p.proposals.some((q,index)=>{const b=p.bindings[index],o=options.find(o=>o[0]===q.quote),r=o&&map.get(o[1]);return !o||!r||r[2]!==o[2]||r[3].slice(o[3],o[4])!==q.quote||!q.basis_ids.length||q.basis_ids.some(id=>!map.has(id))||b.quote!==q.quote||b.source_id!==o[1]||b.time!==r[1]||b.start!==o[3]||b.end!==o[4]||!arrayOf(b.occurrences,a=>record(a)&&map.get(a.parent_id)?.[3]?.slice(a.start,a.end)===a.text&&a.text===q.quote);}))return false;
 const section=learningSectionScope(source.rows.map(r=>({id:r[0],time:r[1],kind:r[2],text:r[3]})),card.topic.quotes.map(q=>({kind:q.kind,text:q.quote,parent_id:q.evidence_id,time:q.time})));
 if(!equal(p.section_scope,section)||section.status==='section_index'&&card.counts_as_relevant===true)return false;
 if(card.counts_as_relevant===true&&(p.status!=='machine_located'||!p.proposals.some(q=>q.role==='primary')))return false;
 return card.topic.quotes.every(q=>q.topic_role==='visual_object'&&card.task_grounding||p.proposals.some((x,i)=>x.role==='primary'&&p.bindings[i].source_id===q.evidence_id&&x.quote===q.quote));
}

export function validateLearningCard(card,options={}){
  if(!record(options)||!record(card)||!record(card.machine_output)||!record(card.summary_quality)||!record(card.model_roles)||!record(card.learning_card)||!record(card.expression_observations)||!record(card.topic)||!arrayOf(card.topic.quotes,record)||!arrayOf(card.learning_card.relevance_basis,record)||!strings(card.learning_card.blocking_gaps)||!arrayOf(card.expression_observations.observations,o=>record(o)&&arrayOf(o.evidence,record)))return result(['CARD_JSON_SHAPE']);
  const {sourceId,sourceFingerprint,groupKey}=options;
  const issues=[],m=card.machine_output;
  if(card?.kind!=='video'||!text(card?.source_id)||card.id!=='video:'+card.source_id||sourceId&&card.source_id!==sourceId||!sha(card?.media_hash))issues.push('CARD_SOURCE_IDENTITY');
  if(m?.vision_prompt_version!==spec.vision_prompt||card?.pipeline_version!==spec.card_pipeline||m?.version!==spec.selection||card?.display_version!==spec.display||m?.display_version!==spec.display)issues.push('CARD_VERSION');
  const projection=m.binding_projection;if(!record(projection)||projection.version!==spec.binding_projection||!['projection_rebound','projection_applied'].includes(projection.status)||!['not_fresh_inference','stage_inference_per_receipt'].includes(projection.inference)||projection.reason_usage!=='audit_only_not_knowledge'||!text(projection.boundary)||projection.status==='projection_rebound'&&(projection.inference!=='not_fresh_inference'||m.model_called!==false||m.cached!==true))issues.push('CARD_BINDING_PROJECTION');
  const stageList=m.stages;
  if(!arrayOf(stageList,record))return result(['CARD_STAGES_IDENTITY']);
  const taskCheck=taskEvidenceCheck(card,stageList);
  if(!taskCheck.valid)issues.push('CARD_TASK_SUPPORT');
  if(m.stages_version!==spec.stages.version||m.code_sha256!==spec.stages.code_sha256||!arrayOf(stageList,s=>record(s)&&text(s.name)&&text(s.checkpoint)&&sha(s.raw_sha256)&&sha(s.input_sha256))||new Set((Array.isArray(stageList)?stageList:[]).map(s=>s?.name)).size!==stageList?.length)issues.push('CARD_STAGES_IDENTITY');
  else {
    const source=cardSource(card),hasText=source?.rows.some(r=>r[2]!=='visual_description');
    const names=stageList.map(s=>s.name),expected=[...(hasText?['scope_hint','literal_grounding','relation']:[]),...(taskCheck.hasTask?['task_support']:[]),...(card.target_identity?.receipt?['target_identity']:[]),...(card.target_identity?.displayed_ui_support?.receipt?['displayed_ui_support']:[])];
    if(names.some((name,i)=>name!==expected[i])||card.counts_as_relevant===true&&names.length!==expected.length)issues.push('CARD_STAGES_STRUCTURE');
  }
  if(!displayedUIEvidenceCheck(card,stageList))issues.push('CARD_DISPLAYED_UI_SUPPORT');
  if(m.pixel_witness_version!==LEARNING_PIXEL_WITNESS_VERSION||!validatePixelWitness(card.target_identity?.pixel_witness,{sourceId:card.source_id,mediaHash:card.media_hash,selectedUnits:card.target_identity?.displayed_ui_support?.selected_units,readings:card.subtitle_review?.ocr_readings}))issues.push('CARD_PIXEL_WITNESS');
  const witness=card.target_identity?.pixel_witness;
  if(!issues.includes('CARD_PIXEL_WITNESS')&&!equal(card.learning_card.relevance_basis,pixelWitnessBasis(witness,card.source_id)))issues.push('CARD_PIXEL_BASIS');
  if(!identityEvidenceCheck(card,stageList))issues.push('CARD_TARGET_IDENTITY');
  if(!primaryEvidenceCheck(card,stageList))issues.push('CARD_PRIMARY_TOPIC');
  if(card?.summary_quality?.status!=='source_bound'||card?.summary_quality?.human_reviewed!==false||card?.summary_quality?.pipeline_version!==spec.card_pipeline||!sha(card?.summary_quality?.catalog_sha256))issues.push('CARD_EVIDENCE_STATUS');
  for(const [name,field,hashField] of [['vision','vision_parameters','vision_parameters_sha256'],['analysis','inference_parameters','parameters_sha256']]){
    if(!equal(m?.[field],spec[name])||m?.[hashField]!==hash(m?.[field]??null))issues.push(name.toUpperCase()+'_CARD_PARAMETERS');
    if(!equal(m?.[name==='vision'?'visual_identity':'analysis_identity'],identity)||!equal(card?.model_roles?.[name+'_identity'],identity))issues.push(name.toUpperCase()+'_CARD_IDENTITY');
  }
  if(card?.counts_as_relevant===true&&(!card.topic.quotes.length||card?.learning_card?.game_relevance!=='relevant'||!['direct_game','explicit_game_discussion'].includes(card?.learning_card?.relationship_type)||!Array.isArray(card?.learning_card?.relevance_basis)||!card.learning_card.relevance_basis.length||card.learning_card.relevance_basis.some(b=>b.source_id!==card.source_id||!text(b.quote)||!Number.isFinite(b.time))||card.learning_card.blocking_gaps?.length))issues.push('CARD_RELEVANCE_EVIDENCE');
  const obs=card?.expression_observations;
  if(obs?.version!==spec.observations||obs?.source_id!==card?.source_id||obs?.media_hash!==card?.media_hash||!sha(obs?.input_sha256)||!Array.isArray(obs?.observations))issues.push('OBSERVATION_BINDING');
  if(sourceFingerprint!==undefined){
    const binding=card?.learning_contract_binding;
    if(!sha(sourceFingerprint)||binding?.contract_id!==CANDIDATE_LEARNING_CONTRACT.id||binding?.source_fingerprint!==sourceFingerprint||!text(binding?.group_key)||groupKey&&binding.group_key!==groupKey||binding?.evidence_sha256!==learningCardDigest(card))issues.push('CARD_SOURCE_FINGERPRINT');
  }
  return result(issues);
}
export function bindLearningCard(card,{sourceFingerprint,groupKey}){
  assertValid(validateLearningCard(card));
  if(!sha(sourceFingerprint)||!text(groupKey))throw Error('学习证据缺少当前本地指纹或独立内容组');
  const evidence={...card};delete evidence.learning_contract_binding;
  return {...evidence,learning_contract_binding:{contract_id:CANDIDATE_LEARNING_CONTRACT.id,source_fingerprint:sourceFingerprint,group_key:groupKey,evidence_sha256:learningCardDigest(evidence)}};
}
export function validateLearningProfile(profile){
  // Historical or damaged JSON must produce a diagnostic, never a GET 500.
  // These validators perform no IO and do not catch cancellation or file errors.
  if(!record(profile)||!arrayOf(profile.evidence,record)||!arrayOf(profile.learning_collection_records,record)||!arrayOf(profile.learning_source_bindings,record)||!arrayOf(profile.game_facts,f=>record(f)&&arrayOf(f.evidence_ids,text))||!arrayOf(profile.content_distribution,d=>record(d)&&arrayOf(d.object_examples,record))||!arrayOf(profile.creative_methods,m=>record(m)&&arrayOf(m.evidence_ids,text)))return {...result(['PROFILE_JSON_SHAPE']),independent_content_count:0,freshness_checked:false};
  const issues=[];
  if(profile?.pipeline_version!==spec.pipeline||profile?.overview_version!==spec.overview)issues.push('PROFILE_VERSION');
  issues.push(...validateLearningTaskBinding(profile?.learning_task_binding).issues,...validateLearningRoles(profile?.model_roles).issues);
  const task=profile?.learning_task_binding,origin=profile?.collection_origin;
  if(profile?.game!==task?.game||origin?.game!==task?.game||origin?.provider!=='redfox'||origin?.request_id!==task?.collection_request_id)issues.push('PROFILE_COLLECTION_BINDING');
  const records=Array.isArray(profile?.learning_collection_records)?profile.learning_collection_records:[];
  if(!Array.isArray(profile?.learning_collection_records)||stableHash(records)!==task?.learning_source?.records_sha256)issues.push('PROFILE_COLLECTION_RECORDS');
  const videos=(Array.isArray(profile?.evidence)?profile.evidence:[]).filter(e=>e?.kind==='video'&&e.counts_as_relevant===true);
  const bindings=Array.isArray(profile?.learning_source_bindings)?profile.learning_source_bindings:[];
  if(!Array.isArray(profile?.learning_source_bindings))issues.push('PROFILE_SOURCE_FINGERPRINTS');
  const groups=new Set(),ids=new Set();
  for(const card of videos){
    if(card.target_game!==profile.game)issues.push('PROFILE_TARGET_GAME_MISMATCH');
    if(!records?.some(r=>r.source_id===card.source_id&&r.kind==='video'&&r.provider==='redfox'))issues.push('PROFILE_SOURCE_OUTSIDE_COLLECTION');
    const matches=(bindings||[]).filter(b=>b.source_id===card.source_id);
    const binding=matches[0];
    if(matches.length!==1||ids.has(card.source_id))issues.push('PROFILE_SOURCE_FINGERPRINTS');
    ids.add(card.source_id);
    const check=validateLearningCard(card,{sourceId:binding?.source_id,sourceFingerprint:binding?.fingerprint??null,groupKey:binding?.group_key});
    issues.push(...check.issues.map(code=>card.source_id+':'+code));
    if(check.valid&&text(binding?.group_key))groups.add(binding.group_key);
  }
  if(groups.size<spec.minimum_independent)issues.push('MINIMUM_INDEPENDENT_CONTENT');
  // Never accept client/stored counts as evidence for independent content.
  if(profile?.independent_content_count!==groups.size||profile?.sample_coverage?.relevant!==groups.size)issues.push('PROFILE_COUNT_MISMATCH');
  const refs=(Array.isArray(profile?.evidence)?profile.evidence:[]).filter(e=>e.kind==='web'&&text(e.content));
  if(!Array.isArray(profile?.game_facts)||!profile.game_facts.length||profile.game_facts.some(f=>!text(f.text)||!text(f.quote)||!Array.isArray(f.evidence_ids)||!f.evidence_ids.length||!f.evidence_ids.every(id=>refs.some(r=>r.id===id&&r.content.includes(f.quote)))))issues.push('GAME_INTRODUCTION_EVIDENCE');
  const directions=profile?.content_distribution;
  if(!Array.isArray(directions)||!directions.length||!directions.some(d=>d.object_examples?.some(q=>text(q.text)&&videos.some(v=>v.id===q.evidence_id&&arrayOf(v.topic?.quotes,record)&&v.topic.quotes.some(t=>t.quote===q.text&&t.time===q.time)))))issues.push('CONCRETE_CONTENT_DIRECTION');
  const observed=videos.filter(v=>v.expression_observations?.status==='observed'&&arrayOf(v.expression_observations.observations,o=>record(o)&&arrayOf(o.evidence,record))&&v.expression_observations.observations.some(o=>text(o.observation)&&text(o.limitation)&&o.evidence.length));
  if(!observed.length||!Array.isArray(profile?.creative_methods)||!profile.creative_methods.length||profile.creative_methods.some(m=>!text(m.text)||!m.evidence_ids?.length||!m.evidence_ids.every(id=>observed.some(v=>v.id===id&&v.expression_observations.observations.some(o=>m.text.includes(o.observation))))))issues.push('EXPRESSION_OBSERVATION_EVIDENCE');
  return {...result(issues),independent_content_count:groups.size,freshness_checked:false};
}

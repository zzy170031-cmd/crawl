import {LEARNING_PIXEL_WITNESS_MODEL} from '../app/learning-pixel-witness.mjs';
import {pixelFixtureParameters} from './learning-pixel-fixture.mjs';
import {captionBridge,declaredAnswer,displayedAnswer} from './learning-caption-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Tasks,hash} from '../app/tasks.mjs';
import {inspectEvidenceLearningMedia,learningEvidenceFingerprint,LEARNING_VISION_PROMPT_VERSION,LEARNING_VISION_OPTIONS} from '../app/learning-media.mjs';

const id='7696364710773525760',identity={name:'controlled-local-vision',digest:'fixture-visual-1'},asrIdentity={name:'controlled-small',digest:'fixture-asr-1'};
const row={provider:'redfox',kind:'video',source_id:id,source_url:`https://www.douyin.com/video/${id}`,collection_request_id:'local-query',game:'率土之滨',title:'UNTRUSTED_TITLE_不得告诉视觉模型 #率土之滨',author:'fixture'};
const tinyPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const reply=()=>({content_type:'操作配置讲解',relationship_type:'游戏画面',relevance_ids:['F0_T','F0_V'],topic_ids:['U0']});
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'evidence-pipeline-')),db=new Tasks(dir),files=join(dir,'media');await mkdir(files);const folder=pathToFileURL(files+'/');
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const sourceHash=hash('local-source'),times=[0,4,8,12,16,20,24,29.7],frames={source_id:id,source_sha256:sourceHash,duration:30,frames:[]};
 for(const time of times){const file=`frame-${time}.png`,bytes=Buffer.concat([tinyPNG,Buffer.from('controlled-frame-'+time)]);await writeFile(new URL(file,folder),bytes);frames.frames.push({file,actual_time:time,sha256:hash(bytes)});}
 await writeFile(new URL('frames.json',folder),JSON.stringify(frames));await writeFile(new URL('audio.json',folder),JSON.stringify({source_id:id,source_sha256:sourceHash,duration:30,start:0,end:30,url:row.source_url}));await writeFile(new URL('audio.webm',folder),'controlled-full-audio');
 const events=[],calls=[],state={reply:reply(),visual:{visible_text:'率土之滨 开荒配置',visible_content:'游戏地图与队伍配置界面',uncertainties:[]},segments:[{start:3,end:5,text:'率土之滨开荒',avg_logprob:-.1},{start:9,end:10,text:'这个队伍'}]};
 let visual=0,selector=0,asr=0;
 const model={json:async(system,input,schema,options)=>{calls.push({system,input,schema,options});if(options.images?.length){visual++;events.push('visual');return structuredClone(typeof state.visual==='function'?state.visual(visual):state.visual);}selector++;events.push('selector');if(input.task==='scope_hint')return {video_topic:state.hint||'开荒配置',content_type:state.reply.content_type};if(input.task==='literal_grounding'){const quotes=state.ground?.topic_quotes||input.literal_topics.slice(0,1).map(o=>o[0]);return state.ground?.subjects?state.ground:{subjects:quotes.map(quote=>({quote,role:'primary',basis_ids:['F0_V']}))};}if(input.task==='target_identity')return declaredAnswer(input);if(input.task==='displayed_ui_support')return displayedAnswer(input,state.ui||{});if(input.task==='task_support')return structuredClone(state.support);return {relationship_type:state.reply.relationship_type,relevance_ids:structuredClone(state.reply.relevance_ids)};}};
 const transcribe=async()=>{asr++;events.push('asr');const audioHash=hash(await readFile(new URL('audio.webm',folder))),value={source_id:id,audio_sha256:audioHash,audio_duration:30,status:'machine_transcript_pending_review',model:'controlled-small',segments:structuredClone(state.segments)};await writeFile(new URL('transcript.json',folder),JSON.stringify(value));return value;};
 const content='率土之滨中以地图与队伍配置界面管理军队。';const targetGameReferences=[{id:'web:appstore:1',kind:'web',game:row.game,title:row.game,publisher:'fixture publisher',url:'https://apps.apple.com/cn/app/id1',content,content_sha256:hash(content),source_type:'publisher_store_description'}];
 const pixelCalls=[];const pixelWitnessModel={identity:async()=>LEARNING_PIXEL_WITNESS_MODEL,cacheParameters:()=>pixelFixtureParameters,json:async(prompt,input,schema,options)=>{pixelCalls.push({prompt,input,schema,options});const raw={has_structured_game_data_panel:'present',has_scene_or_character_art:'present',panel_evidence:['独立像素受控面板'],quotes:Object.fromEntries(input.quotes.map(q=>[q.id,{presence:'visible',role:'entity_name'}]))};await options.onRawResponse({status:200,body:JSON.stringify({message:{content:JSON.stringify(raw)},done:true,done_reason:'stop'})+'\n',complete:true,truncated:false});return raw;}};
 await writeFile(new URL('redfox-source.mp4',folder),'local-source');
 const ctx={db,model,pixelWitnessModel,pixelWitnessIdentity:LEARNING_PIXEL_WITNESS_MODEL,bridge:await captionBridge(row),targetGameReferences,identity,asrIdentity,folder,assets:{read:async()=>({source_id:id,source_sha256:sourceHash,source_path:join(files,'redfox-source.mp4'),duration:30})},prepare:async()=>{events.push('prepare');},transcribe};
 return {ctx,db,folder,frames,state,calls,events,pixelCalls,counts:()=>({visual,selector,asr}),attempt:()=>db.checkpoint('learning-extractive-attempt:'+id)};
}

test('production path reads eight independent frames then full audio and selection, with no title or ASR in vision',async t=>{
 const f=await setup(t),result=await inspectEvidenceLearningMedia(row,f.ctx);
 assert.deepEqual(f.counts(),{visual:8,selector:5,asr:1});assert.deepEqual(f.events.slice(1),[...Array(8).fill('visual'),'asr','selector','selector','selector','selector','selector']);
 for(const call of f.calls.filter(c=>c.options.images?.length)){assert.equal(call.options.images.length,1);assert.equal(call.input.task,'independent_frame_visual_and_ocr');assert(!JSON.stringify(call.input).includes(row.title));assert(!JSON.stringify(call.input).includes('率土'));assert.equal(call.input.raw_segments,undefined);assert.equal(call.options.tools,undefined);}
 assert.equal(result.counts_as_relevant,true);assert.equal(result.id,'video:'+id);assert.equal(result.summary_quality.status,'source_bound');assert.equal(result.summary_quality.human_reviewed,false);assert.equal(result.subtitle_review.human_reviewed,false);
 assert.deepEqual(result.transcript.reviewed_segments,result.transcript.raw_segments);assert.deepEqual(result.subtitle_review.term_corrections,[]);assert.equal(result.coverage.base_sample_count,8);assert.equal(result.coverage.cue_sample_count,0);assert.equal(result.coverage.sound_effects,'not_read');assert.equal(result.coverage.continuous_actions,'not_read');assert.equal(f.attempt().status,'observed');
});

test('production pipeline reuses all checkpoints; changed target, model, frame and audio invalidate their evidence dependencies',async t=>{
 const f=await setup(t);await inspectEvidenceLearningMedia(row,f.ctx);const fingerprint=await learningEvidenceFingerprint(row,f.ctx);assert(fingerprint);
 const cached=await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:8,selector:5,asr:1});assert.equal(cached.machine_output.cached,true);
 assert.notEqual(await learningEvidenceFingerprint({...row,game:'另一游戏'},f.ctx),fingerprint);
 f.ctx.identity={...identity,digest:'fixture-visual-2'};await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:16,selector:10,asr:1});
 const frame=f.frames.frames[0],bytes=Buffer.concat([tinyPNG,Buffer.from('changed-frame')]);await writeFile(new URL(frame.file,f.folder),bytes);frame.sha256=hash(bytes);await writeFile(new URL('frames.json',f.folder),JSON.stringify(f.frames));await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:24,selector:15,asr:1});
 await writeFile(new URL('audio.webm',f.folder),'changed-full-audio');assert.equal(await learningEvidenceFingerprint(row,f.ctx),null);await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:32,selector:20,asr:2});
});

test('production source mismatch and frame hash mismatch stop before visual, ASR or selection',async t=>{
 const f=await setup(t);f.frames.source_id='7696364710773525761';await writeFile(new URL('frames.json',f.folder),JSON.stringify(f.frames));
 await assert.rejects(inspectEvidenceLearningMedia(row,f.ctx),/prepare/);assert.deepEqual(f.counts(),{visual:0,selector:0,asr:0});assert.equal(f.attempt().phase,'prepare');assert.equal(f.attempt().status,'failed');
 f.frames.source_id=id;await writeFile(new URL('frames.json',f.folder),JSON.stringify(f.frames));await writeFile(new URL(f.frames.frames[0].file,f.folder),'tampered-bytes');
 await assert.rejects(inspectEvidenceLearningMedia(row,f.ctx),/prepare/);assert.deepEqual(f.counts(),{visual:0,selector:0,asr:0});assert.equal(await learningEvidenceFingerprint(row,f.ctx),null);
});

test('production cancellation resumes only unfinished frames without a synthetic completed card',async t=>{
 const f=await setup(t),controller=new AbortController(),original=f.ctx.model.json;let frames=0;
 f.ctx.model.json=async(...args)=>{const value=await original(...args);if(args[3].images?.length&&++frames===2)controller.abort(Error('controlled cancellation'));return value;};
 await assert.rejects(inspectEvidenceLearningMedia(row,{...f.ctx,signal:controller.signal}),/controlled cancellation/);assert.equal(f.attempt().status,'cancelled');assert.equal(f.attempt().phase,'visual');assert.deepEqual(f.counts(),{visual:2,selector:0,asr:0});
 f.ctx.model.json=original;const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:9,selector:5,asr:1});assert.equal(result.learning_status,'machine_observed');
});

test('production low-confidence speech-only relevance never counts even when model selects related',async t=>{
 const f=await setup(t);f.state.reply.relationship_type='游戏讨论';f.state.reply.relevance_ids=['S0'];f.state.segments[0].no_speech_prob=.99;f.state.ui={form:'uncertain',support_unit_ids:[]};
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.counts_as_relevant,false);assert.equal(result.learning_status,'needs_review');assert(result.analysis.blocking_gaps.length);assert.equal(result.target_identity.displayed_ui_support.supported,false);assert.equal(result.transcript.raw_segments[0].no_speech_prob,.99);
});

test('production wrong-source ASR fails in transcription before selection and retains only valid earlier frame work',async t=>{
 const f=await setup(t),original=f.ctx.transcribe;f.ctx.transcribe=async(...args)=>({...await original(...args),source_id:'7696364710773525761'});
 await assert.rejects(inspectEvidenceLearningMedia(row,f.ctx),/transcription/);assert.deepEqual(f.counts(),{visual:8,selector:0,asr:1});assert.equal(f.attempt().phase,'transcription');assert.equal(f.attempt().status,'failed');
});

test('production errors keep local cause but neither public error nor phase checkpoint exposes upstream secret text',async t=>{
 const f=await setup(t),cause=new SyntaxError('SECRET_FIXTURE https://private.invalid/private');cause.code='SECRET_FIXTURE';f.ctx.model.json=async()=>{throw cause;};
 await assert.rejects(inspectEvidenceLearningMedia(row,f.ctx),e=>{assert.equal(e.cause,cause);assert(!e.message.includes('SECRET_FIXTURE'));assert(!JSON.stringify(e).includes('SECRET_FIXTURE'));return true;});
 assert.equal(f.attempt().phase,'visual');assert.equal(f.attempt().failure_category,'INVALID_JSON');assert(!JSON.stringify(f.attempt()).includes('SECRET_FIXTURE'));
});

test('production selector rejects invented source IDs, preserving raw failure instead of reporting source-bound success',async t=>{
 const f=await setup(t);f.state.reply.relevance_ids=['F99_T'];
 await assert.rejects(inspectEvidenceLearningMedia(row,f.ctx),/selection/);assert.equal(f.attempt().status,'failed');assert.equal(f.attempt().phase,'selection');
 const records=f.db.db.prepare("SELECT key,value FROM checkpoints WHERE key LIKE 'learning-extractive-stage:%' AND value LIKE '%\"status\":\"failed\"%'").all();assert.equal(records.length,1);const record=JSON.parse(records[0].value);assert.equal(record.descriptor.source_id,id);assert.deepEqual(record.raw_output.relevance_ids,['F99_T']);
});

test('production dual roles isolate images from analysis and analysis digest changes reuse existing vision/ASR',async t=>{
 const f=await setup(t),original=f.ctx.model;let analysisCalls=0;
 f.ctx.visionModel={json:async(...args)=>{assert(args[3].images?.length);return original.json(...args);}};
 f.ctx.analysisModel={json:async(system,input,schema,options)=>{analysisCalls++;assert.equal(options.images,undefined);assert(['scope_hint','literal_grounding','relation','target_identity','displayed_ui_support'].includes(input.task));assert.equal(options.thinking,false);assert.equal(options.contextLength,32768);assert.equal(options.maxTokens,900);return original.json(system,input,schema,options);}};
 f.ctx.visionIdentity=identity;f.ctx.analysisIdentity={name:'text-analysis',digest:'text-digest-1'};
 const first=await inspectEvidenceLearningMedia(row,f.ctx),before=await learningEvidenceFingerprint(row,f.ctx);assert.equal(analysisCalls,5);assert.deepEqual(f.counts(),{visual:8,selector:5,asr:1});
 assert.deepEqual(first.machine_output.visual_identity,identity);assert.deepEqual(first.machine_output.analysis_identity,f.ctx.analysisIdentity);assert.equal(first.machine_output.vision_parameters.contextLength,8192);
 await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(analysisCalls,5);
 f.ctx.analysisIdentity={...f.ctx.analysisIdentity,digest:'text-digest-2'};assert.notEqual(await learningEvidenceFingerprint(row,f.ctx),before);const second=await inspectEvidenceLearningMedia(row,f.ctx);
 assert.deepEqual(f.counts(),{visual:8,selector:10,asr:1});assert.equal(second.machine_output.analysis_identity.digest,'text-digest-2');
 const old=f.db.checkpoint(first.machine_output.checkpoint);assert.equal(old.analysis_identity.digest,'text-digest-1');
});

test('changed actual vision parameter identity invalidates inner frame cache, keeping old OCR and ASR intact',async t=>{
 const f=await setup(t);let revision=1;f.ctx.model.cacheParameters=options=>({...options,implementation_revision:revision});
 const first=await inspectEvidenceLearningMedia(row,f.ctx),before=await learningEvidenceFingerprint(row,f.ctx);
 const oldFrames=f.db.db.prepare("SELECT key,value FROM checkpoints WHERE key LIKE 'learning-frame:%'").all();assert.equal(oldFrames.length,8);
 revision=2;assert.notEqual(await learningEvidenceFingerprint(row,f.ctx),before);const second=await inspectEvidenceLearningMedia(row,f.ctx);
 assert.deepEqual(f.counts(),{visual:16,selector:10,asr:1});assert.notEqual(first.media_hash,second.media_hash);assert.equal(second.machine_output.vision_parameters.implementation_revision,2);
 for(const entry of oldFrames)assert.equal(JSON.stringify(f.db.checkpoint(entry.key)),entry.value);
 assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM checkpoints WHERE key LIKE 'learning-frame:%'").get().n,16);
});

test('vision prompt 3 describes layout briefly while keeping full OCR and raw ASR; actual result and fingerprint bind its version',async t=>{
 const f=await setup(t),ocr='率土之滨 开荒配置\n'+('可见的完整字幕原文。'.repeat(100));f.state.visual.visible_text=ocr;
 const result=await inspectEvidenceLearningMedia(row,f.ctx);
 assert.equal(result.machine_output.vision_prompt_version,LEARNING_VISION_PROMPT_VERSION);assert.equal(LEARNING_VISION_PROMPT_VERSION,'learning-vision-prompt-3');
 for(const call of f.calls.filter(c=>c.options.images?.length)){
  assert.equal(call.schema.properties.visible_content.maxLength,300);assert.equal(call.schema.properties.visible_text.maxLength,5000);
  assert.equal(call.options.contextLength,8192);assert.equal(call.options.maxTokens,2200);assert.equal(call.options.thinking,false);
  assert.match(call.system,/不要重复visible_text/);assert.match(call.system,/布局/);assert(!JSON.stringify(call.input).includes(row.title));
 }
 assert(result.subtitle_review.ocr_readings.every(r=>r.visible_text===ocr));assert.deepEqual(result.transcript.raw_segments,f.state.segments);
 const fingerprint=await learningEvidenceFingerprint(row,f.ctx);assert(fingerprint);await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(await learningEvidenceFingerprint(row,f.ctx),fingerprint);assert.deepEqual(f.counts(),{visual:8,selector:5,asr:1});
});

test('old verbose vision checkpoints remain untouched and cannot authorize prompt 3, while unchanged ASR is reused',async t=>{
 const f=await setup(t),transcript=await f.ctx.transcribe(),parameters={request_version:'injected-model-explicit-parameters',...LEARNING_VISION_OPTIONS};
 const oldMediaHash=hash({version:'learning-media-2',source_id:id,source_hash:hash('local-source'),audioHash:transcript.audio_sha256,frames:f.frames.frames.map(frame=>[frame.actual_time,frame.sha256]),identity,inference_parameters:parameters});
 const old={visible_text:'率土之滨 开荒配置',visible_content:'冗长重复文字'.repeat(100),uncertainties:[]},keys=[];
 for(const frame of f.frames.frames){const key='learning-frame:'+hash({media:oldMediaHash,time:frame.actual_time,frame:frame.sha256,identity,parameters,prompt:'learning-media-2'});keys.push(key);f.db.checkpoint(key,old);}
 f.db.checkpoint('learning-asr:'+hash({source:hash('local-source'),audio:transcript.audio_sha256,asr:asrIdentity,version:'learning-media-2'}),transcript);
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.notEqual(result.media_hash,oldMediaHash);assert.deepEqual(f.counts(),{visual:8,selector:5,asr:1});
 keys.forEach(key=>assert.deepEqual(f.db.checkpoint(key),old));assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM checkpoints WHERE key LIKE 'learning-frame:%'").get().n,16);
 assert.equal(result.machine_output.vision_prompt_version,'learning-vision-prompt-3');
});

test('overlong visual description fails explicitly with original raw evidence retained, not silently shortened or fed to selection',async t=>{
 const f=await setup(t);f.state.visual.visible_content='可见布局'.repeat(76);
 await assert.rejects(inspectEvidenceLearningMedia(row,f.ctx),e=>e.code==='LEARNING_MEDIA_FAILED'&&e.cause?.message.includes('visible_content'));
 assert.equal(f.attempt().phase,'visual');assert.equal(f.attempt().status,'failed');assert.deepEqual(f.counts(),{visual:1,selector:0,asr:0});
 const rows=f.db.db.prepare("SELECT value FROM checkpoints WHERE key LIKE 'learning-frame-raw:%'").all();assert.equal(rows.length,1);
 const raw=JSON.parse(rows[0].value);assert.equal(raw.raw_output.visible_content,f.state.visual.visible_content);assert.equal(raw.vision_prompt_version,'learning-vision-prompt-3');assert.equal(raw.source_id,id);assert.equal(raw.time,0);
 assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM checkpoints WHERE key LIKE 'learning-frame:%'").get().n,0);
 f.state.visual.visible_content='可见游戏配置界面';await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:9,selector:5,asr:1});assert.deepEqual(f.db.db.prepare("SELECT value FROM checkpoints WHERE key LIKE 'learning-frame-raw:%' AND value LIKE '%可见布局%'").all(),rows);
});


test('production reader keeps conditional fourth-stage task support and source times through actual card contract validation',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs');const spec=candidateLearningContract().spec;
 const f=await setup(t);f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 f.state.segments=[{start:3,end:5,text:'今天带来开荒教学',avg_logprob:-.1}];f.state.visual={visible_text:'青羽 Lv.44 3 4',visible_content:'游戏编队UI展示角色、技能配置与开荒操作',uncertainties:[]};f.state.ground={topic_quotes:['开荒教学']};f.state.support={object_quote:'青羽',support_status:'supported',visual_ids:['F0_V']};
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:8,selector:6,asr:1});assert.equal(result.counts_as_relevant,true);
 assert.equal(result.task_grounding.task_time,3);assert.equal(result.task_grounding.object_time,0);assert.equal(result.task_grounding.subtitle_verified,false);assert.deepEqual(result.task_grounding.visual_ids,['F0_V']);assert.equal(result.column_structure,null);
 assert.deepEqual(result.topic.quotes.map(q=>q.topic_role),['speech_task','visual_object']);assert.deepEqual(result.machine_output.stages.map(s=>s.name),['scope_hint','literal_grounding','relation','task_support','target_identity','displayed_ui_support']);assert.deepEqual(validateLearningCard(result).issues,[]);
 const missing=structuredClone(result);delete missing.task_grounding;assert(validateLearningCard(missing).issues.includes('CARD_TASK_SUPPORT'));
 const before=f.counts();await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),before);
});

test('production reader preserves sampled repeated-column metadata without changing model content type',async t=>{
 const f=await setup(t);f.state.segments=[];f.state.hint='克制与被克制关系栏目';f.state.ground={topic_quotes:['克制','被克制']};
 f.state.visual=n=>({visible_text:'被克制\n克制\n'+(n<4?'青羽配置':'北辰配置'),visible_content:'配置UI与两栏文字表',uncertainties:[]});
 const r=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(r.learning_card.content_type,'操作或配置讲解');assert.equal(r.column_structure.origin,'program_observed_repeated_columns_not_model_content_type');assert.equal(r.column_structure.total_sampled_frames,8);assert.equal(r.column_structure.matched_frames,8);assert.deepEqual(r.topic.quotes.map(q=>q.topic_role),['column_label','column_label']);assert(r.selection_diagnostics.some(d=>d.code==='REPEATED_COLUMNS_PROGRAM_LOCATOR'));assert.equal(f.counts().selector,5);
});


test('v13 task provenance validator rejects metadata truthiness, combined deletion, incorrect times and altered original support receipts',async t=>{
 const {candidateLearningContract,validateLearningCard,bindLearningCard}=await import('../app/learning-contract.mjs');const spec=candidateLearningContract().spec;
 const f=await setup(t);f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 f.state.segments=[{start:3,end:5,text:'今天带来开荒教学',avg_logprob:-.1}];f.state.visual={visible_text:'青羽 Lv.44 3 4',visible_content:'游戏配置UI展示开荒操作与技能',uncertainties:[]};f.state.ground={topic_quotes:['开荒教学']};f.state.support={object_quote:'青羽',support_status:'supported',visual_ids:['F0_V']};
 const original=await inspectEvidenceLearningMedia(row,f.ctx);assert.deepEqual(validateLearningCard(original).issues,[]);
 const mutations=[
  c=>{c.task_grounding={};},c=>{c.task_grounding=true;},c=>{c.task_grounding='present';},
  c=>{c.task_grounding={status:'unknown',source_id:'wrong',task_id:'S999',task_time:-1,object_id:null,object_time:null,visual_ids:[],not_synchronous:false,subtitle_verified:true};},
  c=>{delete c.task_grounding;c.machine_output.stages=c.machine_output.stages.filter(s=>s.name!=='task_support');},
  c=>{c.task_grounding.task_time=-1;},c=>{c.task_grounding.object_time=-1;},c=>{c.task_grounding.source_id='wrong';},
  c=>{c.task_grounding.task_quote='另一个任务';},c=>{c.task_grounding.visual_ids=['F99_V'];},c=>{c.task_grounding.subtitle_verified=true;},
  c=>{c.task_grounding.status='unknown';},c=>{c.task_grounding.support_status='unsupported';},
  c=>{c.topic.quotes[0].kind='ocr';},c=>{c.topic.quotes[0].time=0;},c=>{c.topic.quotes[0].source.source_id='wrong';},
  c=>{delete c.topic.quotes[0].topic_role;delete c.task_grounding;c.machine_output.stages=c.machine_output.stages.filter(s=>s.name!=='task_support');},
  c=>{c.task_grounding.support_receipt.raw_output.visual_ids=['F7_V'];},c=>{c.task_grounding.support_receipt.descriptor.input.selected_task.parent_text='changed';},
  c=>{c.task_grounding.support_receipt.descriptor.input.evidence[0][3]='changed';},c=>{c.task_grounding.support_receipt.descriptor.analysis_identity.digest='wrong';},
  c=>{c.task_grounding.support_receipt.descriptor.input.selected_task.context=null;},
  c=>{c.task_grounding.support_receipt.descriptor.input.ocr_objects='not array';},c=>{c.topic.quotes=[null];},
 ];
 for(const mutate of mutations){const card=structuredClone(original);mutate(card);const check=validateLearningCard(card);assert.equal(check.valid,false);assert(check.issues.some(i=>i.startsWith('CARD_TASK')||i.startsWith('CARD_STAGES')||i==='CARD_JSON_SHAPE'));assert.throws(()=>bindLearningCard(card,{sourceFingerprint:hash('source'),groupKey:'group'}));}
 assert.deepEqual(validateLearningCard(original).issues,[]);assert.deepEqual(f.counts(),{visual:8,selector:6,asr:1});
});

test('v13 unsupported task retains auditable original response as unknown but cannot be relabelled as relevant',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs');const spec=candidateLearningContract().spec;const f=await setup(t);
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 f.state.segments=[{start:3,end:5,text:'今天带来开荒教学',avg_logprob:-.1}];f.state.visual={visible_text:'青羽 Lv.44 3 4',visible_content:'游戏配置UI',uncertainties:[]};f.state.ground={topic_quotes:['开荒教学']};f.state.support={object_quote:'',support_status:'unsupported',visual_ids:[]};
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.counts_as_relevant,false);assert.equal(result.task_grounding.status,'unknown');assert.equal(result.task_grounding.support_receipt.raw_output.support_status,'unsupported');assert.deepEqual(validateLearningCard(result).issues,[]);
 const forged=structuredClone(result);forged.counts_as_relevant=true;forged.learning_card.game_relevance='relevant';forged.learning_card.relationship_type='direct_game';forged.learning_card.blocking_gaps=[];assert.equal(validateLearningCard(forged).valid,false);
});

test('v13 actual reader binds target references in outer fingerprint and safely rejects null stage on a real task card',async t=>{
 const f=await setup(t),{candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec;
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 const result=await inspectEvidenceLearningMedia(row,f.ctx),fp=await learningEvidenceFingerprint(row,f.ctx);assert.deepEqual(validateLearningCard(result).issues,[]);assert.equal(result.target_game,row.game);assert.equal(result.target_identity.target_game,row.game);
 f.ctx.targetGameReferences=[];delete f.ctx.bridge;assert.notEqual(await learningEvidenceFingerprint(row,f.ctx),fp);const missing=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(missing.counts_as_relevant,false);assert.equal(missing.target_identity.status,'insufficient');assert.deepEqual(validateLearningCard(missing).issues,[]);
 const malformed=structuredClone(result);malformed.machine_output.stages.splice(1,0,null);assert.doesNotThrow(()=>validateLearningCard(malformed));assert.equal(validateLearningCard(malformed).valid,false);
 const changed=structuredClone(result);changed.target_game='another';assert.equal(validateLearningCard(changed).valid,false);
});

test('v15 reader binds only persisted original API content and page position, never ctx.caption/resolver title',async t=>{
 const {readLearningCaptionReceipt}=await import('../app/learning-media.mjs'),f=await setup(t);
 const receipt=readLearningCaptionReceipt(row,{...f.ctx,caption:'#伪造游戏'});assert.equal(receipt.caption,row.title);assert.equal(receipt.collection_game,row.game);assert.equal(receipt.field_path,'api_pages[0].response.data.list[0].content');assert.equal(receipt.source_record.content,row.title);
 assert.equal(readLearningCaptionReceipt(row,{caption:row.title}),null);
 assert.throws(()=>readLearningCaptionReceipt({...row,title:'另一个 resolver.title'},f.ctx),/不一致/);
 const good=await inspectEvidenceLearningMedia(row,f.ctx),fp=await learningEvidenceFingerprint(row,f.ctx);assert.equal(good.target_identity.evidence_level,'source_declared_visual_supported');assert.equal(good.target_identity.source_caption_receipt.caption,row.title);
 const changedRow={...row,title:'新采集文案 #率土之滨'},changedBridge=await captionBridge(changedRow);assert.notEqual(await learningEvidenceFingerprint(changedRow,{...f.ctx,bridge:changedBridge}),fp);
 const next=await inspectEvidenceLearningMedia(changedRow,{...f.ctx,bridge:changedBridge});assert.equal(f.counts().visual,8);assert.equal(f.counts().selector,6);for(let i=0;i<3;i++)assert.equal(next.machine_output.stages[i].checkpoint,good.machine_output.stages[i].checkpoint);
 const wrong=await inspectEvidenceLearningMedia(row,{...f.ctx,game:'另一游戏'});assert.equal(wrong.target_identity.source_caption_receipt.collection_game,row.game);assert.equal(wrong.counts_as_relevant,false);
});

test('v16 actual reader permits supported task-only index without supplying a person or claiming a verified lineup',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec,f=await setup(t);
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 f.state.hint='开荒配置教学';f.state.segments=[{start:3,end:5,text:'今天带来开荒教学',avg_logprob:-.1}];f.state.visual={visible_text:'青羽 Lv.44 3 4',visible_content:'实际配置与地图UI',uncertainties:[]};f.state.ground={topic_quotes:['开荒教学']};f.state.support={object_quote:'',support_status:'supported',visual_ids:['F4_V']};f.state.reply.relationship_type='游戏讨论';f.state.reply.relevance_ids=['S0'];
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.raw_relation_selection.relationship_type,'游戏讨论');assert.equal(result.counts_as_relevant,true);assert.equal(result.task_grounding.evidence_level,'task_only_object_unverified');assert.equal(result.task_grounding.object_id,null);assert.deepEqual(result.topic.quotes.map(q=>q.topic_role),['speech_task']);assert(result.learning_card.summary.includes('具体对象与阵容未核'));assert.deepEqual(validateLearningCard(result).issues,[]);assert.equal(result.task_grounding.support_receipt.raw_output.object_quote,'');
 const fake=structuredClone(result);fake.task_grounding.evidence_level='task_and_object_machine_candidate';assert.equal(validateLearningCard(fake).valid,false);
 const cached=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(cached.machine_output.binding_projection.inference,'not_fresh_inference');assert.deepEqual(f.counts(),{visual:8,selector:6,asr:1});
});

test('v16 caption ambiguity is replayed by contract; deleting tags or changing supported cannot upgrade a real reader card',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec,f=await setup(t);
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 const tagged={...row,title:row.title+' #开荒'};f.ctx.bridge=await captionBridge(tagged);
 const result=await inspectEvidenceLearningMedia(tagged,f.ctx);assert.equal(result.counts_as_relevant,false);assert.deepEqual(validateLearningCard(result).issues,[]);assert.equal(result.target_identity.caption_tag_assessment.unresolved_caption_tags[0].name,'开荒');
 for(const mutate of [c=>{c.target_identity.caption_tag_assessment.unresolved_caption_tags=[];},c=>{c.target_identity.supported=true;},c=>{c.counts_as_relevant=true;}]){const c=structuredClone(result);mutate(c);assert.equal(validateLearningCard(c).valid,false);}
});

test('v17 actual reader forwards blind UI audit and rejects same-frame unit tampering, missing stage and false support projection',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec,f=await setup(t);
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.counts_as_relevant,true);assert.deepEqual(validateLearningCard(result).issues,[]);const ui=result.target_identity.displayed_ui_support;assert.equal(ui.receipt.descriptor.name,'displayed_ui_support');assert(ui.receipt.descriptor.input.evidence.every(r=>r[2]!=='raw_asr'));
 for(const mutate of [c=>c.target_identity.displayed_ui_support.selected_units[0].time++,c=>c.target_identity.displayed_ui_support.selected_units[0].object_quote='捏造',c=>c.target_identity.displayed_ui_support.receipt.descriptor.input.support_units[0].visual_id='F7_V',c=>c.target_identity.displayed_ui_support.receipt.descriptor.input.evidence.push(['S0',0,'raw_asr','added']),c=>c.target_identity.displayed_ui_support.selected_units=[null],c=>c.target_identity.displayed_ui_support.supported=false,c=>c.machine_output.stages=c.machine_output.stages.filter(s=>s.name!=='displayed_ui_support')]){const c=structuredClone(result);mutate(c);assert.doesNotThrow(()=>validateLearningCard(c));assert.equal(validateLearningCard(c).valid,false);}
});


test('v17 visual-only reader keeps a valid unknown card with null UI units and no invented text stages',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec,f=await setup(t);
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 f.state.visual={visible_text:'',visible_content:'画面中有配置式界面，没有识别出文字',uncertainties:[]};f.state.segments=[];
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.counts_as_relevant,false);assert.deepEqual(result.machine_output.stages.map(s=>s.name),['target_identity','displayed_ui_support']);assert(result.target_identity.displayed_ui_support.selected_units.every(u=>u.object_quote===null));assert.equal(result.target_identity.displayed_ui_support.supported,false);assert.deepEqual(validateLearningCard(result).issues,[]);
});

test('v18 reader contract accepts held metadata-only and same-line single-chapter cards without upgrading them',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec;
 for(const chapter of [false,true]){
  const f=await setup(t);f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
  if(chapter){f.state.hint='多个配置章节';f.state.ground={topic_quotes:['<第一队 青羽配置>']};f.state.visual=n=>({visible_text:n<4?'<第一队 青羽配置> 青羽 Lv.44 3 4':'【第二队 北辰配置】 北辰 Lv.45 3 4',visible_content:'配置界面',uncertainties:[]});}
  else {f.state.hint='数据面板';f.state.ground={topic_quotes:[]};f.state.visual={visible_text:'数据分析\n有效距离 5\n战法品质 A级\n简 详\n93.75万',visible_content:'数据配置面板',uncertainties:[]};}
  const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.counts_as_relevant,false);assert.deepEqual(validateLearningCard(result).issues,[]);
  if(chapter){assert.equal(result.primary_topic.section_scope.status,'section_index');const bad=structuredClone(result);bad.primary_topic.section_scope.headings[0].start++;assert.equal(validateLearningCard(bad).valid,false);}
  else assert.equal(result.target_identity.displayed_ui_support.supported,false);
  const fake=structuredClone(result);fake.counts_as_relevant=true;assert.equal(validateLearningCard(fake).valid,false);
 }
});

test('v18 actual reader keeps explicit unreadable-frame exclusion provenance and refuses a one-UI-time support claim',async t=>{
 const {candidateLearningContract,validateLearningCard}=await import('../app/learning-contract.mjs'),spec=candidateLearningContract().spec,f=await setup(t);
 f.ctx.identity=structuredClone(spec.vision.identity);f.ctx.analysisIdentity=structuredClone(spec.analysis.identity);f.ctx.model.cacheParameters=options=>structuredClone(options.contextLength===8192?spec.vision:spec.analysis);
 f.state.visual=n=>n===2?{visible_text:'青羽 Lv.44 3 4',visible_content:'配置界面',uncertainties:[]}:{visible_text:'',visible_content:'无明显文字、界面或可辨识人物动作',uncertainties:[]};f.state.hint='青羽配置';f.state.ground={topic_quotes:['青羽']};f.state.reply.relevance_ids=['F1_V'];
 const result=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(result.counts_as_relevant,false);assert.equal(result.target_identity.displayed_ui_support.excluded_frames.length,7);assert.deepEqual(validateLearningCard(result).issues,[]);
 const bad=structuredClone(result);bad.target_identity.displayed_ui_support.excluded_frames=[];assert.equal(validateLearningCard(bad).valid,false);
});

test('v19 production reader keeps old visual identity separate, uses actual frame-bound 8B pixels only and makes no witness substitution',async t=>{
 const f=await setup(t);const first=await inspectEvidenceLearningMedia(row,f.ctx);assert(first.target_identity.pixel_witness.supported);assert.equal(f.pixelCalls.length,3);assert.equal(first.model_roles.vision_identity.name,identity.name);assert.equal(first.target_identity.pixel_witness.receipts[0].descriptor.model_identity.name,LEARNING_PIXEL_WITNESS_MODEL.name);
 for(const c of f.pixelCalls){assert.equal(c.options.maxAttempts,1);assert.equal(c.input.task,'independent_actual_frame_components_and_fixed_quote_roles');assert.deepEqual(Object.keys(c.input),['task','quotes']);assert.equal(c.options.images.length,1);assert(!JSON.stringify(c.input).includes(row.title));assert.equal(c.options.tools,undefined);}
 assert(first.learning_card.relevance_basis.every(b=>b.pixel_checkpoint));assert(first.target_identity.v18_audit.relevance_basis.length);assert.equal(first.machine_output.pixel_witness_model_calls,3);
 const second=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(f.pixelCalls.length,3);assert.equal(second.machine_output.pixel_witness_model_calls,0);assert.equal(second.machine_output.cached,true);
 delete f.ctx.pixelWitnessModel;delete f.ctx.pixelWitnessIdentity;const missing=await inspectEvidenceLearningMedia(row,f.ctx);assert.equal(missing.counts_as_relevant,false);assert.equal(missing.target_identity.pixel_witness.status,'missing_provider');assert.equal(f.pixelCalls.length,3);
});

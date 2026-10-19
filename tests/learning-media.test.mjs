import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Tasks,hash} from '../app/tasks.mjs';
import {inspectLearningMedia,learningMediaFingerprint} from '../app/learning-media.mjs';
const id='7696364710773525760';
const row={provider:'redfox',kind:'video',source_id:id,source_url:`https://www.douyin.com/video/${id}`,collection_request_id:'query-one',game:'率土之滨',title:'不能把这条标题给视觉模型',author:'测试作者'};
const identity={name:'fixture-vision',digest:'digest-one'},asrIdentity={name:'fixture-whisper-small',digest:'asr-digest-one'};
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'learning-media-'));const db=new Tasks(dir);const files=join(dir,'media');await mkdir(files);const folder=pathToFileURL(files+'/');
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const times=[0,4,8,12,16,20,24,29.7];let sourceHash=hash('controlled-media-fixture');
 const frames={source_id:id,source_sha256:sourceHash,duration:30,frames:[]};
 for(const time of times){const file=`frame-${time}.png`,bytes=Buffer.from('fixture-'+time);await writeFile(new URL(file,folder),bytes);frames.frames.push({file,actual_time:time,sha256:hash(bytes)});}
 await writeFile(new URL('frames.json',folder),JSON.stringify(frames));await writeFile(new URL('audio.json',folder),JSON.stringify({source_id:id,source_sha256:sourceHash,duration:30,start:0,end:30,url:row.source_url}));await writeFile(new URL('audio.webm',folder),'controlled-audio-fixture');
 let visual=0,synthesis=0,asr=0;const inputs=[];
 const card={summary:'画面介绍率土之滨开荒界面',content_type:'玩法讲解',game_relevance:'relevant',relationship_type:'direct_game',relevance_basis:[{source_id:id,time:4,text:'实际画面字幕含率土之滨',evidence_type:'visual_text',quote:'率土之滨',segment_index:-1}],viewer_value:'介绍画面可见的开荒操作',quality_notes:[{source_id:id,time:4,text:'字幕可读'}],uncertainties:[],blocking_gaps:[],needs_audio_review:true,term_corrections:[{segment_index:0,original:'病',replacement:'滨',evidence_time:4,subtitle_quote:'率土之滨'}]};
 const model={json:async(system,input,schema,options)=>{
  inputs.push({system,input,options});
  if(options.images?.length){visual++;return {visible_text:'率土之滨 开荒',visible_content:'实际游戏地图和队伍界面',uncertainties:[]};}
  synthesis++;return structuredClone(card);
 }};
 const transcribe=async()=>{asr++;const audioHash=hash(await readFile(new URL('audio.webm',folder)));const value={source_id:id,audio_sha256:audioHash,audio_duration:30,status:'machine_transcript_pending_review',model:'fixture-whisper-small',segments:[{start:3,end:5,text:'率土之病开荒',avg_logprob:-.1},{start:9,end:10,text:'这个队伍'}]};await writeFile(new URL('transcript.json',folder),JSON.stringify(value));return value;};
 const assets={read:async()=>({source_id:id,source_sha256:sourceHash,duration:30})};
 const ctx={db,model,identity,asrIdentity,assets,folder,prepare:async()=>{},transcribe};
 return {ctx,db,folder,frames,card,inputs,counts:()=>({visual,synthesis,asr}),setSource:value=>{sourceHash=value;}};
}
test('eight independent actual frames precede whole-audio ASR and grounded recognition; no title or ASR in vision',async t=>{
 const f=await setup(t);const value=await inspectLearningMedia(row,f.ctx);
 assert.deepEqual(f.counts(),{visual:8,synthesis:1,asr:1});assert.deepEqual(value.coverage.times,[0,4,8,12,16,20,24,29.7]);
 for(const call of f.inputs.slice(0,8)){assert.equal(call.options.images.length,1);assert.equal(JSON.stringify(call.input).includes(row.title),false);assert.equal(JSON.stringify(call.input).includes('率土'),false);assert.equal(call.input.raw_segments,undefined);}
 assert.equal(value.id,'video:'+id);assert.equal(value.counts_as_relevant,true);assert.equal(value.transcript.raw_segments[0].text,'率土之病开荒');assert.equal(value.transcript.reviewed_segments[0].text,'率土之滨开荒');
 assert.equal(value.subtitle_review.status,'machine_subtitle_point_checked');assert.equal(value.subtitle_review.human_reviewed,false);assert.equal(value.analysis.needs_audio_review,true);assert.equal(value.coverage.sound_effects,'not_read');
 assert.deepEqual(value.subtitle_review.unverified_segment_indices,[0,1]);assert.equal(f.db.checkpoint('learning-media-attempt:'+id).status,'observed');
});
test('corrections without matching raw term, exact independent OCR or same-time evidence never alter ASR',async t=>{
 const f=await setup(t);f.card.term_corrections=[
  {segment_index:0,original:'病',replacement:'不存在',evidence_time:4,subtitle_quote:'率土之滨'},
  {segment_index:0,original:'病',replacement:'滨',evidence_time:24,subtitle_quote:'率土之滨'},
  {segment_index:0,original:'假的',replacement:'滨',evidence_time:4,subtitle_quote:'率土之滨'},
  {segment_index:0,original:'病',replacement:'滨',evidence_time:4,subtitle_quote:'编造字幕滨'},
 ];
 const value=await inspectLearningMedia(row,f.ctx);assert.equal(value.transcript.reviewed_segments[0].text,'率土之病开荒');assert.equal(value.subtitle_review.term_corrections.length,0);assert.equal(value.subtitle_review.rejected_corrections.length,4);assert.equal(value.counts_as_relevant,false);
});
test('unrelated material remains traceable and is not counted toward relevant sample quota',async t=>{
 const f=await setup(t);f.card.game_relevance='unrelated';f.card.term_corrections=[];
 const value=await inspectLearningMedia(row,f.ctx);assert.equal(value.learning_status,'needs_review');assert.equal(value.counts_as_relevant,false);assert.match(value.analysis.blocking_gaps.join(' '),/未证实与目标游戏相关/);
});
test('cancel and resume retains completed frame checkpoints without inventing successful evidence',async t=>{
 const f=await setup(t),controller=new AbortController();const original=f.ctx.model.json;let calls=0;
 f.ctx.model.json=async(...args)=>{const value=await original(...args);if(++calls===2)controller.abort(Error('user cancelled'));return value;};
 await assert.rejects(inspectLearningMedia(row,{...f.ctx,signal:controller.signal}),/user cancelled/);assert.equal(f.db.checkpoint('learning-media-attempt:'+id).status,'cancelled');
 f.ctx.model.json=original;await inspectLearningMedia(row,f.ctx);assert.equal(f.counts().visual,9);assert.equal(f.counts().asr,1);assert.equal(f.counts().synthesis,1);
});
test('same evidence reuses checkpoints but model, frame and audio mutations invalidate relevant caches',async t=>{
 const f=await setup(t);await inspectLearningMedia(row,f.ctx);const before=await learningMediaFingerprint(row,f.ctx);assert.ok(before);
 await inspectLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:8,synthesis:1,asr:1});
 f.ctx.identity={...identity,digest:'digest-two'};assert.notEqual(await learningMediaFingerprint(row,f.ctx),before);await inspectLearningMedia(row,f.ctx);assert.equal(f.counts().visual,16);assert.equal(f.counts().asr,1);
 const frame=f.frames.frames[0];await writeFile(new URL(frame.file,f.folder),'changed actual bytes');frame.sha256=hash(Buffer.from('changed actual bytes'));await writeFile(new URL('frames.json',f.folder),JSON.stringify(f.frames));await inspectLearningMedia(row,f.ctx);assert.equal(f.counts().visual,24);
 await writeFile(new URL('audio.webm',f.folder),'changed audio');assert.equal(await learningMediaFingerprint(row,f.ctx),null);await inspectLearningMedia(row,f.ctx);assert.equal(f.counts().visual,32);assert.equal(f.counts().asr,2);
});
test('source manifest mismatch and missing assets stop before any model or transcription',async t=>{
 const f=await setup(t);f.setSource(hash('replacement'));await assert.rejects(inspectLearningMedia(row,f.ctx),/prepare/);assert.deepEqual(f.counts(),{visual:0,synthesis:0,asr:0});assert.equal(await learningMediaFingerprint(row,f.ctx),null);
 await assert.rejects(inspectLearningMedia(row,{...f.ctx,assets:{read:async()=>{throw Error('no local source');}}}),/prepare/);assert.equal(f.db.checkpoint('learning-media-attempt:'+id).status,'failed');
});
test('invented frame citations and oversized visual results fail visibly without filling a quota',async t=>{
 const f=await setup(t);f.card.quality_notes[0].time=7;await assert.rejects(inspectLearningMedia(row,f.ctx),/synthesis/);assert.equal(f.db.checkpoint('learning-media-attempt:'+id).status,'failed');
 const next=await setup(t);next.ctx.model.json=async()=>({visible_text:'x'.repeat(5001),visible_content:'test',uncertainties:[]});await assert.rejects(inspectLearningMedia(row,next.ctx),/visual/);assert.equal(next.db.checkpoint('learning-media-attempt:'+id).phase,'visual');
});
test('too few actual frames remain a coverage gap instead of duplicating frames',async t=>{
 const f=await setup(t);f.frames.frames=f.frames.frames.slice(0,3);await writeFile(new URL('frames.json',f.folder),JSON.stringify(f.frames));const value=await inspectLearningMedia(row,f.ctx);assert.equal(value.coverage.sample_count,3);assert.equal(value.counts_as_relevant,false);assert.match(value.analysis.blocking_gaps.join(' '),/不足6帧/);
});
test('ASR model digest, transcript bytes and target game participate in learning reuse',async t=>{
 const f=await setup(t);await inspectLearningMedia(row,f.ctx);const before=await learningMediaFingerprint(row,f.ctx);
 assert.notEqual(await learningMediaFingerprint({...row,game:'另一游戏'},f.ctx),before);
 f.ctx.asrIdentity={...asrIdentity,digest:'changed-asr-weights'};assert.notEqual(await learningMediaFingerprint(row,f.ctx),before);
 await inspectLearningMedia(row,f.ctx);assert.equal(f.counts().asr,2);assert.equal(f.counts().visual,8);
 const path=new URL('transcript.json',f.folder),saved=JSON.parse(await readFile(path,'utf8'));saved.segments[0].text='外部修改后的转写';await writeFile(path,JSON.stringify(saved));
 await inspectLearningMedia(row,f.ctx);assert.equal(f.counts().asr,3);assert.equal(f.counts().visual,8);
});
test('same-theme Three Kingdoms skit is not counted as direct game learning despite a relevant label',async t=>{
 const f=await setup(t);f.card.relationship_type='same_theme';f.card.term_corrections=[];f.card.relevance_basis=[{source_id:id,time:4,text:'共用三国题材',evidence_type:'visual_content',quote:'三国人物情景剧',segment_index:-1}];
 const original=f.ctx.model.json;f.ctx.model.json=async(...args)=>args[3].images?.length?{visible_text:'刘备 张飞',visible_content:'三国人物情景剧',uncertainties:[]}:original(...args);
 const value=await inspectLearningMedia(row,f.ctx);assert.equal(value.learning_card.relationship_type,'same_theme');assert.equal(value.counts_as_relevant,false);assert.match(value.analysis.blocking_gaps.join(' '),/同题材/);
});
test('relevance quote must exist in the independently read source, not only a valid timestamp',async t=>{
 const f=await setup(t);f.card.relevance_basis[0].quote='帧上不存在的游戏证据';
 await assert.rejects(inspectLearningMedia(row,f.ctx),e=>e.cause?.message.includes('未匹配独立观察'));
 assert.equal(f.db.checkpoint('learning-media-attempt:'+id).phase,'synthesis');
});
test('silent subtitle announcement retains no-speech coverage without being automatically disqualified',async t=>{
 const f=await setup(t);f.card.relationship_type='explicit_game_discussion';f.card.content_type='游戏公告';f.card.term_corrections=[];
 const original=f.ctx.transcribe;f.ctx.transcribe=async()=>{const value=await original();value.segments=[];value.status='no_speech_recognized';await writeFile(new URL('transcript.json',f.folder),JSON.stringify(value));return value;};
 const value=await inspectLearningMedia(row,f.ctx);assert.equal(value.coverage.speech,'no_speech_detected');assert.equal(value.counts_as_relevant,true);assert.match(value.analysis.uncertainties.join(' '),/不代表声音内容已理解/);
});
test('low-confidence ASR alone does not establish a game discussion as relevant',async t=>{
 const f=await setup(t);f.card.relationship_type='explicit_game_discussion';f.card.term_corrections=[];f.card.relevance_basis=[{source_id:id,time:4,text:'原始语音提及游戏',evidence_type:'speech',quote:'率土之病',segment_index:0}];
 const original=f.ctx.transcribe;f.ctx.transcribe=async()=>{const value=await original();value.segments[0].no_speech_prob=.99;await writeFile(new URL('transcript.json',f.folder),JSON.stringify(value));return value;};
 const value=await inspectLearningMedia(row,f.ctx);assert.equal(value.counts_as_relevant,false);assert.match(value.analysis.blocking_gaps.join(' '),/低置信语音/);
});
test('underlying cause remains local while persistent diagnostics and public error stay redacted',async t=>{
 const f=await setup(t),underlying=new SyntaxError('secret-token https://private.invalid/path');underlying.code='secret-token';f.ctx.model.json=async()=>{throw underlying;};
 await assert.rejects(inspectLearningMedia(row,f.ctx),e=>{assert.equal(e.cause,underlying);assert.equal(JSON.stringify(e).includes('secret-token'),false);assert.equal(e.message.includes('secret-token'),false);return true;});
 const checkpoint=f.db.checkpoint('learning-media-attempt:'+id);assert.equal(checkpoint.failure_category,'INVALID_JSON');assert.equal(JSON.stringify(checkpoint).includes('secret-token'),false);
});
test('synthesis receives explicit ASR indices and normalizes only canonical indices while preserving raw output',async t=>{
 const f=await setup(t);f.card.term_corrections[0].segment_index='0';f.card.relevance_basis[0].segment_index='-1';
 const value=await inspectLearningMedia(row,f.ctx);
 const input=f.inputs.at(-1).input;assert.deepEqual(input.raw_segments.map(s=>s.segment_index),[0,1]);
 assert.equal(value.transcript.raw_segments[0].segment_index,undefined);
 assert.equal(value.learning_card.term_corrections[0].segment_index,0);assert.equal(value.learning_card.relevance_basis[0].segment_index,-1);
 const original=f.db.checkpoint(value.machine_output.raw_checkpoint);assert.equal(original.raw_output.term_corrections[0].segment_index,'0');assert.equal(original.raw_output.relevance_basis[0].segment_index,'-1');
 assert.equal(value.machine_output.card_version,'learning-card-3');assert.equal(value.machine_output.normalizations.length,2);
 await inspectLearningMedia(row,f.ctx);assert.deepEqual(f.counts(),{visual:8,synthesis:1,asr:1});
 assert.match(f.inputs.at(-1).system,/开头静音/);assert.match(f.inputs.at(-1).system,/不要仅抄长段画面描述/);
});
test('unsafe or missing indices are not guessed; raw failures remain locally inspectable',async t=>{
 for(const bad of ['0.0','1e0',' 0','00','2','9007199254740993',null,undefined]){
  const f=await setup(t);if(bad===undefined)delete f.card.term_corrections[0].segment_index;else f.card.term_corrections[0].segment_index=bad;
  await assert.rejects(inspectLearningMedia(row,f.ctx),e=>e.cause?.message.includes('segment_index'));
  const saved=f.db.db.prepare("SELECT value FROM checkpoints WHERE key LIKE 'learning-card:%:raw:%'").all().map(r=>JSON.parse(r.value));
  assert.equal(saved.length,1);assert.equal(saved[0].raw_output.term_corrections[0].segment_index,bad);
 }
});
test('index normalization never relaxes frame time or subtitle quote matching',async t=>{
 const f=await setup(t);f.card.term_corrections[0].segment_index='0';f.card.relevance_basis[0].time='4';
 await assert.rejects(inspectLearningMedia(row,f.ctx),e=>e.cause?.message.includes('time'));
 const other=await setup(t);other.card.term_corrections[0].segment_index='0';other.card.term_corrections[0].subtitle_quote='原帧不存在的字幕';
 const value=await inspectLearningMedia(row,other.ctx);assert.equal(value.subtitle_review.term_corrections.length,0);assert.equal(value.counts_as_relevant,false);
});

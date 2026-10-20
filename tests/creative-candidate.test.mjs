import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hash} from '../app/tasks.mjs';
import {prepareCreativeCandidate,runCreativeCandidate,validateCreativeCandidate,CREATIVE_CANDIDATE_VERSION} from '../app/creative-candidate.mjs';
import {fixture,output,fakeHost,PNG} from './helpers/creative-fixture.mjs';

test('single selected cross-game source + fixed partial profile yields one complete Host candidate, never ready or delivery',async t=>{
 const f=fixture(t),host=fakeHost(),result=await runCreativeCandidate(f.input,{host,dataRoot:f.root,auditDir:join(f.root,'creative-audit')});
 assert.equal(host.calls.length,1);assert.equal(result.version,CREATIVE_CANDIDATE_VERSION);assert.equal(result.status,'needs_review');assert.equal(result.accepted,false);assert.equal(result.ready,false);assert.equal(result.delivery_enabled,false);assert.equal(result.receipt.model,null);assert.equal(result.binding.profile_version,f.study.profile.version);assert.deepEqual({game:result.binding.game,mode:result.binding.mode,format:result.binding.format},{game:f.input.game,mode:'A',format:'video'});assert.deepEqual(result.receipt.input_binding,result.binding);assert.equal(result.plan.ideas.length,3);assert(result.draft.rows.some(row=>row[0]==='重点拆解'));assert(result.draft.rows.some(row=>row[0]==='游戏对照与结合'));assert.equal(result.draft_sha256,hash(result.draft));
 const call=host.calls[0];assert.equal(call.options.images.length,3);assert.deepEqual(call.options.images.map(f=>f.sha256),Array(3).fill(hash(PNG)));assert.equal(call.input.evidence.filter(e=>e.kind==='raw-asr').length,2);assert.deepEqual(call.input.evidence.filter(e=>e.kind==='raw-asr').map(e=>e.content),f.prepared.transcript.segments.map(s=>s.text));assert(!JSON.stringify(call.input).includes(f.root));assert.deepEqual(result.coverage.omitted_game_image_ids,['GF']);assert.equal(result.coverage.continuous_video_read,false);assert.equal(result.coverage.music_sound_effects_read,false);assert.equal(result.source_reading[0].locations[0].coverage.time,0);
 assert(!JSON.stringify({...result,receipt:null}).includes('/private/host'));assert.equal(f.study.profile.accepted,false);
});

test('game image reference is closed to actually chosen attachments; missing IDs and total excess reject before Host',async t=>{
 const f=fixture(t),p=await prepareCreativeCandidate(f.input,{dataRoot:f.root});const o=output();o.game_bridge[0].game_references=[{id:'game:GF',quote:''}];assert.throws(()=>validateCreativeCandidate(o,p),{code:'CREATIVE_REFERENCE_INVALID'});
 f.input.studyImageIds=['GF'];const withImage=await prepareCreativeCandidate(f.input,{dataRoot:f.root});assert.equal(withImage.images.length,4);assert.equal(withImage.evidence.find(e=>e.id==='game:GF').image_index,4);validateCreativeCandidate(o,withImage);
 f.input.studyImageIds=['not-found'];await assert.rejects(prepareCreativeCandidate(f.input,{dataRoot:f.root}),{code:'CREATIVE_GAME_IMAGES'});
 f.input.studyImageIds=[];for(let i=0;i<10;i++){const s={...f.study.packet.sources[1],id:'G'+i};f.study.packet.sources.push(s);f.input.studyImageIds.push(s.id);}f.study.binding.packet_sha256=hash(f.study.packet);await assert.rejects(prepareCreativeCandidate(f.input,{dataRoot:f.root}),{code:'CREATIVE_ATTACHMENT_LIMIT'});
});

test('wrong source/profile identities, file tamper, manifest ASR namespace and source path escape stop before inference',async t=>{
 for(const mutate of [f=>f.input.study.game='other',f=>f.input.selected.row.collection_request_id='other',f=>f.prepared.source_sha256='f'.repeat(64),f=>f.prepared.transcript.source_id='media_wrong',f=>f.prepared.frames[0].time=7,f=>f.media.path='/etc/hosts',f=>f.study.profile.draft.game='other']){
  const f=fixture(t),host=fakeHost();mutate(f);await assert.rejects(runCreativeCandidate(f.input,{host,dataRoot:f.root}));assert.equal(host.calls.length,0);
 }
 const f=fixture(t),host=fakeHost();writeFileSync(f.media.path,'changed original bytes');await assert.rejects(runCreativeCandidate(f.input,{host,dataRoot:f.root}),{code:'STUDY_EVIDENCE_HASH'});assert.equal(host.calls.length,0);
});

test('exact quotes and all references validate even insufficient; ASR cannot be direct game facts',async t=>{
 const f=fixture(t),p=await prepareCreativeCandidate(f.input,{dataRoot:f.root});
 for(const mutate of [o=>o.game_bridge[0].game_references[0].quote='原文没有的效果',o=>o.source_reading[0].evidence_ids=['game:P'],o=>o.plan.ideas[0].evidence_ids=['selected:F0'],o=>{o.plan.fit='insufficient';o.plan.ideas[0].evidence_ids=['unknown'];}]){const o=output();mutate(o);assert.throws(()=>validateCreativeCandidate(o,p));}
 const o=output();o.game_bridge[0].relation='direct';const altered=structuredClone(p);altered.evidence.find(e=>e.id==='game:P').kind='raw-asr';assert.throws(()=>validateCreativeCandidate(o,altered),{code:'CREATIVE_DIRECT_GAME_FACT_REQUIRED'});
 const insufficient=output();insufficient.plan.fit='insufficient';insufficient.plan.blocking_gaps=['关键声音未读取'];insufficient.plan.ideas=[];const host=fakeHost(insufficient),r=await runCreativeCandidate(f.input,{host,dataRoot:f.root});assert.equal(r.status,'needs_input');assert.equal(r.accepted,false);assert.equal(host.calls.length,1);
});

test('silent source does not invent transcript; signal, failure, bad receipt and changed files have no retry or late output',async t=>{
 const f=fixture(t,{hasAudio:false}),p=await prepareCreativeCandidate(f.input,{dataRoot:f.root});assert.equal(p.coverage.speech,'no_audio_track');assert.equal(p.evidence.filter(e=>e.kind==='raw-asr').length,0);
 const controller=new AbortController();controller.abort();const host=fakeHost();await assert.rejects(runCreativeCandidate(f.input,{host,dataRoot:f.root,signal:controller.signal}));assert.equal(host.calls.length,0);
 let calls=0;await assert.rejects(runCreativeCandidate(f.input,{host:{async json(){calls++;throw Object.assign(Error('timeout'),{code:'HOST_TIMEOUT'});}},dataRoot:f.root}),{code:'HOST_TIMEOUT'});assert.equal(calls,1);
 const bad=fakeHost();const original=bad.json;bad.json=async(...args)=>{const r=await original(...args);r.receipt.tool_events=1;return r;};await assert.rejects(runCreativeCandidate(f.input,{host:bad,dataRoot:f.root}),{code:'CREATIVE_HOST_RECEIPT'});assert.equal(bad.calls.length,1);
 const changed=fakeHost(output(),()=>writeFileSync(f.prepared.frames[0].path,'tampered'));await assert.rejects(runCreativeCandidate(f.input,{host:changed,dataRoot:f.root}),{code:'STUDY_EVIDENCE_HASH'});assert.equal(changed.calls.length,1);
});

test('binding captures exact verified game, mode and format for lifecycle comparison',async t=>{
 const f=fixture(t);f.input.mode='B';f.input.format='image';const p=await prepareCreativeCandidate(f.input,{dataRoot:f.root});assert.equal(p.binding.game,f.input.game);assert.equal(p.binding.mode,'B');assert.equal(p.binding.format,'image');assert.equal(p.binding.input_sha256,hash(p.input));
 f.input.mode='A';f.input.format='video';assert.equal(p.binding.mode,'B');assert.equal(p.binding.format,'image');
});

test('selected-video supplemental frames are attached with closed IDs and independently hashed before Host',async t=>{
 const f=fixture(t),dir=join(f.root,'supplement');mkdirSync(dir);
 const frames=[1,2,3,5,6,7].map((n,i)=>({file:`frame-${i}.png`,path:join(dir,`frame-${i}.png`),time:10*n/8,sha256:hash(PNG)}));for(const frame of frames)writeFileSync(frame.path,PNG);
 const manifest_path=join(dir,'manifest.json'),manifest={version:'creative-supplement-1',source_sha256:f.media.sha256,source_size:f.media.size,duration:10,created_at:'2026-10-20T00:00:00Z',frames:frames.map(({path,...value})=>value)};writeFileSync(manifest_path,JSON.stringify(manifest));
 f.prepared.supplemental={version:manifest.version,manifest_path,frames};
 const p=await prepareCreativeCandidate(f.input,{dataRoot:f.root});assert.equal(p.images.length,9);assert.equal(p.evidence.find(e=>e.id==='selected:F8').coverage.time,8.75);assert.equal(p.coverage.frames.length,9);
 const o=output();o.source_reading[0].evidence_ids=['selected:F8'];validateCreativeCandidate(o,p);
 frames[0].time=9;const host=fakeHost();await assert.rejects(runCreativeCandidate(f.input,{host,dataRoot:f.root}),{code:'CREATIVE_MEDIA_SUPPLEMENT'});assert.equal(host.calls.length,0);
 frames[0].time=1.25;writeFileSync(frames[1].path,'changed supplemental frame');await assert.rejects(runCreativeCandidate(f.input,{host,dataRoot:f.root}),{code:'STUDY_EVIDENCE_HASH'});assert.equal(host.calls.length,0);
});

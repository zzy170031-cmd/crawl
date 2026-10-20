import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {hash} from '../app/tasks.mjs';
import {createCreativeSourceReader} from '../app/creative-source.mjs';
import {creativeTaskRequest} from '../app/creative-task.mjs';
import {createCreativeRuntime} from '../app/creative-runtime.mjs';
import {runCreativeCandidate} from '../app/creative-candidate.mjs';
import {fixture,output,fakeHost} from './helpers/creative-fixture.mjs';

function localize(f){
 const row={provider:'local_upload',kind:'video',source_id:'local_'+f.media.sha256,sha256:f.media.sha256,game:f.input.game,title:'本地视频',source_url:null,author:null,
  published_at:null,published_date:null,publication_date:null,like_count:null,comment_count:null,share_count:null,collect_count:null,
  uploaded_at:'2026-10-20T00:00:00Z',size:f.media.size,contentType:'video/mp4',duration_ms:10000,has_audio:true,learning_status:'not_started'};
 f.input.selected={row,origin:{provider:'local_upload',fingerprint:hash(row)},media:f.media,prepared:f.prepared};
 f.study.profile.learning_source='local';f.study.packet.learning_source='local';f.study.binding.profile_sha256=hash(f.study.profile);f.study.binding.packet_sha256=hash(f.study.packet);
 return {game:f.input.game,mode:'A',format:'video',study_task_id:f.study.binding.task_id,profile_version:f.study.profile.version,source:{provider:'local_upload',source_id:row.source_id}};
}
test('local request accepts only a server-owned hash identity in A, never URL/path/collection metadata or local hotspot B',t=>{
 const f=fixture(t),request=localize(f);assert.deepEqual(creativeTaskRequest(request),request);
 for(const source of [{...request.source,path:f.media.path},{...request.source,request_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},{...request.source,url:'https://www.douyin.com/video/1234567890'},{provider:'local_upload',source_id:'1234567890'}])
  assert.throws(()=>creativeTaskRequest({...request,source}),{code:'CREATIVE_TASK_INPUT'});
 assert.throws(()=>creativeTaskRequest({...request,mode:'B'}),{code:'CREATIVE_TASK_INPUT'});
});
test('local reader binds exact game and bytes identity, cannot treat open-by-hash as cross-game authorization',t=>{
 const f=fixture(t),r=localize(f),row=f.input.selected.row;let opens=0,networkReads=0;
 const reader=createCreativeSourceReader({bridge:{get(){networkReads++;assert.fail('local source must not read collection');}},localVideos:{list:game=>game===f.input.game?[structuredClone(row)]:[],open:id=>{opens++;return {source_id:id,...f.media};}}});
 const value=reader.read({game:r.game,mode:'A',...r.source});assert.equal(value.origin.fingerprint,hash(row));assert.equal(value.collection,undefined);assert.equal(value.media.sha256,f.media.sha256);assert.equal(networkReads,0);
 assert.throws(()=>reader.read({game:'另一个游戏',mode:'A',...r.source}),{code:'CREATIVE_SOURCE_REQUIRED'});assert.equal(opens,1);
 assert.throws(()=>reader.read({game:r.game,mode:'B',...r.source}),{code:'CREATIVE_SOURCE_REQUIRED'});
 row.like_count=100;assert.throws(()=>reader.read({game:r.game,mode:'A',...r.source}),{code:'CREATIVE_SOURCE_REQUIRED'});
});
test('local A engine keeps source hash without a fabricated public URL/collection and preserves evidence closure',async t=>{
 const f=fixture(t);localize(f);const host=fakeHost(),result=await runCreativeCandidate(f.input,{host,dataRoot:f.root});
 assert.equal(result.status,'needs_review');assert.equal(host.calls.length,1);assert.equal(result.binding.source_provider,'local_upload');assert.equal(result.binding.collection_request_id,undefined);
 assert.equal(result.binding.source_sha256,f.media.sha256);assert.equal(result.binding.local_source_fingerprint,hash(f.input.selected.row));
 const src=host.calls[0].input.source;assert.equal(src.url,null);assert.equal(src.published_at,null);assert.equal(src.like_count,null);assert.equal(src.collection_request_id,undefined);
 assert(result.draft.rows.some(r=>r[0]==='本地选题原片'&&r[1]==='本地视频'));assert(result.draft.source_notes.some(n=>n.source_id===src.source_id&&n.url===null));assert(result.draft.links.every(l=>typeof l.url==='string'&&l.url.startsWith('https://')));
 assert(!JSON.stringify(result).includes(f.root));assert(!result.draft.links.some(l=>l.url.includes('local_')));
 const bad=structuredClone(f.input);bad.selected.row.game='other';await assert.rejects(runCreativeCandidate(bad,{host,dataRoot:f.root}),{code:'CREATIVE_SELECTED_BINDING'});assert.equal(host.calls.length,1);
});
test('B uses an unchanged saved network source with a local fixed profile and no invented local link',async t=>{
 const f=fixture(t),network=structuredClone(f.input.selected);localize(f);f.input.selected=network;f.input.mode='B';
 const gameFrame=f.study.packet.sources.find(s=>s.id==='GF');gameFrame.source_id='local_'+hash('game-original');
 f.study.packet.library={records:[{source_id:gameFrame.source_id,title:'星际猎人关卡实录'}]};
 f.study.profile.draft.background_and_loop=[{references:[{id:'GF'}]}];f.input.studyImageIds=['GF'];
 f.study.binding.profile_sha256=hash(f.study.profile);f.study.binding.packet_sha256=hash(f.study.packet);
 const host=fakeHost(),result=await runCreativeCandidate(f.input,{host,dataRoot:f.root});
 assert.equal(host.calls.length,1);assert.equal(result.binding.collection_request_id,network.collection.request_id);assert.equal(result.binding.source_id,network.row.source_id);
 assert(result.draft.rows.some(r=>r[0]==='本地游戏参考'&&!r.join('').includes('local_')));assert(result.draft.source_notes.some(n=>n.source_id===gameFrame.source_id));assert(!result.draft.links.some(l=>l.url.includes('local_')));
 assert.equal(result.draft.source_notes.find(n=>n.source_id===gameFrame.source_id).title,'星际猎人关卡实录');
});
function runtimeFixture(t){
 const f=fixture(t),request=localize(f),cli=join(f.root,'mock-cli');writeFileSync(cli,'unused');chmodSync(cli,0o700);
 const host=fakeHost(output(f.input.game)),calls={network:0,media:0};let row=f.input.selected.row;
 const reader=createCreativeSourceReader({bridge:{get(){assert.fail('no network query');}},localVideos:{list:game=>game===f.input.game?[structuredClone(row)]:[],open:id=>({source_id:id,...f.media})}});
 const make=()=>{
  const runtime=createCreativeRuntime({dataRoot:f.root,cliPath:cli,python:'mock-only',isEnabled:()=>true,
   getStudyEvidence:async()=>structuredClone(f.study),getSource:({signal,...r})=>reader.read(r),
   assets:{read(){calls.network++;assert.fail('local source must not use RedFox asset reader');}},
   hostFactory:()=>host,mediaFactory:()=>({prepare:async()=>{calls.media++;return structuredClone(f.prepared);}})});
  t.after(()=>runtime.close());return runtime;
 };
 return {...f,request,host,calls,make,changeRow:()=>{row={...row,title:'changed server binding'};}};
}
test('real candidate lifecycle handles local capture, dedupe, restart, verified read and source tamper without repeat inference',async t=>{
 const f=runtimeFixture(t),one=f.make(),task=await one.start(f.request);await one.idle();
 const done=one.read(task.id);assert.equal(done.state,'completed',done.error);assert.equal(done.result.binding.source_provider,'local_upload');assert.equal(f.host.calls.length,1);assert.equal(f.calls.network,0);
 assert.equal((await one.start(f.request)).id,task.id);await one.idle();assert.equal(f.host.calls.length,1);
 assert.deepEqual((await one.readVerified(task.id)).result,done.result);await one.close();
 const two=f.make();assert.deepEqual((await two.readVerified(task.id)).result,done.result);assert.equal(f.host.calls.length,1);
 writeFileSync(f.media.path,'changed');
 await assert.rejects(two.readVerified(task.id));assert.equal(f.host.calls.length,1);assert.equal(f.calls.network,0);
});
test('local content mutation before task capture fails before media preparation or Host; metadata drift blocks verified read',async t=>{
 const f=runtimeFixture(t),runtime=f.make();writeFileSync(f.media.path,'changed original bytes');
 await assert.rejects(runtime.start(f.request),{code:'STUDY_EVIDENCE_HASH'});assert.equal(f.host.calls.length,0);assert.equal(f.calls.media,0);assert.equal(runtime.list().length,0);
 const g=runtimeFixture(t),r=g.make(),task=await r.start(g.request);await r.idle();g.changeRow();
 await assert.rejects(r.readVerified(task.id),{code:'CREATIVE_TASK_SOURCE_CHANGED'});assert.equal(g.host.calls.length,1);
});

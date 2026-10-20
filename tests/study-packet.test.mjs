import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createStudyPacketBuilder} from '../app/study-packet.mjs';
import {prepareGameStudy,calculateComparisonMetrics,studyCoverage} from '../app/game-study.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const at='2026-10-20T00:00:00Z',game='海城试验',ctx={game,learning_source:'network'};
function library(n=1,unavailable=[]){
 const items=Array.from({length:n},(_,i)=>{
  const source_id=String(7695600881273670000n+BigInt(i)),digest=sha('media'+i);
  const record={provider:'redfox',game,source_id,kind:'video',title:'只保存标题，不根据标题分类 '+i,source_url:'https://www.douyin.com/video/'+source_id,author:null,collection_request_id:'saved-query',collected_at:at,uploaded_at:null,published_at:null,published_date:'2026-10-15',publication_date:'2026-10-15',publication_precision:'day',duration_ms:10000,like_count:null,comment_count:null,share_count:null,collect_count:null,learning_status:'not_started'};
  const missing=unavailable.includes(i);
  return {library_id:'media_'+digest,record,origins:[structuredClone(record)],media:missing?null:{path:'/controlled/'+i+'.mp4',sha256:digest,size:100,contentType:'video/mp4'},availability:missing?'unavailable':'available',unavailable_reason:missing?'original_not_available':null};
 });
 return {game,items,records:items.map(i=>({...i.record,library_id:i.library_id,origins:i.origins,sha256:i.media?.sha256??null,availability:i.availability,unavailable_reason:i.unavailable_reason})),binding:{source_provider:'game_study_library',game,library_id:'library_'+'a'.repeat(64),library_fingerprint:'a'.repeat(64),collection:{source_provider:'redfox',collection_request_id:'saved-query',collection_fingerprint:'b'.repeat(64),collected_at:at,window:{start_date:'2026-10-12',end_date:'2026-10-18',update_policy:'T+1'}}}};
}
function media(item,{audio=true,empty=false}={}){
 return {source_sha256:item.media.sha256,duration:10,has_audio:audio,frames:[0,5,9.7].map((time,i)=>({time,path:'/controlled/'+item.record.source_id+'-'+i+'.png',sha256:sha(item.record.source_id+':'+i)})),transcript:audio?{source_id:'media_'+item.media.sha256,audio_sha256:sha('audio'),status:empty?'no_speech_recognized':'machine_transcript_pending_review',segments:empty?[]:[{start:0.123456,end:2.345678,text:' 未核原字，不能纠词 ',avg_logprob:-0.8},{start:7,end:10,text:'尾段原文'}]}:null};
}
function refs(n=0){
 const sources=[{id:'publisher',kind:'publisher',game,read_at:at,content:'发行方介绍原句。',content_sha256:sha('发行方介绍原句。'),coverage:{kind:'publisher_page',read_scope:'full_saved_text'}}],images=[];
 for(let i=0;i<n;i++){const file={path:'/controlled/page'+i+'.png',sha256:sha('page'+i)};sources.push({id:'page'+i,kind:'image-page',game,source_id:'post',read_at:at,file,coverage:{page_index:i+1,page_count:n}});images.push(file);}
 return {sources,images,files:[]};
}
test('selects readable representatives using deterministic metadata diversity; actual middle frames/full raw ASR; snapshot and classifications unchanged',async()=>{
 const lib=library(10,[0]),before=structuredClone(lib),calls=[],signal=new AbortController().signal;
 lib.items.reverse();const frozen=structuredClone(lib);
 const builder=createStudyPacketBuilder({prepareMedia:async(item,options)=>{assert.equal(options.signal,signal);calls.push(item.record.source_id);const out=media(item);item.record.title='provider mutation';return out;},readReferences:async args=>{assert.equal(args.signal,signal);assert.equal(args.game,game);args.library_binding.game='provider mutation';return refs(4);}});
 const out=await builder.preparePacket(lib,{...ctx,signal});
 assert.deepEqual(calls,before.records.slice(1,9).map(r=>r.source_id));assert.equal(out.images.length,12);assert.equal(out.packet.representative_samples.length,8);
 assert.deepEqual(out.packet.library.records,lib.records);assert.deepEqual(lib,frozen);assert.deepEqual(out.packet.library.binding,lib.binding);
 assert(!out.packet.library.records.some(r=>r.classification));assert.equal(out.packet.sources.find(s=>s.kind==='video-frame').coverage.time,5);
 const asr=out.packet.sources.find(s=>s.kind==='raw-asr');assert.equal(asr.content,'[0.123456-2.345678]  未核原字，不能纠词 \n[7-10] 尾段原文');assert.equal(asr.coverage.subtitle_verified,false);assert.equal(asr.coverage.raw_segments[0].avg_logprob,-0.8);
 const ready=prepareGameStudy(out.packet,out);assert.equal(calculateComparisonMetrics(ready).groups[0].classification_status,'unknown');
});
test('silent and unrecognized audio are distinct; fewer sources remains a usable partial packet without fabricated transcript',async()=>{
 const lib=library(2),builder=createStudyPacketBuilder({prepareMedia:async item=>media(item,{audio:item.record.source_id===lib.records[1].source_id,empty:true})});
 const out=await builder.preparePacket(lib,ctx);assert.equal(out.packet.sources.length,2);assert.deepEqual(out.packet.sources.map(s=>s.coverage.audio_state),['no_audio_stream','no_recognized_speech']);
 const p=prepareGameStudy(out.packet,out),draft={background_and_loop:[],player_situations:[],necessary_terms:[],content_types:[],peer_transfer:[],platform_actions:[]};
 assert.equal(studyCoverage(p,calculateComparisonMetrics(p),draft).status,'partial');
});
test('wrong source/game/item correspondence and local requests fail before providers; no acquisition dependency exists',async()=>{
 for(const mutate of [l=>l.game='other',l=>l.binding.collection.source_provider='browser',l=>l.records[0].game='other',l=>l.records[0].provider='local_upload',l=>l.items[0].record.source_id='7699999999999999999',l=>l.items[0].media.sha256='c'.repeat(64),l=>l.items.push(l.items[0])]){
  const lib=library();mutate(lib);const builder=createStudyPacketBuilder({prepareMedia:()=>assert.fail('must not prepare'),readReferences:()=>assert.fail('must not read references')});
  await assert.rejects(builder.preparePacket(lib,ctx));
 }
 const builder=createStudyPacketBuilder({prepareMedia:()=>assert.fail('must not prepare')});
 await assert.rejects(builder.preparePacket(library(),{...ctx,learning_source:'local'}),{code:'STUDY_PACKET_LIBRARY_INVALID'});
 assert.deepEqual(Object.keys(builder),['preparePacket']);
});
test('wrong prepared media, audio identity and timed segments cannot be relabelled with current video ID',async()=>{
 for(const mutate of [p=>p.source_sha256='f'.repeat(64),p=>p.has_audio='true',p=>p.transcript.source_id='media_'+'e'.repeat(64),p=>p.transcript.audio_sha256='bad',p=>p.transcript.segments[0].start=-1,p=>p.transcript.segments[0].end=20,p=>p.transcript.segments[0].text=42,p=>p.frames[1].time=20]){
  const b=createStudyPacketBuilder({prepareMedia:async item=>{const p=media(item);mutate(p);return p;}});
  await assert.rejects(b.preparePacket(library(),ctx));
 }
});
test('attachment/reference limits reject without truncation or preparing media; reference videos and wrong games are forbidden',async()=>{
 for(const reference of [
  refs(5),
  {...refs(),files:Array.from({length:33},(_,i)=>({path:'/controlled/f'+i,sha256:sha('f'+i)}))},
  {...refs(),sources:[{...refs().sources[0],kind:'raw-asr'}]},
  {...refs(),sources:[{...refs().sources[0],kind:'video-frame'}]},
  {...refs(1),sources:refs(1).sources.map(s=>s.kind==='image-page'?{...s,game:'other'}:s)},
  {...refs(),images:[{path:'/controlled/unmapped.png',sha256:sha('unmapped')}]}
 ]){
  const b=createStudyPacketBuilder({prepareMedia:()=>assert.fail('must reject before media'),readReferences:async()=>reference});
  await assert.rejects(b.preparePacket(library(8),ctx));
 }
});
test('unavailable originals are not fetched; reference-only packet is partial and no-source packet fails explicitly',async()=>{
 let calls=0;const lib=library(1,[0]),b=createStudyPacketBuilder({prepareMedia:()=>{calls++;assert.fail('no original');}});
 await assert.rejects(b.preparePacket(lib,ctx),{code:'STUDY_PACKET_NO_SOURCES'});assert.equal(calls,0);
 const withRefs=createStudyPacketBuilder({prepareMedia:()=>assert.fail('no original'),readReferences:async()=>refs()});
 const out=await withRefs.preparePacket(lib,ctx);assert.equal(out.packet.representative_samples.length,0);assert.equal(out.packet.library.records[0].availability,'unavailable');
});
test('cancelled signals stop before providers and between media; caller changes after await cannot switch game/source',async()=>{
 const pre=new AbortController();pre.abort();
 const untouched=createStudyPacketBuilder({prepareMedia:()=>assert.fail('cancelled'),readReferences:()=>assert.fail('cancelled')});await assert.rejects(untouched.preparePacket(library(),{...ctx,signal:pre.signal}));
 const c=new AbortController(),mutable={...ctx,signal:c.signal};let count=0;
 const b=createStudyPacketBuilder({prepareMedia:async(item,options)=>{count++;assert.equal(options.signal,c.signal);c.abort();return media(item);}});
 await assert.rejects(b.preparePacket(library(3),mutable));assert.equal(count,1);
 const q={...ctx},lib=library(),saved=structuredClone(lib);
 const changing=createStudyPacketBuilder({readReferences:async()=>{q.game='other';q.learning_source='local';lib.records[0].title='outside change';return refs();},prepareMedia:async item=>media(item)});
 const out=await changing.preparePacket(lib,q);assert.equal(out.packet.game,game);assert.equal(out.packet.learning_source,'network');assert.deepEqual(out.packet.library.records,saved.records);
});
test('oversize complete source text fails the Host input bound and is never trimmed',async()=>{
 const reference=refs(),body='原文'.repeat(180000);reference.sources[0].content=body;reference.sources[0].content_sha256=sha(body);
 const b=createStudyPacketBuilder({prepareMedia:async item=>media(item),readReferences:async()=>reference});
 await assert.rejects(b.preparePacket(library(),ctx),{code:'STUDY_PACKET_INPUT_LIMIT'});assert.equal(reference.sources[0].content,body);
});

function localLibrary(n=2){
 const lib=library(n);lib.binding.collection=null;
 for(const item of lib.items){Object.assign(item.record,{provider:'local_upload',source_id:'local_'+item.media.sha256,source_url:null,author:null,collection_request_id:null,collected_at:null,uploaded_at:at,published_date:null,publication_date:null,publication_precision:null});item.origins=[structuredClone(item.record)];}
 lib.records=lib.items.map(i=>({...i.record,library_id:i.library_id,origins:i.origins,sha256:i.media.sha256,availability:i.availability,unavailable_reason:i.unavailable_reason}));return lib;
}
test('local packet preserves actual frame/full ASR identity and unknown publication data without manufacturing a network window',async()=>{
 const lib=localLibrary(),before=structuredClone(lib),local={game,learning_source:'local'},seen=[];
 const builder=createStudyPacketBuilder({prepareMedia:async item=>{seen.push(item.record.source_id);return media(item);},readReferences:async input=>{assert.equal(input.learning_source,'local');assert.equal(input.library_binding.collection,null);return refs();}});
 const out=await builder.preparePacket(lib,local);assert.equal(out.packet.learning_source,'local');assert.equal(out.packet.library.binding.collection,null);assert.deepEqual(lib,before);assert.equal(seen.length,2);
 const raw=out.packet.sources.filter(s=>s.kind==='raw-asr');assert.equal(raw.length,2);assert(raw.every(s=>s.source_id.startsWith('local_')&&s.coverage.collection_request_id===null&&s.coverage.terms_verified===false));assert(raw.every(s=>s.content.includes(' 未核原字，不能纠词 ')));
 assert(out.packet.sources.filter(s=>s.kind==='video-frame').every(s=>s.coverage.builder==='study-packet-local-1'));
 const metrics=calculateComparisonMetrics(prepareGameStudy(out.packet,out));assert.equal(metrics.window,null);assert.deepEqual(metrics.groups,[]);assert.equal(metrics.excluded.length,2);
});
test('local mismatched SHA/source, injected network metadata and wrong game reject before media or reference reads',async()=>{
 for(const mutate of [l=>l.binding.collection=library().binding.collection,l=>l.records[0].published_date='2026-10-15',l=>l.records[0].like_count=42,l=>l.items[0].origins[0].game='other',l=>l.items[0].media.sha256='f'.repeat(64),l=>l.records[0].source_id='7695600881273670946']){
  const lib=localLibrary();mutate(lib);let calls=0;const builder=createStudyPacketBuilder({prepareMedia:()=>{calls++;assert.fail('invalid input');},readReferences:()=>{calls++;assert.fail('invalid input');}});
  await assert.rejects(builder.preparePacket(lib,{game,learning_source:'local'}));assert.equal(calls,0);
 }
});

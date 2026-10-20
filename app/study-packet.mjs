// Network-only evidence assembly from already readable server-owned originals.
// Acquisition, source authenticity and file-byte verification belong to the
// trusted library/media/reference providers; this builder never fetches media.
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {prepareGameStudy,calculateComparisonMetrics,GAME_STUDY_VERSION,GAME_STUDY_PROMPT,GAME_STUDY_TRUST,gameStudySchema} from './game-study.mjs';
import {HOST_LIMITS} from './host-assistant.mjs';
import {selectStudyRepresentatives} from './study-selection.mjs';
export const STUDY_PACKET_VERSION='study-packet-network-2';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const SHA=/^[a-f0-9]{64}$/,ID=/^\d{10,25}$/;
const referenceKinds=new Set(['publisher','game-guide','platform-guide','competitor-content','image-page']);
const fail=code=>{throw Object.assign(Error(code),{code});};
const stop=signal=>signal?.throwIfAborted();
const fileKey=f=>JSON.stringify([f?.path,f?.sha256]);
const validFile=f=>f&&typeof f.path==='string'&&isAbsolute(f.path)&&SHA.test(f.sha256||'');
function snapshot(library,ctx){
 if(ctx?.learning_source!=='network'||typeof ctx.game!=='string'||!ctx.game.trim()||library?.game!==ctx.game)fail('STUDY_PACKET_SOURCE_INVALID');
 const b=library.binding,c=b?.collection;
 if(b?.game!==ctx.game||b.source_provider!=='game_study_library'||!SHA.test(b.library_fingerprint||'')||b.library_id!=='library_'+b.library_fingerprint||c?.source_provider!=='redfox'||!c.collection_request_id||!SHA.test(c.collection_fingerprint||'')||!c.window)fail('STUDY_PACKET_LIBRARY_INVALID');
 if(!Array.isArray(library.records)||!Array.isArray(library.items)||!library.records.length||library.records.length>30||library.items.length!==library.records.length)fail('STUDY_PACKET_LIBRARY_INVALID');
 const items=new Map();
 for(const item of library.items){const id=item?.record?.source_id;if(!ID.test(id||'')||items.has(id))fail('STUDY_PACKET_ITEM_INVALID');items.set(id,item);}
 const seen=new Set();
 for(const row of library.records){
  if(!row||!ID.test(row.source_id||'')||seen.has(row.source_id)||row.game!==ctx.game||row.provider!=='redfox'||row.kind!=='video'||row.collection_request_id!==c.collection_request_id)fail('STUDY_PACKET_RECORD_INVALID');
  seen.add(row.source_id);const item=items.get(row.source_id);
  if(!item||!Array.isArray(row.origins)||!row.origins.length||sha(item.record)!==sha(row.origins[0])||sha(item.origins)!==sha(row.origins)||item.library_id!==row.library_id||item.availability!==row.availability)fail('STUDY_PACKET_ITEM_INVALID');
  for(const origin of row.origins)if(origin.game!==ctx.game||origin.provider!=='redfox'||origin.kind!=='video'||origin.collection_request_id!==c.collection_request_id)fail('STUDY_PACKET_RECORD_INVALID');
  if(row.availability==='available'){
   if(!validFile(item.media)||item.media.sha256!==row.sha256||!Number.isSafeInteger(item.media.size)||item.media.size<1)fail('STUDY_PACKET_MEDIA_INVALID');
  }else if(row.availability!=='unavailable'||item.media!==null||row.sha256!==null)fail('STUDY_PACKET_MEDIA_INVALID');
 }
 return items;
}
function mediaSources(prepared,item,game,read_at){
 if(!prepared||prepared.source_sha256!==item.media.sha256||!Number.isFinite(prepared.duration)||prepared.duration<=0||typeof prepared.has_audio!=='boolean'||!Array.isArray(prepared.frames)||!prepared.frames.length)fail('STUDY_PACKET_MEDIA_INVALID');
 for(const [i,f]of prepared.frames.entries())if(!validFile(f)||!Number.isFinite(f.time)||f.time<0||f.time>prepared.duration||i>0&&f.time<prepared.frames[i-1].time)fail('STUDY_PACKET_FRAME_INVALID');
 const source_id=item.record.source_id,frame=prepared.frames[Math.floor(prepared.frames.length/2)];
 const common={game,source_id,read_at},coverage={builder:STUDY_PACKET_VERSION,source_sha256:prepared.source_sha256,read_at_basis:'packet_preparation_time_not_publication',collection_request_id:item.record.collection_request_id};
 const transcript=prepared.transcript;
 if(prepared.has_audio){
  if(!transcript||transcript.source_id!=='media_'+prepared.source_sha256||!SHA.test(transcript.audio_sha256||'')||!['machine_transcript_pending_review','no_speech_recognized'].includes(transcript.status)||!Array.isArray(transcript.segments))fail('STUDY_PACKET_TRANSCRIPT_INVALID');
  for(const s of transcript.segments)if(!s||typeof s.text!=='string'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>prepared.duration+1)fail('STUDY_PACKET_TRANSCRIPT_INVALID');
 }else if(transcript!==null)fail('STUDY_PACKET_TRANSCRIPT_INVALID');
 const recognized=prepared.has_audio&&transcript.segments.some(s=>s.text.trim());
 const sources=[{...common,id:'study-frame:'+source_id,kind:'video-frame',file:{path:frame.path,sha256:frame.sha256},coverage:{...coverage,kind:'single_sparse_actual_frame',time:frame.time,selection:'middle_index_of_prepared_frames',prepared_frame_count:prepared.frames.length,full_motion_review:false,timestamp_method:'requested_seek_time_not_independent_pts_verification',audio_state:!prepared.has_audio?'no_audio_stream':recognized?'automatic_transcript_unreviewed':'no_recognized_speech'}}];
 if(recognized){
  const content=transcript.segments.map(s=>`[${s.start}-${s.end}] ${s.text}`).join('\n');
  sources.push({...common,id:'study-asr:'+source_id,kind:'raw-asr',content,content_sha256:sha(content),coverage:{...coverage,kind:'full_machine_asr',audio_sha256:transcript.audio_sha256,time:0,end:prepared.duration,raw_segments:structuredClone(transcript.segments),human_audio_review:false,subtitle_verified:false,terms_verified:false}});
 }
 return sources;
}
export function createStudyPacketBuilder({prepareMedia,readReferences=async()=>({sources:[],images:[],files:[]}),representativeLimit=8}={}){
 if(typeof prepareMedia!=='function'||typeof readReferences!=='function'||!Number.isInteger(representativeLimit)||representativeLimit<1||representativeLimit>8)fail('STUDY_PACKET_CONFIG_INVALID');
 async function preparePacket(library,ctx){
  stop(ctx?.signal);const captured={game:ctx?.game,learning_source:ctx?.learning_source,signal:ctx?.signal,stage:ctx?.stage};
  // Each provider gets a separate copy so it cannot change the captured snapshot.
  const fixed=structuredClone(library),items=snapshot(fixed,captured);
  const selection=selectStudyRepresentatives(fixed.records,{limit:representativeLimit});
  const byId=new Map(fixed.records.map(r=>[r.source_id,r]));
  const selected=selection.source_ids.map(id=>byId.get(id));
  const refs=structuredClone(await readReferences({game:captured.game,learning_source:'network',library_binding:structuredClone(fixed.binding),signal:captured.signal}));
  stop(captured.signal);
  if(!refs||!Array.isArray(refs.sources)||!Array.isArray(refs.images)||!Array.isArray(refs.files)||refs.sources.some(s=>!s||!referenceKinds.has(s.kind)))fail('STUDY_PACKET_REFERENCE_INVALID');
  if(refs.images.length+selected.length>12||refs.files.length>32)fail('STUDY_PACKET_ATTACHMENT_LIMIT');
  if([...refs.images,...refs.files].some(f=>!validFile(f)))fail('STUDY_PACKET_REFERENCE_INVALID');
  const imageKeys=new Set(refs.images.map(fileKey)),fileKeys=new Set(refs.files.map(fileKey));
  if(imageKeys.size!==refs.images.length||fileKeys.size!==refs.files.length)fail('STUDY_PACKET_REFERENCE_INVALID');
  for(const s of refs.sources){
   if(['game-guide','image-page'].includes(s.kind)&&s.game!==captured.game||s.kind==='platform-guide'&&s.game!=null&&s.game!==captured.game||s.kind==='competitor-content'&&(!s.game||s.game===captured.game))fail('STUDY_PACKET_REFERENCE_GAME');
   if(s.file&&!(imageKeys.has(fileKey(s.file))||fileKeys.has(fileKey(s.file))))fail('STUDY_PACKET_REFERENCE_INVALID');
  }
  for(const f of [...refs.images,...refs.files])if(!refs.sources.some(s=>s.file&&fileKey(s.file)===fileKey(f)))fail('STUDY_PACKET_UNMAPPED_ATTACHMENT');
  const sources=[...refs.sources],images=[...refs.images],representative_samples=[];
  for(const row of selected){
   stop(captured.signal);const item=items.get(row.source_id);
   const prepared=await prepareMedia(structuredClone(item),{signal:captured.signal,stage:captured.stage});stop(captured.signal);
   const observed=mediaSources(prepared,item,captured.game,new Date().toISOString());
   for(const source of observed)source.coverage.representative_selection={version:selection.version,boundary:selection.boundary};
   sources.push(...observed);images.push(observed[0].file);representative_samples.push({source_id:row.source_id,evidence_ids:observed.map(s=>s.id)});
  }
  if(!sources.length)fail('STUDY_PACKET_NO_SOURCES');
  const packet={game:captured.game,learning_source:'network',library:{binding:fixed.binding,records:fixed.records},sources,representative_samples};
  stop(captured.signal);const checked=prepareGameStudy(packet,{images,files:refs.files});
  const input={version:GAME_STUDY_VERSION,packet:checked.packet,comparisonMetrics:calculateComparisonMetrics(checked),evidence_boundary:GAME_STUDY_TRUST};
  // Reserve more than the current Host wrapper overhead; never trim evidence.
  const inputBytes=Buffer.byteLength(JSON.stringify(input))+Buffer.byteLength(JSON.stringify(gameStudySchema(captured.game)))+Buffer.byteLength(GAME_STUDY_PROMPT)+1024;
  if(inputBytes>HOST_LIMITS.input)fail('STUDY_PACKET_INPUT_LIMIT');
  return {packet,images,files:refs.files};
 }
 return {preparePacket};
}

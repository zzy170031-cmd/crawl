// Server-side assembly of existing media only. No acquisition, inference or delivery.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {normalizeLocalGame,LOCAL_VIDEO_MAX_BYTES} from './local-videos.mjs';
export const GAME_STUDY_LIBRARY_VERSION='game-study-library-1';
const SHA=/^[a-f0-9]{64}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code,cause){throw Object.assign(new Error(code,{cause}),{code});}
function abort(signal){signal?.throwIfAborted();}
const sameGame=(value,game)=>typeof value==='string'&&normalizeLocalGame(value)===game;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function publicOrigin(row,game,local){
 return {provider:local?'local_upload':'redfox',source_id:row.source_id,game,kind:'video',title:typeof row.title==='string'?row.title:'',
  source_url:local?null:row.source_url,author:local?null:row.author??null,
  collection_request_id:local?null:row.collection_request_id,collected_at:local?null:row.collected_at??null,
  uploaded_at:local?row.uploaded_at:null,published_at:local?null:row.published_at??null,
  published_date:local?null:row.published_date??null,publication_date:local?null:row.published_date??null,
  publication_precision:local?null:row.publication_precision??null,duration_ms:row.duration_ms??null,
  like_count:local?null:row.like_count??null,comment_count:local?null:row.comment_count??null,
  share_count:local?null:row.share_count??null,collect_count:local?null:row.collect_count??null,
  learning_status:'not_started'};
}
async function verifiedMedia(path,expected,size,contentType,signal){
 if(typeof path!=='string'||!SHA.test(expected)||!Number.isSafeInteger(size)||size<1||size>LOCAL_VIDEO_MAX_BYTES)fail('LIBRARY_MEDIA_INVALID');
 const canonical=resolve(path);let file;
 try{
  abort(signal);
  const named=await lstat(canonical);
  if(!named.isFile()||named.isSymbolicLink()||await realpath(canonical)!==canonical)fail('LIBRARY_MEDIA_UNSAFE');
  file=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  const before=await file.stat();
  if(before.ino!==named.ino||before.dev!==named.dev||before.size!==size)fail('LIBRARY_MEDIA_CHANGED');
  const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let bytes=0;
  while(true){abort(signal);const result=await file.read(buffer,0,buffer.length,null);if(!result.bytesRead)break;bytes+=result.bytesRead;if(bytes>size)fail('LIBRARY_MEDIA_CHANGED');digest.update(buffer.subarray(0,result.bytesRead));}
  abort(signal);const after=await file.stat(),current=await lstat(canonical);
  if(bytes!==size||digest.digest('hex')!==expected||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||current.ino!==after.ino||current.dev!==after.dev||current.isSymbolicLink()||await realpath(canonical)!==canonical)fail('LIBRARY_MEDIA_CHANGED');
  return {path:canonical,sha256:expected,size,contentType:typeof contentType==='string'?contentType:null};
 }catch(error){abort(signal);if(error.code?.startsWith('LIBRARY_'))throw error;fail('LIBRARY_MEDIA_UNREADABLE',error);}finally{await file?.close();}
}
function collectionInfo(collection,game){
 if(!collection)return null;
 const b=collection.binding,p=collection.provenance;
 if(!b||b.source_provider!=='redfox'||!SHA.test(b.collection_fingerprint)||typeof b.collection_request_id!=='string'||!b.collection_request_id||p?.provider!=='redfox'||p.request_id!==b.collection_request_id||!sameGame(p.game,game)||!Array.isArray(collection.records)||!iso(p.collected_at)||!/^\d{4}-\d{2}-\d{2}$/.test(p.start_date)||!/^\d{4}-\d{2}-\d{2}$/.test(p.end_date)||p.start_date>p.end_date)fail('LIBRARY_COLLECTION_INVALID');
 return {source_provider:'redfox',collection_request_id:b.collection_request_id,collection_fingerprint:b.collection_fingerprint,collected_at:p.collected_at,window:{start_date:p.start_date,end_date:p.end_date,update_policy:p.update_policy??null}};
}
export async function buildGameStudyLibrary({game,collection=null,uploads=[],readOnline,openLocal,signal,limit=30}={}){
 game=normalizeLocalGame(game);abort(signal);
 if(!Number.isInteger(limit)||limit<1||limit>30||!Array.isArray(uploads))fail('LIBRARY_INPUT_INVALID');
 collection=collection?structuredClone(collection):null;uploads=structuredClone(uploads);
 const online=collectionInfo(collection,game),rows=collection?.records??[],seen=new Set();
 // Validate every source before any file access. Sources are trusted server results,
 // not HTTP candidate payloads; this checks consistency, not publisher authenticity.
 for(const [local,sourceRows] of [[true,uploads],[false,rows]])for(const row of sourceRows){
  if(!row||row.kind!=='video'||!sameGame(row.game,game)||row.provider!==(local?'local_upload':'redfox'))fail('LIBRARY_SOURCE_INVALID');
  const key=row.provider+':'+row.source_id;if(seen.has(key))fail('LIBRARY_SOURCE_DUPLICATE');seen.add(key);
  if(local){if(!/^local_[a-f0-9]{64}$/.test(row.source_id)||row.sha256!==row.source_id.slice(6)||!iso(row.uploaded_at))fail('LIBRARY_SOURCE_INVALID');}
  else if(!/^\d{10,25}$/.test(row.source_id)||row.source_url!==`https://www.douyin.com/video/${row.source_id}`||row.collection_request_id!==online.collection_request_id)fail('LIBRARY_SOURCE_INVALID');
 }
 if(uploads.length&&typeof openLocal!=='function'||rows.length&&typeof readOnline!=='function')fail('LIBRARY_READER_REQUIRED');
 const candidates=[];
 for(const [local,sourceRows] of [[true,uploads],[false,rows]])for(const row of sourceRows){
  abort(signal);let media=null,reason=null;
  if(local){const found=await openLocal(row.source_id);abort(signal);if(found?.source_id!==row.source_id||found.sha256!==row.sha256||found.size!==row.size)fail('LIBRARY_MEDIA_IDENTITY_INVALID');media=await verifiedMedia(found.path,found.sha256,found.size,found.contentType,signal);}
  else{
   let found;
   try{found=await readOnline(row);}catch(error){abort(signal);if(error?.code==='ENOENT'||error?.code==='MEDIA_ASSET_REQUIRED'&&error.message.startsWith('这条视频尚未取得'))reason='original_not_available';else fail('LIBRARY_ONLINE_READ_FAILED',error);}
   abort(signal);
   if(!reason){if(!found)reason='original_not_available';else{
    if(found.provider!=='redfox'||found.source_id!==row.source_id||found.url!==row.source_url||found.current_collection_request_id!==row.collection_request_id||found.status!=='av_readable')fail('LIBRARY_MEDIA_IDENTITY_INVALID');
    media=await verifiedMedia(found.source_path,found.source_sha256,found.bytes,'video/mp4',signal);
   }}
  }
  candidates.push({origin:publicOrigin(row,game,local),media,reason});
 }
 const grouped=new Map();
 for(const item of candidates){const key=item.media?'sha256:'+item.media.sha256:'unavailable:'+item.origin.provider+':'+item.origin.source_id;
  const previous=grouped.get(key);if(previous){previous.origins.push(item.origin);continue;}
  grouped.set(key,{library_id:item.media?'media_'+item.media.sha256:'unavailable_'+hash(item.origin),record:item.origin,origins:[item.origin],media:item.media,availability:item.media?'available':'unavailable',unavailable_reason:item.reason});
 }
 const unique=[...grouped.values()],items=unique.slice(0,limit),excluded=unique.slice(limit).map(item=>({library_id:item.library_id,reason:'selection_limit',origins:item.origins,sha256:item.media?.sha256??null}));
 const records=items.map(({library_id,record,origins,media,availability,unavailable_reason})=>({...record,library_id,origins,sha256:media?.sha256??null,availability,unavailable_reason}));
 const fingerprint=hash({version:GAME_STUDY_LIBRARY_VERSION,game,collection:online,limit,sources:unique.map(item=>({id:item.library_id,origins:item.origins,availability:item.availability,media:item.media?{sha256:item.media.sha256,size:item.media.size,contentType:item.media.contentType}:null}))});
 abort(signal);
 return {version:GAME_STUDY_LIBRARY_VERSION,game,status:'partial',accepted:false,items,records,excluded,
  binding:{source_provider:'game_study_library',library_id:'library_'+fingerprint,library_fingerprint:fingerprint,game,collection:online},
  coverage:{input_origins:candidates.length,unique_candidates:unique.length,selected_candidates:items.length,available_originals:items.filter(i=>i.media).length,unavailable_originals:items.filter(i=>!i.media).length,merged_duplicate_origins:candidates.length-unique.length,excluded_candidates:excluded.length,learning_completed:false,source_boundary:'服务端来源绑定与当前文件字节已核对；不等于内容相关性、发布者身份或学习完成'}};
}

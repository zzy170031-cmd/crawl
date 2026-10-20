// Sparse local preparation of server-owned original files. No acquisition or
// semantic model calls. Whisper is optional for silent clips and always offline.
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localVideoProbeArguments,LOCAL_VIDEO_MAX_BYTES} from './local-videos.mjs';
const exec=promisify(execFile),SHA=/^[a-f0-9]{64}$/;
export const STUDY_MEDIA_VERSION='study-media-sparse-1';
const digest=x=>createHash('sha256').update(x).digest('hex');
function fail(code,cause){throw Object.assign(Error('学习素材准备未完成：'+code,{cause}),{code});}
function stop(signal){signal?.throwIfAborted();}
function inside(root,path){const r=relative(root,path);return r&&!r.startsWith('..')&&!isAbsolute(r);}
async function plain(path,root){path=resolve(path);if(!inside(root,path))fail('STUDY_MEDIA_PATH');const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||await realpath(path)!==path)fail('STUDY_MEDIA_PATH');return st;}
async function fileHash(path,{signal,root,cap=LOCAL_VIDEO_MAX_BYTES}={}){
 const named=await plain(path,root);if(named.size<1||named.size>cap)fail('STUDY_MEDIA_SIZE');
 const f=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const before=await f.stat();if(before.ino!==named.ino||before.dev!==named.dev)fail('STUDY_MEDIA_CHANGED');
  const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let bytes=0;
  while(true){stop(signal);const r=await f.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;bytes+=r.bytesRead;if(bytes>cap)fail('STUDY_MEDIA_SIZE');hash.update(buffer.subarray(0,r.bytesRead));}
  stop(signal);const after=await f.stat(),current=await plain(path,root);
  if(bytes!==named.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.ino!==current.ino||after.dev!==current.dev)fail('STUDY_MEDIA_CHANGED');
  return {sha256:hash.digest('hex'),size:bytes};
 }finally{await f.close();}
}
async function safeDir(path){await mkdir(path,{recursive:true,mode:0o700});const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(path)!==resolve(path))fail('STUDY_MEDIA_PATH');return resolve(path);}
export function studyFrameTimes(duration){if(!Number.isFinite(duration)||duration<1||duration>900)fail('STUDY_MEDIA_DURATION');return [...new Set([0,Number((duration/2).toFixed(2)),Number(Math.max(0,duration-.3).toFixed(2))])];}
export function studyMediaInputArguments(path,demuxer){return ['-protocol_whitelist','file','-format_whitelist',demuxer==='mov'?'mov':'matroska,webm','-f',demuxer,...(demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-i',path];}
function childEnvironment(env,staging){const allowed=['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','TMPDIR','TEMP','TMP','LANG','LC_ALL'];return {...Object.fromEntries(allowed.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]])),HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',CRAWL_DATA_DIR:staging};}
export function createStudyMedia({dataRoot,python,whisperModel,run=exec,environment=process.env}={}){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||typeof python!=='string'||!python||typeof run!=='function')fail('STUDY_MEDIA_CONFIG');
 const root=resolve(dataRoot),cacheRoot=join(root,'study-media'),inflight=new Map();
 const invoke=(name,args,{signal,env,timeout=60000}={})=>run(name,args,{signal,timeout,maxBuffer:1024*1024,windowsHide:true,shell:false,killSignal:'SIGKILL',env:env||childEnvironment(environment,root)});
 async function speechIdentity(signal){
  if(typeof whisperModel!=='string'||!whisperModel.trim())fail('STUDY_SPEECH_MODEL_MISSING');
  const folder=await realpath(resolve(whisperModel));const model=await fileHash(join(folder,'model.bin'),{signal,root:folder,cap:1024*1024*1024}),config=await fileHash(join(folder,'config.json'),{signal,root:folder,cap:1024*1024});
  const decoding_files={};
  for(const name of ['tokenizer.json','vocabulary.json','vocabulary.txt','preprocessor_config.json']){
   try{decoding_files[name]=(await fileHash(join(folder,name),{signal,root:folder,cap:32*1024*1024})).sha256;}
   catch(e){if(e.code!=='ENOENT')throw e;decoding_files[name]=null;}
  }
  return {folder,model_sha256:model.sha256,config_sha256:config.sha256,decoding_files,engine:'faster-whisper',device:'cpu',compute_type:'int8'};
 }
 async function cacheRead(folder,expected,signal){
  await safeExistingDir(folder);const metadata=await plain(join(folder,'manifest.json'),root);if(metadata.size>1024*1024)fail('STUDY_MEDIA_CACHE_CHANGED');const manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
  if(manifest.version!==STUDY_MEDIA_VERSION||manifest.source_sha256!==expected.sha256||manifest.source_size!==expected.size||!Array.isArray(manifest.frames)||manifest.frames.length!==3)fail('STUDY_MEDIA_CACHE_CHANGED');
  if(JSON.stringify(manifest.times)!==JSON.stringify(studyFrameTimes(manifest.duration)))fail('STUDY_MEDIA_CACHE_CHANGED');
  if(typeof manifest.has_audio!=='boolean'||(manifest.has_audio
   ? !manifest.speech||!SHA.test(manifest.audio_sha256)||!SHA.test(manifest.transcript_sha256)
   : manifest.speech!==null||manifest.audio_sha256!==null||manifest.transcript_sha256!==null))fail('STUDY_MEDIA_CACHE_CHANGED');
  const files=manifest.frames.map(f=>({file:f.file,sha256:f.sha256}));if(manifest.has_audio)files.push({file:'audio.webm',sha256:manifest.audio_sha256},{file:'transcript.json',sha256:manifest.transcript_sha256});
  for(const f of files){if(!/^(?:frame-[0-2]\.png|audio\.webm|transcript\.json)$/.test(f.file)||!SHA.test(f.sha256)||(await fileHash(join(folder,f.file),{signal,root})).sha256!==f.sha256)fail('STUDY_MEDIA_CACHE_CHANGED');}
  for(const [i,f]of manifest.frames.entries())if(f.file!==`frame-${i}.png`||f.time!==manifest.times[i])fail('STUDY_MEDIA_CACHE_CHANGED');
  if(manifest.has_audio){const current=await speechIdentity(signal);if(JSON.stringify(current)!==JSON.stringify(manifest.speech))fail('STUDY_MEDIA_CACHE_CHANGED');}
  const transcript=manifest.has_audio?JSON.parse(await readFile(join(folder,'transcript.json'),'utf8')):null;
  if(transcript&&(transcript.source_id!=='media_'+expected.sha256||transcript.audio_sha256!==manifest.audio_sha256||!Array.isArray(transcript.segments)))fail('STUDY_MEDIA_CACHE_CHANGED');
  return {version:STUDY_MEDIA_VERSION,source_sha256:expected.sha256,duration:manifest.duration,has_audio:manifest.has_audio,frames:manifest.frames.map(f=>({...f,path:join(folder,f.file)})),transcript,transcript_path:transcript?join(folder,'transcript.json'):null,manifest_path:join(folder,'manifest.json'),scope:'Three sparse frames and optional full automatic speech transcript; not whole-video viewing, subtitle correction or semantic learning.'};
 }
 async function safeExistingDir(folder){const st=await lstat(folder);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(folder)!==folder)fail('STUDY_MEDIA_PATH');}
 async function prepare(item,{signal,stage=()=>{}}={}){
  stop(signal);const media=item?.media;if(!media||typeof media.path!=='string'||!SHA.test(media.sha256)||!Number.isSafeInteger(media.size))fail('STUDY_MEDIA_INPUT');
  await safeDir(root);await safeDir(cacheRoot);
  const current=await fileHash(media.path,{signal,root});if(current.sha256!==media.sha256||current.size!==media.size)fail('STUDY_MEDIA_CHANGED');
  const folder=join(cacheRoot,media.sha256);let present=false;
  try{await lstat(folder);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(present){try{const cached=await cacheRead(folder,media,signal),after=await fileHash(media.path,{signal,root});if(after.sha256!==media.sha256||after.size!==media.size)fail('STUDY_MEDIA_CHANGED');return {...cached,reused:true};}catch(e){stop(signal);if(e.code==='ENOENT')fail('STUDY_MEDIA_CACHE_CHANGED',e);throw e;}}
  if(inflight.has(media.sha256))fail('STUDY_MEDIA_BUSY');inflight.set(media.sha256,true);
  let staging;
  try{
   const incoming=await safeDir(join(cacheRoot,'incoming'));staging=await safeDir(join(incoming,randomUUID()));
   const processingId='media_'+media.sha256,temp=await safeDir(join(staging,'media',processingId));
   const file=await open(media.path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let header;try{header=Buffer.alloc(16);await file.read(header,0,16,0);}finally{await file.close();}
   const demuxer=header.toString('ascii',4,8)==='ftyp'?'mov':header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))?'matroska':null;if(!demuxer)fail('STUDY_MEDIA_FORMAT');
   stage('读取实际视频并提取3张代表画面');
   const probe=JSON.parse((await invoke('ffprobe',localVideoProbeArguments(media.path,demuxer),{signal})).stdout),duration=Number(probe.format?.duration),times=studyFrameTimes(duration);
   const video=probe.streams?.find(s=>s.codec_type==='video'&&s.disposition?.attached_pic!==1&&Number.isSafeInteger(s.index)&&s.index>=0);if(!video)fail('STUDY_MEDIA_NO_VIDEO');
   const has_audio=probe.streams.some(s=>s.codec_type==='audio'),frames=[];
   for(const [i,time]of times.entries()){
    stop(signal);const name=`frame-${i}.png`;await invoke('ffmpeg',['-nostdin','-v','error','-n','-ss',String(time),...studyMediaInputArguments(media.path,demuxer),'-map',`0:${video.index}`,'-frames:v','1','-vf','scale=1280:1280:force_original_aspect_ratio=decrease',join(temp,name)],{signal});
    const bytes=await readFile(join(temp,name));if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('STUDY_MEDIA_FRAME_INVALID');frames.push({file:name,time,sha256:digest(bytes)});
   }
   const manifest={version:STUDY_MEDIA_VERSION,processing_id:processingId,source_sha256:media.sha256,source_size:media.size,duration,times,frames,has_audio,video_stream_index:video.index,created_at:new Date().toISOString(),speech:null,audio_sha256:null,transcript_sha256:null,scope:'Sparse preparation only; first audio stream when present; timestamps are requested seek positions, not independent PTS verification.'};
   if(has_audio){
    const speech=await speechIdentity(signal);stage('使用已有本地Small模型转写语音（CPU/INT8）');
    await invoke('ffmpeg',['-nostdin','-v','error','-n',...studyMediaInputArguments(media.path,demuxer),'-map','0:a:0','-vn','-c:a','libopus','-ac','1','-ar','48000',join(temp,'audio.webm')],{signal,timeout:300000});
    const coverage={source_id:processingId,source_sha256:media.sha256,duration,start:0,end:duration,method:'full-source-audio-extraction'};
    await writeFile(join(temp,'audio.json'),JSON.stringify(coverage),{flag:'wx',mode:0o600});
    await invoke(python,[fileURLToPath(new URL('./transcribe-media.py',import.meta.url)),processingId,'--model',speech.folder],{signal,timeout:900000,env:childEnvironment(environment,staging)});
    const transcript=JSON.parse(await readFile(join(temp,'transcript.json'),'utf8')),audio_sha256=(await fileHash(join(temp,'audio.webm'),{signal,root})).sha256;
    if(transcript.source_id!==processingId||transcript.audio_sha256!==audio_sha256||!['machine_transcript_pending_review','no_speech_recognized'].includes(transcript.status)||!Array.isArray(transcript.segments)||transcript.segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>duration+1||typeof s.text!=='string'))fail('STUDY_MEDIA_TRANSCRIPT_INVALID');
    Object.assign(manifest,{speech,audio_sha256,transcript_sha256:digest(await readFile(join(temp,'transcript.json')))});
   }
   stop(signal);const after=await fileHash(media.path,{signal,root});if(after.sha256!==media.sha256||after.size!==media.size)fail('STUDY_MEDIA_CHANGED');
   await writeFile(join(temp,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});stop(signal);
   try{await rename(temp,folder);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;await cacheRead(folder,media,signal);}
   stop(signal);return {...await cacheRead(folder,media,signal),reused:false};
  }catch(e){stop(signal);if(e.code?.startsWith('STUDY_'))throw e;fail('STUDY_MEDIA_PREPARE_FAILED',e);}
  finally{inflight.delete(media.sha256);if(staging)await rm(staging,{recursive:true,force:true});}
 }
 return {prepare};
}

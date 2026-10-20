// Focused extra frames for an already selected original. No acquisition/model.
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {createStudyMedia,studyMediaInputArguments} from './study-media.mjs';
import {LOCAL_VIDEO_MAX_BYTES} from './local-videos.mjs';
const exec=promisify(execFile),SHA=/^[a-f0-9]{64}$/;
export const CREATIVE_SUPPLEMENT_VERSION='creative-supplement-1';
const digest=x=>createHash('sha256').update(x).digest('hex');
const fail=(code,cause)=>{throw Object.assign(Error('创作补读未完成：'+code,{cause}),{code});};
export function creativeSupplementTimes(duration){
 if(!Number.isFinite(duration)||duration<1||duration>900)fail('CREATIVE_MEDIA_DURATION');
 return [1,2,3,5,6,7].map(n=>Number((duration*n/8).toFixed(2)));
}
async function safeDirectory(path){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(path)!==path)fail('CREATIVE_MEDIA_PATH');return path;}
async function fileHash(root,path,{signal,maxBytes=LOCAL_VIDEO_MAX_BYTES}={}){
 signal?.throwIfAborted();if(typeof path!=='string'||!isAbsolute(path))fail('CREATIVE_MEDIA_PATH');
 const normalized=resolve(path),part=relative(root,normalized);if(!part||part==='..'||part.startsWith('../')||part.startsWith('..\\')||isAbsolute(part))fail('CREATIVE_MEDIA_PATH');
 const named=await lstat(normalized);if(!named.isFile()||named.isSymbolicLink()||await realpath(normalized)!==normalized)fail('CREATIVE_MEDIA_PATH');
 if(named.size<1||named.size>maxBytes)fail('CREATIVE_MEDIA_SIZE');
 const fd=await open(normalized,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const before=await fd.stat();if(before.ino!==named.ino||before.dev!==named.dev)fail('CREATIVE_MEDIA_CHANGED');
  const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let size=0;
  for(;;){signal?.throwIfAborted();const r=await fd.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;size+=r.bytesRead;if(size>maxBytes)fail('CREATIVE_MEDIA_SIZE');hash.update(buffer.subarray(0,r.bytesRead));}
  const after=await fd.stat(),current=await lstat(normalized);if(size!==named.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||current.ino!==before.ino||current.dev!==before.dev||current.isSymbolicLink()||await realpath(normalized)!==normalized)fail('CREATIVE_MEDIA_CHANGED');
  signal?.throwIfAborted();return {sha256:hash.digest('hex'),size};
 }finally{await fd.close();}
}
function validPNG(bytes){return bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND';}
function environment(env){const keys=['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','TMPDIR','TEMP','TMP','LANG','LC_ALL'];return Object.fromEntries(keys.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));}
export function createCreativeMedia(options={}){
 const {dataRoot,run=exec,environment:env=process.env}=options;
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||typeof run!=='function')fail('CREATIVE_MEDIA_CONFIG');
 const root=resolve(dataRoot),cacheRoot=join(root,'creative-media'),base=createStudyMedia(options),inflight=new Set();
 const checkSource=async(media,signal)=>{const actual=await fileHash(root,media.path,{signal});if(actual.sha256!==media.sha256||actual.size!==media.size)fail('CREATIVE_MEDIA_CHANGED');};
 async function cached(folder,media,p,signal){
  const d=await lstat(folder);if(!d.isDirectory()||d.isSymbolicLink()||await realpath(folder)!==folder)fail('CREATIVE_MEDIA_PATH');
  const path=join(folder,'manifest.json'),stamp=await fileHash(root,path,{signal,maxBytes:1024*1024}),raw=await readFile(path);if(digest(raw)!==stamp.sha256)fail('CREATIVE_MEDIA_CACHE_CHANGED');
  let m;try{m=JSON.parse(raw);}catch(e){fail('CREATIVE_MEDIA_CACHE_CHANGED',e);}
  const times=creativeSupplementTimes(p.duration);
  if(m?.version!==CREATIVE_SUPPLEMENT_VERSION||m.source_sha256!==media.sha256||m.source_size!==media.size||m.duration!==p.duration||m.timestamp_method!=='requested_seek_not_independent_pts_verified'||JSON.stringify(m.times)!==JSON.stringify(times)||!Array.isArray(m.frames)||m.frames.length!==6)fail('CREATIVE_MEDIA_CACHE_CHANGED');
  const frames=[];
  for(const [i,f]of m.frames.entries()){
   if(!f||f.file!==`frame-${i}.png`||f.time!==times[i]||!SHA.test(f.sha256||''))fail('CREATIVE_MEDIA_CACHE_CHANGED');const framePath=join(folder,f.file),actual=await fileHash(root,framePath,{signal,maxBytes:20*1024*1024});
   if(actual.sha256!==f.sha256)fail('CREATIVE_MEDIA_CACHE_CHANGED');const bytes=await readFile(framePath);if(digest(bytes)!==actual.sha256||!validPNG(bytes))fail('CREATIVE_MEDIA_CACHE_CHANGED');frames.push({...f,path:framePath});
  }
  return {version:CREATIVE_SUPPLEMENT_VERSION,manifest_path:path,frames};
 }
 async function prepare(item,ctx={}){
  const {signal}=ctx;signal?.throwIfAborted();
  // Base validates/probes the original and preserves its full automatic ASR.
  const p=await base.prepare(item,ctx);signal?.throwIfAborted();
  const media=item?.media;if(!media||!SHA.test(media.sha256||'')||p.source_sha256!==media.sha256)fail('CREATIVE_MEDIA_INPUT');
  await safeDirectory(root);await safeDirectory(cacheRoot);await checkSource(media,signal);
  const folder=join(cacheRoot,media.sha256);let present=false;
  try{await lstat(folder);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(present){try{const supplemental=await cached(folder,media,p,signal);await checkSource(media,signal);return {...p,supplemental};}catch(e){signal?.throwIfAborted();if(e.code==='ENOENT')fail('CREATIVE_MEDIA_CACHE_CHANGED',e);throw e;}}
  if(inflight.has(media.sha256))fail('CREATIVE_MEDIA_BUSY');inflight.add(media.sha256);let staging;
  try{
   staging=await safeDirectory(join(await safeDirectory(join(cacheRoot,'incoming')),randomUUID()));
   const fd=await open(media.path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let header;try{header=Buffer.alloc(16);await fd.read(header,0,16,0);}finally{await fd.close();}
   const demuxer=header.toString('ascii',4,8)==='ftyp'?'mov':header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))?'matroska':null;if(!demuxer)fail('CREATIVE_MEDIA_FORMAT');
   const baseStamp=await fileHash(root,p.manifest_path,{signal,maxBytes:1024*1024}),baseRaw=await readFile(p.manifest_path);if(digest(baseRaw)!==baseStamp.sha256)fail('CREATIVE_MEDIA_CHANGED');
   const baseManifest=JSON.parse(baseRaw),stream=baseManifest.video_stream_index;
   if(baseManifest.source_sha256!==media.sha256||baseManifest.duration!==p.duration||!Number.isSafeInteger(stream)||stream<0)fail('CREATIVE_MEDIA_INPUT');
   const times=creativeSupplementTimes(p.duration),frames=[];
   for(const [i,time]of times.entries()){
    signal?.throwIfAborted();const name=`frame-${i}.png`,path=join(staging,name);
    await run('ffmpeg',['-nostdin','-v','error','-n','-ss',String(time),...studyMediaInputArguments(media.path,demuxer),'-map',`0:${stream}`,'-frames:v','1','-vf','scale=1280:1280:force_original_aspect_ratio=decrease',path],{signal,timeout:60000,maxBuffer:1024*1024,windowsHide:true,shell:false,killSignal:'SIGKILL',env:environment(env)});
    const actual=await fileHash(root,path,{signal,maxBytes:20*1024*1024}),bytes=await readFile(path);if(digest(bytes)!==actual.sha256||!validPNG(bytes))fail('CREATIVE_MEDIA_FRAME_INVALID');frames.push({file:name,time,sha256:actual.sha256});
   }
   await checkSource(media,signal);signal?.throwIfAborted();
   const manifest={version:CREATIVE_SUPPLEMENT_VERSION,source_sha256:media.sha256,source_size:media.size,duration:p.duration,times,frames,timestamp_method:'requested_seek_not_independent_pts_verified',created_at:new Date().toISOString()};
   await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});signal?.throwIfAborted();
   try{await rename(staging,folder);staging=null;}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;}
   const supplemental=await cached(folder,media,p,signal);await checkSource(media,signal);return {...p,supplemental};
  }catch(e){signal?.throwIfAborted();if(e.code?.startsWith('CREATIVE_MEDIA_'))throw e;fail('CREATIVE_MEDIA_PREPARE_FAILED',e);}
  finally{inflight.delete(media.sha256);if(staging)await rm(staging,{recursive:true,force:true});}
 }
 return {prepare};
}

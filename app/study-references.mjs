// Server-owned public reference pack only. No fetch or publisher authentication.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {normalizeLocalGame} from './local-videos.mjs';
import {HOST_LIMITS} from './host-assistant.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const stop=signal=>signal?.throwIfAborted();
const kinds=new Set(['publisher','game-guide','platform-guide','competitor-content','image-page']);
const empty=()=>({sources:[],images:[],files:[]});
async function directory(path){const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(path)!==path)fail('STUDY_REFERENCE_PATH_INVALID');}
async function readFile(path,limit,signal,body=false){
 const named=await lstat(path);
 if(!named.isFile()||named.isSymbolicLink()||await realpath(path)!==path)fail('STUDY_REFERENCE_PATH_INVALID');
 if(named.size<1||named.size>limit)fail('STUDY_REFERENCE_SIZE');
 const f=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const before=await f.stat();if(before.ino!==named.ino||before.dev!==named.dev)fail('STUDY_REFERENCE_CHANGED');
  const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024),parts=[];let size=0;
  while(true){stop(signal);const {bytesRead}=await f.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit)fail('STUDY_REFERENCE_SIZE');digest.update(buffer.subarray(0,bytesRead));if(body)parts.push(Buffer.from(buffer.subarray(0,bytesRead)));}
  stop(signal);const after=await f.stat(),current=await lstat(path);
  if(size!==named.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||current.isSymbolicLink()||current.ino!==after.ino||current.dev!==after.dev||await realpath(path)!==path)fail('STUDY_REFERENCE_CHANGED');
  return {sha256:digest.digest('hex'),size,...(body?{body:Buffer.concat(parts)}:{})};
 }finally{await f.close();}
}
export function createStudyReferenceReader({dataRoot}={}){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot))fail('STUDY_REFERENCE_CONFIG');
 const root=resolve(dataRoot);
 return async({game,signal}={})=>{
  stop(signal);game=normalizeLocalGame(game);await directory(root);
  const base=join(root,'study-public-references'),folder=join(base,createHash('sha256').update(game).digest('hex')),manifest=join(folder,'pack.json');
  let loaded;
  try{await directory(base);await directory(folder);loaded=await readFile(manifest,512*1024,signal,true);}
  catch(e){stop(signal);if(e.code==='ENOENT')return empty();throw e;}
  let pack;try{pack=JSON.parse(loaded.body.toString('utf8'));}catch{fail('STUDY_REFERENCE_PACK_INVALID');}
  if(!pack||Array.isArray(pack)||Object.keys(pack).sort().join(',')!=='game,sources,version'||pack.version!=='study-reference-pack-1'||pack.game!==game||!Array.isArray(pack.sources))fail('STUDY_REFERENCE_PACK_INVALID');
  const sources=structuredClone(pack.sources),images=[],files=[],seen=new Map();let imageBytes=0,fileBytes=0;
  for(const source of sources){
   stop(signal);if(!source||!kinds.has(source.kind))fail('STUDY_REFERENCE_KIND_INVALID');
   if(!source.file)continue;
   const file=source.file,name=file.name;
   if(Object.keys(file).sort().join(',')!=='name,sha256'||typeof name!=='string'||!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,119}$/u.test(name)||name.includes('..')||/[. ]$/.test(name)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)||!/^[a-f0-9]{64}$/.test(file.sha256||''))fail('STUDY_REFERENCE_PATH_INVALID');
   const image=['image-page','competitor-content'].includes(source.kind),path=join(folder,name),key=path;
   if(seen.has(key)){
    const previous=seen.get(key);if(previous.sha256!==file.sha256||previous.image!==image)fail('STUDY_REFERENCE_FILE_CONFLICT');
   }else{
    const checked=await readFile(path,image?HOST_LIMITS.image:HOST_LIMITS.source,signal);
    if(checked.sha256!==file.sha256)fail('STUDY_REFERENCE_HASH_MISMATCH');
    const target=image?images:files;target.push({path,sha256:file.sha256});seen.set(key,{sha256:file.sha256,image});
    if(image)imageBytes+=checked.size;else fileBytes+=checked.size;
    if(images.length>HOST_LIMITS.maxImages||files.length>HOST_LIMITS.maxSources||imageBytes>HOST_LIMITS.imagesTotal||fileBytes>HOST_LIMITS.sourcesTotal)fail('STUDY_REFERENCE_SIZE');
   }
   source.file={path,sha256:file.sha256};
  }
  stop(signal);return {sources,images,files};
 };
}

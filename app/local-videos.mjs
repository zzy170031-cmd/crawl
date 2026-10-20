// Local upload storage only; no source acquisition, model, or delivery calls.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {constants,createWriteStream,existsSync,lstatSync,realpathSync,mkdirSync,linkSync,unlinkSync,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {join,resolve,posix,win32,extname} from 'node:path';
const exec=promisify(execFile);
export const LOCAL_VIDEO_MAX_BYTES=1024*1024*1024;
const ID=/^local_([a-f0-9]{64})$/;
const EXTENSIONS=new Set(['.mp4','.mov','.m4v','.webm']);
const TYPES=new Set(['video/mp4','video/quicktime','video/x-m4v','video/webm','application/octet-stream']);
const known=(code,cause)=>Object.assign(Error('本地视频未保存：'+code,{cause}),{code,localVideoError:true});
const reject=code=>{throw known(code);};
function abort(signal){if(signal?.aborted)reject('LOCAL_VIDEO_CANCELLED');}
export function normalizeLocalGame(game){if(typeof game!=='string')reject('LOCAL_VIDEO_GAME_INVALID');const normalized=game.normalize('NFKC').trim();if([...normalized].length<1||[...normalized].length>40||/[\p{Cc}\p{Cf}]/u.test(normalized))reject('LOCAL_VIDEO_GAME_INVALID');return normalized;}
function displayFilename(filename){if(typeof filename!=='string'||filename.length>4096||/[\p{Cc}]/u.test(filename))reject('LOCAL_VIDEO_FILENAME_INVALID');const base=win32.basename(posix.basename(filename.normalize('NFKC'))),extension=extname(base).toLowerCase();if(!EXTENSIONS.has(extension))reject('LOCAL_VIDEO_FORMAT_UNSUPPORTED');return {extension,title:[...base.slice(0,-extension.length).trim()].slice(0,240).join('')||'本地视频'};}
function directory(path,create=true){if(!existsSync(path)){if(!create)reject('LOCAL_VIDEO_STORAGE_UNSAFE');mkdirSync(path,{recursive:true,mode:0o700});}const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(path)!==path)reject('LOCAL_VIDEO_STORAGE_UNSAFE');return path;}
function plainFile(path,size){const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||realpathSync(path)!==path||(size!==undefined&&st.size!==size))reject('LOCAL_VIDEO_STORAGE_UNSAFE');return st;}
function digestFile(path){plainFile(path);const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)),h=createHash('sha256'),b=Buffer.alloc(1024*1024);try{const named=lstatSync(path),opened=fstatSync(fd);if(named.ino!==opened.ino||named.dev!==opened.dev||named.isSymbolicLink())reject('LOCAL_VIDEO_STORAGE_UNSAFE');let n;while((n=readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex');}finally{closeSync(fd);}}
function vint(bytes,offset){const first=bytes[offset];if(!first)return null;let length=1,mask=0x80;while(!(first&mask)){mask>>=1;length++;}if(length>8||offset+length>bytes.length)return null;let value=first&(mask-1);for(let i=1;i<length;i++)value=value*256+bytes[offset+i];return Number.isSafeInteger(value)?{value,length}:null;}
function webmHeader(bytes){
 if(bytes.length<8||!bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return false;
 const size=vint(bytes,4);if(!size||size.value>65500)return false;let offset=4+size.length,end=offset+size.value;if(end>bytes.length)return false;
 while(offset<end){let idLength=1,mask=0x80;while(idLength<=4&&!(bytes[offset]&mask)){mask>>=1;idLength++;}if(idLength>4||offset+idLength>end)return false;const id=bytes.subarray(offset,offset+idLength).toString('hex');offset+=idLength;const value=vint(bytes,offset);if(!value)return false;offset+=value.length;if(offset+value.value>end)return false;if(id==='4282')return bytes.toString('ascii',offset,offset+value.value)==='webm';offset+=value.value;
 }return false;
}
function identify(bytes,extension,contentType){
 if(extension==='.webm'){
  if(!webmHeader(bytes)||contentType&& !['video/webm','application/octet-stream'].includes(contentType))reject('LOCAL_VIDEO_MAGIC_INVALID');return {demuxer:'matroska',contentType:'video/webm'};
 }
 if(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp')reject('LOCAL_VIDEO_MAGIC_INVALID');const size=bytes.readUInt32BE(0);if(size<16||size>bytes.length||size>65536||(size-16)%4)reject('LOCAL_VIDEO_MAGIC_INVALID');
 const brands=[bytes.toString('ascii',8,12)];for(let p=16;p<size;p+=4)brands.push(bytes.toString('ascii',p,p+4));
 if(!brands.some(b=>/^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |M4VH|MSNV|qt  )$/.test(b))||contentType&& !['video/mp4','video/quicktime','video/x-m4v','application/octet-stream'].includes(contentType))reject('LOCAL_VIDEO_MAGIC_INVALID');
 return {demuxer:'mov',contentType:brands.includes('qt  ')?'video/quicktime':'video/mp4'};
}
export function localVideoProbeArguments(path,demuxer){
 if(!['mov','matroska'].includes(demuxer))reject('LOCAL_VIDEO_FORMAT_UNSUPPORTED');
 return ['-v','error','-protocol_whitelist','file','-format_whitelist',demuxer==='mov'?'mov':'matroska,webm','-f',demuxer,...(demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-probesize','8388608','-analyzeduration','10000000','-show_format','-show_streams','-of','json','-i',path];
}
async function defaultProbe(path,{signal,demuxer}){
 try{const result=await exec('ffprobe',localVideoProbeArguments(path,demuxer),{signal,timeout:20000,maxBuffer:1024*1024,windowsHide:true,shell:false,killSignal:'SIGKILL'});return JSON.parse(result.stdout);}catch(cause){if(signal?.aborted)throw known('LOCAL_VIDEO_CANCELLED',cause);throw known(cause.code==='ENOENT'?'LOCAL_VIDEO_PROBE_UNAVAILABLE':'LOCAL_VIDEO_INVALID',cause);}
}
function inspectProbe(result,demuxer){
 if(!result||!Array.isArray(result.streams)||typeof result.format?.format_name!=='string'||!(demuxer==='mov'?result.format.format_name.split(',').includes('mov'):result.format.format_name.split(',').includes('webm')||result.format.format_name.split(',').includes('matroska')))reject('LOCAL_VIDEO_INVALID');
 const videos=result.streams.filter(s=>s.codec_type==='video'&&s.disposition?.attached_pic!==1&&typeof s.codec_name==='string'&&s.codec_name!=='unknown'&&Number.isInteger(s.width)&&s.width>0&&Number.isInteger(s.height)&&s.height>0);
 if(!videos.length)reject('LOCAL_VIDEO_NO_VIDEO_STREAM');const durations=[result.format.duration,...videos.map(v=>v.duration)].map(Number).filter(n=>Number.isFinite(n)&&n>0);if(!durations.length)reject('LOCAL_VIDEO_DURATION_INVALID');
 const duration_ms=Math.round(Math.max(...durations)*1000);if(!Number.isSafeInteger(duration_ms)||duration_ms<1)reject('LOCAL_VIDEO_DURATION_INVALID');
 return {duration_ms,has_audio:result.streams.some(s=>s.codec_type==='audio')};
}
const publicRecord=row=>({provider:'local_upload',kind:'video',source_id:'local_'+row.hash,sha256:row.hash,game:row.game,title:row.title,author:null,source_url:null,published_at:null,published_date:null,publication_date:null,like_count:null,comment_count:null,share_count:null,collect_count:null,uploaded_at:row.uploaded_at,size:row.size,contentType:row.content_type,duration_ms:row.duration_ms,has_audio:!!row.has_audio,learning_status:'not_started'});

export function createLocalVideoStore({folder,probe=defaultProbe}={}){
 if(typeof folder!=='string'||!folder||typeof probe!=='function')reject('LOCAL_VIDEO_STORE_INVALID');
 mkdirSync(resolve(folder),{recursive:true,mode:0o700});const root=realpathSync(resolve(folder));if(lstatSync(resolve(folder)).isSymbolicLink())reject('LOCAL_VIDEO_STORAGE_UNSAFE');directory(root);
 const temp=directory(join(root,'incoming')),blobs=directory(join(root,'blobs')),index=join(root,'local-videos.sqlite');
 for(const suffix of ['','-wal','-shm','-journal'])if(existsSync(index+suffix))plainFile(index+suffix);
 const db=new DatabaseSync(index);db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS local_video_blobs(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,content_type TEXT NOT NULL,duration_ms INTEGER NOT NULL,has_audio INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS local_video_bindings(game TEXT NOT NULL,hash TEXT NOT NULL REFERENCES local_video_blobs(hash),title TEXT NOT NULL,uploaded_at TEXT NOT NULL,PRIMARY KEY(game,hash));`);
 let closed=false;const ready=()=>{if(closed)reject('LOCAL_VIDEO_STORE_CLOSED');directory(root,false);directory(temp,false);directory(blobs,false);};
 const query='SELECT b.*,v.game,v.title,v.uploaded_at FROM local_video_bindings v JOIN local_video_blobs b ON v.hash=b.hash';
 return {
  async importStream({stream,game,filename,contentType,declaredBytes,signal}={}){
   let staging,installed=false,blob,transaction=false;
   try{
    ready();abort(signal);const normalized=normalizeLocalGame(game),display=displayFilename(filename);
    const mime=typeof contentType==='string'?contentType.split(';')[0].trim().toLowerCase():'';if(contentType!=null&&typeof contentType!=='string'||mime&&!TYPES.has(mime))reject('LOCAL_VIDEO_CONTENT_TYPE_INVALID');
    if(declaredBytes!=null&&(!Number.isSafeInteger(declaredBytes)||declaredBytes<=0||declaredBytes>LOCAL_VIDEO_MAX_BYTES))reject('LOCAL_VIDEO_SIZE_INVALID');
    if(!stream||!(typeof stream[Symbol.asyncIterator]==='function'||typeof stream.getReader==='function'))reject('LOCAL_VIDEO_STREAM_INVALID');
    staging=join(temp,randomUUID()+'.part');const digest=createHash('sha256');let size=0,header=Buffer.alloc(0);
    const meter=new Transform({transform(chunk,encoding,done){try{abort(signal);size+=chunk.length;if(size>LOCAL_VIDEO_MAX_BYTES||declaredBytes!=null&&size>declaredBytes)reject('LOCAL_VIDEO_TOO_LARGE');digest.update(chunk);if(header.length<65536)header=Buffer.concat([header,chunk.subarray(0,65536-header.length)]);done(null,chunk);}catch(e){done(e);}}});
    await pipeline(stream,meter,createWriteStream(staging,{flags:'wx',mode:0o600}),{signal});abort(signal);if(!size)reject('LOCAL_VIDEO_EMPTY');if(declaredBytes!=null&&size!==declaredBytes)reject('LOCAL_VIDEO_SIZE_MISMATCH');
    const format=identify(header,display.extension,mime),hash=digest.digest('hex');plainFile(staging,size);
    const media=inspectProbe(await probe(staging,{signal,demuxer:format.demuxer}),format.demuxer);abort(signal);ready();
    blob=join(blobs,hash+'.blob');db.exec('BEGIN IMMEDIATE');transaction=true;abort(signal);
    if(existsSync(blob)){plainFile(blob,size);if(digestFile(blob)!==hash)reject('LOCAL_VIDEO_BLOB_INTEGRITY');}
    else{try{linkSync(staging,blob);installed=true;}catch(e){if(e.code!=='EEXIST')throw e;plainFile(blob,size);if(digestFile(blob)!==hash)reject('LOCAL_VIDEO_BLOB_INTEGRITY');}}
    const now=new Date().toISOString();db.prepare('INSERT OR IGNORE INTO local_video_blobs(hash,size,content_type,duration_ms,has_audio,created_at) VALUES(?,?,?,?,?,?)').run(hash,size,format.contentType,media.duration_ms,Number(media.has_audio),now);
    const result=db.prepare('INSERT OR IGNORE INTO local_video_bindings(game,hash,title,uploaded_at) VALUES(?,?,?,?)').run(normalized,hash,display.title,now);
    const record=db.prepare(query+' WHERE v.game=? AND v.hash=?').get(normalized,hash);db.exec('COMMIT');transaction=false;
    return {...publicRecord(record),duplicate:result.changes===0};
   }catch(cause){if(transaction){try{db.exec('ROLLBACK');}catch{}if(installed&&blob)try{unlinkSync(blob);}catch{}}
    if(signal?.aborted)throw known('LOCAL_VIDEO_CANCELLED',cause);if(cause.localVideoError)throw cause;throw known('LOCAL_VIDEO_IMPORT_FAILED',cause);
   }finally{if(staging)try{unlinkSync(staging);}catch(e){if(e.code!=='ENOENT')throw known('LOCAL_VIDEO_TEMP_CLEANUP_FAILED',e);}}
  },
  list(game){try{ready();return db.prepare(query+' WHERE v.game=? ORDER BY v.uploaded_at DESC,v.hash').all(normalizeLocalGame(game)).map(publicRecord);}catch(cause){if(cause.localVideoError)throw cause;throw known('LOCAL_VIDEO_STORAGE_UNSAFE',cause);}},
  open(sourceId){try{ready();const match=typeof sourceId==='string'&&ID.exec(sourceId);if(!match)reject('LOCAL_VIDEO_ID_INVALID');const row=db.prepare('SELECT b.* FROM local_video_blobs b WHERE hash=? AND EXISTS(SELECT 1 FROM local_video_bindings v WHERE v.hash=b.hash)').get(match[1]);if(!row)reject('LOCAL_VIDEO_NOT_FOUND');const path=join(blobs,row.hash+'.blob');plainFile(path,row.size);return {source_id:sourceId,sha256:row.hash,path,size:row.size,contentType:row.content_type};}catch(cause){if(cause.localVideoError)throw cause;throw known('LOCAL_VIDEO_STORAGE_UNSAFE',cause);}},
  close(){if(!closed){db.close();closed=true;}}
 };
}

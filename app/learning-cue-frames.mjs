import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {hash} from './tasks.mjs';
const exec=promisify(execFile);
export const LEARNING_CUE_FRAMES_VERSION='learning-cue-frames-2';
const VERSION=LEARNING_CUE_FRAMES_VERSION;

// ASR only locates a question. It never supplies the answer to the OCR.
export function selectCueTimes(segments,duration,existingTimes=[],limit=4){
  if(!Number.isFinite(duration)||duration<1||duration>900||!Number.isInteger(limit)||limit<0||limit>4)throw Error('Invalid cue frame bounds');
  const cues=[];
  for(const [index,s] of segments.entries()){
    if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>duration+1||typeof s.text!=='string')throw Error('Invalid cue segment');
    const scope=/(?:版本|赛季|賽季|测试服|測試服|经典服|經典服|模式|[\p{Script=Han}]{1,8}[版板][里裡中]|[\p{Script=Han}]{1,8}版)/u.test(s.text);
    const condition=/(?:惧怕|懼怕|克制|害怕|不能|不要|但是|不过|不過|仅限|僅限|这一队|這一隊)/u.test(s.text);
    if(!scope&&!condition)continue;
    const time=Number(Math.min(duration-.1,(s.start+s.end)/2).toFixed(3));
    if(existingTimes.some(t=>Math.abs(t-time)<.75))continue;
    cues.push({requested_time:time,segment_index:index,reason:scope?'scope_candidate':'condition_candidate',priority:scope?0:1});
  }
  // Scope first; spread conditional cues between the beginning and ending.
  const conditions=cues.filter(c=>c.priority===1).sort((a,b)=>a.requested_time-b.requested_time),spread=[];
  for(let first=0,last=conditions.length-1;first<=last;first++,last--){
    spread.push(conditions[first]);if(first!==last)spread.push(conditions[last]);
  }
  const ordered=[...cues.filter(c=>c.priority===0),...spread];
  const selected=[];
  for(const cue of ordered){if(selected.length===limit)break;if(!selected.some(c=>Math.abs(c.requested_time-cue.requested_time)<1))selected.push(cue);}
  return selected.sort((a,b)=>a.requested_time-b.requested_time);
}

// Small bounded PNG validation, including chunk CRCs and the compressed scanlines.
// No decoder dependency; ffmpeg output is bounded to 960 pixels on either axis.
const crcTable=Array.from({length:256},(_,i)=>{let value=i;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function validPng(bytes){
  try{
    if(bytes.length<57||bytes.length>10*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return false;
    let offset=8,width,height,depth,color,interlace,header=false,palette=false,endedData=false,seenData=false;const data=[];
    while(offset<bytes.length){
      if(offset+12>bytes.length)return false;
      const length=bytes.readUInt32BE(offset),end=offset+12+length,type=bytes.subarray(offset+4,offset+8).toString('ascii');
      if(end>bytes.length||!/^[A-Za-z]{4}$/.test(type)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return false;
      const chunk=bytes.subarray(offset+8,end-4);
      if(!header&&type!=='IHDR')return false;
      if(type==='IHDR'){
        if(header||length!==13)return false;
        width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);depth=chunk[8];color=chunk[9];interlace=chunk[12];
        if(width<1||height<1||width>960||height>960||!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]}[color]||[]).includes(depth)||chunk[10]!==0||chunk[11]!==0||interlace>1)return false;
        header=true;
      }else if(type==='PLTE'){
        if(palette||seenData||!length||length>768||length%3!==0)return false;palette=true;
      }else if(type==='IDAT'){
        if(endedData||color===3&&!palette)return false;seenData=true;data.push(chunk);
      }else if(type==='IEND'){
        if(length!==0||!seenData||end!==bytes.length)return false;
        const channels={0:1,2:3,3:1,4:2,6:4}[color];
        const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
        const rows=[];let expected=0;
        for(const [x,y,dx,dy] of passes){const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));if(!w||!h)continue;const size=1+Math.ceil(w*channels*depth/8);rows.push([h,size]);expected+=h*size;}
        const decoded=inflateSync(Buffer.concat(data),{maxOutputLength:expected});if(decoded.length!==expected)return false;
        let cursor=0;for(const [h,size] of rows)for(let row=0;row<h;row++){if(decoded[cursor]>4)return false;cursor+=size;}
        return true;
      }else if(type[0]===type[0].toUpperCase())return false;
      if(seenData&&type!=='IDAT')endedData=true;
      offset=end;
    }
    return false;
  }catch{return false;}
}

export async function prepareCueFrame(cue,{sourceId,sourcePath,sourceHash,folder,db,signal,run=exec}){
  if(!/^\d{10,25}$/.test(sourceId)||!/^[a-f0-9]{64}$/.test(sourceHash)||!Number.isFinite(cue.requested_time)||cue.requested_time<0||cue.requested_time>900)throw Error('Invalid cue identity');
  const key='learning-cue-frame:'+hash({sourceId,sourceHash,time:cue.requested_time,version:VERSION});
  const filename='learning-cue-'+cue.requested_time.toFixed(3)+'.png',path=new URL(filename,folder);
  const cached=db.checkpoint(key);
  if(cached?.file===filename&&cached.source_sha256===sourceHash&&cached.source_id===sourceId&&cached.method==='asr_cue_original_frame'&&cached.timestamp_method==='ffmpeg_original_pts'){
    const bytes=await readFile(path).catch(()=>null);
    if(bytes&&validPng(bytes)&&hash(bytes)===cached.sha256&&Number.isFinite(cached.actual_time)&&Math.abs(cached.actual_time-cue.requested_time)<.25)return {...cached,bytes};
  }
  signal?.throwIfAborted();
  const {stderr}=await run('ffmpeg',['-hide_banner','-loglevel','info','-copyts','-ss',String(cue.requested_time),'-i',sourcePath,'-frames:v','1','-vf','showinfo,scale=960:960:force_original_aspect_ratio=decrease','-y',fileURLToPath(path)],{signal,timeout:60000,maxBuffer:2*1024*1024,windowsHide:true});
  const pts=String(stderr).match(/n:\s*0\s+pts:\s*\d+\s+pts_time:([\d.]+)/);
  const actual=Number(pts?.[1]);
  if(!pts||!Number.isFinite(actual)||Math.abs(actual-cue.requested_time)>=.25)throw Error('Supplemental frame timestamp not verified');
  const bytes=await readFile(path);
  if(!validPng(bytes))throw Error('Invalid supplemental image');
  const frame={...cue,file:filename,actual_time:actual,sha256:hash(bytes),source_id:sourceId,source_sha256:sourceHash,method:'asr_cue_original_frame',timestamp_method:'ffmpeg_original_pts'};
  signal?.throwIfAborted();db.checkpoint(key,frame);return {...frame,bytes};
}

// Read-only outer-cache dependency check: never extracts a frame or runs a model.
export async function cueFramesFingerprint(cues,{sourceId,sourceHash,folder,db}){
  const frames=[];
  for(const cue of cues){
    const key='learning-cue-frame:'+hash({sourceId,sourceHash,time:cue.requested_time,version:VERSION});
    const cached=db?.checkpoint(key),file='learning-cue-'+cue.requested_time.toFixed(3)+'.png';
    if(!cached||cached.file!==file||cached.source_id!==sourceId||cached.source_sha256!==sourceHash||cached.method!=='asr_cue_original_frame'||cached.timestamp_method!=='ffmpeg_original_pts'||!Number.isFinite(cached.actual_time)||Math.abs(cached.actual_time-cue.requested_time)>=.25)return null;
    const bytes=await readFile(new URL(file,folder)).catch(()=>null);
    if(!bytes||!validPng(bytes)||hash(bytes)!==cached.sha256)return null;
    frames.push({source_id:sourceId,source_sha256:sourceHash,file,sha256:cached.sha256,actual_time:cached.actual_time});
  }
  return frames;
}

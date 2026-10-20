import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {timingSafeEqual} from 'node:crypto';

const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
const forUI=record=>({...record,collection:'games',scope:'用户上传至本机；发布时间与平台互动未核'});
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function localMediaCookie(token,name='crawl_local_media'){
 if(!/^[a-zA-Z0-9_]+$/.test(name)||!/^[a-zA-Z0-9_-]{16,128}$/.test(token))throw Error('Invalid local media session');
 return `${name}=${token}; Path=/api/local-videos; HttpOnly; SameSite=Strict`;
}
export function localVideoRange(value,size){
 if(value==null)return {start:0,end:size-1,partial:false};
 const m=/^bytes=(\d*)-(\d*)$/.exec(value);
 if(!m||!m[1]&&!m[2])return null;
 const first=m[1]?Number(m[1]):null,last=m[2]?Number(m[2]):null;
 if([first,last].some(n=>n!==null&&(!Number.isSafeInteger(n)||n<0)))return null;
 if(first===null){if(last===0)return null;return {start:Math.max(0,size-last),end:size-1,partial:true};}
 if(first>=size||last!==null&&last<first)return null;
 return {start:first,end:Math.min(last??size-1,size-1),partial:true};
}
// Caller has already applied its Host/Origin policy. Every mutation still
// checks the session here; media previews use a scoped HttpOnly cookie.
export async function handleLocalVideos(req,res,url,{store,token,cookieName='crawl_local_media'}={}){
 if(url.pathname!=='/api/local-videos'&&!url.pathname.startsWith('/api/local-videos/'))return false;
 try{
  if(url.pathname==='/api/local-videos'){
   if(req.method==='GET'){
    const records=await store.list(url.searchParams.get('game'));
    reply(res,200,{records:records.map(forUI),source:'local_upload',new_paid_calls:0});return true;
   }
   if(req.method==='POST'){
    if(!equal(req.headers['x-crawl-token'],token)){reply(res,403,{error:'会话过期，请刷新'});return true;}
    if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'){reply(res,400,{error:'请上传原始视频文件'});return true;}
    const controller=new AbortController();
    const abort=()=>controller.abort();
    const closed=()=>{if(!res.writableEnded)abort();};
    req.once('aborted',abort);res.once('close',closed);
    const timer=setTimeout(abort,180000);timer.unref();
    try{
     const declared=req.headers['content-length'];
     if(declared!=null&&!/^\d+$/.test(declared))throw Error('Invalid content length');
     const record=await store.importStream({stream:req,game:url.searchParams.get('game'),filename:url.searchParams.get('filename'),contentType:req.headers['content-type'],declaredBytes:declared==null?undefined:Number(declared),signal:controller.signal});
     reply(res,record.duplicate?200:201,{record:forUI(record),new_paid_calls:0,learning_started:false});
    }finally{clearTimeout(timer);req.off('aborted',abort);res.off('close',closed);}
    return true;
   }
   reply(res,405,{error:'不支持的操作'});return true;
  }
  const match=/^\/api\/local-videos\/(local_[a-f0-9]{64})\/media$/.exec(url.pathname);
  if(!match||!['GET','HEAD'].includes(req.method)){reply(res,404,{error:'本地视频不存在'});return true;}
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!equal(cookie,token)&&!equal(req.headers['x-crawl-token'],token)){reply(res,403,{error:'会话过期，请刷新'});return true;}
  const media=await store.open(match[1]),range=localVideoRange(req.headers.range,media.size);
  res.setHeader('Accept-Ranges','bytes');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  if(!range){res.writeHead(416,{'Content-Range':`bytes */${media.size}`});res.end();return true;}
  res.setHeader('Content-Type',media.contentType);res.setHeader('Content-Disposition','inline');
  res.setHeader('Content-Length',range.end-range.start+1);
  if(range.partial)res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${media.size}`);
  res.writeHead(range.partial?206:200);
  if(req.method==='HEAD'){res.end();return true;}
  await pipeline(createReadStream(media.path,{start:range.start,end:range.end}),res);
  return true;
 }catch(e){
  if(res.headersSent){res.destroy();return true;}
  const messages={LOCAL_VIDEO_CANCELLED:'上传已停止，已成功保存的视频仍保留',LOCAL_VIDEO_SIZE_INVALID:'单个视频须大于0字节且不超过1GB',LOCAL_VIDEO_TOO_LARGE:'视频超过1GB或声明的大小',LOCAL_VIDEO_SIZE_MISMATCH:'文件未完整收到，请核对后重新上传',LOCAL_VIDEO_FORMAT_UNSUPPORTED:'支持MP4、MOV、M4V、WebM视频',LOCAL_VIDEO_MAGIC_INVALID:'文件内容与支持的视频格式不符',LOCAL_VIDEO_INVALID:'视频文件无法读取',LOCAL_VIDEO_NO_VIDEO_STREAM:'文件未包含可读视频画面',LOCAL_VIDEO_PROBE_UNAVAILABLE:'缺少FFmpeg的ffprobe组件，请按安装说明补齐',LOCAL_VIDEO_GAME_INVALID:'请输入1–40字目标游戏'};
  reply(res,e.code==='ENOENT'||e.code==='LOCAL_VIDEO_NOT_FOUND'?404:400,{error:messages[e.code]||'本地视频操作未完成；请核对文件格式、大小或刷新后查看已保存结果',code:'LOCAL_VIDEO_FAILED'});
  return true;
 }
}

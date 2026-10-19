import {mkdtemp,mkdir,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {dataDir} from './config.mjs';
import {parseRedfoxMediaReceipt,validateRedfoxMediaURL} from './redfox-media-source.mjs';
import {RedfoxSourceError} from './redfox-error.mjs';

const localErrors=new WeakSet();
const fail=message=>{const error=new RedfoxSourceError(message);localErrors.add(error);throw error;};
const HARD_MAX=128*1024*1024;
const SAFE_TRANSPORT_CODES=new Set(['ECONNRESET','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);

// The resolver receipt authorizes only this single bounded CDN transfer. This
// does not resolve another URL, retry, publish an asset, or verify its contents.
export async function downloadRedfoxMedia(row,receipt,{
  signal,fetch:fetchImpl=globalThis.fetch,folder=join(dataDir,'media-downloads'),
  timeoutMs=300000,maxBytes=HARD_MAX,
}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000 ||
     !Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>HARD_MAX)
    fail('原片下载大小或超时设置无效');
  let rebuilt;
  try {
    rebuilt=parseRedfoxMediaReceipt(receipt?.response,row,{startedAt:receipt?.started_at,receivedAt:receipt?.received_at});
    for(const [key,value] of Object.entries(rebuilt))
      if(JSON.stringify(receipt[key])!==JSON.stringify(value)) fail('原片下载回执与实际解析结果不一致');
  } catch {fail('原片下载回执无效或与实际解析结果不一致');}
  if(signal?.aborted) fail('原片下载已取消，未请求媒体');
  const controller=new AbortController();
  let timedOut=false,temporary=null,handle=null,reader=null,bytes=0,expected=null;
  let rejectAbort;
  const interrupted=new Promise((_,reject)=>{rejectAbort=reject;});
  interrupted.catch(()=>{});
  const abort=()=>{controller.abort();rejectAbort(new Error('cancelled'));};
  const timeout=setTimeout(()=>{timedOut=true;abort();},timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  const bounded=promise=>Promise.race([promise,interrupted]);
  const cleanup=async()=>{
    if(temporary) await rm(temporary,{recursive:true,force:true});
  };
  try {
    await mkdir(folder,{recursive:true});
    temporary=await mkdtemp(join(folder,'redfox-'));
    controller.signal.throwIfAborted();
    const sourcePath=join(temporary,'source.mp4');
    let response,currentURL=rebuilt.media_url;
    const visited=new Set([currentURL]);
    for(let hops=0;;hops++) {
      response=await bounded(fetchImpl(currentURL,{
        method:'GET',redirect:'manual',signal:controller.signal,
        headers:{Accept:'video/*, application/octet-stream'},
      }));
      controller.signal.throwIfAborted();
      if(response.redirected || (response.url && response.url!==currentURL)) fail('原片下载实际地址与已核对地址不一致');
      if(![301,302,303,307,308].includes(response.status))break;
      try{const cancelled=response.body?.cancel();cancelled?.catch?.(()=>{});}catch{}
      if(hops>=3)fail('原片下载跳转次数超过上限，未继续请求');
      const location=response.headers?.get('location');
      let next;
      try{if(!location)throw Error();next=validateRedfoxMediaURL(new URL(location,currentURL).href);}catch{fail('原片下载跳转地址未通过媒体域名校验，未继续请求');}
      if(visited.has(next))fail('原片下载出现循环跳转，未继续请求');
      visited.add(next);currentURL=next;
    }
    if(response?.status!==200) fail('原片下载响应状态无效');
    const mime=String(response.headers?.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!/^video\/[a-z0-9.+-]+$/.test(mime)&&mime!=='application/octet-stream') fail('原片下载未返回视频媒体类型');
    const length=response.headers?.get('content-length');
    expected=length==null?null:/^\d+$/.test(length)?Number(length):NaN;
    if(expected!==null && (!Number.isSafeInteger(expected)||expected<1||expected>maxBytes)) fail('原片下载声明大小无效或超过上限');
    if(!response.body || typeof response.body.getReader!=='function') fail('原片下载没有可读取的数据流');
    reader=response.body.getReader();
    handle=await open(sourcePath,'wx',0o600);
    for(;;) {
      const part=await bounded(reader.read());
      controller.signal.throwIfAborted();
      if(part.done) break;
      if(!(part.value instanceof Uint8Array)) fail('原片下载数据流格式无效');
      bytes+=part.value.byteLength;
      if(bytes>maxBytes) fail('原片下载超过大小上限，已停止');
      // FileHandle.write may complete only part of a buffer.
      let offset=0;
      while(offset<part.value.byteLength) {
        const written=await bounded(handle.write(part.value,offset,part.value.byteLength-offset));
        controller.signal.throwIfAborted();
        if(!written.bytesWritten) fail('原片下载文件写入未完成');
        offset+=written.bytesWritten;
      }
    }
    if(!bytes || (expected!==null&&bytes!==expected)) fail('原片下载数据不完整');
    await handle.close();handle=null;
    controller.signal.throwIfAborted();
    return {sourcePath,cleanup};
  } catch(error) {
    controller.abort();
    try {const cancelled=reader?.cancel();cancelled?.catch?.(()=>{});}catch{}
    if(handle) {try{await handle.close();}catch{}handle=null;}
    try{await cleanup();}catch{fail('原片下载失败且临时文件清理未完成');}
    if(signal?.aborted) fail('原片下载已取消，临时文件已清理');
    if(timedOut) fail('原片下载超时，临时文件已清理，未重试');
    if(localErrors.has(error)) throw error;
    const code=[error?.code,error?.cause?.code].find(value=>SAFE_TRANSPORT_CODES.has(value));
    const progress=`已接收${bytes}字节${Number.isSafeInteger(expected)?`，声明${expected}字节`:''}`;
    fail(`原片下载失败${code?`（${code}；${progress}）`:`（${progress}）`}，临时文件已清理，未重试`);
  } finally {
    clearTimeout(timeout);signal?.removeEventListener('abort',abort);
    try{reader?.releaseLock();}catch{}
  }
}

import {RedfoxSourceError,redfoxTransportDiagnostic} from './redfox-error.mjs';

export const REDFOX_MEDIA_ENDPOINT = 'https://redfox.hk/story/api/parseWork/videoDownload/douyin';
// Real resolver receipts on 2026-10-19 used v5-gz-a, v26 and v95-zj-a
// on douyinvod.com. Permit only that numbered video-node format, not an
// arbitrary hostname/subdomain; retain other observed hosts as exact entries.
// n98-v-ncdnon was returned by saved batch receipt 7695475154498981158.
const OBSERVED_MEDIA_HOSTS = new Set(['v5-dy-ov-experiment.zjcdn.com', 'n98-v-ncdnon.douyinvod.com']);
const DOUYIN_VIDEO_NODE = /^v[0-9]+(?:-[a-z0-9]+)*\.douyinvod\.com$/;
// This exact gateway/embedded origin was observed in a saved resolver receipt
// and checked by DNS, valid HTTPS TLS and one HEAD on 2026-10-20. New gateway
// subdomains or origin-path prefixes still require review; no suffix wildcard.
function isReviewedMediaGateway(value,url) {
  const host='1aaaedc3949ba59abgnd56u2vjbrmhzgoxaqn6artg4.bdcgslb.com';
  const originPath='/v5-e.douyinvod.com/';
  if(url.hostname!==host || !value.startsWith(`https://${host}${originPath}`) ||
     !url.pathname.startsWith(originPath) || value.includes('#'))return false;
  // Check the raw path as well: URL parsing normalizes ports, encoded host
  // characters and dot segments before the downstream fetch sees the URL.
  const rawPath=value.slice(`https://${host}`.length).split(/[?#]/,1)[0];
  return !rawPath.includes('\\') && !/%(?:2f|5c|2e)/i.test(rawPath) &&
    !/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath);
}

const fail = message => {throw new RedfoxSourceError(message);};
const iso = value => {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) fail('原片解析时间无效');
  return date.toISOString();
};
function publicText(value,name) {
  if(value==null) return null;
  if(typeof value!=='string' || value.length>20000) fail(`原片解析${name}字段无效`);
  return value;
}
export function validateRedfoxMediaURL(value) {
  if(typeof value!=='string' || value.length>20000) fail('原片下载链接无效');
  let url;try{url=new URL(value);}catch{fail('原片下载链接无效');}
  // Accept only the documented public CDN family. Unrecognized hosts require
  // review before downloading; never follow arbitrary API URLs into localhost.
  if(url.protocol!=='https:' || url.username || url.password || url.port || url.hash ||
     !(url.hostname.endsWith('.365yg.com') || DOUYIN_VIDEO_NODE.test(url.hostname) || OBSERVED_MEDIA_HOSTS.has(url.hostname) || isReviewedMediaGateway(value,url))) fail('原片下载地址不属于已核对的HTTPS媒体域名，未下载');
  return url.href;
}
function input(row) {
  if(row?.provider!=='redfox' || row.kind!=='video' ||
     typeof row.source_id!=='string' || !/^\d{10,25}$/.test(row.source_id) ||
     row.source_url!==`https://www.douyin.com/video/${row.source_id}`)
    fail('原片解析只接受已采集的红狐视频及其完整作品链接');
  return {url:row.source_url};
}
export function parseRedfoxMediaReceipt(response,row,{startedAt,receivedAt}) {
  const request=input(row),start=iso(startedAt),end=iso(receivedAt);
  if(Date.parse(end)<Date.parse(start)) fail('原片解析回执时间无效');
  if(response?.code!==2000 || !response.data || Array.isArray(response.data))
    fail(`原片解析未返回成功结果（code=${Number.isSafeInteger(response?.code)?response.code:'unknown'}）`);
  const data=response.data;
  if(data.resources!=null && (!Array.isArray(data.resources) || data.resources.length>100))
    fail('原片解析资源列表无效');
  const candidates=(data.resources||[]).filter(resource=>resource?.type==='video');
  const urls=[...new Set([
    ...(data.videoUrl ? [data.videoUrl] : []),
    ...candidates.map(resource=>resource.downloadUrl),
  ])];
  if(!urls.length) fail('原片解析没有返回视频资源，不以图片或独立配乐替代原片');
  const videoUrl=validateRedfoxMediaURL(urls[0]);
  const resource=candidates.find(item=>item.downloadUrl===urls[0]);
  const duration=resource?.durationSeconds ?? null;
  if(duration!==null && (!Number.isFinite(duration) || duration<=0 || duration>86400))
    fail('原片解析时长无效');
  return {
    provider:'redfox',source_id:row.source_id,source_url:row.source_url,
    endpoint:REDFOX_MEDIA_ENDPOINT,request,started_at:start,received_at:end,
    request_count:1,media_url:videoUrl,media_type:'video',
    duration_seconds:duration,title:publicText(data.title,'标题'),description:publicText(data.desc,'描述'),
    // Retain only the selected public resource for offline replay/import.
    response:{code:2000,data:{title:publicText(data.title,'标题'),desc:publicText(data.desc,'描述'),videoUrl,
      resources:[{type:'video',downloadUrl:videoUrl,...(duration===null?{}:{durationSeconds:duration})}]}},
    // A resolver receipt alone is neither a downloaded file nor proof of its
    // identity/content. Preserve that distinction for later ffprobe/AV checks.
    status:'resolved_not_downloaded',identity_verified:false,
  };
}

// The acquisition queue must expose the extra per-video cost and authorize one
// attempt; no retry or scheduler is allowed inside the resolver.
export function createRedfoxMediaSource({apiKey,fetch:fetchImpl=globalThis.fetch,clock=()=>new Date(),timeoutMs=30000}={}) {
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120000) fail('原片解析超时设置无效');
  return {
    async resolve(row,{userInitiated=false,maxRequests=0,signal,onReceipt}={}) {
      if(userInitiated!==true || maxRequests!==1) fail('原片解析需要明确的一次查询授权，不自动追加收费');
      const request=input(row),startedAt=iso(clock());
      let credential;
      try {credential=typeof apiKey==='function'?await apiKey():apiKey;} catch {fail('原片解析密钥读取失败');}
      if(typeof credential!=='string' || !credential.trim()) fail('原片解析尚未配置红狐API密钥');
      credential=credential.trim();
      if(signal?.aborted) fail('原片解析已取消，未调用接口');
      const controller=new AbortController();
      const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
      let timeout,timedOut=false;
      try {
        const response=await Promise.race([
          (async()=>{
            const result=await fetchImpl(REDFOX_MEDIA_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',REDFOX_API_KEY:credential},body:JSON.stringify(request),redirect:'error',signal:controller.signal});
            if(result.status!==200 || result.redirected) fail(`原片解析HTTP失败（status=${Number.isSafeInteger(result.status)?result.status:'unknown'}）`);
            const body=await result.text();
            if(body.length>2000000 || body.includes(credential)) fail('原片解析响应异常，未保留正文');
            try{return JSON.parse(body);}catch{fail('原片解析响应不是有效JSON');}
          })(),
          new Promise((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error('deadline'));},timeoutMs);}),
        ]);
        // Inspect decoded strings too: JSON unicode escapes must not bypass
        // credential redaction before a reply reaches local storage.
        if(JSON.stringify(response).includes(credential)) fail('原片解析响应异常，未保留正文');
        const receivedAt=iso(clock());
        // Save the bounded, credential-checked reply before interpretation. A
        // new CDN or schema mismatch must not require another paid resolution.
        const d=response?.data;
        const textField=v=>typeof v==='string'&&v.length<=20000?v:null;
        const numberField=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
        const retained={code:Number.isSafeInteger(response?.code)?response.code:null,data:d && typeof d==='object' && !Array.isArray(d) ? {
          title:textField(d.title),desc:textField(d.desc),videoUrl:textField(d.videoUrl),
          resources:Array.isArray(d.resources)?d.resources.slice(0,101).map(r=>({type:textField(r?.type),downloadUrl:textField(r?.downloadUrl),durationSeconds:numberField(r?.durationSeconds)})):null,
        }:null};
        await onReceipt?.({status:'unvalidated',source_id:row.source_id,source_url:row.source_url,response:retained,started_at:startedAt,received_at:receivedAt});
        if(signal?.aborted) fail('原片解析已取消');
        return parseRedfoxMediaReceipt(response,row,{startedAt,receivedAt});
      } catch(error) {
        if(signal?.aborted) fail('原片解析已取消');
        if(timedOut) fail('原片解析单次请求超时，未重试');
        if(error instanceof RedfoxSourceError) throw error;
        fail(`原片解析传输失败，未重试（${redfoxTransportDiagnostic(error)}）`);
      } finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
    },
  };
}

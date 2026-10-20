// Dedicated candidate store only. Reads never dispatch or recover work.
import {creativeTaskRequest} from './creative-task.mjs';
import {normalizeLocalGame} from './local-videos.mjs';
const BASE='/api/creative-candidates',UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const family=path=>path===BASE||path.startsWith(BASE+'/');
const messages={
 CREATIVE_TASK_INPUT:[400,'请选择目标游戏、固定学习版本、已选视频和创作模式，不接受额外素材或路径。'],
 CREATIVE_HTTP_QUERY:[400,'请求包含不支持或重复的参数。'],
 CREATIVE_HTTP_CANCEL:[400,'取消不接受额外参数。'],
 CREATIVE_RUNTIME_HELD:[409,'创作候选入口尚未启用，未启动任务。'],
 CREATIVE_RUNTIME_STOPPED:[409,'创作执行器正在停止，请稍后重试。'],
 CREATIVE_TASK_NOT_FOUND:[404,'创作候选任务不存在。'],
 CREATIVE_TASK_NOT_OWNER:[409,'该任务仍由另一个执行器持有，未取消或重新执行。'],
 CREATIVE_TASK_BUSY:[409,'该任务正在执行，未重复启动。'],
 CREATIVE_HOST_CONFIGURATION_REQUIRED:[409,'尚未配置可用的宿主助手执行器，未开始创作。'],
 CREATIVE_SOURCE_REQUIRED:[409,'选题来源无效，请重新选择已保存的作品；未自动查询。'],
 CREATIVE_ORIGINAL_REQUIRED:[409,'该作品没有可用原片；未自动解析、下载或收费。'],
 MEDIA_ASSET_REQUIRED:[409,'该作品的已保存原片不可用；未自动解析、下载或收费。'],
 STUDY_EVIDENCE_PROFILE:[409,'固定学习档案不可用，请核对目标游戏与档案版本。'],
 STUDY_EVIDENCE_HASH:[409,'固定证据文件发生变化，未使用替代资料。'],
};
const fail=code=>{throw Object.assign(Error(code),{code});};
function query(url,allowGame=false){
 const keys=[...url.searchParams.keys()];if(keys.some(k=>!allowGame||k!=='game')||new Set(keys).size!==keys.length)fail('CREATIVE_HTTP_QUERY');
 if(!keys.length)return undefined;
 try{return normalizeLocalGame(url.searchParams.get('game'));}catch{fail('CREATIVE_TASK_INPUT');}
}
export async function handleCreativeHttp(req,res,url,{runtime,token,origin,json,body}){
 if(!family(url.pathname))return false;
 const expected=new URL(origin),alias=`${expected.protocol}//localhost${expected.port?':'+expected.port:''}`;
 if(!new Set([expected.host,new URL(alias).host]).has(req.headers.host)||req.headers.origin&&!new Set([origin,alias]).has(req.headers.origin)){
  json(res,403,{error:'来源不允许'});return true;
 }
 if(req.method!=='GET'&&(typeof token!=='string'||!token||req.headers['x-crawl-token']!==token)){json(res,403,{error:'会话过期，请刷新'});return true;}
 try{
  if(url.pathname===BASE){
   if(req.method==='GET'){
    const game=query(url,true),tasks=runtime.list();json(res,200,game===undefined?tasks:tasks.filter(t=>t.payload?.game===game));
   }else if(req.method==='POST'){
    query(url);let request;try{request=creativeTaskRequest(await body(req));}catch{fail('CREATIVE_TASK_INPUT');}
    json(res,202,await runtime.start(request));
   }else json(res,405,{error:'操作不支持'});
   return true;
  }
  query(url);
  const match=url.pathname.match(new RegExp('^'+BASE+'/('+UUID+')(?:/(cancel))?$'));
  if(!match){json(res,404,{error:messages.CREATIVE_TASK_NOT_FOUND[1],code:'CREATIVE_TASK_NOT_FOUND'});return true;}
  // The runtime has no has(); only its isolated read may establish existence.
  const task=runtime.read(match[1]);if(!task)fail('CREATIVE_TASK_NOT_FOUND');
  if(req.method==='GET'&&!match[2])json(res,200,task);
  else if(req.method==='POST'&&match[2]==='cancel'){
   const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)fail('CREATIVE_HTTP_CANCEL');
   json(res,200,await runtime.cancel(match[1]));
  }else json(res,405,{error:'操作不支持；中断任务不会自动重试'});
 }catch(error){
  const known=Object.hasOwn(messages,error?.code??''),code=known?error.code:'CREATIVE_REQUEST_FAILED';
  const [status,message]=known?messages[code]:[400,'创作操作未完成；请检查固定来源、原片与执行器状态。未自动重试、付费查询或交付。'];
  json(res,status,{error:message,code});
 }
 return true;
}

// Review is an explicit mutation; reads and reconciliation never dispatch writes.
import {destination} from './delivery.mjs';
const BASE='/api/candidate-deliveries',UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const messages={CANDIDATE_DELIVERY_DISABLED:[409,'腾讯交付入口尚未验收开放，未写入。'],CANDIDATE_DELIVERY_CLOSED:[409,'交付执行器正在停止。'],CANDIDATE_DELIVERY_INPUT:[400,'请确认当前草稿版本和显示的目标，不接受额外正文或路径。'],CANDIDATE_DELIVERY_NOT_FOUND:[404,'交付记录不存在。'],CANDIDATE_DELIVERY_DESTINATION_CHANGED:[409,'交付目标已变化，请刷新并重新核对；未写入新目标。'],CANDIDATE_DELIVERY_CANDIDATE_INVALID:[409,'当前草稿尚不满足交付条件。'],CANDIDATE_DELIVERY_BUSY:[409,'该记录仍在执行，请等待或停止交付。'],CANDIDATE_DELIVERY_UNKNOWN:[409,'上次写入结果不明确，请先只读核对，未重复写入。']};
export async function handleCandidateDeliveryHttp(req,res,url,{service,token,origin,json,body}){
 if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return false;
 const u=new URL(origin),alias=`${u.protocol}//localhost${u.port?':'+u.port:''}`;
 if(!new Set([u.host,new URL(alias).host]).has(req.headers.host)||req.headers.origin&&!new Set([origin,alias]).has(req.headers.origin)){json(res,403,{error:'来源不允许'});return true;}
 if(req.method!=='GET'&&(!token||req.headers['x-crawl-token']!==token)){json(res,403,{error:'会话过期，请刷新'});return true;}
 try{
  if(url.search){json(res,400,{error:'请求不接受额外查询参数'});return true;}
  if(url.pathname===BASE){
   if(req.method==='GET')json(res,200,service.list());
   else if(req.method==='POST'){
    const value=await body(req);
    if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='draft_sha256,result_version,target,task_id'||!new RegExp('^'+UUID+'$').test(value.task_id)||!['draft_sha256','result_version'].every(k=>typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k]))||!value.target||Object.keys(value.target).sort().join(',')!=='file_id,url')json(res,400,{error:messages.CANDIDATE_DELIVERY_INPUT[1],code:'CANDIDATE_DELIVERY_INPUT'});
    else {const {target,...request}=value;json(res,202,await service.approve(request,{expectedTarget:destination(target)}));}
   }
   else json(res,405,{error:'操作不支持'});
   return true;
  }
  const match=url.pathname.match(new RegExp('^'+BASE+'/('+UUID+')(?:/(reconcile|cancel|resume))?$'));
  if(!match){json(res,404,{error:'交付记录不存在'});return true;}
  if(req.method==='GET'&&!match[2])json(res,200,service.read(match[1]));
  else if(req.method==='POST'&&match[2]){
   const input=await body(req);if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length)json(res,400,{error:'操作不接受额外参数'});
   else json(res,200,await service[match[2]](match[1]));
  }else json(res,405,{error:'操作不支持；不会自动重试写入'});
 }catch(error){const [status,message]=messages[error?.code]||[409,'交付未完成，请检查固定草稿、目标或腾讯权限。未自动重试。'];json(res,status,{error:message,code:Object.hasOwn(messages,error?.code||'')?error.code:'CANDIDATE_DELIVERY_FAILED'});}
 return true;
}

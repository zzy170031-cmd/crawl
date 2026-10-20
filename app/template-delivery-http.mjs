// Only fixed plans and session-authorized actions; never accepts rows, tool names,
// server authorization records, or file paths from the browser.
import {destination} from './delivery.mjs';
const BASE='/api/template-deliveries',UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',SHA=/^[a-f0-9]{64}$/;
const fail=c=>{throw Object.assign(Error(c),{code:c});};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===k.slice().sort().join(',');
function target(v){if(!exact(v,['file_id','url']))fail('TEMPLATE_DELIVERY_INPUT');try{return destination(v);}catch{fail('TEMPLATE_DELIVERY_INPUT');}}
const messages={
 TEMPLATE_DELIVERY_INPUT:[400,'请确认固定草稿、模板计划和显示的目标；不接受额外正文、授权或路径。'],
 TEMPLATE_DELIVERY_DISABLED:[409,'模板交付尚未开放，未写入。'],TEMPLATE_DELIVERY_CLOSED:[409,'交付执行器正在停止。'],
 TEMPLATE_DELIVERY_NOT_FOUND:[404,'模板交付记录不存在。'],TEMPLATE_DELIVERY_TARGET_CHANGED:[409,'目标文档已变化，请重新核对。'],
 TEMPLATE_DELIVERY_PLAN_CHANGED:[409,'模板计划版本不匹配，未写入。'],TEMPLATE_DELIVERY_CANDIDATE_INVALID:[409,'固定创作候选不可用或存在关键缺口。'],
 TEMPLATE_DELIVERY_BASELINE_CHANGED:[409,'模板表或已有内容变化，已停止覆盖。'],TEMPLATE_DELIVERY_TEMPLATE_HEADERS:[409,'模板表头不匹配，未覆盖已有内容。'],
 TEMPLATE_DELIVERY_TEMPLATE_AMBIGUOUS:[409,'发现同名模板表，未选择或覆盖。'],TEMPLATE_DELIVERY_SHEET_CAPACITY:[409,'目标表可用区域不足，未覆盖或自动扩表。'],
 TEMPLATE_DELIVERY_BUSY:[409,'该记录正在执行，未重复操作。'],TEMPLATE_DELIVERY_TARGET_BUSY:[409,'此目标仍有执行中或待核对交付，未开始另一笔写入。'],
 TEMPLATE_DELIVERY_UNKNOWN:[409,'上次结果不明确，只能核对，未重复写入。'],
};
export async function handleTemplateDeliveryHttp(req,res,url,{service,token,origin,json,body}){
 if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return false;
 const u=new URL(origin),alias=`${u.protocol}//localhost${u.port?':'+u.port:''}`;
 if(![u.host,new URL(alias).host].includes(req.headers.host)||req.headers.origin&&![origin,alias].includes(req.headers.origin)){json(res,403,{error:'来源不允许'});return true;}
 if(req.method!=='GET'&&(!token||req.headers['x-crawl-token']!==token)){json(res,403,{error:'会话过期，请刷新'});return true;}
 try{
  if(url.search)fail('TEMPLATE_DELIVERY_INPUT');
  if(url.pathname===BASE){if(req.method==='GET')json(res,200,service.list());else json(res,405,{error:'请先核对模板分配，再明确确认交付'});return true;}
  if(url.pathname===BASE+'/prepare'){
   if(req.method!=='POST'){json(res,405,{error:'操作不支持'});return true;}const v=await body(req);
   if(!exact(v,['task_id','result_version','draft_sha256','target'])||!new RegExp('^'+UUID+'$').test(v.task_id)||!SHA.test(v.result_version)||!SHA.test(v.draft_sha256))fail('TEMPLATE_DELIVERY_INPUT');
   const {target:dest,...q}=v;json(res,200,await service.prepare(q,{expectedTarget:target(dest)}));return true;
  }
  const match=url.pathname.match(new RegExp('^'+BASE+'/('+UUID+')(?:/(approve|reconcile|cancel))?$'));if(!match)fail('TEMPLATE_DELIVERY_NOT_FOUND');
  if(req.method==='GET'&&!match[2])json(res,200,service.read(match[1]));
  else if(req.method==='POST'&&match[2]){const v=await body(req);if(match[2]==='approve'){if(!exact(v,['plan_sha256','target'])||!SHA.test(v.plan_sha256))fail('TEMPLATE_DELIVERY_INPUT');json(res,202,await service.approve({plan_id:match[1],plan_sha256:v.plan_sha256},{expectedTarget:target(v.target)}));}
   else{if(!exact(v,[]))fail('TEMPLATE_DELIVERY_INPUT');json(res,200,await service[match[2]](match[1]));}}
  else json(res,405,{error:'操作不支持；不会自动重试写入'});
 }catch(e){const known=Object.hasOwn(messages,e?.code||''),code=known?e.code:'TEMPLATE_DELIVERY_FAILED';const [status,message]=known?messages[code]:[409,'模板交付未完成，请核对固定草稿、目标和回执；未自动重试。'];json(res,status,{error:message,code});}
 return true;
}

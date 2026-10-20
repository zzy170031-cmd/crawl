// Dedicated public routes for the isolated study store. No legacy task fallback.
const family=path=>path==='/api/game-study-tasks'||path==='/api/game-study-profile'||path.startsWith('/api/game-study-tasks/');
const messages={STUDY_SERVICE_HELD:'联网学习尚未完成正式入口验收，当前未启动任务。',STUDY_SERVICE_INPUT_INVALID:'请选择目标游戏和联网视频，不接受额外素材或路径。',STUDY_SERVICE_STOPPED:'学习执行器正在停止，请稍后重试。',STUDY_SERVICE_TASK_NOT_FOUND:'学习任务不存在。',STUDY_SERVICE_NOT_OWNER:'该任务仍由另一个执行器持有，未取消或重新执行。',STUDY_HOST_CONFIGURATION_REQUIRED:'尚未配置可用的宿主助手执行器，未开始学习。',STUDY_CURRENT_COLLECTION_REQUIRED:'没有当前游戏的有效联网查询，请先手动查询。',STUDY_ORIGINALS_REQUIRED:'当前查询没有可读原片，请先获取原片并确认费用；未自动获取。'};
export async function handleStudyHttp(req,res,url,{service,token,origin,json,body}){
 if(!family(url.pathname))return false;
 const expected=new URL(origin),hosts=new Set([expected.host,`localhost:${expected.port}`]);
 if(!hosts.has(req.headers.host)||req.headers.origin&&!new Set([origin,`http://localhost:${expected.port}`]).has(req.headers.origin)){
  json(res,403,{error:'来源不允许'});return true;
 }
 if(req.method!=='GET'&&req.headers['x-crawl-token']!==token){json(res,403,{error:'会话过期，请刷新'});return true;}
 try{
  if(url.pathname==='/api/game-study-tasks'){
   if(req.method==='GET')json(res,200,service.list(url.searchParams.has('game')?url.searchParams.get('game'):undefined));
   else if(req.method==='POST')json(res,202,await service.start(await body(req)));
   else json(res,405,{error:'操作不支持'});
   return true;
  }
  if(url.pathname==='/api/game-study-profile'){
   if(req.method!=='GET')json(res,405,{error:'操作不支持'});
   else json(res,200,service.profile({game:url.searchParams.get('game'),learning_source:url.searchParams.get('learning_source')}));
   return true;
  }
  const match=url.pathname.match(/^\/api\/game-study-tasks\/([a-f0-9-]{36})(?:\/(cancel))?$/);
  if(!match||!service.has(match[1])){json(res,404,{error:'学习任务不存在'});return true;}
  if(req.method==='GET'&&!match[2])json(res,200,service.read(match[1]));
  else if(req.method==='POST'&&match[2]==='cancel'){
   const input=await body(req);if(!input||Array.isArray(input)||Object.keys(input).length){json(res,400,{error:'取消不接受额外参数'});return true;}
   json(res,200,await service.cancel(match[1]));
  }else json(res,405,{error:'操作不支持；中断任务不会自动重试'});
 }catch(error){
  const known=Object.hasOwn(messages,error.code),code=known?error.code:'STUDY_REQUEST_FAILED';
  json(res,error.code==='STUDY_SERVICE_TASK_NOT_FOUND'?404:known?409:400,{error:known?messages[error.code]:'学习操作未完成；请检查来源、原片和执行器状态。未自动重试或付费查询。',code});
 }
 return true;
}

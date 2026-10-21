import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
// Only local, finite diagnostics cross into the UI. Do not expose subprocess
// stderr, paths, environment values or upstream response strings.
export class MediaToolsError extends Error {
 constructor(issues){
  const names=issues.map(x=>x.tool).join('、');
  super(`当前创作台后台无法运行 ${names}。请安装 FFmpeg（包含 ffmpeg 和 ffprobe），将其 bin 目录加入 PATH；保存任务后停止后台，完全退出并重开 WorkBuddy／终端，再启动创作台。没有发起新的红狐解析。`);
  this.code='MEDIA_TOOLS_UNAVAILABLE';this.issues=issues;
 }
}
export async function checkMediaTools({run=execute}={}){
 const issues=[];
 for(const tool of ['ffmpeg','ffprobe']){
  try{
   const out=await run(tool,['-version'],{timeout:5000,maxBuffer:256*1024,windowsHide:true});
   if(!new RegExp('^'+tool+' version\\s','m').test(String(out.stdout||'')+'\n'+String(out.stderr||'')))issues.push({tool,reason:'INVALID_VERSION_RESPONSE'});
  }catch(e){issues.push({tool,reason:['ENOENT','EACCES','EPERM'].includes(e?.code)?e.code:e?.killed?'TIMEOUT':'EXECUTION_FAILED'});}
 }
 if(issues.length)throw new MediaToolsError(issues);
 return {ffmpeg:true,ffprobe:true,scope:'current_backend_process',models_called:0,paid_calls:0};
}

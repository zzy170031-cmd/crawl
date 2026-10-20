// Terminal entry for an explicitly active WorkBuddy Skill session. Local only.
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {dataDir} from '../app/config.mjs';
import {workbuddyRequests,readWorkbuddyRequest,submitWorkbuddyResponse} from '../app/workbuddy-host.mjs';
export async function main(args,root=dataDir){
 const [command,kind,id,file]=args;
 if(command==='list')return {requests:workbuddyRequests(root)};
 if(command==='wait'){
  const seconds=Number(kind??45);if(!Number.isInteger(seconds)||seconds<1||seconds>45)throw Error('等待范围为1–45秒');const until=Date.now()+seconds*1000;
  do{const requests=workbuddyRequests(root);if(requests.length)return {requests};await delay(Math.min(1000,until-Date.now()));}while(Date.now()<until);return {requests:[],status:'no_pending_request'};
 }
 if(command==='request')return readWorkbuddyRequest(root,kind,id);
 if(command==='submit'){
  const path=resolve(file||''),s=lstatSync(path);if(!file||!s.isFile()||s.isSymbolicLink()||s.size>2*1024*1024)throw Error('响应文件无效');
  return submitWorkbuddyResponse(root,kind,id,JSON.parse(readFileSync(path,'utf8')));
 }
 throw Error('用法：list | wait [1–45秒] | request KIND UUID | submit KIND UUID 响应JSON文件');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}catch(e){console.error(e.code||'WorkBuddy本机任务操作失败；请检查路径、请求期限及JSON，不自动重试。');process.exitCode=1;}
}

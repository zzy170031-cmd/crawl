// Candidate-only composition. All source readers are trusted local callbacks;
// no search, resolver, download, old worker or Tencent client is imported.
import {mkdirSync,lstatSync,realpathSync,existsSync,accessSync,constants} from 'node:fs';
import {resolve,join,isAbsolute,relative,sep} from 'node:path';
import {Tasks,hash} from './tasks.mjs';
import {HostAssistant} from './host-assistant.mjs';
import {WorkbuddyHost} from './workbuddy-host.mjs';
import {createCreativeMedia} from './creative-media.mjs';
import {runCreativeCandidate} from './creative-candidate.mjs';
import {createCreativeTaskRunner,creativeTaskRequest} from './creative-task.mjs';
import {validLocalCreativeSource} from './creative-local-source.mjs';
import {verifyEvidenceFile} from './study-evidence-reader.mjs';
import {HOST_LIMITS} from './host-assistant.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
function directory(path){mkdirSync(path,{recursive:true,mode:0o700});const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())fail('CREATIVE_RUNTIME_PATH');return realpathSync(path);}
function childDirectory(root,target){const part=relative(root,resolve(target));if(!part||part==='..'||part.startsWith('..'+sep)||isAbsolute(part))fail('CREATIVE_RUNTIME_PATH');let path=root;for(const name of part.split(sep)){path=join(path,name);try{mkdirSync(path,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(path)!==path)fail('CREATIVE_RUNTIME_PATH');}return path;}
export function createCreativeRuntime({dataRoot,taskDirectory,cliPath,hostProvider='codex',python,whisperModel,isEnabled,getStudyEvidence,getSource,assets,hostFactory=options=>hostProvider==='workbuddy'?new WorkbuddyHost(options):new HostAssistant(options),mediaFactory=createCreativeMedia}={}){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||[isEnabled,getStudyEvidence,getSource,hostFactory,mediaFactory].some(f=>typeof f!=='function')||typeof assets?.read!=='function')fail('CREATIVE_RUNTIME_CONFIG');
 const root=directory(resolve(dataRoot)),folder=childDirectory(root,taskDirectory??join(root,'creative-candidate-tasks')),audits=childDirectory(root,join(folder,'audits'));
 for(const suffix of ['','-wal','-shm']){const p=join(folder,'tasks.sqlite'+suffix);if(existsSync(p)&&(lstatSync(p).isSymbolicLink()||!lstatSync(p).isFile()||realpathSync(p)!==p))fail('CREATIVE_RUNTIME_PATH');}
 const db=new Tasks(folder),queue=[],queued=new Set();let creationTail=Promise.resolve(),draining=null,activeId=null,stopped=false,closing,host,media;
 const enabled=()=>!stopped&&isEnabled()===true;
 const configured=()=>{try{if(stopped||!['codex','workbuddy'].includes(hostProvider)||typeof python!=='string'||!python.trim())return false;if(hostProvider==='workbuddy')return true;if(typeof cliPath!=='string'||!isAbsolute(cliPath)||/[\r\n\0]/.test(cliPath)||/\.(bat|cmd)$/i.test(cliPath)||typeof python!=='string'||!python.trim())return false;const s=lstatSync(cliPath);if(!s.isFile()||s.isSymbolicLink())return false;accessSync(cliPath,process.platform==='win32'?constants.R_OK:constants.R_OK|constants.X_OK);return true;}catch{return false;}};
 function dependencies(){if(!configured())fail('CREATIVE_HOST_CONFIGURATION_REQUIRED');try{host??=hostFactory({cliPath,allowedSourceRoot:root});media??=mediaFactory({dataRoot:root,python,whisperModel});if(typeof host?.json!=='function'||typeof media?.prepare!=='function')fail('CREATIVE_HOST_CONFIGURATION_REQUIRED');}catch{fail('CREATIVE_HOST_CONFIGURATION_REQUIRED');}}
 async function capture(request,signal){
  signal?.throwIfAborted();
  const study=await getStudyEvidence({game:request.game,taskId:request.study_task_id,profileVersion:request.profile_version,signal});
  const local=request.source.provider==='local_upload';
  const source=await getSource({game:request.game,mode:request.mode,...request.source,signal});
  if(!source?.row||source.row.source_id!==request.source.source_id)fail('CREATIVE_SOURCE_REQUIRED');
  let selected;
  if(local){
   if(!validLocalCreativeSource(source,request.game,request.mode))fail('CREATIVE_SOURCE_REQUIRED');
   const verified=await verifyEvidenceFile(root,source.media,{signal,maxBytes:HOST_LIMITS.source});
   if(verified.size!==source.media.size)fail('CREATIVE_ORIGINAL_REQUIRED');
   selected={row:structuredClone(source.row),origin:structuredClone(source.origin),media:structuredClone(source.media)};
  }else{
   if(!source.collection)fail('CREATIVE_SOURCE_REQUIRED');
   const asset=await assets.read(source.row);signal?.throwIfAborted();
   if(asset?.provider!=='redfox'||asset.source_id!==request.source.source_id||asset.url!==source.row.source_url||asset.current_collection_request_id!==request.source.request_id||asset.status!=='av_readable')fail('CREATIVE_ORIGINAL_REQUIRED');
   selected={row:structuredClone(source.row),collection:structuredClone(source.collection),media:{path:asset.source_path,sha256:asset.source_sha256,size:asset.bytes}};
  }
  // Choose only a few images actually cited by background/term observations;
  // omitted images cannot be used through the engine's evidence ID closure.
  const preferred=[...(study.profile?.draft?.background_and_loop||[]),...(study.profile?.draft?.necessary_terms||[]).map(t=>t.explanation)].flatMap(c=>(c?.references||[]).map(r=>r.id));
  const studyImageIds=[...new Set(preferred)].filter(id=>study.packet.sources.some(s=>s.id===id&&s.game===request.game&&s.kind==='video-frame')).slice(0,3);
  return {game:request.game,mode:request.mode,format:request.format,study,studyImageIds,selected};
 }
 const runner=createCreativeTaskRunner({db,
  captureInput:async request=>{if(!enabled())fail('CREATIVE_RUNTIME_HELD');dependencies();return capture(request);},
  prepareInput:async(input,ctx)=>{dependencies();input.selected.prepared=await media.prepare({record:input.selected.row,media:input.selected.media},{signal:ctx.signal,stage:ctx.stage});return input;},
  runCandidate:(input,ctx)=>{dependencies();return runCreativeCandidate(input,{host,dataRoot:root,auditDir:join(audits,ctx.taskId),signal:ctx.signal});},
  revalidateInput:async(input,ctx)=>{
   const source=input.selected.row.provider==='local_upload'?{provider:'local_upload',source_id:input.selected.row.source_id}:{provider:'redfox',request_id:input.selected.collection.request_id,source_id:input.selected.row.source_id};
   const request={game:input.game,mode:input.mode,format:input.format,study_task_id:input.study.binding.task_id,profile_version:input.study.binding.profile_version,source};
   return hash(await capture(request,ctx.signal))===hash(input);
  }
 });
 function read(id){const task=runner.read(id),lease=db.get(id).lease;return {...task,resume_required:activeId!==id&&(task.state==='queued'&&!queued.has(id)||task.state==='running'&&lease<=Date.now())};}
 const list=()=>runner.list().map(t=>read(t.id));
 function remove(id){queued.delete(id);const n=queue.indexOf(id);if(n>=0)queue.splice(n,1);}
 async function cancel(id){remove(id);await runner.cancel(id);return read(id);}
 function pump(){
  if(draining||stopped)return;draining=Promise.resolve().then(async()=>{while(queue.length&&!stopped){const id=queue.shift();queued.delete(id);if(!enabled())continue;activeId=id;try{await runner.run(id);}catch{}finally{activeId=null;}}}).finally(()=>{draining=null;if(queue.length&&!stopped)pump();});draining.catch(()=>{});
 }
 async function start(value){
  const request=creativeTaskRequest(value);if(!enabled())fail(stopped?'CREATIVE_RUNTIME_STOPPED':'CREATIVE_RUNTIME_HELD');
  const operation=creationTail.then(async()=>{
   if(!enabled())fail(stopped?'CREATIVE_RUNTIME_STOPPED':'CREATIVE_RUNTIME_HELD');let task=await runner.create(request);
   if(task.state==='running'&&task.cancelled&&activeId!==task.id&&db.get(task.id).lease<=Date.now())task=await runner.cancel(task.id);
   if(stopped){await runner.cancel(task.id);fail('CREATIVE_RUNTIME_STOPPED');}if(!enabled())fail('CREATIVE_RUNTIME_HELD');
   if(!task.cancelled&&['queued','running'].includes(task.state)&&!queued.has(task.id)&&activeId!==task.id){queued.add(task.id);queue.push(task.id);pump();}return read(task.id);
  });creationTail=operation.catch(()=>{});return operation;
 }
 async function idle(){for(;;){const tail=creationTail;await tail;const work=draining;if(work)await work.catch(()=>{});if(tail===creationTail&&!draining)return;}}
 function close(){if(!closing){stopped=true;closing=(async()=>{try{for(const id of [...queue])await cancel(id).catch(()=>{});if(activeId)await cancel(activeId).catch(()=>{});await creationTail;await idle();}finally{db.close();}})();}return closing;}
 return {start,read,list,cancel,idle,close,configured,readVerified:(id,options)=>runner.readVerified(id,options)};
}

// Explicit network-learning candidate runtime. This owns a separate task DB;
// the caller owns freshness policy, feature enablement and source credentials.
import {constants,accessSync,lstatSync,realpathSync,mkdirSync,existsSync} from 'node:fs';
import {isAbsolute,resolve,join} from 'node:path';
import {Tasks,hash} from './tasks.mjs';
import {buildGameStudyLibrary} from './game-study-library.mjs';
import {createStudyMedia} from './study-media.mjs';
import {createStudyPacketBuilder} from './study-packet.mjs';
import {createStudyReferenceReader} from './study-references.mjs';
import {createStudyService} from './study-service.mjs';
import {HostAssistant} from './host-assistant.mjs';
import {runGameStudy} from './game-study.mjs';
import {createStudyEvidenceReader} from './study-evidence-reader.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
function safeDirectory(path){mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)fail('STUDY_RUNTIME_PATH_INVALID');return path;}
function canonicalRoot(path){
 // System aliases may occur in ancestors (macOS /tmp -> /private/tmp).
 // The caller's leaf must still be a real directory, never a symlink.
 mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink())fail('STUDY_RUNTIME_PATH_INVALID');
 return realpathSync(path);
}
export function createNetworkStudyRuntime({dataRoot,getCurrentCollection,readCapturedCollection,assets,python,whisperModel,cliPath,isEnabled,readReferences,hostFactory=options=>new HostAssistant(options),mediaFactory=createStudyMedia}={}){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||[getCurrentCollection,readCapturedCollection,isEnabled,hostFactory,mediaFactory].some(f=>typeof f!=='function')||typeof assets?.read!=='function'||readReferences!==undefined&&typeof readReferences!=='function')fail('STUDY_RUNTIME_CONFIG_INVALID');
 const root=canonicalRoot(resolve(dataRoot)),folder=safeDirectory(join(root,'game-study-tasks')),audits=safeDirectory(join(folder,'audits'));
 for(const suffix of ['','-wal','-shm']){const path=join(folder,'tasks.sqlite'+suffix);if(existsSync(path)&&(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||realpathSync(path)!==path))fail('STUDY_RUNTIME_PATH_INVALID');}
 const db=new Tasks(folder);let host,media,closed=false,closing;
 const configured=()=>{
  if(closed||typeof cliPath!=='string'||!isAbsolute(cliPath)||/[\r\n\0]/.test(cliPath)||/\.(bat|cmd)$/i.test(cliPath)||typeof python!=='string'||!python.trim())return false;
  try{const file=lstatSync(cliPath);if(!file.isFile()||file.isSymbolicLink())return false;accessSync(cliPath,process.platform==='win32'?constants.R_OK:constants.R_OK|constants.X_OK);return true;}catch{return false;}
 };
 function dependencies(){
  if(!configured())fail('STUDY_HOST_CONFIGURATION_REQUIRED');
  try{
   if(!host)host=hostFactory({cliPath,allowedSourceRoot:root});
   if(typeof host?.json!=='function')fail('STUDY_HOST_CONFIGURATION_REQUIRED');
   if(!media)media=mediaFactory({dataRoot:root,python,whisperModel});
   if(typeof media?.prepare!=='function')fail('STUDY_HOST_CONFIGURATION_REQUIRED');
  }catch{fail('STUDY_HOST_CONFIGURATION_REQUIRED');}
 }
 const builder=createStudyPacketBuilder({
  prepareMedia:(item,options)=>{dependencies();return media.prepare(item,options);},
  readReferences:readReferences??createStudyReferenceReader({dataRoot:root})
 });
 const service=createStudyService({
  db,canStart:()=>!closed&&isEnabled()===true,
  captureInput:async input=>{
   if(isEnabled()!==true)fail('STUDY_SERVICE_HELD');
   dependencies();
   let collection;
   try{collection=await getCurrentCollection(input.game);}catch{fail('STUDY_CURRENT_COLLECTION_REQUIRED');}
   if(!collection)fail('STUDY_CURRENT_COLLECTION_REQUIRED');
   const library=await buildGameStudyLibrary({game:input.game,collection,uploads:[],readOnline:r=>assets.read(r)});
   if(!library.coverage.available_originals)fail('STUDY_ORIGINALS_REQUIRED');
   return library;
  },
  preparePacket:builder.preparePacket,
  revalidateInput:async(library,ctx)=>{
   ctx.signal?.throwIfAborted();
   const collection=await readCapturedCollection(ctx.game,library.binding.collection.collection_request_id);
   ctx.signal?.throwIfAborted();
   const available=new Set(library.records.filter(r=>r.availability==='available').flatMap(r=>r.origins.map(o=>o.source_id)));
   const replay=await buildGameStudyLibrary({game:ctx.game,collection,uploads:[],signal:ctx.signal,readOnline:r=>available.has(r.source_id)?assets.read(r):null});
   return hash(replay)===hash(library);
  },
  runStudy:(packet,ctx)=>{
   dependencies();
   if(!/^[a-f0-9-]{36}$/.test(ctx.taskId))fail('STUDY_RUNTIME_TASK_INVALID');
   return runGameStudy(packet,{...ctx,host,auditDir:join(audits,ctx.taskId)});
  }
 });
 function close(){if(!closing){closing=(async()=>{try{await service.stop();}finally{closed=true;db.close();}})();}return closing;}
 // Trusted internal consumer only; the HTTP projection never returns packets,
 // audit receipts or filesystem paths from this fixed-version reader.
 const evidence=createStudyEvidenceReader({db,dataRoot:root});
 return {...service,configured,close,readEvidence:input=>evidence.read(input)};
}

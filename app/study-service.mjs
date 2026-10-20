// Explicit-start FIFO for an isolated candidate Tasks store. No startup scan,
// polling-triggered inference, retries, or production gate configuration.
import {createStudyTaskRunner,STUDY_TASK_PIPELINE} from './study-task.mjs';
import {normalizeLocalGame} from './local-videos.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
function input(value){
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='game,learning_source'||value.learning_source!=='network')fail('STUDY_SERVICE_INPUT_INVALID');
 return {game:normalizeLocalGame(value.game),learning_source:'network'};
}
const tagged=(task,resume_required)=>({...task,task_store:'game-study',resume_required});
export function createStudyService({db,captureInput,preparePacket,runStudy,revalidateInput,canStart}={}){
 if(typeof canStart!=='function'||typeof revalidateInput!=='function')fail('STUDY_SERVICE_CONFIG_INVALID');
 const owners=new Map();
 const runner=createStudyTaskRunner({db,captureInput,preparePacket,runStudy,revalidateInput:async(lib,ctx)=>{
  owners.set(ctx.taskId,ctx.taskOwner);return revalidateInput(lib,ctx);
 }});
 const queue=[],queued=new Set();
 let stopped=false,creationTail=Promise.resolve(),draining=null,activeId=null,stopPromise=null;
 const allowed=()=>canStart()===true;
 function has(id){
  if(typeof id!=='string')return false;
  const t=db.get(id);return Boolean(t?.type==='learn'&&t.payload?.learning_pipeline===STUDY_TASK_PIPELINE&&t.payload?.learning_source==='network');
 }
 function read(id){
  if(!has(id))fail('STUDY_SERVICE_TASK_NOT_FOUND');
  const task=runner.read(id),lease=db.get(id).lease;
  const resumeRequired=activeId!==id&&(task.state==='queued'&&!queued.has(id)||task.state==='running'&&lease<=Date.now());
  return tagged(task,resumeRequired);
 }
 function list(game){
  const normalized=game===undefined?null:normalizeLocalGame(game);
  return db.db.prepare(`SELECT id FROM tasks WHERE type=? AND json_valid(payload)
   AND json_extract(payload,'$.learning_pipeline')=? AND json_extract(payload,'$.learning_source')=?
   ${normalized===null?'':"AND json_extract(payload,'$.game')=?"} ORDER BY updated DESC,id DESC`)
   .all('learn',STUDY_TASK_PIPELINE,'network',...(normalized===null?[]:[normalized])).map(r=>read(r.id));
 }
 const profile=value=>runner.profile(input(value));
 function removeQueued(id){queued.delete(id);const i=queue.indexOf(id);if(i!==-1)queue.splice(i,1);}
 function settleExpiredCancellation(task){
  if(task.id===activeId||task.state!=='running'||!task.cancelled||task.lease>Date.now())return false;
  return db.db.prepare("UPDATE tasks SET state='cancelled',stage=?,error=?,owner=NULL,lease=0,updated=? WHERE id=? AND state='running' AND cancelled=1 AND owner IS ? AND lease<=?")
   .run('已取消','取消后进程已结束；未重试推理',new Date().toISOString(),task.id,task.owner,Date.now()).changes===1;
 }
 async function cancelOwned(id,{quiet=false}={}){
  read(id);removeQueued(id);let waiting;
  // runner.cancel synchronously records cancellation and aborts its controller.
  // Hold the DB transaction around that synchronous part to exclude owner races.
  db.transaction(()=>{
   const task=db.get(id);
   if(settleExpiredCancellation(task))return;
   if(['completed','completed_with_warnings','cancelled','failed','needs_input'].includes(task.state))return;
   if(task.owner!==null&&(id!==activeId||task.owner!==owners.get(id))){
    if(!quiet)fail('STUDY_SERVICE_NOT_OWNER');return;
   }
   waiting=runner.cancel(id);
  });
  if(waiting)await waiting;
  return read(id);
 }
 function pump(){
  if(draining||stopped)return;
  draining=Promise.resolve().then(async()=>{
   while(queue.length&&!stopped){
    const id=queue.shift();queued.delete(id);
    // Closing the trusted gate drops only this in-memory dispatch. The queued
    // task is preserved and needs a later explicit start; reads cannot resume it.
    if(!allowed())continue;
    const task=read(id);
    if(task.cancelled||!['queued','running'].includes(task.state))continue;
    activeId=id;
    try{await runner.run(id);}catch{
     // Preserve the runner's persisted state. Do not retry a claim/lease error
     // and never publish a raw exception through the public task DTO.
    }finally{owners.delete(id);activeId=null;}
   }
  }).finally(()=>{draining=null;if(queue.length&&!stopped)pump();});
  // A throwing trusted gate must not poison the queue or become an unhandled
  // rejection. It also must not cause a retry of the task already removed.
  draining.catch(()=>{});
 }
 async function start(value){
  const captured=input(value);
  if(stopped)fail('STUDY_SERVICE_STOPPED');
  if(!allowed())fail('STUDY_SERVICE_HELD');
  const operation=creationTail.then(async()=>{
   if(stopped)fail('STUDY_SERVICE_STOPPED');
   if(!allowed())fail('STUDY_SERVICE_HELD');
   let task=await runner.create(captured);
   db.transaction(()=>settleExpiredCancellation(db.get(task.id)));
   task=runner.read(task.id);
   if(stopped){await cancelOwned(task.id,{quiet:true});fail('STUDY_SERVICE_STOPPED');}
   if(!allowed())fail('STUDY_SERVICE_HELD');
   if(!task.cancelled&&['queued','running'].includes(task.state)&&!queued.has(task.id)&&activeId!==task.id){queue.push(task.id);queued.add(task.id);pump();}
   return read(task.id);
  });
  creationTail=operation.catch(()=>{});
  return operation;
 }
 async function idle(){
  while(true){const creation=creationTail;await creation;const running=draining;if(running)await running.catch(()=>{});if(creation===creationTail&&!draining)return;}
 }
 function stop(){
  if(stopPromise)return stopPromise;
  stopped=true;
  stopPromise=(async()=>{
   const pending=[...queue];for(const id of pending)await cancelOwned(id,{quiet:true});
   if(activeId)await cancelOwned(activeId,{quiet:true});
   await creationTail;await idle();
  })();
  return stopPromise;
 }
 return {start,read,has,list,profile,cancel:id=>cancelOwned(id),idle,stop};
}

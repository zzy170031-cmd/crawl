import {randomUUID} from 'node:crypto';
import {hash} from './tasks.mjs';
import {replayRedfoxGameResult} from './redfox-game-source.mjs';
import {replayRedfoxHotspotResult} from './redfox-hotspot-source.mjs';
import {parseRedfoxMediaReceipt} from './redfox-media-source.mjs';
import {RedfoxSourceError} from './redfox-error.mjs';
import {RedfoxAssetError} from './redfox-assets.mjs';
import {checkMediaTools,MediaToolsError} from './media-tools.mjs';
export class MediaAcquisitionError extends Error {}
const fail=message=>{throw new MediaAcquisitionError(message);};
const missing=e=>e instanceof RedfoxAssetError && e.message.startsWith('这条视频尚未取得');
const LOCK='redfox-media-acquisition';
// This queue owns original-file acquisition only. It never runs models, searches,
// transcript review or publication. Quotes and status reads are always free.
export function createMediaAcquisition({db,bridge,assets,resolver,download,prepare=async()=>{},preflight=checkMediaTools,clock=()=>Date.now(),pollMs=750,autoStart=true}={}){
 db.db.exec(`CREATE TABLE IF NOT EXISTS media_quotes(id TEXT PRIMARY KEY,request_id TEXT,fingerprint TEXT,selection_key TEXT,scope TEXT,max_requests INTEGER,state TEXT,created_at INTEGER,expires_at INTEGER,renew INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS media_items(quote_id TEXT,source_id TEXT,row_json TEXT,state TEXT,attempts INTEGER DEFAULT 0,receipt TEXT,error TEXT,owner TEXT,lease INTEGER DEFAULT 0,PRIMARY KEY(quote_id,source_id));`);
 if(!db.db.prepare('PRAGMA table_info(media_quotes)').all().some(column=>column.name==='renew')) db.db.exec('ALTER TABLE media_quotes ADD COLUMN renew INTEGER DEFAULT 0');
 const owner=randomUUID();let active=null,stopped=false,loop=null;
 const at=()=>Number(clock());
 const qget=id=>db.db.prepare('SELECT * FROM media_quotes WHERE id=?').get(id);
 const items=id=>db.db.prepare('SELECT * FROM media_items WHERE quote_id=? ORDER BY rowid').all(id);
 function sourceRows(requestId){
  const r=bridge.get(requestId);
  if(!r||r.kind!=='search'||r.task_id!=null||r.state!=='fulfilled'||r.payload?.provider!=='redfox'||!['game-research','hotspots'].includes(r.payload.purpose))fail('请先完成对应游戏或热门榜查询，再获取原片');
  let rebuilt;
  try{rebuilt=bridge.validate(r,(r.payload.purpose==='hotspots'?replayRedfoxHotspotResult:replayRedfoxGameResult)(r.result,r.payload));if(hash(rebuilt)!==hash(r.result))throw Error();}catch{fail('来源回执不一致，未发起原片获取');}
  return {request:r,result:rebuilt};
 }
 function status(id){
  const q=qget(id);if(!q)fail('原片获取任务不存在');
  const rows=items(id),counts={ready:0,reused:0,cached:0,queued:0,running:0,failed:0,blocked:0,cancelled:0,interrupted:0};
  for(const r of rows)counts[r.state]=(counts[r.state]||0)+1;
  const state=q.state==='started' ? counts.running?'running':counts.queued||counts.cached?'queued':counts.failed||counts.blocked||counts.interrupted?'partial':'completed':q.state;
  return {id:q.id,request_id:q.request_id,scope:JSON.parse(q.scope),state,expires_at:new Date(q.expires_at).toISOString(),
   max_requests:q.max_requests,max_points:q.max_requests*6/10,max_cny:q.max_requests*6/100,
   attempted_requests:rows.reduce((n,r)=>n+r.attempts,0),counts,
   items:rows.map(r=>({source_id:r.source_id,title:JSON.parse(r.row_json).title,state:r.state,attempts:r.attempts,error:r.error||null,has_saved_receipt:Boolean(r.receipt)})),
   price_note:'按当前每次解析0.6积分估算上限，实际扣费以红狐账单为准；不含作品搜索费用'};
 }
 async function quote({request_id,source_ids,renew=false}={}){
  const {request,result}=sourceRows(request_id);
  const ids=source_ids??result.records.slice(0,30).map(r=>r.source_id);
  if(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))fail('请选择1至30个不重复的真实视频');
  if(typeof renew!=='boolean')fail('重新解析选项无效');
  const rows=ids.map(id=>result.records.find(r=>r.source_id===id));if(rows.some(r=>!r||r.kind!=='video'))fail('所选视频不属于该查询批次');
  const fingerprint=hash(result),selectionKey=hash({request_id,ids:[...ids].sort(),renew});
  const inFlight=db.db.prepare("SELECT id FROM media_quotes WHERE selection_key=? AND state='started' ORDER BY created_at DESC").all(selectionKey).find(r=>['queued','running'].includes(status(r.id).state));
  if(inFlight)return status(inFlight.id);
  const planned=[];
  for(const row of rows){
   let state='queued',error=null,receipt=null;
   try{await assets.read(row);state='cached';}catch(e){if(!missing(e)){state='blocked';error='已保存原片校验失败，未覆盖或重复收费';}}
   if(state==='queued'&&!row.title?.trim()){state='blocked';error='来源未提供标题，无法核对解析身份，未收费';}
   if(state==='queued'&&!renew){
    const old=db.db.prepare('SELECT receipt FROM media_items WHERE source_id=? AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(row.source_id);
    if(old)receipt=old.receipt;
   }
   planned.push({row,state,error,receipt});
  }
  // Starting the webpage is not dependency acceptance. Verify binaries in the
  // same Node process before creating a quote that could authorize payment.
  if(planned.some(r=>['queued','cached'].includes(r.state)))await preflight();
  const id=randomUUID(),budget=planned.filter(r=>r.state==='queued'&&!r.receipt).length;
  db.transaction(()=>{
   db.db.prepare('INSERT INTO media_quotes(id,request_id,fingerprint,selection_key,scope,max_requests,state,created_at,expires_at,renew) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,request_id,fingerprint,selectionKey,JSON.stringify({game:result.observed_scope.keyword||null,purpose:request.payload.purpose,category:result.observed_scope.category||null,board:request.payload.board||null,start_date:result.observed_scope.start_date,end_date:result.observed_scope.end_date,collected_at:result.searched_at}),budget,'quoted',at(),at()+15*60000,renew?1:0);
   for(const r of planned)db.db.prepare('INSERT INTO media_items(quote_id,source_id,row_json,state,receipt,error) VALUES(?,?,?,?,?,?)').run(id,r.row.source_id,JSON.stringify(r.row),r.state,r.receipt,r.error);
  });return status(id);
 }
 function start({quote_id,user_initiated,max_requests}={}){
  const q=qget(quote_id);if(!q)fail('预算确认已失效，请重新查看原片费用');
  if(user_initiated!==true||max_requests!==q.max_requests)fail('请明确确认此次原片解析次数和费用');
  if(q.state==='started')return status(q.id);
  if(q.state!=='quoted'||at()>q.expires_at)fail('预算确认已失效，请重新查看原片费用');
  if(hash(sourceRows(q.request_id).result)!==q.fingerprint)fail('来源批次已变化，请重新确认');
  // The 15-minute quote confirmation window must not truncate an already
  // approved multi-video batch. Keep an execution deadline proportional to
  // its fixed size (30 items maximum), without extending its monetary cap.
  const executionDeadline=at()+Math.max(15*60000,items(q.id).length*6*60000);
  db.db.prepare("UPDATE media_quotes SET state='started',expires_at=? WHERE id=? AND state='quoted'").run(executionDeadline,q.id);
  kick();return status(q.id);
 }
 function cancel(id){
  if(!qget(id))fail('原片获取任务不存在');
  db.transaction(()=>{db.db.prepare("UPDATE media_quotes SET state='cancelled' WHERE id=?").run(id);db.db.prepare("UPDATE media_items SET state='cancelled',error='用户取消，未继续调用' WHERE quote_id=? AND state IN ('queued','cached')").run(id);});
  if(active?.quote_id===id)active.controller.abort(Error('cancelled'));return status(id);
 }
 function finish(item,state,error=null){db.db.prepare('UPDATE media_items SET state=?,error=?,owner=NULL,lease=0 WHERE quote_id=? AND source_id=? AND owner=?').run(state,error,item.quote_id,item.source_id,owner);}
 async function execute(item){
  const row=JSON.parse(item.row_json),controller=new AbortController();active={...item,controller};let cleanup;
  const renewLease=()=>{
   if(stopped||qget(item.quote_id)?.state!=='started'||!db.lock(LOCK,owner,30000)){controller.abort(Error('interrupted'));return;}
   const changed=db.db.prepare("UPDATE media_items SET lease=? WHERE quote_id=? AND source_id=? AND owner=? AND state='running'").run(at()+30000,item.quote_id,item.source_id,owner).changes;
   if(!changed)controller.abort(Error('interrupted'));
  };
  const heartbeat=setInterval(renewLease,1000);
  try {
   // Recheck after approval in case availability changed. Failure here is
   // terminal and must precede any new resolver request or download.
   await preflight();controller.signal.throwIfAborted();
   let asset;
   try{asset=await assets.read(row);}catch(e){if(!missing(e))throw e;}
   controller.signal.throwIfAborted();
   if(asset){await prepare(row,{signal:controller.signal});controller.signal.throwIfAborted();finish(item,'reused');return;}
   const q=qget(item.quote_id);if(at()>q.expires_at)throw new MediaAcquisitionError('本批执行时限已到，剩余原片未调用；请重新确认预算');
   if(hash(sourceRows(q.request_id).result)!==q.fingerprint)throw new MediaAcquisitionError('来源回执发生变化，未继续调用');
   const latestReceipt = !q.renew && !item.receipt ? db.db.prepare('SELECT receipt FROM media_items WHERE source_id=? AND receipt IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(row.source_id)?.receipt : null;
   let receipt=item.receipt||latestReceipt ? JSON.parse(item.receipt||latestReceipt) : null;
   if(latestReceipt) db.db.prepare('UPDATE media_items SET receipt=? WHERE quote_id=? AND source_id=? AND owner=?').run(latestReceipt,item.quote_id,item.source_id,owner);
   if(!receipt){
    const claimed=db.transaction(()=>{
     const fresh=qget(item.quote_id),used=items(item.quote_id).reduce((n,r)=>n+r.attempts,0);
     if(fresh.state!=='started'||used>=fresh.max_requests||at()>fresh.expires_at)return false;
     return db.db.prepare("UPDATE media_items SET attempts=1 WHERE quote_id=? AND source_id=? AND owner=? AND state='running' AND attempts=0").run(item.quote_id,item.source_id,owner).changes===1;
    });if(!claimed)throw new MediaAcquisitionError('已达到预算或请求已经尝试，未重复调用');
    receipt=await resolver.resolve(row,{userInitiated:true,maxRequests:1,signal:controller.signal,onReceipt:raw=>{
      db.db.prepare('UPDATE media_items SET receipt=? WHERE quote_id=? AND source_id=? AND owner=?').run(JSON.stringify(raw),item.quote_id,item.source_id,owner);
    }});
    controller.signal.throwIfAborted();
    db.db.prepare('UPDATE media_items SET receipt=? WHERE quote_id=? AND source_id=? AND owner=?').run(JSON.stringify(receipt),item.quote_id,item.source_id,owner);
   }
   if(receipt?.status==='unvalidated'){
    if(receipt.source_id!==row.source_id||receipt.source_url!==row.source_url) throw new MediaAcquisitionError('解析回执作品身份不一致，未下载');
    receipt=parseRedfoxMediaReceipt(receipt.response,row,{startedAt:receipt.started_at,receivedAt:receipt.received_at});
    db.db.prepare('UPDATE media_items SET receipt=? WHERE quote_id=? AND source_id=? AND owner=?').run(JSON.stringify(receipt),item.quote_id,item.source_id,owner);
   }
   const file=await download(row,receipt,{signal:controller.signal});cleanup=file.cleanup;
   controller.signal.throwIfAborted();
   await assets.importLocal(row,{sourcePath:file.sourcePath,response:receipt.response,startedAt:receipt.started_at,receivedAt:receipt.received_at,signal:controller.signal});
   await prepare(row,{signal:controller.signal});controller.signal.throwIfAborted();finish(item,'ready');
  } catch(e){
   const cancelled=controller.signal.aborted;
   const message=cancelled?'已停止，已尝试的解析可能计费，未自动重试':e instanceof MediaAcquisitionError||e instanceof RedfoxSourceError||e instanceof RedfoxAssetError||e instanceof MediaToolsError?String(e.message).slice(0,500):'原片获取未完成；未自动重试或重新解析，请查看状态后手动处理';
   finish(item,cancelled?(stopped?'interrupted':'cancelled'):'failed',message);
  } finally{clearInterval(heartbeat);await cleanup?.().catch(()=>{});active=null;}
 }
 async function tick(){
  if(stopped||active||loop)return;
  if(!db.lock(LOCK,owner,30000))return;
  loop=(async()=>{
   try{
    db.db.prepare("UPDATE media_items SET state='interrupted',owner=NULL,lease=0,error='服务中断，未自动重放解析请求' WHERE state='running' AND lease<?").run(at());
    const candidate=db.db.prepare("SELECT i.* FROM media_items i JOIN media_quotes q ON q.id=i.quote_id WHERE q.state='started' AND i.state IN ('queued','cached') AND i.attempts=0 ORDER BY q.created_at,i.rowid LIMIT 1").get();
    if(!candidate)return;
    const claimed=db.transaction(()=>db.db.prepare("UPDATE media_items SET state='running',owner=?,lease=? WHERE quote_id=? AND source_id=? AND state IN ('queued','cached') AND attempts=0").run(owner,at()+30000,candidate.quote_id,candidate.source_id).changes===1);
    if(claimed)await execute(candidate);
   }finally{db.unlock(LOCK,owner);}
  })();try{await loop;}finally{loop=null;}
 }
 function kick(){if(autoStart)queueMicrotask(()=>tick().catch(()=>{}));}
 const timer=autoStart?setInterval(()=>tick().catch(()=>{}),pollMs):null;
 return {quote,start,cancel,status,tick,list:()=>db.db.prepare("SELECT id FROM media_quotes WHERE state!='quoted' ORDER BY created_at DESC LIMIT 30").all().map(q=>status(q.id)),
  stop(){stopped=true;clearInterval(timer);active?.controller.abort(Error('service stopped'));return loop||Promise.resolve();}};
}

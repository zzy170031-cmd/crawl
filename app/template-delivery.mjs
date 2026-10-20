// Four named templates, frozen append regions, explicit approval only. Neither
// this service nor a restart dispatches an uncertain operation a second time.
import {randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Tasks,hash} from './tasks.mjs';
import {CREATIVE_TASK_PIPELINE} from './creative-task.mjs';
import {destination,resolveDestination} from './delivery.mjs';
import {TencentClient} from './tencent-client.mjs';
import {verifyTemplateRegion} from './template-verify.mjs';
export const TEMPLATE_DELIVERY_VERSION='four-template-delivery-1';
export const TEMPLATE_HEADERS=Object.freeze({
 overview:{name:'创作总览',headers:['链路','目标游戏','创作方式','当前状态','内容交付','来源核验','备注']},
 A:{name:'A游戏视频改编',headers:['策划环节','完整创作内容','游戏结合与素材','制作说明']},
 B:{name:'B热点联动策划',headers:['策划环节','完整创作内容','游戏结合与素材','制作说明']},
 sources:{name:'来源与核验',headers:['来源ID','目标游戏','用途','原片链接','媒体状态','抽帧范围','语音状态','字幕术语复核','事实边界']},
});
const fail=c=>{throw Object.assign(Error(c),{code:c});},clone=structuredClone,now=()=>new Date().toISOString();
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const planKey=id=>`template:${id}:plan`,receiptKey=id=>`template:${id}:receipt`;
const READ=new Set(['sheet_get_sheet_info','sheet_get_cell_data','manage_query_file_info','manage_export_file','manage_export_progress']);
const WRITE=new Set(['sheet_add_sheet','sheet_set_range_value','sheet_set_link']);
const boundary='固定候选草稿按模板交付；不是游戏事实、完整视听或成片质量认证。本地租约不能锁定腾讯用户编辑；冲突停写，不覆盖或自动重试。';
function strictKeys(v,keys){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');}
function request(v){if(!strictKeys(v,['task_id','result_version','draft_sha256'])||!UUID.test(v.task_id)||!SHA.test(v.result_version)||!SHA.test(v.draft_sha256))fail('TEMPLATE_DELIVERY_INPUT');return clone(v);}
function target(v){try{return destination(v);}catch{fail('TEMPLATE_DELIVERY_TARGET');}}
function candidate(t,q){
 const r=t?.result,without=clone(r||{});delete without.result_version;
 if(t?.id!==q.task_id||t.state!=='completed'||t.type!=='creative-candidate'||t.cancelled||t.payload?.creative_pipeline!==CREATIVE_TASK_PIPELINE||r?.version!==CREATIVE_TASK_PIPELINE||r.status!=='needs_review'||r.accepted!==false||r.ready!==false||r.delivery_enabled!==false||r.result_version!==q.result_version||hash(without)!==q.result_version||r.draft_sha256!==q.draft_sha256||!r.draft||hash(r.draft)!==q.draft_sha256||!['A','B'].includes(r.mode)||!['video','image'].includes(r.format)||typeof r.game!=='string'||r.binding?.game!==r.game||r.binding?.mode!==r.mode||r.binding?.format!==r.format||!Array.isArray(r.plan?.blocking_gaps)||r.plan.blocking_gaps.length||['unsuitable','insufficient'].includes(r.plan.fit))fail('TEMPLATE_DELIVERY_CANDIDATE_INVALID');
 const d=r.draft;
 if(!Array.isArray(d.rows)||d.rows.length<2||d.rows.length>180||d.rows.some(row=>!Array.isArray(row)||row.length!==4||row.some(v=>typeof v!=='string'||v.length>100000))||hash(d.rows[0])!==hash(TEMPLATE_HEADERS.A.headers)||!Array.isArray(d.links)||d.links.length>100)fail('TEMPLATE_DELIVERY_DRAFT_INVALID');
 const seen=new Set();for(const l of d.links){let u;try{u=new URL(l.url);}catch{fail('TEMPLATE_DELIVERY_DRAFT_INVALID');}if(!Number.isInteger(l.row)||l.row<1||l.row>=d.rows.length||!Number.isInteger(l.col)||l.col<0||l.col>=4||u.protocol!=='https:'||u.username||u.password||seen.has(`${l.row}:${l.col}`)||d.rows[l.row][l.col]!==l.url)fail('TEMPLATE_DELIVERY_DRAFT_INVALID');seen.add(`${l.row}:${l.col}`);}
 return r;
}
// Only public string/rich-string values and explicit protobuf empty defaults.
function cellValue(c){
 if(!c)return '';
 if(![undefined,null,''].includes(c.formula))fail('TEMPLATE_DELIVERY_CELL_TYPE');
 if(['STRING','RICH_STRING'].includes(c.value_type)){
  if(typeof c.string_value!=='string'||![undefined,null,0].includes(c.number_value)||![undefined,null,false].includes(c.bool_value))fail('TEMPLATE_DELIVERY_CELL_TYPE');return c.string_value;
 }
 if([undefined,''].includes(c.value_type)&&[undefined,''].includes(c.string_value)&&[undefined,0].includes(c.number_value)&&[undefined,false].includes(c.bool_value))return '';
 if(c.value_type===undefined&&typeof c.string_value==='string'&&c.number_value===undefined&&c.bool_value===undefined)return c.string_value;
 fail('TEMPLATE_DELIVERY_CELL_TYPE');
}
const linkValue=c=>c?.hyperlink?.url??c?.link?.url??c?.hyperlink??c?.link;
function responseOK(v){if(!v||![undefined,null,''].includes(v.error))fail('TEMPLATE_DELIVERY_PROVIDER_RESPONSE');}
async function info(call,file){const v=await call('sheet_get_sheet_info',{file_id:file});responseOK(v);if(!Array.isArray(v.sheets))fail('TEMPLATE_DELIVERY_PROVIDER_RESPONSE');return v.sheets;}
async function snapshot(call,file,sheet){
 if(typeof sheet.sheet_id!=='string'||!sheet.sheet_id||!Number.isInteger(sheet.row_count)||sheet.row_count<1||sheet.row_count>2000||!Number.isInteger(sheet.col_count)||sheet.col_count<4||sheet.col_count>26)fail('TEMPLATE_DELIVERY_SHEET_LIMIT');
 const cells=[];
 for(let row=0;row<sheet.row_count;row+=100){const end=Math.min(row+99,sheet.row_count-1),v=await call('sheet_get_cell_data',{file_id:file,sheet_id:sheet.sheet_id,start_row:row,end_row:end,start_col:0,end_col:sheet.col_count-1,return_csv:false});responseOK(v);if(!Array.isArray(v.cells))fail('TEMPLATE_DELIVERY_PROVIDER_RESPONSE');const seen=new Set();
  for(const c of v.cells){if(!c||!Number.isInteger(c.row)||c.row<row||c.row>end||!Number.isInteger(c.col)||c.col<0||c.col>=sheet.col_count||seen.has(`${c.row}:${c.col}`))fail('TEMPLATE_DELIVERY_PROVIDER_RESPONSE');seen.add(`${c.row}:${c.col}`);const value=cellValue(c),url=linkValue(c);if(url!==undefined&&url!==null&&typeof url!=='string')fail('TEMPLATE_DELIVERY_PROVIDER_RESPONSE');if(value!==''||url)cells.push({row:c.row,col:c.col,text:value,...(url?{url}:{})});}
 }
 cells.sort((a,b)=>a.row-b.row||a.col-b.col);return {sheet_id:sheet.sheet_id,name:sheet.sheet_name,row_count:sheet.row_count,col_count:sheet.col_count,cells};
}
async function templates(call,file){const sheets=await info(call,file),result={};for(const [role,spec]of Object.entries(TEMPLATE_HEADERS)){const found=sheets.filter(s=>s.sheet_name===spec.name);if(found.length>1)fail('TEMPLATE_DELIVERY_TEMPLATE_AMBIGUOUS');if(!found.length){result[role]=null;continue;}const s=await snapshot(call,file,found[0]);if(s.col_count<spec.headers.length||spec.headers.some((v,col)=>s.cells.find(c=>c.row===0&&c.col===col)?.text!==v)||s.cells.some(c=>c.row===0&&c.col>=spec.headers.length))fail('TEMPLATE_DELIVERY_TEMPLATE_HEADERS');result[role]=s;}return result;}
function endRow(s){return s?Math.max(0,...s.cells.map(c=>c.row))+1:1;}
function overviewStart(s,r,placeholders){if(!s)return {start:1,replace:false};const matches=[];for(let row=1;row<endRow(s);row++){const values=Array.from({length:7},(_,col)=>s.cells.find(c=>c.row===row&&c.col===col)?.text||'');if(values[0]===r.mode&&values[1]===r.game&&placeholders.some(p=>hash(p)===hash(values))&&!s.cells.some(c=>c.row===row&&(c.col>=7||c.url)))matches.push(row);}if(matches.length>1)fail('TEMPLATE_DELIVERY_PLACEHOLDER_AMBIGUOUS');return matches.length?{start:matches[0],replace:true}:{start:endRow(s),replace:false};}
function layout(r,q,base,placeholders){
 const main=r.mode,mainStart=endRow(base[main]),sourceStart=endRow(base.sources),o=overviewStart(base.overview,r,placeholders),titles=(r.plan.ideas||[]).map(i=>i.title).filter(x=>typeof x==='string').join(' / ')||'固定创作候选';
 const ref=`task=${q.task_id}\nresult=${q.result_version}\ndraft=${q.draft_sha256}`;
 const sources=r.draft.links.map((l,index)=>{const selected=index===0&&r.draft.rows[l.row][0]==='热点原片',label=r.draft.rows[l.row][0];return [selected?r.binding.source_id:l.url,r.game,`${r.mode} · ${label}`,l.url,selected?'已核固定原片读取回执；非完整连续观看':'参考资料链接；本次交付未新增媒体读取认证',selected?(Array.isArray(r.coverage?.frames)?JSON.stringify(r.coverage.frames):'固定稿未提供帧时点'):'本项未新增核验，见固定稿来源说明',selected?(r.coverage?.has_audio===false?'回执标记无音轨':`机器转写未逐句核听；状态=${r.coverage?.speech||'未知'}`):'本项未新增核验，见固定稿来源说明',selected?'字幕/ASR差异见固定稿重点拆解；非全量术语校对':'本项未新增字幕核验，见固定稿来源说明',`${selected?'离散抽帧；声音/音乐未读；':'参考资料范围以固定稿为准；'}${r.boundary||'候选来源，未新增核验'}\n${ref}`];});
 const routes=[{role:main,name:TEMPLATE_HEADERS[main].name,sheet_id:base[main]?.sheet_id||null,start_row:mainStart,rows:clone(r.draft.rows.slice(1)),links:r.draft.links.map(l=>({...l,row:mainStart+l.row-1})),replace:false},
 {role:'sources',name:TEMPLATE_HEADERS.sources.name,sheet_id:base.sources?.sheet_id||null,start_row:sourceStart,rows:sources,links:sources.map((row,i)=>({row:sourceStart+i,col:3,url:row[3]})),replace:false},
 {role:'overview',name:TEMPLATE_HEADERS.overview.name,sheet_id:base.overview?.sheet_id||null,start_row:o.start,rows:[[r.mode,r.game,r.format==='image'?'图文创作候选':'视频创作候选','固定稿已交付；质量仍待审阅',titles,'正文与来源表逐字/链接回读；范围见来源表',ref]],links:[],sheet_links:[{row:o.start,col:4,target_role:main},{row:o.start,col:5,target_role:'sources'}],replace:o.replace}];
 for(const route of routes){if(route.start_row+route.rows.length>(base[route.role]?.row_count||200))fail('TEMPLATE_DELIVERY_SHEET_CAPACITY');route.precondition_sha256=hash(base[route.role]);}
 return routes;
}
function bindRoutes(plan,expected){return plan.routes.map(route=>({...clone(route),sheet_id:expected[route.role].sheet_id,links:[...route.links,...(route.sheet_links||[]).map(l=>({row:l.row,col:l.col,url:`${plan.target.url}?tab=${encodeURIComponent(expected[l.target_role].sheet_id)}`}))]}));}
function regionText(snapshot,region){for(const [i,row]of region.rows.entries())for(const [col,value]of row.entries())if((snapshot.cells.find(c=>c.row===region.start_row+i&&c.col===col)?.text||'')!==value)return false;return true;}
function knownLinks(snapshot,region){for(const l of region.links){const actual=snapshot.cells.find(c=>c.row===l.row&&c.col===l.col)?.url;if(actual&&actual!==l.url)fail('TEMPLATE_DELIVERY_LINK_MISMATCH');}}
function safeError(e){return /^TEMPLATE_DELIVERY_[A-Z_]+$/.test(e?.code||'')?e.code:'TEMPLATE_DELIVERY_FAILED';}
function publicReceipt(r){if(!r)return null;const {expected,...publicValue}=r;return clone(publicValue);}
export function createTemplateDelivery({dataRoot,readCandidate,getDestination,isEnabled=()=>false,client=new TencentClient(),verify=verifyTemplateRegion,overviewPlaceholders=[],leaseMs=30000,timeoutMs=300000}={}){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||[readCandidate,getDestination,isEnabled,verify].some(f=>typeof f!=='function')||!client?.call||!Array.isArray(overviewPlaceholders)||overviewPlaceholders.some(r=>!Array.isArray(r)||r.length!==7||r.some(c=>typeof c!=='string'))||!Number.isInteger(leaseMs)||leaseMs<30||!Number.isInteger(timeoutMs)||timeoutMs<1)fail('TEMPLATE_DELIVERY_CONFIG');
 const root=resolve(dataRoot);mkdirSync(root,{recursive:true,mode:0o700});if(lstatSync(root).isSymbolicLink())fail('TEMPLATE_DELIVERY_CONFIG');const folder=join(realpathSync(root),'template-deliveries');mkdirSync(folder,{recursive:true,mode:0o700});if(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder)fail('TEMPLATE_DELIVERY_CONFIG');for(const s of ['','-wal','-shm'])try{if(!lstatSync(join(folder,'tasks.sqlite'+s)).isFile()||lstatSync(join(folder,'tasks.sqlite'+s)).isSymbolicLink())fail('TEMPLATE_DELIVERY_CONFIG');}catch(e){if(e.code!=='ENOENT')throw e;}
 const db=new Tasks(folder),active=new Map(),pending=new Set();let stopped=false;
 function task(id){const t=db.get(id);if(t?.type!=='template-delivery'||t.payload?.version!==TEMPLATE_DELIVERY_VERSION)fail('TEMPLATE_DELIVERY_NOT_FOUND');return t;}
 function plan(id){const t=task(id),p=db.checkpoint(planKey(id));if(!p||hash(p)!==t.payload.plan_sha256)fail('TEMPLATE_DELIVERY_CHECKPOINT');return p;}
 function read(id){const t=task(id),p=plan(id);return {id,version:TEMPLATE_DELIVERY_VERSION,task_store:'template-delivery',state:t.state==='writing'&&t.lease<=Date.now()?'unknown':t.state,plan_sha256:hash(p),target:p.target,candidate:{...p.request,game:p.game,mode:p.mode},routes:clone(p.routes),templates:Object.entries(p.baselines).map(([role,s])=>({role,name:TEMPLATE_HEADERS[role].name,sheet_id:s?.sheet_id||null,create:s===null,header:TEMPLATE_HEADERS[role].headers})),receipt:publicReceipt(db.checkpoint(receiptKey(id))),error:t.error,created:t.created,updated:t.updated,boundary};}
 const list=()=>db.db.prepare("SELECT id FROM tasks WHERE type='template-delivery' ORDER BY created,id").all().map(t=>read(t.id));
 function tracked(fn){if(stopped)fail('TEMPLATE_DELIVERY_CLOSED');const p=Promise.resolve().then(fn);pending.add(p);return p.catch(e=>{fail(safeError(e));}).finally(()=>pending.delete(p));}
 function ro(signal){return async(name,args)=>{signal?.throwIfAborted();if(!READ.has(name))fail('TEMPLATE_DELIVERY_TOOL_DENIED');const r=await client.call(name,args,{signal});signal?.throwIfAborted();responseOK(r);return r;};}
 async function fixed(p,signal){signal?.throwIfAborted();if(hash(target(await getDestination()))!==hash(p.target))fail('TEMPLATE_DELIVERY_TARGET_CHANGED');candidate(await readCandidate(p.request.task_id,{signal}),p.request);signal?.throwIfAborted();}
 function prepare(value,{expectedTarget}={}){const q=request(value);return tracked(async()=>{const signal=AbortSignal.timeout(timeoutMs),dest=target(await getDestination());if(expectedTarget!==undefined&&hash(target(expectedTarget))!==hash(dest))fail('TEMPLATE_DELIVERY_TARGET_CHANGED');const identity=hash({version:TEMPLATE_DELIVERY_VERSION,...q,target:dest});const prior=db.db.prepare('SELECT id FROM tasks WHERE key=?').get(identity);if(prior&&(task(prior.id).state!=='prepared'||db.checkpoint(receiptKey(prior.id))))return read(prior.id);
  const r=candidate(await readCandidate(q.task_id,{signal}),q);await resolveDestination(dest,{client:{call:(n,a)=>ro(signal)(n,a)},signal});const bases=await templates(ro(signal),dest.file_id),routes=layout(r,q,bases,overviewPlaceholders);if(hash(target(await getDestination()))!==hash(dest))fail('TEMPLATE_DELIVERY_TARGET_CHANGED');
  const p={version:TEMPLATE_DELIVERY_VERSION,request:q,target:dest,game:r.game,mode:r.mode,source_binding_sha256:hash(r.binding),draft_sha256:hash(r.draft),baselines:bases,routes,layout_sha256:hash(routes),boundary};
  const id=db.transaction(()=>{const exists=db.db.prepare('SELECT id FROM tasks WHERE key=?').get(identity);if(exists){const oldTask=task(exists.id);if(oldTask.state!=='prepared'||oldTask.owner!==null||oldTask.cancelled||db.checkpoint(receiptKey(exists.id)))return exists.id;const previous=plan(exists.id);if(hash(previous)!==hash(p)){db.checkpoint(`template:${exists.id}:plan-history:${hash(previous)}`,previous);db.checkpoint(planKey(exists.id),p);db.db.prepare('UPDATE tasks SET payload=?,updated=? WHERE id=? AND state=? AND owner IS NULL').run(JSON.stringify({version:TEMPLATE_DELIVERY_VERSION,plan_sha256:hash(p)}),now(),exists.id,'prepared');}return exists.id;}const id=randomUUID();db.db.prepare('INSERT INTO tasks(id,key,type,state,payload,stage,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,identity,'template-delivery','prepared',JSON.stringify({version:TEMPLATE_DELIVERY_VERSION,plan_sha256:hash(p)}),'模板分配待确认',now(),now());db.checkpoint(planKey(id),p);return id;});return read(id);
 });}
 function owns(id,owner,signal){signal?.throwIfAborted();const t=task(id);if(t.state!=='writing'||t.owner!==owner||t.cancelled||t.lease<=Date.now())fail('TEMPLATE_DELIVERY_OWNERSHIP_LOST');}
 function save(id,owner,signal,r){db.transaction(()=>{owns(id,owner,signal);db.checkpoint(receiptKey(id),r);});}
 function approve(value,{authorization,expectedTarget}={}){if(!strictKeys(value,['plan_id','plan_sha256'])||!UUID.test(value.plan_id)||!SHA.test(value.plan_sha256))fail('TEMPLATE_DELIVERY_INPUT');if(isEnabled()!==true)fail('TEMPLATE_DELIVERY_DISABLED');return tracked(async()=>{
  const id=value.plan_id,p=plan(id),t=task(id);if(hash(p)!==value.plan_sha256)fail('TEMPLATE_DELIVERY_PLAN_CHANGED');if(expectedTarget!==undefined&&hash(target(expectedTarget))!==hash(p.target)||hash(target(await getDestination()))!==hash(p.target))fail('TEMPLATE_DELIVERY_TARGET_CHANGED');if(t.state!=='prepared')return read(id);
  const signal=AbortSignal.timeout(timeoutMs);await fixed(p,signal);await resolveDestination(p.target,{client:{call:(n,a)=>ro(signal)(n,a)},signal});if(hash(await templates(ro(signal),p.target.file_id))!==hash(p.baselines))fail('TEMPLATE_DELIVERY_BASELINE_CHANGED');
  let grant={basis:'explicit_template_plan_confirmation',record_id:randomUUID(),plan_id:id,plan_sha256:hash(p),target:p.target,scope:'固定四表路由与显示的完整草稿；仅明确区域写入',authorized_at:now()};
  if(authorization!==undefined){if(!authorization||authorization.basis!=='existing_test_authorization_and_independent_review'||typeof authorization.record_id!=='string'||!authorization.record_id||typeof authorization.scope!=='string'||!authorization.scope||authorization.plan_id!==id||authorization.plan_sha256!==hash(p)||hash(target(authorization.target))!==hash(p.target))fail('TEMPLATE_DELIVERY_AUTHORIZATION_INVALID');grant={...grant,basis:authorization.basis,record_id:authorization.record_id,scope:authorization.scope};}
  if(stopped||isEnabled()!==true)fail('TEMPLATE_DELIVERY_DISABLED');
  const owner=randomUUID(),claimed=db.transaction(()=>{if(task(id).payload.plan_sha256!==value.plan_sha256||hash(plan(id))!==hash(p))fail('TEMPLATE_DELIVERY_PLAN_CHANGED');if(task(id).state!=='prepared')return false;for(const other of list()){if(other.id!==id&&hash(other.target)===hash(p.target)&&!['prepared','verified','blocked','cancelled'].includes(other.state))fail('TEMPLATE_DELIVERY_TARGET_BUSY');}db.db.prepare("UPDATE tasks SET state='writing',owner=?,lease=?,updated=? WHERE id=? AND state='prepared' AND owner IS NULL").run(owner,Date.now()+leaseMs,now(),id);db.checkpoint(receiptKey(id),{version:TEMPLATE_DELIVERY_VERSION,plan_sha256:hash(p),grant,operations:[],expected:clone(p.baselines),routes:[],region_verifications:[],warnings:['STYLE_NOT_CERTIFIED'],boundary});return true;});if(claimed)execute(id,owner);return read(id);
 });}
 function execute(id,owner){const p=plan(id),r=clone(db.checkpoint(receiptKey(id))),controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]),readCall=ro(signal);
  const heartbeat=setInterval(()=>{try{db.transaction(()=>{owns(id,owner,signal);db.db.prepare('UPDATE tasks SET lease=? WHERE id=? AND owner=?').run(Date.now()+leaseMs,id,owner);});}catch{controller.abort();}},Math.max(10,Math.floor(leaseMs/3)));heartbeat.unref?.();
  async function inspectExpected(){owns(id,owner,signal);await fixed(p,signal);const actual=await currentSnapshots(readCall,p,r.expected);owns(id,owner,signal);if(hash(actual)!==hash(r.expected))fail('TEMPLATE_DELIVERY_BASELINE_CHANGED');}
  async function mutate(name,args,role,change){
   if(!WRITE.has(name))fail('TEMPLATE_DELIVERY_TOOL_DENIED');if(isEnabled()!==true)fail('TEMPLATE_DELIVERY_DISABLED');await inspectExpected();owns(id,owner,signal);
   const op={sequence:r.operations.length,name,role,args_sha256:hash(args),status:'pending',started_at:now()};r.operations.push(op);save(id,owner,signal,r);
   const response=await client.call(name,args,{signal});responseOK(response);owns(id,owner,signal);op.status='responded';op.responded_at=now();if(name==='sheet_add_sheet'){if(typeof response.sheet_id!=='string'||!response.sheet_id)fail('TEMPLATE_DELIVERY_REMOTE_UNKNOWN');op.sheet_id=response.sheet_id;}save(id,owner,signal,r);
   if(name==='sheet_add_sheet'){
    const sheets=await info(readCall,p.target.file_id),matches=sheets.filter(s=>s.sheet_name===TEMPLATE_HEADERS[role].name);if(matches.length!==1||matches[0].sheet_id!==response.sheet_id)fail('TEMPLATE_DELIVERY_TEMPLATE_AMBIGUOUS');const actual=await snapshot(readCall,p.target.file_id,matches[0]);if(actual.cells.length||actual.row_count<200||actual.col_count<TEMPLATE_HEADERS[role].headers.length)fail('TEMPLATE_DELIVERY_BASELINE_CHANGED');r.expected[role]=actual;
   }else{
    const old=r.expected[role],expected=applyChange(old,change);let actual;
    for(let attempt=0;attempt<4;attempt++){actual=await snapshot(readCall,p.target.file_id,{sheet_id:old.sheet_id,sheet_name:old.name,row_count:old.row_count,col_count:old.col_count});if(compatibleAfter(actual,old,expected,change))break;if(attempt===3||!onlyMissingChange(actual,old,expected,change))fail('TEMPLATE_DELIVERY_CONTENT_MISMATCH');await delay([250,750,1500][attempt],undefined,{signal});}
    r.expected[role]=actual;
   }
   op.readback_sha256=hash(r.expected[role]);save(id,owner,signal,r);
  }
  async function verifyRegion(region){await inspectExpected();const s=r.expected[region.role];if(!regionText(s,region))fail('TEMPLATE_DELIVERY_CONTENT_MISMATCH');knownLinks(s,region);const exported=await verify({call:readCall},p.target.file_id,region.name,{start_row:region.start_row,rows:region.rows,links:region.links},signal);owns(id,owner,signal);if(exported?.content!==true||exported.links!==true)fail('TEMPLATE_DELIVERY_EXPORT_MISMATCH');await inspectExpected();r.region_verifications.push({role:region.role,rows_sha256:hash(region.rows),links_sha256:hash(region.links),start_row:region.start_row,content_verified:true,links_verified:true,verified_at:now(),method:'live_all_cells_and_bounded_export_region'});save(id,owner,signal,r);}
  const promise=(async()=>{try{
   if(r.plan_sha256!==hash(p)||r.grant?.plan_sha256!==hash(p))fail('TEMPLATE_DELIVERY_PLAN_CHANGED');
   await inspectExpected();for(const role of Object.keys(TEMPLATE_HEADERS))if(!r.expected[role]){await mutate('sheet_add_sheet',{file_id:p.target.file_id,name:TEMPLATE_HEADERS[role].name,append_index:true},role);const values=TEMPLATE_HEADERS[role].headers.map((value,col)=>({row:0,col,value_type:'STRING',string_value:value}));await mutate('sheet_set_range_value',{file_id:p.target.file_id,sheet_id:r.expected[role].sheet_id,values},role,{values});}
   r.routes=bindRoutes(p,r.expected);save(id,owner,signal,r);
   for(const region of r.routes){if(!region.rows.length)continue;
    for(let offset=0;offset<region.rows.length;offset+=15){const values=[];for(let i=offset;i<Math.min(offset+15,region.rows.length);i++)for(let col=0;col<region.rows[i].length;col++)values.push({row:region.start_row+i,col,value_type:'STRING',string_value:region.rows[i][col]});await mutate('sheet_set_range_value',{file_id:p.target.file_id,sheet_id:region.sheet_id,values},region.role,{values});}
    for(const l of region.links){const display=region.rows[l.row-region.start_row][l.col];await mutate('sheet_set_link',{file_id:p.target.file_id,sheet_id:region.sheet_id,...l,display_text:display},region.role,{link:l});}
    await verifyRegion(region); // overview is last, after detail and source proof.
   }
   await inspectExpected();db.transaction(()=>{owns(id,owner,signal);r.verified_at=now();r.content_verified=true;r.links_verified=true;db.checkpoint(receiptKey(id),r);db.db.prepare("UPDATE tasks SET state='verified',owner=NULL,lease=0,error=NULL,updated=? WHERE id=? AND owner=?").run(now(),id,owner);});
  }catch(e){db.transaction(()=>{const t=task(id);if(t.owner!==owner||t.state!=='writing')return;r.failure_code=safeError(e);r.stopped_at=now();db.checkpoint(receiptKey(id),r);db.db.prepare('UPDATE tasks SET state=?,owner=NULL,lease=0,error=?,updated=? WHERE id=? AND owner=?').run(r.operations.length?'unknown':t.cancelled?'cancelled':'blocked',r.failure_code,now(),id,owner);});}
  finally{clearInterval(heartbeat);active.delete(id);}})();active.set(id,{owner,controller,promise});
 }
 function reconcile(id){return tracked(async()=>{const t=task(id),p=plan(id),r=clone(db.checkpoint(receiptKey(id))||{});if(active.has(id)||t.owner&&t.lease>Date.now())fail('TEMPLATE_DELIVERY_BUSY');if(!r.routes?.length)fail('TEMPLATE_DELIVERY_UNKNOWN');const taskHash=hash(t),receiptHash=hash(r),signal=AbortSignal.timeout(timeoutMs),call=ro(signal);let success=false,error;
  try{await fixed(p,signal);const current=await currentSnapshots(call,p,r.expected);assertTemplateHeaders(current);for(const region of r.routes){if(!region.rows.length)continue;const s=current[region.role];if(!regionText(s,region))fail('TEMPLATE_DELIVERY_CONTENT_MISMATCH');knownLinks(s,region);const v=await verify({call},p.target.file_id,region.name,{start_row:region.start_row,rows:region.rows,links:region.links},signal);if(v?.content!==true||v.links!==true)fail('TEMPLATE_DELIVERY_EXPORT_MISMATCH');}const final=await currentSnapshots(call,p,r.expected);assertTemplateHeaders(final);if(hash(final)!==hash(current))fail('TEMPLATE_DELIVERY_BASELINE_CHANGED');success=true;}catch(e){error=safeError(e);}
  db.transaction(()=>{if(hash(task(id))!==taskHash||hash(db.checkpoint(receiptKey(id))||{})!==receiptHash)fail('TEMPLATE_DELIVERY_BUSY');r.reconciliations=[...(r.reconciliations||[]),{checked_at:now(),content_verified:success,links_verified:success,...(error?{error}:{})}];if(success){r.content_verified=true;r.links_verified=true;}db.checkpoint(receiptKey(id),r);if(t.state!=='verified')db.db.prepare('UPDATE tasks SET state=?,owner=NULL,lease=0,error=?,updated=? WHERE id=?').run(success?'verified':'unknown',error||null,now(),id);});return read(id);
 });}
 async function cancel(id){const a=active.get(id);db.transaction(()=>{const t=task(id);if(['verified','cancelled','blocked'].includes(t.state))return;if(t.owner&&t.owner!==a?.owner&&t.lease>Date.now())fail('TEMPLATE_DELIVERY_BUSY');if(a&&t.owner!==a.owner)fail('TEMPLATE_DELIVERY_OWNERSHIP_LOST');db.db.prepare('UPDATE tasks SET cancelled=1,state=?,updated=? WHERE id=?').run(a?'writing':t.state==='prepared'?'cancelled':'unknown',now(),id);a?.controller.abort();});if(a)await a.promise;return read(id);}
 async function idle(){while(active.size||pending.size)await Promise.allSettled([...pending,...[...active.values()].map(a=>a.promise)]);}
 async function close(){if(stopped)return;stopped=true;for(const a of active.values())a.controller.abort();await idle();db.close();}
 return {prepare,approve,read,list,reconcile,cancel,idle,close};
}
async function currentSnapshots(call,p,expected){const sheets=await info(call,p.target.file_id),actual={};for(const role of Object.keys(TEMPLATE_HEADERS)){const found=sheets.filter(s=>s.sheet_name===TEMPLATE_HEADERS[role].name);if(expected[role]===null){if(found.length)fail('TEMPLATE_DELIVERY_BASELINE_CHANGED');actual[role]=null;continue;}if(found.length!==1||found[0].sheet_id!==expected[role].sheet_id)fail('TEMPLATE_DELIVERY_BASELINE_CHANGED');actual[role]=await snapshot(call,p.target.file_id,found[0]);}return actual;}
function applyChange(old,change){const out=clone(old);if(change.values)for(const v of change.values){out.cells=out.cells.filter(c=>c.row!==v.row||c.col!==v.col);if(v.string_value!=='')out.cells.push({row:v.row,col:v.col,text:v.string_value});}if(change.link){const c=out.cells.find(c=>c.row===change.link.row&&c.col===change.link.col);if(!c)fail('TEMPLATE_DELIVERY_LINK_MISMATCH');c.url=change.link.url;}out.cells.sort((a,b)=>a.row-b.row||a.col-b.col);return out;}
function changedPositions(change){return new Set(change.values?change.values.map(v=>`${v.row}:${v.col}`):[`${change.link.row}:${change.link.col}`]);}
function compatibleAfter(actual,old,expected,change){const changed=changedPositions(change),untouched=s=>s.cells.filter(c=>!changed.has(`${c.row}:${c.col}`));if(actual.sheet_id!==old.sheet_id||actual.row_count!==old.row_count||actual.col_count!==old.col_count||hash(untouched(actual))!==hash(untouched(old)))return false;for(const pos of changed){const [row,col]=pos.split(':').map(Number),a=actual.cells.find(c=>c.row===row&&c.col===col),e=expected.cells.find(c=>c.row===row&&c.col===col);if((a?.text||'')!==(e?.text||''))return false;if(a?.url&&a.url!==(e?.url||e?.text))fail('TEMPLATE_DELIVERY_LINK_MISMATCH');}return true;}
function onlyMissingChange(actual,old,expected,change){if(change.link)return false;const changed=changedPositions(change);if(hash(actual.cells.filter(c=>!changed.has(`${c.row}:${c.col}`)))!==hash(old.cells.filter(c=>!changed.has(`${c.row}:${c.col}`))))return false;return [...changed].every(pos=>{const [row,col]=pos.split(':').map(Number),a=actual.cells.find(c=>c.row===row&&c.col===col),e=expected.cells.find(c=>c.row===row&&c.col===col);return !a?.text||a.text===e?.text;});}

function assertTemplateHeaders(snapshots){for(const [role,spec]of Object.entries(TEMPLATE_HEADERS)){const s=snapshots[role];if(!s||s.col_count<spec.headers.length||spec.headers.some((v,col)=>s.cells.find(c=>c.row===0&&c.col===col)?.text!==v)||s.cells.some(c=>c.row===0&&c.col>=spec.headers.length))fail('TEMPLATE_DELIVERY_TEMPLATE_HEADERS');}}

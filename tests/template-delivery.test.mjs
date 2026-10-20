import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Tasks,hash} from '../app/tasks.mjs';
import {CREATIVE_TASK_PIPELINE} from '../app/creative-task.mjs';
import {createTemplateDelivery,TEMPLATE_HEADERS,projectTemplateContent} from '../app/template-delivery.mjs';
const tick=()=>new Promise(r=>setTimeout(r,5));
function fixture(t,{missing=false,mode='A',placeholder=false,...options}={}){
 const root=mkdtempSync(join(tmpdir(),'template-delivery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const rows=[TEMPLATE_HEADERS.A.headers,...Array.from({length:18},(_,i)=>['正文'+i,'完整\n正文'+i,'结合','制作']),['热点原片','https://example.com/video','原片','实际范围'],['重点拆解','追加拆解内容','结构作用','限制'],['游戏对照与结合','追加结合内容','真实引用','条件']];
 const r={version:CREATIVE_TASK_PIPELINE,status:'needs_review',accepted:false,ready:false,delivery_enabled:false,mode,format:'video',game:'测试游戏',binding:{game:'测试游戏',mode,format:'video',source_id:'12345678901'},coverage:{frames:[0,8,16],has_audio:true,speech:'automatic_full_track_transcript_unverified'},boundary:'离散抽帧与未核机器语音',plan:{fit:'expression',blocking_gaps:[],ideas:[{title:'一个完整标题'}]},draft:{rows,links:[{row:19,col:1,url:rows[19][1]}]}};r.draft_sha256=hash(r.draft);r.result_version=hash(r);
 const candidate={id:randomUUID(),type:'creative-candidate',state:'completed',payload:{creative_pipeline:CREATIVE_TASK_PIPELINE},result:r},q={task_id:candidate.id,result_version:r.result_version,draft_sha256:r.draft_sha256};
 const placeholderRow=[mode,r.game,'测试方式','测试中','待生成','未核验','这是精确占位'];const sheets=[];
 if(!missing)for(const [role,s]of Object.entries(TEMPLATE_HEADERS)){const cells=s.headers.map((text,col)=>({row:0,col,string_value:text,value_type:'STRING',formula:'',number_value:0,bool_value:false}));if(role==='overview'&&placeholder)placeholderRow.forEach((text,col)=>cells.push({row:1,col,string_value:text,value_type:'STRING'}));sheets.push({sheet_id:'sheet-'+role,sheet_name:s.name,row_count:200,col_count:26,cells});}
 sheets.push({sheet_id:'history',sheet_name:'旧候选历史',row_count:200,col_count:26,cells:[{row:0,col:0,string_value:'历史保留',value_type:'STRING'}]});
 const calls=[],exports=[];let enabled=true,dest={file_id:'file123',url:'https://docs.qq.com/sheet/file123'},hook=async()=>{};
 const client={call:async(name,args,{signal}={})=>{calls.push({name,args:structuredClone(args)});await hook(name,args,signal);
  if(name==='manage_query_file_info')return {...dest,type:'sheet'};
  if(name==='sheet_get_sheet_info')return {error:'',sheets:sheets.map(({cells,...rest})=>rest)};
  if(name==='sheet_add_sheet'){const s={sheet_id:'new-'+sheets.length,sheet_name:args.name,row_count:200,col_count:26,cells:[]};sheets.push(s);return {sheet_id:s.sheet_id};}
  const s=sheets.find(s=>s.sheet_id===args.sheet_id);if(!s)throw Error('SECRET path');
  if(name==='sheet_get_cell_data')return {error:'',cells:structuredClone(s.cells.filter(c=>c.row>=args.start_row&&c.row<=args.end_row&&c.col>=args.start_col&&c.col<=args.end_col))};
  if(name==='sheet_set_range_value'){for(const v of args.values){s.cells=s.cells.filter(c=>c.row!==v.row||c.col!==v.col);s.cells.push({...v,formula:'',number_value:0,bool_value:false});}return {error:''};}
  if(name==='sheet_set_link'){const c=s.cells.find(c=>c.row===args.row&&c.col===args.col);c.hyperlink={url:args.url};c.string_value=args.display_text;c.value_type='RICH_STRING';return {};}
  throw Error('unexpected '+name);
 }};
 const verify=async(c,file,name,region)=>{exports.push({file,name,region:structuredClone(region)});const s=sheets.find(s=>s.sheet_name===name);return {content:region.rows.every((row,i)=>row.every((text,col)=>(s.cells.find(c=>c.row===region.start_row+i&&c.col===col)?.string_value||'')===text)),links:region.links.every(l=>s.cells.find(c=>c.row===l.row&&c.col===l.col)?.hyperlink?.url===l.url),styles:false};};
 const instances=[];const make=over=>{const service=createTemplateDelivery({dataRoot:root,readCandidate:async()=>structuredClone(candidate),getDestination:()=>structuredClone(dest),isEnabled:()=>enabled,client,verify,overviewPlaceholders:placeholder?[placeholderRow]:[],...options,...over});instances.push(service);return service;};t.after(async()=>{for(const s of instances)await s.close();});
 return {root,candidate,q,rows,sheets,calls,exports,client,verify,make,placeholderRow,setHook:f=>hook=f,setEnabled:v=>enabled=v,setTarget:v=>dest=v};
}
const writes=f=>f.calls.filter(c=>['sheet_add_sheet','sheet_set_range_value','sheet_set_link'].includes(c.name));
async function deliver(f,s){const p=await s.prepare(f.q);await s.approve({plan_id:p.id,plan_sha256:p.plan_sha256});await s.idle();return s.read(p.id);}
test('prepare is read-only, exact A/source/overview routes preserve draft and old history; repeated approval/restart zero writes',async t=>{
 const f=fixture(t),s=f.make(),p=await s.prepare(f.q);assert.equal(writes(f).length,0);assert.equal(p.routes[0].role,'A');assert.deepEqual(p.routes[0].rows,f.rows.slice(1).filter(r=>r[0]!=='热点原片'));assert.equal(p.routes[2].rows[0].length,7);assert.equal(p.routes[1].rows[0].length,9);assert(!JSON.stringify(p).includes(f.root));
 await s.approve({plan_id:p.id,plan_sha256:p.plan_sha256});await s.idle();const r=s.read(p.id);assert.equal(r.state,'verified');assert.equal(r.receipt.routes.length,3);assert.equal(r.receipt.expected,undefined);assert.equal(f.exports.length,3);assert(f.exports.every(e=>e.region.start_row===1));assert.equal(f.sheets.find(x=>x.sheet_id==='sheet-B').cells.length,4);assert.equal(f.sheets.find(x=>x.sheet_id==='history').cells[0].string_value,'历史保留');
 const order=writes(f).filter(c=>c.name==='sheet_set_range_value').map(c=>c.args.sheet_id);assert.equal(order.at(-1),'sheet-overview');const count=f.calls.length;await s.approve({plan_id:p.id,plan_sha256:p.plan_sha256});await s.close();const reopened=f.make();assert.equal((await reopened.prepare(f.q)).id,p.id);assert.equal(reopened.read(p.id).state,'verified');assert.equal(f.calls.length,count);
});
test('missing templates only create after approval; mode B routes correctly and real metadata independent of IDs',async t=>{
 const f=fixture(t,{missing:true,mode:'B'}),s=f.make(),p=await s.prepare(f.q);assert.equal(p.templates.filter(x=>x.create).length,4);assert.equal(writes(f).length,0);await s.approve({plan_id:p.id,plan_sha256:p.plan_sha256});await s.idle();assert.equal(s.read(p.id).state,'verified');assert.equal(f.calls.filter(c=>c.name==='sheet_add_sheet').length,4);assert(f.sheets.find(x=>x.sheet_name===TEMPLATE_HEADERS.B.name).cells.length>4);assert.equal(f.sheets.find(x=>x.sheet_name===TEMPLATE_HEADERS.A.name).cells.length,4);
});
test('placeholder exact full-row CAS only; otherwise append after actual last occupied row',async t=>{
 const f=fixture(t,{placeholder:true}),s=f.make(),p=await s.prepare(f.q);assert.equal(p.routes.at(-1).start_row,1);assert.equal(p.routes.at(-1).replace,true);f.sheets.find(x=>x.sheet_id==='sheet-overview').cells.find(c=>c.row===1&&c.col===6).string_value='用户修改';await assert.rejects(s.approve({plan_id:p.id,plan_sha256:p.plan_sha256}),{code:'TEMPLATE_DELIVERY_BASELINE_CHANGED'});assert.equal(writes(f).length,0);
 const g=fixture(t,{placeholder:true}),z=g.make({overviewPlaceholders:[]});g.sheets.find(x=>x.sheet_id==='sheet-overview').cells.push({row:150,col:15,string_value:'后段用户内容',value_type:'STRING'});const q=await z.prepare(g.q);assert.equal(q.routes.at(-1).start_row,151);assert.equal(q.routes.at(-1).replace,false);
});
test('header conflict/duplicate name/target version drift/gate block mutation',async t=>{
 const f=fixture(t),s=f.make();f.setEnabled(false);const p=await s.prepare(f.q);assert.throws(()=>s.approve({plan_id:p.id,plan_sha256:p.plan_sha256}),{code:'TEMPLATE_DELIVERY_DISABLED'});f.setEnabled(true);await assert.rejects(s.approve({plan_id:p.id,plan_sha256:'a'.repeat(64)}),{code:'TEMPLATE_DELIVERY_PLAN_CHANGED'});f.setTarget({file_id:'other123',url:'https://docs.qq.com/sheet/other123'});await assert.rejects(s.approve({plan_id:p.id,plan_sha256:p.plan_sha256}),{code:'TEMPLATE_DELIVERY_TARGET_CHANGED'});assert.equal(writes(f).length,0);
 for(const duplicate of [false,true]){const g=fixture(t);if(duplicate)g.sheets.push({...g.sheets[0],sheet_id:'duplicate'});else g.sheets[0].cells[0].string_value='近似表头';await assert.rejects(g.make().prepare(g.q));assert.equal(writes(g).length,0);}
});
test('partial/lost response is unknown, reapprove/restart never resend and overview remains untouched',async t=>{
 const f=fixture(t);f.setHook(async name=>{if(name==='sheet_set_range_value')throw Error('SECRET lost response');});const s=f.make(),p=await s.prepare(f.q);await s.approve({plan_id:p.id,plan_sha256:p.plan_sha256});await s.idle();assert.equal(s.read(p.id).state,'unknown');assert(!JSON.stringify(s.read(p.id)).includes('SECRET'));const n=writes(f).length;await s.approve({plan_id:p.id,plan_sha256:p.plan_sha256});await s.close();const z=f.make();z.list();z.read(p.id);await z.approve({plan_id:p.id,plan_sha256:p.plan_sha256});assert.equal(writes(f).length,n);assert.equal(f.sheets.find(s=>s.sheet_id==='sheet-overview').cells.length,7);await z.reconcile(p.id);assert.equal(z.read(p.id).state,'unknown');assert.equal(writes(f).length,n);
});
test('same target serialized across instances; cancel waits owned request and cannot overwrite foreign owner',async t=>{
 const f=fixture(t);let entered=false,release;f.setHook(async name=>{if(name==='sheet_set_range_value'){entered=true;await new Promise(r=>release=r);}});const a=f.make(),b=f.make();const p=await a.prepare(f.q);await a.approve({plan_id:p.id,plan_sha256:p.plan_sha256});while(!entered)await tick();await b.approve({plan_id:p.id,plan_sha256:p.plan_sha256});assert.equal(writes(f).length,1);let finished=false;const cancelling=a.cancel(p.id).then(r=>{finished=true;return r;});await tick();assert.equal(finished,false);release();assert.equal((await cancelling).state,'unknown');assert.equal(writes(f).length,1);
});
test('export must prove actual offset text and links before overview; wrong URL cannot be hidden',async t=>{
 const f=fixture(t),s=f.make({verify:async()=>({content:true,links:false,styles:true})}),r=await deliver(f,s);assert.equal(r.state,'unknown');assert.equal(f.sheets.find(s=>s.sheet_id==='sheet-overview').cells.length,7);assert.equal(f.sheets.find(s=>s.sheet_id==='sheet-sources').cells.length,9);
 const g=fixture(t);g.setHook(async name=>{if(name==='sheet_get_cell_data'){const c=g.sheets.find(s=>s.sheet_id==='sheet-sources').cells.find(c=>c.hyperlink);if(c)c.hyperlink.url='https://wrong.example/';}});const z=g.make(),rr=await deliver(g,z);assert.equal(rr.state,'unknown');assert.equal(g.exports.length,1);
});
test('bounded XLSX verifier handles nine columns at nonzero offset without expecting prefix blanks',t=>{
 const root=mkdtempSync(join(tmpdir(),'template-xlsx-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const py=`import zipfile,json,sys\np=sys.argv[1]\nns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'\nwith zipfile.ZipFile(p+'/book.xlsx','w') as z:\n z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="来源与核验" r:id="s1"/></sheets></workbook>')\n z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>')\n cells='<c r="A1" t="inlineStr"><is><t>用户旧正文</t></is></c>'+''.join('<c r="'+chr(65+i)+'6" t="inlineStr"><is><t>'+str(i)+'</t></is></c>' for i in range(9))\n z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row>'+cells+'</row></sheetData><hyperlinks><hyperlink ref="I6" r:id="l1"/></hyperlinks></worksheet>')\n z.writestr('xl/worksheets/_rels/sheet1.xml.rels','<Relationships><Relationship Id="l1" Target="https://example.com/"/></Relationships>')\n`;
 execFileSync('python3',['-c',py,root]);const expected={sheet_name:'来源与核验',start_row:5,rows:[Array.from({length:9},(_,i)=>''+i)],links:[{row:5,col:8,url:'https://example.com/'}]};writeFileSync(join(root,'expected.json'),JSON.stringify(expected));const run=()=>JSON.parse(execFileSync('python3',['app/template-verify.py',join(root,'book.xlsx'),join(root,'expected.json')],{encoding:'utf8'}));assert.equal(run().content,true);assert.equal(run().links,true);expected.start_row=0;writeFileSync(join(root,'expected.json'),JSON.stringify(expected));assert.equal(run().content,false);
});
test('HTTP strict plan/target/session boundaries, pure GET and no client authorization forwarding',async t=>{
 const {createServer}=await import('node:http'),{handleTemplateDeliveryHttp}=await import('../app/template-delivery-http.mjs');const actions=[],id=randomUUID(),target={file_id:'file123',url:'https://docs.qq.com/sheet/file123'},planHash='a'.repeat(64);
 const service={list:()=>[],read:()=>({id}),prepare:async(...x)=>{actions.push(['prepare',...x]);return {id,plan_sha256:planHash};},approve:async(...x)=>{actions.push(['approve',...x]);return {id,state:'writing'};},reconcile:async()=>({id}),cancel:async()=>({id})};let origin;
 const server=createServer(async(req,res)=>{const json=(r,status,v)=>{r.writeHead(status,{'content-type':'application/json'});r.end(JSON.stringify(v));};await handleTemplateDeliveryHttp(req,res,new URL(req.url,origin),{service,origin,token:'session',json,body:async req=>{let raw='';for await(const x of req)raw+=x;return JSON.parse(raw);}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;t.after(()=>new Promise(r=>server.close(r)));
 const send=(path,value,headers={})=>fetch(origin+'/api/template-deliveries'+path,{method:'POST',headers:{'content-type':'application/json','x-crawl-token':'session',origin,...headers},body:JSON.stringify(value)});
 assert.equal((await fetch(origin+'/api/template-deliveries')).status,200);assert.equal(actions.length,0);
 const q={task_id:id,result_version:planHash,draft_sha256:planHash,target};assert.equal((await send('/prepare',q,{'x-crawl-token':'wrong'})).status,403);assert.equal((await send('/prepare',q,{origin:'https://evil.example'})).status,403);assert.equal((await send('/prepare',{...q,authorization:{basis:'approved'}})).status,400);assert.equal(actions.length,0);
 assert.equal((await send('/prepare',q)).status,200);assert.deepEqual(actions[0],['prepare',{task_id:id,result_version:planHash,draft_sha256:planHash},{expectedTarget:target}]);
 assert.equal((await send('/'+id+'/approve',{plan_sha256:planHash,target,rows:[]})).status,400);assert.equal((await send('/'+id+'/approve',{plan_sha256:planHash,target})).status,202);assert.deepEqual(actions[1],['approve',{plan_id:id,plan_sha256:planHash},{expectedTarget:target}]);
 assert.equal((await send('/'+id+'/reconcile',{retry:true})).status,400);assert.equal((await send('/'+id+'/cancel',{})).status,200);assert.equal((await send('/'+id+'/resume',{})).status,404);
 service.read=()=>{throw Error('/private/secret');};const failure=await (await fetch(origin+'/api/template-deliveries/'+id)).text();assert(!failure.includes('/private'));
});
test('explicit prepared refresh after another delivery preserves old plan history and rejects old hash',async t=>{
 const f=fixture(t),s=f.make();const a=await s.prepare(f.q);
 const second=structuredClone(f.candidate);second.id=randomUUID();second.result.mode='B';second.result.binding.mode='B';delete second.result.result_version;second.result.result_version=hash(second.result);const bq={task_id:second.id,result_version:second.result.result_version,draft_sha256:second.result.draft_sha256};const bs=f.make({readCandidate:async()=>structuredClone(second)});const b=await bs.prepare(bq);
 await s.approve({plan_id:a.id,plan_sha256:a.plan_sha256});await s.idle();assert.equal(s.read(a.id).state,'verified');await assert.rejects(bs.approve({plan_id:b.id,plan_sha256:b.plan_sha256}),{code:'TEMPLATE_DELIVERY_BASELINE_CHANGED'});
 const oldWrites=writes(f).length,next=await bs.prepare(bq);assert.equal(next.id,b.id);assert.notEqual(next.plan_sha256,b.plan_sha256);assert.equal(writes(f).length,oldWrites);await assert.rejects(bs.approve({plan_id:b.id,plan_sha256:b.plan_sha256}),{code:'TEMPLATE_DELIVERY_PLAN_CHANGED'});
 const db=new Tasks(join(f.root,'template-deliveries'));assert(db.checkpoint(`template:${b.id}:plan-history:${b.plan_sha256}`));db.close();await bs.approve({plan_id:next.id,plan_sha256:next.plan_sha256});await bs.idle();assert.equal(bs.read(next.id).state,'verified');assert.equal(bs.read(next.id).receipt.expected,undefined);
});
test('independent target lock blocks competing candidate; foreign lease owner is not overwritten',async t=>{
 const f=fixture(t),s=f.make();const a=await s.prepare(f.q),other=structuredClone(f.candidate);other.id=randomUUID();const os=f.make({readCandidate:async()=>other}),b=await os.prepare({...f.q,task_id:other.id});let entered=false,release;f.setHook(async name=>{if(name==='sheet_set_range_value'){entered=true;await new Promise(r=>release=r);}});await s.approve({plan_id:a.id,plan_sha256:a.plan_sha256});while(!entered)await tick();await assert.rejects(os.approve({plan_id:b.id,plan_sha256:b.plan_sha256}),{code:'TEMPLATE_DELIVERY_TARGET_BUSY'});
 const db=new Tasks(join(f.root,'template-deliveries'));db.db.prepare("UPDATE tasks SET owner='replacement',lease=? WHERE id=?").run(Date.now()+60000,a.id);await assert.rejects(s.cancel(a.id),{code:'TEMPLATE_DELIVERY_BUSY'});release();await s.idle();assert.equal(db.get(a.id).owner,'replacement');assert.equal(db.get(a.id).state,'writing');db.close();assert.equal(writes(f).length,1);
});
test('read-only reconciliation cannot certify a workbook whose template headers changed',async t=>{
 const f=fixture(t);let verifications=0;const s=f.make({verify:async(...args)=>{verifications++;if(verifications===3)throw Error('export response lost');return f.verify(...args);}}),r=await deliver(f,s);assert.equal(r.state,'unknown');await s.close();const z=f.make(),count=writes(f).length;f.sheets.find(s=>s.sheet_id==='sheet-B').cells[0].string_value='用户改了未使用的B表头';assert.equal((await z.reconcile(r.id)).state,'unknown');assert.equal(writes(f).length,count);f.sheets.find(s=>s.sheet_id==='sheet-B').cells[0].string_value=TEMPLATE_HEADERS.B.headers[0];assert.equal((await z.reconcile(r.id)).state,'verified');assert.equal(writes(f).length,count);
});
test('approve CAS rejects a plan refreshed by another instance while candidate read awaited',async t=>{
 const f=fixture(t);let pause=false,entered=false,release;const a=f.make({readCandidate:async()=>{if(pause){entered=true;await new Promise(r=>release=r);}return structuredClone(f.candidate);}}),b=f.make();const original=await a.prepare(f.q);pause=true;const approval=a.approve({plan_id:original.id,plan_sha256:original.plan_sha256});while(!entered)await tick();const overview=f.sheets.find(s=>s.sheet_id==='sheet-overview');overview.cells.push({row:1,col:0,string_value:'new row',value_type:'STRING'});const refreshed=await b.prepare(f.q);assert.notEqual(refreshed.plan_sha256,original.plan_sha256);overview.cells=overview.cells.filter(c=>c.row!==1);release();await assert.rejects(approval,{code:'TEMPLATE_DELIVERY_PLAN_CHANGED'});assert.equal(writes(f).length,0);assert.equal(a.read(original.id).state,'prepared');
});

test('readable projection removes audit rows, remaps retained links and separates webpage/local media notes',async t=>{
 const f=fixture(t),r=f.candidate.result,id='local_'+'a'.repeat(64);
 r.draft={rows:[TEMPLATE_HEADERS.A.headers,['完整台词','保留开头、行动和结尾','游戏处境','待试拍'],
  ['读取范围','{"frames":[0,8,16],"state":"raw_machine"}','',''],
  ['本地选题原片','本地视频',id,'SHA-256：'+'a'.repeat(64)],
  ['游戏资料','https://example.com/official','游戏官网','实际读取：画面抽样；语音自动转写'],
  ['分镜参考','https://example.com/shot','保留这一镜','声音自行录制']],
  links:[{row:4,col:1,url:'https://example.com/official'},{row:5,col:1,url:'https://example.com/shot'}],
  source_notes:[{kind:'local-video',selected:true,source_id:id,title:'星际猎人战斗录屏',url:null,frames:[0,8,16],has_audio:true},
   {kind:'web',selected:false,source_id:null,title:'游戏官网',url:'https://example.com/official',frames:[],has_audio:null}]};
 r.boundary='One Host candidate internal English boundary';r.draft_sha256=hash(r.draft);delete r.result_version;r.result_version=hash(r);Object.assign(f.q,{result_version:r.result_version,draft_sha256:r.draft_sha256});
 const original=structuredClone(r.draft),p=await f.make().prepare(f.q),main=p.routes[0],sources=p.routes[1],overview=p.routes[2];
 assert.deepEqual(main.rows,[original.rows[1],original.rows[5]]);assert.deepEqual(main.links,[{row:2,col:1,url:'https://example.com/shot'}]);
 assert.equal(sources.rows[0][0],'星际猎人战斗录屏');assert.equal(sources.rows[0][3],'');assert.equal(sources.rows[0][5],'0秒、8秒、16秒');assert.match(sources.rows[0][6],/未逐句核听/);
 assert.deepEqual(sources.links,[{row:2,col:3,url:'https://example.com/official'}]);assert.match(sources.rows[1][5],/网页文字/);assert.match(sources.rows[1][6],/不适用/);assert(!sources.rows[1].join('').includes('自动转写'));
 const visible=p.routes.map(r=>r.rows).flat(2).join('\n');for(const token of [id,'SHA-256','One Host','raw_machine',f.q.task_id,f.q.result_version,f.q.draft_sha256,'task=','result=','draft='])assert(!visible.includes(token),token);
 assert.equal(overview.rows[0][6],'待试拍');assert.deepEqual(r.draft,original);assert.equal(writes(f).length,0);
});

test('old local IDs get readable fallback names and zero fabricated hyperlinks',()=>{
 const id='local_'+'b'.repeat(64),r={game:'游戏',coverage:{frames:[2.5],has_audio:false},draft:{rows:[TEMPLATE_HEADERS.A.headers,['台词','完整正文','',''],['本地游戏参考',id,'SHA-256: hash','无链接']],links:[]}};
 const view=projectTemplateContent(r);assert.equal(view.rows.length,1);assert.equal(view.sources.length,1);assert.equal(view.sources[0][0],'本地参考视频 1');assert.equal(view.sources[0][3],'');assert(!JSON.stringify(view).includes(id));assert.deepEqual(view.links,[]);
});
test('legacy evidence names fall back without rejecting normal titles containing colons',()=>{
 const names=['publisher:rate','platform:community','game:study-frame:1234567890','game:P','study-asr:1234567890','selected:F0','星际猎人:初学攻略','玩法说明：角色与关卡','A guide: first steps'];
 const r={game:'游戏',draft:{rows:[TEMPLATE_HEADERS.A.headers,['方案','保留原文','',''],...names.map((name,i)=>['游戏资料',`https://example.com/${i}`,name,'旧来源说明'])],links:names.map((_,i)=>({row:i+2,col:1,url:`https://example.com/${i}`}))}};
 const before=structuredClone(r),view=projectTemplateContent(r);
 for(let i=0;i<6;i++){assert.equal(view.sources[i][0],'参考网页');assert.equal(view.sources[i][3],`https://example.com/${i}`);}
 for(let i=6;i<names.length;i++)assert.equal(view.sources[i][0],names[i]);
 assert.deepEqual(r,before);assert.deepEqual(view.rows,[['方案','保留原文','','']]);
});
test('source note projection rejects forged local public links and unbound remote URLs',()=>{
 const make=()=>({game:'游戏',draft:{rows:[TEMPLATE_HEADERS.A.headers,['完整方案','正文','','']],links:[],source_notes:[{kind:'local-video',selected:true,source_id:'local_'+'a'.repeat(64),title:'原片',url:null,frames:[1],has_audio:null}]}});
 const local=make();local.draft.source_notes[0].url='https://example.com/fake-local';assert.throws(()=>projectTemplateContent(local),{code:'TEMPLATE_DELIVERY_DRAFT_INVALID'});
 const remote=make();remote.draft.source_notes[0].kind='web';remote.draft.source_notes[0].url='https://example.com/not-captured';assert.throws(()=>projectTemplateContent(remote),{code:'TEMPLATE_DELIVERY_DRAFT_INVALID'});
});

test('pre-projection frozen prepared plan survives restart and explicit prepare without route migration',async t=>{
 const f=fixture(t),one=f.make(),prepared=await one.prepare(f.q);await one.close();
 const db=new Tasks(join(f.root,'template-deliveries')),key=`template:${prepared.id}:plan`,old=db.checkpoint(key);delete old.presentation_version;old.routes[0].rows.push(['旧冻结行','保持原文','旧证据编号','旧备注']);
 old.layout_sha256=hash(old.routes);db.checkpoint(key,old);db.db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify({version:old.version,plan_sha256:hash(old)}),prepared.id);db.close();
 const two=f.make(),calls=f.calls.length,reread=two.read(prepared.id);assert.equal(reread.plan_sha256,hash(old));assert.deepEqual((await two.prepare(f.q)).routes,old.routes);assert.equal(f.calls.length,calls);
 await two.approve({plan_id:prepared.id,plan_sha256:hash(old)});await two.idle();assert.equal(two.read(prepared.id).state,'verified');assert.deepEqual(two.read(prepared.id).receipt.routes[0].rows,old.routes[0].rows);
});

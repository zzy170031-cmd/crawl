// A2 independent controlled-provider tests; no real Tencent, Host or source API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,symlinkSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Tasks,hash} from '../app/tasks.mjs';
import {CREATIVE_TASK_PIPELINE} from '../app/creative-task.mjs';
import {createTemplateDelivery,TEMPLATE_HEADERS} from '../app/template-delivery.mjs';
const tick=()=>new Promise(r=>setTimeout(r,5));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'template-a2-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sheets=Object.entries(TEMPLATE_HEADERS).map(([role,s])=>({role,sheet_id:'tab-'+role,sheet_name:s.name,row_count:200,col_count:26,cells:s.headers.map((text,col)=>({row:0,col,value_type:'STRING',string_value:text}))}));
 let destination={file_id:'fixture123',url:'https://docs.qq.com/sheet/fixture123'},enabled=true,hook=async()=>{};const candidates=new Map(),calls=[],exports=[],instances=[];
 function candidate(mode='A'){
  const draft={rows:[TEMPLATE_HEADERS.A.headers,['方案','完整创作\n不截断','实际动作','说明'],['热点原片','https://www.douyin.com/video/1234567890123456789','选题标题','真实读取'],['游戏资料','https://example.com/reference','公开原文','边界'],['附加拆解','末尾完整文字','仅设计','非事实']],links:[{row:2,col:1,url:'https://www.douyin.com/video/1234567890123456789'},{row:3,col:1,url:'https://example.com/reference'}]};
  const result={version:CREATIVE_TASK_PIPELINE,status:'needs_review',accepted:false,ready:false,delivery_enabled:false,game:'测试游戏',mode,format:'video',binding:{game:'测试游戏',mode,format:'video',source_id:'1234567890123456789'},coverage:{frames:[0,12,24],has_audio:true,speech:'automatic_full_track_transcript_unverified'},plan:{fit:'expression',blocking_gaps:[],ideas:[{title:'完整候选'}]},draft,draft_sha256:hash(draft),boundary:'抽样画面和机器语音，未认证全部规则'};result.result_version=hash(result);
  const c={id:randomUUID(),type:'creative-candidate',state:'completed',payload:{creative_pipeline:CREATIVE_TASK_PIPELINE},result};candidates.set(c.id,c);return {c,q:{task_id:c.id,result_version:result.result_version,draft_sha256:result.draft_sha256}};
 }
 const client={async call(name,args,ctx={}){calls.push({name,args:structuredClone(args)});await hook(name,args,ctx);
  if(name==='manage_query_file_info')return {...destination,type:'sheet'};
  if(name==='sheet_get_sheet_info')return {sheets:sheets.map(({cells,role,...s})=>structuredClone(s))};
  if(name==='sheet_add_sheet'){const s={sheet_id:randomUUID(),sheet_name:args.name,row_count:200,col_count:26,cells:[]};sheets.push(s);return {sheet_id:s.sheet_id};}
  const s=sheets.find(s=>s.sheet_id===args.sheet_id);if(!s)throw Error('private provider error /Users/private/secret');
  if(name==='sheet_get_cell_data')return {cells:structuredClone(s.cells.filter(c=>c.row>=args.start_row&&c.row<=args.end_row&&c.col>=args.start_col&&c.col<=args.end_col))};
  if(name==='sheet_set_range_value'){for(const v of args.values){const old=s.cells.find(c=>c.row===v.row&&c.col===v.col);if(old)Object.assign(old,v);else s.cells.push({...v});}return {};}
  if(name==='sheet_set_link'){const c=s.cells.find(c=>c.row===args.row&&c.col===args.col);c.hyperlink={url:args.url};return {};}
  throw Error('unexpected fake provider');
 }};
 const make=(overrides={})=>{const s=createTemplateDelivery({dataRoot:root,readCandidate:async id=>structuredClone(candidates.get(id)),getDestination:()=>structuredClone(destination),isEnabled:()=>enabled,client,verify:async(_c,file,name,region)=>{exports.push({file,name,region:structuredClone(region)});return {content:true,links:true};},...overrides});instances.push(s);return s;};
 t.after(async()=>{for(const s of instances)await s.close();});
 return {root,sheets,candidates,candidate,make,calls,exports,client,setHook:f=>hook=f,setTarget:v=>destination=v,setEnabled:v=>enabled=v,target:()=>structuredClone(destination)};
}
const writes=f=>f.calls.filter(c=>c.name==='sheet_add_sheet'||c.name.startsWith('sheet_set_'));
const approve=(s,p,extra={})=>s.approve({plan_id:p.id,plan_sha256:p.plan_sha256},{expectedTarget:p.target,...extra});
const put=(s,row,values)=>values.forEach((text,col)=>{const old=s.cells.find(c=>c.row===row&&c.col===col),v={row,col,value_type:'STRING',string_value:text};if(old)Object.assign(old,v);else s.cells.push(v);});

test('prepare scans complete allocation, preserves creative body and moves both sources at nonzero offset without writes',async t=>{
 const f=fixture(t),s=f.make(),{q,c}=f.candidate();put(f.sheets.find(s=>s.role==='A'),151,['existing late user row','','','']);
 const p=await s.prepare(q,{expectedTarget:f.target()});assert.equal(writes(f).length,0);const main=p.routes.find(r=>r.role==='A');assert.equal(main.start_row,152);
 assert.deepEqual(main.rows,[c.result.draft.rows[1],c.result.draft.rows[4]]);assert.deepEqual(main.links,[]);
 const sources=p.routes.find(r=>r.role==='sources');
 assert.deepEqual(sources.rows.map(r=>[r[0],r[3]]),[['选题标题',c.result.draft.links[0].url],['公开原文',c.result.draft.links[1].url]]);
 assert.deepEqual(sources.links,c.result.draft.links.map((l,i)=>({row:sources.start_row+i,col:3,url:l.url})));
 assert.match(sources.rows[0][5],/0秒、12秒、24秒/);assert.match(sources.rows[1][6],/没有进行语音读取/);
 await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'verified');assert.equal(f.sheets.find(s=>s.role==='A').cells.find(c=>c.row===151&&c.col===0).string_value,'existing late user row');assert.equal(f.exports.find(e=>e.name==='A游戏视频改编').region.start_row,152);
});
test('readable local projection preserves every non-source cell and exact link coordinates after removed rows',async t=>{
 const f=fixture(t),s=f.make(),{c,q}=f.candidate(),r=c.result,bodyURL='https://example.com/production-reference',webURL='https://example.com/reference';
 r.draft={rows:[TEMPLATE_HEADERS.A.headers,
  ['完整台词','第一段\n第二段，逐字保留','玩家具体动作','原限定'],
  ['读取范围','{"internal_hash":"'+('a'.repeat(64))+'"}','',''],
  ['本地选题原片','录屏甲.mp4','用户上传的本地视频','无公开链接'],
  ['游戏资料',webURL,'资料页面','原来源'],
  ['镜头03','保留城池文字与标点',bodyURL,'等待3秒'],
  ['最后一段','不能截尾','','']],
  links:[{row:4,col:1,url:webURL},{row:5,col:2,url:bodyURL}],
  source_notes:[
   {kind:'local-video',selected:true,source_id:'local_'+'b'.repeat(64),title:'录屏甲.mp4',url:null,frames:[0,4,8],has_audio:false},
   {kind:'web',selected:false,source_id:null,title:'公开说明',url:webURL,frames:[],has_audio:null},
   {kind:'web',selected:false,source_id:null,title:'拍摄参考',url:bodyURL,frames:[],has_audio:null}]};
 r.draft_sha256=hash(r.draft);delete r.result_version;r.result_version=hash(r);Object.assign(q,{result_version:r.result_version,draft_sha256:r.draft_sha256});
 put(f.sheets.find(x=>x.role==='A'),40,['旧用户正文','','','']);put(f.sheets.find(x=>x.role==='sources'),17,['旧来源']);
 const p=await s.prepare(q),main=p.routes.find(x=>x.role==='A'),sources=p.routes.find(x=>x.role==='sources');
 assert.deepEqual(main.rows,[r.draft.rows[1],r.draft.rows[5],r.draft.rows[6]]);
 assert.deepEqual(main.links,[{row:42,col:2,url:bodyURL}]);
 assert.equal(sources.rows.length,3);assert.deepEqual(sources.rows.map(x=>x[3]),['',webURL,bodyURL]);
 assert.deepEqual(sources.links,[{row:19,col:3,url:webURL},{row:20,col:3,url:bodyURL}]);
 assert.equal(sources.rows[0][0],'录屏甲.mp4');assert.match(sources.rows[0][6],/没有音轨/);
 const visible=JSON.stringify(p.routes.map(x=>x.rows));
 for(const privateText of ['local_'+'b'.repeat(64),'a'.repeat(64),q.task_id,q.result_version,q.draft_sha256])assert(!visible.includes(privateText));
 assert.equal(writes(f).length,0);await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'verified');
 const cells=f.sheets.find(x=>x.role==='A').cells;
 for(const [i,row]of main.rows.entries())for(const [col,text]of row.entries())assert.equal(cells.find(c=>c.row===main.start_row+i&&c.col===col)?.string_value,text);
 assert.equal(cells.find(c=>c.row===40&&c.col===0).string_value,'旧用户正文');
});
test('legacy source evidence identifiers become readable names without removing their public links',async t=>{
 const f=fixture(t),s=f.make(),{c,q}=f.candidate(),r=c.result;
 r.draft.rows[3][2]='publisher:rate';
 r.draft_sha256=hash(r.draft);delete r.result_version;r.result_version=hash(r);Object.assign(q,{result_version:r.result_version,draft_sha256:r.draft_sha256});
 const p=await s.prepare(q),sources=p.routes.find(x=>x.role==='sources');
 assert.equal(sources.rows[1][0],'参考网页');assert.equal(sources.rows[1][3],'https://example.com/reference');
 assert(!JSON.stringify(p.routes.map(x=>x.rows)).includes('publisher:rate'));assert.equal(writes(f).length,0);
});
test('missing templates are planned without creation and created only after exact approval',async t=>{
 const f=fixture(t);f.sheets.length=0;const s=f.make(),{q}=f.candidate(),p=await s.prepare(q);assert.equal(writes(f).length,0);assert.equal(p.templates.filter(x=>x.create).length,4);
 await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'verified');assert.equal(f.calls.filter(c=>c.name==='sheet_add_sheet').length,4);assert.deepEqual(new Set(f.sheets.map(s=>s.sheet_name)),new Set(Object.values(TEMPLATE_HEADERS).map(x=>x.name)));
});
test('duplicate names, header changes, out-of-range response and numeric cells cannot plan a write',async t=>{
 for(const mode of ['duplicate','header','number','bounds']){
  const f=fixture(t);if(mode==='duplicate')f.sheets.push({...structuredClone(f.sheets[0]),sheet_id:'duplicate'});if(mode==='header')f.sheets[0].cells[0].string_value='near match';if(mode==='number')Object.assign(f.sheets[0].cells[0],{value_type:'NUMBER',number_value:1});
  const s=f.make(mode==='bounds'?{client:{call:async(n,a,ctx)=>n==='sheet_get_cell_data'?{cells:[{row:99999,col:0,string_value:'bad'}]}:f.client.call(n,a,ctx)}}:{}),{q}=f.candidate();await assert.rejects(s.prepare(q));assert.equal(writes(f).length,0);
 }
});
test('target, candidate or baseline drift between prepare and approve rejects before any mutation',async t=>{
 for(const mode of ['target','candidate','baseline']){
  const f=fixture(t),s=f.make(),{q,c}=f.candidate(),p=await s.prepare(q);
  if(mode==='target')f.setTarget({file_id:'other',url:'https://docs.qq.com/sheet/other'});if(mode==='candidate')c.result.plan.blocking_gaps.push('new review gap');if(mode==='baseline')put(f.sheets[1],5,['new user row','','','']);
  await assert.rejects(approve(s,p));assert.equal(writes(f).length,0);
 }
});
test('trusted placeholder requires exact full row and no links; other contents append without overwrite',async t=>{
 const placeholder=['A','测试游戏','占位','待生成','','','原说明'];
 for(const mode of ['exact','changed','linked']){
  const f=fixture(t),overview=f.sheets[0];put(overview,1,placeholder);if(mode==='changed')overview.cells.find(c=>c.row===1&&c.col===6).string_value='用户新备注';if(mode==='linked')overview.cells.find(c=>c.row===1&&c.col===0).hyperlink={url:'https://user.example/'};
  const s=f.make({overviewPlaceholders:[placeholder]}),{q}=f.candidate(),p=await s.prepare(q),route=p.routes.find(r=>r.role==='overview');assert.equal(route.replace,mode==='exact');assert.equal(route.start_row,mode==='exact'?1:2);
 }
});
test('two prepared candidates cannot write the same target concurrently, and stale second baseline is rejected',async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),x=await a.prepare(f.candidate('A').q),y=await b.prepare(f.candidate('B').q);let entered=false,release;
 f.setHook(async name=>{if(name==='sheet_set_range_value'&&!entered){entered=true;await new Promise(r=>release=r);}});await approve(a,x);while(!entered)await tick();await assert.rejects(approve(b,y));release();await a.idle();await assert.rejects(approve(b,y));assert.equal(b.read(y.id).state,'prepared');assert.equal(f.calls.filter(c=>c.name==='sheet_set_range_value'&&c.args.sheet_id==='tab-B').length,0);
});
test('lost mutation response remains unknown; GET/restart/repeated approve never replay',async t=>{
 const f=fixture(t),s=f.make(),{q}=f.candidate(),p=await s.prepare(q);f.setHook(async name=>{if(name==='sheet_set_range_value')throw Error('secret /private/token');});await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'unknown');const n=writes(f).length;assert.equal(n,1);assert(!JSON.stringify(s.read(p.id)).includes('/private/token'));
 s.read(p.id);s.list();await approve(s,p);await s.close();const b=f.make();b.read(p.id);await approve(b,p);assert.equal(writes(f).length,n);
});
test('a remote edit after a responded batch stops the next mutation',async t=>{
 const f=fixture(t),s=f.make(),p=await s.prepare(f.candidate().q);let wrote=false,changed=false;f.setHook(async name=>{if(name==='sheet_set_range_value')wrote=true;if(wrote&&!changed&&name==='sheet_get_cell_data'){changed=true;put(f.sheets[3],100,['unrelated user edit']);}});
 await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'unknown');assert.equal(writes(f).length,1);
});
test('export verifier is read-only and conflicting links or mismatching export cannot produce verified',async t=>{
 for(const mode of ['mutation','wrong-link','export-false']){
  const f=fixture(t);let changedLink=false;const s=f.make({verify:async(client,_file,name,region)=>{if(mode==='mutation')await client.call('sheet_set_range_value',{});if(mode==='wrong-link'&&region.links.length){const sheet=f.sheets.find(s=>s.sheet_name===name),l=region.links[0];sheet.cells.find(c=>c.row===l.row&&c.col===l.col).hyperlink={url:'https://wrong.example/'};changedLink=true;}return {content:mode!=='export-false',links:true};}}),p=await s.prepare(f.candidate().q);await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'unknown');assert.equal(f.calls.filter(c=>c.name==='sheet_set_range_value'&&!c.args.values).length,0);
  if(mode==='wrong-link')assert.equal(changedLink,true,'must exercise an actual hyperlink conflict, not throw because the main body now has no source links');
 }
});
test('explicit read-only prepare can refresh a stale never-written plan after another candidate completes',async t=>{
 const f=fixture(t),s=f.make(),a=await s.prepare(f.candidate('A').q),bCandidate=f.candidate('B'),oldB=await s.prepare(bCandidate.q);
 await approve(s,a);await s.idle();await assert.rejects(approve(s,oldB));const n=writes(f).length;
 const freshB=await s.prepare(bCandidate.q,{expectedTarget:f.target()});assert.equal(writes(f).length,n);assert.notEqual(freshB.plan_sha256,oldB.plan_sha256);
 await approve(s,freshB);await s.idle();assert.equal(s.read(freshB.id).state,'verified');
});
test('public receipt excludes other-template baseline contents while private checkpoint retains integrity evidence',async t=>{
 const f=fixture(t);put(f.sheets.find(s=>s.role==='B'),50,['PRIVATE_UNRELATED_BASELINE /Users/example/private']);const s=f.make(),p=await s.prepare(f.candidate().q);await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'verified');assert(!JSON.stringify(s.read(p.id)).includes('PRIVATE_UNRELATED_BASELINE'));assert(!JSON.stringify(s.list()).includes('/Users/example/private'));
});
test('read-only reconciliation rejects changed template headers even when written regions still match',async t=>{
 const f=fixture(t),s=f.make(),p=await s.prepare(f.candidate().q);await approve(s,p);await s.idle();assert.equal(s.read(p.id).state,'verified');
 const db=new Tasks(join(f.root,'template-deliveries'));db.db.prepare("UPDATE tasks SET state='unknown',owner=NULL,lease=0 WHERE id=?").run(p.id);db.close();f.sheets.find(x=>x.role==='A').cells.find(c=>c.row===0&&c.col===1).string_value='CHANGED TEMPLATE HEADER';const n=writes(f).length;
 assert.equal((await s.reconcile(p.id)).state,'unknown');assert.equal(writes(f).length,n);
});
test('a concurrent prepared-plan refresh invalidates an in-flight old-hash approval before any writes',async t=>{
 const f=fixture(t),pair=f.candidate();let armed=false,entered=false,release;
 const a=f.make({readCandidate:async id=>{if(armed){armed=false;entered=true;await new Promise(r=>release=r);}return structuredClone(f.candidates.get(id));}}),b=f.make();const old=await a.prepare(pair.q);armed=true;
 const attempt=approve(a,old);while(!entered)await tick();const main=f.sheets.find(s=>s.role==='A');put(main,10,['temporary user content']);const fresh=await b.prepare(pair.q);assert.notEqual(fresh.plan_sha256,old.plan_sha256);main.cells=main.cells.filter(c=>c.row!==10);release();
 await assert.rejects(attempt,{code:'TEMPLATE_DELIVERY_PLAN_CHANGED'});await a.idle();assert.equal(writes(f).length,0);
});

test('relative, symlink root/folder and SQLite sidecars reject without a provider call',t=>{
 const f=fixture(t),deps={readCandidate:async()=>{},getDestination:()=>f.target(),client:{call:async()=>assert.fail('provider must not run')},verify:async()=>assert.fail('export must not run')};
 assert.throws(()=>createTemplateDelivery({...deps,dataRoot:'relative'}));const alias=join(f.root,'alias');symlinkSync(f.root,alias,'dir');assert.throws(()=>createTemplateDelivery({...deps,dataRoot:alias}));
 const dest=join(f.root,'other');mkdirSync(dest);const folder=join(f.root,'template-deliveries');symlinkSync(dest,folder,'dir');assert.throws(()=>createTemplateDelivery({...deps,dataRoot:f.root}));rmSync(folder);mkdirSync(folder);const secret=join(f.root,'secret');writeFileSync(secret,'fixture');
 for(const suffix of ['', '-wal','-shm']){const file=join(folder,'tasks.sqlite'+suffix);symlinkSync(secret,file);assert.throws(()=>createTemplateDelivery({...deps,dataRoot:f.root}));rmSync(file);}
});
test('offset XLSX checks reject a cached formula and wrong hyperlink despite identical displayed text',t=>{
 const root=mkdtempSync(join(tmpdir(),'template-offset-a2-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const builder=`import json,sys,zipfile
p,formula,url=sys.argv[1:]
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rns='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
with zipfile.ZipFile(p+'/book.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="'+rns+'"><sheets><sheet name="测试" r:id="s"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="s" Target="worksheets/s.xml"/></Relationships>')
 c='<c r="A8" t="str">'+('<f>HYPERLINK(&quot;https://bad.example&quot;)</f>' if formula=='yes' else '')+'<v>原文</v></c>'
 z.writestr('xl/worksheets/s.xml','<worksheet xmlns="'+ns+'" xmlns:r="'+rns+'"><sheetData><row r="8">'+c+'</row></sheetData><hyperlinks><hyperlink ref="A8" r:id="h"/></hyperlinks></worksheet>')
 z.writestr('xl/worksheets/_rels/s.xml.rels','<Relationships><Relationship Id="h" Target="'+url+'" TargetMode="External"/></Relationships>')
`;
 const expected={sheet_name:'测试',start_row:7,rows:[['原文']],links:[{row:7,col:0,url:'https://example.com/'}]};writeFileSync(join(root,'expected.json'),JSON.stringify(expected));
 const run=(formula,url)=>{execFileSync('python3',['-c',builder,root,formula,url]);return JSON.parse(execFileSync('python3',['app/template-verify.py',join(root,'book.xlsx'),join(root,'expected.json')],{encoding:'utf8'}));};
 assert.equal(run('no','https://example.com/').content,true);assert.equal(run('yes','https://example.com/').content,false);assert.equal(run('no','https://wrong.example/').links,false);
});

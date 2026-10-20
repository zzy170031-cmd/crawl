import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
const snippet=source.slice(source.indexOf('function renderTemplateDelivery('),source.indexOf('function renderTaskDetail('));
function fixture(deliveries=[]){
 const calls=[],buttons=[];
 const el=(tag,text='',className='')=>({tag,textContent:text,className,children:[],append(...xs){this.children.push(...xs);}});
 const target={file_id:'test-file',url:'https://docs.qq.com/sheet/test-target'};
 const ctx={candidateDeliveries:deliveries,qualityCapabilities:{reviewed_candidate_delivery:{enabled:true}},destination:target,structuredClone,encodeURIComponent,el,link:(text,url)=>({textContent:text,url}),button:(text,onclick)=>{const b={textContent:text,onclick};buttons.push(b);return b;},api:async(path,body)=>{calls.push({path,body});},refreshStatus:async()=>{}};
 vm.runInNewContext(snippet,ctx);
 const root=el('main'),task={id:'task-a',state:'completed'},result={status:'needs_review',result_version:'result-v',draft_sha256:'draft-hash'};
 ctx.renderTemplateDelivery(root,result,task);return {ctx,root,calls,buttons,target,task,result};
}
test('template preview and polling never write; prepare carries exact current draft and target',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.deepEqual(f.buttons.map(b=>b.textContent),['核对腾讯子表与字段']);
 await f.buttons[0].onclick();assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{path:'/api/template-deliveries/prepare',body:{task_id:'task-a',result_version:'result-v',draft_sha256:'draft-hash',target:f.target}}]);
});
test('prepared plan shows actual tab routing and approves only precise plan hash without rows',async()=>{
 const target={file_id:'test-file',url:'https://docs.qq.com/sheet/test-target'},plan={id:'plan-a',plan_sha256:'plan-hash',state:'prepared',target,candidate:{task_id:'task-a',result_version:'result-v',draft_sha256:'draft-hash'},routes:[{role:'main',name:'A游戏视频改编',sheet_id:'tab-a',start_row:1,rows:[['正文','完整台词','','']],links:[]},{role:'overview',name:'创作总览',sheet_id:'summary',start_row:3,rows:[['A']],links:[]}]};
 const f=fixture([plan]);assert.equal(f.calls.length,0);assert.deepEqual(f.buttons.map(b=>b.textContent),['按上述子表确认写入','重新核对子表']);
 await f.buttons[0].onclick();assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{path:'/api/template-deliveries/plan-a/approve',body:{plan_sha256:'plan-hash',target}}]);
 const text=JSON.stringify(f.root);assert.match(text,/A游戏视频改编/);assert.match(text,/创作总览/);assert.match(text,/完整台词/);
});
test('changed target disables old-plan approval and requests fresh read-only routing',()=>{
 const f=fixture([{id:'old',plan_sha256:'old-hash',state:'prepared',target:{file_id:'old-file',url:'https://docs.qq.com/sheet/old-target'},candidate:{task_id:'task-a',result_version:'result-v',draft_sha256:'draft-hash'},routes:[]}]);
 assert.equal(f.calls.length,0);assert.equal(f.buttons[0].textContent,'按上述子表确认写入');assert.equal(f.buttons[0].disabled,true);assert.equal(f.buttons[1].textContent,'重新核对子表');
});
test('unknown partial plan has only a read-only reconcile action and no write retry',async()=>{
 const f=fixture([{id:'partial',state:'unknown',target:{file_id:'test-file',url:'https://docs.qq.com/sheet/test-target'},candidate:{task_id:'task-a',result_version:'result-v',draft_sha256:'draft-hash'},routes:[]}]);
 assert.deepEqual(f.buttons.map(b=>b.textContent),['只读核对腾讯内容']);await f.buttons[0].onclick();assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{path:'/api/template-deliveries/partial/reconcile',body:{}}]);
});
test('newly created template links use persisted actual receipt IDs and keep creation disclosure',()=>{
 const f=fixture([{id:'created',state:'verified',target:{file_id:'test-file',url:'https://docs.qq.com/sheet/test-target'},candidate:{task_id:'task-a',result_version:'result-v',draft_sha256:'draft-hash'},templates:[{create:true,name:'A游戏视频改编',header:['字段']}],routes:[{role:'A',name:'A游戏视频改编',sheet_id:null,start_row:1,rows:[['完整稿件']],links:[]}],receipt:{routes:[{role:'A',sheet_id:'provider-generated'}],warnings:['STYLE_NOT_CERTIFIED']}}]);
 const view=JSON.stringify(f.root);assert.match(view,/provider-generated/);assert.match(view,/计划包含新子表/);assert.match(view,/字体与单元格样式未单独核验/);assert.equal(f.calls.length,0);assert.equal(f.buttons.length,0);
});

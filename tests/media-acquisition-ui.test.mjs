import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('let mediaQuote ='),source.indexOf('function openMaterial('));
const quote=(id='fixture')=>({id,request_id:'source-batch',scope:{game:'率土之滨',start_date:'2026-10-12',end_date:'2026-10-18',collected_at:'2026-10-19T10:00:00Z'},state:'quoted',items:[{source_id:'7696356432198913321',title:'测试作品'}],max_requests:1,max_points:0.6,attempted_requests:0,counts:{reused:0,ready:0,queued:1,running:0},price_note:'estimate'});
function setup(api){
 const nodes=new Map(),timers=[];
 const node=(tag,text='')=>({tag,textContent:text,children:[],open:false,append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;},showModal(){this.open=true;}});
 const context={api,$:id=>{if(!nodes.has(id))nodes.set(id,node('div'));return nodes.get(id);},el:node,date:x=>x,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},button:(label,action)=>({...node('button',label),action})};
 vm.createContext(context);vm.runInContext(code,context);
 return {context,nodes,timers};
}
test('opening quote only requests local quote; explicit confirm sends the exact quoted budget once',async()=>{
 const calls=[];const h=setup(async(path,body)=>{calls.push({path,body});return path.endsWith('/start')?{...quote(),state:'queued'}:quote();});
 await h.context.openMediaAcquisition('source-batch',['7696356432198913321']);
 assert.deepEqual(calls.map(c=>c.path),['/api/media-acquisition/quote']);
 const confirm=h.nodes.get('media-acquisition-actions').children[0];assert.match(confirm.textContent,/0.6 积分/);await confirm.action();
 assert.equal(calls[1].path,'/api/media-acquisition/start');assert.equal(calls[1].body.max_requests,1);assert.equal(calls[1].body.user_initiated,true);assert.equal(calls[1].body.quote_id,'fixture');
 await h.timers.at(-1)();assert.equal(calls[2].path,'/api/media-acquisition/fixture');assert.equal(calls[2].body,undefined);
});
test('late responses from an earlier selection cannot replace the current quote',async()=>{
 const resolvers=[];const h=setup(()=>new Promise(resolve=>resolvers.push(resolve)));
 const old=h.context.openMediaAcquisition('old',['111111111111']);
 const fresh=h.context.openMediaAcquisition('new',['222222222222']);
 resolvers[1]({...quote('new-quote'),request_id:'new',max_requests:2,max_points:1.2});await fresh;
 resolvers[0](quote('old-quote'));await old;
 assert.equal(vm.runInContext('mediaQuote.id',h.context),'new-quote');
 assert.match(h.nodes.get('media-acquisition-actions').children[0].textContent,/1.2 积分/);
});
test('closing while quote is pending does not reopen modal or start collection',async()=>{
 let resolve;const calls=[];const h=setup((path)=>{calls.push(path);return new Promise(r=>resolve=r);});
 const opening=h.context.openMediaAcquisition('source-batch');h.nodes.get('media-acquisition-dialog').open=false;resolve(quote());await opening;
 assert.equal(vm.runInContext('mediaQuote',h.context),null);assert.equal(calls.length,1);assert.equal(h.nodes.get('media-acquisition-actions').children.length,0);
});
test('failed saved links expose a new quote action, never silently renew or retry',async()=>{
 const calls=[];const failed={...quote(),state:'partial',counts:{reused:0,ready:0,queued:0,running:0,failed:1},items:[{source_id:'7696356432198913321',state:'failed',has_saved_receipt:true,error:'expired'}]};
 const h=setup(async(path,body)=>{calls.push({path,body});return calls.length===1?failed:quote('renewed');});
 await h.context.openMediaAcquisition('source-batch');assert.equal(calls.length,1);assert.equal(h.timers.length,0);
 const renew=h.nodes.get('media-acquisition-actions').children.find(n=>n.textContent.startsWith('重新解析'));
 await renew.action();assert.equal(calls[1].path,'/api/media-acquisition/quote');assert.equal(calls[1].body.renew,true);assert(!calls.some(c=>c.path.endsWith('/start')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks} from '../app/tasks.mjs';
import {startWorker,NeedsInput} from '../app/worker.mjs';

const game='受控测试游戏';
const selected={kind:'video',provider:'redfox',source_id:'1234567890123456789',title:'已确认作品',source_url:'https://www.douyin.com/video/1234567890123456789'};
const refs=['video:'+selected.source_id,'web:fixture'];
function plan(){return {game,meaning:'受控选题',fit:'expression',rationale:'使用已读作品与游戏资料',evidence_ids:refs,blocking_gaps:[],ideas:[{title:'受控草稿',hook:'开场',bridge:'游戏语境',evidence_ids:refs,script:'本地测试正文',shots:[{position:'0',visual:'画面',text:'对白',sound:'音轨'}],materials:['自制素材'],tiers:['低','中','高'].map(level=>({level,premises:[],method:'制作方式',viewer_value:'观看收益'})),limitations:[]}]};}
async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),'crawl-redfox-create-')),db=new Tasks(folder);
  let worker;t.after(async()=>{worker?.stop();db.close();await rm(folder,{recursive:true,force:true});});
  db.profile(game,{game,version:'fixture-profile',status:'ready',expires_at:new Date(Date.now()+60000).toISOString(),relevant_video_ids:Array.from({length:20},(_,i)=>'video:'+String(2234567890123456700n+BigInt(i))),evidence:[{id:'web:fixture',kind:'web',url:'https://example.com/game',title:'游戏资料',read_at:'2026-10-19T00:00:00Z'}]});
  return {db,start:options=>worker=startWorker(db,{interval:999999,browserMode:'cdp',gameProvider:'redfox',...options})};
}
for(const mode of ['A','B'])test(`Redfox ${mode} creation in default CDP mode reads selected work only and waits for draft approval`,{ skip: '固定 experimental_quality_hold 暂停此旧执行路径；保留原算法/交付断言，门禁由 quality-policy.test.mjs 单独覆盖' },async t=>{
 const {db,start}=await fixture(t);let searches=0,publishes=0,requests=0,waits=0;const media=[];
 const worker=start({
  model:{identity:async()=>({name:'fixture',digest:'fixture'}),json:async()=>plan()},
  search:async()=>{searches++;throw Error('unexpected search');},
  readMedia:async row=>{media.push(row.source_id);return {id:'video:'+row.source_id,kind:'video',url:row.source_url,title:row.title,read_at:'2026-10-19T00:00:00Z',analysis:{summary:'受控实际读取',observations:[{time:0,text:'受控观察'}],blocking_gaps:[],needs_audio_review:false}};},
  publish:async()=>{publishes++;throw Error('unapproved publish');},
  bridge:{completedDelivery:()=>null,request:(kind,payload,options)=>{requests++;assert.equal(kind,'delivery');assert.equal(payload.plan.game,game);assert.ok(payload.draft.rows.some(row=>row.includes('本地测试正文')));assert.ok(options.taskId);return {id:'approval-fixture',kind,payload};},wait:async request=>{waits++;assert.equal(request.id,'approval-fixture');throw new NeedsInput('等待用户审阅确认');}},
 });
 const task=db.create('create',{game,profile_version:'fixture-profile',source:selected,mode,format:'video',destination:null});
 await worker.tick();const result=db.get(task.id);
 assert.equal(result.state,'needs_input');assert.match(result.error,/等待用户审阅/);
 assert.deepEqual(media,[selected.source_id]);assert.equal(searches,0);assert.equal(publishes,0);assert.equal(requests,1);assert.equal(waits,1);
 assert.equal(result.result.bridge_request_id,'approval-fixture');assert.deepEqual(result.result.plan,plan());
});
test('Redfox completed delivery recovery works in CDP mode without model, source or publication replay',async t=>{
 const {db,start}=await fixture(t),receipt={warnings:[],readback_verified:true},evidence=[{id:'original-proof'}];let calls=0;
 const forbidden=async()=>{calls++;throw Error('unexpected external work');};
 const worker=start({model:{identity:forbidden,json:forbidden},search:forbidden,readMedia:forbidden,publish:forbidden,bridge:{completedDelivery:()=>({payload:{plan:plan(),evidence},result:receipt})}});
 const task=db.create('create',{game,source:selected,mode:'A',format:'video'});await worker.tick();
 assert.equal(db.get(task.id).state,'completed');assert.deepEqual(db.get(task.id).result,{plan:plan(),evidence,delivery:receipt});assert.equal(calls,0);
});

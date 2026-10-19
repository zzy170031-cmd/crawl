import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks} from '../app/tasks.mjs';
import {SideBridge} from '../app/side-bridge.mjs';
import {createRedfoxGameSource,redfoxGameScope} from '../app/redfox-game-source.mjs';
import {gameCollectionScope,bindLatestGameCollection,resolveBoundGameCollection,readLearningSnapshot} from '../app/learning-snapshot.mjs';
import {startWorker,NeedsInput} from '../app/worker.mjs';
async function setup(t) {
 const folder=await mkdtemp(join(tmpdir(),'learning-snapshot-')),db=new Tasks(folder),bridge=new SideBridge(db,{folder});
 t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});
 return {db,bridge};
}
async function collect(bridge,game='率土之滨',count=20) {
 const r=bridge.request('search',gameCollectionScope(game));
 const scope=redfoxGameScope(r.payload,r.created_at);
 const rows=Array.from({length:count},(_,i)=>({videoId:String(7696356432198913321n+BigInt(i)),videoType:'0',content:`${game} 测试 ${i}`,authorName:`作者${i}`,opusUrl:`https://www.douyin.com/video/${7696356432198913321n+BigInt(i)}`,publishTime:`${scope.end_date} 12:30:00`,duration:10000,likeCount:count-i}));
 const source=createRedfoxGameSource({apiKey:'fixture-not-secret',clock:()=>r.created_at,fetch:async()=>({status:200,redirected:false,text:async()=>JSON.stringify({code:2000,data:{list:rows,total:count,pageNum:1,pageSize:50}})})});
 bridge.fulfill(r.id,{request_id:r.id,task_id:null,result:await source.collect(r.payload)});
 return bridge.get(r.id);
}
test('binds verified query receipts and remains on the same batch across game changes',async t=>{
 const {bridge}=await setup(t),r=await collect(bridge);
 const snapshot=bindLatestGameCollection(bridge,'率土之滨');
 assert.equal(snapshot.records.length,20);assert.equal(snapshot.provenance.request_id,r.id);
 const payload={game:'率土之滨',...snapshot.binding};
 await collect(bridge,'星际猎人');
 assert.deepEqual(resolveBoundGameCollection(bridge,payload),snapshot);
 assert.throws(()=>resolveBoundGameCollection(bridge,{...payload,game:'星际猎人'}),/当前游戏/);
 assert.throws(()=>resolveBoundGameCollection(bridge,{...payload,collection_fingerprint:'bad'}),/批次已变化/);
 snapshot.records[0].title='client mutation';
 assert.notEqual(resolveBoundGameCollection(bridge,payload).records[0].title,'client mutation');
});
test('pending, failed, old-day, empty and modified receipts cannot start learning',async t=>{
 const {bridge,db}=await setup(t);
 assert.throws(()=>bindLatestGameCollection(bridge,'率土之滨'),/没有当前游戏/);
 const r=await collect(bridge);
 for(const state of ['pending','failed']) assert.throws(()=>readLearningSnapshot(bridge,{...r,state},'率土之滨'),/尚未成功/);
 const altered=structuredClone(r);altered.result.records[0].title='invented';
 assert.throws(()=>readLearningSnapshot(bridge,altered,'率土之滨'),/回执/);
 assert.throws(()=>bindLatestGameCollection(bridge,'率土之滨',new Date(Date.parse(r.created_at)+86400000)),/跨日期/);
 const empty=await collect(bridge,'空游戏',0);
 assert.throws(()=>readLearningSnapshot(bridge,empty,'空游戏'),/没有可学习/);
 // The latest failed query cannot fall back to a previous successful snapshot.
 const failed=bridge.request('search',gameCollectionScope('率土之滨'),{dedupe:false});
 db.db.prepare("UPDATE bridge_requests SET state='failed',created_at=? WHERE id=?").run(new Date(Date.parse(r.created_at)+1000).toISOString(),failed.id);
 assert.throws(()=>bindLatestGameCollection(bridge,'率土之滨'),/尚未成功/);
});
test('Redfox learning reads only bound rows, ignores old sample checkpoint and makes zero searches',async t=>{
 const {db,bridge}=await setup(t);await collect(bridge);
 const snapshot=bindLatestGameCollection(bridge,'率土之滨');
 const task=db.create('learn',{game:'率土之滨',...snapshot.binding});
 db.checkpoint('samples:'+task.id,[{source_id:'12345678999',title:'old wrong game'}]);
 let searches=0,modelCalls=0,read=[];
 const worker=startWorker(db,{bridge,gameProvider:'redfox',browserMode:'side-browser',interval:999999,
  model:{identity:async()=>{modelCalls++;return {name:'fixture'};}},
  search:async()=>{searches++;throw Error('unexpected paid search');},
  fingerprintMedia:async()=>null,
  readMedia:async row=>{read.push(row);throw new NeedsInput('test stops before any real analysis');},
 });t.after(()=>worker.stop());
 await worker.tick();
 assert.equal(db.get(task.id).state,'needs_input');assert.equal(modelCalls,1);assert.equal(searches,0);
 assert.equal(read.length,1);assert.equal(read[0].collection_request_id,snapshot.binding.collection_request_id);
 assert.equal(bridge.status().pending.length,0);
 const old=db.create('learn',{game:'率土之滨'},'legacy');
 await worker.tick();assert.equal(db.get(old.id).state,'needs_input');assert.match(db.get(old.id).error,/未绑定/);
 assert.equal(modelCalls,1);assert.equal(searches,0);assert.equal(bridge.status().pending.length,0);
});
test('same-task checkpoint recovery preserves old read time and counts reuse, not new reads',async t=>{
 const {db,bridge}=await setup(t);await collect(bridge);
 const snapshot=bindLatestGameCollection(bridge,'率土之滨');
 const task=db.create('learn',{game:'率土之滨',...snapshot.binding});
 const originalRead='2026-10-18T01:00:00.000Z';
 for(const row of snapshot.records)db.checkpoint('video-evidence:'+task.id+':'+row.source_id,{
  id:'video:'+row.source_id,kind:'video',url:row.source_url,read_at:originalRead,media_fingerprint:'fp:'+row.source_id,
  analysis:{needs_audio_review:false,blocking_gaps:[]},subtitle_review:{status:'reviewed_no_changes'},
 });
 let reads=0,searches=0;
 const worker=startWorker(db,{bridge,gameProvider:'redfox',browserMode:'side-browser',interval:999999,
  model:{identity:async()=>({name:'fixture'})},fingerprintMedia:async row=>'fp:'+row.source_id,
  readMedia:async()=>{reads++;throw Error('must reuse');},search:async()=>{searches++;throw Error('must not search');},
  web:async()=>{throw new NeedsInput('test stops before research');},
 });t.after(()=>worker.stop());await worker.tick();
 const result=db.get(task.id).result;
 assert.equal(reads,0);assert.equal(searches,0);
 assert.equal(result.progress.newly_read_count,0);assert.equal(result.progress.reused_count,20);
 assert.equal(result.progress.verified_count,20);
 assert(result.evidence.every(e=>e.read_at===originalRead&&e.reused_from.task_id===task.id&&e.reused_from.read_at===originalRead));
});

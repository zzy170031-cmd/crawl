import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tasks} from '../app/tasks.mjs';
import {SideBridge} from '../app/side-bridge.mjs';
import {createRedfoxGameSource,redfoxGameScope} from '../app/redfox-game-source.mjs';
import {createRedfoxHotspotSource,redfoxHotspotScope} from '../app/redfox-hotspot-source.mjs';
import {gameCollectionScope} from '../app/learning-snapshot.mjs';
import {createMediaAcquisition} from '../app/media-acquisition.mjs';
import {RedfoxAssetError} from '../app/redfox-assets.mjs';
const missing=()=>{throw new RedfoxAssetError('这条视频尚未取得原片；受控测试');};
async function setup(t,overrides={},rowCount=3) {
 const folder=await mkdtemp(join(tmpdir(),'media-acquisition-')),db=new Tasks(folder),bridge=new SideBridge(db,{folder});
 const request=bridge.request('search',gameCollectionScope('率土之滨'));
 const scope=redfoxGameScope(request.payload,request.created_at);
 const rows=Array.from({length:rowCount},(_,i)=>({videoId:String(7696356432198913321n+BigInt(i)),videoType:'0',content:`率土之滨 测试 ${i}`,authorName:`作者${i}`,opusUrl:`https://www.douyin.com/video/${7696356432198913321n+BigInt(i)}`,publishTime:`${scope.end_date} 12:30:00`,duration:10000,likeCount:rowCount-i}));
 const source=createRedfoxGameSource({apiKey:'fixture',clock:()=>request.created_at,fetch:async()=>({status:200,redirected:false,text:async()=>JSON.stringify({code:2000,data:{list:rows,total:rowCount,pageNum:1,pageSize:50}})})});
 bridge.fulfill(request.id,{request_id:request.id,task_id:null,result:await source.collect(request.payload)});
 const counts={resolve:0,download:0,import:0,prepare:0,cleanup:0},available=new Set();
 const options={db,bridge,autoStart:false,preflight:async()=>{},assets:{read:async row=>available.has(row.source_id)?{verified:true}:missing(),importLocal:async row=>{counts.import++;available.add(row.source_id);}},resolver:{resolve:async row=>{counts.resolve++;return {response:{fixture:true},source_id:row.source_id,started_at:request.created_at,received_at:request.created_at};}},download:async()=>{counts.download++;return {sourcePath:'fixture-only',cleanup:async()=>{counts.cleanup++;}};},prepare:async()=>{counts.prepare++;},...overrides};
 const manager=createMediaAcquisition(options);t.after(async()=>{await manager.stop();db.close();await rm(folder,{recursive:true,force:true});});
 const ids=rows.map(r=>r.videoId);
 return {db,bridge,manager,options,counts,available,request,ids,quote:extra=>manager.quote({request_id:request.id,source_ids:ids,...extra}),start:q=>manager.start({quote_id:q.id,user_initiated:true,max_requests:q.max_requests})};
}
test('quote/status are free; exact budget and explicit initiation precede acquisition',async t=>{
 const h=await setup(t),q=await h.quote();
 assert.equal(q.max_requests,3);assert.equal(q.max_points,1.8);assert.equal(q.scope.purpose,'game-research');
 assert.equal(q.scope.game,'率土之滨');assert.equal(h.counts.resolve,0);
 assert.throws(()=>h.manager.start({quote_id:q.id,max_requests:3}),/明确确认/);
 assert.throws(()=>h.manager.start({quote_id:q.id,user_initiated:true,max_requests:4}),/明确确认/);
 await h.manager.tick();assert.equal(h.counts.resolve,0);
 h.start(q);h.start(q);await h.manager.tick();await h.manager.tick();await h.manager.tick();await h.manager.tick();
 assert.equal(h.manager.status(q.id).state,'completed');assert.equal(h.counts.resolve,3);assert.equal(h.counts.download,3);assert.equal(h.counts.import,3);assert.equal(h.counts.prepare,3);assert.equal(h.counts.cleanup,3);
 const publicStatus=JSON.stringify(h.manager.status(q.id));assert(!publicStatus.includes('fixture-only'));assert(!publicStatus.includes('response'));
 h.start(q);await h.manager.tick();assert.equal(h.counts.resolve,3);
});
test('cache reuse reduces budget and never repeats a parse or download',async t=>{
 const h=await setup(t);h.available.add(h.ids[0]);const q=await h.quote();assert.equal(q.max_requests,2);assert.equal(q.counts.cached,1);
 h.start(q);await h.manager.tick();await h.manager.tick();await h.manager.tick();
 assert.equal(h.counts.resolve,2);const again=await h.quote();assert.equal(again.max_requests,0);h.start(again);await h.manager.tick();await h.manager.tick();await h.manager.tick();assert.equal(h.manager.status(again.id).state,'completed');assert.equal(h.counts.resolve,2);
});
test('invalid selection, failed or altered query receipts cannot authorize acquisition',async t=>{
 const h=await setup(t);
 for(const source_ids of [[],['1234567890123'],[h.ids[0],h.ids[0]],Array(31).fill(h.ids[0])])await assert.rejects(h.quote({source_ids}));
 const q=await h.quote();
 const r=h.bridge.get(h.request.id);r.result.records[0].title='invented';h.db.db.prepare('UPDATE bridge_requests SET result=? WHERE id=?').run(JSON.stringify(r.result),r.id);
 assert.throws(()=>h.start(q),/回执/);await assert.rejects(h.quote(),/回执/);assert.equal(h.counts.resolve,0);
});
test('expired budget and cancelled unstarted queue incur no resolver attempts',async t=>{
 let now=Date.now();const h=await setup(t,{clock:()=>now});const q=await h.quote();now+=16*60000;assert.throws(()=>h.start(q),/失效/);
 const next=await h.quote();h.start(next);h.manager.cancel(next.id);await h.manager.tick();assert.equal(h.counts.resolve,0);assert.equal(h.manager.status(next.id).counts.cancelled,3);
});
test('expiry during batch stops remaining calls instead of spending old authorization',async t=>{
 let now=Date.now();const h=await setup(t,{clock:()=>now});const q=await h.quote();h.start(q);await h.manager.tick();now+=19*60000;
 await h.manager.tick();await h.manager.tick();assert.equal(h.counts.resolve,1);assert.equal(h.manager.status(q.id).counts.failed,2);
});
test('resolver failure is terminal and does not auto retry on poll, start or restart',async t=>{
 let calls=0;const h=await setup(t,{resolver:{resolve:async()=>{calls++;throw Error('upstream secret');}}});const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);await h.manager.tick();h.start(q);await h.manager.tick();
 const restarted=createMediaAcquisition(h.options);await restarted.tick();await restarted.stop();
 assert.equal(calls,1);assert.equal(h.manager.status(q.id).attempted_requests,1);assert.equal(h.manager.status(q.id).counts.failed,1);assert(!JSON.stringify(h.manager.status(q.id)).includes('upstream secret'));
});
test('saved receipt survives failed download; explicit retry reuses it without another paid parse',async t=>{
 let attempts=0;const h=await setup(t,{download:async()=>{attempts++;throw Error('expired private CDN URL');}});
 const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);await h.manager.tick();assert.equal(h.counts.resolve,1);
 const retry=await h.quote({source_ids:[h.ids[0]]});assert.equal(retry.max_requests,0);assert.equal(retry.items[0].has_saved_receipt,true);h.start(retry);await h.manager.tick();
 assert.equal(attempts,2);assert.equal(h.counts.resolve,1);
 const renew=await h.quote({source_ids:[h.ids[0]],renew:true});assert.equal(renew.max_requests,1);assert.equal(h.counts.resolve,1);h.start(renew);await h.manager.tick();assert.equal(h.counts.resolve,2);
});
test('already active selection is reused and concurrent workers cannot double claim',async t=>{
 let release,entered;const started=new Promise(r=>entered=r);
 const h=await setup(t,{resolver:{resolve:()=>{entered();return new Promise(r=>release=r);}}});const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);const tick=h.manager.tick();await started;
 const duplicate=await h.quote({source_ids:[h.ids[0]]});assert.equal(duplicate.id,q.id);
 const second=createMediaAcquisition(h.options);await second.tick();assert.equal(h.manager.status(q.id).attempted_requests,1);
 release({response:{},started_at:h.request.created_at,received_at:h.request.created_at});await tick;await second.stop();assert.equal(h.counts.import,1);
});
test('cancel in flight aborts further download/import and remaining queued rows',async t=>{
 let entered;const started=new Promise(r=>entered=r);
 const h=await setup(t,{resolver:{resolve:(_row,{signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})}});
 const q=await h.quote();h.start(q);const run=h.manager.tick();await started;h.manager.cancel(q.id);await run;await h.manager.tick();
 const state=h.manager.status(q.id);assert.equal(state.attempted_requests,1);assert.equal(state.counts.cancelled,3);assert.equal(h.counts.download,0);assert.equal(h.counts.import,0);
});
test('process restart marks an expired attempted lease interrupted without replay',async t=>{
 const h=await setup(t);const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);
 h.db.db.prepare("UPDATE media_items SET state='running',attempts=1,owner='dead',lease=1 WHERE quote_id=?").run(q.id);
 await h.manager.tick();assert.equal(h.manager.status(q.id).counts.interrupted,1);assert.equal(h.counts.resolve,0);
});
test('corrupted existing assets are blocked, never overwritten or charged',async t=>{
 const h=await setup(t,{assets:{read:async()=>{throw new RedfoxAssetError('hash mismatch');},importLocal:async()=>{throw Error('must not write');}}});
 const q=await h.quote();assert.equal(q.max_requests,0);assert.equal(q.counts.blocked,3);h.start(q);await h.manager.tick();assert.equal(h.counts.resolve,0);assert.equal(h.manager.status(q.id).state,'partial');
});
test('cached original still prepares missing derived media, and prepare failure never reports completed',async t=>{
 let preparations=0;const h=await setup(t,{prepare:async()=>{preparations++;throw Error('ffmpeg failed');}});h.available.add(h.ids[0]);
 const q=await h.quote({source_ids:[h.ids[0]]});assert.equal(q.max_requests,0);assert.equal(q.counts.cached,1);h.start(q);await h.manager.tick();
 assert.equal(preparations,1);assert.equal(h.counts.resolve,0);assert.equal(h.manager.status(q.id).state,'partial');
});
test('overlapping pre-approved quotes reuse a receipt acquired after quoting, without another paid parse',async t=>{
 const h=await setup(t,{download:async()=>{throw Error('expired link');}});
 const first=await h.quote({source_ids:[h.ids[0]]}),second=await h.quote({source_ids:[h.ids[0]]});h.start(first);h.start(second);
 await h.manager.tick();await h.manager.tick();assert.equal(h.counts.resolve,1);assert.equal(h.manager.status(second.id).attempted_requests,0);
});
test('unrecognized resolver receipt is retained and can be replayed without another paid resolve',async t=>{
 let calls=0;
 const h=await setup(t,{resolver:{resolve:async(row,{onReceipt})=>{
  calls++;await onReceipt({status:'unvalidated',source_id:row.source_id,source_url:row.source_url,started_at:new Date().toISOString(),received_at:new Date().toISOString(),response:{code:2000,data:{desc:row.title,videoUrl:'https://unreviewed.invalid/private'}}});throw Error('unrecognized host');
 }}});
 const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);await h.manager.tick();assert.equal(h.manager.status(q.id).items[0].has_saved_receipt,true);
 const retry=await h.quote({source_ids:[h.ids[0]]});assert.equal(retry.max_requests,0);h.start(retry);await h.manager.tick();assert.equal(calls,1);assert.equal(h.counts.download,0);assert.equal(h.manager.status(retry.id).state,'partial');
 assert(!JSON.stringify(h.manager.status(retry.id)).includes('unreviewed.invalid'));
});
test('hotspot originals bind the exact board/category/time receipt and reject a game-only selection',async t=>{
 const h=await setup(t),r=h.bridge.request('search',{provider:'redfox',purpose:'hotspots',board:'redfox_daily_hot',hours:24,category:'游戏',keyword:'',sort:'likes'});
 const scope=redfoxHotspotScope(r.payload,r.created_at),id='7697943133530672410';
 const source=createRedfoxHotspotSource({apiKey:'fixture',clock:()=>r.created_at,fetch:async()=>({status:200,text:async()=>JSON.stringify({code:2000,data:[{workId:id,workUrl:`https://www.iesdouyin.com/share/video/${id}`,workType:'0',content:'热门游戏视频',title:'热门游戏视频',accountName:'作者',category:'游戏',duration:42000,publishTime:scope.end_date+' 12:00:00',likeCount:100}]})})});
 h.bridge.fulfill(r.id,{request_id:r.id,task_id:null,result:await source.collect(r.payload)});
 const q=await h.manager.quote({request_id:r.id,source_ids:[id]});assert.equal(q.scope.purpose,'hotspots');assert.equal(q.scope.category,'游戏');assert.equal(q.scope.start_date,scope.start_date);assert.equal(q.max_requests,1);
 await assert.rejects(h.manager.quote({request_id:r.id,source_ids:[h.ids[0]]}),/不属于/);
 h.start(q);await h.manager.tick();assert.equal(h.manager.status(q.id).state,'completed');assert.equal(h.counts.resolve,1);
});

test('twenty-item batch resumes after budget expiry without paying for completed assets again',async t=>{
 let now=Date.now();const h=await setup(t,{clock:()=>now},20);
 const quote=await h.quote();assert.equal(quote.max_requests,20);h.start(quote);
 for(let i=0;i<8;i++)await h.manager.tick();
 now+=121*60000;
 for(let i=0;i<12;i++)await h.manager.tick();
 const partial=h.manager.status(quote.id);assert.equal(partial.counts.ready,8);assert.equal(partial.counts.failed,12);assert.equal(h.counts.resolve,8);
 const resumed=await h.quote();assert.equal(resumed.max_requests,12);assert.equal(resumed.counts.cached,8);h.start(resumed);
 for(let i=0;i<20;i++)await h.manager.tick();
 const complete=h.manager.status(resumed.id);assert.equal(complete.state,'completed');assert.equal(complete.counts.reused,8);assert.equal(complete.counts.ready,12);assert.equal(h.counts.resolve,20);assert.equal(h.counts.import,20);
 h.start(resumed);await h.manager.tick();assert.equal(h.counts.resolve,20);
});
test('cancellation during cached preparation remains cancelled even when prepare resolves late',async t=>{
 let entered,release;const preparing=new Promise(r=>entered=r);
 const h=await setup(t,{prepare:()=>{entered();return new Promise(r=>release=r);}});h.available.add(h.ids[0]);
 const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);const run=h.manager.tick();await preparing;
 h.manager.cancel(q.id);release();await run;
 const state=h.manager.status(q.id);assert.equal(state.counts.cancelled,1);assert.equal(state.counts.reused,0);assert.equal(h.counts.resolve,0);
});

test('confirmed twenty-item budget remains usable after quote window but has a fixed execution deadline',async t=>{
 let now=Date.now();const h=await setup(t,{clock:()=>now},20),q=await h.quote();assert.equal(Date.parse(q.expires_at)-now,15*60000);
 const started=h.start(q);assert.equal(Date.parse(started.expires_at)-now,120*60000);assert.equal(started.max_requests,20);
 now+=16*60000;for(let i=0;i<20;i++)await h.manager.tick();assert.equal(h.manager.status(q.id).state,'completed');assert.equal(h.counts.resolve,20);
 const oldDeadline=h.manager.status(q.id).expires_at;now+=1000;h.start(q);assert.equal(h.manager.status(q.id).expires_at,oldDeadline);assert.equal(h.counts.resolve,20);
});

test('missing media tools reject quote before any resolver/download or new quote is created',async t=>{
 const {MediaToolsError}=await import('../app/media-tools.mjs');const h=await setup(t,{preflight:async()=>{throw new MediaToolsError([{tool:'ffmpeg',reason:'ENOENT'},{tool:'ffprobe',reason:'ENOENT'}]);}});
 await assert.rejects(h.quote(),{code:'MEDIA_TOOLS_UNAVAILABLE'});assert.equal(h.counts.resolve,0);assert.equal(h.counts.download,0);assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM media_quotes').get().n,0);
});
test('tools disappearing after quote fail before new paid parsing and do not replay on poll',async t=>{
 const {MediaToolsError}=await import('../app/media-tools.mjs');let checks=0;const h=await setup(t,{preflight:async()=>{checks++;if(checks>1)throw new MediaToolsError([{tool:'ffprobe',reason:'ENOENT'}]);}});const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);await h.manager.tick();await h.manager.tick();const state=h.manager.status(q.id);assert.equal(state.state,'partial');assert.equal(state.attempted_requests,0);assert.equal(h.counts.resolve,0);assert.equal(h.counts.download,0);assert.match(state.items[0].error,/ffprobe/);assert.equal(checks,2);
});
test('cached resolver receipt with no raw media still requires available tools before free retry',async t=>{
 const {MediaToolsError}=await import('../app/media-tools.mjs');let unavailable=false;const h=await setup(t,{preflight:async()=>{if(unavailable)throw new MediaToolsError([{tool:'ffmpeg',reason:'ENOENT'}]);},download:async()=>{throw Error('controlled first failure');}});const q=await h.quote({source_ids:[h.ids[0]]});h.start(q);await h.manager.tick();assert.equal(h.counts.resolve,1);unavailable=true;await assert.rejects(h.quote({source_ids:[h.ids[0]]}),{code:'MEDIA_TOOLS_UNAVAILABLE'});assert.equal(h.counts.resolve,1);assert.equal(h.counts.download,0);
});

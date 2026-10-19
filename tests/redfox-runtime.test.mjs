import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRedfoxRuntime,redfoxCredentialReader,saveRedfoxCredential} from '../app/redfox-runtime.mjs';
import {createReadiness} from '../app/readiness.mjs';
import {Tasks} from '../app/tasks.mjs';
import {SideBridge} from '../app/side-bridge.mjs';
import {startCollectionWorker} from '../app/collection-worker.mjs';
function setup({collect=async()=>({records:[],failures:[]}),configured=true}={}) {
 const calls=[];
 const browser={status:()=>({state:'verification_required',recovery_scope_key:'blocked-scope'}),probe:async site=>{calls.push(['probe',site]);return {state:'verification_required'};},collect:async payload=>{calls.push(['browser',payload]);return {};},cancelOperation:async()=>calls.push(['cancel-browser']),close:async()=>{},login:async()=>{}};
 const source={checkConnection:async()=>({configured,live_verified:false}),collect:async(...args)=>{calls.push(['api',args[0]]);return collect(...args);}};
 return {calls,browser,runtime:createRedfoxRuntime({browser,gameSource:source,hotspotSource:source,gameProvider:'redfox',hotspotProvider:'redfox',clock:()=>new Date('2026-10-19T00:00:00Z')})};
}
const game={purpose:'game-research',keyword:'率土之滨',provider:'redfox'};
test('configuration probes and status never collect or misrepresent a browser login',async()=>{
 const {runtime,calls}=setup();const result=await runtime.probe('douyin');
 assert.equal(result.state,'configured');assert.equal(result.capabilities.live_verified,false);assert.equal(result.capabilities.requires_browser_login,false);
 const status=await runtime.status();assert.equal(status.state,'verification_required');assert.equal(status.game_source,'redfox');assert.deepEqual(calls,[]);
});
test('explicit provider routing excludes old browser searches and preserves browser courses',async()=>{
 const {runtime,calls}=setup();assert.equal(runtime.requestAllowed({...game,provider:undefined}),false);
 await assert.rejects(runtime.collect({...game,provider:undefined}));
 await runtime.collect(game);await runtime.collect({purpose:'courses',provider:'browser'});
 assert.deepEqual(calls.map(x=>x[0]),['api','browser']);assert.equal((await runtime.probe('douyin')).capabilities.last_verified_at,'2026-10-19T00:00:00.000Z');
});
test('configuration errors and transport secrets stay off public surfaces',async()=>{
 const secret='ak_unit_secret_do_not_show';const {runtime}=setup({collect:async()=>{throw Error(secret);}});
 await assert.rejects(runtime.collect(game),error=>!error.message.includes(secret));assert.equal((await runtime.probe('douyin')).capabilities.live_verified,false);
 const unavailable=setup({configured:false});await assert.rejects(unavailable.runtime.collect(game));assert.equal(unavailable.calls.length,0);
});
test('API cancellation aborts the request without touching browser pages',async()=>{
 let received;const {runtime,calls}=setup({collect:async(_,{signal})=>{received=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 const pending=runtime.collect(game);while(!received)await new Promise(r=>setImmediate(r));await runtime.cancelOperation();await assert.rejects(pending);await runtime.cancelOperation();assert.ok(received.aborted);assert.ok(!calls.some(x=>x[0]==='cancel-browser'));
});
test('readiness permits configured collection while unrelated Tencent is unavailable',async()=>{
 const {runtime}=setup();const gate=createReadiness({collector:runtime});gate.check(['douyin','douhot']);const state=await gate.settled();assert.equal(state.ready,false);assert.equal(state.collection_ready,true);assert.equal(state.game_collection_ready,true);assert.equal(state.hotspot_collection_ready,true);
});
test('API credentials are private, dynamically reloadable and absent from runtime outputs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'redfox-runtime-'));try{const path=join(dir,'secret.json');const getter=redfoxCredentialReader(path,()=> 'fallback');assert.equal(await getter(),'fallback');const value='ak_unit_test_credential_123456';await saveRedfoxCredential(path,value);assert.equal(await getter(),value);assert.equal((await stat(path)).mode&0o777,0o600);await assert.rejects(saveRedfoxCredential(path,'invalid'));}finally{await rm(dir,{recursive:true,force:true});}
});
test('queue bypasses browser challenge only for explicit API and never replays attempted paid jobs',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'redfox-queue-'));const db=new Tasks(folder),bridge=new SideBridge(db);let calls=0;
 const {runtime}=setup({collect:async()=>{calls++;throw Error('controlled transport failure');}});
 const worker=startCollectionWorker({db,bridge,store:{import:()=>{}},collector:runtime,enabled:true,autoStart:false,canRun:payload=>payload.provider==='redfox'});
 t.after(async()=>{await worker.stop();db.close();await rm(folder,{recursive:true,force:true});});
 db.setting('collector-blocked',{code:'VERIFICATION_REQUIRED',site:'douhot'});
 // Raw persisted requests deliberately avoid depending on another lane's schema edits.
 const request=bridge.request('search',{purpose:'game-research',keyword:'率土之滨'});
 db.db.prepare('UPDATE bridge_requests SET payload=? WHERE id=?').run(JSON.stringify(game),request.id);
 assert.equal(await worker.runOnce(),true);assert.equal(calls,1);assert.equal(db.setting('collector-blocked').site,'douhot');
 db.db.prepare("UPDATE bridge_requests SET state='pending' WHERE id=?").run(request.id);
 assert.equal(await worker.runOnce(),false);assert.equal(calls,1);
});
test('only locally classified adapter failures retain safe diagnostics',async()=>{
 const {RedfoxSourceError}=await import('../app/redfox-error.mjs');
 const {runtime}=setup({collect:async()=>{throw new RedfoxSourceError('查询日期已变化，未调用红狐；请重新点击开始查询','SOURCE_SCOPE_MISMATCH');}});
 await assert.rejects(runtime.collect(game),e=>e.code==='SOURCE_SCOPE_MISMATCH'&&e.message.includes('未调用红狐'));
});

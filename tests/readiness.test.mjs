import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadiness, probeTencent } from '../app/readiness.mjs';
import { TencentClient, saveTencentCredential, loadTencentToken } from '../app/tencent-client.mjs';
const tools = ['sheet_get_sheet_info','sheet_get_cell_data','sheet_add_sheet','sheet_set_range_value','sheet_set_link','sheet_set_cell_style','sheet_set_dimension_size'];
const fakeClient = () => ({names:new Map(tools.map(x=>[x,x])),init:async()=>{},call:async(name)=>{assert.equal(name,'sheet_get_sheet_info');return {sheets:[]};}});
const target = {file_id:'test-file'};

test('readiness does real probes once, starts checking immediately, expires and does not assert writing', async()=>{
 let time=100000, calls=[], kicked=0;
 const gate=createReadiness({collector:{probe:async id=>{calls.push(id);return {state:'ready',message:'source available'};}},client:fakeClient(),target,now:()=>time,ttlMs:1000,onReady:()=>kicked++});
 assert.equal(gate.status().ready,false);
 assert.equal(gate.check().checking,true);gate.check();
 const done=await gate.settled();
 assert.equal(done.ready,true);assert.deepEqual(calls,['douyin','douhot']);assert.equal(kicked,1);
 assert.equal(done.sites[2].capabilities.write_permission_verified,false);
 time+=1001;assert.equal(gate.status().ready,false);assert.equal(gate.status().sites[0].state,'unknown');
});

test('login/verification and invalidation cannot be overwritten by an old in-flight result', async()=>{
 let release;const delay=new Promise(r=>release=r);
 const gate=createReadiness({collector:{probe:async id=>{if(id==='douyin')await delay;return {state:id==='douyin'?'ready':'verification_required',message:'state'};}},client:fakeClient(),target});
 gate.check();await Promise.resolve();gate.invalidate('douyin',{state:'login_required',message:'session expired'});release();
 const result=await gate.settled();assert.equal(result.ready,false);assert.equal(result.sites[0].state,'login_required');assert.equal(result.sites[1].state,'verification_required');
});

test('credential changes during a check trigger a fresh Tencent-only probe', async()=>{
 let release;let count=0;const client=fakeClient();client.init=async()=>{count++;if(count===1)await new Promise(r=>release=r);};
 const gate=createReadiness({collector:{probe:async()=>({state:'ready'})},client,target});
 gate.check();while(!release)await new Promise(r=>setImmediate(r));
 gate.invalidate('tencent');gate.check(['tencent']);release();
 assert.equal((await gate.settled()).ready,true);assert.equal(count,2);
});

test('Tencent missing config, rejected auth and absent capabilities do not become ready', async()=>{
 const client=fakeClient();assert.equal((await probeTencent({client,target:null})).state,'configuration_required');
 client.init=async()=>{throw Object.assign(Error('DO NOT LEAK secret'),{code:'AUTH_REQUIRED'});};
 const failure=await probeTencent({client,target});assert.equal(failure.state,'login_required');assert.ok(!JSON.stringify(failure).includes('secret'));
 const missing=fakeClient();missing.names.delete('sheet_set_range_value');assert.equal((await probeTencent({client:missing,target})).state,'failed');
});

test('local credential is atomic, private, validates input and honors environment priority',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'readiness-'));const path=join(dir,'creds','token.json');const token='unit-test-only-token-012345';
 try{
  await saveTencentCredential(token,{env:{},path});assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal(await loadTencentToken({env:{},path}),token);
  const replacement='replacement-test-only-token';await saveTencentCredential(replacement,{env:{},path});assert.equal(await loadTencentToken({env:{},path}),replacement);
  assert.equal(await loadTencentToken({env:{TENCENT_DOCS_TOKEN:token},path}),token);
  await assert.rejects(saveTencentCredential('bad\ncredential',{env:{},path}));
  await assert.rejects(saveTencentCredential(replacement,{env:{TENCENT_DOCS_TOKEN:token},path}),/环境变量/);
  assert.equal(JSON.parse(await readFile(path,'utf8')).token,replacement);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Tencent client resets session on credential replacement and sends no writes during probe',async()=>{
 let token='first-test-token-0000000';const requests=[];
 const client=new TencentClient({tokenProvider:()=>token,fetchImpl:async(url,options)=>{
  assert.equal(url,'https://docs.qq.com/openapi/mcp');const request=JSON.parse(options.body);requests.push(request);
  const result=request.method==='tools/list'?{tools:tools.map(name=>({name}))}:request.method==='tools/call'?{structuredContent:{sheets:[]}}:{};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'mcp-session-id':'fixture'}});
 }});
 assert.equal((await probeTencent({client,target})).state,'ready');token='second-test-token-000000';
 assert.equal((await probeTencent({client,target})).state,'ready');
 assert.equal(requests.filter(x=>x.method==='initialize').length,2);
 assert.deepEqual(requests.filter(x=>x.method==='tools/call').map(x=>x.params.name),['sheet_get_sheet_info','sheet_get_sheet_info']);
});

test('HTTP preflight gate blocks independent clients without queueing and protects credential endpoint',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const dir=await mkdtemp(join(tmpdir(),'readiness-http-'));const port=14783;
 const {Tasks}=await import('../app/tasks.mjs');const seed=new Tasks(dir);const task=seed.create('learn',{game:'门禁测试'});seed.claim('seed');seed.finish(task.id,'seed','failed',null,'preserved failure');seed.db.close();
 const child=spawn(process.execPath,[fileURLToPath(new URL('../app/server.mjs',import.meta.url))],{env:{...process.env,PORT:String(port),CRAWL_DATA_DIR:dir,CRAWL_SEARCH_MODE:'automatic'},stdio:'pipe'});
 let errors='';child.stderr.on('data',b=>errors+=b);
 try{
  const base='http://127.0.0.1:'+port;let ready=false;
  for(let i=0;i<60;i++){try{ready=(await fetch(base+'/api/session')).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert(ready,errors);
  for(let browser=0;browser<2;browser++){
   const {token}=await(await fetch(base+'/api/session')).json();
   const headers={'Content-Type':'application/json','x-crawl-token':token};
   const status=await(await fetch(base+'/api/readiness')).json();assert.equal(status.ready,false);assert.equal(status.enabled,true);
   const response=await fetch(base+'/api/game-search',{method:'POST',headers,body:JSON.stringify({game:'星际猎人'})});
   assert.equal(response.status,409);assert.equal((await response.json()).code,'CONNECTIONS_NOT_READY');
   const bridge=await(await fetch(base+'/api/bridge/status')).json();assert.equal(bridge.pending.length,0);
   const retry=await fetch(base+'/api/tasks/'+task.id+'/retry',{method:'POST',headers,body:'{}'});assert.equal(retry.status,409);
   const preserved=await(await fetch(base+'/api/tasks/'+task.id)).json();assert.equal(preserved.state,'failed');
   const malicious=await fetch(base+'/api/readiness/tencent-credential',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify({token:'fixture-only-token'})});assert.equal(malicious.status,403);
   const arbitrary=await fetch(base+'/api/readiness/tencent-credential',{method:'POST',headers,body:JSON.stringify({token:'fixture-only-token',path:'/tmp/never'})});assert.equal(arbitrary.status,400);
  }
 } finally {child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(dir,{recursive:true,force:true});}
});

test('busy collection finishes before probes, including TTL refresh; no cancellation or false failure',async()=>{
 let busy=true, now=10000, probes=0, closeCalls=0;
 const collector={
  probe:async()=>{probes++;if(busy)throw Object.assign(Error('busy'),{code:'COLLECTOR_BUSY'});return {state:'ready',message:'verified'};},
  close:async()=>closeCalls++,
 };
 const gate=createReadiness({collector,target,client:fakeClient(),now:()=>now,ttlMs:10,timeoutMs:500,busyRetryMs:5});
 gate.check();await new Promise(r=>setTimeout(r,15));
 assert.equal(gate.status().checking,true);assert.equal(gate.status().sites[0].state,'checking');assert.match(gate.status().sites[0].message,/等待/);
 busy=false;assert.equal((await gate.settled()).ready,true);assert.ok(probes>2);assert.equal(closeCalls,0);
 now+=11;assert.equal(gate.status().ready,false);
 busy=true;gate.check();await new Promise(r=>setTimeout(r,15));assert.equal(gate.status().sites[0].state,'checking');
 busy=false;assert.equal((await gate.settled()).ready,true);assert.equal(closeCalls,0);
});

test('persistent collector busy is bounded and remains unknown, never a login or source failure',async()=>{
 let closes=0;
 const gate=createReadiness({collector:{probe:async()=>{throw Object.assign(Error('busy'),{code:'COLLECTOR_BUSY'});},close:async()=>closes++},target,client:fakeClient(),timeoutMs:25,busyRetryMs:2});
 gate.check();const result=await gate.settled();
 assert.equal(result.ready,false);assert.equal(result.checking,false);
 assert.ok(result.sites.every(x=>x.state==='unknown'));
 assert.equal(closes,0);
});

test('server scheduler refreshes expired connections without UI and cools down busy outcomes',async()=>{
 const {startReadinessScheduler}=await import('../app/readiness.mjs');
 let now=10000,checks=[],login=false;let state={checking:false,sites:[{id:'douyin',state:'unknown'},{id:'douhot',state:'login_required'},{id:'tencent',state:'failed'}]};
 const readiness={status:()=>state,check:ids=>{checks.push(ids);state={...state,checking:true};return state;}};
 const scheduler=startReadinessScheduler({readiness,collector:{status:async()=>({state:login?'login_open':'idle'})},enabled:true,autoStart:false,now:()=>now,cooldownMs:30});
 assert.equal(await scheduler.tick(),true);assert.deepEqual(checks,[['douyin']]);
 state.checking=false;assert.equal(await scheduler.tick(),false);now+=29;assert.equal(await scheduler.tick(),false);
 now++;login=true;assert.equal(await scheduler.tick(),false);assert.equal(checks.length,1);
 login=false;assert.equal(await scheduler.tick(),true);assert.equal(checks.length,2);
 state.checking=false;state.sites=[{id:'douyin',state:'ready'},{id:'douhot',state:'failed'},{id:'tencent',state:'configuration_required'}];
 await scheduler.tick();now+=100;assert.equal(await scheduler.tick(),false);assert.equal(checks.length,2);
 scheduler.stop();
});


test('first setup missing both authorization and target exposes authorization before link configuration',async()=>{
 let authorized=false, inits=0, reads=0;
 const client=fakeClient();
 client.init=async()=>{inits++;if(!authorized)throw Object.assign(Error('secret detail'),{code:'CREDENTIAL_REQUIRED'});};
 client.call=async name=>{reads++;assert.equal(name,'sheet_get_sheet_info');return{sheets:[]};};
 const first=await probeTencent({client,target:null});
 assert.equal(first.state,'configuration_required');assert.equal(first.reauthorization_required,true);
 assert.match(first.message,/授权/);assert(!first.message.includes('secret'));assert.equal(reads,0);
 authorized=true;
 const second=await probeTencent({client,target:null});
 assert.equal(second.state,'configuration_required');assert.equal(second.reauthorization_required,false);
 assert.match(second.message,/交付表格/);assert.equal(reads,0);
 const third=await probeTencent({client,target:{file_id:'verified-file'}});
 assert.equal(third.state,'ready');assert.equal(third.reauthorization_required,false);
 assert.equal(inits,3);assert.equal(reads,1);
});


test('manual confirmation of a ready site during another check schedules fresh evidence', async()=>{
 let now=10000, release, block=false;const calls=[];
 const gate=createReadiness({collector:{probe:async id=>{calls.push(id);if(id==='douhot'&&block)await new Promise(r=>release=r);return {state:'ready'};}},client:fakeClient(),target,now:()=>now});
 gate.check();await gate.settled();assert.equal(gate.status().ready,true);
 const previous=gate.status().sites.find(row=>row.id==='douyin').checked_at;
 now+=1000;block=true;gate.check(['douhot']);
 while(!release)await new Promise(r=>setImmediate(r));
 const requestedAt=now;
 gate.check(['douyin']);release();
 const done=await gate.settled();
 assert.deepEqual(calls,['douyin','douhot','douhot','douyin']);
 const checked=done.sites.find(row=>row.id==='douyin');
 assert.equal(checked.state,'ready');assert.notEqual(checked.checked_at,previous);
 assert.ok(Date.parse(checked.checked_at)>=requestedAt);
});

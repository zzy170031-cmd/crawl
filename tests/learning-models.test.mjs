import test from 'node:test';
import assert from 'node:assert/strict';
import {Model} from '../app/model.mjs';
import {createLearningModels,recoverLearningModelCleanup,LEARNING_MODELS_VERSION} from '../app/learning-models.mjs';
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const events=[],state={};
 const make=name=>({model:name,url:'http://127.0.0.1:11434',
  cacheParameters:options=>new Model({model:name}).cacheParameters(options),
  identity:async()=>{events.push('identity:'+name);if(state.missing===name)throw Error('PRIVATE_MISSING');return {name,digest:state.changed===name?'changed':'digest:'+name};},
  unload:async({signal}={})=>{events.push('unload:start:'+name);if(state.unloadGate)await state.unloadGate.promise;signal?.throwIfAborted();if(state.unloadFail)throw Error('PRIVATE_UNLOAD');events.push('unload:end:'+name);return {unloaded:true};},
  json:async(system,input,schema,options)=>{events.push('json:start:'+name);state.options=options;if(state.jsonGate)await state.jsonGate.promise;options.signal?.throwIfAborted();if(state.jsonFail)throw Error('PRIVATE_JSON');events.push('json:end:'+name);return {name,input};}
 });
 const vision=make('vision:local'),analysis=make('analysis:local');
 return {events,state,vision,analysis,options:{visionModel:vision,analysisModel:analysis,injectedRuntimeIdentity:{engine:'injected',version:'fixture-1'}}};
}
const json=m=>m.json('fixture',{},{});

function runtimeFixture(){
 const state={version:'0.30.6'},calls=[];
 const fetchImpl=async(url,options={})=>{
  const path=new URL(url).pathname;calls.push(path);assert.equal(options.redirect,'error');
  if(path==='/api/version')return Response.json({version:state.version});
  if(path==='/api/tags')return Response.json({models:[{name:'v:local',digest:'same-v'},{name:'a:local',digest:'same-a'}]});
  if(path==='/api/chat')return new Response(JSON.stringify({message:{content:'{}'},done:true})+'\n');
  if(path==='/api/generate'){if(state.upgradeOnUnload)state.version=state.upgradeOnUnload;return Response.json({done:true});}
  if(path==='/api/ps')return Response.json({models:[]});
  assert.fail('unexpected request '+path);
 };
 return {state,calls,options:{visionName:'v:local',analysisName:'a:local',fetchImpl}};
}

test('actual runtime version binds both role cache identities even with identical weights; setup shares endpoint lookup',async()=>{
 const f=runtimeFixture(),old=await createLearningModels(f.options);
 assert.equal(f.calls.filter(p=>p==='/api/version').length,1);
 assert(f.calls.every(p=>['/api/version','/api/tags'].includes(p)));
 assert.deepEqual(old.vision.cacheParameters().runtime,{engine:'ollama',version:'0.30.6'});
 f.state.version='0.40.6';const next=await createLearningModels(f.options);
 assert.deepEqual(next.visionIdentity,old.visionIdentity);assert.deepEqual(next.analysisIdentity,old.analysisIdentity);
 assert.notDeepEqual(next.cacheIdentity,old.cacheIdentity);assert.notDeepEqual(next.vision.cacheParameters(),old.vision.cacheParameters());
 assert.deepEqual(old.analysis.cacheParameters().runtime,{engine:'ollama',version:'0.30.6'});
 assert.equal(LEARNING_MODELS_VERSION,'learning-model-roles-2');
});

test('runtime upgrade rejects obsolete roles before inference or unload; queue remains usable only with matching runtime',async()=>{
 const f=runtimeFixture(),roles=await createLearningModels(f.options);f.state.version='0.40.6';
 await assert.rejects(json(roles.vision),e=>e.code==='LEARNING_MODEL_RUNTIME_CHANGED');
 assert(!f.calls.includes('/api/chat'));assert(!f.calls.includes('/api/generate'));
 const fresh=await createLearningModels(f.options);await json(fresh.vision);assert.equal(f.calls.filter(p=>p==='/api/chat').length,1);await fresh.dispose();
});

test('upgrade during role unload is detected before the requested role is loaded',async()=>{
 const f=runtimeFixture(),roles=await createLearningModels(f.options);await json(roles.vision);
 f.state.upgradeOnUnload='0.40.6';await assert.rejects(json(roles.analysis),e=>e.code==='LEARNING_MODEL_RUNTIME_CHANGED');
 assert.equal(f.calls.filter(p=>p==='/api/chat').length,1);assert.equal(f.calls.filter(p=>p==='/api/generate').length,1);
});

test('missing actual runtime version fails closed without loading; injected models require explicit injected identity and never fetch',async()=>{
 const real=runtimeFixture();delete real.state.version;
 await assert.rejects(createLearningModels({...real.options,injectedRuntimeIdentity:{engine:'injected',version:'cannot-override-real'}}),e=>e.code==='LEARNING_MODEL_IDENTITY_UNAVAILABLE');
 assert.deepEqual(real.calls,['/api/version']);
 const f=fixture();delete f.options.injectedRuntimeIdentity;
 await assert.rejects(createLearningModels({...f.options,fetchImpl:()=>assert.fail('no network')}),e=>e.code==='LEARNING_MODEL_IDENTITY_UNAVAILABLE');assert.deepEqual(f.events,[]);
 await assert.rejects(createLearningModels({...f.options,injectedRuntimeIdentity:{engine:'ollama',version:'0.40.6'}}));
 const roles=await createLearningModels({...f.options,injectedRuntimeIdentity:{engine:'injected',version:'fixture-2'},fetchImpl:()=>assert.fail('no network')});
 await json(roles.vision);assert.deepEqual(roles.vision.cacheParameters().runtime,{engine:'injected',version:'fixture-2'});
});

test('role initialization only checks installed identities; cache metadata binds role, digest and inference settings',async()=>{
 const f=fixture(),roles=await createLearningModels({...f.options,analysisOptions:{thinking:true,maxTokens:2000}});
 assert.deepEqual(f.events,['identity:vision:local','identity:analysis:local']);assert.equal(roles.visionIdentity.digest,'digest:vision:local');assert.equal(roles.analysisIdentity.digest,'digest:analysis:local');
 assert.equal(roles.cacheIdentity.version,LEARNING_MODELS_VERSION);assert.equal(roles.cacheIdentity.vision.inference.thinking,false);assert.equal(roles.cacheIdentity.analysis.inference.thinking,true);
 assert.notDeepEqual(roles.analysis.cacheParameters({maxTokens:3000}),roles.analysis.cacheParameters());
 await roles.vision.identity();await roles.analysis.identity();assert.equal(f.events.length,2);
 await roles.analysis.json('分析',{source:'local'},{});assert.equal(f.state.options.thinking,true);
});
test('role switching awaits unload completion before the other model starts; concurrent requests remain serial',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options);f.state.jsonGate=defer();const first=json(roles.vision);await new Promise(r=>setImmediate(r));
 const second=json(roles.analysis);await new Promise(r=>setImmediate(r));assert(!f.events.includes('json:start:analysis:local'));assert(!f.events.includes('unload:start:vision:local'));
 const gate=f.state.jsonGate;f.state.jsonGate=null;f.state.unloadGate=defer();gate.resolve();await first;await new Promise(r=>setImmediate(r));
 assert(f.events.includes('unload:start:vision:local'));assert(!f.events.includes('json:start:analysis:local'));f.state.unloadGate.resolve();await second;
 assert(f.events.indexOf('unload:end:vision:local')<f.events.indexOf('json:start:analysis:local'));
});
test('failed inference and unload do not poison queue; failed unload prevents the next role loading',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options);f.state.jsonFail=true;await assert.rejects(json(roles.vision),e=>e.code==='LEARNING_MODEL_OPERATION_FAILED'&&!e.message.includes('PRIVATE'));
 f.state.jsonFail=false;f.state.unloadFail=true;await assert.rejects(json(roles.analysis));assert(!f.events.includes('json:start:analysis:local'));
 f.state.unloadFail=false;await json(roles.analysis);assert(f.events.includes('json:end:analysis:local'));
 assert.equal(f.events.filter(e=>e==='unload:start:vision:local').length,2);
});
test('same model used by both roles stays loaded and the first role never unloads an unrelated model',async()=>{
 const f=fixture(),roles=await createLearningModels({...f.options,analysisModel:f.vision});await json(roles.vision);await json(roles.analysis);await json(roles.vision);
 assert.equal(f.events.filter(e=>e.startsWith('unload')).length,0);assert.equal(f.events.filter(e=>e==='json:start:vision:local').length,3);
});
test('missing analysis model fails before all inference/unloading with no downloader or fallback',async()=>{
 const f=fixture();f.state.missing='analysis:local';await assert.rejects(createLearningModels(f.options),e=>e.code==='LEARNING_MODEL_IDENTITY_UNAVAILABLE'&&!e.message.includes('PRIVATE'));
 assert(f.events.every(e=>e.startsWith('identity:')));
});
test('queued cancellation rejects promptly without later load and does not corrupt the serial queue',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options),controller=new AbortController();f.state.jsonGate=defer();const first=json(roles.vision);await new Promise(r=>setImmediate(r));
 const second=roles.analysis.json('分析',{}, {},{signal:controller.signal});controller.abort(Error('PRIVATE_CANCEL'));await assert.rejects(second,e=>e.code==='LEARNING_MODEL_CANCELLED'&&!e.message.includes('PRIVATE'));
 const gate=f.state.jsonGate;f.state.jsonGate=null;gate.resolve();await first;await json(roles.vision);assert(!f.events.includes('json:start:analysis:local'));assert(!f.events.some(e=>e.startsWith('unload')));
});
test('cancellation during unload cannot start the requested model; subsequent request can retry unloading',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options),controller=new AbortController();await json(roles.vision);f.state.unloadGate=defer();
 const pending=roles.analysis.json('分析',{}, {},{signal:controller.signal});await new Promise(r=>setImmediate(r));assert(f.events.includes('unload:start:vision:local'));
 controller.abort();await assert.rejects(pending,e=>e.code==='LEARNING_MODEL_CANCELLED');f.state.unloadGate.resolve();f.state.unloadGate=null;
 await json(roles.analysis);assert.equal(f.events.filter(e=>e==='json:start:analysis:local').length,1);
});
test('identity mutation rejects inference under an obsolete digest; analysis rejects images before touching models',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options);f.state.changed='analysis:local';await assert.rejects(json(roles.analysis),e=>e.code==='LEARNING_MODEL_IDENTITY_CHANGED');assert(!f.events.some(e=>e.startsWith('json:')));
 f.state.changed=null;const before=f.events.length;await assert.rejects(roles.analysis.json('分析',{}, {},{images:['frame']}),e=>e.code==='LEARNING_MODEL_ROLE_INVALID');assert.equal(f.events.length,before);
 await json(roles.analysis);assert(f.events.includes('json:end:analysis:local'));
});
test('injected upstream secret remains available only as local cause, never message or serialized error',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options);f.state.jsonFail=true;
 await assert.rejects(json(roles.vision),e=>{assert.equal(e.cause.message,'PRIVATE_JSON');assert(!JSON.stringify(e).includes('PRIVATE_JSON'));assert(!e.message.includes('PRIVATE_JSON'));return true;});
});

test('real Model wrappers wait for delayed ps disappearance before requesting analysis chat',async()=>{
 const events=[];let polls=0;
 const fetchImpl=async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;
  if(url.endsWith('/api/version'))return Response.json({version:'0.40.6'});
  if(url.endsWith('/api/tags'))return Response.json({models:[{name:'v:local',digest:'v-sha'},{name:'a:local',digest:'a-sha'}]});
  if(url.endsWith('/api/chat')){events.push('chat:'+body.model);return new Response(JSON.stringify({message:{content:'{}'},done:true})+'\n');}
  if(url.endsWith('/api/generate')){events.push('unload:'+body.model);return Response.json({done:true});}
  if(url.endsWith('/api/ps')){events.push('ps:'+ ++polls);return Response.json({models:polls===1?[{name:'v:local'}]:[{name:'unrelated:user'}]});}
  assert.fail('unexpected endpoint '+url);
 };
 const roles=await createLearningModels({visionName:'v:local',analysisName:'a:local',fetchImpl});
 await json(roles.vision);await json(roles.analysis);
 assert.deepEqual(events,['chat:v:local','unload:v:local','ps:1','ps:2','chat:a:local']);await roles.dispose();
});

test('dispose unloads only the last model owned by this coordinator before the next run starts',async()=>{
 const f=fixture(),first=await createLearningModels(f.options);await json(first.vision);await json(first.analysis);await first.dispose();
 const next=await createLearningModels(f.options);await json(next.vision);await next.dispose();
 const relevant=f.events.filter(e=>e.startsWith('json:start')||e.startsWith('unload:end'));
 assert.deepEqual(relevant,['json:start:vision:local','unload:end:vision:local','json:start:analysis:local','unload:end:analysis:local','json:start:vision:local','unload:end:vision:local']);
 await assert.rejects(json(first.vision),e=>e.code==='LEARNING_MODEL_DISPOSED');
 const before=f.events.length;assert.deepEqual(await first.dispose(),{disposed:true});assert.equal(f.events.length,before);
 const untouched=await createLearningModels(f.options),beforeUnused=f.events.length;await untouched.dispose();assert.equal(f.events.length,beforeUnused);
});

test('failed dispose keeps endpoint ownership after the run object is discarded; explicit cleanup unlocks the next run',async()=>{
 const f=fixture();let first=await createLearningModels(f.options);await json(first.analysis);f.state.unloadFail=true;
 await assert.rejects(first.dispose(),e=>e.code==='LEARNING_MODEL_DISPOSE_FAILED');first=null;
 const next=await createLearningModels(f.options);await assert.rejects(json(next.vision),e=>e.code==='LEARNING_MODEL_CLEANUP_REQUIRED');
 assert.deepEqual(f.events.filter(e=>e.startsWith('json:start')),['json:start:analysis:local']);
 const recovery={url:f.vision.url,injectedRuntimeIdentity:f.options.injectedRuntimeIdentity,timeoutMs:100};
 await assert.rejects(recoverLearningModelCleanup(recovery),e=>e.code==='LEARNING_MODEL_DISPOSE_FAILED');
 await assert.rejects(json(next.vision),e=>e.code==='LEARNING_MODEL_CLEANUP_REQUIRED');
 f.state.unloadFail=false;assert.deepEqual(await recoverLearningModelCleanup(recovery),{recovered:true,unloaded:true});
 await json(next.vision);assert.deepEqual(f.events.filter(e=>e.startsWith('json:start')||e.startsWith('unload:end')),['json:start:analysis:local','unload:end:analysis:local','json:start:vision:local']);
 await next.dispose();assert.deepEqual(await recoverLearningModelCleanup(recovery),{recovered:true,unloaded:false});
});

test('another coordinator cannot infer or explicitly recover an active healthy owner',async()=>{
 const f=fixture(),first=await createLearningModels(f.options),next=await createLearningModels(f.options);await json(first.vision);
 await assert.rejects(json(next.analysis),e=>e.code==='LEARNING_MODEL_ENDPOINT_BUSY');
 await assert.rejects(recoverLearningModelCleanup({url:f.vision.url,injectedRuntimeIdentity:f.options.injectedRuntimeIdentity}),e=>e.code==='LEARNING_MODEL_ENDPOINT_BUSY');
 assert(!f.events.some(e=>e.startsWith('unload')));await first.dispose();await json(next.analysis);await next.dispose();
});

test('actual endpoint ownership blocks a fresh Model instance after failed cleanup, without touching unrelated endpoints',async()=>{
 const f=runtimeFixture(),original=f.options.fetchImpl;let fail=true;
 f.options.fetchImpl=async(url,options)=>{if(url.endsWith('/api/generate')&&fail)throw Error('PRIVATE_UNLOAD');return original(url,options);};
 const first=await createLearningModels(f.options);await json(first.analysis);await assert.rejects(first.dispose());
 const next=await createLearningModels(f.options);await assert.rejects(json(next.vision),e=>e.code==='LEARNING_MODEL_CLEANUP_REQUIRED');
 assert.equal(f.calls.filter(p=>p==='/api/chat').length,1);
 assert.deepEqual(await recoverLearningModelCleanup({url:'http://127.0.0.1:11499'}),{recovered:true,unloaded:false});
 fail=false;await recoverLearningModelCleanup({url:'http://127.0.0.1:11434/'});await json(next.vision);await next.dispose();
});

test('dispose after task cancellation has independent bounded cleanup and reports unknown unload rather than success',async()=>{
 const f=fixture(),roles=await createLearningModels(f.options),controller=new AbortController();f.state.jsonGate=defer();
 const running=roles.vision.json('read',{}, {},{signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(running);f.state.jsonGate.resolve();f.state.jsonGate=null;
 assert.deepEqual(await roles.dispose(),{disposed:true});assert(f.events.includes('unload:end:vision:local'));
 const failed=await createLearningModels(f.options);await json(failed.vision);f.state.unloadGate=defer();
 await assert.rejects(failed.dispose({timeoutMs:10}),e=>e.code==='LEARNING_MODEL_DISPOSE_FAILED');assert(!f.events.includes('json:start:analysis:local'));
 f.state.unloadGate.resolve();f.state.unloadGate=null;assert.deepEqual(await failed.dispose(),{disposed:true});
});

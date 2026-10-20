import test from "node:test";
import assert from "node:assert/strict";
import { Model } from "../app/model.mjs";

function streamResponse(content, reason = "stop") {
  return new Response(JSON.stringify({ message: { content }, done: true, done_reason: reason }) + "\n");
}
test('运行时身份仅读取本地version，缺失或畸形版本失败且取消不请求',async()=>{
 const calls=[];let payload={version:'0.40.6'};
 const model=new Model({fetchImpl:async(url,options)=>{calls.push(url);assert.equal(options.redirect,'error');assert(options.signal);return Response.json(payload);}});
 assert.deepEqual(await model.runtimeIdentity(),{engine:'ollama',version:'0.40.6'});
 for(const value of [{},{version:''},{version:40},{version:'0.40.6 https://PRIVATE.invalid'}]){
  payload=value;await assert.rejects(model.runtimeIdentity(),e=>e.code==='MODEL_RUNTIME_IDENTITY_FAILED'&&!e.message.includes('PRIVATE'));
 }
 assert(calls.every(url=>url==='http://127.0.0.1:11434/api/version'));
 const before=calls.length,controller=new AbortController();controller.abort(Error('PRIVATE'));
 await assert.rejects(model.runtimeIdentity({signal:controller.signal}),e=>e.code==='MODEL_CANCELLED');assert.equal(calls.length,before);
});
test("单帧JSON前缀只用于显式请求的Qwen并保留截断检查", async () => {
  let request;
  const model = new Model({ model: "qwen3-vl:8b", fetchImpl: async (_, options) => {
    request = JSON.parse(options.body);
    return streamResponse('"text":"实际字幕"}');
  }});
  const schema = {type:"object",properties:{text:{type:"string"}},required:["text"]};
  assert.deepEqual(await model.json("读取画面", {}, schema, {images:["fixture"],prefillJson:true}), {text:"实际字幕"});
  assert.equal(request.messages.at(-1).content, "<think>\n\n</think>\n\n{");
  assert.deepEqual(request.messages[1].images, ["fixture"]);
  model.fetch = async () => streamResponse('"text":"截断', "length");
  await assert.rejects(model.json("读取", {}, schema, {prefillJson:true}), /截断/);
});
for (const name of ["other:model", "qwen3-vl:8b-instruct"]) test(name + "不插入思考版专用前缀", async () => {
  let request;
  const model = new Model({model:name, fetchImpl:async (_, options)=>{
    request=JSON.parse(options.body);return streamResponse('{"text":"字幕"}');
  }});
  assert.deepEqual(await model.json("读取", {}, {}, {prefillJson:true}), {text:"字幕"});
  assert.equal(request.messages.length, 2);
});

test('显式thinking保留思考请求但不使用旧强制JSON前缀；默认请求仍false',async()=>{
 const calls=[];const model=new Model({model:'qwen3-vl:8b',fetchImpl:async(_,options)=>{calls.push(JSON.parse(options.body));return streamResponse('{"text":"结果"}');}});
 await model.json('分析',{}, {},{thinking:true,prefillJson:true});assert.equal(calls[0].think,true);assert.equal(calls[0].messages.length,2);assert(!calls[0].messages[1].content.includes('/no_think'));
 await model.json('默认',{},{});assert.equal(calls[1].think,false);
 assert.notDeepEqual(model.cacheParameters({thinking:true}),model.cacheParameters());
 await assert.rejects(model.json('无效',{}, {},{thinking:'yes'}),/参数无效/);assert.equal(calls.length,2);
});
test('模型身份仅读取tags，缺模型或缺digest不推理、不下载且不泄漏上游诊断',async()=>{
 const calls=[];const model=new Model({model:'local:required',fetchImpl:async(url)=>{calls.push(url);return Response.json({models:[]});}});
 await assert.rejects(model.identity(),/不会自动下载/);assert.deepEqual(calls,['http://127.0.0.1:11434/api/tags']);
 model.fetch=async()=>Response.json({models:[{name:'local:required'}]});await assert.rejects(model.identity(),/摘要缺失/);
 const cause=Error('SECRET https://remote.invalid/credential');model.fetch=async()=>{throw cause;};await assert.rejects(model.identity(),e=>{assert.equal(e.cause,cause);assert(!e.message.includes('SECRET'));assert(!JSON.stringify(e).includes('SECRET'));return true;});
 assert.throws(()=>new Model({url:'https://remote.invalid'}),/本机HTTP/);
});
test('卸载确认等待本模型从ps消失，不卸载其他常驻模型',async()=>{
 const calls=[];let polls=0;const model=new Model({model:'vision:local',fetchImpl:async(url,options)=>{
  calls.push({url,body:options.body&&JSON.parse(options.body)});
  if(url.endsWith('/api/generate'))return Response.json({done:true,done_reason:'unload'});
  polls++;return Response.json({models:[{name:'other:user-model'},...(polls<3?[{model:'vision:local'}]:[])]});
 }});
 assert.deepEqual(await model.unload({timeoutMs:500,pollIntervalMs:1}),{unloaded:true});assert.equal(polls,3);
 assert.deepEqual(calls.filter(c=>c.body).map(c=>c.body),[{model:'vision:local',keep_alive:0,stream:false}]);
});
test('卸载超时和取消不能声称完成，流异常不暴露上游输出',async()=>{
 const controller=new AbortController();let polls=0;
 const model=new Model({model:'local:model',fetchImpl:async(url)=>url.endsWith('/api/generate')?Response.json({done:true}):(++polls,Response.json({models:[{name:'local:model'}]}))});
 await assert.rejects(model.unload({timeoutMs:15,pollIntervalMs:1}),e=>e.code==='MODEL_UNLOAD_FAILED');assert(polls>0);
 model.fetch=async(url)=>{if(url.endsWith('/api/generate'))return Response.json({done:true});controller.abort(Error('PRIVATE'));return Response.json({models:[{name:'local:model'}]});};
 await assert.rejects(model.unload({signal:controller.signal,pollIntervalMs:1}),e=>e.code==='MODEL_CANCELLED'&&!e.message.includes('PRIVATE'));
 model.fetch=async()=>streamResponse('invalid SECRET_JSON');await assert.rejects(model.json('分析',{},{}),e=>!e.message.includes('SECRET_JSON')&&!JSON.stringify(e).includes('SECRET_JSON'));
});


test('所有模型请求明确拒绝重定向，包括带图片的chat和卸载后的ps轮询',async()=>{
 const paths=[],model=new Model({model:'local:fixture',fetchImpl:async(url,options)=>{
  const path=new URL(url).pathname;paths.push(path);assert.equal(options.redirect,'error',path+' must reject redirects before following an external Location');
  if(path==='/api/version')return Response.json({version:'0.40.6'});
  if(path==='/api/tags')return Response.json({models:[{name:'local:fixture',digest:'fixture-digest'}]});
  if(path==='/api/chat'){const request=JSON.parse(options.body);assert.deepEqual(request.messages[1].images,['PRIVATE_MEDIA']);return streamResponse('{}');}
  if(path==='/api/generate')return Response.json({done:true});
  if(path==='/api/ps')return Response.json({models:[]});
  assert.fail('unexpected endpoint');
 }});
 await model.runtimeIdentity();await model.identity();await model.json('识别',{text:'private'}, {},{images:['PRIVATE_MEDIA']});await model.unload();
 assert.deepEqual(paths,['/api/version','/api/tags','/api/chat','/api/generate','/api/ps']);
});

test('重定向被fetch拒绝后不重试外跳或泄漏Location和媒体，五路错误均脱敏',async()=>{
 for(const blocked of ['/api/version','/api/tags','/api/chat','/api/generate','/api/ps']){
  const paths=[],cause=new TypeError('redirect to https://outside.invalid/SECRET_TOKEN PRIVATE_MEDIA');
  const model=new Model({model:'local:fixture',fetchImpl:async(url,options)=>{
   const path=new URL(url).pathname;paths.push(path);assert.equal(options.redirect,'error');
   if(path===blocked)throw cause; // controlled fetch redirect:error rejection, no network.
   if(path==='/api/generate')return Response.json({done:true});
   assert.fail('unexpected follow-up request '+path);
  }});
  const operation=blocked==='/api/version'?()=>model.runtimeIdentity():blocked==='/api/tags'?()=>model.identity():blocked==='/api/chat'?()=>model.json('识别',{}, {},{images:['PRIVATE_MEDIA']}):()=>model.unload();
  await assert.rejects(operation(),error=>{
   assert.equal(error.cause,cause);assert(!error.message.includes('SECRET_TOKEN'));assert(!error.message.includes('PRIVATE_MEDIA'));assert(!JSON.stringify(error).includes('outside.invalid'));return true;
  });
  assert.deepEqual(paths,blocked==='/api/ps'?['/api/generate','/api/ps']:[blocked]);
 }
});

test('pixel-only one wire captures HTTP, malformed JSON and token truncation before throwing; legacy retry unchanged',async()=>{
 for(const make of [()=>new Response('private error body',{status:503}),()=>streamResponse('invalid-json'),()=>streamResponse('{"partial":', 'length')]){
  let calls=0;const audits=[],model=new Model({fetchImpl:async()=>{calls++;return make();}});
  await assert.rejects(model.json('frame',{}, {},{maxAttempts:1,onRawResponse:r=>audits.push(r)}));assert.equal(calls,1);assert.equal(audits.length,1);assert(audits[0].body.length);assert.equal(audits[0].complete,true);
 }
 let calls=0;const old=new Model({fetchImpl:async()=>{calls++;return calls===1?new Response('',{status:503}):streamResponse('{}');}});await old.json('legacy',{},{});assert.equal(calls,2);
});
test('raw persistence failure never retries; callback/options are not model input or inference identity; raw is bounded',async()=>{
 let calls=0,body;const model=new Model({fetchImpl:async(url,o)=>{calls++;body=JSON.parse(o.body);return new Response('failure',{status:503});}});
 await assert.rejects(model.json('frame',{}, {},{onRawResponse:()=>{throw Object.assign(Error('disk failure'),{transient:true});}}));assert.equal(calls,1);assert(!JSON.stringify(body).includes('onRawResponse'));assert(!JSON.stringify(body).includes('maxAttempts'));
 const opts={maxAttempts:1,onRawResponse:()=>{}};assert.deepEqual(model.cacheParameters(opts),model.cacheParameters());
 let saved;model.fetch=async()=>new Response('x'.repeat(4*1024*1024+100));await assert.rejects(model.json('frame',{}, {},{maxAttempts:1,onRawResponse:r=>{saved=r;}}));assert.equal(Buffer.byteLength(saved.body),4*1024*1024);assert.equal(saved.truncated,true);assert.equal(saved.complete,false);
});

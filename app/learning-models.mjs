import {config,localURL} from './config.mjs';
import {Model} from './model.mjs';

export const LEARNING_MODELS_VERSION='learning-model-roles-2';
const keys=['thinking','contextLength','maxTokens','prefillJson'];
// Ownership survives an individual run's finally/catch. Only a confirmed
// unload releases it; a new coordinator cannot forget an earlier failed cleanup.
const endpointOwners=new Map(),injectedEndpointOwners=new WeakMap();
function ownerTable(injected){
  if(!injected)return endpointOwners;
  if(!injectedEndpointOwners.has(injected))injectedEndpointOwners.set(injected,new Map());
  return injectedEndpointOwners.get(injected);
}
export async function recoverLearningModelCleanup({url=config.modelURL,injectedRuntimeIdentity,timeoutMs=10000}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1)throw localError('LEARNING_MODEL_OPTIONS_INVALID','清理时限无效');
  const owner=ownerTable(injectedRuntimeIdentity).get(injectedRuntimeIdentity?url:localURL(url));
  if(!owner)return {recovered:true,unloaded:false};
  if(!owner.cleanupRequired)throw localError('LEARNING_MODEL_ENDPOINT_BUSY','本地模型仍由另一任务使用，不能强制清理');
  await owner.dispose({timeoutMs});
  return {recovered:true,unloaded:true};
}
function localError(code,message,cause){const error=Error(message,{cause});error.code=code;return error;}
function cancelled(signal){return localError('LEARNING_MODEL_CANCELLED','本地模型任务已取消',signal?.reason);}
function validIdentity(value,name){
  if(value?.name!==name||typeof value?.digest!=='string'||!value.digest.trim())throw localError('LEARNING_MODEL_IDENTITY_INVALID','本地模型身份不完整或不匹配');
  return Object.freeze({name:value.name,digest:value.digest});
}
function validRuntime(value,engine){
  if(value?.engine!==engine||typeof value?.version!=='string'||!value.version.trim()||value.version.length>100)throw localError('LEARNING_MODEL_RUNTIME_INVALID','模型运行时身份不完整');
  return Object.freeze({engine:value.engine,version:value.version});
}
function defaults(value,model){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw localError('LEARNING_MODEL_OPTIONS_INVALID','模型角色参数无效');
  const effective=model.cacheParameters(value);
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,effective[key]])));
}

// One coordinator owns only models it actually called. Identity checks use tags
// and do not load models. Callers can read/cache evidence without invoking json.
// The queue covers this coordinator, not unrelated external Ollama processes.
export async function createLearningModels({
  visionName=config.model,analysisName=config.analysisModel,
  visionOptions={},analysisOptions={},visionModel,analysisModel,injectedRuntimeIdentity,
  url=config.modelURL,fetchImpl=fetch,timeout=180000,signal,
}={}) {
  const vision=visionModel||new Model({model:visionName,url,fetchImpl,timeout});
  const analysis=analysisModel||(analysisName===vision.model?vision:new Model({model:analysisName,url,fetchImpl,timeout}));
  for(const model of [vision,analysis])if(!model||typeof model.model!=='string'||!model.model||typeof model.identity!=='function'||typeof model.json!=='function'||typeof model.unload!=='function'||typeof model.cacheParameters!=='function')throw localError('LEARNING_MODEL_INTERFACE_INVALID','模型角色接口不完整');
  const parameters={vision:defaults(visionOptions,vision),analysis:defaults(analysisOptions,analysis)};
  const identities={},runtimes={},initialRuntimes=new Map();
  const runtimeFor=async(model,requestSignal)=>model instanceof Model
    ?validRuntime(await model.runtimeIdentity({signal:requestSignal}),'ollama')
    :validRuntime(injectedRuntimeIdentity,'injected');
  try{
    if(signal?.aborted)throw cancelled(signal);
    for(const [role,model] of [['vision',vision],['analysis',analysis]]){
      const key=model instanceof Model?model.url:model;
      if(!initialRuntimes.has(key))initialRuntimes.set(key,await runtimeFor(model,signal));
      runtimes[role]=initialRuntimes.get(key);
    }
    identities.vision=validIdentity(await vision.identity({signal}),vision.model);
    identities.analysis=analysis===vision?identities.vision:validIdentity(await analysis.identity({signal}),analysis.model);
    if(signal?.aborted)throw cancelled(signal);
    if(vision.model===analysis.model&&vision.url===analysis.url&&identities.vision.digest!==identities.analysis.digest)throw Error('identity changed during setup');
  }catch(cause){throw signal?.aborted?cancelled(signal):localError('LEARNING_MODEL_IDENTITY_UNAVAILABLE','所需本地模型身份检查未通过；不会下载、推理或回退',cause);}
  let tail=Promise.resolve(),active=null,closing=false,disposePromise=null;
  const owner={cleanupRequired:false,dispose};
  const ownership=model=>({table:ownerTable(model instanceof Model?undefined:injectedRuntimeIdentity),key:model.url||'injected'});
  function available(model){
    const {table,key}=ownership(model),held=table.get(key);
    if(held&&held!==owner)throw localError(held.cleanupRequired?'LEARNING_MODEL_CLEANUP_REQUIRED':'LEARNING_MODEL_ENDPOINT_BUSY',held.cleanupRequired?'上次模型清理尚未确认，必须显式恢复后再推理':'本地模型正在由另一任务使用');
  }
  function release(model){const {table,key}=ownership(model);if(table.get(key)===owner)table.delete(key);}
  async function unloadOwned(options){
    try{
      const result=await active.model.unload(options);
      if(result?.unloaded!==true)throw Error('unload not confirmed');
      release(active.model);active=null;owner.cleanupRequired=false;
    }catch(error){owner.cleanupRequired=true;throw error;}
  }
  function enqueue(work,signal){
    return new Promise((resolve,reject)=>{
      let aborted=false;
      const onAbort=()=>{aborted=true;reject(cancelled(signal));};
      if(signal?.aborted){onAbort();return;}
      signal?.addEventListener('abort',onAbort,{once:true});
      const execute=async()=>{
        try{if(aborted)return;const value=await work();if(!aborted)resolve(value);}
        catch(cause){if(!aborted){const changed=['LEARNING_MODEL_IDENTITY_CHANGED','LEARNING_MODEL_RUNTIME_CHANGED'].includes(cause?.code),held=['LEARNING_MODEL_CLEANUP_REQUIRED','LEARNING_MODEL_ENDPOINT_BUSY'].includes(cause?.code);reject(signal?.aborted?cancelled(signal):localError(changed||held?cause.code:'LEARNING_MODEL_OPERATION_FAILED',changed?'本地模型或运行时身份已变化，请重新建立模型角色':held?'本地模型被占用或上次清理未确认；没有开始推理':'本地模型角色操作未完成；没有继续切换或回退',cause));}}
        finally{signal?.removeEventListener('abort',onAbort);}
      };
      tail=tail.then(execute,execute);
    });
  }
  function wrapper(role,model){
    const identity=identities[role],runtime=runtimes[role],base=parameters[role];
    const checkRuntime=async signal=>{
      const current=await runtimeFor(model,signal);
      if(current.engine!==runtime.engine||current.version!==runtime.version)throw localError('LEARNING_MODEL_RUNTIME_CHANGED','本地模型运行时身份已变化');
    };
    return Object.freeze({
      identity:async()=>({...identity}),
      runtimeIdentity:async()=>({...runtime}),
      cacheParameters(options={}){return {version:LEARNING_MODELS_VERSION,role,identity:{...identity},runtime:{...runtime},inference:model.cacheParameters({...base,...options})};},
      json(system,input,schema,options={}){
        if(closing)return Promise.reject(localError('LEARNING_MODEL_DISPOSED','模型角色已关闭，不能继续推理'));
        if(role==='analysis'&&options.images?.length)return Promise.reject(localError('LEARNING_MODEL_ROLE_INVALID','文本分析角色不接受图片输入'));
        const merged={...base,...options};
        try{model.cacheParameters(merged);}catch(cause){return Promise.reject(localError('LEARNING_MODEL_OPTIONS_INVALID','模型角色参数无效',cause));}
        return enqueue(async()=>{
          available(model);
          await checkRuntime(merged.signal);
          const current=validIdentity(await model.identity({signal:merged.signal}),model.model);
          if(current.digest!==identity.digest)throw localError('LEARNING_MODEL_IDENTITY_CHANGED','本地模型身份已变化');
          merged.signal?.throwIfAborted();
          if(active&&(active.model.model!==model.model||active.model.url!==model.url)){
            // Leave active intact on unknown/failed unload; never load the next.
            await unloadOwned({signal:merged.signal});
          }
          // Switching/unloading can overlap an engine restart. Recheck at the
          // last asynchronous boundary before inference under captured identity.
          await checkRuntime(merged.signal);
          merged.signal?.throwIfAborted();
          available(model);
          // A failed request may still have loaded its model: retain ownership.
          active={model};
          const {table,key}=ownership(model);table.set(key,owner);
          return await model.json(system,input,schema,merged);
        },merged.signal);
      },
    });
  }
  function dispose({timeoutMs=10000}={}){
    if(disposePromise)return disposePromise;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1)return Promise.reject(localError('LEARNING_MODEL_OPTIONS_INVALID','清理时限无效'));
    closing=true;
    // Cleanup has its own bounded signal, independent of a cancelled task.
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('cleanup deadline')),timeoutMs);
    disposePromise=enqueue(async()=>{
      if(active){
        await unloadOwned({signal:controller.signal,timeoutMs});
      }
      return {disposed:true};
    },controller.signal).catch(cause=>{if(active)owner.cleanupRequired=true;disposePromise=null;throw localError('LEARNING_MODEL_DISPOSE_FAILED','本地模型清理未确认；不会启动下一模型',cause);}).finally(()=>clearTimeout(timer));
    return disposePromise;
  }
  const visionWrapper=wrapper('vision',vision),analysisWrapper=wrapper('analysis',analysis);
  return Object.freeze({vision:visionWrapper,analysis:analysisWrapper,dispose,
    visionIdentity:identities.vision,analysisIdentity:identities.analysis,
    visionRuntimeIdentity:runtimes.vision,analysisRuntimeIdentity:runtimes.analysis,
    cacheIdentity:Object.freeze({version:LEARNING_MODELS_VERSION,vision:Object.freeze(visionWrapper.cacheParameters()),analysis:Object.freeze(analysisWrapper.cacheParameters())})});
}

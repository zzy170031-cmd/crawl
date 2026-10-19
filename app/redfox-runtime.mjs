import {RedfoxSourceError} from "./redfox-error.mjs";
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export function redfoxCredentialReader(path, fallback=()=>process.env.REDFOX_API_KEY) {
  return async()=>{try {const value=JSON.parse(await readFile(path,'utf8'));return typeof value.token==='string'?value.token:'';}catch(error){if(error.code==='ENOENT')return fallback()||'';return '';}};
}
export async function saveRedfoxCredential(path,token) {
  if(typeof token!=='string' || !/^ak_[A-Za-z0-9_-]{16,200}$/.test(token.trim())) throw Error('红狐 API 密钥格式无效');
  await mkdir(dirname(path),{recursive:true});
  const tmp=path+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,JSON.stringify({token:token.trim()}),{mode:0o600,flag:'wx'});
  await rename(tmp,path);await chmod(path,0o600);
}

// Provider routing is explicit in each persisted request. Changing configuration
// must never replay an old browser request as a newly billable API request.
export function createRedfoxRuntime({browser, gameSource, hotspotSource, gameProvider='browser', hotspotProvider='browser', clock=()=>new Date()} = {}) {
  const providers = {games:gameProvider,hotspots:hotspotProvider};
  const sources = {games:gameSource,hotspots:hotspotSource};
  const verified = {games:null,hotspots:null};
  let active = null;
  let lastOperationWasAPI = false;
  const kind = payload => ['game-research','game-learning'].includes(payload?.purpose) ? 'games' : payload?.purpose === 'hotspots' ? 'hotspots' : null;
  const siteKind = site => site === 'douyin' ? 'games' : site === 'douhot' ? 'hotspots' : null;
  async function configured(k) { try{return Boolean((await sources[k]?.checkConnection?.())?.configured);}catch{return false;} }
  async function capability(k) {
    return {provider:providers[k],configured:providers[k]==='redfox'&&await configured(k),requires_browser_login:providers[k]!=='redfox',live_verified:Boolean(verified[k]),last_verified_at:verified[k]};
  }
  function requestAllowed(payload) {
    const k=kind(payload);
    if (!k || providers[k]!=='redfox') return payload?.provider !== 'redfox';
    return payload?.provider==='redfox';
  }
  function independent(payload) { const k=kind(payload);return Boolean(k && providers[k]==='redfox' && payload?.provider==='redfox'); }
  return {
    invalidateCredentials(){verified.games=null;verified.hotspots=null;},
    requestAllowed,
    isIndependentRequest:independent,
    isConfigurationProbe:site=>providers[siteKind(site)]==='redfox',
    async status() { return {...await browser.status(),game_source:gameProvider,hotspot_source:hotspotProvider,capabilities:{games:await capability('games'),hotspots:await capability('hotspots')},...(active?{api_collecting:true}: {})}; },
    async probe(site,options) {
      const k=siteKind(site);
      if(providers[k]!=='redfox') return browser.probe(site,options);
      const available=await configured(k);
      return {state:available?'configured':'configuration_required',message:available?(verified[k]?'红狐 API 已配置；上次请求通过，当前未发起计费检查':'红狐 API 密钥已配置，尚未实际请求验证'):'请在后台配置红狐 API 密钥',capabilities:{...await capability(k),source:'redfox',configuration_only:true}};
    },
    async collect(payload,{signal,requestCreatedAt}={}) {
      if(!requestAllowed(payload)) throw Object.assign(Error('请求来源与当前配置不一致，请重新发起采集'),{code:'SOURCE_FAILED'});
      lastOperationWasAPI=independent(payload);
      if(!lastOperationWasAPI) return browser.collect(payload,{signal});
      const k=kind(payload);
      if(!await configured(k)) throw Object.assign(Error('红狐 API 尚未配置'),{code:'SOURCE_FAILED'});
      if(active) throw Object.assign(Error('红狐采集正在进行'),{code:'COLLECTOR_BUSY'});
      const controller=new AbortController(); active=controller;
      try {
        const result=await sources[k].collect(payload,{requestCreatedAt,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
        if (!result?.failures?.length) verified[k]=new Date(clock()).toISOString();
        return result;
      } catch(error) {
        // Third-party transports must not be able to echo headers or credentials.
        const safeCodes=new Set(['SOURCE_TIMEOUT','SOURCE_FAILED','VERIFICATION_REQUIRED','LOGIN_REQUIRED','SOURCE_SCOPE_MISMATCH','SOURCE_PARTIAL']);
        throw Object.assign(Error(error instanceof RedfoxSourceError ? error.message : '红狐 API 采集未完成，请检查配置、额度或请求范围后手动重试'),{code:safeCodes.has(error?.code)?error.code:'SOURCE_FAILED'});
      } finally {if(active===controller) active=null;}
    },
    async cancelOperation() {if(active) active.abort(Error('采集已取消'));if(lastOperationWasAPI)return;return browser.cancelOperation?.();},
    async close() {active?.abort(Error('服务已停止'));return browser.close();},
    login:(...args)=>browser.login(...args),
    verifyLogin:(...args)=>browser.verifyLogin(...args),
    resume:(...args)=>browser.resume(...args),
    loginView:(...args)=>browser.loginView(...args),
    loginInput:(...args)=>browser.loginInput(...args),
  };
}

import { TencentClient } from './tencent-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const IDS = ['douyin', 'douhot', 'tencent'];
const STATES = new Set(['ready', 'configured', 'login_required', 'verification_required', 'configuration_required', 'failed', 'unknown']);
const REQUIRED_TOOLS = ['sheet_get_sheet_info', 'sheet_get_cell_data', 'sheet_add_sheet', 'sheet_set_range_value', 'sheet_set_link', 'sheet_set_cell_style', 'sheet_set_dimension_size'];
const safeMessage = (error) => {
  if (error?.code === 'CREDENTIAL_REQUIRED') return '请连接腾讯文档授权';
  if (error?.code === 'CREDENTIAL_INVALID') return '腾讯文档凭据不可用，请重新连接';
  if (error?.code === 'AUTH_REQUIRED') return '腾讯文档授权已失效，请重新连接';
  if (error?.code === 'FORBIDDEN') return '腾讯文档目标表格无访问权限';
  return '腾讯文档连接或目标表格检查失败，请稍后重新检测';
};

// Read-only capability discovery proves access, never document write permission.
export async function probeTencent({client, target, signal}) {
  const destination = typeof target === 'function' ? target() : target;
  try {
    // Link resolution itself requires authorization. Check it before the target
    // so a first installation missing both can expose the authorization repair.
    await client.init({signal, force:true});
    if (!destination?.file_id || !/^[A-Za-z0-9_-]{4,100}$/.test(destination.file_id))
      return {state:'configuration_required', message:'请先设置腾讯文档交付表格',reauthorization_required:false};
    const missing = REQUIRED_TOOLS.filter(name => !client.names.has(name));
    if (missing.length) return {state:'failed', message:'腾讯文档缺少创作交付所需的表格能力', capabilities:{missing_tools:missing,write_permission_verified:false}};
    const info = await client.call('sheet_get_sheet_info', {file_id:destination.file_id}, {signal});
    if (!Array.isArray(info?.sheets)) throw Error('invalid sheet info');
    return {state:'ready', reauthorization_required:false, message:'腾讯文档已授权且目标表格可读取；写入权限将在交付时验证', capabilities:{target_readable:true,required_tools_available:true,write_permission_verified:false}};
  } catch (error) {
    return {state:['CREDENTIAL_REQUIRED','CREDENTIAL_INVALID'].includes(error.code)?'configuration_required':error.code==='AUTH_REQUIRED'?'login_required':'failed',message:safeMessage(error),reauthorization_required:['CREDENTIAL_REQUIRED','CREDENTIAL_INVALID','AUTH_REQUIRED'].includes(error.code)};
  }
}

export function createReadiness({collector, target, client = new TencentClient(), ttlMs = 5 * 60000, timeoutMs = 120000, busyRetryMs = 1000, now = () => Date.now(), onReady = () => {}} = {}) {
  const rows = new Map(IDS.map(id => [id, {id,state:'unknown',message:'尚未检查连接',checked_at:null}]));
  const versions = new Map(IDS.map(id => [id,0]));
  let running = null;
  const deferred = new Set();
  const timestamp = () => new Date(now()).toISOString();
  function status() {
    const sites = IDS.map(id => {
      const row = rows.get(id);
      const expired = row.checked_at && now() >= Date.parse(row.checked_at) + ttlMs;
      return {...row,...(expired && row.state === 'ready' ? {state:'unknown',message:'连接检查已过期，请重新检测'} : {})};
    });
    const checked = sites.map(x => x.checked_at && Date.parse(x.checked_at)).filter(x => Number.isFinite(x));
    const usable = row => ['ready','configured'].includes(row?.state);
    const ready = !running && sites.every(usable);
    const game_collection_ready=usable(sites.find(x=>x.id==='douyin'));
    const hotspot_collection_ready=usable(sites.find(x=>x.id==='douhot'));
    return {ready,game_collection_ready,hotspot_collection_ready,collection_ready:game_collection_ready&&hotspot_collection_ready,checking:Boolean(running),checked_at:checked.length===IDS.length?new Date(Math.min(...checked)).toISOString():null,expires_at:checked.length===IDS.length?new Date(Math.min(...checked)+ttlMs).toISOString():null,sites};
  }
  function invalidate(id, detail = {}) {
    if (!IDS.includes(id)) return;
    versions.set(id, versions.get(id)+1);
    rows.set(id,{id,state:STATES.has(detail.state)?detail.state:'unknown',message:detail.message||'连接已变化，请重新检测',checked_at:null});
  }
  function check(selected = IDS) {
    const ids = Array.isArray(selected) ? IDS.filter(id => selected.includes(id)) : IDS;
    if (running) {
      // An explicit recheck of an already-ready site still needs fresh evidence.
      for (const id of ids) if (rows.get(id).state !== 'checking') deferred.add(id);
      return status();
    }
    if (!ids.length) return status();
    const generations = new Map(ids.map(id => [id, versions.get(id)]));
    for (const id of ids) rows.set(id,{id,state:'checking',message:'正在检查连接',checked_at:null});
    const controller = new AbortController();
    let waitedForCollector = false;
    const deadline = setTimeout(() => controller.abort(Error('连接检查超时')), timeoutMs);
    deadline.unref?.();
    const aborted = new Promise((_,reject) => controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    async function probeWhenIdle(id) {
      for (;;) {
        controller.signal.throwIfAborted();
        try { return await collector.probe(id,{signal:controller.signal}); }
        catch (error) {
          if (error.code !== 'COLLECTOR_BUSY') throw error;
          // The worker rejects before acquiring the source lease. Do not close
          // its browser or abort its active task; wait within this check's budget.
          waitedForCollector = true;
          if (versions.get(id) === generations.get(id))
            rows.set(id,{id,state:'checking',message:'正在等待当前采集或登录结束，再检查连接',checked_at:null});
          await delay(Math.max(1,busyRetryMs),undefined,{signal:controller.signal});
        }
      }
    }
    running = Promise.resolve().then(async () => {
      for (const id of ids) {
        let result;
        try {
          controller.signal.throwIfAborted();
          result = await Promise.race([
            id === 'tencent' ? probeTencent({client,target,signal:controller.signal}) : probeWhenIdle(id),
            aborted,
          ]);
        } catch { result = controller.signal.aborted && waitedForCollector
          ? {state:'unknown',message:'当前采集或登录尚未结束，连接暂未复检；完成后请重新检测'}
          : {state:'failed',message:controller.signal.aborted?'连接检查超时，请重试':'来源连接检查失败，请重试'}; }
        if (versions.get(id) !== generations.get(id)) continue;
        const state = STATES.has(result?.state) ? result.state : 'failed';
        rows.set(id,{id,state,message:String(result?.message||'连接检查失败').slice(0,300),checked_at:timestamp(),...(typeof result?.reauthorization_required === 'boolean' ? {reauthorization_required:result.reauthorization_required} : {}),...(result?.capabilities ? {capabilities:result.capabilities} : {})});
      }
    }).finally(() => {
      clearTimeout(deadline);
      running = null;
      if (deferred.size) {
        const next = [...deferred]; deferred.clear(); check(next); return;
      }
      if (status().ready) { try { onReady(); } catch {} }
    });
    return status();
  }
  return {status,check,invalidate,async settled(){while (running) await running;return status();}};
}

// Source sessions must refresh even with no open browser tab. Only unknown or
// expired entries are automatic retries; explicit login/config/failure needs action.
export function startReadinessScheduler({readiness,collector,enabled=false,intervalMs=5000,cooldownMs=30000,now=()=>Date.now(),autoStart=true}) {
  let stopped=false,busy=false,awaitingCompletion=false,nextAttempt=0;
  async function tick() {
    if (!enabled || stopped || busy) return false;
    busy=true;
    try {
      const snapshot=readiness.status();
      if (snapshot.checking) { awaitingCompletion=true; return false; }
      if (awaitingCompletion) { awaitingCompletion=false;nextAttempt=now()+cooldownMs; }
      if (now()<nextAttempt) return false;
      const ids=snapshot.sites.filter(site=>site.state==='unknown').map(site=>site.id);
      if (!ids.length) return false;
      const source=await collector.status();
      if (stopped || source.state==='login_open' || source.source?.mode==='login') return false;
      const result=readiness.check(ids);
      awaitingCompletion=Boolean(result.checking);
      nextAttempt=now()+cooldownMs;
      return Boolean(result.checking);
    } catch { nextAttempt=now()+cooldownMs;return false; }
    finally { busy=false; }
  }
  const timer=enabled&&autoStart?setInterval(()=>{void tick();},intervalMs):null;
  timer?.unref?.();
  return {tick,stop(){stopped=true;clearInterval(timer);}};
}

import { readFile, mkdir, open, rename, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { dataDir } from './config.mjs';

const failure = (message, code) => Object.assign(Error(message), {code});
export function credentialFile(env = process.env) {
  return env.TENCENT_DOCS_TOKEN_FILE ? resolve(env.TENCENT_DOCS_TOKEN_FILE) : join(dataDir, 'credentials', 'tencent-docs.json');
}
export function validateTencentToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value))
    throw failure('授权凭据格式无效，请完整粘贴凭据，不要包含空格或换行', 'CREDENTIAL_INVALID');
  return value;
}
export async function loadTencentToken({env = process.env, path = credentialFile(env)} = {}) {
  if (env.TENCENT_DOCS_TOKEN) return validateTencentToken(env.TENCENT_DOCS_TOKEN);
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { throw failure('本地服务未配置腾讯文档授权', error.code === 'ENOENT' ? 'CREDENTIAL_REQUIRED' : 'CREDENTIAL_INVALID'); }
  try {
    const parsed = raw.trim().startsWith('{') ? JSON.parse(raw).token : raw.trim();
    return validateTencentToken(parsed);
  } catch { throw failure('本地腾讯文档凭据不可用', 'CREDENTIAL_INVALID'); }
}
export async function saveTencentCredential(token, {env = process.env, path = credentialFile(env)} = {}) {
  validateTencentToken(token);
  if (env.TENCENT_DOCS_TOKEN) throw failure('当前服务使用环境变量授权，请更新环境配置后重启服务', 'ENV_CREDENTIAL_ACTIVE');
  const dir = dirname(path);
  await mkdir(dir, {recursive:true,mode:0o700});
  const temp = join(dir, '.tencent-' + randomUUID() + '.tmp');
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify({token}), 'utf8');
    await file.sync();
    await file.close(); file = null;
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally { await file?.close().catch(()=>{}); await rm(temp,{force:true}).catch(()=>{}); }
}

// Credentials stay on the local server and are sent only to Tencent's MCP endpoint.
export class TencentClient {
  constructor({tokenProvider = () => loadTencentToken(), fetchImpl = fetch} = {}) {
    this.session = null;
    this.id = 0;
    this.ready = false;
    this.names = new Map();
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
    this.credentialVersion = null;
  }
  reset() { this.session = null; this.ready = false; this.names.clear(); }
  async credentials() {
    const token = validateTencentToken(await this.tokenProvider());
    const version = createHash('sha256').update(token).digest('hex');
    if (this.credentialVersion !== version) { this.reset(); this.credentialVersion = version; }
    return token;
  }
  async rpc(method, params, notification = false, {signal} = {}) {
    const token = await this.credentials();
    const headers = {'Content-Type':'application/json', Accept:'application/json, text/event-stream', Authorization:token};
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const requestId = ++this.id;
    let response;
    try {
      response = await this.fetch('https://docs.qq.com/openapi/mcp', {
        method:'POST', headers,
        body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:requestId}),method,params}),
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
      });
    } catch { throw failure('腾讯文档连接超时或网络不可用，请稍后重试', 'NETWORK_FAILED'); }
    if (!response.ok) {
      if ([401,403].includes(response.status)) this.reset();
      throw failure('腾讯文档连接失败，请检查授权或网络', response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : 'NETWORK_FAILED');
    }
    this.session = response.headers.get('mcp-session-id') || this.session;
    const body = await response.text();
    if (notification || !body) return {};
    let data;
    try { data = JSON.parse(body); }
    catch {
      for (const line of body.split('\n')) if (line.startsWith('data:')) {
        try { const item = JSON.parse(line.slice(5)); if (item.id === requestId) data = item; } catch {}
      }
    }
    if (!data || data.error) throw failure('腾讯文档接口调用失败，请检查 MCP 服务状态', 'RPC_FAILED');
    return data.result;
  }
  async init({signal, force = false} = {}) {
    await this.credentials();
    if (this.ready && !force) return;
    this.reset();
    await this.rpc('initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'hotspot-workbench',version:'1.0'}}, false, {signal});
    await this.rpc('notifications/initialized', {}, true, {signal});
    let cursor; const seen = new Set();
    do {
      const result = await this.rpc('tools/list', cursor ? {cursor} : {}, false, {signal});
      for (const tool of result.tools || []) this.names.set(tool.name.replaceAll('.', '_'), tool.name);
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw failure('腾讯文档能力列表异常', 'RPC_FAILED');
      seen.add(cursor);
    } while (cursor);
    this.ready = true;
  }
  async call(name, args, {signal} = {}) {
    await this.init({signal});
    const actual = this.names.get(name);
    if (!actual) throw failure('腾讯文档缺少所需表格接口', 'CAPABILITY_MISSING');
    const result = await this.rpc('tools/call', {name:actual,arguments:args}, false, {signal});
    if (result.isError) throw failure('腾讯文档操作失败，请检查访问权限', 'FORBIDDEN');
    let data = result.structuredContent;
    if (!data) {
      try { data = JSON.parse(result.content.find(c=>c.type==='text').text); }
      catch { throw failure('腾讯文档返回格式异常', 'RPC_FAILED'); }
    }
    if (data.error) throw failure('腾讯文档操作未完成，请检查访问权限或请求', 'RPC_FAILED');
    return data;
  }
}

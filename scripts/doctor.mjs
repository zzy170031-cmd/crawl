import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, arch, totalmem } from 'node:os';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, dataDir, root } from '../app/config.mjs';
import { Model } from '../app/model.mjs';
import { object, strings, validateSchema } from '../app/contracts.mjs';
import { redfoxCredentialReader } from '../app/redfox-runtime.mjs';
import { loadTencentToken } from '../app/tencent-client.mjs';
const exec = promisify(execFile);

async function localChecks() {
  const model = new Model();
  return {
    redfox: async () => {
      const key = await redfoxCredentialReader(join(dataDir, 'redfox-credential.json'))();
      if (!/^ak_[A-Za-z0-9_-]{16,200}$/.test(key)) throw Error('missing');
      return { configured: true, live_verified: false, billable_calls: 0 };
    },
    browser: async () => {
      const response = await fetch(config.cdp + '/json/version', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('unavailable');
      return { reachable: true, login_verified: false };
    },
    model: async () => { await model.identity(); return { installed: true, media_understanding_verified: false }; },
    host: async () => {
      if(config.studyHostProvider==='workbuddy')return {provider:'workbuddy-skill',configured:true,session_activity:'not_observed',execution_verified:false,next:'在WorkBuddy启用Skill，明确接续本轮任务；安装包或配置不证明看图与内容质量'};
      if(config.studyHostProvider!=='codex'||!config.studyHostCLI)throw Error('missing');
      await access(config.studyHostCLI);
      return {provider:'codex-host',configured:true,execution_verified:false};
    },
    ffmpeg: async () => {
      for (const tool of ['ffmpeg', 'ffprobe']) await exec(tool, ['-version'], { timeout: 5000, windowsHide: true });
      return { available: true };
    },
    asr: async () => {
      const code = "from faster_whisper import WhisperModel; import os; WhisperModel(os.environ.get('CRAWL_WHISPER_MODEL','small'),device='cpu',compute_type='int8',download_root=os.environ.get('CRAWL_WHISPER_CACHE') or None,local_files_only=True)";
      await exec(config.python, ['-c', code], { cwd: root, timeout: 60000, windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } });
      return { cached_model_loaded: true, device: 'cpu', compute_type: 'int8', transcription_verified: false };
    },
    tencent: async () => {
      await loadTencentToken();
      return { configured: true, authorization_verified: false, destination_permission_verified: false, writes: 0, next: '在创作台填写自己的目标表格并确认连接；本地配置不能证明写入权限' };
    },
    probe: async () => {
      const image = await readFile(join(root, 'tests/fixtures/two-colors.png'));
      const schema = object({ colors: strings });
      const result = validateSchema(await model.json('识别图片从左到右的两块纯色，colors使用英文小写颜色名。', {}, schema, { images: [image.toString('base64')] }), schema);
      if (result.colors.join(',') !== 'red,blue') throw Error('incorrect');
      return { scope: '仅本机双色图推理，不代表视频理解或交付验收' };
    },
  };
}

export async function runDoctor({ layer = 'all', probe = false, providers = { game: config.gameSource, hotspot: config.hotspotSource }, checks } = {}) {
  if (!['all', 'collection', 'analysis', 'host', 'delivery'].includes(layer)) throw Error('layer须为all、collection、analysis、host或delivery');
  if (probe && !['all', 'analysis'].includes(layer)) throw Error('--probe只能用于analysis/all');
  checks ??= await localChecks();
  const report = { at: new Date().toISOString(), platform: platform(), arch: arch(), memory_gib: Math.round(totalmem() / 1024 ** 3), node: process.version, layers: {}, limits: ['配置检查不证明真实采集成功、模型质量或腾讯写入权限', '不下载模型、不调用红狐、不写入腾讯；--probe仅额外调用本机视觉模型'] };
  async function check(group, name, failure) {
    report.layers[group] ??= {};
    try { report.layers[group][name] = { status: 'ok', result: await checks[name]() }; }
    catch { report.layers[group][name] = { status: 'failed', reason: failure }; }
  }
  if (layer === 'all' || layer === 'collection') {
    if (Object.values(providers).includes('redfox')) await check('collection', 'redfox', '请配置自己的红狐API Key；未发起付费验证');
    if (Object.values(providers).some(p => p !== 'redfox')) await check('collection', 'browser', '浏览器模式需要本机专用Chrome/CDP；Redfox模式不需要');
  }
  if (layer === 'all' || layer === 'analysis') {
    await check('analysis', 'ffmpeg', '请安装ffmpeg与ffprobe并加入PATH');
    await check('analysis', 'model', '请启动本机Ollama并安装配置中的视觉模型');
    await check('analysis', 'asr', '请核对Python依赖与多语言faster-whisper-small本地模型目录；不会自动下载');
    if (probe) await check('analysis', 'probe', '本机双色图推理未通过；请检查模型和资源');
  }
  if(layer==='host'){
    await check('host','host','请配置WorkBuddy协作模式或兼容Codex CLI；不会自动安装助手');
    await check('host','ffmpeg','请安装ffmpeg与ffprobe并加入PATH');
    await check('host','asr','请核对Python依赖与多语言Small本地目录；不会自动下载');
  }
  if (layer === 'all' || layer === 'delivery') await check('delivery', 'tencent', '请在本机配置本人腾讯文档MCP Token；表格链接不能替代授权');
  report.ok = Object.values(report.layers).every(group => Object.values(group).every(check => check.status === 'ok'));
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const layer = process.argv.find(arg => arg.startsWith('--layer='))?.slice(8) || 'all';
    const report = await runDoctor({ layer, probe: process.argv.includes('--probe') });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'doctor.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch { console.error('诊断未运行；检查--layer=collection|host|analysis|delivery|all与本地目录权限。'); process.exitCode = 1; }
}

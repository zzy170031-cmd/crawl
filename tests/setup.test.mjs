import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setup } from '../scripts/setup.mjs';
import { runDoctor } from '../scripts/doctor.mjs';
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'crawl 安装 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(new URL('../.env.example', import.meta.url), join(root, '.env.example'));
  return root;
}
test('fresh setup uses this checkout paths and Redfox defaults without credentials', async t => {
  const root = await sandbox(t);
  assert.equal((await setup({ root, platform: 'darwin' })).status, 'created');
  const env = parseEnv(await readFile(join(root, '.env'), 'utf8'));
  assert.equal(env.CRAWL_PYTHON, join(root, '.venv/bin/python'));
  assert.equal(env.CRAWL_WHISPER_MODEL, join(root, 'models/faster-whisper-small'));
  assert.equal(env.CRAWL_GAME_SOURCE, 'redfox');
  assert.equal(env.CRAWL_HOTSPOT_SOURCE, 'redfox');
  assert.equal(env.HOTSPOT_VISION_MODEL, 'qwen3-vl:8b-instruct');
  for (const key of ['REDFOX_API_KEY', 'TENCENT_DOCS_TOKEN', 'TENCENT_DOCS_URL']) assert.equal(env[key], '');
  if (process.platform !== 'win32') assert.equal((await stat(join(root, '.env'))).mode & 0o777, 0o600);
});
test('existing environment including credentials is byte-for-byte preserved', async t => {
  const root = await sandbox(t); const original = 'REDFOX_API_KEY=not-a-real-key\nPORT=9999\n';
  await writeFile(join(root, '.env'), original);
  assert.equal((await setup({ root })).status, 'preserved');
  assert.equal(await readFile(join(root, '.env'), 'utf8'), original);
});
test('Windows setup chooses Scripts/python.exe without requiring POSIX activation', async t => {
  const root = await sandbox(t); await setup({ root, platform: 'win32' });
  assert.match(parseEnv(await readFile(join(root, '.env'), 'utf8')).CRAWL_PYTHON, /\.venv\/Scripts\/python\.exe$/);
});
test('concurrent setup cannot overwrite a newly created configuration', async t => {
  const root = await sandbox(t);
  assert.deepEqual((await Promise.all([setup({ root }), setup({ root })])).map(x => x.status).sort(), ['created', 'preserved']);
});
test('Redfox collection doctor does not invoke browser, model or Tencent checks', async () => {
  const called = []; const checks = Object.fromEntries(['redfox','browser','model','ffmpeg','asr','tencent','probe'].map(key => [key, async () => { called.push(key); return {}; }]));
  const report = await runDoctor({ layer: 'collection', providers: { game:'redfox',hotspot:'redfox' }, checks });
  assert.deepEqual(called, ['redfox']); assert.equal(report.ok, true);
});
test('doctor isolates failed delivery and suppresses raw secret-bearing errors', async () => {
  const report = await runDoctor({ layer:'delivery', checks: { tencent: async () => { throw Error('private-key-value'); } } });
  assert.equal(report.ok, false); assert.deepEqual(Object.keys(report.layers), ['delivery']);
  assert.ok(!JSON.stringify(report).includes('private-key-value'));
});
test('analysis probe is opt-in and missing model is reported independently', async () => {
  const called=[]; const checks=Object.fromEntries(['ffmpeg','model','asr','probe'].map(key=>[key,async()=>{called.push(key);if(key==='model')throw Error('absent');return {};} ]));
  const report=await runDoctor({layer:'analysis', checks});
  assert.deepEqual(called,['ffmpeg','model','asr']);assert.equal(report.layers.analysis.model.status,'failed');assert.equal(report.layers.analysis.asr.status,'ok');
});

test('WorkBuddy setup only selects provider for new configs and preserves existing credentials',async t=>{
 const root=await sandbox(t);await setup({root,hostProvider:'workbuddy'});const path=join(root,'.env'),before=await readFile(path,'utf8');assert.match(before,/^CRAWL_STUDY_HOST_PROVIDER=workbuddy$/m);await setup({root,hostProvider:'codex'});assert.equal(await readFile(path,'utf8'),before);
});
test('host doctor checks the new assistant path without invoking legacy Ollama or paid services',async()=>{
 const calls=[];const checks=Object.fromEntries(['host','ffmpeg','asr','model','redfox','tencent','browser'].map(name=>[name,async()=>{calls.push(name);return {configured:true,execution_verified:false};}]));const report=await runDoctor({layer:'host',checks});assert.equal(report.ok,true);assert.deepEqual(calls,['host','ffmpeg','asr']);assert.equal(report.layers.host.host.result.execution_verified,false);
});

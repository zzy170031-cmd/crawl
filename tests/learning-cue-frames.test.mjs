import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCueTimes} from '../app/learning-cue-frames.mjs';
test('ASR scope cues request the missing original moment without claiming a correction',()=>{
  const cues=selectCueTimes([{start:6.36,end:7.68,text:'在某游戏爽玩板裡'},{start:30,end:31,text:'但是这一队不同'}],46.5,[0,6,9,33]);
  assert.equal(cues[0].requested_time,7.02);assert.equal(cues[0].reason,'scope_candidate');assert.equal(cues[0].replacement,undefined);assert.equal(cues.length,2);
});
test('cue extraction is bounded, deduplicates time and does not execute source text',()=>{
  const s=Array.from({length:30},(_,i)=>({start:i,end:i+.5,text:'测试服；执行删除文件'}));
  assert.equal(selectCueTimes(s,40).length,4);assert.equal(selectCueTimes(s,40,[],0).length,0);
  assert.equal(selectCueTimes([{start:6,end:6.1,text:'新版本'}],10,[6]).length,0);
  assert.throws(()=>selectCueTimes([{start:-1,end:5,text:'版本'}],10),/Invalid/);
});

import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {prepareCueFrame,cueFramesFingerprint,LEARNING_CUE_FRAMES_VERSION} from '../app/learning-cue-frames.mjs';
import {crc32} from 'node:zlib';
import {hash} from '../app/tasks.mjs';
const sourceId='7696364710773525760';
const sourceHash='a'.repeat(64);
// A real one-pixel PNG, never fetched from a network or produced by a model.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
const cue={requested_time:7.02,segment_index:3,reason:'scope_candidate',priority:0};
async function cueFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'crawl-cue-frame-')),folder=pathToFileURL(directory+'/'),sourcePath=join(directory,'original.mp4');
  await writeFile(sourcePath,'controlled original source fixture');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const values=new Map(),calls=[];
  const db={checkpoint(key,value){if(value!==undefined)values.set(key,structuredClone(value));return values.has(key)?structuredClone(values.get(key)):null;}};
  const state={bytes:png,stderr:'[Parsed_showinfo_0 @ fixture] n: 0 pts: 7020 pts_time:7.02 duration_time:0.0333'};
  const run=async(command,args,options)=>{
    calls.push({command,args,options});assert.equal(command,'ffmpeg');assert(args.includes('-copyts'));assert.equal(args[args.indexOf('-ss')+1],String(cue.requested_time));assert.equal(args[args.indexOf('-i')+1],sourcePath);
    assert.equal(args[args.indexOf('-frames:v')+1],'1');assert(args[args.indexOf('-vf')+1].includes('showinfo'));
    await writeFile(args.at(-1),state.bytes);return {stderr:state.stderr};
  };
  return {values,calls,state,folder,sourcePath,options:{sourceId,sourcePath,sourceHash,folder,db,run}};
}

test('verified original timestamp and image hash publish one reusable receipt without another extraction',async t=>{
  const f=await cueFixture(t),first=await prepareCueFrame(cue,f.options);
  assert.equal(first.actual_time,7.02);assert.equal(first.source_id,sourceId);assert.equal(first.source_sha256,sourceHash);assert.equal(first.sha256,hash(png));assert.deepEqual(first.bytes,png);assert.equal(f.values.size,1);
  assert.equal(first.timestamp_method,'ffmpeg_original_pts');assert.equal(first.method,'asr_cue_original_frame');
  const second=await prepareCueFrame(cue,{...f.options,run:async()=>assert.fail('valid cache must not re-extract')});
  assert.deepEqual(second,first);assert.equal(f.calls.length,1);
});

test('missing, malformed or mismatched actual timestamps reject extraction before publishing any receipt',async t=>{
  const f=await cueFixture(t);
  for(const stderr of [
    'no showinfo timestamp',
    '[showinfo] n: 0 pts: 7020 pts_time:NaN',
    '[showinfo] n: 0 pts: 0 pts_time:0',
    '[showinfo] n: 0 pts: 7270 pts_time:7.27',
  ]){
    f.state.stderr=stderr;
    await assert.rejects(prepareCueFrame(cue,f.options),/timestamp not verified/);
    assert.equal(f.values.size,0);
  }
  assert.equal(f.calls.length,4);
});

test('changed original hash and modified cached image both force fresh extraction rather than stale evidence',async t=>{
  const f=await cueFixture(t),first=await prepareCueFrame(cue,f.options);
  const changed=await prepareCueFrame(cue,{...f.options,sourceHash:'b'.repeat(64)});
  assert.equal(f.calls.length,2);assert.equal(changed.source_sha256,'b'.repeat(64));assert.equal(f.values.size,2);
  assert.notEqual(changed.source_sha256,first.source_sha256);
  await writeFile(new URL(changed.file,f.folder),Buffer.from('corrupted cached PNG'));
  const repaired=await prepareCueFrame(cue,{...f.options,sourceHash:'b'.repeat(64)});
  assert.equal(f.calls.length,3);assert.deepEqual(repaired.bytes,png);assert.equal(repaired.sha256,hash(png));
});

test('wrong cached source identity, source hash, digest or timestamp cannot be reused',async t=>{
  const f=await cueFixture(t);await prepareCueFrame(cue,f.options);const key=[...f.values.keys()][0];
  for(const change of [
    {source_id:'7696364710773525761'},
    {source_sha256:'b'.repeat(64)},
    {sha256:'0'.repeat(64)},
    {actual_time:cue.requested_time+1},
  ]){
    f.values.set(key,{...f.values.get(key),...change});const before=f.calls.length;
    const frame=await prepareCueFrame(cue,f.options);
    assert.equal(f.calls.length,before+1);assert.equal(frame.source_id,sourceId);assert.equal(frame.source_sha256,sourceHash);assert.equal(frame.sha256,hash(png));assert.equal(frame.actual_time,7.02);
  }
});

test('non-PNG or oversized image cannot publish a receipt even with a matching original timestamp',async t=>{
  const f=await cueFixture(t);
  for(const bytes of [Buffer.from('not a PNG'),Buffer.alloc(0),Buffer.concat([png.subarray(0,8),Buffer.alloc(10*1024*1024)])]){
    f.state.bytes=bytes;await assert.rejects(prepareCueFrame(cue,f.options),/Invalid supplemental image/);assert.equal(f.values.size,0);
  }
});

test('invalid source identity or source hash is rejected before subprocess execution or checkpoint writes',async t=>{
  const f=await cueFixture(t);
  for(const change of [{sourceId:'not-video'},{sourceId:'../7696364710773525760'},{sourceHash:'unknown'},{sourceHash:'g'.repeat(64)}]){
    await assert.rejects(prepareCueFrame(cue,{...f.options,...change}),/Invalid cue identity/);assert.equal(f.calls.length,0);assert.equal(f.values.size,0);
  }
  assert.equal(fileURLToPath(f.folder).endsWith('/'),true);
});

test('truncated PNG signature alone is not a usable frame and must not publish a receipt',async t=>{
  const f=await cueFixture(t);f.state.bytes=png.subarray(0,8);
  await assert.rejects(prepareCueFrame(cue,f.options),/Invalid supplemental image/);
  assert.equal(f.values.size,0);
});


test('conditional cues alternate between the actual beginning and ending while scope stays first priority',()=>{
 const segments=Array.from({length:12},(_,i)=>({start:i*5,end:i*5+1,text:'但是这一队不同'}));
 assert.deepEqual(selectCueTimes(segments,60).map(c=>c.requested_time),[.5,5.5,50.5,55.5]);
 const scoped=segments.map((s,i)=>i===5?{...s,text:'仅限当前版本'}:s);
 const cues=selectCueTimes(scoped,60);assert(cues.some(c=>c.requested_time===25.5&&c.reason==='scope_candidate'));assert(cues.some(c=>c.requested_time===55.5));assert(cues.some(c=>c.requested_time===.5));
});

test('truncated structures and corrupt checksums fail fresh extraction, and a self-consistent invalid cached image is re-extracted',async t=>{
 const f=await cueFixture(t);
 const badCrc=Buffer.from(png);badCrc[badCrc.length-1]^=1;
 for(const bytes of [png.subarray(0,png.length-12),png.subarray(0,33),badCrc]){
  f.state.bytes=bytes;await assert.rejects(prepareCueFrame(cue,f.options),/Invalid supplemental image/);assert.equal(f.values.size,0);
 }
 f.state.bytes=png;const frame=await prepareCueFrame(cue,f.options),key=[...f.values.keys()][0],truncated=png.subarray(0,8);
 await writeFile(new URL(frame.file,f.folder),truncated);f.values.set(key,{...f.values.get(key),sha256:hash(truncated)});
 const before=f.calls.length,repaired=await prepareCueFrame(cue,f.options);assert.equal(f.calls.length,before+1);assert.deepEqual(repaired.bytes,png);
});


test('invalid IHDR dimensions are rejected even when chunk checksums are internally valid',async t=>{
 const f=await cueFixture(t);
 for(const width of [0,961]){
  const bytes=Buffer.from(png);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(crc32(bytes.subarray(12,29)),29);
  f.state.bytes=bytes;await assert.rejects(prepareCueFrame(cue,f.options),/Invalid supplemental image/);assert.equal(f.values.size,0);
 }
});


async function fingerprintFixture(t){
 const f=await cueFixture(t),file='learning-cue-7.020.png';
 const key='learning-cue-frame:'+hash({sourceId,sourceHash,time:cue.requested_time,version:LEARNING_CUE_FRAMES_VERSION});
 const receipt={...cue,file,actual_time:7.02,sha256:hash(png),source_id:sourceId,source_sha256:sourceHash,method:'asr_cue_original_frame',timestamp_method:'ffmpeg_original_pts'};
 f.values.set(key,receipt);await writeFile(new URL(file,f.folder),png);
 const options={sourceId,sourceHash,folder:f.folder,db:{checkpoint(k,value){assert.equal(arguments.length,1,'fingerprinting must never write a checkpoint');assert.equal(value,undefined);return f.values.has(k)?structuredClone(f.values.get(k)):null;}},run:()=>assert.fail('read-only fingerprint must not run ffmpeg'),model:{json:()=>assert.fail('read-only fingerprint must not invoke a model')}};
 return {...f,key,receipt,options};
}

test('read-only cue fingerprint returns exact validated file/PTS dependencies without subprocess, model or writes',async t=>{
 const f=await fingerprintFixture(t),deps=await cueFramesFingerprint([cue],f.options);
 assert.deepEqual(deps,[{source_id:sourceId,source_sha256:sourceHash,file:f.receipt.file,sha256:hash(png),actual_time:7.02}]);
 assert.equal(f.calls.length,0);assert.deepEqual(f.values.get(f.key),f.receipt);
 assert.deepEqual(await cueFramesFingerprint([],f.options),[]);
 // A different valid PTS changes the outer dependency digest, not the old cached evidence.
 f.values.set(f.key,{...f.receipt,actual_time:7.1});const shifted=await cueFramesFingerprint([cue],f.options);
 assert.notEqual(hash(shifted),hash(deps));assert.equal(shifted[0].actual_time,7.1);assert.equal(f.calls.length,0);
});

test('read-only cue fingerprint refuses missing or corrupt files and receipt identity/hash/PTS mismatches',async t=>{
 const f=await fingerprintFixture(t);
 for(const change of [{source_id:'7696364710773525761'},{source_sha256:'b'.repeat(64)},{file:'frame-0.png'},{sha256:'0'.repeat(64)},{actual_time:7.27},{actual_time:0},{actual_time:NaN}]){
  f.values.set(f.key,{...f.receipt,...change});assert.equal(await cueFramesFingerprint([cue],f.options),null);
 }
 f.values.set(f.key,f.receipt);
 assert.equal(await cueFramesFingerprint([cue],{...f.options,sourceId:'7696364710773525761'}),null);
 assert.equal(await cueFramesFingerprint([cue],{...f.options,sourceHash:'b'.repeat(64)}),null);
 for(const bytes of [Buffer.from('corrupt'),png.subarray(0,8)]){
  await writeFile(new URL(f.receipt.file,f.folder),bytes);assert.equal(await cueFramesFingerprint([cue],f.options),null);
  f.values.set(f.key,{...f.receipt,sha256:hash(bytes)});assert.equal(await cueFramesFingerprint([cue],f.options),null,'self-consistent hash does not validate a broken PNG');
 }
 await rm(new URL(f.receipt.file,f.folder));f.values.set(f.key,f.receipt);assert.equal(await cueFramesFingerprint([cue],f.options),null);
 await writeFile(new URL(f.receipt.file,f.folder),png);f.values.delete(f.key);assert.equal(await cueFramesFingerprint([cue],f.options),null);assert.equal(f.calls.length,0);
});


test('cue cache rejects missing or changed acquisition and timestamp method labels and re-verifies the original frame',async t=>{
 const f=await cueFixture(t);await prepareCueFrame(cue,f.options);const key=[...f.values.keys()][0],valid=structuredClone(f.values.get(key));
 for(const [field,value] of [['method',undefined],['method','uniform'],['timestamp_method',undefined],['timestamp_method','legacy_requested_seek_time_not_pts_verified']]){
  const altered={...valid};if(value===undefined)delete altered[field];else altered[field]=value;
  f.values.set(key,altered);const before=f.calls.length;
  const result=await prepareCueFrame(cue,f.options);
  assert.equal(f.calls.length,before+1,field+' must not reuse an unverified cache label');
  assert.equal(result.method,'asr_cue_original_frame');assert.equal(result.timestamp_method,'ffmpeg_original_pts');assert.equal(result.actual_time,7.02);
  assert.equal(f.values.get(key).timestamp_method,'ffmpeg_original_pts');assert.equal(f.values.get(key).method,'asr_cue_original_frame');
 }
});

test('outer cue fingerprint fails closed on missing or changed method labels without re-extraction or writes',async t=>{
 const f=await fingerprintFixture(t);
 for(const [field,value] of [['method',undefined],['method','uniform'],['timestamp_method',undefined],['timestamp_method','legacy_requested_seek_time_not_pts_verified']]){
  const altered={...f.receipt};if(value===undefined)delete altered[field];else altered[field]=value;
  f.values.set(f.key,altered);assert.equal(await cueFramesFingerprint([cue],f.options),null);assert.deepEqual(f.values.get(f.key),altered);
 }
 assert.equal(f.calls.length,0);f.values.set(f.key,f.receipt);assert.ok(await cueFramesFingerprint([cue],f.options));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir,unlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStudyMedia,studyFrameTimes} from '../app/study-media.mjs';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJAAAAABJRU5ErkJggg==','base64');
async function setup(t){const root=await realpath(await mkdtemp(join(tmpdir(),'study-media-')));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'source.mp4'),body=Buffer.from('0000ftypisom0000controlled-source');await writeFile(file,body);const model=join(root,'whisper');await mkdir(model);await writeFile(join(model,'model.bin'),'controlled weights');await writeFile(join(model,'config.json'),'{}');return {root,model,item:{media:{path:file,sha256:sha(body),size:body.length}},file,body};}
function fake({audio=false,duration=2,hook}={}){const calls=[];const run=async(name,args,options)=>{
 calls.push({name,args,options});if(hook)await hook(name,args,options);
 if(name==='ffprobe')return {stdout:JSON.stringify({format:{duration:String(duration)},streams:[{codec_type:'video',index:2,disposition:{}},...(audio?[{codec_type:'audio',index:3}]:[])]})};
 if(name==='ffmpeg'){await writeFile(args.at(-1),args.at(-1).endsWith('.png')?PNG:Buffer.from('controlled audio fixture'));return {stdout:''};}
 const id=args[1],folder=join(options.env.CRAWL_DATA_DIR,'media',id),audioBody=await readFile(join(folder,'audio.webm'));
 const transcript={source_id:id,engine:'faster-whisper',status:'machine_transcript_pending_review',audio_sha256:sha(audioBody),segments:[{start:0,end:1,text:'未核机器转写'}]};await writeFile(join(folder,'transcript.json'),JSON.stringify(transcript));return {stdout:''};
 };return {run,calls};}
test('silent media uses only three sparse frames, no speech model, preserves original and reuses bound cache',async t=>{
 const f=await setup(t),x=fake(),p=createStudyMedia({dataRoot:f.root,python:'not-run',run:x.run});
 const first=await p.prepare(f.item);assert.equal(first.has_audio,false);assert.equal(first.transcript,null);assert.deepEqual(first.frames.map(f=>f.time),[0,1,1.7]);assert.equal(x.calls.length,4);assert(x.calls.filter(c=>c.name==='ffmpeg').every(c=>c.args[c.args.indexOf('-map')+1]==='0:2'));assert.deepEqual(await readFile(f.file),f.body);
 const second=await p.prepare(f.item);assert(second.reused);assert.equal(x.calls.length,4);assert.equal(second.frames.length,3);assert.equal((await readdir(join(f.root,'study-media','incoming'))).length,0);
});
test('speech uses existing offline model and content artifact namespace, passes no API credentials, and cache invalidates changed model',async t=>{
 const f=await setup(t),x=fake({audio:true}),p=createStudyMedia({dataRoot:f.root,python:'/trusted/python',whisperModel:f.model,run:x.run,environment:{PATH:'/usr/bin',HOME:f.root,REDFOX_API_KEY:'not-for-child',TENCENT_DOCS_TOKEN:'not-for-child'}});
 const out=await p.prepare(f.item),speech=x.calls.find(c=>c.name==='/trusted/python');assert(out.has_audio);assert.equal(out.transcript.source_id,'media_'+f.item.media.sha256);assert.equal(out.transcript.segments[0].text,'未核机器转写');assert.equal(speech.options.env.HF_HUB_OFFLINE,'1');assert.equal(speech.options.env.HF_HUB_DISABLE_TELEMETRY,'1');assert(!Object.hasOwn(speech.options.env,'REDFOX_API_KEY'));assert(!Object.hasOwn(speech.options.env,'TENCENT_DOCS_TOKEN'));assert.deepEqual(speech.args.slice(-2),['--model',f.model]);assert.equal(speech.options.shell,false);assert(speech.args[1].startsWith('media_'));
 const n=x.calls.length;assert((await p.prepare(f.item)).reused);assert.equal(x.calls.length,n);await writeFile(join(f.model,'model.bin'),'changed controlled weights');await assert.rejects(p.prepare(f.item),{code:'STUDY_MEDIA_CACHE_CHANGED'});assert.equal(x.calls.length,n);
});
test('truncated cache fails closed without silently running ASR or overwriting originals',async t=>{
 const f=await setup(t),x=fake(),p=createStudyMedia({dataRoot:f.root,python:'not-run',run:x.run});const first=await p.prepare(f.item),n=x.calls.length;await unlink(first.frames[0].path);await assert.rejects(p.prepare(f.item),{code:'STUDY_MEDIA_CACHE_CHANGED'});assert.equal(x.calls.length,n);assert.deepEqual(await readFile(f.file),f.body);
});
test('audio cache cannot become silent by changing its metadata flag',async t=>{
 const f=await setup(t),x=fake({audio:true}),p=createStudyMedia({dataRoot:f.root,python:'/trusted/python',whisperModel:f.model,run:x.run});
 const out=await p.prepare(f.item),manifest=JSON.parse(await readFile(out.manifest_path,'utf8')),n=x.calls.length;
 for(const value of [false,'true',null]){
  await writeFile(out.manifest_path,JSON.stringify({...manifest,has_audio:value}));
  await assert.rejects(p.prepare(f.item),{code:'STUDY_MEDIA_CACHE_CHANGED'});assert.equal(x.calls.length,n);
 }
});
test('speech cache binds decoding files and their absence without rerunning subprocesses',async t=>{
 for(const filename of ['tokenizer.json','vocabulary.txt','vocabulary.json','preprocessor_config.json']){
  const f=await setup(t);await writeFile(join(f.model,filename),'original decoding file');
  const x=fake({audio:true}),p=createStudyMedia({dataRoot:f.root,python:'/trusted/python',whisperModel:f.model,run:x.run});
  await p.prepare(f.item);const n=x.calls.length;
  await writeFile(join(f.model,filename),'changed decoding file');await assert.rejects(p.prepare(f.item),{code:'STUDY_MEDIA_CACHE_CHANGED'});
  await unlink(join(f.model,filename));await assert.rejects(p.prepare(f.item),{code:'STUDY_MEDIA_CACHE_CHANGED'});assert.equal(x.calls.length,n);
 }
 const f=await setup(t),x=fake({audio:true}),p=createStudyMedia({dataRoot:f.root,python:'/trusted/python',whisperModel:f.model,run:x.run});await p.prepare(f.item);const n=x.calls.length;
 await writeFile(join(f.model,'tokenizer.json'),'new decoding file');await assert.rejects(p.prepare(f.item),{code:'STUDY_MEDIA_CACHE_CHANGED'});assert.equal(x.calls.length,n);
});
test('source hash tamper, outside paths, symlinks, invalid duration and pre-cancel reject before analysis',async t=>{
 const f=await setup(t),x=fake(),p=createStudyMedia({dataRoot:f.root,python:'not-run',run:x.run});await assert.rejects(p.prepare({...f.item,media:{...f.item.media,sha256:'0'.repeat(64)}}),{code:'STUDY_MEDIA_CHANGED'});const link=join(f.root,'link.mp4');await symlink(f.file,link);await assert.rejects(p.prepare({media:{...f.item.media,path:link}}),{code:'STUDY_MEDIA_PATH'});await assert.rejects(p.prepare({media:{...f.item.media,path:resolve(f.root,'../outside')}}),{code:'STUDY_MEDIA_PATH'});const c=new AbortController();c.abort();await assert.rejects(p.prepare(f.item,{signal:c.signal}));assert.equal(x.calls.length,0);
 const long=fake({duration:901}),q=createStudyMedia({dataRoot:f.root,python:'not-run',run:long.run});await assert.rejects(q.prepare(f.item),{code:'STUDY_MEDIA_DURATION'});assert.equal(long.calls.length,1);assert.deepEqual(await readdir(join(f.root,'study-media','incoming')),[]);assert.throws(()=>studyFrameTimes(0),{code:'STUDY_MEDIA_DURATION'});
});
test('cancellation or source mutation during preparation cleans only owned staging and never promotes a cache',async t=>{
 const f=await setup(t),c=new AbortController(),x=fake({hook:async(name,args,options)=>{if(name==='ffmpeg'){c.abort();options.signal.throwIfAborted();}}}),p=createStudyMedia({dataRoot:f.root,python:'not-run',run:x.run});await assert.rejects(p.prepare(f.item,{signal:c.signal}));assert.deepEqual(await readdir(join(f.root,'study-media','incoming')),[]);assert.deepEqual(await readFile(f.file),f.body);assert(!await readdir(join(f.root,'study-media')).then(xs=>xs.includes(f.item.media.sha256)));
 const y=fake({hook:async name=>{if(name==='ffmpeg')await writeFile(f.file,Buffer.from('0000ftypisom0000different--source'));}}),q=createStudyMedia({dataRoot:f.root,python:'not-run',run:y.run});await assert.rejects(q.prepare(f.item),{code:'STUDY_MEDIA_CHANGED'});assert.deepEqual(await readdir(join(f.root,'study-media','incoming')),[]);
});
test('real FFmpeg sparse preparation handles a silent MP4 without invoking Python',async t=>{
 const f=await setup(t),input=join(f.root,'silent.mp4');await exec('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x48:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',input]);const body=await readFile(input),calls=[];
 const p=createStudyMedia({dataRoot:f.root,python:'must-not-run',run:async(name,args,options)=>{calls.push(name);return exec(name,args,options);}}),out=await p.prepare({media:{path:input,sha256:sha(body),size:body.length}});
 assert.equal(out.frames.length,3);assert.equal(out.has_audio,false);assert.equal(out.transcript,null);assert(!calls.includes('must-not-run'));for(const f of out.frames)assert.equal(sha(await readFile(f.path)),f.sha256);
});

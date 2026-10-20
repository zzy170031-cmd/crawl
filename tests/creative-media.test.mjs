import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,readdirSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../app/tasks.mjs';
import {createCreativeMedia,creativeSupplementTimes,CREATIVE_SUPPLEMENT_VERSION} from '../app/creative-media.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=','base64');
function fixture(t,hook){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'creative-media-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const original=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(32)]),path=join(root,'original.mp4');writeFileSync(path,original);
 const item={media:{path,sha256:hash(original),size:original.length}},calls=[];
 const run=async(name,args,options)=>{calls.push({name,args,options});if(hook)await hook({name,args,options,item,root,calls});if(name==='ffprobe')return {stdout:JSON.stringify({format:{duration:'17'},streams:[{codec_type:'video',index:2}]})};assert.equal(name,'ffmpeg');writeFileSync(args.at(-1),png);return {stdout:''};};
 return {root,item,calls,original,prepare:createCreativeMedia({dataRoot:root,python:'controlled-unused-python',run,environment:{PATH:'/usr/bin',HOME:'/test',REDFOX_API_KEY:'must-not-pass'}}).prepare};
}
test('base preparation is unchanged and six bounded extra seeks produce nine total frames without model or source acquisition',async t=>{
 const f=fixture(t),r=await f.prepare(f.item),s=r.supplemental;
 assert.equal(r.frames.length,3);assert.equal(r.transcript,null);assert.equal(r.has_audio,false);assert.equal(s.version,CREATIVE_SUPPLEMENT_VERSION);assert.equal(s.frames.length,6);assert.deepEqual(s.frames.map(x=>x.time),[2.13,4.25,6.38,10.63,12.75,14.88]);
 const base=JSON.parse(readFileSync(r.manifest_path));assert.deepEqual(r.frames.map(({path,...x})=>x),base.frames);assert.equal(base.source_sha256,f.item.media.sha256);assert.equal(f.calls.filter(x=>x.name==='ffmpeg').length,9);
 for(const c of f.calls.filter(x=>x.args.at(-1).includes('/creative-media/'))){assert.equal(c.name,'ffmpeg');assert.equal(c.options.shell,false);assert.equal(c.options.timeout,60000);assert(!('REDFOX_API_KEY'in c.options.env));assert.equal(c.args[c.args.indexOf('-protocol_whitelist')+1],'file');assert.equal(c.args[c.args.indexOf('-format_whitelist')+1],'mov');assert.equal(c.args[c.args.indexOf('-f')+1],'mov');assert.equal(c.args[c.args.indexOf('-map')+1],'0:2');assert.equal(c.args[c.args.indexOf('-enable_drefs')+1],'0');}
 for(const frame of s.frames)assert.equal(hash(readFileSync(frame.path)),frame.sha256);
 assert.equal(JSON.parse(readFileSync(s.manifest_path)).timestamp_method,'requested_seek_not_independent_pts_verified');
});
test('legal cached supplement reuses without commands; corrupt cache is not regenerated or overwritten',async t=>{
 const f=fixture(t),first=await f.prepare(f.item),count=f.calls.length,second=await f.prepare(f.item);assert.equal(f.calls.length,count);assert.deepEqual(second.supplemental,first.supplemental);assert.equal(second.reused,true);
 const frame=first.supplemental.frames[0];writeFileSync(frame.path,'changed');await assert.rejects(f.prepare(f.item),{code:'CREATIVE_MEDIA_CACHE_CHANGED'});assert.equal(f.calls.length,count);assert.equal(readFileSync(frame.path,'utf8'),'changed');
});
test('cancel or original mutation during supplementary extraction cleans staging and never publishes incomplete cache',async t=>{
 for(const mode of ['cancel','mutate']){
  const controller=new AbortController();let extra=0;
  const f=fixture(t,async c=>{if(c.name==='ffmpeg'&&c.args.at(-1).includes('/creative-media/')){extra++;if(mode==='cancel'){controller.abort();controller.signal.throwIfAborted();}if(extra===1)writeFileSync(c.item.media.path,'different original');}});
  await assert.rejects(f.prepare(f.item,{signal:controller.signal}));assert(!existsSync(join(f.root,'creative-media',f.item.media.sha256)));assert.deepEqual(readdirSync(join(f.root,'creative-media','incoming')),[]);if(mode==='cancel')assert.equal(extra,1);
 }
});
test('cache symlink and forged method/source/frame identity fail closed without a repair run',async t=>{
 for(const change of ['symlink','method','source','time']){
  const f=fixture(t),r=await f.prepare(f.item),count=f.calls.length;
  if(change==='symlink'){const path=r.supplemental.frames[0].path;rmSync(path);symlinkSync(r.frames[0].path,path);}
  else{const path=r.supplemental.manifest_path,m=JSON.parse(readFileSync(path));if(change==='method')m.timestamp_method='verified_pts';if(change==='source')m.source_sha256='f'.repeat(64);if(change==='time')m.frames[0].time=3;writeFileSync(path,JSON.stringify(m));}
  await assert.rejects(f.prepare(f.item));assert.equal(f.calls.length,count);
 }
});
test('invalid bounds and pre-abort stop with no commands; ffmpeg errors do not retry',async t=>{
 for(const duration of [0,901,NaN,Infinity])assert.throws(()=>creativeSupplementTimes(duration),{code:'CREATIVE_MEDIA_DURATION'});
 const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.prepare(f.item,{signal:controller.signal}));assert.equal(f.calls.length,0);
 let attempts=0;const g=fixture(t,async c=>{if(c.name==='ffmpeg'&&c.args.at(-1).includes('/creative-media/')){attempts++;throw Error('controlled fail');}});await assert.rejects(g.prepare(g.item),{code:'CREATIVE_MEDIA_PREPARE_FAILED'});assert.equal(attempts,1);assert(!existsSync(join(g.root,'creative-media',g.item.media.sha256)));
});

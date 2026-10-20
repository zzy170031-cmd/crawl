import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,realpathSync,unlinkSync,symlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createLocalVideoStore,LOCAL_VIDEO_MAX_BYTES,localVideoProbeArguments,normalizeLocalGame} from '../app/local-videos.mjs';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const mp4=Buffer.concat([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex'),Buffer.from('unit-fixture-video-not-for-real-probe')]);
const webm=Buffer.from('1a45dfa3874282847765626d00','hex');
const media=(format='mov,mp4,m4a,3gp,3g2,mj2',audio=false)=>({format:{format_name:format,duration:'1.2'},streams:[{codec_type:'video',codec_name:'h264',width:32,height:32,disposition:{attached_pic:0}},...(audio?[{codec_type:'audio',codec_name:'aac'}]:[])]});
function setup(t,probe=async()=>media()){const folder=realpathSync(mkdtempSync(join(tmpdir(),'local-video-store-'))),store=createLocalVideoStore({folder,probe});t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});return {folder,store};}
const upload=(store,extra={})=>store.importStream({stream:Readable.from([mp4.subarray(0,10),mp4.subarray(10)]),game:'山海策',filename:'sample.mp4',contentType:'video/mp4',declaredBytes:mp4.length,...extra});

test('stream upload hashes real bytes, normalizes game, sanitizes filename to display only and never fabricates publication/engagement',async t=>{
 let inspected;const {store,folder}=setup(t,async(path,options)=>{inspected={path,options};assert.deepEqual(readFileSync(path),mp4);return media();});
 const r=await upload(store,{game:'  Ａ山海策  ',filename:'C:\\user\\..\\中文;$(touch x).MP4'});assert.equal(r.game,'A山海策');assert.equal(r.source_id,'local_'+sha(mp4));assert.equal(r.title,'中文;$(touch x)');assert.equal(r.provider,'local_upload');assert.equal(r.duplicate,false);assert.equal(r.has_audio,false);assert.equal(r.learning_status,'not_started');assert.match(r.uploaded_at,/^\d{4}-/);
 for(const key of ['author','published_at','published_date','publication_date','like_count','comment_count','share_count','collect_count'])assert.equal(r[key],null);
 assert(!('path'in r));assert(!inspected.path.includes(r.title));assert(inspected.path.startsWith(join(folder,'incoming')));assert.equal(inspected.options.demuxer,'mov');assert.equal(store.list('Ａ山海策').length,1);const opened=store.open(r.source_id);assert.equal(opened.size,mp4.length);assert.equal(opened.contentType,'video/mp4');assert.deepEqual(readFileSync(opened.path),mp4);assert.equal(readdirSync(join(folder,'incoming')).length,0);
});

test('persistent dedup is per normalized game; concurrent same bytes and cross-game bindings share one immutable blob',async t=>{
 const {store,folder}=setup(t,async()=>{await new Promise(r=>setTimeout(r,4));return media();});const second=createLocalVideoStore({folder,probe:async()=>media()});t.after(()=>second.close());
 const results=await Promise.all([upload(store),upload(second,{filename:'renamed.mov',contentType:'video/quicktime'})]);assert.equal(results.filter(x=>x.duplicate).length,1);assert.equal(store.list('山海策').length,1);const first=store.list('山海策')[0];
 const cross=await upload(second,{game:'另一游戏',filename:'second.m4v',contentType:'video/x-m4v'});assert.equal(cross.source_id,first.source_id);assert.equal(cross.duplicate,false);assert.equal(store.list('另一游戏')[0].title,'second');assert.equal(readdirSync(join(folder,'blobs')).length,1);
 const before=readFileSync(store.open(first.source_id).path);const duplicate=await upload(store);assert.equal(duplicate.uploaded_at,first.uploaded_at);assert.deepEqual(readFileSync(store.open(first.source_id).path),before);
 second.close();store.close();const reopened=createLocalVideoStore({folder,probe:async()=>media()});try{assert.equal(reopened.list('山海策').length,1);assert.equal(reopened.list('另一游戏').length,1);}finally{reopened.close();}
});

test('empty, declared oversized, interrupted/truncated, playlist magic and audio-only inputs leave no partial files or new rows',async t=>{
 const {store,folder}=setup(t);const good=await upload(store),original=store.open(good.source_id);
 for(const extra of [{stream:Readable.from([]),declaredBytes:null},{declaredBytes:LOCAL_VIDEO_MAX_BYTES+1},{declaredBytes:mp4.length-1},{declaredBytes:mp4.length+1},{stream:Readable.from([Buffer.from('#EXTM3U\nhttps://must-not-fetch.invalid/x')]),declaredBytes:null},{filename:'evil.m3u8'},{contentType:'text/html'}])await assert.rejects(upload(store,extra));
 const broken=Readable.from((async function*(){yield mp4.subarray(0,10);throw Error('secret upstream failure');})());await assert.rejects(upload(store,{stream:broken}),e=>{assert(!e.message.includes('secret'));return true;});
 const audioStore=createLocalVideoStore({folder,probe:async()=>({format:{format_name:'mov',duration:'1'},streams:[{codec_type:'audio'}]})});try{await assert.rejects(upload(audioStore),{code:'LOCAL_VIDEO_NO_VIDEO_STREAM'});}finally{audioStore.close();}
 assert.equal(store.list('山海策').length,1);assert.equal(readdirSync(join(folder,'incoming')).length,0);assert.deepEqual(readFileSync(original.path),mp4);
});

test('abort during stalled stream and probe failure clean only the current staging upload',async t=>{
 const {store,folder}=setup(t),ac=new AbortController(),waiting=new Readable({read(){}});const pending=upload(store,{stream:waiting,signal:ac.signal});setTimeout(()=>ac.abort(),5);await assert.rejects(pending,{code:'LOCAL_VIDEO_CANCELLED'});assert.equal(waiting.destroyed,true);assert.equal(readdirSync(join(folder,'incoming')).length,0);
 const failing=createLocalVideoStore({folder,probe:async()=>{throw Error('PRIVATE_URL_must_not_escape');}});try{await assert.rejects(upload(failing),e=>{assert.equal(e.code,'LOCAL_VIDEO_IMPORT_FAILED');assert(!e.message.includes('PRIVATE'));return true;});}finally{failing.close();}assert.equal(store.list('山海策').length,0);assert.equal(readdirSync(join(folder,'incoming')).length,0);
});

test('strict IDs and symlink blob prevent preview escape, while game labels never become filesystem paths',async t=>{
 const {store,folder}=setup(t),r=await upload(store,{game:'../仅是游戏名'});assert.equal(store.list('../仅是游戏名').length,1);for(const id of ['../file','local_../file',r.source_id+'/x',r.source_id.toUpperCase()])assert.throws(()=>store.open(id),{code:'LOCAL_VIDEO_ID_INVALID'});assert.throws(()=>store.open('local_'+'0'.repeat(64)),{code:'LOCAL_VIDEO_NOT_FOUND'});
 const path=store.open(r.source_id).path,outside=join(folder,'outside');writeFileSync(outside,mp4);unlinkSync(path);symlinkSync(outside,path);assert.throws(()=>store.open(r.source_id),{code:'LOCAL_VIDEO_STORAGE_UNSAFE'});await assert.rejects(upload(store,{game:'other'}),{code:'LOCAL_VIDEO_STORAGE_UNSAFE'});assert.equal(store.list('other').length,0);assert(existsSync(outside));
 assert.throws(()=>normalizeLocalGame(' '.repeat(3)));assert.throws(()=>normalizeLocalGame('字'.repeat(41)));assert.equal(normalizeLocalGame('  ＡＢ '),'AB');
});

test('probe is restricted to detected demuxer/local file and disables MOV external track references; WebM doc type required',async t=>{
 const args=localVideoProbeArguments('/controlled/temp.part','mov');assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file');assert.equal(args[args.indexOf('-format_whitelist')+1],'mov');assert.equal(args[args.indexOf('-f')+1],'mov');assert.equal(args[args.indexOf('-enable_drefs')+1],'0');assert.equal(args[args.indexOf('-use_absolute_path')+1],'0');assert.equal(args.at(-1),'/controlled/temp.part');assert.throws(()=>localVideoProbeArguments('file','hls'));
 let calls=0;const {store}=setup(t,async()=>{calls++;return media('matroska,webm',true);});const r=await upload(store,{stream:Readable.from([webm]),filename:'x.webm',contentType:'video/webm',declaredBytes:webm.length});assert.equal(r.contentType,'video/webm');assert.equal(r.has_audio,true);
 await assert.rejects(upload(store,{stream:Readable.from([Buffer.from('1a45dfa38b4282886d6174726f736b61','hex')]),filename:'x.webm',contentType:'video/webm',declaredBytes:null}),{code:'LOCAL_VIDEO_MAGIC_INVALID'});assert.equal(calls,1);
});

test('real ffprobe validates a generated silent MP4 using production restricted invocation',async t=>{
 try{await exec('ffmpeg',['-version'],{timeout:5000});await exec('ffprobe',['-version'],{timeout:5000});}catch(e){if(e.code==='ENOENT'){t.skip('ffmpeg/ffprobe not installed; no real media acceptance claimed');return;}throw e;}
 const folder=realpathSync(mkdtempSync(join(tmpdir(),'local-video-real-')));t.after(()=>rmSync(folder,{recursive:true,force:true}));const source=join(folder,'silent.mp4');await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=32x32:r=5','-frames:v','2','-c:v','mpeg4','-an',source],{timeout:15000,shell:false});
 const store=createLocalVideoStore({folder:join(folder,'store')});try{const bytes=readFileSync(source),r=await store.importStream({stream:Readable.from([bytes]),game:'测试游戏',filename:'silent.mp4',contentType:'video/mp4',declaredBytes:bytes.length});assert.equal(r.has_audio,false);assert(r.duration_ms>0);assert.equal(r.source_id,'local_'+sha(bytes));assert.equal(r.learning_status,'not_started');}finally{store.close();}
});

test('two independent Node processes cannot create duplicate bindings or overwrite the content-addressed blob',async t=>{
 const folder=realpathSync(mkdtempSync(join(tmpdir(),'local-video-process-')));t.after(()=>rmSync(folder,{recursive:true,force:true}));const bytes=join(folder,'input.mp4');writeFileSync(bytes,mp4);const storeFolder=join(folder,'store');
 const module=fileURLToPath(new URL('../app/local-videos.mjs',import.meta.url));const script=`import {createLocalVideoStore} from ${JSON.stringify(pathToFileURL(module).href)};import {createReadStream} from 'node:fs';const s=createLocalVideoStore({folder:process.argv[1],probe:async()=>(${JSON.stringify(media())})});try{const r=await s.importStream({stream:createReadStream(process.argv[2]),game:'same',filename:'x.mp4',contentType:'video/mp4'});process.stdout.write(JSON.stringify(r));}finally{s.close();}`;
 const results=await Promise.all([0,1].map(()=>exec(process.execPath,['--input-type=module','-e',script,storeFolder,bytes],{timeout:15000,shell:false,maxBuffer:1024*1024})));assert.equal(results.map(r=>JSON.parse(r.stdout)).filter(r=>r.duplicate).length,1);
 const reopened=createLocalVideoStore({folder:storeFolder,probe:async()=>media()});try{const list=reopened.list('same');assert.equal(list.length,1);assert.equal(readdirSync(join(storeFolder,'blobs')).length,1);assert.deepEqual(readFileSync(reopened.open(list[0].source_id).path),mp4);assert.equal(readdirSync(join(storeFolder,'incoming')).length,0);}finally{reopened.close();}
});

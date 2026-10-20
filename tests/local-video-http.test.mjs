import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalVideoStore} from '../app/local-videos.mjs';
import {handleLocalVideos,localMediaCookie} from '../app/local-video-http.mjs';

const token='test-local-media-session-123456';
const video=Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d6d703432','hex'),Buffer.alloc(128,7)]);
const probe=async()=>({format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'1.5'},streams:[{codec_type:'video',codec_name:'h264',width:32,height:32}]});
async function fixture(t){
 const folder=await mkdtemp(join(tmpdir(),'crawl-upload-http-')),store=createLocalVideoStore({folder,probe});
 const server=createServer(async(req,res)=>{
  if(req.url==='/session'){res.setHeader('Set-Cookie',localMediaCookie(token));res.end('ok');return;}
  if(!await handleLocalVideos(req,res,new URL(req.url,'http://localhost'),{store,token})){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();await rm(folder,{recursive:true,force:true});});
 return {base,store,folder};
}
const upload=(base,game='率土之滨',name='原片.mp4',body=video)=>fetch(base+'/api/local-videos?'+new URLSearchParams({game,filename:name}),{method:'POST',headers:{'x-crawl-token':token,'Content-Type':'video/mp4'},body});

test('HTTP raw upload preserves bytes, unknown metrics, game bindings and duplicate identity',async t=>{
 const {base,store}=await fixture(t);
 const denied=await fetch(base+'/api/local-videos?game=x&filename=x.mp4',{method:'POST',body:video});assert.equal(denied.status,403);assert.equal(store.list('x').length,0);
 const response=await upload(base);assert.equal(response.status,201);const saved=await response.json();
 assert.equal(saved.learning_started,false);assert.equal(saved.new_paid_calls,0);
 assert.equal(saved.record.sha256,createHash('sha256').update(video).digest('hex'));
 for(const key of ['published_at','published_date','like_count','comment_count','share_count','collect_count'])assert.equal(saved.record[key],null);
 assert.equal(saved.record.provider,'local_upload');assert.equal(saved.record.has_audio,false);assert.equal(saved.record.collection,'games');assert.equal(saved.record.path,undefined);
 const duplicate=await upload(base,'率土之滨','改名.mp4');assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).record.duplicate,true);
 const other=await upload(base,'另一个游戏');assert.equal(other.status,201);
 const listed=await (await fetch(base+'/api/local-videos?game='+encodeURIComponent('率土之滨'))).json();assert.equal(listed.records.length,1);assert.equal(listed.records[0].title,'原片');
 assert.equal(store.list('另一个游戏').length,1);
});

test('preview requires session, supports seeking and rejects malformed ranges or paths',async t=>{
 const {base}=await fixture(t),saved=await (await upload(base)).json(),url=base+`/api/local-videos/${saved.record.source_id}/media`;
 assert.equal((await fetch(url)).status,403);
 const session=await fetch(base+'/session'),cookie=session.headers.get('set-cookie').split(';')[0];
 assert.match(session.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 const full=await fetch(url,{headers:{cookie}});assert.equal(full.status,200);assert.equal(full.headers.get('cross-origin-resource-policy'),'same-origin');assert.deepEqual(Buffer.from(await full.arrayBuffer()),video);
 const part=await fetch(url,{headers:{cookie,range:'bytes=8-15'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),`bytes 8-15/${video.length}`);assert.deepEqual(Buffer.from(await part.arrayBuffer()),video.subarray(8,16));
 const tail=await fetch(url,{headers:{cookie,range:'bytes=-4'}});assert.deepEqual(Buffer.from(await tail.arrayBuffer()),video.subarray(-4));
 for(const range of ['bytes=999999-','bytes=5-2','bytes=0-1,3-4','bytes=-0','bytes=9007199254740993-'])assert.equal((await fetch(url,{headers:{cookie,range}})).status,416);
 assert.equal((await fetch(base+'/api/local-videos/local_..%2fsecret/media',{headers:{cookie}})).status,404);
});

test('invalid video and disconnected HTTP upload leave no binding or staging file',async t=>{
 const {base,folder,store}=await fixture(t);
 const invalid=await upload(base,'率土之滨','网页.mp4',Buffer.from('#EXTM3U\nhttps://example.invalid/private'));
 assert.equal(invalid.status,400);assert.equal(store.list('率土之滨').length,0);
 assert.deepEqual(await readdir(join(folder,'incoming')),[]);
 await new Promise((resolve,reject)=>{
  const req=request(base+'/api/local-videos?'+new URLSearchParams({game:'率土之滨',filename:'中断.mp4'}),{method:'POST',headers:{'x-crawl-token':token,'Content-Type':'video/mp4','Content-Length':10000}});
  req.on('error',()=>resolve());req.write(video);
  const timer=setTimeout(()=>req.destroy(),50);timer.unref();req.on('response',reject);
 });
 for(let n=0;n<50&&(await readdir(join(folder,'incoming'))).length;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(await readdir(join(folder,'incoming')),[]);assert.equal(store.list('率土之滨').length,0);
});

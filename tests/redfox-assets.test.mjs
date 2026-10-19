import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRedfoxAssetStore,RedfoxAssetError} from '../app/redfox-assets.mjs';
import {inspectMedia} from '../app/media.mjs';
const id='7696364710773525760';
const row={provider:'redfox',kind:'video',source_id:id,source_url:`https://www.douyin.com/video/${id}`,collection_request_id:'query-one',title:'测试游戏视频',duration_ms:10000};
const response={code:2000,data:{desc:row.title,videoUrl:'https://v9-default.365yg.com/test.mp4'}};
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'redfox-asset-'));t.after(()=>rm(dir,{recursive:true,force:true}));const sourcePath=join(dir,'test.mp4');await writeFile(sourcePath,'synthetic-media-bytes');const store=createRedfoxAssetStore({folder:join(dir,'media'),probe:async()=>({format:{duration:'10'},streams:[{codec_type:'video'},{codec_type:'audio'}]})});return {dir,sourcePath,store};}
const input=sourcePath=>({sourcePath,response,startedAt:'2026-10-19T01:00:00Z',receivedAt:'2026-10-19T01:00:01Z'});
test('local asset ingestion and subsequent query reuse preserve identity and original acquisition time',async t=>{
 const {store,sourcePath}=await setup(t);const result=await store.importLocal(row,input(sourcePath));
 assert.equal(result.status,'av_readable');assert.equal(result.observed_at,'2026-10-19T01:00:01Z');
 const read=await store.read({...row,collection_request_id:'query-two'});
 assert.equal(read.collection_request_id,'query-one');assert.equal(read.current_collection_request_id,'query-two');
 assert.equal(read.source_sha256,result.source_sha256);
 assert.equal((await store.importLocal(row,input(sourcePath))).source_sha256,result.source_sha256);
 await assert.rejects(store.read({...row,source_id:'12345678901'}),RedfoxAssetError);
 await assert.rejects(store.read({...row,duration_ms:999000}),/时长/);
});
test('invalid metadata, cancellation and damaged cache do not silently replace files',async t=>{
 const {store,sourcePath}=await setup(t);
 await assert.rejects(store.importLocal(row,{...input(sourcePath),response:{code:2000,data:{desc:'另一个作品',videoUrl:'https://v9-default.365yg.com/test.mp4'}}}),/描述/);
 const aborted=new AbortController();aborted.abort(Error('cancelled'));
 await assert.rejects(store.importLocal(row,{...input(sourcePath),signal:aborted.signal}),/cancelled/);
 const result=await store.importLocal(row,input(sourcePath));
 await writeFile(result.source_path,'tampered');
 await assert.rejects(store.read(row),/文件指纹/);
 await assert.rejects(store.importLocal(row,input(sourcePath)),/文件指纹/);
 assert.equal(await readFile(result.source_path,'utf8'),'tampered');
});
test('missing Redfox asset never falls back to browser bridge, model or implicit resolver',async()=>{
 let called=0;
 const unavailable={...row,source_id:'99999999999999999999',source_url:'https://www.douyin.com/video/99999999999999999999'};
 await assert.rejects(inspectMedia(unavailable,{stage(){},browserMode:'side-browser',bridge:{request(){called++;throw Error('unexpected bridge');}},model:{json(){called++;throw Error('unexpected model');}}}),/尚未取得原片/);
 assert.equal(called,0);
});
test('empty resolver description uses an exact title match while conflicting descriptions remain rejected',async t=>{
 const {store,sourcePath}=await setup(t);
 const withTitle=(title,desc)=>({...input(sourcePath),response:{code:2000,data:{title,desc,videoUrl:'https://v26.douyinvod.com/test.mp4'}}});
 await assert.rejects(store.importLocal(row,withTitle('另一个作品','')),/描述/);
 await assert.rejects(store.importLocal(row,withTitle(row.title,'另一个作品')),/描述/);
 await assert.rejects(store.importLocal(row,withTitle('','')),/描述/);
 const saved=await store.importLocal(row,withTitle(row.title,''));
 assert.equal(saved.metadata_match_field,'title');
 assert.equal(saved.title,row.title);
 assert.equal((await store.read(row)).source_sha256,saved.source_sha256);
});

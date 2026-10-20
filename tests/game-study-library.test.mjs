import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {buildGameStudyLibrary} from '../app/game-study-library.mjs';
const sha=body=>createHash('sha256').update(body).digest('hex'),game='测试游戏';
async function fixture(t){const folder=await realpath(await mkdtemp(join(tmpdir(),'study-library-')));t.after(()=>rm(folder,{recursive:true,force:true}));const body=Buffer.from('actual existing video bytes'),digest=sha(body),path=join(folder,'original.mp4');await writeFile(path,body);
 const upload={provider:'local_upload',kind:'video',game,source_id:'local_'+digest,sha256:digest,size:body.length,uploaded_at:'2026-10-20T00:00:00Z',title:'my file',duration_ms:2000};
 const row={provider:'redfox',kind:'video',game,source_id:'7695600881273670946',source_url:'https://www.douyin.com/video/7695600881273670946',collection_request_id:'query-fixture',title:'online title',published_at:'2026-10-17T00:00:00Z',published_date:'2026-10-17',like_count:8,share_count:null};
 const collection={binding:{source_provider:'redfox',collection_request_id:'query-fixture',collection_fingerprint:'a'.repeat(64)},provenance:{provider:'redfox',request_id:'query-fixture',game,collected_at:'2026-10-19T00:00:00Z',start_date:'2026-10-12',end_date:'2026-10-18',update_policy:'T+1'},records:[row]};
 const openLocal=()=>({source_id:upload.source_id,sha256:digest,path,size:body.length,contentType:'video/mp4'});
 const readOnline=async row=>({provider:'redfox',source_id:row.source_id,url:row.source_url,current_collection_request_id:row.collection_request_id,status:'av_readable',source_path:path,source_sha256:digest,bytes:body.length});
 return {folder,path,body,upload,row,collection,openLocal,readOnline};}
test('real file bytes merge local and online origins without inventing query/publication/engagement',async t=>{
 const f=await fixture(t),result=await buildGameStudyLibrary({game,uploads:[f.upload],collection:f.collection,openLocal:f.openLocal,readOnline:f.readOnline});
 assert.equal(result.items.length,1);assert.equal(result.records[0].origins.length,2);assert.equal(result.items[0].media.path,f.path);assert.equal(result.records[0].provider,'local_upload');
 for(const key of ['published_at','published_date','publication_date','author','like_count','comment_count','share_count','collect_count','collection_request_id'])assert.equal(result.records[0][key],null,key);
 assert.equal(result.records[0].origins[1].like_count,8);assert.equal(result.records[0].origins[1].published_date,'2026-10-17');assert.equal(result.binding.source_provider,'game_study_library');assert.equal(result.binding.collection.collection_request_id,'query-fixture');
 assert(!JSON.stringify({records:result.records,binding:result.binding,excluded:result.excluded}).includes(f.path));assert.equal(result.status,'partial');assert.equal(result.accepted,false);assert.equal(result.coverage.merged_duplicate_origins,1);
 const again=await buildGameStudyLibrary({game,uploads:[f.upload],collection:f.collection,openLocal:f.openLocal,readOnline:f.readOnline});assert.deepEqual(again.binding,result.binding);
});
test('local-only one original is usable partial, cancelled before access, and wrong game/provider/id fails before readers',async t=>{
 const f=await fixture(t);let calls=0;const openLocal=id=>{calls++;return f.openLocal(id);};
 const r=await buildGameStudyLibrary({game,uploads:[f.upload],openLocal});assert.equal(r.coverage.available_originals,1);assert.equal(r.binding.collection,null);
 for(const upload of [{...f.upload,game:'other'},{...f.upload,provider:'redfox'},{...f.upload,source_id:'../../escape'}])await assert.rejects(buildGameStudyLibrary({game,uploads:[upload],openLocal}),{code:'LIBRARY_SOURCE_INVALID'});
 const aborted=new AbortController();aborted.abort();await assert.rejects(buildGameStudyLibrary({game,uploads:[f.upload],openLocal,signal:aborted.signal}));assert.equal(calls,1);
 const wrong=structuredClone(f.collection);wrong.provenance.game='other';await assert.rejects(buildGameStudyLibrary({game,collection:wrong,readOnline:f.readOnline}),{code:'LIBRARY_COLLECTION_INVALID'});
 const mixed=structuredClone(f.collection);mixed.records[0].collection_request_id='another';await assert.rejects(buildGameStudyLibrary({game,collection:mixed,readOnline:f.readOnline}),{code:'LIBRARY_SOURCE_INVALID'});
});
test('same-size file tamper and unsafe symlink fail closed rather than unavailable',async t=>{
 const f=await fixture(t);await writeFile(f.path,Buffer.alloc(f.body.length,42));await assert.rejects(buildGameStudyLibrary({game,uploads:[f.upload],openLocal:f.openLocal}),{code:'LIBRARY_MEDIA_CHANGED'});
 await writeFile(f.path,f.body);const link=join(f.folder,'link.mp4');await symlink(f.path,link);await assert.rejects(buildGameStudyLibrary({game,uploads:[f.upload],openLocal:()=>({...f.openLocal(),path:link})}),{code:'LIBRARY_MEDIA_UNSAFE'});
 await assert.rejects(buildGameStudyLibrary({game,collection:f.collection,readOnline:async()=>({...await f.readOnline(f.row),source_id:'7690000000000000000'})}),{code:'LIBRARY_MEDIA_IDENTITY_INVALID'});
});
test('missing online originals remain unavailable and never trigger acquisition; corrupted reads are not treated as missing',async t=>{
 const f=await fixture(t);let reads=0;const readOnline=async()=>{reads++;throw Object.assign(Error('这条视频尚未取得原片；不会自动收费'),{code:'MEDIA_ASSET_REQUIRED'});};
 const r=await buildGameStudyLibrary({game,collection:f.collection,readOnline});assert.equal(reads,1);assert.equal(r.records[0].availability,'unavailable');assert.equal(r.items[0].media,null);assert.equal(r.records[0].published_date,'2026-10-17');assert.equal(r.records[0].share_count,null);
 await assert.rejects(buildGameStudyLibrary({game,collection:f.collection,readOnline:async()=>{throw Object.assign(Error('保存的原片与身份不符'),{code:'MEDIA_ASSET_REQUIRED'});}}),{code:'LIBRARY_ONLINE_READ_FAILED'});
});
test('uploads have priority, limit counts independent originals, later duplicates retain origins, excluded remain auditable',async t=>{
 const f=await fixture(t);const rows=Array.from({length:31},(_,i)=>({...f.row,source_id:String(7695600881273670946n+BigInt(i)),source_url:'https://www.douyin.com/video/'+String(7695600881273670946n+BigInt(i))}));f.collection.records=rows;
 const readOnline=async row=>row.source_id===rows[30].source_id?f.readOnline(row):null;
 const r=await buildGameStudyLibrary({game,uploads:[f.upload],collection:f.collection,openLocal:f.openLocal,readOnline});
 assert.equal(r.items.length,30);assert.equal(r.excluded.length,1);assert.equal(r.records[0].source_id,f.upload.source_id);assert.equal(r.records[0].origins[1].source_id,rows[30].source_id);assert.equal(r.coverage.unique_candidates,31);
 assert(!JSON.stringify(r.excluded).includes(f.path));
 for(const limit of [0,31,1.5])await assert.rejects(buildGameStudyLibrary({game,limit}),{code:'LIBRARY_INPUT_INVALID'});
});
test('binding changes for window/origin/file identity, cancellation after reader aborts before consuming media',async t=>{
 const f=await fixture(t),a=await buildGameStudyLibrary({game,collection:f.collection,readOnline:f.readOnline});
 f.collection.provenance.start_date='2026-10-11';const b=await buildGameStudyLibrary({game,collection:f.collection,readOnline:f.readOnline});assert.notEqual(a.binding.library_fingerprint,b.binding.library_fingerprint);
 f.row.like_count=9;const c=await buildGameStudyLibrary({game,collection:f.collection,readOnline:f.readOnline});assert.notEqual(b.binding.library_fingerprint,c.binding.library_fingerprint);
 const controller=new AbortController();await assert.rejects(buildGameStudyLibrary({game,uploads:[f.upload],openLocal:()=>{controller.abort();return f.openLocal();},signal:controller.signal}));
});

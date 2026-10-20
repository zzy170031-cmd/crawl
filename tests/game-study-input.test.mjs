import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {createGameStudyInput} from '../app/game-study-input.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ui=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
const server=readFileSync(new URL('../app/server.mjs',import.meta.url),'utf8');
const piece=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
const mustNot=()=>assert.fail('wrong source, acquisition or inference must not be invoked');
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'study-input-')));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'saved.mp4'),bytes=Buffer.from('already acquired original');await writeFile(path,bytes);const digest=sha(bytes),game='游戏 A';
 const upload={game,kind:'video',provider:'local_upload',source_id:'local_'+digest,sha256:digest,size:bytes.length,title:'camera',uploaded_at:'2026-10-20T00:00:00Z'};
 const row={game,kind:'video',provider:'redfox',source_id:'7695600881273670946',source_url:'https://www.douyin.com/video/7695600881273670946',collection_request_id:'saved-query',published_date:'2026-10-18',like_count:42};
 const snapshot={binding:{source_provider:'redfox',collection_request_id:'saved-query',collection_fingerprint:'a'.repeat(64)},provenance:{provider:'redfox',game,request_id:'saved-query',collected_at:'2026-10-19T00:00:00Z',start_date:'2026-10-12',end_date:'2026-10-18'},records:[row]};
 return {root,path,game,upload,row,snapshot,openLocal:id=>{assert.equal(id,upload.source_id);return {source_id:id,sha256:digest,path,size:bytes.length,contentType:'video/mp4'};},readOnline:async r=>{assert.equal(r.source_id,row.source_id);return {provider:'redfox',source_id:r.source_id,url:r.source_url,status:'av_readable',current_collection_request_id:'saved-query',source_path:path,source_sha256:digest,bytes:bytes.length};}};
}
test('network branch reads only fixed server snapshot/media, exposes no private items/path and creates no task',async t=>{
 const f=await fixture(t);let reads=0;const prepare=createGameStudyInput({getCollection:g=>{assert.equal(g,f.game);return f.snapshot;},readOnline:r=>{reads++;return f.readOnline(r);},listUploads:mustNot,openLocal:mustNot});
 const result=await prepare({game:f.game,learning_source:'network'});assert.equal(reads,1);assert.equal(result.learning_source,'network');assert.equal(result.records[0].provider,'redfox');assert.equal(result.records[0].like_count,42);assert.equal(result.task_created,false);assert.equal(result.learning_started,false);assert.equal(result.accepted,false);assert.equal(result.items,undefined);assert(!JSON.stringify(result).includes(f.root));
});
test('local branch works with no RedFox configuration or current query and preserves null date/metrics',async t=>{
 const f=await fixture(t);let reads=0;const prepare=createGameStudyInput({getCollection:mustNot,readOnline:mustNot,listUploads:g=>{assert.equal(g,f.game);reads++;return [f.upload];},openLocal:f.openLocal});
 const result=await prepare({game:f.game,learning_source:'local'});assert.equal(reads,1);assert.equal(result.binding.collection,null);assert.equal(result.records[0].published_at,null);assert.equal(result.records[0].like_count,null);assert.equal(result.coverage.available_originals,1);assert.equal(result.status,'partial');assert(!JSON.stringify(result).includes(f.root));
});
test('only explicit two-field source request accepted; hostile rows/path/source values never reach stores',async()=>{
 const prepare=createGameStudyInput({getCollection:mustNot,readOnline:mustNot,listUploads:mustNot,openLocal:mustNot});
 for(const input of [null,{},[],{game:'x'}, {game:'x',learning_source:'combined'}, {game:'x',learning_source:'LOCAL'}, {game:'x',learning_source:'local',rows:[]}, {game:'x',learning_source:'network',path:'/private'}, {game:'',learning_source:'local'}])await assert.rejects(prepare(input),{code:'GAME_STUDY_INPUT_INVALID'});
 const abort=new AbortController();abort.abort();await assert.rejects(prepare({game:'x',learning_source:'local'},{signal:abort.signal}));
});
test('missing network snapshot does not fall back to uploads; local empty list remains partial',async()=>{
 const prepare=createGameStudyInput({getCollection:()=>null,readOnline:mustNot,listUploads:mustNot,openLocal:mustNot});await assert.rejects(prepare({game:'x',learning_source:'network'}),{code:'GAME_STUDY_COLLECTION_REQUIRED'});
 const local=await createGameStudyInput({getCollection:mustNot,readOnline:mustNot,listUploads:()=>[],openLocal:mustNot})({game:'x',learning_source:'local'});assert.equal(local.records.length,0);assert.equal(local.accepted,false);
});
function browser(storage=new Map()){
 const nodes=new Map(),calls=[],messages=[];
 const context={Map,gameGeneration:0,learningBusy:false,target:'游戏 A',
  game:()=>context.target,$:id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:''});return nodes.get(id);},
  localRead:(key,fallback)=>storage.has(key)?JSON.parse(storage.get(key)):fallback,localStorage:{setItem:(k,v)=>storage.set(k,v)},
  currentProfile:null,loadProfile:async()=>{},savedStudyTask:()=>null,studyEntryEnabled:()=>false,renderGameState:()=>{},show:text=>messages.push(text),api:async(path,data)=>{calls.push({path,data});return {coverage:{selected_candidates:1,available_originals:1,unavailable_originals:0}};},
 };
 vm.runInNewContext(piece(ui,'const learningSourceChoices=','function safeURL(')+piece(ui,'async function learning()','async function searchGame()')+piece(ui,'$("learning-source").onchange =','$("find-game").onclick'),context);
 return {context,nodes,calls,messages,storage};
}
test('source preferences persist per game, source onchange never acquires media and refresh retains choice',async()=>{
 const a=browser();assert.equal(a.context.learningSource(),'network');a.context.$('learning-source').value='local';a.context.$('learning-source').onchange();assert.equal(a.calls.length,0);assert.equal(a.context.learningSource(),'local');
 a.context.target='游戏 B';assert.equal(a.context.learningSource(),'network');a.context.target='游戏 A';assert.equal(a.context.learningSource(),'local');
 assert.equal(browser(a.storage).context.learningSource(),'local');
 const render=piece(ui,'function renderGameState()','async function loadProfile()');assert.match(render,/\$\("learning-source"\)\.value = learningSource\(\)/);assert.match(render,/核对学习素材/);assert.doesNotMatch(render,/\? "更新学习"/);
});
test('click captures game/source before awaiting; later selection or game change never changes submitted source or starts learning',async()=>{
 const a=browser();let done;a.context.api=(path,data)=>{a.calls.push({path,data});return new Promise(resolve=>done=resolve);};a.context.$('learning-source').value='local';a.context.$('learning-source').onchange();const pending=a.context.learning();
 a.context.$('learning-source').value='network';a.context.$('learning-source').onchange();a.context.target='游戏 B';a.context.gameGeneration++;
 done({coverage:{selected_candidates:1,available_originals:1,unavailable_originals:0}});await pending;
 assert.deepEqual(JSON.parse(JSON.stringify(a.calls)),[{path:'/api/game-study-input',data:{game:'游戏 A',learning_source:'local'}}]);assert.equal(a.messages.length,0);assert.equal(a.context.learningBusy,false);
 a.context.target='游戏 A';a.context.api=async(path,data)=>{a.calls.push({path,data});return {coverage:{selected_candidates:3,available_originals:2,unavailable_originals:1}};};await a.context.learning();assert.match(a.messages[0],/联网视频.*2 条可读原片，1 条缺原片.*未开始学习/);assert(a.calls.every(c=>c.path==='/api/game-study-input'));
});
test('actual server route is behind session token and local check bypasses network/config/legacy tasks',async()=>{
 const part=piece(server,'    if (req.method === "GET" && url.pathname === "/api/session")','    if(url.pathname===\'/api/quality-policy\'');
 const context={AbortController,createGameStudyInput,body:async req=>req.input,token:'secret',localMediaCookieName:'test',handleLocalVideos:async()=>false,handleStudyHttp:async()=>false,studyRuntime:{},origin:'http://127.0.0.1:4319',localVideosWithOrigins:mustNot,
  localVideos:{list:()=>[],open:mustNot},config:{gameSource:'browser'},bridge:null,redfoxAssets:{read:mustNot},bindLatestGameCollection:mustNot,
  experimentalQualityHold:()=>({active:true}),json:(res,status,value)=>({status,value})};
 vm.runInNewContext('async function dispatch(req,res,url){'+part+'}',context);
 const req={method:'POST',headers:{},input:{game:'x',learning_source:'local'},once(){},off(){}};
 let r=await context.dispatch(req,new EventEmitter(),{pathname:'/api/game-study-input'});assert.equal(r.status,403);
 req.headers['x-crawl-token']='secret';r=await context.dispatch(req,new EventEmitter(),{pathname:'/api/game-study-input'});assert.equal(r.status,200);assert.equal(r.value.learning_started,false);assert.equal(r.value.experimental_quality_hold.active,true);assert.equal(r.value.items,undefined);
 // Even if a later quality flag opens the old route, explicit local input must
 // fail before snapshot resolution/db.create; this test executes its guard.
 const legacy=piece(server,'    if (url.pathname === "/api/game-research" && req.method === "POST") {','      const game = gameName(input.game);');
 vm.runInNewContext('async function legacy(req,res,url){'+legacy+'}}',context);
 r=await context.legacy(req,{}, {pathname:'/api/game-research'});assert.equal(r.status,409);assert.equal(r.value.code,'LEARNING_SOURCE_UNSUPPORTED');
});

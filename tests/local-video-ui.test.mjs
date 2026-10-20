import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the actual browser functions with controlled DOM/API boundaries.
// These tests do not start a server, open a database, or perform network IO.
const source=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
function section(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert(a>=0&&b>a,`production function boundaries missing: ${start}`);
  return source.slice(a,b);
}
const loader=section('async function loadRecords()', 'function sourceURL(');
const uploader=section('async function uploadLocalVideos(', 'const date =');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const video=(id,title=id)=>({source_id:id,title,kind:'video',provider:'redfox'});
const local=(suffix='a',ids=[])=>({...video('local_'+suffix.repeat(64),'camera.mp4'),provider:'local_upload',matching_online_ids:ids});
const plain=value=>JSON.parse(JSON.stringify(value));
function setup({mode='game',api,fetch}={}){
  const nodes=new Map(),calls=[],renders=[],errors=[];
  const context={URLSearchParams,AbortController,token:'test-session',localUploadController:null,
    listGeneration:0,sourceMode:mode,records:[],recordCollection:null,localUploadNotice:'',target:'game-a',
    $:id=>{if(!nodes.has(id))nodes.set(id,{value:id==='sort'?'newest':'',textContent:'',hidden:false,disabled:false});return nodes.get(id);},
    game:()=>context.target,scope:()=>({board:1001,hours:24,category:'all',keyword:''}),
    api:async(path,body)=>{calls.push({type:'api',path,body});assert.equal(body,undefined,'list refresh cannot mutate or start learning');assert(path.startsWith('/api/hotspots?')||path.startsWith('/api/local-videos?'),'unexpected API: '+path);return api?api(path):{records:[]};},
    fetch:async(path,options)=>{calls.push({type:'fetch',path,options});assert(path.startsWith('/api/local-videos?'),'upload must stay on the local endpoint');assert.equal(options.method,'POST');return fetch?fetch(path,options):{ok:true,json:async()=>({record:{duplicate:false}})};},
    renderRecords:()=>renders.push(plain(context.records)),renderGameState:()=>{},show:error=>errors.push(error),
  };
  vm.runInNewContext(loader+'\n'+uploader,context);
  return {context,nodes,calls,renders,errors};
}

test('game list retains independent online and local sources and joins a shared original',async()=>{
  const original=local('a',['online-1']),standalone=local('b');
  const online=[video('online-1','online title'),video('online-2')];
  const fixture=JSON.stringify({original,standalone,online});
  const h=setup({api:async path=>path.startsWith('/api/local-videos?')?{records:[original,standalone]}:{records:online,collection:{marker:'online-snapshot'}}});
  await h.context.loadRecords();
  assert.deepEqual(Array.from(h.context.records,r=>r.source_id),['online-1','online-2',standalone.source_id]);
  assert.deepEqual(plain(h.context.records[0].local_upload),original);
  assert.equal(h.context.records[0].title,'online title');
  assert.equal(h.context.recordCollection.marker,'online-snapshot');
  assert.equal(JSON.stringify({original,standalone,online}),fixture,'API records must not be mutated');
});

test('searching an online title must retain the matching uploaded original despite a different filename',async()=>{
  const uploaded=local('a',['online-1']);
  const h=setup({api:async path=>path.startsWith('/api/local-videos?')?{records:[uploaded,local('b')]}:{records:[video('online-1','opening guide')]}});
  h.context.$('query').value='guide';
  await h.context.loadRecords();
  assert.equal(h.context.records.length,1);
  assert.equal(h.context.records[0].local_upload?.source_id,uploaded.source_id,'query may hide standalone uploads, not detach an already matching original');
});

test('courses and hotspots never request or append local game uploads',async()=>{
  for(const mode of ['courses','hotspot']){
    const h=setup({mode,api:async()=>({records:[video('source-'+mode)]})});
    await h.context.loadRecords();
    assert.equal(h.calls.length,1);assert(h.calls[0].path.startsWith('/api/hotspots?'));
    assert.equal(h.context.records[0].source_id,'source-'+mode);
    assert(!h.calls.some(c=>c.path.startsWith('/api/local-videos')));
  }
});

test('a failed source leaves the other source visible and reports the limited result',async()=>{
  for(const failure of ['online','local']){
    const h=setup({api:async path=>{
      const isLocal=path.startsWith('/api/local-videos?');
      if(isLocal===(failure==='local'))throw Error('fixture source unavailable');
      return {records:[isLocal?local():video('online')]};
    }});
    await h.context.loadRecords();
    assert.equal(h.context.records.length,1);
    assert.equal(h.context.records[0].provider,failure==='online'?'local_upload':'redfox');
    assert.match(h.context.localUploadNotice,/读取失败/);
  }
});

test('late responses cannot replace another game or another source tab',async()=>{
  for(const switchTab of [false,true]){
    const held=deferred();
    const h=setup({api:path=>path.includes('game-a')?held.promise:Promise.resolve({records:[video('new-scope')]})});
    const old=h.context.loadRecords();
    h.context.target='game-b';if(switchTab)h.context.sourceMode='courses';
    await h.context.loadRecords();
    const before=JSON.stringify(h.context.records),renderCount=h.renders.length;
    held.resolve({records:[local('a'),video('old-scope')]});await old;
    assert.equal(JSON.stringify(h.context.records),before);assert.equal(h.renders.length,renderCount);
    assert(!h.context.records.some(r=>r.source_id==='old-scope'));
  }
});

test('empty game reads neither source and clears the previous list',async()=>{
  const h=setup();h.context.target='';h.context.records=[video('old')];
  await h.context.loadRecords();assert.equal(h.calls.length,0);assert.equal(h.context.records.length,0);
});

const files=[{name:'one.mp4',size:10,type:'video/mp4'},{name:'two.mov',size:12,type:'video/quicktime'}];
test('upload posts each file once locally, retains target binding and never queries paid or learning APIs',async()=>{
  const h=setup({fetch:async(path,options)=>({ok:true,json:async()=>({record:{duplicate:options.body===files[1]}})})});
  await h.context.uploadLocalVideos(files);
  const posts=h.calls.filter(c=>c.type==='fetch');assert.equal(posts.length,2);
  assert.deepEqual(posts.map(p=>p.options.body),files);
  for(const post of posts){assert.equal(new URLSearchParams(post.path.split('?')[1]).get('game'),'game-a');assert.equal(post.options.headers['x-crawl-token'],'test-session');}
  assert.match(h.context.$('local-upload-status').textContent,/已保存 1 条新视频，复用 1 条/);
  assert.equal(h.context.localUploadController,null);assert.equal(h.context.$('cancel-local-upload').hidden,true);
  assert.equal(h.renders.length,1,'only refresh saved local records after upload');
});

test('upload finishing after game switch keeps its original game and does not refresh the new game',async()=>{
  const held=deferred();const h=setup({fetch:()=>held.promise});
  const running=h.context.uploadLocalVideos(files);await new Promise(resolve=>setImmediate(resolve));
  h.context.target='game-b';held.resolve({ok:true,json:async()=>({record:{}})});await running;
  const posts=h.calls.filter(c=>c.type==='fetch');assert.equal(posts.length,2);
  assert(posts.every(c=>new URLSearchParams(c.path.split('?')[1]).get('game')==='game-a'));
  assert.equal(h.renders.length,0);assert.equal(h.calls.filter(c=>c.type==='api').length,1);
});

test('upload failure stops before later files, preserves saved count and never retries',async()=>{
  let count=0;const h=setup({fetch:async()=>++count===1?{ok:true,json:async()=>({record:{}})}:{ok:false,status:500,json:async()=>({error:'fixture failure'})}});
  await h.context.uploadLocalVideos([...files,{name:'third.mp4',size:5}]);
  assert.equal(count,2);assert.equal(h.errors.length,1);
  assert.match(h.context.$('local-upload-status').textContent,/已确认保存 1 条/);
  assert.match(h.context.$('local-upload-status').textContent,/不会自动重试/);
  assert.equal(h.context.localUploadController,null);
});

test('cancelled upload does not submit subsequent files and resets controls',async()=>{
  const held=deferred();const h=setup({fetch:()=>held.promise});
  const running=h.context.uploadLocalVideos(files);await new Promise(resolve=>setImmediate(resolve));
  h.context.localUploadController.abort();held.reject(new DOMException('cancelled','AbortError'));await running;
  assert.equal(h.calls.filter(c=>c.type==='fetch').length,1);assert.equal(h.errors.length,0);
  assert.match(h.context.$('local-upload-status').textContent,/已停止上传/);
  assert.equal(h.context.localUploadController,null);assert.equal(h.context.$('upload-local-video').disabled,false);
});

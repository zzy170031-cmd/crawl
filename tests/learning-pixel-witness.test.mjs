import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {hash} from '../app/tasks.mjs';
import {createLearningPixelWitness,validatePixelWitness,bindPixelWitness,LEARNING_PIXEL_WITNESS_MODEL,LEARNING_PIXEL_WITNESS_OPTIONS,LEARNING_PIXEL_WITNESS_PROMPT} from '../app/learning-pixel-witness.mjs';
import {pixelFixtureParameters} from './learning-pixel-fixture.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const sourceId='7690000000000000001',mediaHash=hash('media'),raw=(quotes,role='entity_name',panel='present')=>({has_structured_game_data_panel:panel,has_scene_or_character_art:'present',panel_evidence:panel==='present'?['角色卡片内有等级、属性与技能栏']:[],quotes:Object.fromEntries(quotes.map(q=>[q.id,{presence:'visible',role}]))});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pixel-witness-')),sourcePath=join(dir,'redfox-source.mp4');t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(sourcePath,'original-video');
 const source={source_path:sourcePath,source_sha256:hash('original-video')},frames=[0,12,24,36].map(time=>({file:`frame-${time}.png`,sha256:hash(png),actual_time:time}));
 for(const f of frames)await writeFile(join(dir,f.file),png);await writeFile(join(dir,'frames.json'),JSON.stringify({source_id:sourceId,source_sha256:source.source_sha256,frames}));
 const readings=frames.map((f,i)=>({source_id:sourceId,time:f.actual_time,frame_file:f.file,frame_sha256:f.sha256,timestamp_method:'legacy_requested_seek_time_not_pts_verified',visible_text:i===1?'发动率':'青羽',visible_content:'不会进入像素模型的旧描述'}));
 const units=readings.map((r,i)=>({id:`u${i}`,visual_id:`F${i}_V`,ocr_id:`F${i}_T`,time:r.time,object_quote:r.visible_text,start:0,end:r.visible_text.length}));
 const records=new Map(),calls=[],behavior={roles:['entity_name','field_or_control','entity_name','entity_name'],panels:['present','present','absent','present']};
 const db={checkpoint(k,v){if(v!==undefined)records.set(k,structuredClone(v));return structuredClone(records.get(k)||null);},transaction(fn){return fn();}};
 const model={cacheParameters:()=>structuredClone(pixelFixtureParameters),json:async(prompt,input,schema,options)=>{calls.push({prompt,input,schema,options});assert.equal(options.maxAttempts,1);assert.equal(options.images.length,1);assert.equal(prompt,LEARNING_PIXEL_WITNESS_PROMPT);assert.deepEqual(Object.keys(input),['task','quotes']);assert(!JSON.stringify(input).includes('旧描述'));if(behavior.abort)behavior.abort.abort();const reply=behavior.reply||raw(input.quotes,behavior.roles[calls.length-1]||'entity_name',behavior.panels[calls.length-1]||'present');await options.onRawResponse({status:behavior.http||200,body:JSON.stringify({message:{content:JSON.stringify(reply)},done:true,done_reason:'stop'})+'\n',complete:true,truncated:false});if(behavior.fail)throw Error('private model failure');return reply;}};
 const args={db,model,identity:LEARNING_PIXEL_WITNESS_MODEL,sourceId,mediaHash,source,folder:pathToFileURL(dir+'/'),frames,readings};
 return {dir,args,units,records,calls,behavior,provider:()=>createLearningPixelWitness(args)};
}

test('actual pixels are independent; panel, each quote and coarse substantive support are separate and cache reuses without inference',async t=>{
 const f=await fixture(t),w=await f.provider().inspect(f.units);assert.equal(f.calls.length,4);assert.equal(w.supported,true);assert.equal(w.panel_frames.length,3);assert.deepEqual(w.accepted_units.map(x=>x.unit.id),['u0','u3']);assert.deepEqual(w.rejected_units.map(x=>x.reason),['NON_SUBSTANTIVE_ROLE','NOT_CONFIRMED_PANEL']);
 assert(validatePixelWitness(w,{sourceId,mediaHash,selectedUnits:f.units,readings:f.args.readings}));assert(w.receipts.every(r=>r.descriptor.model_identity.name==='qwen3-vl:8b-instruct'));assert.equal(w.spelling_verified,false);assert.equal(w.accepted,false);
 const again=await f.provider().inspect(f.units);assert.equal(f.calls.length,4);assert.equal(w.execution.model_calls,4);assert.equal(again.execution.model_calls,0);assert.deepEqual(again.receipts,w.receipts);assert([...f.records.keys()].filter(k=>k.endsWith(':wire')).length===4);
 for(const c of f.calls){assert.equal(c.options.thinking,false);assert.equal(c.options.contextLength,8192);assert.equal(c.options.maxTokens,900);assert(!JSON.stringify(c.input).includes('target'));}
});

test('field/statement/unknown, absent quote, one panel time and null-only can never create substantive support',async t=>{
 for(const role of ['field_or_control','numeric_value','statement','unknown']){const f=await fixture(t);f.behavior.roles=[role,role];f.behavior.panels=['present','present'];const w=await f.provider().inspect(f.units.slice(0,2));assert.equal(w.supported,false,role);assert.equal(w.panel_frames.length,2);}
 const f=await fixture(t);f.behavior.reply={...raw([{id:'Q0'}]),quotes:{Q0:{presence:'unclear',role:'entity_name'}}};assert.equal((await f.provider().inspect(f.units.slice(0,2))).supported,false);
 const one=await fixture(t);assert.equal((await one.provider().inspect(one.units.slice(0,1))).supported,false);
 const empty=await fixture(t);empty.behavior.panels=['present','present'];const units=empty.units.slice(0,2).map(u=>({...u,object_quote:null,start:null,end:null}));assert.equal((await empty.provider().inspect(units)).supported,false);
});

test('missing provider is explicit unknown; spoofed booleans, source/frame/quote/model/runtime changes invalidate receipts',async t=>{
 const f=await fixture(t),w=await f.provider().inspect(f.units.slice(0,2)),selectedUnits=f.units.slice(0,2),opts={sourceId,mediaHash,selectedUnits,readings:f.args.readings};
 const missing=bindPixelWitness([],selectedUnits,{sourceId,mediaHash,status:'missing_provider'});assert(validatePixelWitness(missing,opts));assert.equal(missing.supported,false);
 for(const mutate of [x=>x.supported=!x.supported,x=>x.receipts[0].descriptor.source_id='wrong',x=>x.receipts[0].descriptor.frame.time=7,x=>x.receipts[0].descriptor.input.quotes[0].text='invented',x=>x.receipts[0].descriptor.inference_parameters.runtime.version='0.30.6',x=>x.receipts[0].descriptor.model_identity.digest='fake',x=>x.receipts[0].raw_output.quotes.Q0.role='unknown',x=>x.receipts[0].wire=null,x=>x.receipts.push(x.receipts[0])]){const bad=structuredClone(w);mutate(bad);assert.equal(validatePixelWitness(bad,opts),false);}
 assert.equal(validatePixelWitness(w,{...opts,readings:[null]}),false);
});

test('read-only source binding rejects changed PNG/source/manifest, foreign path and more than four units before model',async t=>{
 for(const change of [async f=>writeFile(join(f.dir,'frame-0.png'),'changed'),async f=>writeFile(f.args.source.source_path,'different video'),async f=>writeFile(join(f.dir,'frames.json'),JSON.stringify({source_id:'other',frames:f.args.frames})),async f=>{await rm(join(f.dir,'frame-0.png'));await symlink('/etc/hosts',join(f.dir,'frame-0.png'));}]){const f=await fixture(t);await change(f);await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_SOURCE_INVALID'});assert.equal(f.calls.length,0);}
 const f=await fixture(t);await assert.rejects(f.provider().inspect([...f.units,{...f.units[0],id:'extra'}]),{code:'PIXEL_WITNESS_SOURCE_INVALID'});await assert.rejects(f.provider().inspect([{...f.units[0],start:1}]),{code:'PIXEL_WITNESS_SOURCE_INVALID'});assert.equal(f.calls.length,0);
});

test('failed raw is retained and only persisted current owner explicit retry can create an immutable later attempt',async t=>{
 const f=await fixture(t);f.behavior.fail=true;await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_LOCAL_FAILURE'});const old=[...f.records].find(([,r])=>r.status==='failed');assert(old);assert(f.records.get(old[0]+':wire').body.includes('entity_name'));
 await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_PREVIOUS_FAILURE'});assert.equal(f.calls.length,1);
 const grant={task_id:'task',attempt_id:'retry1',generation:1,authorization:'explicit_task_retry',authorized_at:new Date(Date.now()+10000).toISOString()};const task={owner:'owner',type:'learn',state:'running',payload:{game:'game',source_provider:'redfox',collection_request_id:'query'}};
 Object.assign(f.args,{taskId:'task',taskOwner:'stale',game:'game',collectionRequestId:'query',learningRetry:grant});f.args.db.get=()=>task;f.args.db.learningRetry=(id,owner)=>owner===task.owner?grant:null;
 await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_PREVIOUS_FAILURE'});assert.equal(f.calls.length,1);
 f.args.taskOwner='owner';f.behavior.fail=false;await f.provider().inspect(f.units.slice(0,1));assert.equal(f.calls.length,2);assert.deepEqual(f.records.get(old[0]),old[1]);assert([...f.records.values()].some(r=>r.retry?.previous_checkpoint===old[0]&&r.status==='valid'));
});

test('cancellation preserves a cancelled attempt and never advances to another frame',async t=>{
 const f=await fixture(t),abort=new AbortController();f.args.signal=abort.signal;f.behavior.abort=abort;await assert.rejects(f.provider().inspect(f.units));assert.equal(f.calls.length,1);assert([...f.records.values()].some(r=>r.status==='cancelled'));assert([...f.records.keys()].some(k=>k.endsWith(':wire')));
});

 test('tampered persisted wire body or raw-content mismatch is not reusable and never silently re-infers',async t=>{
 for(const mode of ['body','rehashed_body','metadata']){const f=await fixture(t);await f.provider().inspect(f.units.slice(0,1));const [key,wire]=[...f.records].find(([k])=>k.endsWith(':wire'));if(mode==='metadata')wire.source_id='other';else{wire.body='{}';if(mode==='rehashed_body')wire.sha256=hash(wire.body);}f.records.set(key,wire);await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_CACHE_INVALID'});assert.equal(f.calls.length,1);assert([...f.records.values()].some(v=>v.previous_checkpoint&&v.status==='failed'));}
 });

test('retry authority is rechecked inside transaction and cancelled/foreign source never advances a new attempt',async t=>{
 const f=await fixture(t);f.behavior.fail=true;await assert.rejects(f.provider().inspect(f.units.slice(0,1)));
 const task={owner:'owner',state:'running',type:'learn',payload:{game:'game',source_provider:'redfox',collection_request_id:'query'}},grant={task_id:'task',authorization:'explicit_task_retry',attempt_id:'attempt2',authorized_at:new Date(Date.now()+10000).toISOString()};
 Object.assign(f.args,{taskId:'task',taskOwner:'owner',game:'game',collectionRequestId:'query',learningRetry:grant});f.args.db.get=()=>task;f.args.db.learningRetry=()=>grant;f.args.db.transaction=fn=>{task.owner='replacement-owner';return fn();};
 await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_PREVIOUS_FAILURE'});assert.equal(f.calls.length,1);assert(![...f.records.values()].some(r=>r.retry));
});

test('two real Node processes with one SQLite initial-read barrier make exactly one wire and preserve the successful receipt',async t=>{
 const {spawn}=await import('node:child_process'),{Tasks}=await import('../app/tasks.mjs'),f=await fixture(t);const initial=new Tasks(f.dir);initial.close();
 const launch=id=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/pixel-initial-race.mjs',import.meta.url)),f.dir,id],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('exit',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out.trim()));}catch(e){reject(e);}});});
 const results=await Promise.all([launch('a'),launch('b')]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'PIXEL_WITNESS_IN_PROGRESS');assert.equal((await readFile(join(f.dir,'wire.log'),'utf8')).trim().split('\n').length,1);
 const db=new Tasks(f.dir);try{const rows=db.db.prepare("SELECT value FROM checkpoints WHERE key LIKE '%:attempt:initial'").all().map(r=>JSON.parse(r.value));assert.equal(rows.length,1);assert.equal(rows[0].status,'valid');assert.match(rows[0].claim_owner,/^[a-f0-9-]{36}$/);const original=structuredClone(rows[0]);f.args.db=db;await f.provider().inspect(f.units.slice(0,1));assert.equal(f.calls.length,0);assert.deepEqual(JSON.parse(db.db.prepare("SELECT value FROM checkpoints WHERE key LIKE '%:attempt:initial'").get().value),original);}finally{db.close();}
});

test('lost attempt ownership cannot write wire or overwrite another terminal receipt',async t=>{
 const f=await fixture(t);f.args.model.json=async(prompt,input,schema,options)=>{const [key,saved]=[...f.records].find(([,r])=>r.status==='started');f.records.set(key,{...saved,status:'valid',claim_owner:'other-owner',sentinel:'must preserve'});await options.onRawResponse({status:200,body:'{}',complete:true,truncated:false});};
 await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_LOCAL_FAILURE'});const saved=[...f.records.values()].find(r=>r.sentinel);assert.equal(saved.status,'valid');assert.equal(saved.claim_owner,'other-owner');assert(![...f.records.keys()].some(k=>k.endsWith(':wire')));
});

test('missing cached raw_output is a typed cache invalid failure, not a hash TypeError or new model request',async t=>{
 const f=await fixture(t);await f.provider().inspect(f.units.slice(0,1));const [key,saved]=[...f.records].find(([,r])=>r.status==='valid');delete saved.raw_output;f.records.set(key,saved);await assert.rejects(f.provider().inspect(f.units.slice(0,1)),{code:'PIXEL_WITNESS_CACHE_INVALID'});assert.equal(f.calls.length,1);
});

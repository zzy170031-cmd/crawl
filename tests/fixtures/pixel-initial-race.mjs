// Child process for the real SQLite initial-claim regression. No model/network.
import {writeFileSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {Tasks,hash} from '../../app/tasks.mjs';
import {createLearningPixelWitness,LEARNING_PIXEL_WITNESS_MODEL} from '../../app/learning-pixel-witness.mjs';
import {pixelFixtureParameters} from '../learning-pixel-fixture.mjs';
const [dir,id]=process.argv.slice(2),sourceId='7690000000000000001';
// Serialize schema/PRAGMA initialization only; both initial receipt reads still
// rendezvous below before either process is allowed to claim the attempt.
if(id==='b'){const deadline=Date.now()+5000;while(!existsSync(join(dir,'a.open'))){if(Date.now()>deadline)throw Error('open timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
const db=new Tasks(dir),original=db.checkpoint.bind(db);writeFileSync(join(dir,id+'.open'),'open');let intercepted=false;
db.checkpoint=(key,value)=>{const result=original(key,value);if(value===undefined&&key.endsWith(':attempt:initial')&&!result&&!intercepted){intercepted=true;writeFileSync(join(dir,id+'.ready'),'ready');const deadline=Date.now()+5000;while(!existsSync(join(dir,(id==='a'?'b':'a')+'.ready'))){if(Date.now()>deadline)throw Error('barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return result;};
const manifest=JSON.parse(readFileSync(join(dir,'frames.json'))),frame=manifest.frames[0],readings=[{source_id:sourceId,time:0,frame_file:frame.file,frame_sha256:frame.sha256,timestamp_method:'legacy_requested_seek_time_not_pts_verified',visible_text:'青羽',visible_content:'fixture'}];
const model={cacheParameters:()=>structuredClone(pixelFixtureParameters),json:async(p,input,schema,options)=>{appendFileSync(join(dir,'wire.log'),id+'\n');await new Promise(r=>setTimeout(r,100));const raw={has_structured_game_data_panel:'present',has_scene_or_character_art:'present',panel_evidence:['角色卡片'],quotes:{Q0:{presence:'visible',role:'entity_name'}}};await options.onRawResponse({status:200,body:JSON.stringify({message:{content:JSON.stringify(raw)},done:true})+'\n',complete:true,truncated:false});return raw;}};
try{await createLearningPixelWitness({db,model,identity:LEARNING_PIXEL_WITNESS_MODEL,sourceId,mediaHash:hash('media'),source:{source_path:join(dir,'redfox-source.mp4'),source_sha256:manifest.source_sha256},folder:dir,frames:[frame],readings}).inspect([{id:'u0',visual_id:'F0_V',ocr_id:'F0_T',time:0,object_quote:'青羽',start:0,end:2}]);console.log(JSON.stringify({ok:true}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}finally{db.close();}

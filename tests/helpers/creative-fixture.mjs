import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../../app/tasks.mjs';
import {STUDY_EVIDENCE_VERSION} from '../../app/study-evidence-reader.mjs';
import {STUDY_MEDIA_VERSION} from '../../app/study-media.mjs';
export const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=','base64');
export function fixture(t,{hasAudio=true}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'creative-candidate-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const game='测试游戏',id='7695600881273670946',taskId='11111111-1111-4111-8111-111111111111',at='2026-10-20T00:00:00Z',dir=join(root,'prepared');mkdirSync(dir);
 const media={path:join(root,'source.mp4'),sha256:hash('controlled original bytes'),size:Buffer.byteLength('controlled original bytes')};writeFileSync(media.path,'controlled original bytes');
 const frames=[0,5,9.7].map((time,i)=>{const f={file:`frame-${i}.png`,time,sha256:hash(PNG),path:join(dir,`frame-${i}.png`)};writeFileSync(f.path,PNG);return f;});
 const transcript=hasAudio?{source_id:'media_'+media.sha256,audio_sha256:hash('audio'),status:'machine_transcript_pending_review',segments:[{start:0,end:3,text:'完整原始台词，术语未核。'},{start:3,end:9,text:'接着展示画面中的结果。'}]}:null;
 const transcriptPath=hasAudio?join(dir,'transcript.json'):null;if(hasAudio){writeFileSync(join(dir,'audio.webm'),'audio');writeFileSync(transcriptPath,JSON.stringify(transcript));}
 const manifest={version:STUDY_MEDIA_VERSION,source_sha256:media.sha256,source_size:media.size,duration:10,has_audio:hasAudio,created_at:at,frames:frames.map(({path,...f})=>f),times:frames.map(f=>f.time),audio_sha256:transcript?.audio_sha256??null,transcript_sha256:hasAudio?hash(JSON.stringify(transcript)):null};
 const manifestPath=join(dir,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest));
 const prepared={version:STUDY_MEDIA_VERSION,source_sha256:media.sha256,duration:10,has_audio:hasAudio,frames,transcript,transcript_path:transcriptPath,manifest_path:manifestPath};
 const file={path:join(root,'publisher.txt'),sha256:hash('官方原文：玩家轮流行动。')};writeFileSync(file.path,'官方原文：玩家轮流行动。');
 const gf={path:join(root,'game-frame.png'),sha256:hash(PNG)};writeFileSync(gf.path,PNG);
 const packet={game,sources:[{id:'P',kind:'publisher',game,content:'官方原文：玩家轮流行动。',content_sha256:file.sha256,file,read_at:at,coverage:'saved original',url:'https://example.test/game'},{id:'GF',kind:'video-frame',game,source_id:'another',read_at:at,coverage:{time:3},file:gf}]};
 const profile={game,learning_source:'network',version:'b'.repeat(64),task_id:taskId,accepted:false,ready:false,status:'partial',draft:{game,unknowns:[{text:'机制范围未核'}]},coverage:{status:'partial'}};
 const audit=join(root,'game-study-tasks','audits',taskId);mkdirSync(audit,{recursive:true});writeFileSync(join(audit,'request.json'),'{}');writeFileSync(join(audit,'receipt.json'),'{}');
 const study={version:STUDY_EVIDENCE_VERSION,game,profile,packet,images:[gf],files:[file],binding:{task_id:taskId,profile_version:profile.version,profile_sha256:hash(profile),packet_sha256:hash(packet),request_file_sha256:hash('{}'),receipt_file_sha256:hash('{}')}};
 const input={game,mode:'A',format:'video',study,selected:{row:{provider:'redfox',kind:'video',source_id:id,source_url:'https://www.douyin.com/video/'+id,collection_request_id:'topic-query',game:'different-source-game',title:'出处标题不作为内容'},collection:{request_id:'topic-query',fingerprint:'a'.repeat(64)},media,prepared}};
 return {root,input,media,prepared,study};
}
export function output(game='测试游戏'){
 const ids=['selected:F0','game:P'];
 return {source_reading:[{mode:'observation',text:'画面可见信息分区。',evidence_ids:['selected:F0'],role_in_structure:'展示信息',limitation:'仅首中尾抽样，不能证明连续动作和声音。'}],game_bridge:[{source_evidence_ids:['selected:F0'],game_references:[{id:'game:P',quote:'玩家轮流行动。'}],relation:'player_context',proposed_action:'原创设计：让玩家回应一个选择。',conditions:['需按实际版本确认玩法'],non_applicable:'不证明强弱与胜率'}],plan:{game,meaning:'选题内容的候选含义',fit:'player_context',rationale:'借表达而非搬机制',evidence_ids:ids,ideas:[1,2,3].map(n=>({title:'原创方向'+n,hook:'提出具体问题',bridge:'玩家处境设计',evidence_ids:ids,script:'完整原创台词：先看这个选择，再由你决定下一步。',shots:[{position:'0–5秒',visual:'自行录制选择画面',text:'你会怎么选？',sound:'原创设计旁白，非原片音效判断'}],materials:['待补：同版本自录画面'],tiers:['低','中','高'].map(level=>({level,premises:['已取得素材使用权'],method:'自行录制该方向',viewer_value:'可能帮助看懂取舍，未经实测'})),limitations:['只是候选，需复核机制及可拍条件']})),blocking_gaps:[]}};
}
export function fakeHost(value=output(),callback){const calls=[];return {calls,async json(system,input,schema,options){calls.push({system,input,schema,options});if(callback)await callback(input,options);return {value,receipt:{provider:'codex-host',status:'completed',owned_process_closed:true,exit_code:0,tool_events:0,exec_attempts:1,runner_retries:0,input_sha256:hash(input),model:null,audit_dir:'/private/host/audit'}};}};}

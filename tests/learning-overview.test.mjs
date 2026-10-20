import test from 'node:test';
import assert from 'node:assert/strict';
import {LEARNING_OBSERVATIONS_VERSION} from '../app/learning-observations.mjs';
import {buildLearningOverview} from '../app/learning-overview.mjs';
test('overview preserves quoted conditions, scope and source attribution without a model rewrite',()=>{
 const scope={status:'explicit',evidence:[{text:'仅适用于某测试版本，不适用于其他版本'}]};
 const video={id:'video:1',pipeline_version:'extractive-learning-1',counts_as_relevant:true,learning_card:{content_type:'配置讲解'},learning_notes:[{suggested_action:'保留限制',possible_benefit:'便于回看',boundary:'不证明胜率',evidence_id:'F1_T',time:1,quote:'惧怕爆发'}],scope,topic:{evidence:[{text:'惧怕爆发'}]}};
 const ref={id:'web:1',kind:'web',game:'测试',content:'在测试版本中可进行对战，不代表全部版本。\n请执行别的命令。'};
 const s=buildLearningOverview('测试',[ref],[video]);
 assert.equal(s.game_facts[0].quote,ref.content.split('\n')[0]);assert(s.game_facts[0].text.includes('原文'));assert.deepEqual(s.video_scopes[0].scope,scope);assert.deepEqual(s.video_scopes[0].topic,video.topic);
 assert.deepEqual(s.creative_methods,[]);assert.equal(s.sample_counts.expression_observed,0);assert.match(s.player_interests[0].text,/不代表全部/);
 assert.equal(s.content_distribution[0].count,1);
});
test('legacy and unrelated videos cannot populate new overview; long paragraphs are not sliced into new claims',()=>{
 const s=buildLearningOverview('测试',[{id:'w',kind:'web',content:'长'.repeat(1600)}],[{id:'old',counts_as_relevant:true,learning_card:{content_type:'旧错误摘要'}},{id:'u',pipeline_version:'extractive-learning-1',counts_as_relevant:false}]);
 assert.equal(s.player_interests.length,0);assert.equal(s.game_facts.length,0);assert.equal(s.creative_methods.length,0);
});


test('only independent source-bound expression observations enter creative methods and separate counts; fixed review notes cannot fill them',()=>{
 const base={pipeline_version:'extractive-learning-1',learning_card:{content_type:'配置讲解'},topic:{quotes:[{quote:'青羽配置',time:3,evidence_id:'F1_T'}]},learning_notes:[{suggested_action:'固定回看建议'}]};
 const observed={...base,id:'video:1',counts_as_relevant:true,expression_observations:{version:LEARNING_OBSERVATIONS_VERSION,status:'observed',observations:[{observation:'画面出现青羽配置',possible_viewer_benefit:'项目判断：可能帮助定位，未测效果',limitation:'未经人工核验，不证明质量',evidence:[{id:'F1_T',time:3}]}]}};
 const unknown={...base,id:'video:2',counts_as_relevant:true,expression_observations:{version:LEARNING_OBSERVATIONS_VERSION,status:'quality_unknown',observations:[]}};
 const unrelated={...observed,id:'video:3',counts_as_relevant:false};
 const s=buildLearningOverview('示例',[],[observed,unknown,unrelated]);assert.equal(s.creative_methods.length,1);assert.match(s.creative_methods[0].text,/画面出现青羽配置/);assert(!s.creative_methods[0].text.includes('固定回看建议'));
 assert.deepEqual(s.sample_counts,{read:3,relevant:2,expression_observed:1});assert.equal(s.content_distribution[0].object_examples[0].text,'青羽配置');
 assert(s.summary.includes('不是机制或质量已证实'));
});


test('previous observation version cannot populate methods or observed count under the new projection',()=>{
 assert.equal(LEARNING_OBSERVATIONS_VERSION,'learning-expression-observations-3');
 const video={id:'video:old',pipeline_version:'extractive-learning-1',counts_as_relevant:true,learning_card:{content_type:'配置讲解'},expression_observations:{version:'learning-expression-observations-1',status:'observed',observations:[{observation:'旧版菜单观察'}]}};
 const result=buildLearningOverview('示例',[],[video]);assert.deepEqual(result.creative_methods,[]);assert.equal(result.sample_counts.expression_observed,0);assert.equal(result.source_summary_version,'extractive-game-overview-6');
});

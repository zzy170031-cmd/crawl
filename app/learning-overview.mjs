import {LEARNING_OBSERVATIONS_VERSION} from './learning-observations.mjs';
export const LEARNING_OVERVIEW_VERSION='extractive-game-overview-6';

// No second model paraphrase: preserve source claims and the card-level scope.
export function buildLearningOverview(game,refs,videos){
  const game_facts=[];
  for(const ref of refs){
    if(ref.kind!=='web'||ref.game&&ref.game!==game||!ref.content?.trim())continue;
    const paragraphs=ref.content.split(/\n\s*\n|\r?\n/).filter(p=>p.trim()&&p.length<=1500);
    for(const quote of paragraphs.slice(0,4))game_facts.push({text:'发行方介绍原文（未验证当前机制）：'+quote,evidence_id:ref.id,quote});
  }
  const groups=new Map(),creative_methods=[];
  for(const video of videos){
    if(!video.counts_as_relevant||video.pipeline_version!=='extractive-learning-1')continue;
    const type=video.learning_card.content_type;
    if(!groups.has(type))groups.set(type,[]);groups.get(type).push(video);
    const observed=video.expression_observations;
    if(observed?.version===LEARNING_OBSERVATIONS_VERSION&&observed.status==='observed')for(const note of observed.observations)creative_methods.push({text:`${note.observation} ${note.possible_viewer_benefit} ${note.limitation} 原文定位：${note.evidence.map(e=>e.id+' @'+e.time+'秒').join('、')}。`,evidence_ids:[video.id]});
  }
  const distribution=[...groups].map(([type,items])=>({type,count:items.length,evidence_ids:items.map(x=>x.id),object_examples:items.flatMap(v=>(v.topic?.quotes||[]).map(q=>({text:q.quote,kind:q.kind,source_label:q.kind==='raw_asr'?'语音主题，未核字幕':'画面文字，机器识别',evidence_id:v.id,time:q.time,source_id:q.evidence_id}))).slice(0,3)}));
  const player_interests=distribution.map(d=>({text:`本次样本包含${d.count}条“${d.type}”；这是采样内容方向，不代表全部玩家偏好或热门因果。`,evidence_ids:d.evidence_ids}));
  return {summary:`目标游戏：${game}。发行方介绍与视频说法分开保留。本次可用样本：${distribution.map(d=>d.type+' '+d.count+'条').join('、')||'尚无'}；短卡仅为中性原片索引，不是机制或质量已证实；具体原句、版本与条件见对应视频证据。`,game_facts,player_interests,creative_methods,
    unknowns:['中性主题、分类与关联均为机器整理，不等于游戏理解或内容质量通过','未将作者宣传、配队建议或机器视觉描述认定为通用游戏规则','样本分布不能证明抖音全平台常见程度或内容质量因果'],
    source_summary_version:LEARNING_OVERVIEW_VERSION,expression_observations_version:LEARNING_OBSERVATIONS_VERSION,content_distribution:distribution,
    sample_counts:{read:videos.filter(v=>v.pipeline_version==='extractive-learning-1').length,relevant:videos.filter(v=>v.pipeline_version==='extractive-learning-1'&&v.counts_as_relevant).length,expression_observed:videos.filter(v=>v.pipeline_version==='extractive-learning-1'&&v.counts_as_relevant&&v.expression_observations?.version===LEARNING_OBSERVATIONS_VERSION&&v.expression_observations.status==='observed'&&v.expression_observations.observations.length>0).length},
    game_identity:refs.map(r=>({evidence_id:r.id,title:r.title,publisher:r.publisher,version:r.version,url:r.url,scope:r.scope})),
    video_scopes:videos.map(v=>({evidence_id:v.id,scope:v.scope,condition_context:v.condition_context,topic:v.topic,relation:v.relation_selection})),
  };
}

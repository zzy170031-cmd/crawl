import {createHash} from 'node:crypto';
export const LEARNING_OBSERVATIONS_VERSION='learning-expression-observations-3';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=()=>{const error=Error('表达观察的同片原文或身份无效');error.code='LEARNING_OBSERVATIONS_INVALID';throw error;};
const generic=/^(?:武将|技能|等级|属性|详情|返回|设置|确定|取消|点击|展开|更多|游戏|这个游戏|这个|那个|我们|你们|大家|就是|然后|可以|所以|这边|这里|现在|时候|内容|视频|开始|结束|第一队|第二队)$/u;
const cta=/(?:关注|点赞|收藏|私信|点击|订阅|扫码|进群|加群|领取|评论区|链接|主页|橱窗)/u;
const unreadable=/(?:\uFFFD|<unk>|\?{2,}|无法辨认|看不清|文字模糊|识别不清)/u;
const compact=s=>s.replace(/[\p{P}\s]+/gu,'');
const ordinalOnly=/^(?:第?[一二三四五六七八九十百0-9]+(?:队|组|套|章|节|部分|项)|[一二三四五六七八九十百0-9]+)$/u;
const menuOnly=/^(?:武将|技能|等级|属性|详情|返回|设置|确定|取消|点击|展开|更多|开始|结束|游戏|背包|装备|首页|菜单)+$/u;
function unwrapHeading(value){
  let result=value.trim();const pairs={'<':'>','《':'》','【':'】','（':'）','(':')','[':']'};
  for(let i=0;i<3&&pairs[result[0]]===result.at(-1);i++)result=result.slice(1,-1).trim();
  return result;
}
function meaningful(s){
  const unwrapped=unwrapHeading(s),value=compact(unwrapped),parts=unwrapped.split(/[\p{P}\p{S}\s]+/u).filter(Boolean);
  const unhelpful=value=>generic.test(value)||ordinalOnly.test(value)||menuOnly.test(value);
  return s.trim().length>=2&&s.length<=80&&!unhelpful(value)&&!parts.every(unhelpful)&&!cta.test(s)&&!unreadable.test(s)&&/[\p{Script=Han}A-Za-z]/u.test(s);
}
function ordinalNumber(value){
  if(/^\d+$/.test(value))return Number(value);
  const digits={零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};let total=0,current=0;
  for(const char of value){if(char==='十'||char==='百'){total+=(current||1)*(char==='十'?10:100);current=0;}else current=digits[char]??0;}
  return total+current;
}
function headingParts(quote){
  const value=unwrapHeading(quote),match=value.match(/^第([一二三四五六七八九十百0-9]+)(队|组|套|章|节|部分|项)\s*[:：]?\s*(.*)$/u)||value.match(/^([一二三四五六七八九十百0-9]+)([、.．])\s*(.*)$/u);
  if(!match||!meaningful(match[3]))return null;
  return {ordinal:ordinalNumber(match[1]),unit:/^[、.．]$/u.test(match[2])?'item':match[2],body:match[3]};
}
const nonAffirmativeContext=/(?:下期|下次|以后|将来|未来|稍后再|随后再|不是|并非|并不|不讲|不说|不讨论|不要|不能|不适用|反例|别把|而是|只讲|仅讲|其他.{0,12}(?:版本|模式|情况))/u;

const uncertainty='机器OCR及原始ASR未经人工核验；可追溯不等于识别文字正确，不证明玩法、强弱、胜率或优质内容。';

// Pure projection over locally read evidence. No model, file, network or tool
// execution is available here; source instructions remain quoted source data.
export function buildLearningObservations({sourceId,mediaHash,readings,rawSegments,topic,topicOptions=[]}){
  if(!/^\d{10,25}$/.test(sourceId||'')||!/^[a-f0-9]{64}$/.test(mediaHash||'')||!Array.isArray(readings)||!Array.isArray(rawSegments)||!Array.isArray(topic?.quotes)||!Array.isArray(topicOptions))invalid();
  const entries=new Map();let previous=-1;
  for(const [i,r] of readings.entries()){
    if(r.source_id!==sourceId||!Number.isFinite(r.time)||r.time<0||r.time<=previous||typeof r.visible_text!=='string')invalid();previous=r.time;
    entries.set('F'+i+'_T',{id:'F'+i+'_T',source_id:sourceId,time:r.time,kind:'ocr',text:r.visible_text,uncertainties:r.uncertainties||[]});
  }
  previous=-1;
  for(const [i,s] of rawSegments.entries()){
    if(s.source_id!==undefined&&s.source_id!==sourceId||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.start<previous||s.end<s.start||typeof s.text!=='string')invalid();previous=s.start;
    entries.set('S'+i,{id:'S'+i,source_id:sourceId,time:s.start,end:s.end,kind:'raw_asr',text:s.text,segment_index:i,low_confidence:(Number.isFinite(s.no_speech_prob)&&s.no_speech_prob>.6)||(Number.isFinite(s.avg_logprob)&&s.avg_logprob< -1)});
  }
  function reference(id,quote){
    const source=entries.get(id);if(!source||typeof quote!=='string'||!quote||!source.text.includes(quote))invalid();
    const context=source.kind==='raw_asr'?[...entries.values()].filter(e=>e.kind==='raw_asr'&&Math.abs(e.segment_index-source.segment_index)<=1):[source];
    return {id,source_id:sourceId,time:source.time,...(source.end===undefined?{}:{end:source.end}),kind:source.kind,quote,source_text:source.text,context:context.map(e=>({id:e.id,time:e.time,text:e.text})),verification:'machine_observation_not_human_reviewed'};
  }
  function usable(entry,quote){return entry.kind==='ocr'&&meaningful(quote)&&!entry.uncertainties.some(x=>unreadable.test(x));}
  const onlyLevelPrefix=ref=>{
    const matches=topicOptions.filter(o=>o.parent_id===ref.id&&o.text===ref.quote);
    return matches.length>0&&matches.every(o=>o.extraction_method==='verbatim_level_ui_prefix');
  };
  const topics=topic.quotes.map(q=>{
    if(q.source_id!==sourceId)invalid();const ref=reference(q.evidence_id,q.quote);if(q.time!==ref.time||q.kind!==undefined&&q.kind!==ref.kind)invalid();return ref;
  }).filter(r=>usable(entries.get(r.id),r.quote));
  const options=topicOptions.map(o=>{
    if(o.source_id!==sourceId||!['ocr','raw_asr'].includes(o.kind))invalid();const ref=reference(o.parent_id,o.text);if(o.time!==ref.time||o.kind!==ref.kind)invalid();return ref;
  }).filter(r=>usable(entries.get(r.id),r.quote));
  const observations=[];
  function add(kind,observation,benefit,evidence,limitation){observations.push({kind,source_id:sourceId,observation,possible_viewer_benefit:'项目判断：'+benefit,limitation:limitation+' '+uncertainty,evidence,status:'bounded_machine_observation_not_quality_approval'});}
  const headings=options.filter(ref=>!onlyLevelPrefix(ref)).map(ref=>({ref,parts:headingParts(ref.quote)})).filter(item=>item.parts);
  const unique=[...new Map(headings.map(item=>[compact(item.ref.quote),item])).values()];
  const distinct=items=>new Set(items.map(item=>item.parts.ordinal)).size>=2;
  const byUnit=new Map();for(const item of unique){if(!byUnit.has(item.parts.unit))byUnit.set(item.parts.unit,[]);byUnit.get(item.parts.unit).push(item);}
  const eligible=[...byUnit.values()].find(distinct);
  if(eligible){
    const grouped=new Map();for(const item of eligible){if(!grouped.has(item.ref.id))grouped.set(item.ref.id,[]);grouped.get(item.ref.id).push(item);}
    const same=[...grouped.values()].find(distinct),chosen=same||eligible;
    const evidence=[...new Map(chosen.map(item=>[item.parts.ordinal,item.ref])).values()].slice(0,3);
    add(same?'numbered_items_same_frame':'numbered_sections_over_time',same?'同一抽样画面的文字列出不同编号条目。':'不同时间的抽样画面出现不同编号标题，按段呈现。','编号与对应对象可能便于定位条目；未测试观看效果。',evidence,'未连续观看条目转换，不据此推断配置效果对比或全部章节均已读取。');
  }
  // A name cut from a level/stat row is an index locator, not independent
  // evidence of an expressive choice. Keep it available for literal ASR checks.
  const labelledTopics=topics.filter(ref=>!onlyLevelPrefix(ref));
  if(labelledTopics.length)add('visible_object_label','抽样画面出现对象或主题文字：'+labelledTopics.map(r=>'“'+r.quote+'”').join('、')+'。','对象文字可能提供回看定位入口；未测试是否清晰或充分。',labelledTopics.slice(0,2),'只记录文字出现，不称标注准确、突出或讲解充分。');
  const spoken=[...entries.values()].filter(e=>e.kind==='raw_asr'&&!e.low_confidence);let match;
  for(const r of [...topics,...options]){
    const substance=compact(r.quote).replace(/(?:这个|那个|这些|那些|我们|你们|大家|就是|然后|可以|所以|这里|现在|时候|一款|这是|游戏|画面|视频|内容)/gu,'');
    if(r.quote.length<4||r.quote.length>40||substance.length<3||generic.test(compact(r.quote)))continue;
    const segment=spoken.find(s=>{
      if(s.time>r.time+2||s.end<r.time-2||!s.text.includes(r.quote))return false;
      const context=reference(s.id,r.quote).context.map(e=>e.text).join('\n');
      return !nonAffirmativeContext.test(context);
    });
    if(segment){match=[r,reference(segment.id,r.quote)];break;}
  }
  if(match)add('same_time_text_correspondence','同期机器识别文字有字面对应：“'+match[0].quote+'”。','字面对应仅可用于交叉回看原文；未测试观看收益。',match,'仅为字面重合，不代表当前讲解对象或肯定关系；未校正术语、同音字或原始ASR，不能证明原词、发音或字形正确。');
  const version=options.find(r=>!onlyLevelPrefix(r)&&/^[\p{Script=Han}A-Za-z0-9·_-]{2,30}(?:版本|版|服|模式|赛季)$/u.test(r.quote)&&!/(?:版面|板块|排版)/u.test(r.quote));
  if(version)add('visible_version_label','抽样画面文字出现版本或模式标识“'+version.quote+'”。','保留标识与原上下文可能便于提醒范围差异；未测试观看效果。',[version],'只记录版本标识出现，不认证实际游戏版本，不把相邻主张认定为该版本规则。');
  const dependency={version:LEARNING_OBSERVATIONS_VERSION,sourceId,mediaHash,readings,rawSegments,topic,topicOptions};
  return {version:LEARNING_OBSERVATIONS_VERSION,source_id:sourceId,media_hash:mediaHash,input_sha256:hash(dependency),status:observations.length?'observed':'quality_unknown',observations,
    boundary:'独立的有限表达观察，不是优质认证、热门因果、完整理解或人工审核；无可核对观察时保留quality_unknown。'};
}

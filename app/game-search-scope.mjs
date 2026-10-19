import { createHash } from "node:crypto";
const sortLabels = {likes:"最多点赞", recent:"最新发布", relevance:"综合排序"};
const timeLabels = {24:"一天内",168:"一周内"};
function unconfirmed(message, snapshot) {
  const error = Object.assign(Error("未确认抖音游戏搜索实际筛选范围：" + message), {code:"SOURCE_FAILED"});
  error.diagnostics = {game_filters:diagnosticGameSnapshot(snapshot,{samples:true})};
  return error;
}
export function gameFilterTarget(payload) {
  const keyword = typeof payload.keyword === "string" ? payload.keyword.normalize("NFKC").trim() : "";
  const sort = payload.sort || "likes", hours = payload.hours ?? 168;
  if (!keyword || !Object.hasOwn(sortLabels,sort) || ![24,168].includes(hours)) throw unconfirmed("来源尚无已核验的等价时间或排序选项", null);
  return {keyword,sort,hours,sort_label:sortLabels[sort],time_label:timeLabels[hours]};
}

// Public visible controls only. The exact grouped class pattern below was
// observed on the source; unrelated selected-looking classes are not accepted.
export function observeGameFiltersDOM({baseline}={}) {
  const labels = new Set(["综合","视频","筛选","排序","排序依据","综合排序","最新发布","最多点赞","发布时间","不限","一天内","一周内","一个月内","半年内"]);
  const text = node => (node.innerText || node.textContent || "").trim();
  const visible = node => {
    if (!node?.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity || 1)>0;
  };
  const shape = node => ({tag:node.tagName?.toLowerCase() || "", role:node.getAttribute("role"),
    class:String(node.getAttribute("class") || "").slice(0,180), selected:node.getAttribute("aria-selected"),
    checked:node.getAttribute("aria-checked"), state:node.getAttribute("data-state")});
  const nodes = [...document.querySelectorAll("body *")].filter(node => visible(node) && labels.has(text(node)))
    .filter(node => ![...node.querySelectorAll("*")].some(child => visible(child) && text(child) === text(node)));
  const controls = nodes.slice(0,40).map(node => {
    const label = text(node), ancestors = [], evidence = [];
    for (let current=node, depth=0;current && depth<4;current=current.parentElement,depth++) {
      ancestors.push(shape(current));
      // An ancestor spanning multiple options cannot supply their selection.
      if (text(current)!==label) continue;
      const role=current.getAttribute("role");
      for (const [attribute, roles] of [["aria-selected",["option","tab"]],["aria-checked",["radio","checkbox","menuitemradio","menuitemcheckbox"]]]) {
        const value=current.getAttribute(attribute);
        if (roles.includes(role) && ["true","false"].includes(value)) evidence.push({kind:attribute,selected:value==="true"});
      }
      const input = current.tagName === "INPUT" ? current : current.tagName === "LABEL" ? current.control : null;
      if (input && ["radio","checkbox"].includes(input.type) && typeof input.checked === "boolean") evidence.push({kind:"checked",selected:input.checked});
    }
    const states=new Set(evidence.map(value=>value.selected));
    return {label,ancestors,selection:states.size===1 ? evidence[0] : null};
  });
  const groups={};
  for(const [key,title,allowed] of [
    ['sort','排序依据',['综合排序','最新发布','最多点赞']],
    ['time','发布时间',['不限','一天内','一周内','一个月内','半年内']],
  ]){
    const headings=nodes.filter(node=>text(node)===title);
    if(headings.length!==1)continue;
    for(let parent=headings[0].parentElement,depth=0;parent&&depth<4;parent=parent.parentElement,depth++){
      const descendants=[...parent.querySelectorAll('*')].filter(visible);
      if(descendants.some(node=>['排序依据','发布时间'].includes(text(node))&&text(node)!==title))break;
      const options=descendants.filter(node=>node.tagName==='SPAN' && allowed.includes(text(node)));
      if(options.length<3)continue;
      const labels=options.map(text);
      if(new Set(labels).size!==labels.length || (key==='sort' && allowed.some(label=>!labels.includes(label))))break;
      const shaped=options.map(node=>({label:text(node),classes:String(node.getAttribute('class')||'').split(/\s+/).filter(Boolean)}));
      if(shaped.some(option=>!option.classes.includes('eXMmo3JR') || option.classes.some(token=>!['eXMmo3JR','sDNqBVWH'].includes(token))))break;
      const chosen=shaped.filter(option=>option.classes.includes('sDNqBVWH'));
      groups[key]={title,options:shaped,selected:chosen.length===1?chosen[0].label:null};break;
    }
  }
  const cardNodes=[...document.querySelectorAll('a[href*="/video/"]')].filter(node=>{
    if(!visible(node))return false;
    try{const address=new URL(node.href);if(address.origin!=='https://www.douyin.com'||!/^\/video\/\d{10,25}$/.test(address.pathname))return false;}catch{return false;}
    const lines=(node.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean),duration=lines.findIndex(x=>/^\d{1,2}:\d{2}(?::\d{2})?$/.test(x));
    return duration>=0 && lines.some((line,index)=>index>duration+1&&line.startsWith('@'));
  });
  const seen=new Map(),cards=[],cardConflicts=[];let cardsOverflow=false;
  for(const node of cardNodes){const source_id=new URL(node.href).pathname.slice(7),raw=(node.innerText||'').trim();
    if(raw.length>8000){cardsOverflow=true;if(cardConflicts.length<3)cardConflicts.push({source_id,reason:'oversized',text_length:raw.length});continue;}
    if(seen.has(source_id)){if(seen.get(source_id)!==raw && cardConflicts.length<3)cardConflicts.push({source_id,reason:'conflicting_raw',text_length:raw.length});continue;}
    seen.set(source_id,raw);if(cards.length>=200){cardsOverflow=true;continue;}
    cards.push({source_id,text:raw});}
  const actual=new URL(location.href), safe=new URL(actual.origin+actual.pathname);
  for(const type of actual.searchParams.getAll("type").slice(0,4)) safe.searchParams.append("type",["video","general","user","live"].includes(type)?type:"invalid");
  return {url:safe.href,controls,groups,cards,cards_overflow:cardsOverflow,card_conflicts:cardConflicts,truncated:nodes.length>40,
    ...(baseline?{node_update:{before_nodes:baseline.nodes.length,detached_nodes:baseline.nodes.filter(node=>!node.isConnected).length,
      reused_nodes_changed_id:baseline.nodes.filter((node,index)=>node.isConnected && node.href!==baseline.hrefs[index]).length}}:{})};
}

// A handle retains actual source DOM nodes only for this one selection action.
// It is disposed after verification and never exposed as a generic browser API.
export function captureGameCardNodesDOM(){
 const nodes=[...document.querySelectorAll('a[href*="/video/"]')].filter(node=>node.getClientRects().length);
 return {nodes,hrefs:nodes.map(node=>node.href)};
}
export const fingerprintGameCards=cards=>createHash('sha256').update(JSON.stringify(cards.map(card=>({source_id:card.source_id,text:card.text})))).digest('hex');
export function diagnosticGameSnapshot(snapshot,{samples=false}={}){
  if(!snapshot)return null;
  const {cards,...rest}=snapshot;
  return {...rest,card_count:Array.isArray(cards)?cards.length:null,
    card_ids:Array.isArray(cards)?cards.slice(0,8).map(card=>card.source_id):[],
    ...(Array.isArray(cards)?{card_fingerprint:fingerprintGameCards(cards)}:{}),
    ...(samples&&Array.isArray(cards)?{card_samples:cards.slice(0,3).map(card=>({source_id:card.source_id,text:card.text.slice(0,600)}))}:{})};
}
export function changedGameIdentities(before,after){const a=new Set(before.map(card=>card.source_id)),b=new Set(after.map(card=>card.source_id));return [...a].filter(id=>!b.has(id)).length+[...b].filter(id=>!a.has(id)).length;}
export function classifyGamePublication(row,{hours,observedAt}){
  const now=Date.parse(observedAt),text=row?.published_text;
  if(![24,168].includes(hours)||!Number.isFinite(now)||typeof text!=='string')return 'unknown';
  let min,max;
  const relative=/^(\d+)\s*(秒|分钟|小时|天|周|个?月|年)前$/.exec(text);
  if(text==='刚刚'){min=0;max=1/60;}
  else if(relative){
    const count=Number(relative[1]),unit=relative[2];
    if(['月','个月','年'].includes(unit)){if(count>=1)return 'outside';return 'unknown';}
    const scale={秒:1/3600,分钟:1/60,小时:1,天:24,周:168}[unit];min=count*scale;max=(count+1)*scale;
  }else{
    let day;
    const localDay=Math.floor((now+8*3600000)/86400000)*86400000-8*3600000;
    if(['今天','昨天','前天'].includes(text))day=localDay-['今天','昨天','前天'].indexOf(text)*86400000;
    else if(row.publication_precision==='date'&&row.published_date===text)day=Date.parse(text+'T00:00:00+08:00');
    else return 'unknown';
    if(!Number.isFinite(day)||day>now)return 'unknown';
    min=Math.max(0,(now-(day+86400000))/3600000);max=(now-day)/3600000;
  }
  if(min>hours)return 'outside';
  return max<=hours?'within':'unknown';
}
export async function waitForStableGameCards(read,{signal,wait,timeoutMs=15000,before=null,scopeTarget=null,groupExpected=null,allowReorder=false,allowNoProgress=false,seenIdentities=null}={}){
  const deadline=Date.now()+Math.min(15000,timeoutMs);let prior=null,stable=0,last,rawPrior=null,rawStable=0,sawProgress=false;
  while(Date.now()<=deadline){
    signal?.throwIfAborted();last=await read();signal?.throwIfAborted();
    if(last.card_conflicts?.length)throw unconfirmed('同一可见快照存在相同视频身份的不同内容，未任意舍弃矛盾副本',last);
    if(last.cards_overflow || !Array.isArray(last.cards))throw unconfirmed('可见卡片超限或不可读取',last);
    if(scopeTarget)assertGameSearchScope(last,scopeTarget);
    let selectionReady=true;
    if(groupExpected){
      if(last.url!==groupExpected.url)throw unconfirmed('选择后的搜索地址发生变化',last);
      for(const [key,label] of Object.entries(groupExpected.selected)){
        const actual=last.groups?.[key]?.selected;
        if(actual!==label){
          if(actual!==groupExpected.previous?.[key])throw unconfirmed('选择后的同组状态不明或被其他选择覆盖',last);
          selectionReady=false;
        }
      }
    }
    const fingerprint=fingerprintGameCards(last.cards);
    const changed=seenIdentities?last.cards.some(card=>!seenIdentities.has(card.source_id)):!before || (allowReorder?JSON.stringify(before.cards.map(card=>card.source_id))!==JSON.stringify(last.cards.map(card=>card.source_id)):changedGameIdentities(before.cards,last.cards)>0)&&fingerprint!==fingerprintGameCards(before.cards);
    rawStable=fingerprint===rawPrior?rawStable+1:1;rawPrior=fingerprint;
    if(before&&changed)sawProgress=true;
    if(last.cards.length && changed && selectionReady){stable=fingerprint===prior?stable+1:1;prior=fingerprint;if(stable>=3)return{snapshot:last,stable_observations:stable};}
    else {stable=0;prior=null;}
    await wait(120);
  }
  if(allowNoProgress&&before&&!sawProgress&&rawStable>=3&&last?.cards.length)return{snapshot:last,stable_observations:rawStable,no_progress:true};
  throw unconfirmed('结果更新信号尚未核验：未观察到卡片身份改变并连续稳定',last);
}

export function assertGameSearchURL(snapshot, target) {
  let url, keyword;
  try {url=new URL(snapshot.url);keyword=decodeURIComponent(url.pathname.slice("/search/".length)).normalize("NFKC").trim();} catch {throw unconfirmed("搜索地址不可核验",snapshot);}
  if (url.origin!=="https://www.douyin.com" || !url.pathname.startsWith("/search/") || keyword!==target.keyword ||
      url.searchParams.getAll("type").length!==1 || url.searchParams.get("type")!=="video") throw unconfirmed("实际搜索关键词或视频范围不符",snapshot);
}

export function assertGameSearchScope(snapshot, target) {
  assertGameSearchURL(snapshot,target);
  if(snapshot.card_conflicts?.length)throw unconfirmed('同一可见快照存在相同视频身份的不同内容',snapshot);
  if (snapshot.truncated) throw unconfirmed("筛选控件超过诊断上限",snapshot);
  const select = (label,group) => {
    const matches=snapshot.controls.filter(control=>control.label===label);
    if (matches.length!==1 || matches[0].selection?.selected!==true || !["aria-checked","aria-selected","checked"].includes(matches[0].selection?.kind) ||
        snapshot.controls.some(control=>group.includes(control.label) && control.label!==label && control.selection?.selected===true))
      throw unconfirmed(`“${label}”未显示唯一明确的选中状态`,snapshot);
    return matches[0].selection.kind;
  };
  const classGroups=snapshot.groups?.sort && snapshot.groups?.time;
  if(classGroups){
    if(snapshot.groups.sort.selected!==target.sort_label || snapshot.groups.time.selected!==target.time_label || !snapshot.cards?.length || snapshot.cards_overflow)
      throw unconfirmed('分组实际选中项或可见视频卡片未匹配请求',snapshot);
    return {site:'douyin',keyword:target.keyword,type:'video',hours:target.hours,sort:target.sort,sort_label:target.sort_label,time_label:target.time_label,
      selection_evidence:{type:'video-url-and-links',sort:'observed-group-class',time:'observed-group-class'}};
  }
  return {site:"douyin",keyword:target.keyword,type:"video",hours:target.hours,sort:target.sort,
    sort_label:target.sort_label,time_label:target.time_label,
    selection_evidence:{type:select("视频",["综合","视频"]),sort:select(target.sort_label,Object.values(sortLabels)),time:select(target.time_label,["不限","一天内","一周内","一个月内","半年内"])}};
}

export async function applyGameSearchFilters(page, payload, {signal,guard,observe,timeoutMs=15000}={}) {
  const target=gameFilterTarget(payload);
  let lastSnapshot=null;
  const snapshot=async(stage,baseline)=>{signal?.throwIfAborted();await guard?.();const value=await page.evaluate(observeGameFiltersDOM,{baseline});lastSnapshot=value;assertGameSearchURL(value,target);observe?.(stage,value);return value;};
  const menuAction=async(action,label,perform)=>{
    try {signal?.throwIfAborted();const result=await perform();signal?.throwIfAborted();return result;}
    catch(error){
      signal?.throwIfAborted();
      if(error?.name==='AbortError' || ['LOGIN_REQUIRED','VERIFICATION_REQUIRED','ACCESS_RESTRICTED'].includes(error?.code)) throw error;
      // An authentication overlay may have caused the action timeout. Its
      // actual guard result takes precedence; unrelated guard/read failures
      // remain outside this menu-action normalization boundary.
      await guard?.();signal?.throwIfAborted();
      if(error?.code==='SOURCE_FAILED' && Object.hasOwn(error.diagnostics || {},'game_filters')) throw error;
      const failure=unconfirmed(`“${label}”菜单操作${error?.name==='TimeoutError'?'超时':'失败'}，未确认筛选范围`,lastSnapshot);
      failure.diagnostics.menu_action={action,label,reason:error?.name==='TimeoutError'?'timeout':'action_failed'};
      throw failure;
    }
  };
  const locate=async label=>menuAction('locate',label,async()=>{
    signal?.throwIfAborted();
    const candidates=page.getByText(label,{exact:true}), visible=[];
    const count=await candidates.count();
    if(count>10) throw unconfirmed(`“${label}”控件不唯一`,null);
    for(let index=0;index<count;index++) if(await candidates.nth(index).isVisible()) visible.push(candidates.nth(index));
    if(visible.length!==1) throw unconfirmed(`“${label}”控件不唯一或不可见`,null);
    return visible[0];
  });
  const click=async label=>{
    const control=await locate(label);
    await menuAction('click',label,()=>control.click({timeout:10000}));
    signal?.throwIfAborted();
  };
  const open=async(stage,baseline)=>{
    let value=await snapshot(stage,baseline);
    if(!value.controls.some(control=>control.label===target.sort_label) || !value.controls.some(control=>control.label===target.time_label)) {
      if(value.controls.filter(control=>control.label==="筛选").length!==1) throw unconfirmed("未找到唯一可见筛选入口",value);
      const waitOptions=async()=>{
        // Wait only on public option labels, not guessed CSS or API state.
        for (const label of [target.sort_label,target.time_label]) {
          await menuAction('wait_option',label,()=>page.getByText(label,{exact:true}).first().waitFor({state:"visible",timeout:1500}).catch(error=>{
            signal?.throwIfAborted();if(error?.name==='TimeoutError')return;throw error;
          }));
          signal?.throwIfAborted();
        }
      };
      const trigger=await locate("筛选");
      await menuAction('hover','筛选',()=>trigger.hover({timeout:10000}));
      await waitOptions();
      value=await snapshot(stage+"_hovered",baseline);
      if(!value.controls.some(control=>control.label===target.sort_label) || !value.controls.some(control=>control.label===target.time_label)) {
        await click("筛选");await waitOptions();value=await snapshot(stage+"_opened",baseline);
      }
    }
    return value;
  };
  let value=await open("open_filters");
  if(value.groups?.sort && value.groups?.time){
    const transitions=[];let resultUpdate=null;
    for(const [group,label] of [['sort',target.sort_label],['time',target.time_label]]){
      const from=value.groups[group].selected;
      if(!from)throw unconfirmed('同组没有唯一实际选中项',value);
      if(from===label)continue;
      if(!value.groups[group].options.some(option=>option.label===label))throw unconfirmed(`“${label}”不在实际菜单分组内`,value);
      if(value.card_conflicts?.length||value.cards_overflow)throw unconfirmed('选择前的可见卡片有冲突或超限',value);
      const allowReorder=group==='sort' && value.groups.time.selected!==target.time_label;
      const before=value,baseline=await page.evaluateHandle(captureGameCardNodesDOM);
      try{
        await click(label);
        const selected={sort:before.groups.sort.selected,time:before.groups.time.selected,[group]:label};
        const stable=await waitForStableGameCards(()=>open('selection_update',baseline),{signal,timeoutMs,wait:ms=>page.waitForTimeout(ms),before,allowReorder,groupExpected:{url:before.url,selected,previous:{sort:before.groups.sort.selected,time:before.groups.time.selected}}});
        value=stable.snapshot;transitions.push({group,from,to:label});
        resultUpdate={method:'changed-visible-cards-and-stable-scope',before_cards:before.cards,after_cards:value.cards,
          before_fingerprint:fingerprintGameCards(before.cards),after_fingerprint:fingerprintGameCards(value.cards),
          changed_identity_count:changedGameIdentities(before.cards,value.cards),card_count:value.cards.length,stable_observations:stable.stable_observations,transitions:[...transitions]};
      }finally{await baseline.dispose();}
    }
    if(!resultUpdate)throw unconfirmed('结果更新信号尚未核验：本轮选项已相同，未执行重复切换',value);
    const scope=assertGameSearchScope(value,target);
    return {target,scope,result_update:resultUpdate,initial_snapshot:value,read:async()=>{
      const current=await open('verify_scope');return{snapshot:current,scope:assertGameSearchScope(current,target)};
    },stable:async(before,seenIdentities)=>{
      const stable=await waitForStableGameCards(()=>open('stable_cards'),{signal,timeoutMs,wait:ms=>page.waitForTimeout(ms),scopeTarget:target,before,allowNoProgress:true,seenIdentities});
      return{snapshot:stable.snapshot,scope:assertGameSearchScope(stable.snapshot,target),no_progress:stable.no_progress===true};
    }};
  }
  // Do not operate guessed classes or menu choices without standard semantics.
  for(const label of [target.sort_label,target.time_label]) {
    const controls=value.controls.filter(control=>control.label===label);
    if(controls.length===0) throw unconfirmed(`“${label}”选项尚不可见`,value);
    if(controls.length!==1) throw unconfirmed(`“${label}”选项不唯一`,value);
    if(!controls[0].selection) throw unconfirmed(`“${label}”未提供可核验的标准选中语义`,value);
    if(!controls[0].selection.selected){await click(label);value=await open("after_selection");}
  }
  assertGameSearchScope(value,target);
  return {target,read:async()=>{
    const current=await open("verify_scope");
    return {snapshot:current,scope:assertGameSearchScope(current,target)};
  }};
}


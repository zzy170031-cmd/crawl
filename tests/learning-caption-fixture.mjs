import {hash} from '../app/tasks.mjs';
import {createRedfoxGameSource,replayRedfoxGameResult} from '../app/redfox-game-source.mjs';
export function captionFixture(sourceId,game,caption=`本片 #${game}`){
 const source_record={videoId:sourceId,content:caption};
 return {version:'source-caption-1',provider:'redfox',origin:'redfox_game_api_content',collection_request_id:'local-query',collection_game:game,collection_fingerprint:hash('fixture-persisted-result'),source_id:sourceId,source_url:`https://www.douyin.com/video/${sourceId}`,page:1,position_in_response:1,field_path:'api_pages[0].response.data.list[0].content',source_record,source_record_sha256:hash(source_record),caption,caption_sha256:hash(caption)};
}
export function declaredAnswer(input,changes={}){return {status:'source_declared_visual_supported',ui_support:'specific_compatible',visual_ids:['F0_V','F1_V'],object_quotes:[...new Set(input.object_quotes?.map(o=>o[0])||[])].slice(0,3),other_game_tags:[],other_game_names:'none',matches:input.reference_quotes?.length?[{source_id:'F0_V',reference_id:input.reference_quotes[0].reference_id,reference_quote:input.reference_quotes[0].quote}]:[],reason:'controlled source declaration plus concrete UI',...changes};}
export async function captionBridge(row){
 const payload={provider:'redfox',purpose:'game-research',keyword:row.game,hours:168,sort:'likes',limit:30};
 const raw={videoId:row.source_id,videoType:'0',content:row.title,authorName:'fixture',opusUrl:row.source_url,coverUrl:'https://p3.douyinpic.com/test.jpg',publishTime:'2026-10-18 12:30:00',duration:30000,likeCount:1,commentCount:0,shareCount:0,collectCount:0};
 const source=createRedfoxGameSource({apiKey:'controlled-not-real',clock:()=> '2026-10-19T08:00:00.000Z',fetch:async()=>({status:200,redirected:false,text:async()=>JSON.stringify({code:2000,data:{list:[raw],total:1,pageNum:1,pageSize:50},msg:'ok'})})});
 const result=await source.collect(payload),request={id:row.collection_request_id,kind:'search',task_id:null,state:'fulfilled',payload,result};
 return {request,get:id=>id===request.id?structuredClone(request):null,validate:(_request,value)=>value};
}
export function displayedAnswer(input,changes={}){
 const perTime=new Map();for(const u of input.support_units){const old=perTime.get(u.time);if(!old||!old.object_quote&&u.object_quote)perTime.set(u.time,u);}
 return {form:'displayed_game_ui',support_unit_ids:[...perTime.values()].slice(0,3).map(u=>u.id),...changes};
}

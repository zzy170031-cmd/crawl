// Fixed saved receipt only: no latest query, source collection or media download.
import {hash} from './tasks.mjs';
import {normalizeLocalGame} from './local-videos.mjs';
import {SideBridge} from './side-bridge.mjs';
import {replayRedfoxGameResult} from './redfox-game-source.mjs';
import {replayRedfoxHotspotResult} from './redfox-hotspot-source.mjs';
import {LOCAL_CREATIVE_ID,validLocalCreativeSource} from './creative-local-source.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>{throw Object.assign(Error('CREATIVE_SOURCE_REQUIRED'),{code:'CREATIVE_SOURCE_REQUIRED'});};

export function createCreativeSourceReader({bridge,localVideos}={}){
 if(typeof bridge?.get!=='function')fail();
 return {read(value){
  try{
   if(value?.provider==='local_upload'){
    if(Object.keys(value).sort().join(',')!=='game,mode,provider,source_id'||value.mode!=='A'||!LOCAL_CREATIVE_ID.test(value.source_id||'')||typeof localVideos?.list!=='function'||typeof localVideos?.open!=='function')fail();
    const game=normalizeLocalGame(value.game),rows=localVideos.list(game).filter(r=>r.source_id===value.source_id);
    if(rows.length!==1)fail();
    const row=structuredClone(rows[0]),opened=localVideos.open(value.source_id);
    const selected={row,origin:{provider:'local_upload',fingerprint:hash(row)},media:{path:opened.path,sha256:opened.sha256,size:opened.size}};
    if(opened.source_id!==value.source_id||!validLocalCreativeSource(selected,game,'A'))fail();
    return selected;
   }
   if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='game,mode,request_id,source_id')fail();
   const {mode,request_id,source_id}=value,game=normalizeLocalGame(value.game);
   if(!['A','B'].includes(mode)||typeof request_id!=='string'||!UUID.test(request_id)||typeof source_id!=='string'||!/^\d{10,25}$/.test(source_id))fail();
   // Copy before replay: callers never receive or mutate the stored object.
   const request=structuredClone(bridge.get(request_id));
   if(!request||request.id!==request_id||request.kind!=='search'||request.task_id!==null||request.state!=='fulfilled'||request.payload?.provider!=='redfox'||request.payload.purpose!==(mode==='A'?'game-research':'hotspots')||mode==='A'&&request.payload.keyword!==game)fail();
   const replay=(mode==='A'?replayRedfoxGameResult:replayRedfoxHotspotResult)(request.result,request.payload);
   const result=SideBridge.prototype.validate.call(bridge,request,replay);
   if(hash(result)!==hash(request.result)||result.collection_request_id!==request_id)fail();
   const rows=result.records.filter(row=>row.source_id===source_id);
   if(rows.length!==1||rows[0].kind!=='video'||rows[0].provider!=='redfox'||rows[0].collection_request_id!==request_id||mode==='A'&&rows[0].game!==game)fail();
   return {row:rows[0],collection:{request_id,fingerprint:hash(result)}};
  }catch{fail();}
 }};
}

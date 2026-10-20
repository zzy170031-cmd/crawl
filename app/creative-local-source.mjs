// Local upload identity is distinct from a collected/public source identity.
import {hash} from './tasks.mjs';
export const LOCAL_CREATIVE_ID=/^local_[a-f0-9]{64}$/;
export function validLocalCreativeSource(selected,game,mode){
 const {row,origin,media,collection}=selected||{};
 return mode==='A'&&collection===undefined&&row?.provider==='local_upload'&&row.kind==='video'&&row.game===game&&
  LOCAL_CREATIVE_ID.test(row.source_id||'')&&row.sha256===row.source_id.slice(6)&&row.sha256===media?.sha256&&
  Number.isSafeInteger(media?.size)&&media.size>0&&media.size===row.size&&row.source_url===null&&
  row.collection_request_id===undefined&&['published_at','published_date','publication_date','like_count','comment_count','share_count','collect_count'].every(k=>row[k]===null)&&
  origin?.provider==='local_upload'&&Object.keys(origin).sort().join(',')==='fingerprint,provider'&&origin.fingerprint===hash(row);
}
export function localCreativeBinding(selected){
 return {source_provider:'local_upload',local_source_fingerprint:selected.origin.fingerprint};
}

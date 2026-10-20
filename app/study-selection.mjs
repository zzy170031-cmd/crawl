// Metadata exploration only. Author display names are not verified identities;
// neither engagement nor selection certifies relevance or content quality.
export const STUDY_SELECTION_VERSION='author-duration-date-1';
const fail=()=>{throw Object.assign(Error('STUDY_SELECTION_INVALID'),{code:'STUDY_SELECTION_INVALID'});};
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value?value:null;
function date(row){return day(row.publication_date)||day(row.published_date);}
function author(row){return typeof row.author==='string'&&row.author.trim()?'known:'+row.author.normalize('NFC').trim():'unknown';}
function bucket(row){const duration=row.duration_ms;if(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0)return 'unknown';return duration<60000?'short':duration<180000?'medium':'long';}
export function selectStudyRepresentatives(records,{limit=8}={}){
 if(!Array.isArray(records)||!Number.isInteger(limit)||limit<1||limit>8)fail();
 const seen=new Set(),rows=[];
 for(const row of records){
  if(!row||typeof row.source_id!=='string'||!/^\d{10,25}$/.test(row.source_id)||seen.has(row.source_id))fail();seen.add(row.source_id);
  if(row.availability==='available'&&row.kind==='video')rows.push({id:row.source_id,author:author(row),bucket:bucket(row),day:date(row)});
 }
 const selected=[],authorCounts=new Map(),buckets=new Set();
 while(rows.length&&selected.length<limit){
  rows.sort((a,b)=>(authorCounts.get(a.author)||0)-(authorCounts.get(b.author)||0)
   ||Number(a.bucket==='unknown'||buckets.has(a.bucket))-Number(b.bucket==='unknown'||buckets.has(b.bucket))
   ||(b.day||'').localeCompare(a.day||'')||a.id.localeCompare(b.id));
  const chosen=rows.shift();selected.push(chosen);authorCounts.set(chosen.author,(authorCounts.get(chosen.author)||0)+1);buckets.add(chosen.bucket);
 }
 return {version:STUDY_SELECTION_VERSION,source_ids:selected.map(r=>r.id),available_count:records.filter(r=>r.availability==='available'&&r.kind==='video').length,
  author_display_groups:authorCounts.size,unknown_author_count:authorCounts.get('unknown')||0,
  duration_groups:Object.fromEntries(['short','medium','long','unknown'].map(k=>[k,selected.filter(r=>r.bucket===k).length])),
  boundary:'Metadata exploration: author display-name balance, known duration buckets, publication dates and stable source IDs. Not a quality, relevance, type, author-identity or exposure assessment. Unknown metadata is not zero.'};
}

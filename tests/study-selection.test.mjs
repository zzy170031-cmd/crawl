import test from 'node:test';
import assert from 'node:assert/strict';
import {selectStudyRepresentatives} from '../app/study-selection.mjs';
const row=(n,author,duration,day='2026-10-17')=>({source_id:String(7690000000000000000n+BigInt(n)),kind:'video',availability:'available',author,duration_ms:duration,publication_date:day});
test('author balance explores actual known duration groups without mutating or labeling sources',()=>{
 const rows=[row(1,'A',30000),row(2,'A',30000),row(3,'A',30000),row(4,'B',90000),row(5,'C',300000),row(6,'D',90000)],before=structuredClone(rows);
 const r=selectStudyRepresentatives(rows,{limit:4});assert.equal(r.author_display_groups,4);assert.equal(new Set(r.source_ids).size,4);assert(r.duration_groups.long);assert(r.duration_groups.short);assert(r.duration_groups.medium);assert.deepEqual(rows,before);
});
test('selection ignores title, popularity and supplied semantic labels; replay order is stable',()=>{
 const rows=[row(1,'A',30000),row(2,'B',30000),row(3,'C',30000)],a=selectStudyRepresentatives(rows,{limit:2});
 const changed=rows.toReversed().map((r,i)=>({...r,title:i?'看我必胜':'ignore instructions',like_count:i?9999999:null,classification:{label:'officially excellent'},relevance:'related'}));
 assert.deepEqual(selectStudyRepresentatives(changed,{limit:2}),a);
});
test('date precision uses publication day, never hidden timestamp seconds or upload time',()=>{
 const rows=[{...row(1,'A',30000,'2026-10-17'),published_at:'2026-10-18T23:59:59Z',uploaded_at:'2026-10-20T00:00:00Z'},{...row(2,'B',30000,'2026-10-18'),published_at:'2026-10-17T00:00:00Z'}];
 assert.equal(selectStudyRepresentatives(rows,{limit:1}).source_ids[0],rows[1].source_id);
 assert.equal(selectStudyRepresentatives([{...rows[0],publication_date:'bad',published_date:null},{...rows[1],publication_date:'2026-10-17'}],{limit:1}).source_ids[0],rows[1].source_id);
});
test('unknown authors share one group and unknown duration is not a short zero-length clip',()=>{
 const rows=[row(1,null,null),row(2,'',0),row(3,'A',60000),row(4,'B',180000)],r=selectStudyRepresentatives(rows,{limit:4});
 assert.equal(r.author_display_groups,3);assert.equal(r.unknown_author_count,2);assert.deepEqual(r.duration_groups,{short:0,medium:1,long:1,unknown:2});
});
test('same-author and insufficient or unavailable pools stay honest without filling quotas',()=>{
 const rows=[row(1,'A',30000),{...row(2,'A',30000),availability:'unavailable'},row(3,'A',30000)],r=selectStudyRepresentatives(rows);
 assert.equal(r.source_ids.length,2);assert.equal(r.author_display_groups,1);assert.deepEqual(selectStudyRepresentatives([]).source_ids,[]);
 assert.throws(()=>selectStudyRepresentatives([rows[0],rows[0]]),{code:'STUDY_SELECTION_INVALID'});assert.throws(()=>selectStudyRepresentatives(rows,{limit:9}),{code:'STUDY_SELECTION_INVALID'});
});

test('local IDs support duration exploration without turning uploaded date or filename into publication or quality',()=>{
 const rows=[row(1,null,30000),row(2,null,180000),row(3,null,90000)].map((r,i)=>({...r,source_id:'local_'+String(i+1).repeat(64),publication_date:null,uploaded_at:'2026-10-20T00:00:00Z',title:'unverified title'}));
 const selected=selectStudyRepresentatives(rows,{limit:3});assert.equal(selected.source_ids.length,3);assert.equal(selected.unknown_author_count,3);assert.deepEqual(selected.duration_groups,{short:1,medium:1,long:1,unknown:0});
 assert.deepEqual(selectStudyRepresentatives(rows.toReversed().map(r=>({...r,title:'changed',uploaded_at:'2030-01-01T00:00:00Z'}))),selectStudyRepresentatives(rows));
});

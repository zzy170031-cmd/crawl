import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../app/tasks.mjs';
import {createStudyReferenceReader} from '../app/study-references.mjs';
const game='海城',at='2026-10-20T00:00:00Z';
function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'study-references-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const folder=join(root,'study-public-references',hash(game));mkdirSync(folder,{recursive:true});
 const file=Buffer.from('controlled source bytes'),fileName='actual-page.png';writeFileSync(join(folder,fileName),file);
 const source={id:'page',kind:'image-page',game,read_at:at,source_id:'post',coverage:{page_index:1,page_count:1},file:{name:fileName,sha256:hash(file)}};
 const save=sources=>writeFileSync(join(folder,'pack.json'),JSON.stringify({version:'study-reference-pack-1',game,sources}));
 return {root,folder,file,source,save,read:createStudyReferenceReader({dataRoot:root})};
}
test('optional public pack resolves only same directory files with actual hash and maps images/text attachments',async t=>{
 const f=fixture(t);assert.deepEqual(await f.read({game:'absent'}),{sources:[],images:[],files:[]});
 const body='发行方原句。';writeFileSync(join(f.folder,'reference.txt'),body);
 f.save([f.source,{id:'publisher',kind:'publisher',game,read_at:at,content:body,content_sha256:hash(body),coverage:{kind:'saved_public_page'},file:{name:'reference.txt',sha256:hash(body)}}]);
 const out=await f.read({game});assert.equal(out.images.length,1);assert.equal(out.files.length,1);assert.equal(out.sources[0].file.path,join(f.folder,'actual-page.png'));assert.equal(out.sources[1].content,body);
 assert.equal((await f.read({game:' '+game+' '})).images.length,1);
});
test('absolute, traversal, private-path, symlink, hash-tampered attachments and source video kinds fail closed',async t=>{
 for(const name of ['/private/data.png','../secret.png','..\\secret.png','local-videos/file.png','C:\\private.png','CON.png']){
  const f=fixture(t);f.save([{...f.source,file:{...f.source.file,name}}]);await assert.rejects(f.read({game}),{code:'STUDY_REFERENCE_PATH_INVALID'});
 }
 const f=fixture(t);f.save([f.source]);writeFileSync(join(f.folder,'actual-page.png'),'tampered');await assert.rejects(f.read({game}),{code:'STUDY_REFERENCE_HASH_MISMATCH'});
 const g=fixture(t);writeFileSync(join(g.root,'secret.png'),g.file);symlinkSync(join(g.root,'secret.png'),join(g.folder,'link.png'));g.save([{...g.source,file:{...g.source.file,name:'link.png'}}]);await assert.rejects(g.read({game}),{code:'STUDY_REFERENCE_PATH_INVALID'});
 g.save([{...g.source,kind:'raw-asr'}]);await assert.rejects(g.read({game}),{code:'STUDY_REFERENCE_KIND_INVALID'});
});
test('wrong manifest game, oversize text, symlink pack and cancelled read do not import private data',async t=>{
 const f=fixture(t);writeFileSync(join(f.folder,'pack.json'),JSON.stringify({version:'study-reference-pack-1',game:'other',sources:[]}));await assert.rejects(f.read({game}),{code:'STUDY_REFERENCE_PACK_INVALID'});
 writeFileSync(join(f.folder,'pack.json'),' '.repeat(512*1024+1));await assert.rejects(f.read({game}),{code:'STUDY_REFERENCE_SIZE'});
 const g=fixture(t);writeFileSync(join(g.root,'private.json'),'{}');symlinkSync(join(g.root,'private.json'),join(g.folder,'pack.json'));await assert.rejects(g.read({game}),{code:'STUDY_REFERENCE_PATH_INVALID'});
 const c=new AbortController();c.abort();await assert.rejects(f.read({game,signal:c.signal}));
});

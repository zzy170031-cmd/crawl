import test from 'node:test';
import assert from 'node:assert/strict';
import {checkMediaTools,MediaToolsError} from '../app/media-tools.mjs';
test('check uses current process PATH through bounded executable calls, never shell/model/network',async()=>{
 const calls=[];const out=await checkMediaTools({run:async(name,args,options)=>{calls.push({name,args,options});return {stdout:name+' version controlled\n',stderr:''};}});assert.deepEqual(calls.map(x=>x.name),['ffmpeg','ffprobe']);for(const c of calls){assert.deepEqual(c.args,['-version']);assert.equal(c.options.timeout,5000);assert.equal(c.options.windowsHide,true);assert.equal(c.options.shell,undefined);}assert.equal(out.scope,'current_backend_process');assert.equal(out.paid_calls,0);
});
test('both missing tools are reported with finite diagnostics and no raw process secrets',async()=>{
 await assert.rejects(checkMediaTools({run:async()=>{throw Object.assign(Error('token=private /home/private'),{code:'ENOENT',stderr:'private'});}}),e=>{assert(e instanceof MediaToolsError);assert.equal(e.code,'MEDIA_TOOLS_UNAVAILABLE');assert.deepEqual(e.issues,[{tool:'ffmpeg',reason:'ENOENT'},{tool:'ffprobe',reason:'ENOENT'}]);assert.match(e.message,/PATH/);assert.match(e.message,/重开/);assert(!e.message.includes('private'));return true;});
});
test('single missing, invalid version output, permission and execution failures do not pass installation gate',async()=>{
 for(const mode of ['ffprobe','invalid','permissions','timeout','other']){
  await assert.rejects(checkMediaTools({run:async tool=>{if(mode==='ffprobe'&&tool==='ffmpeg')return {stdout:'ffmpeg version fixture'};if(mode==='invalid')return {stdout:'wrong program'};throw Object.assign(Error('private'),mode==='permissions'?{code:'EACCES'}:mode==='timeout'?{killed:true}:{code:mode==='other'?'secret-error':'ENOENT'});}}),e=>{assert(e instanceof MediaToolsError);assert(!e.message.includes('secret-error'));if(mode==='ffprobe')assert.equal(e.issues.length,1);return true;});
 }
});

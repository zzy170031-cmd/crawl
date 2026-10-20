import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync,symlinkSync,mkdirSync,truncateSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HostAssistant,HOST_PROTOCOL,HOST_LIMITS,hostSchema,validateHostOutput,hostEnvironment,hostArgs,hostEventAudit,terminateOwnedHost} from '../app/host-assistant.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJAAAAABJRU5ErkJggg==','base64');
const schema={type:'object',properties:{items:{type:'array',items:{type:'string',minLength:1},minItems:1,uniqueItems:true}},required:['items'],additionalProperties:false};
const good={items:['原字']};
const events=v=>[{type:'thread.started',thread_id:'test'},{type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(v)}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}];
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'host-module-')));t.after(()=>rmSync(root,{recursive:true,force:true}));const cli=join(root,'trusted-cli'),sourceRoot=join(root,'public');mkdirSync(sourceRoot);writeFileSync(cli,'test executable only; never run');const img=join(sourceRoot,'pic.png'),text=join(sourceRoot,'source.txt');writeFileSync(img,PNG);writeFileSync(text,'public source');return {root,cli,sourceRoot,img,text,images:[{path:img,sha256:sha(PNG)}],sources:[{path:text,sha256:sha('public source')}]};}
function fake(behavior){const calls=[],kills=[];return {calls,kills,spawn(file,args,options){const c=new EventEmitter();c.pid=567890;c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=s=>{kills.push(s);queueMicrotask(()=>c.emit('close',null,s));};let input='';c.stdin.on('data',x=>input+=x);c.stdin.on('finish',()=>{calls.push({file,args,options,input});queueMicrotask(()=>behavior({c,file,args,options,input}));});return c;},terminate(c,s,platform){kills.push(platform);c.kill(s);}};}
function respond({c,args},v=good,{exit=0,eventValue=v}={}){writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(v));const bytes=Buffer.from(events(eventValue).map(JSON.stringify).join('\n'));for(let i=0;i<bytes.length;i+=7)c.stdout.write(bytes.subarray(i,i+7));c.emit('close',exit,null);}
const env={HOME:'/existing-home',PATH:'/usr/bin:/bin',CODEX_HOME:'/existing-codex',REDFOX_API_KEY:'secret',OPENAI_API_KEY:'secret',CODEX_EXECUTOR_BRIDGE_URL:'secret'};
function client(f,m,extra={}){return new HostAssistant({cliPath:f.cli,allowedSourceRoot:f.sourceRoot,spawnImpl:m.spawn,terminateImpl:m.terminate,environment:env,graceMs:2,...extra});}

test('single image JSON exec binds copied PNG/input/schema/receipt without shell or model impersonation',async t=>{
 const f=fixture(t),m=fake(ctx=>{const {args,options,input}=ctx;assert.equal(options.shell,false);assert.equal(options.detached,true);assert(!options.cwd.startsWith(f.sourceRoot));assert.deepEqual(Object.keys(options.env).sort(),['CODEX_HOME','HOME','PATH']);assert(!args.includes('--model'));assert(args.includes('--ignore-user-config'));assert(args.includes('view_image'));assert(args.includes('read-only'));const image=args[args.indexOf('-i')+1];assert(image.startsWith(options.cwd));assert.notEqual(image,f.img);assert.equal(sha(readFileSync(image)),sha(PNG));const wire=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1]));assert.equal(wire.properties.items.uniqueItems,undefined);assert.equal(wire.properties.items.minItems,1);assert(input.includes('uniqueItems'));assert(input.includes('$(touch should-not-run); `echo nope`'));respond(ctx);});
 const r=await client(f,m).json('Read only',{text:'$(touch should-not-run); `echo nope`'},schema,{images:f.images,sources:f.sources,auditDir:join(f.root,'audit')});assert.deepEqual(r.value,good);assert.equal(m.calls.length,1);assert.equal(r.receipt.protocol,HOST_PROTOCOL);assert.equal(r.receipt.provider,'codex-host');assert.equal(r.receipt.model,null);assert.equal(r.receipt.owned_process_closed,true);assert.equal(r.receipt.tool_events,0);assert.equal(r.receipt.runner_retries,0);assert.equal(r.receipt.accepted,false);assert(!existsSync(m.calls[0].options.cwd));const request=JSON.parse(readFileSync(join(f.root,'audit/request.json')));assert.equal(request.sources[0].sha256,sha('public source'));assert.equal(request.images[0].sha256,sha(PNG));assert.deepEqual(request.removed_wire_constraints,['$.items.uniqueItems']);assert.equal(schema.properties.items.uniqueItems,true);
});

test('original schema constraints are actually enforced, including key-order independent uniqueItems',()=>{
 const copy=hostSchema(schema);assert.equal(copy.original.properties.items.uniqueItems,true);assert.equal(copy.wire.properties.items.uniqueItems,undefined);assert.throws(()=>validateHostOutput({items:['x','x']},copy.original),{code:'HOST_OUTPUT_SCHEMA'});assert.throws(()=>validateHostOutput({items:[]},copy.original));assert.throws(()=>validateHostOutput({items:['']},copy.original));
 const nested={type:'array',items:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b'],additionalProperties:false},uniqueItems:true};assert.throws(()=>validateHostOutput([{a:1,b:2},{b:2,a:1}],nested));
 for(const extra of [{$ref:'#/somewhere'},{pattern:'unsupported'},{enum:null}])assert.throws(()=>hostSchema({...schema,...extra}),{code:'HOST_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>validateHostOutput({items:['x'],extra:true},schema));assert.throws(()=>validateHostOutput(4,{type:'number',maximum:3}));assert.throws(()=>validateHostOutput(0.5,{type:'integer'}));
});

test('modified hashes, escaped paths, symlinks, non-images and oversized public sources never spawn',async t=>{
 const f=fixture(t);const outside=join(f.root,'outside.png');writeFileSync(outside,PNG);const link=join(f.sourceRoot,'link.png');symlinkSync(f.img,link);const textImage=join(f.sourceRoot,'fake.png');writeFileSync(textImage,'not image');
 let spawned=0;const m=fake(()=>{});m.spawn=()=>{spawned++;throw Error('must never run');};
 const bads=[{path:f.img,sha256:'0'.repeat(64)},{path:outside,sha256:sha(PNG)},{path:link,sha256:sha(PNG)},{path:textImage,sha256:sha('not image')}];
 for(let i=0;i<bads.length;i++){await assert.rejects(client(f,m).json('Read',{},schema,{images:[bads[i]],auditDir:join(f.root,'bad'+i)}));assert.equal(JSON.parse(readFileSync(join(f.root,'bad'+i,'receipt.json'))).exec_attempts,0);}assert.equal(spawned,0);const huge=join(f.sourceRoot,'large.txt');writeFileSync(huge,'');truncateSync(huge,HOST_LIMITS.source+1);await assert.rejects(client(f,m).json('Read',{},schema,{sources:[{path:huge,sha256:'0'.repeat(64)}],auditDir:join(f.root,'large')}),{code:'HOST_SOURCE_SIZE'});assert.equal(spawned,0);
});

test('tool/unknown/error events reject later final, bounded stderr is local only, no automatic retry',async t=>{
 for(const bad of [{type:'item.started',item:{type:'command_execution',command:'cat secret'}},{type:'approval.requested'},{type:'item.completed',item:{type:'error',message:'unknown warning'}},{type:'turn.failed'},{type:'unknown'}]){const f=fixture(t),m=fake(({c,args})=>{c.stderr.write('UPSTREAM_PRIVATE_SECRET');writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(good));c.stdout.write(JSON.stringify(bad)+'\n');c.stdout.write(events(good).map(JSON.stringify).join('\n')+'\n');});await assert.rejects(client(f,m).json('Read',{},schema,{auditDir:join(f.root,'audit')}),e=>{assert(!e.message.includes('SECRET'));assert.equal(e.receipt.owned_process_closed,true);return true;});assert.equal(m.calls.length,1);assert(existsSync(join(f.root,'audit/final.json')));assert(m.kills.includes('SIGTERM'));}
});

test('bad JSON, mismatched final, nonzero exit and local uniqueness failure remain failed receipts',async t=>{
 for(const mode of ['json','mismatch','exit','unique','no-completed']){const f=fixture(t),m=fake(ctx=>{if(mode==='json'){writeFileSync(ctx.args[ctx.args.indexOf('-o')+1],'{bad');ctx.c.stdout.write(events(good).map(JSON.stringify).join('\n')+'\n');ctx.c.emit('close',0,null);}else if(mode==='no-completed'){writeFileSync(ctx.args[ctx.args.indexOf('-o')+1],JSON.stringify(good));ctx.c.stdout.write(events(good).slice(0,-1).map(JSON.stringify).join('\n')+'\n');ctx.c.emit('close',0,null);}else respond(ctx,mode==='unique'?{items:['x','x']}:good,{exit:mode==='exit'?1:0,eventValue:mode==='mismatch'?{items:['different']}:mode==='unique'?{items:['x','x']}:good});});await assert.rejects(client(f,m).json('Read',{},schema,{auditDir:join(f.root,'audit')}));assert.equal(m.calls.length,1);const r=JSON.parse(readFileSync(join(f.root,'audit/receipt.json')));assert.equal(r.status,'failed');assert.equal(r.exec_attempts,1);}
});

test('cancellation before spawn is zero-exec; active cancellation and timeout only terminate owned process and await close',async t=>{
 const f=fixture(t),pre=new AbortController();pre.abort();const m=fake(()=>{});await assert.rejects(client(f,m).json('Read',{},schema,{auditDir:join(f.root,'pre'),signal:pre.signal}),{code:'HOST_CANCELLED'});assert.equal(m.calls.length,0);
 for(const mode of ['abort','timeout']){const g=fixture(t),ac=new AbortController(),n=fake(()=>{if(mode==='abort')ac.abort();});await assert.rejects(client(g,n,{timeoutMs:15}).json('Read',{},schema,{auditDir:join(g.root,'audit'),signal:ac.signal}),e=>{assert.equal(e.code,mode==='abort'?'HOST_CANCELLED':'HOST_TIMEOUT');assert.equal(e.receipt.owned_process_closed,true);return true;});assert.equal(n.calls.length,1);assert(n.kills.includes('SIGTERM'));}
});

test('output cap and truncated events fail closed; output folder cannot be reused',async t=>{
 const f=fixture(t),m=fake(({c})=>c.stdout.write(Buffer.alloc(HOST_LIMITS.stdout+1,65)));await assert.rejects(client(f,m).json('Read',{},schema,{auditDir:join(f.root,'audit')}),{code:'HOST_OUTPUT_SIZE'});assert.equal(readFileSync(join(f.root,'audit/events.jsonl')).length,HOST_LIMITS.stdout);await assert.rejects(client(f,m).json('Read',{},schema,{auditDir:join(f.root,'audit')}),{code:'HOST_AUDIT_PATH_INVALID'});assert.equal(m.calls.length,1);
 const a=hostEventAudit();a.push(Buffer.from('{"type":'));assert.throws(()=>a.finish(),{code:'HOST_EVENT_JSON'});
});

test('Windows path and argv/env support is shell-free and mock-only, no cmd/bat fallback',()=>{
 const e=hostEnvironment({PATH:'C:\\Windows',USERPROFILE:'C:\\Users\\x',SystemRoot:'C:\\Windows',CODEX_HOME:'C:\\Users\\x\\.codex',REDFOX_API_KEY:'no',CODEX_EXECUTOR_BRIDGE_URL:'no'},'win32');assert.equal(e.USERPROFILE,'C:\\Users\\x');assert(!('REDFOX_API_KEY'in e));const args=hostArgs('C:\\Temp\\isolated','C:\\Temp\\schema.json','C:\\Temp\\out.json',['C:\\Temp\\picture with space.png']);assert.equal(args[args.indexOf('-i')+1],'C:\\Temp\\picture with space.png');assert.throws(()=>new HostAssistant({cliPath:'C:\\tool.cmd',allowedSourceRoot:process.cwd(),platform:'win32',environment:e}),{code:'HOST_CLI_PATH_INVALID'});
});

test('owned process termination targets only its numeric pid/tree: macOS and Windows mock, not live verification',()=>{
 const calls=[];terminateOwnedHost({pid:4567},'SIGTERM','darwin',{}, {kill:(...args)=>calls.push(args)});assert.deepEqual(calls,[[-4567,'SIGTERM']]);
 const spawns=[];terminateOwnedHost({pid:9876},'SIGKILL','win32',{SystemRoot:'C:\\Windows'}, {spawnImpl:(...args)=>{spawns.push(args);return new EventEmitter();}});assert.equal(spawns[0][0],'C:\\Windows\\System32\\taskkill.exe');assert.deepEqual(spawns[0][1],['/PID','9876','/T','/F']);assert.equal(spawns[0][2].shell,false);
});


test('real synthetic JPEG bytes under .png attach unchanged as .jpg with actual audited MIME and dimensions',async t=>{
 const f=fixture(t),jpg=join(f.sourceRoot,'cua-named.png');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=32x24:r=1','-frames:v','1','-c:v','mjpeg','-f','image2',jpg],{shell:false,timeout:10000,stdio:'pipe'});
 const bytes=readFileSync(jpg);assert.equal(bytes.readUInt16BE(0),0xffd8);
 const m=fake(ctx=>{const path=ctx.args[ctx.args.indexOf('-i')+1];assert(path.endsWith('.jpg'));assert.deepEqual(readFileSync(path),bytes);respond(ctx);});
 const result=await client(f,m).json('Read',{},schema,{images:[{path:jpg,sha256:sha(bytes)}],auditDir:join(f.root,'jpeg')});
 assert.equal(result.receipt.exec_attempts,1);const bound=JSON.parse(readFileSync(join(f.root,'jpeg/request.json'))).images[0];assert.equal(bound.mime,'image/jpeg');assert.equal(bound.format,'jpeg');assert.equal(bound.width,32);assert.equal(bound.height,24);assert.equal(bound.sha256,sha(bytes));
 // A misleading JPEG extension does not change genuine PNG bytes or their suffix.
 const png=join(f.sourceRoot,'actually-png.jpg');writeFileSync(png,PNG);const n=fake(ctx=>{assert(ctx.args[ctx.args.indexOf('-i')+1].endsWith('.png'));respond(ctx);});
 await client(f,n).json('Read',{},schema,{images:[{path:png,sha256:sha(PNG)}],auditDir:join(f.root,'png')});assert.equal(JSON.parse(readFileSync(join(f.root,'png/request.json'))).images[0].mime,'image/png');
});

test('truncated JPEG, broken segment length, missing SOF and empty dimensions reject before any exec',async t=>{
 const f=fixture(t),path=join(f.sourceRoot,'source.jpg');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=16x16:r=1','-frames:v','1','-c:v','mjpeg','-f','image2',path],{shell:false,timeout:10000,stdio:'pipe'});
 const valid=readFileSync(path),sof=valid.indexOf(Buffer.from([255,192]));assert(sof>0);const badLength=Buffer.from(valid);badLength.writeUInt16BE(65535,4);const empty=Buffer.from(valid);empty.writeUInt16BE(0,sof+7);const sofEnd=sof+2+valid.readUInt16BE(sof+2);
 const inputs=[valid.subarray(0,valid.length-2),badLength,Buffer.concat([valid.subarray(0,sof),valid.subarray(sofEnd)]),empty,Buffer.from([255,216,255,217]),Buffer.concat([valid,Buffer.from([0])])];
 let calls=0;const m=fake(()=>{});m.spawn=()=>{calls++;throw Error('must not spawn');};
 for(let i=0;i<inputs.length;i++){const p=join(f.sourceRoot,'invalid-'+i+'.png');writeFileSync(p,inputs[i]);const auditDir=join(f.root,'badjpeg'+i);await assert.rejects(client(f,m).json('Read',{},schema,{images:[{path:p,sha256:sha(inputs[i])}],auditDir}),{code:'HOST_IMAGE_INVALID'});assert.equal(JSON.parse(readFileSync(join(auditDir,'receipt.json'))).exec_attempts,0);}
 assert.equal(calls,0);
});

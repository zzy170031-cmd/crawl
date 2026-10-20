// Dedicated region verifier. Existing single-sheet delivery verifier is unchanged.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {config} from './config.mjs';
const exec=promisify(execFile);
export async function verifyTemplateRegion(client,fileId,sheetName,region,signal){
 const task=await client.call('manage_export_file',{file_id:fileId},{signal});if(typeof task?.task_id!=='string')throw Error('TEMPLATE_EXPORT_INVALID');let url;
 for(let i=0;i<12;i++){signal?.throwIfAborted();await delay(5000,undefined,{signal});const p=await client.call('manage_export_progress',{task_id:task.task_id},{signal});if(p.progress===100){url=p.file_url;break;}}
 if(!url)throw Error('TEMPLATE_EXPORT_INCOMPLETE');const u=new URL(url);
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!['qq.com','qcloud.com','myqcloud.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw Error('TEMPLATE_EXPORT_DOMAIN');
 const response=await fetch(u,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(45000),...(signal?[signal]:[])])});if(!response.ok)throw Error('TEMPLATE_EXPORT_FAILED');let size=0;const chunks=[];
 for await(const chunk of response.body){size+=chunk.length;if(size>32*1024*1024)throw Error('TEMPLATE_EXPORT_LIMIT');chunks.push(chunk);}
 const dir=await mkdtemp(join(tmpdir(),'template-export-'));
 try{await writeFile(join(dir,'book.xlsx'),Buffer.concat(chunks));await writeFile(join(dir,'expected.json'),JSON.stringify({sheet_name:sheetName,...region}));const result=await exec(config.python,[fileURLToPath(new URL('./template-verify.py',import.meta.url)),join(dir,'book.xlsx'),join(dir,'expected.json')],{timeout:30000,windowsHide:true,signal,maxBuffer:1024*1024});return JSON.parse(result.stdout);}
 finally{await rm(dir,{recursive:true,force:true});}
}

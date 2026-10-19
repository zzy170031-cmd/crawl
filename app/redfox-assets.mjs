import {readFile,writeFile,mkdir,copyFile,rename,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {dataDir} from './config.mjs';
import {hash} from './tasks.mjs';
import {parseRedfoxMediaReceipt} from './redfox-media-source.mjs';
const exec=promisify(execFile), MAX_BYTES=128*1024*1024;
export class RedfoxAssetError extends Error {constructor(message){super(message);this.code='MEDIA_ASSET_REQUIRED';}}
function identity(row){
 if(row?.provider!=='redfox'||row.kind!=='video'||typeof row.source_id!=='string'||!/^\d{10,25}$/.test(row.source_id)||row.source_url!==`https://www.douyin.com/video/${row.source_id}`||!row.collection_request_id)
  throw new RedfoxAssetError('原片必须绑定已采集的红狐作品与查询批次');
 return row.source_id;
}
async function bytes(path){const size=(await stat(path)).size;if(size<1||size>MAX_BYTES)throw new RedfoxAssetError('原片文件大小超出可处理范围');return readFile(path);}
export function createRedfoxAssetStore({folder=join(dataDir,'media'),probe=async path=>JSON.parse((await exec('ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{timeout:20000,maxBuffer:1024*1024,windowsHide:true})).stdout)}={}){
 function paths(row){const id=identity(row),dir=join(folder,id);return {dir,source:join(dir,'redfox-source.mp4'),manifest:join(dir,'redfox-asset.json')};}
 async function read(row){
  const p=paths(row);let manifest,body;
  try {manifest=JSON.parse(await readFile(p.manifest,'utf8'));body=await bytes(p.source);}catch(e){if(e.code==='ENOENT')throw new RedfoxAssetError('这条视频尚未取得原片；需要单独授权解析预算，不会自动收费或等待聊天回填');throw e;}
  if(manifest.provider!=='redfox'||manifest.source_id!==row.source_id||manifest.url!==row.source_url||manifest.source_sha256!==hash(body)||manifest.bytes!==body.length||manifest.status!=='av_readable')
   throw new RedfoxAssetError('保存的原片与身份或文件指纹不符，未使用旧文件');
  if(row.duration_ms!=null&&Math.abs(manifest.duration-row.duration_ms/1000)>1)
   throw new RedfoxAssetError('保存的原片时长与当前查询不符，请核验来源');
  return {...manifest,source_path:p.source,current_collection_request_id:row.collection_request_id};
 }
 // Local ingestion does not resolve, fetch or charge. Existing assets are never
 // replaced implicitly. The caller supplies a previously acquired source file.
 async function importLocal(row,{sourcePath,response,startedAt,receivedAt,signal}={}){
  signal?.throwIfAborted();const p=paths(row);
  const receipt=parseRedfoxMediaReceipt(response,row,{startedAt,receivedAt});
  // Some real replies supply the full work caption in title and leave desc
  // empty. Never use title to override a conflicting nonempty description.
  const metadataMatchField=receipt.description?.trim()?'description':'title';
  if(!row.title?.trim()||receipt[metadataMatchField]?.trim()!==row.title.trim())throw new RedfoxAssetError('解析描述或标题与来源标题无法对应，未入库');
  const body=await bytes(sourcePath),digest=hash(body),info=await probe(sourcePath);
  const duration=Number(info.format?.duration),types=(info.streams||[]).map(s=>s.codec_type);
  if(!Number.isFinite(duration)||duration<1||duration>900||!types.includes('video')||!types.includes('audio'))throw new RedfoxAssetError('原片缺少可读音画或超出时长范围');
  if(row.duration_ms!=null&&Math.abs(duration-row.duration_ms/1000)>1)throw new RedfoxAssetError('实际原片时长与来源记录不一致');
  signal?.throwIfAborted();await mkdir(p.dir,{recursive:true});
  try {const existing=await read(row);if(existing.source_sha256!==digest)throw new RedfoxAssetError('已有不同原片，未覆盖');return existing;}catch(e){if(!(e instanceof RedfoxAssetError)||!e.message.startsWith('这条视频尚未取得'))throw e;}
  const manifest={provider:'redfox',source_id:row.source_id,url:row.source_url,title:row.title,
   collection_request_id:row.collection_request_id,source_sha256:digest,bytes:body.length,duration,
   status:'av_readable',observed_at:receivedAt,imported_at:new Date().toISOString(),
   source_metadata_origin:'redfox_resolver_and_saved_query',metadata_match_field:metadataMatchField,resolver_receipt:receipt,
   coverage:'原片文件与来源标题或描述、时长一致；已检测音视频流，尚未完成内容理解'};
  const temp=p.manifest+'.'+randomUUID()+'.tmp';
  let ownsSource=false;
  try {
   // COPYFILE_EXCL: concurrent imports cannot overwrite another asset.
   await copyFile(sourcePath,p.source,1);ownsSource=true;
   if(hash(await bytes(p.source))!==digest)throw new RedfoxAssetError('原片在复制过程中发生变化，未入库');
   signal?.throwIfAborted();await writeFile(temp,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
   await rename(temp,p.manifest);return read(row);
  } catch(e){await unlink(temp).catch(()=>{});if(ownsSource)await unlink(p.source).catch(()=>{});throw e;}
 }
 return {read,importLocal};
}
export const redfoxAssets=createRedfoxAssetStore();

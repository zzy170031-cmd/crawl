import {hash} from './tasks.mjs';

const normalized = value => String(value || '').normalize('NFKC').trim().toLowerCase();
// Publisher-authored introductory text, not proof of current gameplay rules.
// No arbitrary URL fetches, paid search, login session or chat-side bridge.
export async function gameReference(game, {signal, fetchImpl = fetch, now = () => new Date()} = {}) {
  const url = new URL('https://itunes.apple.com/search');
  url.search = new URLSearchParams({term:game,country:'cn',entity:'software',limit:'10'});
  const response = await fetchImpl(url, {redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])])});
  if (!response.ok) throw Error('公开游戏资料读取失败 HTTP '+response.status);
  // Bound streamed responses before parsing. Never follow links from source text.
  let text='', bytes=0;
  if (response.body) {
    const decoder=new TextDecoder();
    for await (const chunk of response.body) {
      bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('游戏资料超过读取上限');
      text+=decoder.decode(chunk,{stream:true});
    }
    text+=decoder.decode();
  } else text=await response.text();
  if(Buffer.byteLength(text)>2*1024*1024)throw Error('游戏资料超过读取上限');
  const data=JSON.parse(text);
  const matches=(data.results||[]).filter(x=>normalized(x.trackName)===normalized(game)&&x.kind==='software'&&x.primaryGenreName==='Games');
  if(matches.length!==1) return [];
  const row=matches[0], link=new URL(row.trackViewUrl);
  if(link.protocol!=='https:'||link.hostname!=='apps.apple.com'||!Number.isSafeInteger(row.trackId)||!row.artistName||typeof row.description!=='string'||!row.description.trim())throw Error('游戏资料身份未通过检查');
  const content=row.description.slice(0,16000);
  return [{id:'web:appstore:'+row.trackId,kind:'web',game,title:row.trackName,url:link.href,publisher:row.artistName,
    content,content_sha256:hash(content),read_at:now().toISOString(),version:row.version||null,
    source_type:'publisher_store_description',scope:'中国区同名游戏的发行方商店介绍；不是实机验证，不证明当前数值、具体配队、活动或隐藏规则'}];
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedfoxGameSource} from '../app/redfox-game-source.mjs';
import {createRedfoxHotspotSource} from '../app/redfox-hotspot-source.mjs';
import {RedfoxSourceError} from '../app/redfox-error.mjs';
const game={provider:'redfox',purpose:'game-research',keyword:'测试游戏',hours:168,sort:'likes',limit:30};
const hotspot={provider:'redfox',purpose:'hotspots',board:'redfox_daily_hot',category:'all',hours:168,keyword:''};
for(const [name,create,payload] of [['game',createRedfoxGameSource,game],['hotspot',createRedfoxHotspotSource,hotspot]]) {
 test(`${name} diagnostics classify transport safely with one attempt`,async()=>{
  for(const [code,expected] of [['ECONNRESET','ECONNRESET'],['secret-credential','NETWORK_OR_RESPONSE_ERROR']]) {
   let calls=0;
   const source=create({apiKey:'fixture-secret',fetch:async()=>{calls++;throw Object.assign(Error('secret-credential'),{cause:{code}});}});
   await assert.rejects(source.collect(payload),error=>error instanceof RedfoxSourceError && error.message.includes(expected) && !error.message.includes('secret-credential'));
   assert.equal(calls,1);
  }
 });
 test(`${name} invalid JSON has a local diagnostic, never upstream body`,async()=>{
  const source=create({apiKey:'fixture-secret',fetch:async()=>({status:200,text:async()=>'<html>private-upstream-text</html>'})});
  await assert.rejects(source.collect(payload),error=>error instanceof RedfoxSourceError && error.message.includes('JSON') && !error.message.includes('private-upstream'));
 });
}

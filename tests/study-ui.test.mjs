import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../app/public/app.js',import.meta.url),'utf8');
const profile=code.slice(code.indexOf('async function loadProfile()'),code.indexOf('async function learning()'));
test('network dossier reads only its explicit source store and never falls back to a legacy local profile',async()=>{
 const calls=[];const ctx={URLSearchParams,currentProfile:{learning_source:'local'},gameGeneration:1,game:()=> '率土之滨',learningSource:()=> 'network',renderGameState(){},renderComposer(){},api:async path=>{calls.push(path);assert(path.startsWith('/api/game-study-profile?'));return null;}};
 vm.runInNewContext(profile,ctx);await ctx.loadProfile();assert.equal(ctx.currentProfile,null);assert.equal(calls.length,1);
 ctx.learningSource=()=> 'local';await ctx.loadProfile();assert.equal(ctx.currentProfile,null);assert.equal(calls.length,1,'deferred local learning must not read a network profile');
});
test('late dossier response cannot replace a different selected game or source',async()=>{
 for(const next of ['game','source']){
  let target='率土之滨',source='network',release;const pending=new Promise(r=>release=r),ctx={URLSearchParams,currentProfile:null,gameGeneration:1,game:()=>target,learningSource:()=>source,renderGameState(){},renderComposer(){},api:()=>pending};
  vm.runInNewContext(profile,ctx);const read=ctx.loadProfile();if(next==='game')target='星际猎人';else source='local';release({game:'率土之滨',learning_source:'network'});await read;assert.equal(ctx.currentProfile,null);
 }
});

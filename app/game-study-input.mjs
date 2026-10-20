import {normalizeLocalGame} from './local-videos.mjs';
import {buildGameStudyLibrary} from './game-study-library.mjs';
function invalid(){throw Object.assign(Error('请选择联网视频或本地视频，并指定目标游戏'),{code:'GAME_STUDY_INPUT_INVALID'});}
// Dependencies are server-owned stores. This endpoint checks saved inputs only:
// it never accepts client candidate rows/paths and never schedules learning.
export function createGameStudyInput({getCollection,listUploads,readOnline,openLocal}){
 return async function prepare(input,{signal}={}){
  if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='game,learning_source'||!['network','local'].includes(input.learning_source))invalid();
  let game;try{game=normalizeLocalGame(input.game);}catch{invalid();}
  const learning_source=input.learning_source;signal?.throwIfAborted();
  let library;
  if(learning_source==='network'){
   if(typeof getCollection!=='function'||typeof readOnline!=='function')invalid();
   const collection=await getCollection(game);signal?.throwIfAborted();
   if(!collection)throw Object.assign(Error('没有可核验的当前游戏查询，请先手动查询联网视频'),{code:'GAME_STUDY_COLLECTION_REQUIRED'});
   library=await buildGameStudyLibrary({game,collection,uploads:[],readOnline,signal});
  }else{
   if(typeof listUploads!=='function'||typeof openLocal!=='function')invalid();
   const uploads=await listUploads(game);signal?.throwIfAborted();
   library=await buildGameStudyLibrary({game,uploads,openLocal,signal});
  }
  signal?.throwIfAborted();
  // Explicit public projection: no private items, media paths or reader receipts.
  return {version:library.version,game,learning_source,status:library.status,accepted:false,
   records:library.records,excluded:library.excluded,binding:library.binding,coverage:library.coverage,
   action:'input_check_only',task_created:false,learning_started:false};
 };
}

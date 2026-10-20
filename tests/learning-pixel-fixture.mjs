// Pure controlled positive pixel receipts for the historical selector/contract
// unit tests. These are not real image acceptance; filesystem/wire tests live
// in learning-pixel-witness.test.mjs and root owns independent actual evals.
import {hash} from '../app/tasks.mjs';
import {bindPixelWitness,pixelWitnessProtocol,pixelWitnessKey,LEARNING_PIXEL_WITNESS_VERSION,LEARNING_PIXEL_WITNESS_MODEL,LEARNING_PIXEL_WITNESS_OPTIONS,LEARNING_PIXEL_WITNESS_PROMPT,LEARNING_PIXEL_WITNESS_CODE_SHA256} from '../app/learning-pixel-witness.mjs';
export const pixelFixtureParameters={version:'learning-model-roles-2',role:'vision',identity:LEARNING_PIXEL_WITNESS_MODEL,runtime:{engine:'ollama',version:'0.40.6'},inference:{request_version:'ollama-json-2',...LEARNING_PIXEL_WITNESS_OPTIONS,effective_prefill:false,temperature:0.2}};
export function pixelFixtureReadings(readings){return readings.map(r=>({...r,frame_file:r.frame_file||`frame-${r.time}.png`,frame_sha256:r.frame_sha256||hash('fixture-png:'+r.time),timestamp_method:r.timestamp_method||'legacy_requested_seek_time_not_pts_verified'}));}
export function pixelFixture(units,{sourceId,mediaHash,readings},rawOverride){
 const receipts=[];
 for(const visualId of [...new Set(units.map(u=>u.visual_id))]){
  const selected=units.filter(u=>u.visual_id===visualId),r=readings.find(r=>r.time===selected[0].time),protocol=pixelWitnessProtocol([...new Set(selected.filter(u=>u.object_quote!==null).map(u=>u.object_quote))]),sourceHash=hash('fixture-mp4');
  const frame={visual_id:visualId,time:r.time,file:r.frame_file,frame_sha256:r.frame_sha256,timestamp_method:r.timestamp_method,origin:{kind:'base_manifest',source_id:sourceId,source_sha256:sourceHash,file:r.frame_file,sha256:r.frame_sha256,actual_time:r.time}};
  const descriptor={version:LEARNING_PIXEL_WITNESS_VERSION,source_id:sourceId,media_hash:mediaHash,source_sha256:sourceHash,frame,units:selected,model_identity:LEARNING_PIXEL_WITNESS_MODEL,inference_parameters:pixelFixtureParameters,prompt:LEARNING_PIXEL_WITNESS_PROMPT,prompt_sha256:hash(LEARNING_PIXEL_WITNESS_PROMPT),...protocol,input_sha256:hash(protocol.input),schema_sha256:hash(protocol.schema),code_sha256:LEARNING_PIXEL_WITNESS_CODE_SHA256};
  const raw=rawOverride?.(visualId,protocol)||{has_structured_game_data_panel:'present',has_scene_or_character_art:'present',panel_evidence:['受控测试面板'],quotes:Object.fromEntries(protocol.input.quotes.map(q=>[q.id,{presence:'visible',role:'entity_name'}]))};
  receipts.push({checkpoint:pixelWitnessKey(descriptor)+':attempt:initial',descriptor,status:'valid',raw_output:raw,raw_sha256:hash(raw),wire:{checkpoint:pixelWitnessKey(descriptor)+':attempt:initial:wire',attempt_checkpoint:pixelWitnessKey(descriptor)+':attempt:initial',source_id:sourceId,frame_sha256:frame.frame_sha256,sha256:hash(raw),status:200,complete:true,truncated:false}});
 }
 return bindPixelWitness(receipts,units,{sourceId,mediaHash});
}

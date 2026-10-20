import {candidateLearningContract,validateLearningTaskBinding,validateLearningProfile} from './learning-contract.mjs';
import {GAME_STUDY_VERSION} from './game-study.mjs';
// Limited dossier entry recovered after real-media, UI, restart and independent
// review. This does not release legacy learning, creative work or delivery.
const NETWORK_STUDY_RECOVERY_ENABLED=true;
export const networkStudyEnabled=()=>NETWORK_STUDY_RECOVERY_ENABLED;
// Rate-game A/B candidates and exact four-tab writes passed bounded real-media,
// independent content, remote read-back and restart/repeat acceptance. Legacy
// worker paths stay held; these entries retain explicit candidate/plan review.
const CREATIVE_CANDIDATE_RECOVERY_ENABLED=true;
export const creativeCandidateEnabled=()=>CREATIVE_CANDIDATE_RECOVERY_ENABLED;
export const creativeCandidateCapability=()=>({enabled:CREATIVE_CANDIDATE_RECOVERY_ENABLED,output:'creative_candidate',semantic_acceptance:false,automatic_paid_collection:false,delivery_enabled:false});
const REVIEWED_CANDIDATE_DELIVERY_ENABLED=true;
export const reviewedCandidateDeliveryEnabled=()=>REVIEWED_CANDIDATE_DELIVERY_ENABLED;
export const reviewedCandidateDeliveryCapability=()=>({enabled:REVIEWED_CANDIDATE_DELIVERY_ENABLED,pipeline:'four-template-delivery-1',requires_exact_draft_confirmation:true,requires_template_plan_confirmation:true,template_layout:true,automatic_resume:false});
export const networkStudyCapability=()=>({enabled:NETWORK_STUDY_RECOVERY_ENABLED,pipeline:GAME_STUDY_VERSION,output:'candidate_dossier',semantic_acceptance:false,uses_existing_host_account_network:true,automatic_paid_collection:false});
// Recovery is released by capability after real-media review, never by settings.
export const LEARNING_PIPELINE='game-learning-extractive-2';
const LEARNING_RECOVERY_ENABLED=false; // Candidate metadata is not release acceptance.
export function qualityCapabilities(){return {learning:{enabled:LEARNING_RECOVERY_ENABLED&&candidateLearningContract().accepted,pipeline:LEARNING_PIPELINE,candidate_contract:candidateLearningContract()},study:networkStudyCapability(),creative_candidate:creativeCandidateCapability(),reviewed_candidate_delivery:reviewedCandidateDeliveryCapability(),creation:{enabled:false},delivery:{enabled:false}};}
export function qualityExecutionAllowed(capability,payload={}){
  return capability==='learn'&&LEARNING_RECOVERY_ENABLED&&candidateLearningContract().accepted&&validateLearningTaskBinding(payload).valid;
}
// Server-owned hold after real summary fidelity probes failed.
// Deliberately not configurable by environment, client input, saved settings or models.
const HOLD=Object.freeze({
  active:true,
  code:'EXPERIMENTAL_QUALITY_HOLD',
  reason:'摘要忠实性尚未通过真实负例验收，学习结果仅供实验核验，暂停新批次学习、创作与文档产出',
  policy_version:'experimental-summary-quality-hold-1',
});
export function experimentalQualityHold(){return HOLD;}
export function projectQualityHeldProfile(profile){
  if(!profile)return profile;
  return {...profile,status:'needs_input',experimental_quality_hold:HOLD,candidate_contract_check:validateLearningProfile(profile),
    blocking_gaps:[...new Set([...(Array.isArray(profile.blocking_gaps)?profile.blocking_gaps:[]),HOLD.reason])]};
}
export function qualityHoldResponse(profile){
  return {error:HOLD.reason,code:HOLD.code,experimental_quality_hold:HOLD,
    ...(profile?{profile:projectQualityHeldProfile(profile)}:{})};
}
export function assertQualityExecutionAllowed(capability,payload){
  if(qualityExecutionAllowed(capability,payload))return;
  const error=Error(HOLD.reason);error.code=HOLD.code;throw error;
}

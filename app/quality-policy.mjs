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
  return {...profile,status:'needs_input',experimental_quality_hold:HOLD,
    blocking_gaps:[...new Set([...(Array.isArray(profile.blocking_gaps)?profile.blocking_gaps:[]),HOLD.reason])]};
}
export function qualityHoldResponse(profile){
  return {error:HOLD.reason,code:HOLD.code,experimental_quality_hold:HOLD,
    ...(profile?{profile:projectQualityHeldProfile(profile)}:{})};
}
export function assertQualityExecutionAllowed(){
  const error=Error(HOLD.reason);error.code=HOLD.code;throw error;
}

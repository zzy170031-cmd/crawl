// The bridge supplies normalized search payloads. Compare every payload field;
// never infer that another game, time window, sort or purpose is interchangeable.
export function collectionRecoveryKey(payload) {
  return JSON.stringify(Object.fromEntries(Object.keys(payload || {}).sort().map(key => [key, payload[key]])));
}

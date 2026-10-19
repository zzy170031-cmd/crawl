// Source failure identity is shared by the worker, persisted bridge and API
// projection. Never infer a new identity from free-form or nested error text.
const sourceCodes = new Set([
  "LOGIN_REQUIRED", "VERIFICATION_REQUIRED", "ACCESS_RESTRICTED",
  "SOURCE_TIMEOUT", "SOURCE_RESPONSE_TIMEOUT", "SOURCE_UNAVAILABLE",
  "MEDIA_UNAVAILABLE", "SOURCE_FAILED", "OPERATION_CLEANUP_FAILED",
  "CLOSE_TIMEOUT",
]);
export const isSourceErrorCode = code => typeof code === "string" && sourceCodes.has(code);
export const normalizeSourceErrorCode = code => isSourceErrorCode(code) ? code : "SOURCE_FAILED";
export function persistedSourceErrorCode(error) {
  if (typeof error !== "string") return null;
  const prefix = /^([A-Z_]+):(?:\s|$)/.exec(error)?.[1];
  return isSourceErrorCode(prefix) ? prefix : null;
}

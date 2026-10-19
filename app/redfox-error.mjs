// Only locally authored adapter diagnostics may reach public status. Transport
// and upstream message strings are never passed into this class.
export class RedfoxSourceError extends Error {
  constructor(message, code = 'SOURCE_FAILED') {
    super(message); this.code = code;
  }
}

// Never expose upstream error.message, URLs or headers. A finite diagnostic
// vocabulary is sufficient to distinguish transient transport from bad JSON.
export function redfoxTransportDiagnostic(error) {
  const allowed = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  const code = error?.cause?.code ?? error?.code;
  return allowed.has(code) ? code : "NETWORK_OR_RESPONSE_ERROR";
}

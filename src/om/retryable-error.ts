/**
 * Shared retryable-error regex and detection function.
 *
 * Shared by compaction retries and consolidation diagnostics.
 */

/** Regex matching retryable API error messages. */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** Check whether an error string or Error indicates a retryable error. */
export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return RETRYABLE_ERROR_RE.test(message);
}

/**
 * Deterministic client errors: retrying the same model cannot succeed without
 * a config/header fix (missing provider-required headers, bad credentials,
 * unknown model, rejected payload). Unlike transient `isRetryableError`
 * failures (same model, later), these generally need a config/header fix.
 * Both kinds advance the worker fallback chain within the current stage.
 *
 * Anchored on explicit signals to avoid false positives from token counts
 * (e.g. "~401-token chunk") — framed codes match with an error framing
 * (`HTTP 400`, `status: 404`, `error: 422`), while bare codes (`403
 * RegionError`, `400 Bad Request`) only match alongside an error signal word
 * somewhere in the message. The preceding-character guard keeps `~401-token`
 * style counts out even when an error word is nearby.
 */
export const DETERMINISTIC_ERROR_RE =
  /MissingSessionID|missing.?session|invalid.?api.?key|unauthorized|HTTP\s+40[014]\b|HTTP\s+4(?:03|22)\b|status\s*:?\s*40[014]\b|status\s*:?\s*4(?:03|22)\b|error\s*:?\s*40[014]\b|error\s*:?\s*4(?:03|22)\b/i;

/** Bare 4xx status in status position (start, or after whitespace/punctuation). */
const BARE_DETERMINISTIC_CODE_RE = /(?:^|[\s:([{="'])(40[014]|403|422)\b/;

/** Error signal word required alongside a bare code (substring match). */
const DETERMINISTIC_SIGNAL_RE =
  /error|fail|missing|forbidden|denied|bad request|not found|unauthorized|invalid/i;

/** Check whether an error is a deterministic client error (see above). */
export function isDeterministicError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  if (DETERMINISTIC_ERROR_RE.test(message)) return true;
  return BARE_DETERMINISTIC_CODE_RE.test(message) && DETERMINISTIC_SIGNAL_RE.test(message);
}

/** Detect Pi's "extension ctx is stale" error from session replacement/reload.
 *  These are lifecycle errors, not worker-model failures. */
export function isStaleExtensionContextError(error: unknown): boolean {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    message = String((error as { message: unknown }).message);
  } else {
    message = String(error || "");
  }
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}

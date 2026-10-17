/** Host codes that mean the response arrived and the action was not lost. */
const CONFIRMED_TERMINAL = new Set([
  "EXECUTION_FAILED",
  "INVALID_STATE",
  "REVISION_CONFLICT",
  "REVIEW_REQUIRED",
  "REVIEW_EXPIRED",
  "REVIEW_INCOMPLETE",
  "INVALID_DECISION",
  "NOT_FOUND",
  "BUSY",
  "APPROVAL_MISMATCH",
  "EXPLICIT_REVIEW_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "CAPACITY_EXCEEDED",
  "INVALID_REQUEST",
  "WEB_CREDENTIALS_REQUIRED",
  "WEB_MODEL_NOT_CONFIGURED",
  "WEB_PAIRING_REQUIRED",
]);

/**
 * True when the browser cannot tell whether the host applied the action.
 * A confirmed terminal code, including EXECUTION_FAILED, must not lock the session.
 * Lost sockets and non-JSON bodies stay unconfirmed and are never replayed.
 */
export function mutationUnconfirmed(code: string): boolean {
  if (code === "WEB_REQUEST_FAILED") return true;
  if (code.startsWith("The provider stream failed:")) return false;
  if (CONFIRMED_TERMINAL.has(code)) return false;
  return true;
}

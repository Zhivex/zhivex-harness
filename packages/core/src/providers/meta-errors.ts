import { ProviderHTTPError } from "@zhivex-ai/core/provider";

/** Persist only fixed diagnostic labels, never provider messages or payloads. */
export function annotateMetaRequestError(error: unknown): never {
  if (error instanceof ProviderHTTPError) {
    let reason = "reason unavailable";
    try {
      const detail = JSON.parse(typeof error.responseBody === "string" ? error.responseBody : "").error;
      const message = typeof detail?.message === "string" ? detail.message : "";
      if (detail?.type === "invalid_request_error" && /response/i.test(message) &&
          /not found|expired/i.test(message) && (detail.param == null || detail.param === "previous_response_id")) {
        reason = "previous response unavailable";
      } else if (detail?.code === "context_length_exceeded") {
        reason = "context length exceeded";
      } else if (detail?.param === "tools") {
        reason = "tools rejected";
      } else if (detail?.param === "input") {
        reason = "input rejected";
      } else if (detail?.param === "max_output_tokens") {
        reason = "output token limit rejected";
      } else if (detail?.param === "previous_response_id") {
        reason = "previous response rejected";
      }
    } catch { /* Malformed bodies retain the safe status-only diagnostic. */ }
    error.message = `Meta request failed with status ${error.status} (${reason}).`;
  }
  throw error;
}

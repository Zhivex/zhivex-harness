import { z } from "zod";

export const providerDiagnosticSchema = z.strictObject({
  reason: z.enum(["previous_response_unavailable", "context_length_exceeded", "authentication", "permission", "rate_limit", "model_unavailable", "invalid_request", "server_error", "unknown"]),
  parameter: z.enum(["previous_response_id", "input", "messages", "tools", "model", "max_output_tokens", "max_tokens", "temperature", "other", "none"]),
  bodyState: z.enum(["parsed", "malformed", "too_large", "unavailable", "read_timeout"])
});

/** Interpret bounded provider responses into fixed labels; never retain their text. */
export function providerDiagnostic(body: unknown, status?: number): z.infer<typeof providerDiagnosticSchema> {
  let reason: z.infer<typeof providerDiagnosticSchema>["reason"] = status === 401 ? "authentication" : status === 403 ? "permission" : status === 429 ? "rate_limit" : status && status >= 500 ? "server_error" : "unknown";
  let parameter: z.infer<typeof providerDiagnosticSchema>["parameter"] = "none";
  if (typeof body !== "string") return { reason, parameter, bodyState: "unavailable" };
  if (Buffer.byteLength(body) > 8192) return { reason, parameter, bodyState: "too_large" };
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.error ?? parsed;
    const code = detail?.code ?? detail?.status ?? detail?.type;
    const message = typeof detail?.message === "string" ? detail.message : "";
    const param = providerDiagnosticSchema.shape.parameter.safeParse(detail?.param);
    parameter = param.success ? param.data : detail?.param == null ? "none" : "other";
    if (/response/i.test(message) && /not found|expired/i.test(message) && (parameter === "previous_response_id" || parameter === "none")) reason = "previous_response_unavailable";
    else if (["context_length_exceeded", "context_window_exceeded"].includes(code)) reason = "context_length_exceeded";
    else if (["invalid_api_key", "authentication_error", "UNAUTHENTICATED"].includes(code)) reason = "authentication";
    else if (["permission_denied", "permission_error", "PERMISSION_DENIED"].includes(code)) reason = "permission";
    else if (["rate_limit_exceeded", "rate_limit_error", "RESOURCE_EXHAUSTED"].includes(code)) reason = "rate_limit";
    else if (["model_not_found", "model_not_available"].includes(code)) reason = "model_unavailable";
    else if (["invalid_request_error", "INVALID_ARGUMENT"].includes(code) || status === 400 || status === 422) reason = "invalid_request";
    return { reason, parameter, bodyState: "parsed" };
  } catch { return { reason, parameter, bodyState: "malformed" }; }
}

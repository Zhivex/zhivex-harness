import { expect, test } from "bun:test";
import { normalizeHarnessError } from "../src/runtime/errors.js";
import { sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";
import { sanitizeOperationalError } from "../scripts/release-diagnostics.js";
import {
  isEmptyModelTurn,
  transientBackoffMs,
  type ProviderStatusCategory
} from "../src/runtime/provider-transient.js";

const secret = "projects/secret-project/serviceAccounts/private@example.com token=secret-token";

const expectTransient = (
  error: unknown,
  providerStatus: ProviderStatusCategory,
  httpStatus?: number
) => {
  const normalized = normalizeHarnessError(error);
  expect(normalized).toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
    category: "provider",
    retryable: true,
    ...(httpStatus !== undefined ? { status: httpStatus } : {}),
    providerStatus
  });
  expect(normalized.message).toBe("Provider request failed.");
  const details = sanitizedErrorDetails(error);
  const operational = sanitizeOperationalError(error);
  expect(operational).toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
    category: "provider",
    retryable: true,
    ...(httpStatus !== undefined ? { status: httpStatus } : {})
  });
  expect(details.chain.some(entry => entry.providerStatus === providerStatus)).toBe(true);
  if (httpStatus !== undefined) expect(details.chain.some(entry => entry.status === httpStatus)).toBe(true);
  const serialized = JSON.stringify({ normalized: { status: (normalized as { status?: number }).status, providerStatus }, details, operational });
  expect(serialized).not.toContain("secret-project");
  expect(serialized).not.toContain("secret-token");
  expect(serialized).not.toContain("private@example.com");
};

test("classifies Vertex HTTP and gRPC transient failures as retryable provider outages", () => {
  expectTransient(Object.assign(new Error(secret), {
    status: 409,
    responseBody: JSON.stringify({ error: { code: 409, status: "ABORTED", message: secret } })
  }), "ABORTED", 409);
  expectTransient(Object.assign(new Error(secret), { status: "ABORTED", code: 10 }), "ABORTED", 409);
  expectTransient(Object.assign(new Error(secret), { code: 10, httpStatusCode: 409 }), "ABORTED", 409);
  expectTransient(Object.assign(new Error(secret), { status: 429 }), "RESOURCE_EXHAUSTED", 429);
  expectTransient(Object.assign(new Error(secret), { code: 8 }), "RESOURCE_EXHAUSTED", 429);
  expectTransient(Object.assign(new Error(secret), { status: "RESOURCE_EXHAUSTED" }), "RESOURCE_EXHAUSTED", 429);
  expectTransient(Object.assign(new Error(secret), { status: 500 }), "INTERNAL", 500);
  expectTransient(Object.assign(new Error(secret), { status: 502 }), "UNAVAILABLE", 502);
  expectTransient(Object.assign(new Error(secret), { status: 503 }), "UNAVAILABLE", 503);
  expectTransient(Object.assign(new Error(secret), { status: "UNAVAILABLE" }), "UNAVAILABLE", 503);
  expectTransient(Object.assign(new Error(secret), { code: 14 }), "UNAVAILABLE", 503);
  expectTransient(Object.assign(new Error(secret), { status: 504 }), "DEADLINE_EXCEEDED", 504);
  expectTransient(Object.assign(new Error(secret), { status: "DEADLINE_EXCEEDED" }), "DEADLINE_EXCEEDED", 504);
  expectTransient(Object.assign(new Error(secret), { code: 4 }), "DEADLINE_EXCEEDED", 504);
  expectTransient(Object.assign(new Error(secret), { code: 13 }), "INTERNAL", 500);
  expectTransient(Object.assign(new Error(secret), { code: "ECONNRESET" }), "STREAM_RESET");
  expectTransient(Object.assign(new Error(`stream reset ${secret}`), {}), "STREAM_RESET");
  expectTransient(Object.assign(new Error(secret), { diagnosticCode: "VERTEX_STREAM_TOOL_TRUNCATED", reason: "stream_truncated" }), "STREAM_RESET");
  expectTransient(new Error(`Vertex HTTP 409 ${secret}`), "ABORTED", 409);
});

test("keeps definitive client errors non-retryable even when a cause looks transient", () => {
  for (const status of [400, 401, 403, 404]) {
    const error = Object.assign(new Error(secret), {
      status,
      responseBody: JSON.stringify({ error: { status: "UNAVAILABLE", message: secret } }),
      cause: Object.assign(new Error("HTTP 503"), { status: 503 })
    });
    const normalized = normalizeHarnessError(error);
    expect(normalized).toMatchObject({ code: "EXECUTION_FAILED", retryable: false });
    expect(JSON.stringify(sanitizedErrorDetails(error))).not.toContain("secret-token");
  }
});

test("treats an empty model turn as empty and keeps visible output", () => {
  expect(isEmptyModelTurn({ text: "", finishReason: "stop", messages: [{ parts: [] }] })).toBe(true);
  expect(isEmptyModelTurn({ text: "  ", finishReason: "stop" })).toBe(true);
  expect(isEmptyModelTurn({ text: '{"thought":true}', finishReason: "stop" })).toBe(true);
  expect(isEmptyModelTurn({ text: "", finishReason: "content-filter" })).toBe(false);
  expect(isEmptyModelTurn({ text: "", finishReason: "error" })).toBe(false);
  expect(isEmptyModelTurn({ text: "answer", finishReason: "stop" })).toBe(false);
  expect(isEmptyModelTurn({ text: '{"thought":true,"text":"hidden"}' })).toBe(false);
  expect(isEmptyModelTurn({ messages: [{ parts: [{ type: "tool-call" }] }] })).toBe(false);
  expect(isEmptyModelTurn({ messages: [{ parts: [{ type: "image" }] }] })).toBe(false);
  expect(isEmptyModelTurn({ images: [{}] })).toBe(false);
});

test("bounds jittered transient backoff", () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const exponential = Math.min(250 * 2 ** attempt, 10_000);
    const delay = transientBackoffMs(attempt);
    expect(delay).toBeGreaterThanOrEqual(exponential);
    expect(delay).toBeLessThan(exponential * 2);
  }
  expect(transientBackoffMs(0, 0)).toBe(0);
});
